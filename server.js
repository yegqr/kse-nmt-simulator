require('dotenv').config();
const express = require('express');
const session = require('express-session');
const ConnectSQLite3 = require('connect-sqlite3');
const path = require('path');
const fs = require('fs');
const { db, init } = require('./db');

const SQLiteStore = ConnectSQLite3(session);
const app = express();

// ─── Paths ─────────────────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SESSION_DB_DIR = process.env.SESSION_DB_DIR || __dirname;

// ─── Enable WAL mode on sessions.db before connect-sqlite3 opens it ───────────
{
  const sqlite3 = require('sqlite3').verbose();
  const sessDbPath = path.join(SESSION_DB_DIR, 'sessions.db');
  const tmpDb = new sqlite3.Database(sessDbPath);
  tmpDb.run('PRAGMA journal_mode=WAL', () => tmpDb.close());
}

[DATA_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: SESSION_DB_DIR }),
  secret: process.env.SESSION_SECRET || 'kse-nmt-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    // Set COOKIE_SECURE=true in .env only when running behind HTTPS
    secure: process.env.COOKIE_SECURE === 'true'
  }
}));

// ─── SEB Detection Middleware ──────────────────────────────────────────────────
// Protects exam.html AND all /api/exam/* routes when SEB_KEY is set.
// Without this, a student could bypass SEB and call the API directly via curl.
const SEB_KEY = process.env.SEB_KEY;
if (SEB_KEY) {
  const crypto = require('crypto');

  const requireSEB = (req, res, next) => {
    const sebHash = req.headers['x-safeexambrowser-requesthash'];
    if (!sebHash) {
      const isHtml = req.path.endsWith('.html');
      if (isHtml) {
        return res.status(403).send(`
          <html><body style="font-family:sans-serif;text-align:center;padding:60px">
            <h2>Доступ заборонено</h2>
            <p>Для доступу до тесту необхідно використовувати <strong>Safe Exam Browser</strong>.</p>
          </body></html>
        `);
      }
      return res.status(403).json({ error: 'Потрібен Safe Exam Browser' });
    }
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const expected = crypto.createHash('sha256').update(url + SEB_KEY).digest('hex');
    if (sebHash !== expected) {
      return res.status(403).json({ error: 'Недійсний SEB ключ' });
    }
    next();
  };

  app.use('/exam.html', requireSEB);
  app.use('/api/exam', requireSEB);
}

// ─── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.redirect('/login.html'));

app.use('/api', require('./routes/auth'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/exam', require('./routes/exam'));
app.use('/api/admin', require('./routes/admin'));

// User-facing reference materials (auth but not admin)
const { requireParticipant } = require('./middleware/auth');
app.get('/api/reference-materials', requireParticipant, (req, res) => {
  const { db: dbInst } = require('./db');
  const subject = req.query.subject || 'math';
  dbInst.all(
    `SELECT * FROM reference_materials WHERE subject = ? ORDER BY order_num ASC, id ASC`,
    [subject],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ─── Error handling middleware ─────────────────────────────────────────────────

// 404 for API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Маршрут не знайдено' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack || err.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Внутрішня помилка сервера' });
});

// ─── Startup validation ────────────────────────────────────────────────────────

(function validateStartup() {
  // Warn if using default session secret in production
  if (!process.env.SESSION_SECRET) {
    console.warn('[WARN] SESSION_SECRET not set — using default insecure secret. Set it in .env before deploying.');
  }

  // Validate required config.json fields
  const config = require('./config.json');
  const missing = [];
  if (!config.admin?.login) missing.push('admin.login');
  if (!config.admin?.password) missing.push('admin.password');
  if (!config.exam?.title) missing.push('exam.title');
  if (!config.exam?.duration_minutes) missing.push('exam.duration_minutes');
  if (missing.length > 0) {
    console.error('[FATAL] config.json is missing required fields:', missing.join(', '));
    process.exit(1);
  }
})();

// ─── Start ─────────────────────────────────────────────────────────────────────

init();

// ─── Background sweep: auto-finish expired active sessions ────────────────────
// Runs every 5 minutes. Catches participants who closed browser without finishing.
function sweepExpiredSessions() {
  const config = require('./config.json');
  const { calculateScore } = require('./utils/scoring');
  const cutoff = Date.now() - config.exam.duration_minutes * 60 * 1000;

  db.all(
    `SELECT * FROM exam_sessions WHERE status = 'active' AND CAST(started_at AS INTEGER) <= ?`,
    [cutoff],
    (err, sessions) => {
      if (err) return console.error('[sweep] DB error:', err.message);
      if (!sessions || sessions.length === 0) return;

      for (const s of sessions) {
        db.run(
          `UPDATE exam_sessions SET status = 'finishing' WHERE id = ? AND status = 'active'`,
          [s.id],
          function (err2) {
            if (err2 || this.changes === 0) return;

            db.all(`SELECT id, subject, type, correct_answer, options, match_right, points FROM questions`, (e1, questions) => {
              db.all(`SELECT question_id, answer FROM answers WHERE session_id = ?`, [s.id], (e2, answerRows) => {
                const answerMap = {};
                for (const a of (answerRows || [])) {
                  try { answerMap[a.question_id] = JSON.parse(a.answer); }
                  catch { answerMap[a.question_id] = a.answer; }
                }
                const { scoreUkr, scoreMath } = calculateScore(questions || [], answerMap);
                db.run(
                  `UPDATE exam_sessions SET status = 'finished', finished_at = ?, score_ukrainian = ?, score_math = ? WHERE id = ?`,
                  [Date.now(), scoreUkr, scoreMath, s.id],
                  () => {
                    console.log(`[sweep] Auto-finished session ${s.id} (participant ${s.participant_id}, ukr=${scoreUkr}, math=${scoreMath})`);
                  }
                );
              });
            });
          }
        );
      }
    }
  );
}

// Run once at startup (after a short delay so DB init completes), then every 5 min
setTimeout(sweepExpiredSessions, 10_000);
setInterval(sweepExpiredSessions, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`KSE NMT Simulator running at http://${HOST}:${PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL] Unhandled Rejection:', reason);
});

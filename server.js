const express = require('express');
const session = require('express-session');
const ConnectSQLite3 = require('connect-sqlite3');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db, init } = require('./db');
const config = require('./config.json');

const SQLiteStore = ConnectSQLite3(session);
const app = express();

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
[DATA_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
  secret: 'kse-nmt-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── Multer: Single question image (legacy) ───────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    cb(null, `q_${req.params.id}.png`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ─── Multer: Multiple question images ────────────────────────────────────────
const qMultiStorage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `q_${req.params.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`);
  }
});
const qMultiUpload = multer({ storage: qMultiStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// ─── Multer: Reference materials ─────────────────────────────────────────────
const refStorage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`);
  }
});
const refUpload = multer({ storage: refStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// ─── CSV multer ───────────────────────────────────────────────────────────────
const csvUpload = multer({ storage: multer.memoryStorage() });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function logEvent(sessionId, participantId, eventType, payload) {
  db.run(
    `INSERT INTO event_log (session_id, participant_id, event_type, payload) VALUES (?, ?, ?, ?)`,
    [sessionId, participantId, eventType, JSON.stringify(payload)]
  );
}

function requireParticipant(req, res, next) {
  if (!req.session.participant && !req.session.admin) return res.status(401).json({ error: 'Не авторизовано' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.status(401).json({ error: 'Не авторизовано' });
  next();
}

// Normalize a string answer for math open questions (comma→period)
function normalizeOpenMath(str) {
  if (str === null || str === undefined) return "";
  const normalized = String(str).trim().toLowerCase().replace(/,/g, '.');
  // If it's a valid number, parse and stringify to remove trailing zeros/dots (e.g. "16.0" -> "16")
  const num = parseFloat(normalized);
  if (!isNaN(num) && isFinite(num)) {
    return String(num);
  }
  return normalized;
}

function calculateScore(questions, answers) {
  let scoreUkr = 0, scoreMath = 0;

  for (const q of questions) {
    const ans = answers[q.id];
    if (!ans) continue;

    let correct = false;
    if (q.type === 'single') {
      correct = (ans.trim() === q.correct_answer.trim());
    } else if (q.type === 'multiple') {
      try {
        const userArr = JSON.parse(ans).sort();
        const corrArr = JSON.parse(q.correct_answer).sort();
        correct = JSON.stringify(userArr) === JSON.stringify(corrArr);
      } catch { correct = false; }
    } else if (q.type === 'match') {
      try {
        const userMap = JSON.parse(ans);
        const corrMap = JSON.parse(q.correct_answer);
        let pairs = 0;
        for (const key of Object.keys(corrMap)) {
          if (userMap[key] === corrMap[key]) pairs++;
        }
        if (q.subject === 'ukrainian') scoreUkr += pairs;
        else scoreMath += pairs;
        continue;
      } catch { correct = false; }
    } else if (q.type === 'open') {
      if (q.subject === 'math') {
        correct = normalizeOpenMath(ans) === normalizeOpenMath(q.correct_answer);
      } else {
        correct = (ans.trim().toLowerCase() === q.correct_answer.trim().toLowerCase());
      }
    }

    if (correct) {
      const pts = q.points || 1;
      if (q.subject === 'ukrainian') scoreUkr += pts;
      else scoreMath += pts;
    }
  }

  return { scoreUkr, scoreMath };
}

// ─── Settings ─────────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  db.get(`SELECT value FROM settings WHERE key = 'test_access_enabled'`, (err, row) => {
    res.json({ test_access_enabled: row ? row.value === '1' : false });
  });
});

app.put('/api/admin/settings/access', requireAdmin, (req, res) => {
  const { enabled } = req.body;
  db.run(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('test_access_enabled', ?)`,
    [enabled ? '1' : '0'],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, enabled: !!enabled });
    }
  );
});

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const { login, password } = req.body;
  db.get(
    `SELECT * FROM participants WHERE login = ? AND password = ?`,
    [login, password],
    (err, participant) => {
      if (err || !participant) {
        return res.status(401).json({ error: 'Невірний логін або пароль' });
      }
      req.session.participant = { id: participant.id, login: participant.login, full_name: participant.full_name, seat_number: participant.seat_number };
      logEvent(null, participant.id, 'login', { login });

      db.get(
        `SELECT * FROM exam_sessions WHERE participant_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
        [participant.id],
        (err2, examSession) => {
          res.json({ participant: req.session.participant, examSession: examSession || null });
        }
      );
    }
  );
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', requireParticipant, (req, res) => {
  res.json({ participant: req.session.participant, is_admin: !!req.session.admin });
});

// ─── Exam Routes ──────────────────────────────────────────────────────────────

app.post('/api/exam/start', requireParticipant, (req, res) => {
  const p = req.session.participant;

  // Check test access toggle
  db.get(`SELECT value FROM settings WHERE key = 'test_access_enabled'`, (err, row) => {
    if (!row || row.value !== '1') {
      return res.status(403).json({ error: 'Тест ще не відкрито адміністратором. Зверніться до організатора.' });
    }

    // Check if already has active session
    db.get(
      `SELECT * FROM exam_sessions WHERE participant_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
      [p.id],
      (err, existing) => {
        if (existing) {
          const totalSec = config.exam.duration_minutes * 60;
          const startedMs = parseInt(existing.started_at);
          const elapsed = Math.floor((Date.now() - startedMs) / 1000);
          const remaining = Math.max(0, totalSec - elapsed);
          return res.json({ session_id: existing.id, time_remaining_seconds: remaining, started_at: existing.started_at });
        }

        if (!config.allow_retake) {
          db.get(
            `SELECT * FROM exam_sessions WHERE participant_id = ? AND status = 'finished' LIMIT 1`,
            [p.id],
            (err2, finished) => {
              if (finished) return res.status(403).json({ error: 'Тест вже завершено. Повторна спроба не дозволена.' });
              createSession();
            }
          );
        } else {
          createSession();
        }
      }
    );
  });

  function createSession() {
    const sessionId = uuidv4();
    const totalSec = config.exam.duration_minutes * 60;

    db.run(
      `INSERT INTO exam_sessions (id, participant_id, started_at, time_remaining_seconds, status) VALUES (?, ?, ?, ?, 'active')`,
      [sessionId, p.id, Date.now(), totalSec],
      (err) => {
        if (err) return res.status(500).json({ error: 'Помилка створення сесії' });
        logEvent(sessionId, p.id, 'exam_start', {});
        res.json({ session_id: sessionId, time_remaining_seconds: totalSec });
      }
    );
  }
});

app.get('/api/exam/session', requireParticipant, (req, res) => {
  const p = req.session.participant;
  db.get(
    `SELECT * FROM exam_sessions WHERE participant_id = ? ORDER BY started_at DESC LIMIT 1`,
    [p.id],
    (err, s) => {
      if (err || !s) return res.status(404).json({ error: 'Сесія не знайдена' });

      let remaining = 0;
      if (s.status === 'active') {
        const totalSec = config.exam.duration_minutes * 60;
        const startedMs = parseInt(s.started_at);
        const elapsed = Math.floor((Date.now() - startedMs) / 1000);
        remaining = Math.max(0, totalSec - elapsed);
      }

      res.json({
        session_id: s.id,
        status: s.status,
        started_at: s.started_at,
        finished_at: s.finished_at,
        time_remaining_seconds: remaining,
        score_ukrainian: s.score_ukrainian,
        score_math: s.score_math
      });
    }
  );
});

app.get('/api/exam/questions', requireParticipant, (req, res) => {
  db.all(
    `SELECT id, subject, order_num, type, text, options, match_left, match_right, image_path, points, instruction
     FROM questions ORDER BY subject DESC, order_num ASC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.get('/api/exam/answers', requireParticipant, (req, res) => {
  const { session_id } = req.query;
  const p = req.session.participant;

  if (!session_id) return res.status(400).json({ error: 'session_id обов\'язковий' });

  db.all(
    `SELECT question_id, answer FROM answers WHERE session_id = ?`,
    [session_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const map = {};
      for (const row of rows) {
        try { map[row.question_id] = JSON.parse(row.answer); }
        catch { map[row.question_id] = row.answer; }
      }
      res.json(map);
    }
  );
});

// Bulk question images for exam
app.get('/api/exam/question-images', requireParticipant, (req, res) => {
  db.all(`SELECT * FROM question_images ORDER BY question_id, order_num ASC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const map = {};
    for (const row of rows) {
      if (!map[row.question_id]) map[row.question_id] = [];
      map[row.question_id].push(row);
    }
    res.json(map);
  });
});

app.post('/api/exam/answer', requireParticipant, (req, res) => {
  const { session_id, question_id, answer, time_spent_seconds } = req.body;
  const p = req.session.participant;

  db.get(
    `SELECT * FROM exam_sessions WHERE id = ? AND participant_id = ? AND status = 'active'`,
    [session_id, p.id],
    (err, s) => {
      if (err || !s) return res.status(403).json({ error: 'Недійсна сесія' });

      db.run(
        `INSERT INTO answers (session_id, question_id, answer, saved_at, time_spent_seconds)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, question_id) DO UPDATE SET
           answer = excluded.answer,
           saved_at = excluded.saved_at,
           time_spent_seconds = excluded.time_spent_seconds`,
        [session_id, question_id, JSON.stringify(answer), Date.now(), time_spent_seconds || 0],
        (err2) => {
          if (err2) return res.status(500).json({ error: err2.message });
          logEvent(session_id, p.id, 'answer_save', { question_id, answer });
          res.json({ ok: true });
        }
      );
    }
  );
});

app.post('/api/exam/ping', requireParticipant, (req, res) => {
  const { session_id, time_remaining_seconds } = req.body;
  const p = req.session.participant;

  db.run(
    `UPDATE exam_sessions SET time_remaining_seconds = ? WHERE id = ? AND participant_id = ? AND status = 'active'`,
    [time_remaining_seconds, session_id, p.id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

app.post('/api/exam/finish', requireParticipant, (req, res) => {
  const { session_id } = req.body;
  const p = req.session.participant;

  db.get(
    `SELECT * FROM exam_sessions WHERE id = ? AND participant_id = ?`,
    [session_id, p.id],
    (err, s) => {
      if (err || !s) return res.status(403).json({ error: 'Недійсна сесія' });
      if (s.status === 'finished') {
        return res.json({ score_ukrainian: s.score_ukrainian, score_math: s.score_math, already_finished: true });
      }

      db.all(`SELECT * FROM questions`, (err2, questions) => {
        db.all(
          `SELECT * FROM answers WHERE session_id = ?`,
          [session_id],
          (err3, answerRows) => {
            const answerMap = {};
            for (const a of answerRows) {
              try { answerMap[a.question_id] = JSON.parse(a.answer); }
              catch { answerMap[a.question_id] = a.answer; }
            }

            let scoreUkr = 0, scoreMath = 0;
            for (const q of questions) {
              const ans = answerMap[q.id];
              if (ans === undefined || ans === null) continue;

              let pts = 0;
              if (q.type === 'single') {
                if (String(ans).trim() === String(q.correct_answer).trim()) pts = q.points || 1;
              } else if (q.type === 'multiple') {
                try {
                  const userArr = (Array.isArray(ans) ? ans : JSON.parse(ans)).map(String).sort();
                  const corrArr = JSON.parse(q.correct_answer).map(String).sort();
                  if (JSON.stringify(userArr) === JSON.stringify(corrArr)) pts = q.points || 1;
                } catch { }
              } else if (q.type === 'match') {
                try {
                  const userMap = typeof ans === 'object' ? ans : JSON.parse(ans);
                  const corrMap = JSON.parse(q.correct_answer);
                  for (const key of Object.keys(corrMap)) {
                    if (userMap[key] === corrMap[key]) pts++;
                  }
                } catch { }
              } else if (q.type === 'open') {
                let isCorrect;
                if (q.subject === 'math') {
                  isCorrect = normalizeOpenMath(ans) === normalizeOpenMath(q.correct_answer);
                } else {
                  isCorrect = String(ans).trim().toLowerCase() === String(q.correct_answer).trim().toLowerCase();
                }
                if (isCorrect) pts = q.points || 1;
              }

              if (q.subject === 'ukrainian') scoreUkr += pts;
              else scoreMath += pts;
            }

            db.run(
              `UPDATE exam_sessions SET status = 'finished', finished_at = ?, score_ukrainian = ?, score_math = ? WHERE id = ?`,
              [Date.now(), scoreUkr, scoreMath, session_id],
              (err4) => {
                if (err4) return res.status(500).json({ error: err4.message });
                logEvent(session_id, p.id, 'test_submit', { scoreUkr, scoreMath });
                res.json({ score_ukrainian: scoreUkr, score_math: scoreMath });
              }
            );
          }
        );
      });
    }
  );
});

// ─── Reference Materials (User) ───────────────────────────────────────────────

app.get('/api/reference-materials', requireParticipant, (req, res) => {
  const subject = req.query.subject || 'math';
  db.all(
    `SELECT * FROM reference_materials WHERE subject = ? ORDER BY order_num ASC, id ASC`,
    [subject],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ─── Admin Auth ───────────────────────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { login, password } = req.body;
  if (login === config.admin.login && password === config.admin.password) {
    req.session.admin = true;
    // Also create a virtual participant for the admin to allow testing the exam
    req.session.participant = {
      id: 0, // Admin always has ID 0
      login: 'admin',
      full_name: 'Administrator (Testing Mode)',
      seat_number: 'ADMIN'
    };
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Невірний логін або пароль' });
});

app.post('/api/admin/logout', (req, res) => {
  delete req.session.admin;
  res.json({ ok: true });
});

// ─── Admin Participants ───────────────────────────────────────────────────────

app.get('/api/admin/participants', requireAdmin, (req, res) => {
  db.all(
    `SELECT p.*,
       (SELECT status FROM exam_sessions WHERE participant_id = p.id ORDER BY started_at DESC LIMIT 1) as exam_status,
       (SELECT score_ukrainian FROM exam_sessions WHERE participant_id = p.id AND status = 'finished' LIMIT 1) as score_ukrainian,
       (SELECT score_math FROM exam_sessions WHERE participant_id = p.id AND status = 'finished' LIMIT 1) as score_math
     FROM participants p ORDER BY seat_number, full_name`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.post('/api/admin/participants', requireAdmin, (req, res) => {
  const { login, password, full_name, seat_number } = req.body;
  if (!login || !password || !full_name) return res.status(400).json({ error: 'Поля login, password, full_name обов\'язкові' });

  db.run(
    `INSERT INTO participants (login, password, full_name, seat_number) VALUES (?, ?, ?, ?)`,
    [login, password, full_name, seat_number || null],
    function (err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ id: this.lastID, login, full_name, seat_number });
    }
  );
});

app.delete('/api/admin/participants/:id', requireAdmin, (req, res) => {
  db.run(`DELETE FROM participants WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.post('/api/admin/participants/import', requireAdmin, csvUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не завантажено' });

  const content = req.file.buffer.toString('utf-8');
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const dataLines = lines[0].toLowerCase().includes('login') ? lines.slice(1) : lines;

  const stmt = db.prepare(`INSERT OR IGNORE INTO participants (login, password, full_name, seat_number) VALUES (?, ?, ?, ?)`);
  let count = 0;

  for (const line of dataLines) {
    const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, ''));
    if (parts.length < 3) continue;
    const [login, password, full_name, seat_number] = parts;
    stmt.run(login, password, full_name, seat_number || null);
    count++;
  }
  stmt.finalize();
  res.json({ imported: count });
});

// ─── Admin Results ────────────────────────────────────────────────────────────

app.get('/api/admin/results', requireAdmin, (req, res) => {
  db.all(
    `SELECT es.*, p.full_name, p.login, p.seat_number,
       (SELECT COUNT(*) FROM answers WHERE session_id = es.id) as answers_count
     FROM exam_sessions es
     JOIN participants p ON p.id = es.participant_id
     WHERE es.status = 'finished'
     ORDER BY es.finished_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.get('/api/admin/results/:session_id', requireAdmin, (req, res) => {
  const { session_id } = req.params;

  db.get(
    `SELECT es.*, p.full_name, p.login, p.seat_number
     FROM exam_sessions es JOIN participants p ON p.id = es.participant_id
     WHERE es.id = ?`,
    [session_id],
    (err, session) => {
      if (err || !session) return res.status(404).json({ error: 'Сесія не знайдена' });

      db.all(`SELECT * FROM questions ORDER BY subject DESC, order_num ASC`, (err2, questions) => {
        db.all(
          `SELECT a.*, q.text, q.type, q.subject, q.order_num, q.correct_answer, q.options, q.match_left, q.match_right
           FROM answers a JOIN questions q ON q.id = a.question_id
           WHERE a.session_id = ?`,
          [session_id],
          (err3, answers) => {
            res.json({ session, questions, answers });
          }
        );
      });
    }
  );
});

// ─── Admin Active Sessions ────────────────────────────────────────────────────

app.get('/api/admin/sessions/active', requireAdmin, (req, res) => {
  db.all(
    `SELECT es.*, p.full_name, p.login, p.seat_number
     FROM exam_sessions es JOIN participants p ON p.id = es.participant_id
     WHERE es.status = 'active'
     ORDER BY es.started_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ─── Admin Logs ───────────────────────────────────────────────────────────────

app.get('/api/admin/logs', requireAdmin, (req, res) => {
  const { participant_id, event_type, date_from, date_to } = req.query;
  let where = [];
  let params = [];

  if (participant_id) { where.push('el.participant_id = ?'); params.push(participant_id); }
  if (event_type) { where.push('el.event_type = ?'); params.push(event_type); }
  if (date_from) { where.push('el.created_at >= ?'); params.push(date_from); }
  if (date_to) { where.push('el.created_at <= ?'); params.push(date_to); }

  const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : '';

  db.all(
    `SELECT el.*, p.full_name, p.login
     FROM event_log el LEFT JOIN participants p ON p.id = el.participant_id
     ${whereStr}
     ORDER BY el.created_at DESC LIMIT 1000`,
    params,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ─── Admin Export ─────────────────────────────────────────────────────────────

app.get('/api/admin/export/csv', requireAdmin, (req, res) => {
  db.all(
    `SELECT p.full_name, p.login, p.seat_number, es.started_at, es.finished_at,
       es.score_ukrainian, es.score_math,
       (COALESCE(es.score_ukrainian,0) + COALESCE(es.score_math,0)) as total
     FROM participants p
     LEFT JOIN exam_sessions es ON es.participant_id = p.id AND es.status = 'finished'
     ORDER BY p.seat_number`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      let csv = 'ПІБ,Логін,Місце,Початок,Кінець,Бали укр,Бали мат,Загальний\n';
      for (const r of rows) {
        csv += `"${r.full_name}","${r.login}","${r.seat_number || ''}","${r.started_at || ''}","${r.finished_at || ''}","${r.score_ukrainian ?? ''}","${r.score_math ?? ''}","${r.total ?? ''}"\n`;
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="results.csv"');
      res.send('\uFEFF' + csv);
    }
  );
});

// ─── Admin Questions ──────────────────────────────────────────────────────────

app.get('/api/admin/questions', requireAdmin, (req, res) => {
  db.all(`SELECT * FROM questions ORDER BY subject DESC, order_num ASC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/admin/questions', requireAdmin, (req, res) => {
  const { subject, order_num, type, text, options, match_left, match_right, correct_answer, points, instruction } = req.body;
  db.run(
    `INSERT INTO questions (subject, order_num, type, text, options, match_left, match_right, correct_answer, points, instruction)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [subject, order_num, type, text, options, match_left, match_right, correct_answer, points || 1, instruction],
    function (err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ id: this.lastID });
    }
  );
});

app.put('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const { subject, order_num, type, text, options, match_left, match_right, correct_answer, points, instruction } = req.body;
  db.run(
    `UPDATE questions SET subject=?, order_num=?, type=?, text=?, options=?, match_left=?, match_right=?, correct_answer=?, points=?, instruction=?
     WHERE id=?`,
    [subject, order_num, type, text, options, match_left, match_right, correct_answer, points || 1, instruction, req.params.id],
    (err) => {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

app.delete('/api/admin/questions/:id', requireAdmin, (req, res) => {
  db.run(`DELETE FROM questions WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ─── Admin Question Images ────────────────────────────────────────────────────

// Legacy single image (backward compat)
app.post('/api/admin/questions/:id/image', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не завантажено' });
  const imagePath = `uploads/q_${req.params.id}.png`;
  db.run(`UPDATE questions SET image_path = ? WHERE id = ?`, [imagePath, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, image_path: imagePath });
  });
});

// Get all extra images for a question
app.get('/api/admin/questions/:id/images', requireAdmin, (req, res) => {
  db.all(
    `SELECT * FROM question_images WHERE question_id = ? ORDER BY order_num ASC`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Upload multiple images for a question
app.post('/api/admin/questions/:id/images', requireAdmin, qMultiUpload.array('images', 10), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Файли не завантажено' });
  const qId = req.params.id;
  const paths = [];

  db.get(`SELECT COALESCE(MAX(order_num), -1) as maxOrd FROM question_images WHERE question_id = ?`, [qId], (err, row) => {
    let nextOrd = (row ? row.maxOrd : -1) + 1;
    let done = 0;

    for (const file of req.files) {
      const imagePath = `uploads/${file.filename}`;
      paths.push(imagePath);
      db.run(
        `INSERT INTO question_images (question_id, image_path, order_num) VALUES (?, ?, ?)`,
        [qId, imagePath, nextOrd++],
        () => {
          done++;
          if (done === req.files.length) res.json({ ok: true, images: paths });
        }
      );
    }
  });
});

// Delete a single extra image
app.delete('/api/admin/questions/:qid/images/:imgid', requireAdmin, (req, res) => {
  db.get(`SELECT * FROM question_images WHERE id = ? AND question_id = ?`, [req.params.imgid, req.params.qid], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Зображення не знайдено' });
    db.run(`DELETE FROM question_images WHERE id = ?`, [row.id], () => {
      // Optionally delete the file from disk
      const filePath = path.join(__dirname, 'public', row.image_path);
      fs.unlink(filePath, () => { });
      res.json({ ok: true });
    });
  });
});

// ─── Admin Reference Materials ────────────────────────────────────────────────

app.get('/api/admin/reference-materials', requireAdmin, (req, res) => {
  const subject = req.query.subject;
  let sql = `SELECT * FROM reference_materials`;
  let params = [];
  if (subject) { sql += ` WHERE subject = ?`; params.push(subject); }
  sql += ` ORDER BY subject, order_num ASC, id ASC`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/admin/reference-materials', requireAdmin, refUpload.array('images', 20), (req, res) => {
  const { subject, title, order_num } = req.body;
  const subj = subject || 'math';
  const ord = parseInt(order_num) || 0;

  if (!req.files || req.files.length === 0) {
    // Text-only material
    db.run(
      `INSERT INTO reference_materials (subject, title, image_path, order_num) VALUES (?, ?, NULL, ?)`,
      [subj, title || '', ord],
      function (err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ id: this.lastID });
      }
    );
    return;
  }

  // Insert one row per image
  let done = 0;
  const ids = [];
  req.files.forEach((file, idx) => {
    const imagePath = `uploads/${file.filename}`;
    db.run(
      `INSERT INTO reference_materials (subject, title, image_path, order_num) VALUES (?, ?, ?, ?)`,
      [subj, title || '', imagePath, ord + idx],
      function (err) {
        if (!err) ids.push(this.lastID);
        done++;
        if (done === req.files.length) res.json({ ok: true, ids });
      }
    );
  });
});

app.delete('/api/admin/reference-materials/:id', requireAdmin, (req, res) => {
  db.get(`SELECT * FROM reference_materials WHERE id = ?`, [req.params.id], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Не знайдено' });
    db.run(`DELETE FROM reference_materials WHERE id = ?`, [row.id], () => {
      if (row.image_path) {
        const filePath = path.join(__dirname, 'public', row.image_path);
        fs.unlink(filePath, () => { });
      }
      res.json({ ok: true });
    });
  });
});

// ─── Dashboard stats ──────────────────────────────────────────────────────────

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  db.get(`SELECT COUNT(*) as total FROM participants`, (err, r1) => {
    db.get(`SELECT COUNT(*) as active FROM exam_sessions WHERE status = 'active'`, (err2, r2) => {
      db.get(`SELECT COUNT(DISTINCT participant_id) as finished FROM exam_sessions WHERE status = 'finished'`, (err3, r3) => {
        db.get(`SELECT value FROM settings WHERE key = 'test_access_enabled'`, (err4, r4) => {
          res.json({
            total: r1?.total || 0,
            active: r2?.active || 0,
            finished: r3?.finished || 0,
            test_access_enabled: r4 ? r4.value === '1' : false
          });
        });
      });
    });
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

init();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KSE NMT Simulator running at http://localhost:${PORT}`);
});

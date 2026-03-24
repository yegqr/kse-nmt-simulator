const express = require('express');
const router = express.Router();
const archiver = require('archiver');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { logEvent } = require('../utils/logger');

const UPLOADS_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'uploads')
  : path.join(__dirname, '..', 'data', 'uploads');

// ─── Multer configs ────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, `q_${req.params.id}.png`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const qMultiUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `q_${req.params.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const refUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const csvUpload = multer({ storage: multer.memoryStorage() });

// ─── Settings ──────────────────────────────────────────────────────────────────

router.put('/settings/access', requireAdmin, (req, res) => {
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

// ─── Freeze / Unfreeze ─────────────────────────────────────────────────────────

router.post('/freeze', requireAdmin, (req, res) => {
  const frozenAt = Date.now();
  db.serialize(() => {
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('exam_frozen', '1')`);
    db.run(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('exam_frozen_at', ?)`,
      [String(frozenAt)],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true, frozen: true });
      }
    );
  });
});

router.post('/unfreeze', requireAdmin, (req, res) => {
  db.get(`SELECT value FROM settings WHERE key = 'exam_frozen_at'`, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    const frozenAt = row ? parseInt(row.value) : Date.now();
    const pausedMs = Date.now() - frozenAt;

    db.run(
      `UPDATE exam_sessions SET started_at = CAST(started_at + ? AS INTEGER) WHERE status = 'active'`,
      [pausedMs],
      (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        db.serialize(() => {
          db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('exam_frozen', '0')`);
          db.run(`DELETE FROM settings WHERE key = 'exam_frozen_at'`, (err3) => {
            if (err3) return res.status(500).json({ error: err3.message });
            res.json({ ok: true, frozen: false });
          });
        });
      }
    );
  });
});

// ─── Dashboard ─────────────────────────────────────────────────────────────────

router.get('/dashboard', requireAdmin, (req, res) => {
  // Single query replaces 4 sequential round-trips — ~4x faster under load
  db.get(
    `SELECT
       (SELECT COUNT(*) FROM participants) as total,
       (SELECT COUNT(*) FROM exam_sessions WHERE status = 'active') as active,
       (SELECT COUNT(DISTINCT participant_id) FROM exam_sessions WHERE status = 'finished') as finished,
       (SELECT value FROM settings WHERE key = 'test_access_enabled') as access_value`,
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        total: row?.total || 0,
        active: row?.active || 0,
        finished: row?.finished || 0,
        test_access_enabled: row?.access_value === '1'
      });
    }
  );
});

// ─── Participants ──────────────────────────────────────────────────────────────

router.get('/participants', requireAdmin, (req, res) => {
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

router.post('/participants', requireAdmin, (req, res) => {
  const { login, password, full_name, seat_number } = req.body;
  if (!login || !password || !full_name) {
    return res.status(400).json({ error: 'Поля login, password, full_name обов\'язкові' });
  }
  db.run(
    `INSERT INTO participants (login, password, full_name, seat_number) VALUES (?, ?, ?, ?)`,
    [login, password, full_name, seat_number || null],
    function (err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ id: this.lastID, login, full_name, seat_number });
    }
  );
});

router.delete('/participants/:id', requireAdmin, (req, res) => {
  db.run(`DELETE FROM participants WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

router.post('/participants/import', requireAdmin, csvUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не завантажено' });

  const content = req.file.buffer.toString('utf-8');
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const dataLines = lines[0] && lines[0].toLowerCase().includes('login') ? lines.slice(1) : lines;

  function parseCSVLine(str) {
    const delim = str.includes(';') ? ';' : ',';
    const arr = [];
    let quote = false;
    for (let col = 0, c = 0; c < str.length; c++) {
      const cc = str[c], nc = str[c + 1];
      arr[col] = arr[col] || '';
      if (cc === '"' && quote && nc === '"') { arr[col] += cc; ++c; continue; }
      if (cc === '"') { quote = !quote; continue; }
      if (cc === delim && !quote) { ++col; continue; }
      arr[col] += cc;
    }
    return arr.map(s => s.trim());
  }

  const stmt = db.prepare(`INSERT OR IGNORE INTO participants (login, password, full_name, seat_number) VALUES (?, ?, ?, ?)`);
  let count = 0;

  for (const line of dataLines) {
    const parts = parseCSVLine(line);
    if (parts.length < 3) continue;
    const [login, password, full_name, seat_number] = parts;
    if (!login) continue;
    stmt.run(login, password, full_name, seat_number || null);
    count++;
  }
  stmt.finalize(() => {
    res.json({ imported: count });
  });
});

// ─── Results ───────────────────────────────────────────────────────────────────

router.get('/results', requireAdmin, (req, res) => {
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

router.get('/results/:session_id', requireAdmin, (req, res) => {
  db.get(
    `SELECT es.*, p.full_name, p.login, p.seat_number
     FROM exam_sessions es JOIN participants p ON p.id = es.participant_id
     WHERE es.id = ?`,
    [req.params.session_id],
    (err, session) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!session) return res.status(404).json({ error: 'Сесія не знайдена' });

      db.all(`SELECT * FROM questions ORDER BY subject DESC, order_num ASC`, (err2, questions) => {
        if (err2) return res.status(500).json({ error: err2.message });

        db.all(
          `SELECT a.*, q.text, q.type, q.subject, q.order_num, q.correct_answer, q.options, q.match_left, q.match_right
           FROM answers a JOIN questions q ON q.id = a.question_id
           WHERE a.session_id = ?`,
          [req.params.session_id],
          (err3, answers) => {
            if (err3) return res.status(500).json({ error: err3.message });
            res.json({ session, questions, answers });
          }
        );
      });
    }
  );
});

// ─── Active sessions ───────────────────────────────────────────────────────────

router.get('/sessions/active', requireAdmin, (req, res) => {
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

// ─── Logs ──────────────────────────────────────────────────────────────────────

router.get('/logs', requireAdmin, (req, res) => {
  const { participant_id, event_type, date_from, date_to } = req.query;
  const where = [], params = [];

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

// ─── Export CSV ────────────────────────────────────────────────────────────────

router.get('/export/csv', requireAdmin, (req, res) => {
  db.all(
    `SELECT p.full_name, p.login, p.seat_number, es.started_at, es.finished_at,
       es.score_ukrainian, es.score_math,
       (COALESCE(es.score_ukrainian,0) + COALESCE(es.score_math,0)) as total
     FROM participants p
     LEFT JOIN exam_sessions es ON es.participant_id = p.id AND es.status = 'finished'
     ORDER BY p.seat_number`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const fmtTs = (ts) => {
        if (!ts) return '';
        const d = new Date(isNaN(ts) ? ts : parseInt(ts));
        return d.toLocaleString('uk-UA');
      };

      let csv = 'ПІБ,Логін,Місце,Початок,Кінець,Бали укр,Бали мат,Загальний\n';
      for (const r of rows) {
        csv += `"${r.full_name || ''}","${r.login || ''}","${r.seat_number || ''}","${fmtTs(r.started_at)}","${fmtTs(r.finished_at)}","${r.score_ukrainian ?? ''}","${r.score_math ?? ''}","${r.total ?? ''}"\n`;
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="results.csv"');
      res.send('\uFEFF' + csv);
    }
  );
});

// ─── Questions Export/Import ────────────────────────────────────────────────────

router.get('/questions/export', requireAdmin, (req, res) => {
  db.all('SELECT * FROM questions', [], (err, questions) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT * FROM question_images', [], (err2, images) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ questions, images });
    });
  });
});

router.post('/questions/import', requireAdmin, (req, res) => {
  const { questions, images } = req.body;
  if (!questions || !Array.isArray(questions)) {
    return res.status(400).json({ error: 'Некоректний формат JSON' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run('DELETE FROM questions');
    db.run('DELETE FROM question_images');

    const qStmt = db.prepare(
      `INSERT INTO questions (id, subject, order_num, type, text, options, match_left, match_right, correct_answer, image_path, points, instruction)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const q of questions) {
      const opts = typeof q.options === 'string' ? q.options : JSON.stringify(q.options || []);
      const ml = typeof q.match_left === 'string' ? q.match_left : JSON.stringify(q.match_left || []);
      const mr = typeof q.match_right === 'string' ? q.match_right : JSON.stringify(q.match_right || []);
      const ca = typeof q.correct_answer === 'string' ? q.correct_answer : JSON.stringify(q.correct_answer);
      qStmt.run(q.id, q.subject, q.order_num, q.type, q.text, opts, ml, mr, ca, q.image_path, q.points, q.instruction);
    }
    qStmt.finalize();

    if (images && Array.isArray(images)) {
      const iStmt = db.prepare(`INSERT INTO question_images (id, question_id, image_path, order_num) VALUES (?, ?, ?, ?)`);
      for (const img of images) {
        iStmt.run(img.id, img.question_id, img.image_path, img.order_num);
      }
      iStmt.finalize();
    }

    db.run('COMMIT', (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, count: questions.length });
    });
  });
});

router.get('/questions/export-zip', requireAdmin, (req, res) => {
  db.all('SELECT * FROM questions', [], (err, questions) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT * FROM question_images', [], (err2, images) => {
      if (err2) return res.status(500).json({ error: err2.message });

      const archive = archiver('zip', { zlib: { level: 9 } });
      res.attachment(`kse_export_${Date.now()}.zip`);
      archive.on('error', (e) => res.status(500).send({ error: e.message }));
      archive.pipe(res);
      archive.append(JSON.stringify({ questions, images }, null, 2), { name: 'questions.json' });
      if (fs.existsSync(UPLOADS_DIR)) archive.directory(UPLOADS_DIR, 'uploads');
      archive.finalize();
    });
  });
});

router.delete('/questions/all', requireAdmin, (req, res) => {
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run('DELETE FROM questions');
    db.run('DELETE FROM question_images');
    db.run('COMMIT', (err) => {
      if (err) return res.status(500).json({ error: err.message });
      try {
        if (fs.existsSync(UPLOADS_DIR)) {
          for (const file of fs.readdirSync(UPLOADS_DIR)) {
            fs.unlinkSync(path.join(UPLOADS_DIR, file));
          }
        }
      } catch (e) {
        console.error('[admin] Error cleaning uploads:', e.message);
      }
      res.json({ ok: true });
    });
  });
});

// ─── Question validation helper ────────────────────────────────────────────────

function validateQuestion(type, correct_answer, options, match_left, match_right) {
  const errors = [];

  if (!['single', 'multiple', 'match', 'open'].includes(type)) {
    errors.push('Невідомий тип питання: ' + type);
    return errors;
  }

  if (type === 'single') {
    if (!correct_answer || !String(correct_answer).trim()) {
      errors.push('correct_answer обов\'язкова для single');
    }
  }

  if (type === 'multiple') {
    try {
      const arr = JSON.parse(correct_answer);
      if (!Array.isArray(arr) || arr.length === 0) {
        errors.push('correct_answer для multiple має бути JSON масив, напр. ["А","В"]');
      }
    } catch {
      errors.push('correct_answer для multiple має бути валідний JSON масив, напр. ["А","В"]');
    }
  }

  if (type === 'match') {
    try {
      const obj = JSON.parse(correct_answer);
      if (typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).length === 0) {
        errors.push('correct_answer для match має бути JSON об\'єкт, напр. {"1":"А","2":"Б"}');
      }
    } catch {
      errors.push('correct_answer для match має бути валідний JSON об\'єкт, напр. {"1":"А","2":"Б"}');
    }
    try { JSON.parse(match_left || '[]'); } catch { errors.push('match_left має бути валідний JSON масив'); }
    try { JSON.parse(match_right || '[]'); } catch { errors.push('match_right має бути валідний JSON масив'); }
  }

  if (type === 'open' && (correct_answer === null || correct_answer === undefined || !String(correct_answer).trim())) {
    errors.push('correct_answer обов\'язкова для open');
  }

  return errors;
}

// ─── Questions CRUD ────────────────────────────────────────────────────────────

router.get('/questions', requireAdmin, (req, res) => {
  db.all(`SELECT * FROM questions ORDER BY subject DESC, order_num ASC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

router.post('/questions', requireAdmin, (req, res) => {
  const { subject, order_num, type, text, options, match_left, match_right, correct_answer, points, instruction } = req.body;
  const validationErrors = validateQuestion(type, correct_answer, options, match_left, match_right);
  if (validationErrors.length > 0) return res.status(400).json({ error: validationErrors.join('; ') });
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

router.put('/questions/:id', requireAdmin, (req, res) => {
  const { subject, order_num, type, text, options, match_left, match_right, correct_answer, points, instruction } = req.body;
  const validationErrors = validateQuestion(type, correct_answer, options, match_left, match_right);
  if (validationErrors.length > 0) return res.status(400).json({ error: validationErrors.join('; ') });
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

router.delete('/questions/:id', requireAdmin, (req, res) => {
  db.run(`DELETE FROM questions WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ─── Question Images ───────────────────────────────────────────────────────────

router.post('/questions/:id/image', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не завантажено' });
  const imagePath = `uploads/q_${req.params.id}.png`;
  db.run(`UPDATE questions SET image_path = ? WHERE id = ?`, [imagePath, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, image_path: imagePath });
  });
});

router.get('/questions/:id/images', requireAdmin, (req, res) => {
  db.all(
    `SELECT * FROM question_images WHERE question_id = ? ORDER BY order_num ASC`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

router.post('/questions/:id/images', requireAdmin, qMultiUpload.array('images', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Файли не завантажено' });
  }
  const qId = req.params.id;
  const paths = [];

  db.get(`SELECT COALESCE(MAX(order_num), -1) as maxOrd FROM question_images WHERE question_id = ?`, [qId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
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

router.delete('/questions/:qid/images/:imgid', requireAdmin, (req, res) => {
  db.get(
    `SELECT * FROM question_images WHERE id = ? AND question_id = ?`,
    [req.params.imgid, req.params.qid],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Зображення не знайдено' });

      db.run(`DELETE FROM question_images WHERE id = ?`, [row.id], () => {
        // Delete file from disk (correct path fix)
        const filePath = path.join(UPLOADS_DIR, path.basename(row.image_path));
        fs.unlink(filePath, (unlinkErr) => {
          if (unlinkErr) console.error('[admin] File delete error:', unlinkErr.message);
        });
        res.json({ ok: true });
      });
    }
  );
});

// ─── Reference Materials ───────────────────────────────────────────────────────

router.get('/reference-materials', requireAdmin, (req, res) => {
  const subject = req.query.subject;
  let sql = `SELECT * FROM reference_materials`;
  const params = [];
  if (subject) { sql += ` WHERE subject = ?`; params.push(subject); }
  sql += ` ORDER BY subject, order_num ASC, id ASC`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

router.post('/reference-materials', requireAdmin, refUpload.array('images', 20), (req, res) => {
  const { subject, title, order_num } = req.body;
  const subj = subject || 'math';
  const ord = parseInt(order_num) || 0;

  if (!req.files || req.files.length === 0) {
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

router.delete('/reference-materials/:id', requireAdmin, (req, res) => {
  db.get(`SELECT * FROM reference_materials WHERE id = ?`, [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Не знайдено' });

    db.run(`DELETE FROM reference_materials WHERE id = ?`, [row.id], () => {
      if (row.image_path) {
        const filePath = path.join(UPLOADS_DIR, path.basename(row.image_path));
        fs.unlink(filePath, () => {});
      }
      res.json({ ok: true });
    });
  });
});

// ─── Reference materials (user-facing, requires participant auth) ───────────────
// NOTE: mounted separately in server.js at /api/reference-materials

module.exports = router;

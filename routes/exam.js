const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const config = require('../config.json');
const { requireParticipant, requireAdmin } = require('../middleware/auth');
const { calculateScore } = require('../utils/scoring');
const { logEvent } = require('../utils/logger');

// GET /api/exam/config — public exam info (title, duration, date)
router.get('/config', (req, res) => {
  res.json({
    title: config.exam.title,
    date: config.exam.date,
    duration_minutes: config.exam.duration_minutes
  });
});

// GET /api/exam/status — freeze check (participants)
router.get('/status', requireParticipant, (req, res) => {
  db.get(`SELECT value FROM settings WHERE key = 'exam_frozen'`, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ frozen: row ? row.value === '1' : false });
  });
});

// POST /api/admin/freeze — admin only
// NOTE: mounted at /api/exam internally but exposed at /api/admin via server.js
// These routes are on examRouter but called from adminRouter by server.js re-use
// Actually these go here as they relate to exam state

// POST /api/exam/start
router.post('/start', requireParticipant, (req, res) => {
  const p = req.session.participant;

  // Admin can always start regardless of access toggle
  if (!req.session.admin) {
    db.get(`SELECT value FROM settings WHERE key = 'test_access_enabled'`, (err, row) => {
      if (err) return res.status(500).json({ error: 'Помилка сервера' });
      if (!row || row.value !== '1') {
        return res.status(403).json({ error: 'Тест ще не відкрито адміністратором. Зверніться до організатора.' });
      }
      checkExistingSession();
    });
  } else {
    checkExistingSession();
  }

  function checkExistingSession() {
    db.get(
      `SELECT * FROM exam_sessions WHERE participant_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
      [p.id],
      (err, existing) => {
        if (err) return res.status(500).json({ error: 'Помилка сервера' });

        if (existing && !req.session.admin) {
          const totalSec = config.exam.duration_minutes * 60;
          const elapsed = Math.floor((Date.now() - parseInt(existing.started_at)) / 1000);
          const remaining = Math.max(0, totalSec - elapsed);
          return res.json({ session_id: existing.id, time_remaining_seconds: remaining, started_at: existing.started_at });
        }

        if (!config.allow_retake && !req.session.admin) {
          db.get(
            `SELECT id FROM exam_sessions WHERE participant_id = ? AND status = 'finished' LIMIT 1`,
            [p.id],
            (err2, finished) => {
              if (err2) return res.status(500).json({ error: 'Помилка сервера' });
              if (finished) return res.status(403).json({ error: 'Тест вже завершено. Повторна спроба не дозволена.' });
              createSession();
            }
          );
        } else {
          createSession();
        }
      }
    );
  }

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

// GET /api/exam/session
// Also auto-finishes expired active sessions (server-side enforcement)
router.get('/session', requireParticipant, (req, res) => {
  const p = req.session.participant;
  db.get(
    `SELECT * FROM exam_sessions WHERE participant_id = ? ORDER BY started_at DESC LIMIT 1`,
    [p.id],
    (err, s) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!s) return res.status(404).json({ error: 'Сесія не знайдена' });

      let remaining = 0;
      if (s.status === 'active') {
        const totalSec = config.exam.duration_minutes * 60;
        const elapsed = Math.floor((Date.now() - parseInt(s.started_at)) / 1000);
        remaining = Math.max(0, totalSec - elapsed);

        // Auto-finish expired sessions server-side
        if (remaining === 0) {
          db.run(
            `UPDATE exam_sessions SET status = 'finishing' WHERE id = ? AND status = 'active'`,
            [s.id],
            function () {
              if (this.changes > 0) {
                // Calculate and store scores (only fields needed by calculateScore)
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
                      [Date.now(), scoreUkr, scoreMath, s.id]
                    );
                    logEvent(s.id, p.id, 'test_submit_auto', { scoreUkr, scoreMath, reason: 'time_expired' });
                  });
                });
              }
            }
          );
          return res.json({
            session_id: s.id, status: 'finished',
            started_at: s.started_at, finished_at: s.finished_at,
            time_remaining_seconds: 0,
            score_ukrainian: s.score_ukrainian, score_math: s.score_math
          });
        }
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

// GET /api/exam/questions
router.get('/questions', requireParticipant, (req, res) => {
  db.all(
    `SELECT id, subject, order_num, type, text, options, match_left, match_right, image_path, points, instruction
     FROM questions ORDER BY subject DESC, order_num ASC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// GET /api/exam/answers?session_id=...
router.get('/answers', requireParticipant, (req, res) => {
  const { session_id } = req.query;
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

// GET /api/exam/question-images
router.get('/question-images', requireParticipant, (req, res) => {
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

// POST /api/exam/answer
router.post('/answer', requireParticipant, (req, res) => {
  const { session_id, question_id, answer, time_spent_seconds } = req.body;
  const p = req.session.participant;

  if (!session_id || !question_id) {
    return res.status(400).json({ error: 'session_id і question_id обов\'язкові' });
  }

  // Check freeze state first — answers cannot be saved during air raid pause
  db.get(`SELECT value FROM settings WHERE key = 'exam_frozen'`, (err0, freezeRow) => {
    if (err0) return res.status(500).json({ error: 'Помилка сервера' });
    if (freezeRow && freezeRow.value === '1') {
      return res.status(423).json({ error: 'Тест тимчасово призупинено. Збереження заблоковано.' });
    }

    // Verify active session belongs to this participant and has time remaining
    db.get(
      `SELECT id, started_at FROM exam_sessions WHERE id = ? AND participant_id = ? AND status = 'active'`,
      [session_id, p.id],
      (err, s) => {
        if (err) return res.status(500).json({ error: 'Помилка сервера' });
        if (!s) return res.status(403).json({ error: 'Недійсна або завершена сесія' });

        // Reject answers after time is up (server-side enforcement)
        const totalSec = config.exam.duration_minutes * 60;
        const elapsed = Math.floor((Date.now() - parseInt(s.started_at)) / 1000);
        if (elapsed >= totalSec) {
          return res.status(403).json({ error: 'Час тесту вичерпано' });
        }

        // Verify question_id actually exists in our question bank
        db.get(`SELECT id FROM questions WHERE id = ?`, [question_id], (err1, q) => {
          if (err1) return res.status(500).json({ error: 'Помилка сервера' });
          if (!q) return res.status(400).json({ error: 'Невідоме питання' });

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
        });
      }
    );
  });
});

// POST /api/exam/ping
// Server calculates remaining time authoritatively — does NOT trust client value
router.post('/ping', requireParticipant, (req, res) => {
  const { session_id } = req.body;
  const p = req.session.participant;

  if (!session_id) return res.status(400).json({ error: 'session_id обов\'язковий' });

  db.get(
    `SELECT started_at FROM exam_sessions WHERE id = ? AND participant_id = ? AND status = 'active'`,
    [session_id, p.id],
    (err, s) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!s) return res.json({ ok: true, expired: true });

      const totalSec = config.exam.duration_minutes * 60;
      const elapsed = Math.floor((Date.now() - parseInt(s.started_at)) / 1000);
      const serverRemaining = Math.max(0, totalSec - elapsed);

      db.run(
        `UPDATE exam_sessions SET time_remaining_seconds = ? WHERE id = ?`,
        [serverRemaining, session_id],
        (err2) => {
          if (err2) return res.status(500).json({ error: err2.message });
          // Return authoritative remaining time so client can self-correct
          res.json({ ok: true, time_remaining_seconds: serverRemaining });
        }
      );
    }
  );
});

// POST /api/exam/finish
router.post('/finish', requireParticipant, (req, res) => {
  const { session_id } = req.body;
  const p = req.session.participant;

  if (!session_id) return res.status(400).json({ error: 'session_id обов\'язковий' });

  // Atomically mark as finishing to prevent race condition (double finish)
  db.run(
    `UPDATE exam_sessions SET status = 'finishing'
     WHERE id = ? AND participant_id = ? AND status = 'active'`,
    [session_id, p.id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Помилка сервера' });

      if (this.changes === 0) {
        // Either session doesn't exist, or already finished/finishing
        db.get(
          `SELECT status, score_ukrainian, score_math FROM exam_sessions WHERE id = ? AND participant_id = ?`,
          [session_id, p.id],
          (err2, s) => {
            if (err2 || !s) return res.status(403).json({ error: 'Недійсна сесія' });
            if (s.status === 'finished') {
              return res.json({ score_ukrainian: s.score_ukrainian, score_math: s.score_math, already_finished: true });
            }
            // Still being finalized by a concurrent request — return immediately,
            // client should poll /api/exam/session for final scores
            return res.json({ score_ukrainian: null, score_math: null, already_finished: true, still_processing: true });
          }
        );
        return;
      }

      // We won the race — calculate and store scores (only fields needed by calculateScore)
      db.all(`SELECT id, subject, type, correct_answer, options, match_right, points FROM questions`, (err2, questions) => {
        if (err2) {
          db.run(`UPDATE exam_sessions SET status = 'active' WHERE id = ?`, [session_id]);
          return res.status(500).json({ error: 'Помилка завантаження питань' });
        }

        db.all(`SELECT question_id, answer FROM answers WHERE session_id = ?`, [session_id], (err3, answerRows) => {
          if (err3) {
            db.run(`UPDATE exam_sessions SET status = 'active' WHERE id = ?`, [session_id]);
            return res.status(500).json({ error: 'Помилка завантаження відповідей' });
          }

          const answerMap = {};
          for (const a of answerRows) {
            try { answerMap[a.question_id] = JSON.parse(a.answer); }
            catch { answerMap[a.question_id] = a.answer; }
          }

          const { scoreUkr, scoreMath } = calculateScore(questions, answerMap);

          db.run(
            `UPDATE exam_sessions SET status = 'finished', finished_at = ?, score_ukrainian = ?, score_math = ? WHERE id = ?`,
            [Date.now(), scoreUkr, scoreMath, session_id],
            (err4) => {
              if (err4) return res.status(500).json({ error: err4.message });
              logEvent(session_id, p.id, 'test_submit', { scoreUkr, scoreMath });
              res.json({ score_ukrainian: scoreUkr, score_math: scoreMath });
            }
          );
        });
      });
    }
  );
});

// POST /api/exam/violation
router.post('/violation', requireParticipant, (req, res) => {
  const { eventType, timestamp, session_id } = req.body;
  const p = req.session.participant;
  logEvent(session_id || 'manual', p.id, 'violation', { eventType, timestamp });
  res.json({ ok: true });
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const config = require('../config.json');
const { requireParticipant } = require('../middleware/auth');
const { logEvent } = require('../utils/logger');

// ─── Simple in-memory rate limiter for login ──────────────────────────────────
const loginAttempts = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 20; // per IP per window

function isRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  if (entry.count >= MAX_ATTEMPTS) return true;
  entry.count++;
  return false;
}

// Clean up old entries every 30 minutes to avoid memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000);

// Participant login (also accepts admin credentials)
router.post('/login', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Забагато спроб входу. Зачекайте 15 хвилин.' });
  }

  const { login, password } = req.body;
  if (!login || !password) {
    return res.status(400).json({ error: 'Логін і пароль обов\'язкові' });
  }

  if (login === config.admin.login && password === config.admin.password) {
    req.session.admin = true;
    req.session.participant = {
      id: 0,
      login: 'admin',
      full_name: 'Administrator (Testing Mode)',
      seat_number: 'ADMIN'
    };
    logEvent(null, 0, 'admin_login_as_user', { login });
    return res.json({ participant: req.session.participant, examSession: null, is_admin: true });
  }

  db.get(
    `SELECT * FROM participants WHERE login = ? AND password = ?`,
    [login, password],
    (err, participant) => {
      if (err) return res.status(500).json({ error: 'Помилка сервера' });
      if (!participant) return res.status(401).json({ error: 'Невірний логін або пароль' });

      delete req.session.admin;
      req.session.participant = {
        id: participant.id,
        login: participant.login,
        full_name: participant.full_name,
        seat_number: participant.seat_number
      };
      logEvent(null, participant.id, 'login', { login });

      db.get(
        `SELECT * FROM exam_sessions WHERE participant_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
        [participant.id],
        (err2, examSession) => {
          if (err2) return res.status(500).json({ error: 'Помилка сервера' });
          res.json({ participant: req.session.participant, examSession: examSession || null, is_admin: false });
        }
      );
    }
  );
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('[logout] session destroy error:', err);
    res.json({ ok: true });
  });
});

router.get('/me', requireParticipant, (req, res) => {
  res.json({ participant: req.session.participant, is_admin: !!req.session.admin });
});

// Admin-only login endpoint
router.post('/admin/login', (req, res) => {
  const { login, password } = req.body;
  if (login === config.admin.login && password === config.admin.password) {
    req.session.admin = true;
    req.session.participant = {
      id: 0,
      login: 'admin',
      full_name: 'Administrator (Testing Mode)',
      seat_number: 'ADMIN'
    };
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Невірний логін або пароль' });
});

router.post('/admin/logout', (req, res) => {
  delete req.session.admin;
  res.json({ ok: true });
});

module.exports = router;

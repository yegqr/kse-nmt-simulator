const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { requireAdmin } = require('../middleware/auth');

// GET /api/settings — public (used by participant dashboard)
router.get('/', (req, res) => {
  db.get(`SELECT value FROM settings WHERE key = 'test_access_enabled'`, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ test_access_enabled: row ? row.value === '1' : false });
  });
});

// PUT /api/settings/access — admin only
router.put('/access', requireAdmin, (req, res) => {
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

module.exports = router;

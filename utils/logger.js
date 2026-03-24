const { db } = require('../db');

function logEvent(sessionId, participantId, eventType, payload) {
  db.run(
    `INSERT INTO event_log (session_id, participant_id, event_type, payload) VALUES (?, ?, ?, ?)`,
    [sessionId, participantId, eventType, JSON.stringify(payload)],
    (err) => {
      if (err) console.error('[logEvent] DB error:', err.message);
    }
  );
}

module.exports = { logEvent };

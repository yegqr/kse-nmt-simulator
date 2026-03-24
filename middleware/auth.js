function requireParticipant(req, res, next) {
  if (!req.session.participant && !req.session.admin) {
    return res.status(401).json({ error: 'Не авторизовано' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.status(401).json({ error: 'Не авторизовано' });
  }
  next();
}

module.exports = { requireParticipant, requireAdmin };

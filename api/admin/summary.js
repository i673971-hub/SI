const { json, readBody, getSession, requireAdmin, makeAuthCookie } = require('./lib/server');

module.exports = async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const body = await readBody(req);
      const password = String(body.password || '');
      if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
        return json(res, 401, { ok: false, error: 'Invalid admin password.' });
      }
      const sessionId = require('node:crypto').randomUUID();
      res.setHeader('Set-Cookie', makeAuthCookie(sessionId));
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, error.statusCode || 500, { ok: false, error: error.message || 'Unable to sign in.' });
    }
  }

  const session = getSession(req);
  if (session) {
    return json(res, 200, { ok: true, authenticated: true });
  }

  return json(res, 401, { ok: false, error: 'Admin authentication required.' });
};

module.exports.requireAdmin = requireAdmin;

const { json, requireAdmin } = require('../lib/server');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed.' });

  const session = requireAdmin(req, res);
  if (!session) return;

  res.setHeader('Set-Cookie', 'si_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
  return json(res, 200, { ok: true, loggedOut: true });
};

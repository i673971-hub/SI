const { json } = require('./lib/server');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed.' });
  return json(res, 200, {
    ok: true,
    message: 'SI reserver service is running.',
    hasSupabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    hasAdminPassword: Boolean(process.env.ADMIN_PASSWORD),
    requiredConfirmations: Number(process.env.REQUIRED_CONFIRMATIONS || 2)
  });
};

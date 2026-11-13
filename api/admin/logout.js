const { json, requireAdmin, createSupabaseClient } = require('../lib/server');

module.exports = async function handler(req, res) {
  const session = requireAdmin(req, res);
  if (!session) return;
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed.' });

  try {
    const client = createSupabaseClient();
    const { data, error } = await client.from('reservations').select('*').order('created_at', { ascending: false }).limit(250);
    if (error) throw error;
    return json(res, 200, { reservations: data || [] });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message || 'Unable to load reservations.' });
  }
};

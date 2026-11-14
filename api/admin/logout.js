const { json, requireAdmin, getAllReservations } = require('../lib/server');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed.' });

  const session = requireAdmin(req, res);
  if (!session) return;

  try {
    const reservations = await getAllReservations();
    return json(res, 200, { ok: true, reservations });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message || 'Unable to load reservations.' });
  }
};

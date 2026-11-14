const { json, getReservationById, ensureReady, verifyTransaction } = require('../../lib/server');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed.' });

  try {
    ensureReady();
    const id = req.query.id;
    const token = req.query.token || '';
    const record = await getReservationById(id);

    if (!record) return json(res, 404, { ok: false, error: 'Reservation not found.' });
    if (record.statusToken !== token) return json(res, 403, { ok: false, error: 'Invalid status token.' });

    if (record.txHash) {
      const refreshed = await verifyTransaction(record);
      if (refreshed.status !== record.status || refreshed.confirmations !== record.confirmations || refreshed.statusMessage !== record.statusMessage) {
        const { updateReservation } = require('../../lib/server');
        await updateReservation(id, refreshed);
      }
      return json(res, 200, { ok: true, ...refreshed });
    }

    return json(res, 200, { ok: true, ...record });
  } catch (error) {
    return json(res, error.statusCode || 500, { ok: false, error: error.message || 'Unable to check payment status.' });
  }
};

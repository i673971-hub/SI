const { json, readBody, ensureReady, getReservationById, updateReservation, getChainConfig, verifyTransaction } = require('../lib/server');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed.' });

  try {
    ensureReady();
    const body = await readBody(req);
    const id = body.reservationId;
    const token = body.statusToken;
    const txHash = body.txHash;

    if (!id || !token || !txHash) {
      return json(res, 400, { ok: false, error: 'reservationId, statusToken, and txHash are required.' });
    }

    const record = await getReservationById(id);
    if (!record) return json(res, 404, { ok: false, error: 'Reservation not found.' });
    if (record.statusToken !== token) return json(res, 403, { ok: false, error: 'Invalid status token.' });
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return json(res, 400, { ok: false, error: 'Invalid transaction hash.' });

    const existing = await getReservationByIdByTx(txHash);
    if (existing && existing.id !== id) {
      return json(res, 409, { ok: false, error: 'This transaction hash is already attached to another reservation.' });
    }

    const current = await getReservationById(id);
    const updated = await verifyTransaction({ ...current, txHash });
    await updateReservation(id, updated);

    return json(res, updated.status === 'paid' ? 200 : 202, { ok: true, ...updated });
  } catch (error) {
    return json(res, error.statusCode || 500, { ok: false, error: error.message || 'Unable to confirm payment.' });
  }
};

async function getReservationByIdByTx(txHash) {
  const { getAllReservations } = require('../lib/server');
  const rows = await getAllReservations();
  return rows.find((row) => row.txHash && row.txHash.toLowerCase() === txHash.toLowerCase()) || null;
}

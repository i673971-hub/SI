const { json, requireAdmin, getAllReservations, getChainConfig, getBalanceForChain } = require('../lib/server');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed.' });

  const session = requireAdmin(req, res);
  if (!session) return;

  try {
    const reservations = await getAllReservations();
    const counts = { total: reservations.length, paid: 0, pending: 0, review: 0, failed: 0 };

    for (const row of reservations) {
      if (row.status === 'paid') counts.paid += 1;
      else if (row.status === 'review') counts.review += 1;
      else if (row.status === 'failed') counts.failed += 1;
      else counts.pending += 1;
    }

    const balances = [];
    for (const [key, chain] of Object.entries(getChainConfig())) {
      if (!chain.rpc || !chain.treasury) {
        balances.push({ chain: key, name: chain.name, configured: false, balanceEth: 'Not configured' });
        continue;
      }
      try {
        const balance = await getBalanceForChain(chain);
        balances.push({ chain: key, name: chain.name, configured: true, balanceEth: `${balance} ETH` });
      } catch (error) {
        balances.push({ chain: key, name: chain.name, configured: true, balanceEth: 'RPC error' });
      }
    }

    return json(res, 200, { ok: true, counts, balances, requiredConfirmations: Number(process.env.REQUIRED_CONFIRMATIONS || 2) });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message || 'Unable to load summary.' });
  }
};

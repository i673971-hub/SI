const { json, requireAdmin, createSupabaseClient, getChainConfig } = require('../lib/server');

async function getSummary() {
  const client = createSupabaseClient();
  const { data, error } = await client.from('reservations').select('*').order('created_at', { ascending: false }).limit(250);
  if (error) throw error;

  const counts = { total: data.length, paid: 0, pending: 0, review: 0, failed: 0 };
  for (const row of data) {
    if (row.status === 'paid') counts.paid++;
    else if (row.status === 'review') counts.review++;
    else if (row.status === 'failed') counts.failed++;
    else counts.pending++;
  }

  const balances = [];
  const chains = getChainConfig();
  for (const key of Object.keys(chains)) {
    const chain = chains[key];
    if (!chain.rpc || !chain.treasury) {
      balances.push({ chain: key, name: chain.name, configured: false, balanceEth: 'Not configured' });
      continue;
    }
    try {
      const response = await fetch(chain.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [chain.treasury, 'latest'] })
      });
      const result = await response.json();
      const wei = result && result.result ? BigInt(result.result) : 0n;
      balances.push({ chain: key, name: chain.name, configured: true, balanceEth: `${Number(wei) / 1e18} ETH` });
    } catch (error) {
      balances.push({ chain: key, name: chain.name, configured: true, balanceEth: 'RPC error' });
    }
  }

  return { counts, balances };
}

module.exports = async function handler(req, res) {
  const session = requireAdmin(req, res);
  if (!session) return;
  try {
    const summary = await getSummary();
    return json(res, 200, summary);
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message || 'Unable to load summary.' });
  }
};

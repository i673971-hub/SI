const { json, readBody, requireAdmin, createSupabaseClient, getChainConfig } = require('./lib/server');

async function getSummary() {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.from('reservations').select('*').order('created_at', { ascending: false }).limit(250);
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
  if (req.method === 'GET') {
    const session = requireAdmin(req, res);
    if (!session) return;
    const data = await getSummary();
    return json(res, 200, data);
  }

  if (req.method === 'POST') {
    try {
      const body = await readBody(req);
      const password = String(body.password || '');
      if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
        return json(res, 401, { ok: false, error: 'Invalid admin password.' });
      }
      const sessionId = `${Date.now()}:${require('node:crypto').randomBytes(16).toString('hex')}`;
      res.setHeader('Set-Cookie', `si_admin=${encodeURIComponent(`${sessionId}.${require('node:crypto').createHmac('sha256', process.env.SESSION_SECRET || 'development-secret').update(sessionId).digest('hex')}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${8 * 60 * 60}; Secure`);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, error.statusCode || 500, { ok: false, error: error.message || 'Unable to login.' });
    }
  }

  return json(res, 405, { ok: false, error: 'Method not allowed.' });
};

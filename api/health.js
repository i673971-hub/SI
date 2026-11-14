function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return send(res, 405, { ok: false, error: 'Method not allowed.' });
  }
  return send(res, 200, {
    ok: true,
    paymentsEnabled: false,
    enabledChains: [],
    message: 'Payment processing is disabled while the backend is being repaired.'
  });
};

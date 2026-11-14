function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  return send(res, 503, {
    ok: false,
    error: 'Admin backend is temporarily disabled while authentication and database access are repaired.'
  });
};

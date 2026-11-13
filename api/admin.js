const { json, readBody, getSession, requireAdmin, makeAuthCookie, createSupabaseClient, getChainConfig, isValidAddress } = require('./lib/server');

const TIERS = {
  waitlist: { amountEth: '0.005', amountWei: '5000000000000000' },
  adopter: { amountEth: '0.02', amountWei: '20000000000000000' }
};

function getAdminHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>SI Admin</title>
  <style>
    * { box-sizing: border-box; }
    body { margin:0; font:14px/1.5 Inter, system-ui, sans-serif; background:#f5f6fb; color:#171a22; }
    .wrap { max-width: 460px; margin: 80px auto; padding: 24px; border: 1px solid #ddd; border-radius: 18px; background:white; }
    h1 { margin: 0 0 14px; font-size: 2rem; }
    p { margin: 0 0 12px; color: #555; }
    label { display:block; font-weight:700; margin-bottom:6px; }
    input { width:100%; padding:12px 14px; border:1px solid #d9dce5; border-radius:10px; font:inherit; }
    button { width:100%; margin-top:16px; padding:12px 14px; border:none; border-radius:12px; background:linear-gradient(135deg,#1d4ed8,#7c3aed); color:white; font-weight:700; cursor:pointer; }
    .error { margin-top:12px; color:#b91c1c; min-height:20px; }
    .hidden { display:none; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>SI Admin</h1>
    <p>Sign in to view the reservation ledger and treasury summary.</p>
    <form id="login-form">
      <label for="password">Admin password</label>
      <input id="password" type="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
      <div id="error" class="error"></div>
    </form>
  </div>
  <script>
    const form = document.getElementById('login-form');
    const error = document.getElementById('error');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = document.getElementById('password').value;
      error.textContent = '';
      try {
        const res = await fetch('/api/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Login failed.');
        }
        window.location.href = '/admin';
      } catch (err) {
        error.textContent = err.message || 'Login failed.';
      }
    });
  </script>
</body>
</html>`;
}

function getDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>SI Reservation Admin</title>
  <style>
    * { box-sizing: border-box; }
    body { margin:0; background:#f5f6fb; color:#1d2433; font:14px/1.5 Inter, system-ui, sans-serif; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 32px 20px 60px; }
    .top { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:20px; }
    h1 { margin: 0; font-size: 2rem; }
    .btn { border:none; border-radius:10px; padding:10px 16px; font-weight:700; cursor:pointer; background:#111827; color:white; }
    .secondary { background: white; border:1px solid #d7dbe6; color:#18212f; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; margin-bottom:18px; }
    .card { background:white; border:1px solid #dfe3ee; border-radius:16px; padding:18px; }
    .stat-label { color:#667085; font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .stat-val { font-size:2rem; margin-top:6px; font-weight:700; }
    table { width:100%; border-collapse:collapse; margin-top:14px; }
    th, td { text-align:left; padding:12px 10px; border-bottom:1px solid #edf0f6; vertical-align:top; }
    th { color:#667085; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    .tag { display:inline-block; padding:4px 8px; border-radius:999px; font-size:11px; font-weight:700; }
    .paid { background:#dcfce7; color:#166534; }
    .pending { background:#fef3c7; color:#92400e; }
    .review { background:#fee2e2; color:#991b1b; }
    .failed { background:#f3f4f6; color:#374151; }
    .muted { color:#667085; }
    .hidden { display:none; }
    .balances { display:grid; grid-template-columns: repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-bottom:22px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <h1>Reservation admin</h1>
      <form action="/api/admin/logout" method="POST">
        <button class="btn secondary" type="submit">Sign out</button>
      </form>
    </div>

    <div id="summary" class="grid"></div>
    <div class="card">
      <h2> Treasury balances </h2>
      <div id="balances" class="balances"></div>
    </div>

    <div class="card" style="margin-top:22px;">
      <div class="top" style="margin-bottom:0;">
        <h2 style="margin:0;">Reservations</h2>
      </div>
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Status</th>
            <th>Tier</th>
            <th>Chain</th>
            <th>Amount</th>
            <th>Wallet</th>
            <th>Tx hash</th>
            <th>Confirmations</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </div>

  <script>
    async function loadData() {
      const [summaryRes, reservationsRes] = await Promise.all([
        fetch('/api/admin/summary'),
        fetch('/api/admin/reservations')
      ]);
      const summary = await summaryRes.json();
      const reservations = await reservationsRes.json();
      const stats = document.getElementById('summary');
      const cards = [
        ['Total', summary.counts.total],
        ['Paid', summary.counts.paid],
        ['Pending', summary.counts.pending],
        ['Review', summary.counts.review],
        ['Failed', summary.counts.failed]
      ];
      stats.innerHTML = cards.map(([label, value]) => `
        <div class="card">
          <div class="stat-label">${label}</div>
          <div class="stat-val">${value}</div>
        </div>
      `).join('');

      const balances = document.getElementById('balances');
      balances.innerHTML = (summary.balances || []).map((item) => `
        <div class="card">
          <div class="stat-label">${item.name}</div>
          <div class="stat-val" style="font-size:1.2rem;">${item.balanceEth ?? item.error ?? 'Not configured'}</div>
        </div>
      `).join('');

      const rows = document.getElementById('rows');
      rows.innerHTML = (reservations.reservations || []).map((item) => {
        const tagClass = item.status === 'paid' ? 'paid' : item.status === 'pending' || item.status === 'confirming' ? 'pending' : item.status === 'review' ? 'review' : 'failed';
        return `
          <tr>
            <td>${new Date(item.createdAt).toLocaleString()}</td>
            <td><span class="tag ${tagClass}">${item.status}</span></td>
            <td>${item.tier}</td>
            <td>${item.chain}</td>
            <td>${item.amountEth} ETH</td>
            <td>${item.walletAddress.slice(0,6)}...${item.walletAddress.slice(-4)}</td>
            <td>${item.txHash ? `${item.txHash.slice(0,8)}...${item.txHash.slice(-6)}` : '—'}</td>
            <td>${item.confirmations || 0}</td>
            <td>${item.statusMessage || ''}</td>
          </tr>
        `;
      }).join('');
    }

    loadData().catch((err) => {
      document.getElementById('summary').innerHTML = '<div class="card"><div class="stat-label">Error</div><div class="stat-val" style="font-size:1rem;">Unable to load data.</div></div>';
      console.error(err);
    });
  </script>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  const session = getSession(req);
  if (req.method === 'POST') {
    try {
      const body = await readBody(req);
      const password = String(body.password || '');
      if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
        return json(res, 401, { ok: false, error: 'Invalid admin password.' });
      }
      const sessionId = `${Date.now()}:${crypto.randomBytes(16).toString('hex')}`;
      res.setHeader('Set-Cookie', makeAuthCookie(sessionId));
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, error.statusCode || 500, { ok: false, error: error.message || 'Error logging in.' });
    }
  }

  if (session) {
    return res.end(getDashboardHtml());
  }

  return res.end(getAdminHtml());
};

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

loadDotEnv();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const REQUIRED_CONFIRMATIONS = Math.max(1, Number(process.env.REQUIRED_CONFIRMATIONS || 2));
const DATA_DIR = path.join(__dirname, 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'reservations.json');
const TIERS = Object.freeze({ waitlist: '5000000000000000', adopter: '20000000000000000' });
const CHAINS = Object.freeze({
  ethereum: { chainId: Number(process.env.ETH_CHAIN_ID || 1), name: 'Ethereum', rpc: process.env.ETH_RPC_URL || '', treasury: process.env.ETH_TREASURY || '' },
  base: { chainId: Number(process.env.BASE_CHAIN_ID || 8453), name: 'Base', rpc: process.env.BASE_RPC_URL || '', treasury: process.env.BASE_TREASURY || '' }
});
const SOL_TREASURY = process.env.SOL_TREASURY || '';
const sessions = new Map();
const rateLimits = new Map();
let ledger = [];
let writeQueue = Promise.resolve();

function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
function validAddress(value) { return /^0x[0-9a-fA-F]{40}$/.test(value || ''); }
function json(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(body);
}
function cookieOptions(maxAge) { return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`; }
function signSession(id) { return crypto.createHmac('sha256', SESSION_SECRET).update(id).digest('hex'); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function getSession(req) {
  const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('si_admin='));
  if (!raw) return null;
  const parts = decodeURIComponent(raw.slice('si_admin='.length)).split('.');
  if (parts.length !== 2 || !safeEqual(signSession(parts[0]), parts[1])) return null;
  const session = sessions.get(parts[0]);
  if (!session || session.expiresAt < Date.now()) { sessions.delete(parts[0]); return null; }
  return { id: parts[0], ...session };
}
function requireAdmin(req, res, csrf = false) {
  const session = getSession(req);
  if (!session) { json(res, 401, { error: 'Admin login required.' }); return null; }
  if (csrf && !safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) { json(res, 403, { error: 'Invalid CSRF token.' }); return null; }
  return session;
}
function rateLimit(req, key, max, windowMs) {
  const id = `${key}:${req.socket.remoteAddress || 'unknown'}`;
  const now = Date.now(); let item = rateLimits.get(id);
  if (!item || item.until < now) item = { count: 0, until: now + windowMs };
  item.count++; rateLimits.set(id, item);
  return item.count <= max;
}
async function readBody(req, max = 16_384) {
  let data = ''; for await (const chunk of req) { data += chunk; if (data.length > max) throw Object.assign(new Error('Request body too large.'), { status: 413 }); }
  try { return data ? JSON.parse(data) : {}; } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}
function persistLedger() {
  writeQueue = writeQueue.then(async () => {
    await fs.promises.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    const temp = `${LEDGER_FILE}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
    await fs.promises.rename(temp, LEDGER_FILE);
  });
  return writeQueue;
}
function mutateLedger(mutator) {
  const run = writeQueue.then(async () => { const result = mutator(); await fs.promises.mkdir(DATA_DIR, { recursive: true, mode: 0o700 }); const temp = `${LEDGER_FILE}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`; await fs.promises.writeFile(temp, JSON.stringify(ledger, null, 2), { mode: 0o600 }); await fs.promises.rename(temp, LEDGER_FILE); return result; });
  writeQueue = run.catch(() => {});
  return run;
}
async function rpc(chain, method, params) {
  if (!chain.rpc) throw new Error(`${chain.name} RPC is not configured; payment verification is disabled.`);
  const response = await fetch(chain.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`${chain.name} RPC returned HTTP ${response.status}.`);
  const result = await response.json();
  if (result.error) throw new Error(`${chain.name} RPC error: ${result.error.message || 'request failed'}`);
  return result.result;
}
function safeHexNumber(value) { try { return BigInt(value || '0x0'); } catch { return 0n; } }
async function verifyPayment(row) {
  const chain = CHAINS[row.chain];
  if (!chain || !chain.rpc || !validAddress(chain.treasury)) return { state: 'verification_unavailable', reason: 'Chain RPC or treasury configuration is missing.' };
  try {
    const [tx, receipt, latestHex] = await Promise.all([
      rpc(chain, 'eth_getTransactionByHash', [row.txHash]),
      rpc(chain, 'eth_getTransactionReceipt', [row.txHash]),
      rpc(chain, 'eth_blockNumber', [])
    ]);
    if (!tx || !receipt) return { state: 'confirming', reason: 'Transaction has not been indexed yet.' };
    const latest = safeHexNumber(latestHex); const block = safeHexNumber(receipt.blockNumber);
    if (receipt.status !== '0x1') return { state: 'failed', reason: 'Transaction reverted on chain.' };
    if ((tx.from || '').toLowerCase() !== row.walletAddress.toLowerCase()) return { state: 'review', reason: 'Transaction sender differs from the reservation wallet.' };
    if ((tx.to || '').toLowerCase() !== chain.treasury.toLowerCase()) return { state: 'review', reason: 'Transaction destination differs from the configured treasury.' };
    if (safeHexNumber(tx.value) !== BigInt(row.amountWei)) return { state: 'review', reason: 'Transaction amount does not match the selected reservation tier.' };
    if (tx.input && tx.input !== '0x') return { state: 'review', reason: 'Expected a direct native ETH transfer, not contract calldata.' };
    const confirmations = latest >= block ? Number(latest - block + 1n) : 0;
    if (confirmations < REQUIRED_CONFIRMATIONS) return { state: 'confirming', confirmations, reason: `Waiting for ${REQUIRED_CONFIRMATIONS} confirmations.` };
    return { state: 'paid', confirmations, blockNumber: block.toString(), reason: 'Payment verified on chain.' };
  } catch (error) {
    return { state: 'verification_unavailable', reason: error.message || 'Could not verify with the chain RPC.' };
  }
}
async function checkRecord(id, statusToken) {
  const row = ledger.find(item => item.id === id);
  if (!row || !safeEqual(row.statusTokenHash, crypto.createHash('sha256').update(statusToken || '').digest('hex'))) return null;
  if (!row.txHash || ['paid', 'failed', 'review'].includes(row.status)) return row;
  const result = await verifyPayment(row);
  if (result.state !== row.status || result.confirmations !== row.confirmations || result.reason !== row.statusMessage) {
    await mutateLedger(() => { const current = ledger.find(item => item.id === id); if (current && current.txHash) { current.status = result.state; current.confirmations = result.confirmations || 0; current.statusMessage = result.reason; if (result.state === 'paid') { current.paidAt = new Date().toISOString(); current.blockNumber = result.blockNumber; } current.updatedAt = new Date().toISOString(); } });
  }
  return ledger.find(item => item.id === id);
}
function publicRow(row) {
  const { statusTokenHash, ...safe } = row;
  return safe;
}
async function serveStatic(pathname, res) {
  const allowed = new Set(['/','/index.html','/treasury.html','/reserve.html','/admin.html']);
  if (!allowed.has(pathname)) return false;
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  try {
    const data = await fs.promises.readFile(path.join(__dirname, file));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" });
    res.end(data); return true;
  } catch { json(res, 404, { error: 'Page not found.' }); return true; }
}
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;
  if (req.method === 'GET' && await serveStatic(route, res)) return;
  if (req.method === 'GET' && route === '/api/health') {
    return json(res, 200, { ok: true, paymentsEnabled: Object.values(CHAINS).some(c => c.rpc && validAddress(c.treasury)), enabledChains: Object.entries(CHAINS).filter(([,c]) => c.rpc && validAddress(c.treasury)).map(([key,c]) => ({ id:key, name:c.name, chainId:c.chainId })), requiredConfirmations: REQUIRED_CONFIRMATIONS });
  }
  if (req.method === 'POST' && route === '/api/reservations') {
    if (!rateLimit(req, 'intent', 20, 60_000)) return json(res, 429, { error: 'Too many reservation requests. Try again shortly.' });
    const body = await readBody(req); const chain = CHAINS[body.chain]; const tier = body.tier;
    if (!chain || !TIERS[tier] || !validAddress(body.walletAddress)) return json(res, 400, { error: 'Choose a supported chain and tier and provide a valid EVM wallet address.' });
    if (!chain.rpc || !validAddress(chain.treasury)) return json(res, 503, { error: `${chain.name} payment verification is not configured yet.` });
    const statusToken = crypto.randomBytes(32).toString('hex');
    const row = { id:crypto.randomUUID(), createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), chain:body.chain, chainId:chain.chainId, tier, amountWei:TIERS[tier], amountEth:tier === 'waitlist' ? '0.005' : '0.02', walletAddress:body.walletAddress, treasuryAddress:chain.treasury, txHash:null, status:'awaiting_payment', statusMessage:'Send the exact amount to the treasury address, then submit the transaction hash.', confirmations:0, statusTokenHash:crypto.createHash('sha256').update(statusToken).digest('hex') };
    await mutateLedger(() => ledger.unshift(row));
    return json(res, 201, { reservationId:row.id, statusToken, chainId:chain.chainId, chainName:chain.name, treasuryAddress:chain.treasury, amountEth:row.amountEth, tier });
  }
  if (req.method === 'POST' && route === '/api/reservations/confirm') {
    if (!rateLimit(req, 'confirm', 30, 60_000)) return json(res, 429, { error: 'Too many confirmation attempts.' });
    const body = await readBody(req); const row = ledger.find(item => item.id === body.reservationId);
    if (!row || !safeEqual(row.statusTokenHash, crypto.createHash('sha256').update(body.statusToken || '').digest('hex'))) return json(res, 404, { error: 'Reservation not found.' });
    if (!/^0x[0-9a-fA-F]{64}$/.test(body.txHash || '')) return json(res, 400, { error: 'Provide a valid EVM transaction hash.' });
    const used = ledger.find(item => item.txHash && item.txHash.toLowerCase() === body.txHash.toLowerCase());
    if (used && used.id !== row.id) return json(res, 409, { error: 'That transaction hash is already associated with another reservation.' });
    if (row.txHash && row.txHash.toLowerCase() !== body.txHash.toLowerCase()) return json(res, 409, { error: 'A transaction hash has already been submitted for this reservation.' });
    await mutateLedger(() => { const current = ledger.find(item => item.id === row.id); current.txHash = body.txHash; current.status = 'confirming'; current.statusMessage = 'Checking transaction with the chain RPC.'; current.updatedAt = new Date().toISOString(); });
    const updated = await checkRecord(row.id, body.statusToken);
    return json(res, updated.status === 'paid' ? 200 : 202, publicRow(updated));
  }
  const statusMatch = route.match(/^\/api\/reservations\/([0-9a-f-]+)\/status$/i);
  if (req.method === 'GET' && statusMatch) {
    const row = await checkRecord(statusMatch[1], url.searchParams.get('token'));
    if (!row) return json(res, 404, { error: 'Reservation not found.' });
    return json(res, 200, publicRow(row));
  }
  if (req.method === 'POST' && route === '/api/admin/login') {
    if (!rateLimit(req, 'login', 8, 15 * 60_000)) return json(res, 429, { error: 'Too many login attempts. Try later.' });
    const body = await readBody(req);
    if (!ADMIN_PASSWORD || !safeEqual(body.password || '', ADMIN_PASSWORD)) return json(res, 401, { error: 'Invalid credentials.' });
    const id = crypto.randomBytes(32).toString('hex'); const csrf = crypto.randomBytes(24).toString('hex'); const maxAge = 8 * 60 * 60;
    sessions.set(id, { csrf, expiresAt:Date.now() + maxAge * 1000 });
    return json(res, 200, { csrfToken:csrf }, { 'Set-Cookie':`si_admin=${encodeURIComponent(`${id}.${signSession(id)}`)}; ${cookieOptions(maxAge)}` });
  }
  if (req.method === 'POST' && route === '/api/admin/logout') {
    const session = requireAdmin(req, res, true); if (!session) return;
    sessions.delete(session.id); return json(res, 200, { ok:true }, { 'Set-Cookie':`si_admin=; ${cookieOptions(0)}` });
  }
  if (req.method === 'GET' && route === '/api/admin/summary') {
    if (!requireAdmin(req, res)) return;
    const counts = { total:ledger.length, paid:0, pending:0, review:0, failed:0 };
    for (const row of ledger) { if (row.status === 'paid') counts.paid++; else if (row.status === 'review') counts.review++; else if (row.status === 'failed') counts.failed++; else counts.pending++; }
    const balances = await Promise.all(Object.entries(CHAINS).map(async ([key,c]) => {
      if (!c.rpc || !validAddress(c.treasury)) return { chain:key, name:c.name, configured:false, balanceWei:null };
      try { const chainHex = await rpc(c,'eth_chainId',[]); if (Number(safeHexNumber(chainHex)) !== c.chainId) return { chain:key, name:c.name, configured:true, error:'RPC chain ID mismatch.' }; return { chain:key, name:c.name, configured:true, balanceWei:safeHexNumber(await rpc(c,'eth_getBalance',[c.treasury,'latest'])).toString() }; }
      catch (error) { return { chain:key, name:c.name, configured:true, error:error.message }; }
    }));
    return json(res, 200, { counts, balances, requiredConfirmations:REQUIRED_CONFIRMATIONS, solanaTreasury:SOL_TREASURY || null });
  }
  if (req.method === 'GET' && route === '/api/admin/reservations') {
    if (!requireAdmin(req, res)) return;
    const limit = Math.min(250, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    return json(res, 200, { reservations:ledger.slice(0,limit).map(publicRow) });
  }
  json(res, 404, { error:'Not found.' });
}
async function main() {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 16) throw new Error('Set ADMIN_PASSWORD to a unique password of at least 16 characters.');
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error('Set SESSION_SECRET to at least 32 characters of random data.');
  for (const [key,c] of Object.entries(CHAINS)) if (c.treasury && !validAddress(c.treasury)) throw new Error(`${key} treasury address is invalid.`);
  await fs.promises.mkdir(DATA_DIR, { recursive:true, mode:0o700 });
  try { ledger = JSON.parse(await fs.promises.readFile(LEDGER_FILE,'utf8')); if (!Array.isArray(ledger)) throw new Error('bad ledger'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Could not load ledger: ${error.message}`); ledger = []; await persistLedger(); }
  const server = http.createServer((req,res) => { handle(req,res).catch(error => { if (!res.headersSent) json(res,error.status || 500,{ error:error.status ? error.message : 'Internal server error.' }); else res.destroy(); if (!error.status) console.error(error); }); });
  server.listen(PORT, HOST, () => console.log(`SI reserve service listening at http://${HOST}:${PORT}`));
}
main().catch(error => { console.error(error.message); process.exit(1); });

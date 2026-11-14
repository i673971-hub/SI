const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

const DATA_DIR = path.join(process.cwd(), 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'reservations.json');

function json(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('Request body too large.'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(new Error('Invalid JSON body.'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function ensureReady() {
  const ready = Boolean(process.env.ADMIN_PASSWORD && process.env.SESSION_SECRET);
  if (!ready) {
    const error = new Error('Server configuration is incomplete. Set ADMIN_PASSWORD and SESSION_SECRET before enabling payment flows.');
    error.statusCode = 503;
    throw error;
  }
}

function getChainConfig() {
  return {
    ethereum: {
      id: 'ethereum',
      name: 'Ethereum',
      rpc: process.env.ETH_RPC_URL || '',
      treasury: process.env.ETH_TREASURY || '',
      chainId: Number(process.env.ETH_CHAIN_ID || 1)
    },
    base: {
      id: 'base',
      name: 'Base',
      rpc: process.env.BASE_RPC_URL || '',
      treasury: process.env.BASE_TREASURY || '',
      chainId: Number(process.env.BASE_CHAIN_ID || 8453)
    }
  };
}

function isValidAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ''));
}

function signValue(value) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'development-secret').update(value).digest('hex');
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

function makeAuthCookie(sessionId) {
  const signed = signValue(sessionId);
  return `si_admin=${encodeURIComponent(`${sessionId}.${signed}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${8 * 60 * 60}; Secure`;
}

function getSession(req) {
  const raw = getCookie(req, 'si_admin');
  if (!raw) return null;
  const [sessionId, signature] = raw.split('.');
  if (!sessionId || !signature) return null;
  if (signValue(sessionId) !== signature) return null;

  const createdAt = Number(sessionId.split(':')[0] || '0');
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > 8 * 60 * 60 * 1000) return null;
  return { sessionId };
}

function requireAdmin(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { ok: false, error: 'Admin authentication required.' });
    return null;
  }
  return session;
}

function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function readLedger() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = fs.readFileSync(LEDGER_FILE, 'utf8');
    return JSON.parse(file);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeLedger(rows) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tempFile = `${LEDGER_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tempFile, LEDGER_FILE);
}

async function createReservation(record) {
  const client = createSupabaseClient();
  if (client) {
    const { error } = await client.from('reservations').insert([record]);
    if (error) throw error;
    return record;
  }

  const rows = await readLedger();
  rows.unshift(record);
  await writeLedger(rows);
  return record;
}

async function getAllReservations() {
  const client = createSupabaseClient();
  if (client) {
    const { data, error } = await client.from('reservations').select('*').order('createdAt', { ascending: false });
    if (!error) return data || [];
  }

  return await readLedger();
}

async function getReservationById(id) {
  const client = createSupabaseClient();
  if (client) {
    const { data, error } = await client.from('reservations').select('*').eq('id', id).maybeSingle();
    if (!error) return data || null;
  }

  const rows = await readLedger();
  return rows.find((row) => row.id === id) || null;
}

async function updateReservation(id, patch) {
  const client = createSupabaseClient();
  if (client) {
    const { error } = await client.from('reservations').update(patch).eq('id', id);
    if (error) throw error;
    return patch;
  }

  const rows = await readLedger();
  const index = rows.findIndex((row) => row.id === id);
  if (index >= 0) {
    rows[index] = { ...rows[index], ...patch };
    await writeLedger(rows);
  }
  return patch;
}

function toWei(value) {
  return BigInt(value || '0');
}

async function getBalanceForChain(chain) {
  if (!chain.rpc) throw new Error(`${chain.name} RPC is not configured.`);
  const response = await fetch(chain.rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [chain.treasury, 'latest'] })
  });
  const result = await response.json();
  const wei = result && result.result ? BigInt(result.result) : 0n;
  return Number(wei) / 1e18;
}

async function verifyTransaction(record) {
  const chain = getChainConfig()[record.chain];
  if (!chain || !chain.rpc || !chain.treasury) {
    const error = new Error(`${record.chain} payment verification is not configured.`);
    error.statusCode = 503;
    throw error;
  }

  const txHash = record.txHash;
  const response = await fetch(chain.rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getTransactionByHash',
      params: [txHash]
    })
  });

  const transaction = await response.json();
  if (!transaction || !transaction.result) {
    return {
      ...record,
      status: 'confirming',
      confirmations: 0,
      statusMessage: 'Transaction is still pending on the chain.'
    };
  }

  const tx = transaction.result;
  const receiptResponse = await fetch(chain.rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] })
  });

  const receiptJson = await receiptResponse.json();
  const receipt = receiptJson && receiptJson.result ? receiptJson.result : null;
  const latestResponse = await fetch(chain.rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
  });
  const latestJson = await latestResponse.json();
  const latest = latestJson && latestJson.result ? BigInt(latestJson.result) : 0n;
  const txValue = tx && tx.value ? BigInt(tx.value) : 0n;

  const txFrom = (tx && tx.from || '').toLowerCase();
  const txTo = (tx && tx.to || '').toLowerCase();
  const treasury = (chain.treasury || '').toLowerCase();
  const wallet = (record.walletAddress || '').toLowerCase();
  const amount = BigInt(record.amountWei || '0');

  if (!receipt || receipt.status !== '0x1') {
    return {
      ...record,
      status: 'failed',
      confirmations: 0,
      statusMessage: 'Transaction reverted or was not successful.'
    };
  }

  if (txFrom !== wallet) {
    return { ...record, status: 'review', confirmations: 0, statusMessage: 'Sender does not match the reservation wallet.' };
  }

  if (txTo !== treasury) {
    return { ...record, status: 'review', confirmations: 0, statusMessage: 'Destination does not match the configured treasury.' };
  }

  if (txValue !== amount) {
    return { ...record, status: 'review', confirmations: 0, statusMessage: 'Amount does not match the selected tier.' };
  }

  const confirmations = Number(latest - BigInt(receipt.blockNumber || '0x0') + 1n);
  if (confirmations < Number(process.env.REQUIRED_CONFIRMATIONS || 2)) {
    return {
      ...record,
      txHash,
      status: 'confirming',
      confirmations,
      statusMessage: `Waiting for ${Number(process.env.REQUIRED_CONFIRMATIONS || 2)} confirmations.`
    };
  }

  return {
    ...record,
    txHash,
    status: 'paid',
    confirmations,
    statusMessage: 'Payment verified on chain.'
  };
}

module.exports = {
  json,
  readBody,
  ensureReady,
  getChainConfig,
  isValidAddress,
  signValue,
  getCookie,
  makeAuthCookie,
  getSession,
  requireAdmin,
  createReservation,
  getAllReservations,
  getReservationById,
  updateReservation,
  getBalanceForChain,
  verifyTransaction
};

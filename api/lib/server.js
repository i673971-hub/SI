const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createClient } = require('@supabase/supabase-js');

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
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Request body too large.'));
      }
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

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader
    .split(';')
    .map(v => v.trim())
    .find(v => v.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

function signValue(value) {
  const secret = process.env.SESSION_SECRET || 'development-secret';
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function makeAuthCookie(sessionId) {
  const signed = signValue(sessionId);
  return `si_admin=${encodeURIComponent(`${sessionId}.${signed}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${8 * 60 * 60}; Secure`;
}

function getSession(req) {
  const cookieValue = getCookie(req, 'si_admin');
  if (!cookieValue) return null;
  const [sessionId, signature] = cookieValue.split('.');
  if (!sessionId || !signature) return null;
  if (signValue(sessionId) !== signature) return null;
  const [timestamp] = sessionId.split(':');
  const created = Number(timestamp || '0');
  if (!Number.isFinite(created) || Date.now() - created > 8 * 60 * 60 * 1000) return null;
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
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
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

function readFileFromRoot(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

module.exports = {
  json,
  readBody,
  getSession,
  requireAdmin,
  signValue,
  makeAuthCookie,
  getCookie,
  createSupabaseClient,
  getChainConfig,
  isValidAddress,
  readFileFromRoot
};

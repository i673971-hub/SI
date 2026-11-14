const { json, getChainConfig } = require('./lib/server');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed.' });

  const chains = getChainConfig();
  const enabled = Object.entries(chains)
    .filter(([, value]) => !!value.rpc && !!value.treasury)
    .map(([id, value]) => ({ id, name: value.name, chainId: value.chainId }));

  const ready = Boolean(
    process.env.ADMIN_PASSWORD &&
    process.env.SESSION_SECRET &&
    enabled.length >= 1
  );

  return json(res, ready ? 200 : 503, {
    ok: ready,
    paymentsEnabled: ready,
    enabledChains: enabled,
    requiredConfirmations: Number(process.env.REQUIRED_CONFIRMATIONS || 2),
    message: ready
      ? 'Payment verification is ready for the configured chains.'
      : 'Payment verification is disabled until ADMIN_PASSWORD, SESSION_SECRET, and RPC settings are configured.'
  });
};

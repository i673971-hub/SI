const { json, readBody, getChainConfig, isValidAddress, createReservation, ensureReady } = require('./lib/server');

const TIERS = {
  waitlist: { amountEth: '0.005', amountWei: '5000000000000000' },
  adopter: { amountEth: '0.02', amountWei: '20000000000000000' }
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed.' });

  try {
    ensureReady();
    const body = await readBody(req);
    const chainKey = body.chain;
    const tier = body.tier;
    const walletAddress = String(body.walletAddress || '');
    const chain = getChainConfig()[chainKey];

    if (!chain || !TIERS[tier] || !isValidAddress(walletAddress)) {
      return json(res, 400, { ok: false, error: 'Invalid chain, tier, or wallet address.' });
    }

    if (!chain.rpc || !chain.treasury) {
      return json(res, 503, { ok: false, error: `${chain.name} payment verification is not configured.` });
    }

    const reservationId = cryptoId();
    const record = {
      id: reservationId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chain: chainKey,
      chainId: chain.chainId,
      tier,
      amountEth: TIERS[tier].amountEth,
      amountWei: TIERS[tier].amountWei,
      walletAddress,
      treasuryAddress: chain.treasury,
      txHash: null,
      status: 'awaiting_payment',
      statusMessage: 'Waiting for a verified on-chain payment.',
      confirmations: 0,
      statusToken: cryptoId()
    };

    await createReservation(record);

    return json(res, 201, {
      ok: true,
      reservationId: record.id,
      statusToken: record.statusToken,
      amountEth: record.amountEth,
      treasuryAddress: record.treasuryAddress,
      chain: chainKey
    });
  } catch (error) {
    return json(res, error.statusCode || 500, {
      ok: false,
      error: error.message || 'Unable to create reservation.'
    });
  }
};

function cryptoId() {
  return require('node:crypto').randomUUID();
}

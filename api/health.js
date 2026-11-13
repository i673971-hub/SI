const { json, readBody, createSupabaseClient, getChainConfig, isValidAddress } = require('./lib/server');

const TIERS = {
  waitlist: { amountEth: '0.005', amountWei: '5000000000000000' },
  adopter: { amountEth: '0.02', amountWei: '20000000000000000' }
};

module.exports = async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const body = await readBody(req);
      const chainKey = body.chain;
      const tier = body.tier;
      const walletAddress = String(body.walletAddress || '');
      const chainConfig = getChainConfig()[chainKey];

      if (!chainConfig || !TIERS[tier] || !isValidAddress(walletAddress)) {
        return json(res, 400, { ok: false, error: 'Invalid chain, tier, or wallet address.' });
      }

      const client = createSupabaseClient();
      const reservation = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        chain: chainKey,
        tier,
        wallet_address: walletAddress,
        treasury_address: chainConfig.treasury,
        tx_hash: null,
        amount_eth: TIERS[tier].amountEth,
        amount_wei: TIERS[tier].amountWei,
        status: 'pending',
        status_message: 'Waiting for a verified on-chain payment.',
        confirmations: 0
      };

      const { error } = await client.from('reservations').insert([reservation]);
      if (error) throw error;

      return json(res, 201, {
        ok: true,
        reservationId: reservation.id,
        amountEth: reservation.amount_eth,
        treasuryAddress: reservation.treasury_address,
        chain: chainKey
      });
    } catch (error) {
      return json(res, error.statusCode || 500, { ok: false, error: error.message || 'Failed to create reservation.' });
    }
  }

  if (req.method === 'GET') {
    return json(res, 405, { ok: false, error: 'Use POST to create a reservation.' });
  }

  return json(res, 405, { ok: false, error: 'Method not allowed.' });
};

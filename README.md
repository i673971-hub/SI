# SI reservations and treasury admin

This adds a small Node.js 20+ backend, a wallet-connected reservation flow, and a password-protected admin ledger. It accepts **native ETH only** on Ethereum Mainnet and Base. The server independently checks transaction sender, recipient, exact tier amount, successful receipt, configured chain endpoint, and confirmation count before marking a reservation paid. Solana remains listed on the public treasury page but is not enabled for reservation payments in this version.

## Important security / deployment requirements

- Do not use this as a production payment service until you have deployed it on a trusted HTTPS host and completed a test transaction on each enabled chain.
- Configure a strong `ADMIN_PASSWORD`, a long random `SESSION_SECRET`, and private, reliable RPC endpoints in the deployment environment. Never commit `.env` or secrets.
- `ADMIN_PASSWORD` is the only admin login in this minimal implementation. Add managed identity/MFA, backups, monitoring, and a durable database before significant production use.
- Ledger data is stored in `data/reservations.json`. Persist that directory on the host and back it up. Ephemeral serverless hosting will lose this ledger.
- Public reservation/payment routes are rate-limited in-process; use a reverse proxy/WAF for production.
- The backend verifies only exact native ETH transfers for 0.005 ETH (waitlist) or 0.02 ETH (adopter). No ERC-20, Solana, refunds, or off-chain/manual payment claims.

## Run locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set all required values. Use testnet-only treasury addresses/RPC URLs for development; production wallet addresses are already prefilled from the owner-provided public addresses.
3. Run `npm start` and open `http://localhost:3000/reserve.html` or `http://localhost:3000/admin.html`.
4. Add funds for gas to a test wallet and use MetaMask on the chosen network. The browser requests a direct payment transaction to the configured treasury address. Inspect the wallet confirmation screen before approving.

The `mainnet` RPC endpoint must connect to chain ID 1 and `base` to chain ID 8453. The application rejects a mismatch. For development, change the corresponding configured chain ID and use test-specific addresses only after adapting the application configuration; do not point a testnet app at production treasury wallets.

## Environment variables

See `.env.example`. The server refuses to start without admin password, session secret, and valid treasury addresses. EVM payment confirmation is disabled for any chain lacking its RPC URL.

## Routes

- `GET /api/health` — service/config health (does not reveal secret values).
- `POST /api/reservations` — create a pending intent (`chain`, `tier`, `walletAddress`). Returns an unpredictable reservation ID and status token.
- `POST /api/reservations/confirm` — attach a transaction hash and run independent on-chain verification.
- `GET /api/reservations/:id/status?token=...` — poll payment verification using the secret token returned at intent creation.
- `POST /api/admin/login`, `POST /api/admin/logout` — admin session.
- `GET /api/admin/summary`, `GET /api/admin/reservations` — authenticated ledger and treasury balances.

The public website is not the source of truth for payment status. Only a verified successful on-chain receipt is counted as paid.

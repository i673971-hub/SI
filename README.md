# SI website — deployment status

The public website is served as static files on Vercel. The reservation/payment and admin API routes are deliberately disabled while the serverless backend is repaired and tested. **Do not accept payments or send funds through this site.**

## Current routes

- `/` — public website
- `/reserve` — reservation page; payment is disabled
- `/admin` — admin page; backend is disabled
- `/api/health` — reports that payment processing is disabled
- `/api/reservations` and `/api/admin/*` — return HTTP 503 while disabled

## Before enabling reservations or admin

The current files must be replaced with a tested Vercel serverless implementation. The previous attempt mixed handler contents between API files and used an invalid `vercel.json`. The old `server.js` uses an in-memory session map and local JSON ledger, which are not durable or reliable in Vercel serverless functions. Environment variables alone do not make that implementation safe or functional.

Required work before payments can be enabled:

1. Implement reservation creation, transaction verification, and status polling as independent serverless routes.
2. Store reservation data durably in Supabase; keep the service-role key server-only.
3. Implement secure admin authentication and protect every admin endpoint.
4. Add and verify the Supabase schema and indexes.
5. Test the API and payment flow on test networks, including wrong-chain, wrong-amount, reused-transaction, and failed-transaction cases.
6. Only then enable payment endpoints and configure production RPC endpoints.

Keep Vercel secrets out of GitHub and chat. Rotate any credentials that were shared outside Vercel.

# Pancho Bull/Bear PvP (Devnet)

## Quick start

```bash
npm install
npm run dev
```

## Cloudflare deploy (Workers & Pages)

This app uses API routes and SSR, so deploy with Cloudflare Workers runtime (inside the Workers & Pages dashboard).

```bash
npm run cf:build
npm run cf:deploy
```

## Ops quick controls

Run from project root:

```bash
# Health
npm run ops:health

# Ops summary (recent settlement stats)
npm run ops:summary

# Alert check (fails when health degrades or lag/pending thresholds are exceeded)
npm run ops:alert

# Smoke check (canary join/results)
npm run ops:smoke

# Prelaunch gate (blocks launch on unsafe config/health)
npm run ops:prelaunch

# D1 backup and verification
npm run ops:backup:d1
npm run ops:backup:verify

# Emergency pause/resume
npm run ops:pause:joins
npm run ops:resume:joins
npm run ops:pause:sim-settlement
npm run ops:resume:sim-settlement
npm run ops:pause:all
npm run ops:resume:all
```

Treasury lock:

- Set `PANCHO_EXPECTED_TREASURY_WALLET` to your real treasury.
- Runtime and prelaunch checks fail if configured treasury differs.

Public runtime status:

- `GET /api/status` returns `ok|degraded|paused` plus pause flags and settlement lag summary.
- UI polls this endpoint and shows a live incident banner when status is not `ok`.

## Production automation (alerts + backups)

Included workflows:

- `.github/workflows/ops-alert.yml` (every 10 min + manual)
- `.github/workflows/d1-backup-verify.yml` (daily + manual)

Required GitHub secrets:

- `OPS_BASE` (example: `https://arena.panchoverse.com`)
- `OPS_API_KEY`
- `OPS_ALERT_WEBHOOK_URL` (optional but recommended)
- `CLOUDFLARE_API_TOKEN` (for D1 export)
- `CLOUDFLARE_ACCOUNT_ID` (for D1 export)

Cloudflare dashboard alert rule recommendations:

- Worker error rate > 2% for 5 min
- Worker p95 latency > 1500 ms for 5 min
- D1 errors > 0 for 5 min

Set runtime secrets before deploy:

```bash
wrangler secret put SETTLE_API_KEY
wrangler secret put SOLANA_RPC_URL
```

## Auto-settlement wiring

For auto payouts, escrow deposits and payout signer must match or be funded correctly.

- `NEXT_PUBLIC_ESCROW_WALLET`: wallet users deposit into from the UI.
- `PAYOUT_KEYPAIR_PATH`: local keypair file used by `/api/settle` to send payouts/refunds.
- `TREASURY_WALLET` (optional): fee wallet. If omitted, fees stay in payout signer wallet.
- `SOLANA_RPC_URL` (optional): RPC endpoint (defaults to devnet).
- `NEXT_PUBLIC_SOLANA_RPC_URL` (optional): client RPC endpoint.
- `SETTLE_API_KEY` (required for `/api/settle`): bearer-like key for secured settlement trigger.
- `DATABASE_URL` (recommended for production): Postgres connection string.
- `DATABASE_SSL=require` (optional): enables SSL mode for managed Postgres providers.
- `AUDIT_WEBHOOK_URL` (optional): receives WARN/ERROR structured audit events.

Example:

```bash
NEXT_PUBLIC_ESCROW_WALLET=Dkm5UeGTaeXDkauBMtNwbHGw7q2aXbrqb9HBQVN5GFx8
PAYOUT_KEYPAIR_PATH=/Users/dirdiebirdies/.config/solana/id.json
TREASURY_WALLET=Dkm5UeGTaeXDkauBMtNwbHGw7q2aXbrqb9HBQVN5GFx8
```

## How settlement works

1. User joins round and signs devnet transfer to escrow.
2. App posts the entry to `/api/entries`.
3. Keeper calls `/api/settle` every few seconds.
4. When a round is past end time:
   - one-sided/tie -> refund all entries
   - two-sided -> winners split pool pro-rata minus fee
5. Transfers and settlement details are stored in Postgres when `DATABASE_URL` is set; otherwise local fallback is `data/ledger.json`.

## Abuse protection

- `/api/entries` now enforces replay + rate controls:
  - Signature replay guard (`signature` cannot be registered twice).
  - Per-wallet and per-IP join attempt throttles (rolling 60s window).
  - Limits are enforced before expensive RPC verification.
  - Stake guardrails reject out-of-range stake values.

## Multi-instance safety

- Settlement now uses cross-process round locks in Postgres to prevent two keepers from settling the same round concurrently.

## Migrate existing ledger to Postgres

If you already have `data/ledger.json`, import it once after setting `DATABASE_URL`:

```bash
npm run migrate:ledger
```

## On-chain migration (in progress)

An Anchor program scaffold now exists in `/onchain` to move escrow + settlement fully on Solana.

- Program path: `onchain/programs/pancho_pvp/src/lib.rs`
- Root scripts:
  - `npm run onchain:preflight`
  - `npm run onchain:check`
  - `npm run onchain:build`

Current state:
- Custody and payout logic is implemented on-chain (round/vault/position PDAs, join/settle/claim).
- Oracle validation is enforced on-chain via legacy Pyth account parsing (owner + expected account + staleness checks).

### On-chain keeper (create/lock/settle crank)

Use this when `NEXT_PUBLIC_USE_ONCHAIN_PROGRAM=true` so rounds are continuously created, locked, and settled on Solana.

Run:

```bash
npm run onchain:keeper
```

Required env:
- `PANCHO_KEEPER_KEYPAIR_PATH` or `PANCHO_KEEPER_SECRET_KEY` (JSON array private key)
- `PANCHO_ORACLE_PROGRAM_ID` (owner program of the oracle price accounts)
- `PANCHO_ORACLE_ACCOUNT_SOL`
- `PANCHO_ORACLE_ACCOUNT_BTC`
- `PANCHO_ORACLE_ACCOUNT_ETH`
- `PANCHO_PROGRAM_ID` (or keep default)

Optional env:
- `PANCHO_AUTO_INIT_CONFIG=true` (auto-create config if missing)
- `PANCHO_TREASURY_WALLET` (required only when auto-init is enabled)
- `PANCHO_FEE_BPS` (default `600`)
- `PANCHO_ORACLE_MAX_AGE_SEC` (default `120`)
- `PANCHO_OPEN_SECONDS` (default `60`)
- `PANCHO_LOCK_SECONDS` (default `60`)
- `PANCHO_SETTLEMENT_SECONDS` (default `300`)
- `ONCHAIN_KEEPER_INTERVAL_MS` (default `4000`)

## Secured keeper trigger

Settlement endpoint now requires `SETTLE_API_KEY` header:

```bash
curl -X POST http://localhost:3000/api/settle -H "x-settle-key: $SETTLE_API_KEY"
```

## Full cutover guide

See `/ONCHAIN_CUTOVER.md` for exact preflight -> deploy -> keeper -> frontend cutover order.

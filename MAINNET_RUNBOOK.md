# Pancho Mainnet Runbook

## 1) Critical Env Vars

Set these before production deploy:

- `SETTLE_API_KEY`: secret key for keeper calls to `/api/settle`.
- `SIM_SETTLE_API_KEY`: secret key for automated sim settlement calls to `/api/sim/settle`.
- `OPS_API_KEY`: secret key for `/api/ops/health`.
- `PANCHO_TREASURY_WALLET`: fee wallet for protocol treasury.
- `PANCHO_EXPECTED_TREASURY_WALLET`: treasury lock guard. Keeper/settlement refuse to run on mismatch.
- `PANCHO_PAUSE_JOINS`: `on|off` (default `off`).
- `PANCHO_PAUSE_SIM_SETTLEMENTS`: `on|off` (default `off`).
- `PANCHO_PAUSE_SETTLE_API`: `on|off` (default `off`).

Rate limit controls (safe defaults are built in):

- `PANCHO_RL_SIM_ENTRIES_IP_LIMIT`
- `PANCHO_RL_SIM_ENTRIES_IP_WINDOW_MS`
- `PANCHO_RL_SIM_ENTRIES_WALLET_LIMIT`
- `PANCHO_RL_SIM_ENTRIES_WALLET_WINDOW_MS`
- `PANCHO_RL_SIM_RESULTS_IP_LIMIT`
- `PANCHO_RL_SIM_RESULTS_IP_WINDOW_MS`
- `PANCHO_RL_SIM_RESULTS_WALLET_LIMIT`
- `PANCHO_RL_SIM_RESULTS_WALLET_WINDOW_MS`
- `PANCHO_RL_ORACLE_IP_LIMIT`
- `PANCHO_RL_ORACLE_IP_WINDOW_MS`
- `PANCHO_SIM_SETTLE_LIMIT`
- `PANCHO_ALERT_PENDING_DUE_ROUNDS`
- `PANCHO_ALERT_SETTLEMENT_LAG_MS`

## 2) Pre-Launch Checklist

1. Deploy latest build and verify health endpoints/pages load.
2. Confirm keeper keys are set and secure endpoints reject bad keys:
   - `/api/settle`
   - `/api/sim/settle`
   - `/api/ops/health`
3. Confirm treasury wallet env points to your controlled wallet.
4. Run stress suite:
   - entry stress
   - settlement stress (batched all-wallet profile)
5. Verify no `PENDING`/`MISSING` after settlement windows.
6. Verify alerting channels are live (errors, keeper misses, settlement latency).

## 3) Launch Strategy (Canary)

1. Start with conservative limits:
   - low max stake tiers
   - strict rate limits
2. Monitor for at least 24h.
3. If stable, increase limits gradually in controlled steps.

## 4) Incident Controls (Immediate)

If abuse or instability is detected:

1. Pause new joins:
   - `npm run ops:pause:joins`
2. Pause settlement trigger route:
   - `PANCHO_PAUSE_SETTLE_API=on`
3. If needed, pause simulated settlement processing:
   - `npm run ops:pause:sim-settlement`
4. Keep read APIs available for user visibility.
5. Announce status + ETA before re-enabling.

Emergency one-liners:

- Pause all user flow:
  - `npm run ops:pause:all`
- Resume all user flow:
  - `npm run ops:resume:all`
- Health check:
  - `npm run ops:health`
- Ops summary:
  - `npm run ops:summary`
- Smoke test (join + results + pool):
  - `npm run ops:smoke`
- Full prelaunch gate:
  - `npm run ops:prelaunch`
- D1 backup:
  - `npm run ops:backup:d1`
- Verify latest backup:
  - `npm run ops:backup:verify`

Notes:

- Pause/resume scripts update Cloudflare Worker secrets (`PANCHO_PAUSE_JOINS`, `PANCHO_PAUSE_SIM_SETTLEMENTS`).
- After toggling flags, deploy latest worker:
  - `npm run cf:deploy`

## 5) Rollback Procedure

1. Enable kill switches (above).
2. Roll back to last known-good release.
3. Run smoke checks:
   - connect wallet
   - place one join
   - verify results update
4. Re-enable joins only after keeper and settlement checks pass.

## 6) Post-Launch Daily Ops

1. Review settlement success rate and latency.
2. Review 429 rates by endpoint (abuse pressure).
3. Review wallet-level error spikes.
4. Verify backup integrity and restore test cadence.

## 7) Automation Commands

- Run sim keeper (recommended always-on process):
  - `npm run sim:keeper`
- Run canary against deployed workers:
  - `npm run canary:workers`
- Run ops health check:
  - `npm run ops:health`

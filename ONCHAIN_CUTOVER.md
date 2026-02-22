# On-Chain Cutover Plan

This is the hard gate before enabling fully on-chain custody/settlement in production.

## 1) Required Environment

- `PANCHO_PROGRAM_ID`
- `PANCHO_KEEPER_SECRET_KEY` or `PANCHO_KEEPER_KEYPAIR_PATH`
- `PANCHO_TREASURY_WALLET`
- `PANCHO_EXPECTED_TREASURY_WALLET` (must match treasury; keeper blocks on mismatch)
- `PANCHO_ORACLE_PROGRAM_ID`
- `PANCHO_ORACLE_ACCOUNT_SOL`
- `PANCHO_ORACLE_ACCOUNT_BTC`
- `PANCHO_ORACLE_ACCOUNT_ETH`
- `SOLANA_RPC_URL` (recommended dedicated RPC for production)

Optional but recommended:

- `PANCHO_MIN_DEPLOY_SOL` (default `3`)
- `PANCHO_AUTO_INIT_CONFIG=true` (only if config PDA has not been initialized yet)
- `ONCHAIN_KEEPER_INTERVAL_MS` (default `4000`)

## 2) Preflight (must pass)

Run:

```bash
npm run onchain:preflight
```

This command fails fast on:

- RPC unreachable
- Keeper signer missing
- Keeper balance too low
- Program id mismatch
- Missing oracle settings
- Missing oracle accounts or owner mismatch

## 3) Program Deployment

From repo root:

```bash
npm run onchain:build
cd onchain
anchor deploy --provider.cluster devnet --provider.wallet ~/.config/solana/id.json
```

Verify:

```bash
solana program show "$PANCHO_PROGRAM_ID" --url devnet
```

## 4) Start On-Chain Keeper

From repo root:

```bash
npm run onchain:keeper
```

Keeper will:

- create rounds
- lock rounds
- settle rounds

across SOL/BTC/ETH on configured cadence.

## 5) Frontend Cutover Flags

Set:

- `NEXT_PUBLIC_USE_ONCHAIN_PROGRAM=true`
- `NEXT_PUBLIC_SIM_MODE=false`
- `NEXT_PUBLIC_PANCHO_PROGRAM_ID=$PANCHO_PROGRAM_ID`

Deploy app after setting flags.

## 6) Canary Gate (required)

Run:

```bash
npm run canary:workers
```

Then manually place small real-value joins and verify:

- onchain join tx success
- round lock + settle via keeper
- claim flow works

## 7) Kill Switch

If abnormal behavior:

- set `PANCHO_PAUSE_SETTLE_API=on`
- set `PANCHO_PAUSE_JOINS=on`
- set `PANCHO_PAUSE_SIM_SETTLEMENTS=on` (if any sim paths still enabled)

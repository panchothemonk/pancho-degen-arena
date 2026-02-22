# Pancho PvP On-Chain Program (Anchor)

This folder contains the Solana program that moves custody and settlement on-chain.

## Current scope

Implemented in `programs/pancho_pvp/src/lib.rs`:
- Global config PDA (`admin`, `treasury`, `oracle_authority`, `fee_bps`, pause switch)
- Round PDA per market/round id
- Two escrow vault PDAs per round (`UP`, `DOWN`)
- Position PDA per user+round+side
- Instructions:
  - `initialize_config`
  - `set_config`
  - `set_treasury`
  - `set_oracle_authority`
  - `create_round`
  - `join_round`
  - `lock_round`
  - `settle_round`
  - `claim`
- Fee handling on-chain (6% configured by `fee_bps`)
- Permissionless claims from escrow vaults
- Oracle checks in-program using legacy Pyth price account parsing:
  - expected oracle account pubkey is pinned per round
  - oracle owner is validated against configured oracle program id
  - stale slot checks and trading status checks are enforced

## Oracle note

The current implementation uses `pyth-client` (legacy parser) for compatibility with the pinned Anchor toolchain.
Next upgrade target is moving to a modern Pyth receiver account flow once dependency compatibility is aligned.

## Build

```bash
cd onchain
cargo check
anchor build
```

## Local test workflow

```bash
cd onchain
anchor test
```

## Migration target

Frontend should migrate from:
- direct SOL transfer + `/api/entries` registration

to:
- `join_round` program instruction (wallet signs)
- `lock_round` and `settle_round` crank(s)
- `claim` program instruction for payouts

Once this path is active, the server no longer controls user escrow funds.

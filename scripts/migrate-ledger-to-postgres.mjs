import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";

const ledgerPath = path.join(process.cwd(), "data", "ledger.json");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: false } : undefined
});

const schemaSql = `
  CREATE TABLE IF NOT EXISTS ledger_entries (
    signature TEXT PRIMARY KEY,
    round_id TEXT NOT NULL,
    market TEXT,
    feed_id TEXT,
    round_start_ms BIGINT NOT NULL,
    round_end_ms BIGINT NOT NULL,
    wallet TEXT NOT NULL,
    direction TEXT NOT NULL,
    stake_usd DOUBLE PRECISION NOT NULL,
    stake_lamports BIGINT NOT NULL,
    joined_at_ms BIGINT NOT NULL,
    start_price DOUBLE PRECISION NOT NULL,
    client_ip TEXT
  );

  CREATE TABLE IF NOT EXISTS round_settlements (
    round_id TEXT PRIMARY KEY,
    state TEXT,
    settled_at_ms BIGINT NOT NULL,
    mode TEXT NOT NULL,
    winner_side TEXT,
    start_price DOUBLE PRECISION NOT NULL,
    end_price DOUBLE PRECISION NOT NULL,
    fee_lamports BIGINT NOT NULL,
    planned_transfers JSONB NOT NULL DEFAULT '[]'::jsonb
  );

  CREATE TABLE IF NOT EXISTS settlement_transfers (
    id BIGSERIAL PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES round_settlements(round_id) ON DELETE CASCADE,
    transfer_id TEXT,
    wallet TEXT NOT NULL,
    lamports BIGINT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    UNIQUE (round_id, transfer_id)
  );

  CREATE TABLE IF NOT EXISTS round_processing_locks (
    round_id TEXT PRIMARY KEY,
    acquired_at_ms BIGINT NOT NULL
  );
`;

async function main() {
  const raw = await readFile(ledgerPath, "utf8");
  const ledger = JSON.parse(raw);

  await pool.query(schemaSql);

  for (const entry of ledger.entries ?? []) {
    await pool.query(
      `
        INSERT INTO ledger_entries (
          signature, round_id, market, feed_id, round_start_ms, round_end_ms, wallet, direction,
          stake_usd, stake_lamports, joined_at_ms, start_price, client_ip
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13
        )
        ON CONFLICT (signature) DO NOTHING
      `,
      [
        entry.signature,
        entry.roundId,
        entry.market ?? null,
        entry.feedId ?? null,
        entry.roundStartMs,
        entry.roundEndMs,
        entry.wallet,
        entry.direction,
        entry.stakeUsd,
        entry.stakeLamports,
        entry.joinedAtMs,
        entry.startPrice ?? 0,
        entry.clientIp ?? null
      ]
    );
  }

  for (const settlement of ledger.settlements ?? []) {
    await pool.query(
      `
        INSERT INTO round_settlements (
          round_id, state, settled_at_ms, mode, winner_side, start_price, end_price, fee_lamports, planned_transfers
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT (round_id)
        DO UPDATE SET
          state = EXCLUDED.state,
          settled_at_ms = EXCLUDED.settled_at_ms,
          mode = EXCLUDED.mode,
          winner_side = EXCLUDED.winner_side,
          start_price = EXCLUDED.start_price,
          end_price = EXCLUDED.end_price,
          fee_lamports = EXCLUDED.fee_lamports,
          planned_transfers = EXCLUDED.planned_transfers
      `,
      [
        settlement.roundId,
        settlement.state ?? null,
        settlement.settledAtMs,
        settlement.mode,
        settlement.winnerSide ?? null,
        settlement.startPrice,
        settlement.endPrice,
        settlement.feeLamports,
        JSON.stringify(settlement.plannedTransfers ?? [])
      ]
    );

    for (const transfer of settlement.transfers ?? []) {
      await pool.query(
        `
          INSERT INTO settlement_transfers (round_id, transfer_id, wallet, lamports, signature)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT DO NOTHING
        `,
        [settlement.roundId, transfer.id ?? null, transfer.wallet, transfer.lamports, transfer.signature]
      );
    }
  }

  console.log(
    `Migration complete. Imported entries=${ledger.entries?.length ?? 0}, settlements=${ledger.settlements?.length ?? 0}`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

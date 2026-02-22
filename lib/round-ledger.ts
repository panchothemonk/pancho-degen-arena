import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

type PoolType = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
};

export type Direction = "UP" | "DOWN";

export type LedgerEntry = {
  roundId: string;
  market?: string;
  feedId?: string;
  roundStartMs: number;
  roundEndMs: number;
  wallet: string;
  direction: Direction;
  stakeUsd: number;
  stakeLamports: number;
  signature: string;
  joinedAtMs: number;
  startPrice: number;
  clientIp?: string;
};

export type TransferRecord = {
  id?: string;
  wallet: string;
  lamports: number;
  signature: string;
};

export type PlannedTransfer = {
  id: string;
  wallet: string;
  lamports: number;
  kind: "fee" | "payout";
};

export type RoundSettlement = {
  roundId: string;
  state?: "PROCESSING" | "COMPLETED";
  settledAtMs: number;
  mode: "WIN" | "REFUND";
  winnerSide?: Direction;
  startPrice: number;
  endPrice: number;
  feeLamports: number;
  plannedTransfers?: PlannedTransfer[];
  transfers: TransferRecord[];
};

type LedgerData = {
  entries: LedgerEntry[];
  settlements: RoundSettlement[];
};

const LEDGER_DIR = path.join(process.cwd(), "data");
const LEDGER_PATH = path.join(LEDGER_DIR, "ledger.json");
const EMPTY_LEDGER: LedgerData = { entries: [], settlements: [] };

let writeLock: Promise<void> = Promise.resolve();
let pgPoolPromise: Promise<PoolType | null> | null = null;
let pgSchemaReady = false;
const inMemoryWalletJoinAttempts = new Map<string, number[]>();
const inMemoryIpJoinAttempts = new Map<string, number[]>();

async function ensureLedgerFile() {
  await mkdir(LEDGER_DIR, { recursive: true });
  try {
    await readFile(LEDGER_PATH, "utf8");
  } catch {
    await writeFile(LEDGER_PATH, JSON.stringify(EMPTY_LEDGER, null, 2), "utf8");
  }
}

async function readFileLedger(): Promise<LedgerData> {
  await ensureLedgerFile();
  const raw = await readFile(LEDGER_PATH, "utf8");
  return JSON.parse(raw) as LedgerData;
}

async function writeFileLedger(data: LedgerData): Promise<void> {
  await ensureLedgerFile();
  await writeFile(LEDGER_PATH, JSON.stringify(data, null, 2), "utf8");
}

function fromPgRowEntry(row: any): LedgerEntry {
  return {
    roundId: row.round_id,
    market: row.market ?? undefined,
    feedId: row.feed_id ?? undefined,
    roundStartMs: Number(row.round_start_ms),
    roundEndMs: Number(row.round_end_ms),
    wallet: row.wallet,
    direction: row.direction,
    stakeUsd: Number(row.stake_usd),
    stakeLamports: Number(row.stake_lamports),
    signature: row.signature,
    joinedAtMs: Number(row.joined_at_ms),
    startPrice: Number(row.start_price),
    clientIp: row.client_ip ?? undefined
  };
}

function fromPgRowSettlement(row: any, transfers: TransferRecord[]): RoundSettlement {
  return {
    roundId: row.round_id,
    state: row.state,
    settledAtMs: Number(row.settled_at_ms),
    mode: row.mode,
    winnerSide: row.winner_side ?? undefined,
    startPrice: Number(row.start_price),
    endPrice: Number(row.end_price),
    feeLamports: Number(row.fee_lamports),
    plannedTransfers: (row.planned_transfers as PlannedTransfer[]) ?? [],
    transfers
  };
}

async function getPgPool(): Promise<PoolType | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  if (!pgPoolPromise) {
    pgPoolPromise = (async () => {
      const { Pool } = await import("pg");
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 20,
        ssl: process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: false } : undefined
      });
      return pool as unknown as PoolType;
    })();
  }

  const pool = await pgPoolPromise;
  if (!pool) {
    return null;
  }

  if (!pgSchemaReady) {
    await pool.query(`
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

      CREATE TABLE IF NOT EXISTS join_attempts (
        id BIGSERIAL PRIMARY KEY,
        wallet TEXT,
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS round_processing_locks (
        round_id TEXT PRIMARY KEY,
        acquired_at_ms BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_entries_round_id ON ledger_entries(round_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_entries_wallet ON ledger_entries(wallet);
      CREATE INDEX IF NOT EXISTS idx_ledger_entries_round_end ON ledger_entries(round_end_ms);
      CREATE INDEX IF NOT EXISTS idx_join_attempts_wallet_created ON join_attempts(wallet, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_join_attempts_ip_created ON join_attempts(ip, created_at DESC);
    `);

    pgSchemaReady = true;
  }

  return pool;
}

async function withFileLedgerWrite<T>(fn: (data: LedgerData) => Promise<T> | T): Promise<T> {
  const run = async () => {
    const data = await readFileLedger();
    const result = await fn(data);
    await writeFileLedger(data);
    return result;
  };

  const queued = writeLock.then(run, run);
  writeLock = queued.then(
    () => undefined,
    () => undefined
  );

  return queued;
}

export async function readLedger(): Promise<LedgerData> {
  const pool = await getPgPool();
  if (!pool) {
    return readFileLedger();
  }

  const [entriesRes, settlementsRes, transfersRes] = await Promise.all([
    pool.query("SELECT * FROM ledger_entries ORDER BY joined_at_ms DESC"),
    pool.query("SELECT * FROM round_settlements ORDER BY settled_at_ms DESC"),
    pool.query("SELECT round_id, transfer_id, wallet, lamports, signature FROM settlement_transfers ORDER BY id ASC")
  ]);

  const transfersByRound = new Map<string, TransferRecord[]>();
  for (const row of transfersRes.rows) {
    const current = transfersByRound.get(row.round_id) ?? [];
    current.push({
      id: row.transfer_id ?? undefined,
      wallet: row.wallet,
      lamports: Number(row.lamports),
      signature: row.signature
    });
    transfersByRound.set(row.round_id, current);
  }

  return {
    entries: entriesRes.rows.map(fromPgRowEntry),
    settlements: settlementsRes.rows.map((row) => fromPgRowSettlement(row, transfersByRound.get(row.round_id) ?? []))
  };
}

export async function withLedgerWrite<T>(fn: (data: LedgerData) => Promise<T> | T): Promise<T> {
  const pool = await getPgPool();
  if (!pool) {
    return withFileLedgerWrite(fn);
  }

  const data = await readLedger();
  return fn(data);
}

export async function hasLedgerEntrySignature(signature: string): Promise<boolean> {
  const pool = await getPgPool();
  if (!pool) {
    const ledger = await readFileLedger();
    return ledger.entries.some((item) => item.signature === signature);
  }

  const res = await pool.query("SELECT 1 FROM ledger_entries WHERE signature = $1 LIMIT 1", [signature]);
  return res.rowCount > 0;
}

export async function addLedgerEntry(entry: LedgerEntry): Promise<{ created: boolean }> {
  const pool = await getPgPool();
  if (!pool) {
    return withFileLedgerWrite((data) => {
      if (data.entries.some((item) => item.signature === entry.signature)) {
        return { created: false };
      }

      data.entries.push(entry);
      return { created: true };
    });
  }

  const res = await pool.query(
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
      entry.startPrice,
      entry.clientIp ?? null
    ]
  );

  return { created: (res.rowCount ?? 0) > 0 };
}

export async function addRoundSettlement(settlement: RoundSettlement): Promise<void> {
  const pool = await getPgPool();
  if (!pool) {
    await withFileLedgerWrite((data) => {
      const exists = data.settlements.some((item) => item.roundId === settlement.roundId);
      if (!exists) {
        data.settlements.push(settlement);
      }
    });
    return;
  }

  await pool.query(
    `
      INSERT INTO round_settlements (
        round_id, state, settled_at_ms, mode, winner_side, start_price, end_price, fee_lamports, planned_transfers
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      ON CONFLICT (round_id) DO NOTHING
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
}

export async function upsertRoundSettlement(settlement: RoundSettlement): Promise<void> {
  const pool = await getPgPool();
  if (!pool) {
    await withFileLedgerWrite((data) => {
      const idx = data.settlements.findIndex((item) => item.roundId === settlement.roundId);
      if (idx === -1) {
        data.settlements.push(settlement);
      } else {
        data.settlements[idx] = settlement;
      }
    });
    return;
  }

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
}

export async function appendSettlementTransfer(roundId: string, transfer: TransferRecord): Promise<void> {
  const pool = await getPgPool();
  if (!pool) {
    await withFileLedgerWrite((data) => {
      const settlement = data.settlements.find((item) => item.roundId === roundId);
      if (!settlement) {
        return;
      }

      if (transfer.id && settlement.transfers.some((item) => item.id === transfer.id)) {
        return;
      }
      if (settlement.transfers.some((item) => item.signature === transfer.signature)) {
        return;
      }
      settlement.transfers.push(transfer);
    });
    return;
  }

  await pool.query(
    `
      INSERT INTO settlement_transfers (round_id, transfer_id, wallet, lamports, signature)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
    `,
    [roundId, transfer.id ?? null, transfer.wallet, transfer.lamports, transfer.signature]
  );
}

export async function markSettlementCompleted(roundId: string): Promise<void> {
  const pool = await getPgPool();
  if (!pool) {
    await withFileLedgerWrite((data) => {
      const settlement = data.settlements.find((item) => item.roundId === roundId);
      if (!settlement) {
        return;
      }
      settlement.state = "COMPLETED";
      settlement.settledAtMs = Date.now();
    });
    return;
  }

  await pool.query(
    `
      UPDATE round_settlements
      SET state = 'COMPLETED', settled_at_ms = $2
      WHERE round_id = $1
    `,
    [roundId, Date.now()]
  );
}

export async function recordJoinAttempt(wallet: string, ip: string | null): Promise<void> {
  const pool = await getPgPool();
  if (!pool) {
    const now = Date.now();
    inMemoryWalletJoinAttempts.set(wallet, [...(inMemoryWalletJoinAttempts.get(wallet) ?? []), now]);
    if (ip) {
      inMemoryIpJoinAttempts.set(ip, [...(inMemoryIpJoinAttempts.get(ip) ?? []), now]);
    }
    return;
  }

  await pool.query("INSERT INTO join_attempts (wallet, ip) VALUES ($1, $2)", [wallet, ip]);
}

export async function countRecentJoinAttempts(params: {
  wallet: string;
  ip: string | null;
  windowSeconds: number;
}): Promise<{ walletCount: number; ipCount: number }> {
  const pool = await getPgPool();
  if (!pool) {
    const windowMs = Math.max(1, Math.floor(params.windowSeconds)) * 1000;
    const cutoff = Date.now() - windowMs;
    const walletTimes = (inMemoryWalletJoinAttempts.get(params.wallet) ?? []).filter((ts) => ts >= cutoff);
    inMemoryWalletJoinAttempts.set(params.wallet, walletTimes);

    let ipCount = 0;
    if (params.ip) {
      const ipTimes = (inMemoryIpJoinAttempts.get(params.ip) ?? []).filter((ts) => ts >= cutoff);
      inMemoryIpJoinAttempts.set(params.ip, ipTimes);
      ipCount = ipTimes.length;
    }

    return { walletCount: walletTimes.length, ipCount };
  }

  const windowExpr = `${Math.max(1, Math.floor(params.windowSeconds))} seconds`;
  const [walletRes, ipRes] = await Promise.all([
    pool.query(
      `
        SELECT COUNT(*)::INT AS count
        FROM join_attempts
        WHERE wallet = $1
          AND created_at >= NOW() - ($2::INTERVAL)
      `,
      [params.wallet, windowExpr]
    ),
    params.ip
      ? pool.query(
          `
            SELECT COUNT(*)::INT AS count
            FROM join_attempts
            WHERE ip = $1
              AND created_at >= NOW() - ($2::INTERVAL)
          `,
          [params.ip, windowExpr]
        )
      : Promise.resolve({ rows: [{ count: 0 }], rowCount: 1 })
  ]);

  return {
    walletCount: Number(walletRes.rows[0]?.count ?? 0),
    ipCount: Number(ipRes.rows[0]?.count ?? 0)
  };
}

export async function tryAcquireRoundProcessingLock(roundId: string, staleAfterMs = 15 * 60 * 1000): Promise<boolean> {
  const pool = await getPgPool();
  if (!pool) {
    return true;
  }

  const now = Date.now();
  const staleBefore = now - Math.max(1, staleAfterMs);
  const res = await pool.query(
    `
      INSERT INTO round_processing_locks (round_id, acquired_at_ms)
      VALUES ($1, $2)
      ON CONFLICT (round_id)
      DO UPDATE SET acquired_at_ms = EXCLUDED.acquired_at_ms
      WHERE round_processing_locks.acquired_at_ms < $3
      RETURNING round_id
    `,
    [roundId, now, staleBefore]
  );

  return (res.rowCount ?? 0) > 0;
}

export async function releaseRoundProcessingLock(roundId: string): Promise<void> {
  const pool = await getPgPool();
  if (!pool) {
    return;
  }

  await pool.query("DELETE FROM round_processing_locks WHERE round_id = $1", [roundId]);
}

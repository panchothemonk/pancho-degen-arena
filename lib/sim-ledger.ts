import { mkdir, readFile, rename, writeFile } from "fs/promises";
import path from "path";

export type SimDirection = "UP" | "DOWN";

export type SimEntry = {
  id: string;
  roundId: string;
  market: string;
  feedId: string;
  roundStartMs: number;
  roundEndMs: number;
  wallet: string;
  direction: SimDirection;
  stakeBucks: number;
  joinedAtMs: number;
};

export type SimRoundPoolStats = {
  roundId: string;
  market: string;
  totalBucks: number;
  upBucks: number;
  downBucks: number;
  players: number;
  entries: number;
};

export type SimRoundSettlementRecord = {
  roundId: string;
  settlement: {
    mode: "WIN" | "REFUND";
    winnerSide?: SimDirection;
    startPrice: number;
    endPrice: number;
  };
  payoutsByEntryId: Map<string, number>;
  feeCents: number;
  settledAtMs: number;
};

type SimLedgerData = {
  entries: SimEntry[];
};

const LEDGER_DIR = path.join(process.cwd(), "data");
const LEDGER_PATH = path.join(LEDGER_DIR, "sim-ledger.json");
const EMPTY_LEDGER: SimLedgerData = { entries: [] };
const MEMORY_LEDGER_KEY = "__PANCHO_SIM_LEDGER__";
const HOT_FLUSH_INTERVAL_MS = Number(process.env.SIM_LEDGER_FLUSH_MS ?? 2500);

let writeLock: Promise<void> = Promise.resolve();
let pgPoolPromise: Promise<PoolType | null> | null = null;
let pgSchemaReady = false;
let useMemoryOnly = false;
let hotLedgerPromise: Promise<SimLedgerData> | null = null;
let hotLedger: SimLedgerData | null = null;
let hotLedgerIds: Set<string> | null = null;
let hotFlushTimer: ReturnType<typeof setTimeout> | null = null;
let hotFlushRunning = false;
let hotDirty = false;
let d1Promise: Promise<D1DatabaseLike | null> | null = null;
let d1SchemaReady = false;
const MEMORY_SETTLEMENT_KEY = "__PANCHO_SIM_SETTLEMENTS__";

type PoolType = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
};

type D1RunResult<T = unknown> = {
  results?: T[];
};

type D1StatementLike = {
  bind: (...values: unknown[]) => {
    all: <T = unknown>() => Promise<D1RunResult<T>>;
    first: <T = unknown>() => Promise<T | null>;
    run: () => Promise<unknown>;
  };
};

type D1DatabaseLike = {
  prepare: (sql: string) => D1StatementLike;
  exec: (sql: string) => Promise<unknown>;
};

type SqliteStatementLike = {
  all: (...params: unknown[]) => any[];
  get: (...params: unknown[]) => any;
  run: (...params: unknown[]) => { changes?: number };
};

type SqliteDatabaseLike = {
  prepare: (sql: string) => SqliteStatementLike;
  exec: (sql: string) => unknown;
  pragma: (sql: string) => unknown;
};

const SQLITE_DB_PATH = path.join(LEDGER_DIR, "sim-ledger.db");
let sqlitePromise: Promise<SqliteDatabaseLike | null> | null = null;
let sqliteSchemaReady = false;
let sqliteInitError: string | null = null;

function shouldFallbackToMemory(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /EPERM|EROFS|ENOSYS|operation not permitted|read-only file system/i.test(msg);
}

function getMemoryLedger(): SimLedgerData {
  const scope = globalThis as Record<string, unknown>;
  if (!scope[MEMORY_LEDGER_KEY]) {
    scope[MEMORY_LEDGER_KEY] = { entries: [] } satisfies SimLedgerData;
  }
  return scope[MEMORY_LEDGER_KEY] as SimLedgerData;
}

function getMemorySettlements(): Map<string, SimRoundSettlementRecord> {
  const scope = globalThis as Record<string, unknown>;
  if (!scope[MEMORY_SETTLEMENT_KEY]) {
    scope[MEMORY_SETTLEMENT_KEY] = new Map<string, SimRoundSettlementRecord>();
  }
  return scope[MEMORY_SETTLEMENT_KEY] as Map<string, SimRoundSettlementRecord>;
}

async function getD1Database(): Promise<D1DatabaseLike | null> {
  const d1Mode = (process.env.SIM_LEDGER_USE_D1 ?? "auto").toLowerCase();
  if (d1Mode === "off") {
    return null;
  }

  if (!d1Promise) {
    d1Promise = (async () => {
      try {
        const mod = await import("@opennextjs/cloudflare");
        const context = mod.getCloudflareContext();
        const env = (context?.env ?? {}) as Record<string, unknown>;
        const db = (env.PANCHO_SIM_DB ?? env.DB) as D1DatabaseLike | undefined;
        if (!db && d1Mode === "on") {
          return null;
        }
        return db ?? null;
      } catch {
        return null;
      }
    })();
  }

  const db = await d1Promise;
  if (!db) {
    return null;
  }

  if (!d1SchemaReady) {
    await db
      .prepare(
        `
          CREATE TABLE IF NOT EXISTS sim_entries (
            id TEXT PRIMARY KEY,
            round_id TEXT NOT NULL,
            market TEXT NOT NULL,
            feed_id TEXT NOT NULL,
            round_start_ms INTEGER NOT NULL,
            round_end_ms INTEGER NOT NULL,
            wallet TEXT NOT NULL,
            direction TEXT NOT NULL,
            stake_bucks REAL NOT NULL,
            joined_at_ms INTEGER NOT NULL
          )
        `
      )
      .bind()
      .run();
    await db
      .prepare(
        `
          CREATE TABLE IF NOT EXISTS sim_round_settlements (
            round_id TEXT PRIMARY KEY,
            settlement_mode TEXT NOT NULL,
            winner_side TEXT,
            start_price REAL NOT NULL,
            end_price REAL NOT NULL,
            fee_cents INTEGER NOT NULL,
            payouts_json TEXT NOT NULL,
            settled_at_ms INTEGER NOT NULL
          )
        `
      )
      .bind()
      .run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_sim_entries_wallet ON sim_entries(wallet)").bind().run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_sim_entries_round_id ON sim_entries(round_id)").bind().run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_sim_entries_round_end ON sim_entries(round_end_ms)").bind().run();
    d1SchemaReady = true;
  }

  return db;
}

async function getSqliteDatabase(): Promise<SqliteDatabaseLike | null> {
  if (process.env.SIM_LEDGER_SQLITE === "off") {
    return null;
  }

  if (!sqlitePromise) {
    sqlitePromise = (async () => {
      try {
        await mkdir(LEDGER_DIR, { recursive: true });
        const mod = await import("better-sqlite3");
        const DatabaseCtor = (mod as unknown as { default?: new (file: string) => SqliteDatabaseLike }).default;
        if (!DatabaseCtor) {
          return null;
        }
        const db = new DatabaseCtor(SQLITE_DB_PATH);
        db.pragma("journal_mode = WAL");
        db.pragma("synchronous = NORMAL");
        sqliteInitError = null;
        return db;
      } catch (error) {
        sqliteInitError = error instanceof Error ? error.message : String(error ?? "unknown sqlite init error");
        return null;
      }
    })();
  }

  const db = await sqlitePromise;
  if (!db) {
    return null;
  }

  if (!sqliteSchemaReady) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sim_entries (
        id TEXT PRIMARY KEY,
        round_id TEXT NOT NULL,
        market TEXT NOT NULL,
        feed_id TEXT NOT NULL,
        round_start_ms INTEGER NOT NULL,
        round_end_ms INTEGER NOT NULL,
        wallet TEXT NOT NULL,
        direction TEXT NOT NULL,
        stake_bucks REAL NOT NULL,
        joined_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sim_entries_wallet ON sim_entries(wallet);
      CREATE INDEX IF NOT EXISTS idx_sim_entries_round_id ON sim_entries(round_id);
      CREATE INDEX IF NOT EXISTS idx_sim_entries_round_end ON sim_entries(round_end_ms);

      CREATE TABLE IF NOT EXISTS sim_round_settlements (
        round_id TEXT PRIMARY KEY,
        settlement_mode TEXT NOT NULL,
        winner_side TEXT,
        start_price REAL NOT NULL,
        end_price REAL NOT NULL,
        fee_cents INTEGER NOT NULL,
        payouts_json TEXT NOT NULL,
        settled_at_ms INTEGER NOT NULL
      );
    `);
    sqliteSchemaReady = true;
  }

  return db;
}

function requireDbBackend(context: string): never {
  const details = sqliteInitError ? ` sqlite_error=${sqliteInitError}` : "";
  throw new Error(`SIM ledger DB backend unavailable for ${context}.${details}`);
}

async function ensureLedgerFile() {
  await mkdir(LEDGER_DIR, { recursive: true });
  try {
    await readFile(LEDGER_PATH, "utf8");
  } catch {
    await writeFile(LEDGER_PATH, JSON.stringify(EMPTY_LEDGER, null, 2), "utf8");
  }
}

async function readFileLedger(): Promise<SimLedgerData> {
  if (useMemoryOnly) {
    return getMemoryLedger();
  }

  try {
    await ensureLedgerFile();
    const raw = await readFile(LEDGER_PATH, "utf8");
    try {
      return JSON.parse(raw) as SimLedgerData;
    } catch {
      // Recover from partially-written/corrupted JSON by resetting to an empty ledger.
      await writeFile(LEDGER_PATH, JSON.stringify(EMPTY_LEDGER, null, 2), "utf8");
      return { entries: [] };
    }
  } catch (error) {
    if (!shouldFallbackToMemory(error)) {
      throw error;
    }
    useMemoryOnly = true;
    return getMemoryLedger();
  }
}

async function writeFileLedger(data: SimLedgerData): Promise<void> {
  if (useMemoryOnly) {
    getMemoryLedger().entries = data.entries;
    return;
  }

  try {
    await ensureLedgerFile();
    const tempPath = `${LEDGER_PATH}.tmp`;
    await writeFile(tempPath, JSON.stringify(data), "utf8");
    await rename(tempPath, LEDGER_PATH);
  } catch (error) {
    if (!shouldFallbackToMemory(error)) {
      throw error;
    }
    useMemoryOnly = true;
    getMemoryLedger().entries = data.entries;
  }
}

async function loadHotLedger(): Promise<SimLedgerData> {
  if (hotLedger) {
    return hotLedger;
  }
  if (!hotLedgerPromise) {
    hotLedgerPromise = (async () => {
      const loaded = await readFileLedger();
      hotLedger = loaded;
      hotLedgerIds = new Set(loaded.entries.map((entry) => entry.id));
      return loaded;
    })();
  }
  return hotLedgerPromise;
}

function queueHotLedgerFlush(): void {
  hotDirty = true;
  if (hotFlushTimer || hotFlushRunning || useMemoryOnly) {
    return;
  }
  hotFlushTimer = setTimeout(async () => {
    hotFlushTimer = null;
    hotFlushRunning = true;
    try {
      if (hotDirty && hotLedger) {
        hotDirty = false;
        // Use the in-memory ledger reference directly; avoid full-array clone on each flush.
        await writeFileLedger(hotLedger);
      }
    } catch {
      // Keep serving from memory even if file persistence fails transiently.
    } finally {
      hotFlushRunning = false;
      if (hotDirty) {
        queueHotLedgerFlush();
      }
    }
  }, HOT_FLUSH_INTERVAL_MS);
}

async function getPgPool(): Promise<PoolType | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  if (!pgPoolPromise) {
    pgPoolPromise = (async () => {
      try {
        const { Pool } = await import("pg");
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 20,
          ssl: process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: false } : undefined
        });
        return pool as unknown as PoolType;
      } catch {
        // In Cloudflare Workers runtime, Node pg may be unavailable.
        // Fall back to file/memory path so API remains functional.
        return null;
      }
    })();
  }

  const pool = await pgPoolPromise;
  if (!pool) {
    return null;
  }

  if (!pgSchemaReady) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sim_entries (
        id TEXT PRIMARY KEY,
        round_id TEXT NOT NULL,
        market TEXT NOT NULL,
        feed_id TEXT NOT NULL,
        round_start_ms BIGINT NOT NULL,
        round_end_ms BIGINT NOT NULL,
        wallet TEXT NOT NULL,
        direction TEXT NOT NULL,
        stake_bucks DOUBLE PRECISION NOT NULL,
        joined_at_ms BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sim_entries_wallet ON sim_entries(wallet);
      CREATE INDEX IF NOT EXISTS idx_sim_entries_round_id ON sim_entries(round_id);
      CREATE INDEX IF NOT EXISTS idx_sim_entries_round_end ON sim_entries(round_end_ms);
    `);
    pgSchemaReady = true;
  }

  return pool;
}

async function withLedgerWrite<T>(fn: (data: SimLedgerData) => Promise<T> | T): Promise<T> {
  const run = async () => {
    const data = await loadHotLedger();
    const result = await fn(data);
    queueHotLedgerFlush();
    return result;
  };

  const queued = writeLock.then(run, run);
  writeLock = queued.then(
    () => undefined,
    () => undefined
  );

  return queued;
}

export async function readSimLedger(): Promise<SimLedgerData> {
  const d1 = await getD1Database();
  if (d1) {
    const result = await d1
      .prepare(
        `
          SELECT id, round_id, market, feed_id, round_start_ms, round_end_ms, wallet, direction, stake_bucks, joined_at_ms
          FROM sim_entries
          ORDER BY joined_at_ms DESC
        `
      )
      .bind()
      .all<{
        id: string;
        round_id: string;
        market: string;
        feed_id: string;
        round_start_ms: number;
        round_end_ms: number;
        wallet: string;
        direction: string;
        stake_bucks: number;
        joined_at_ms: number;
      }>();

    return {
      entries: (result.results ?? []).map((row) => ({
        id: row.id,
        roundId: row.round_id,
        market: row.market,
        feedId: row.feed_id,
        roundStartMs: Number(row.round_start_ms),
        roundEndMs: Number(row.round_end_ms),
        wallet: row.wallet,
        direction: row.direction as SimDirection,
        stakeBucks: Number(row.stake_bucks),
        joinedAtMs: Number(row.joined_at_ms)
      }))
    };
  }

  const sqlite = await getSqliteDatabase();
  if (sqlite) {
    const rows = sqlite
      .prepare(
        `
          SELECT id, round_id, market, feed_id, round_start_ms, round_end_ms, wallet, direction, stake_bucks, joined_at_ms
          FROM sim_entries
          ORDER BY joined_at_ms DESC
        `
      )
      .all() as Array<{
      id: string;
      round_id: string;
      market: string;
      feed_id: string;
      round_start_ms: number;
      round_end_ms: number;
      wallet: string;
      direction: string;
      stake_bucks: number;
      joined_at_ms: number;
    }>;

    return {
      entries: rows.map((row) => ({
        id: row.id,
        roundId: row.round_id,
        market: row.market,
        feedId: row.feed_id,
        roundStartMs: Number(row.round_start_ms),
        roundEndMs: Number(row.round_end_ms),
        wallet: row.wallet,
        direction: row.direction as SimDirection,
        stakeBucks: Number(row.stake_bucks),
        joinedAtMs: Number(row.joined_at_ms)
      }))
    };
  }

  const pool = await getPgPool();
  if (!pool) {
    return requireDbBackend("readSimLedger");
  }

  const res = await pool.query("SELECT * FROM sim_entries ORDER BY joined_at_ms DESC");
  return {
    entries: res.rows.map((row) => ({
      id: row.id,
      roundId: row.round_id,
      market: row.market,
      feedId: row.feed_id,
      roundStartMs: Number(row.round_start_ms),
      roundEndMs: Number(row.round_end_ms),
      wallet: row.wallet,
      direction: row.direction as SimDirection,
      stakeBucks: Number(row.stake_bucks),
      joinedAtMs: Number(row.joined_at_ms)
    }))
  };
}

export async function readSimLedgerForWallet(wallet: string): Promise<SimLedgerData> {
  const d1 = await getD1Database();
  if (d1) {
    const roundIdsResult = await d1
      .prepare("SELECT DISTINCT round_id FROM sim_entries WHERE wallet = ?")
      .bind(wallet)
      .all<{ round_id: string }>();

    const roundIds = (roundIdsResult.results ?? []).map((row) => row.round_id);
    if (roundIds.length === 0) {
      return { entries: [] };
    }

    const placeholders = roundIds.map(() => "?").join(", ");
    const entriesResult = await d1
      .prepare(
        `
          SELECT id, round_id, market, feed_id, round_start_ms, round_end_ms, wallet, direction, stake_bucks, joined_at_ms
          FROM sim_entries
          WHERE round_id IN (${placeholders})
          ORDER BY joined_at_ms DESC
        `
      )
      .bind(...roundIds)
      .all<{
        id: string;
        round_id: string;
        market: string;
        feed_id: string;
        round_start_ms: number;
        round_end_ms: number;
        wallet: string;
        direction: string;
        stake_bucks: number;
        joined_at_ms: number;
      }>();

    return {
      entries: (entriesResult.results ?? []).map((row) => ({
        id: row.id,
        roundId: row.round_id,
        market: row.market,
        feedId: row.feed_id,
        roundStartMs: Number(row.round_start_ms),
        roundEndMs: Number(row.round_end_ms),
        wallet: row.wallet,
        direction: row.direction as SimDirection,
        stakeBucks: Number(row.stake_bucks),
        joinedAtMs: Number(row.joined_at_ms)
      }))
    };
  }

  const sqlite = await getSqliteDatabase();
  if (sqlite) {
    const roundRows = sqlite.prepare("SELECT DISTINCT round_id FROM sim_entries WHERE wallet = ?").all(wallet) as Array<{ round_id: string }>;
    const roundIds = roundRows.map((row) => row.round_id);
    if (roundIds.length === 0) {
      return { entries: [] };
    }

    const placeholders = roundIds.map(() => "?").join(", ");
    const rows = sqlite
      .prepare(
        `
          SELECT id, round_id, market, feed_id, round_start_ms, round_end_ms, wallet, direction, stake_bucks, joined_at_ms
          FROM sim_entries
          WHERE round_id IN (${placeholders})
          ORDER BY joined_at_ms DESC
        `
      )
      .all(...roundIds) as Array<{
      id: string;
      round_id: string;
      market: string;
      feed_id: string;
      round_start_ms: number;
      round_end_ms: number;
      wallet: string;
      direction: string;
      stake_bucks: number;
      joined_at_ms: number;
    }>;

    return {
      entries: rows.map((row) => ({
        id: row.id,
        roundId: row.round_id,
        market: row.market,
        feedId: row.feed_id,
        roundStartMs: Number(row.round_start_ms),
        roundEndMs: Number(row.round_end_ms),
        wallet: row.wallet,
        direction: row.direction as SimDirection,
        stakeBucks: Number(row.stake_bucks),
        joinedAtMs: Number(row.joined_at_ms)
      }))
    };
  }

  return requireDbBackend("readSimLedgerForWallet");
}

export async function readSimWalletEntries(wallet: string): Promise<SimEntry[]> {
  const d1 = await getD1Database();
  if (d1) {
    const result = await d1
      .prepare(
        `
          SELECT id, round_id, market, feed_id, round_start_ms, round_end_ms, wallet, direction, stake_bucks, joined_at_ms
          FROM sim_entries
          WHERE wallet = ?
          ORDER BY joined_at_ms DESC
        `
      )
      .bind(wallet)
      .all<{
        id: string;
        round_id: string;
        market: string;
        feed_id: string;
        round_start_ms: number;
        round_end_ms: number;
        wallet: string;
        direction: string;
        stake_bucks: number;
        joined_at_ms: number;
      }>();

    return (result.results ?? []).map((row) => ({
      id: row.id,
      roundId: row.round_id,
      market: row.market,
      feedId: row.feed_id,
      roundStartMs: Number(row.round_start_ms),
      roundEndMs: Number(row.round_end_ms),
      wallet: row.wallet,
      direction: row.direction as SimDirection,
      stakeBucks: Number(row.stake_bucks),
      joinedAtMs: Number(row.joined_at_ms)
    }));
  }

  const sqlite = await getSqliteDatabase();
  if (sqlite) {
    const rows = sqlite
      .prepare(
        `
          SELECT id, round_id, market, feed_id, round_start_ms, round_end_ms, wallet, direction, stake_bucks, joined_at_ms
          FROM sim_entries
          WHERE wallet = ?
          ORDER BY joined_at_ms DESC
        `
      )
      .all(wallet) as Array<{
      id: string;
      round_id: string;
      market: string;
      feed_id: string;
      round_start_ms: number;
      round_end_ms: number;
      wallet: string;
      direction: string;
      stake_bucks: number;
      joined_at_ms: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      roundId: row.round_id,
      market: row.market,
      feedId: row.feed_id,
      roundStartMs: Number(row.round_start_ms),
      roundEndMs: Number(row.round_end_ms),
      wallet: row.wallet,
      direction: row.direction as SimDirection,
      stakeBucks: Number(row.stake_bucks),
      joinedAtMs: Number(row.joined_at_ms)
    }));
  }

  const pool = await getPgPool();
  if (pool) {
    const res = await pool.query("SELECT * FROM sim_entries WHERE wallet = $1 ORDER BY joined_at_ms DESC", [wallet]);
    return res.rows.map((row) => ({
      id: row.id,
      roundId: row.round_id,
      market: row.market,
      feedId: row.feed_id,
      roundStartMs: Number(row.round_start_ms),
      roundEndMs: Number(row.round_end_ms),
      wallet: row.wallet,
      direction: row.direction as SimDirection,
      stakeBucks: Number(row.stake_bucks),
      joinedAtMs: Number(row.joined_at_ms)
    }));
  }

  return requireDbBackend("readSimWalletEntries");
}

export async function readSimEntriesForRoundIds(roundIds: string[]): Promise<SimEntry[]> {
  if (roundIds.length === 0) {
    return [];
  }

  const uniqueRoundIds = [...new Set(roundIds)];

  const d1 = await getD1Database();
  if (d1) {
    const placeholders = uniqueRoundIds.map(() => "?").join(", ");
    const result = await d1
      .prepare(
        `
          SELECT id, round_id, market, feed_id, round_start_ms, round_end_ms, wallet, direction, stake_bucks, joined_at_ms
          FROM sim_entries
          WHERE round_id IN (${placeholders})
          ORDER BY joined_at_ms DESC
        `
      )
      .bind(...uniqueRoundIds)
      .all<{
        id: string;
        round_id: string;
        market: string;
        feed_id: string;
        round_start_ms: number;
        round_end_ms: number;
        wallet: string;
        direction: string;
        stake_bucks: number;
        joined_at_ms: number;
      }>();

    return (result.results ?? []).map((row) => ({
      id: row.id,
      roundId: row.round_id,
      market: row.market,
      feedId: row.feed_id,
      roundStartMs: Number(row.round_start_ms),
      roundEndMs: Number(row.round_end_ms),
      wallet: row.wallet,
      direction: row.direction as SimDirection,
      stakeBucks: Number(row.stake_bucks),
      joinedAtMs: Number(row.joined_at_ms)
    }));
  }

  const sqlite = await getSqliteDatabase();
  if (sqlite) {
    const placeholders = uniqueRoundIds.map(() => "?").join(", ");
    const rows = sqlite
      .prepare(
        `
          SELECT id, round_id, market, feed_id, round_start_ms, round_end_ms, wallet, direction, stake_bucks, joined_at_ms
          FROM sim_entries
          WHERE round_id IN (${placeholders})
          ORDER BY joined_at_ms DESC
        `
      )
      .all(...uniqueRoundIds) as Array<{
      id: string;
      round_id: string;
      market: string;
      feed_id: string;
      round_start_ms: number;
      round_end_ms: number;
      wallet: string;
      direction: string;
      stake_bucks: number;
      joined_at_ms: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      roundId: row.round_id,
      market: row.market,
      feedId: row.feed_id,
      roundStartMs: Number(row.round_start_ms),
      roundEndMs: Number(row.round_end_ms),
      wallet: row.wallet,
      direction: row.direction as SimDirection,
      stakeBucks: Number(row.stake_bucks),
      joinedAtMs: Number(row.joined_at_ms)
    }));
  }

  const pool = await getPgPool();
  if (pool) {
    const placeholders = uniqueRoundIds.map((_, idx) => `$${idx + 1}`).join(", ");
    const res = await pool.query(
      `SELECT * FROM sim_entries WHERE round_id IN (${placeholders}) ORDER BY joined_at_ms DESC`,
      uniqueRoundIds
    );
    return res.rows.map((row) => ({
      id: row.id,
      roundId: row.round_id,
      market: row.market,
      feedId: row.feed_id,
      roundStartMs: Number(row.round_start_ms),
      roundEndMs: Number(row.round_end_ms),
      wallet: row.wallet,
      direction: row.direction as SimDirection,
      stakeBucks: Number(row.stake_bucks),
      joinedAtMs: Number(row.joined_at_ms)
    }));
  }

  return requireDbBackend("readSimEntriesForRoundIds");
}

export async function readSimRoundPoolStats(roundId: string): Promise<SimRoundPoolStats | null> {
  const d1 = await getD1Database();
  if (d1) {
    const rows = await d1
      .prepare(
        `
          SELECT market, wallet, direction, stake_bucks
          FROM sim_entries
          WHERE round_id = ?
        `
      )
      .bind(roundId)
      .all<{
        market: string;
        wallet: string;
        direction: string;
        stake_bucks: number;
      }>();

    const items = rows.results ?? [];
    if (items.length === 0) {
      return null;
    }

    let upBucks = 0;
    let downBucks = 0;
    const wallets = new Set<string>();
    for (const item of items) {
      wallets.add(item.wallet);
      if (item.direction === "UP") {
        upBucks += Number(item.stake_bucks);
      } else if (item.direction === "DOWN") {
        downBucks += Number(item.stake_bucks);
      }
    }

    return {
      roundId,
      market: items[0].market,
      totalBucks: upBucks + downBucks,
      upBucks,
      downBucks,
      players: wallets.size,
      entries: items.length
    };
  }

  const sqlite = await getSqliteDatabase();
  if (sqlite) {
    const items = sqlite
      .prepare(
        `
          SELECT market, wallet, direction, stake_bucks
          FROM sim_entries
          WHERE round_id = ?
        `
      )
      .all(roundId) as Array<{ market: string; wallet: string; direction: string; stake_bucks: number }>;

    if (items.length === 0) {
      return null;
    }

    let upBucks = 0;
    let downBucks = 0;
    const wallets = new Set<string>();
    for (const item of items) {
      wallets.add(item.wallet);
      if (item.direction === "UP") {
        upBucks += Number(item.stake_bucks);
      } else if (item.direction === "DOWN") {
        downBucks += Number(item.stake_bucks);
      }
    }

    return {
      roundId,
      market: items[0].market,
      totalBucks: upBucks + downBucks,
      upBucks,
      downBucks,
      players: wallets.size,
      entries: items.length
    };
  }

  return requireDbBackend("readSimRoundPoolStats");
}

export async function addSimEntry(entry: SimEntry): Promise<{ created: boolean }> {
  const d1 = await getD1Database();
  if (d1) {
    const existing = await d1.prepare("SELECT id FROM sim_entries WHERE id = ? LIMIT 1").bind(entry.id).first<{ id: string }>();
    if (existing?.id) {
      return { created: false };
    }

    await d1
      .prepare(
        `
          INSERT INTO sim_entries (
            id, round_id, market, feed_id, round_start_ms, round_end_ms, wallet, direction, stake_bucks, joined_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        entry.id,
        entry.roundId,
        entry.market,
        entry.feedId,
        entry.roundStartMs,
        entry.roundEndMs,
        entry.wallet,
        entry.direction,
        entry.stakeBucks,
        entry.joinedAtMs
      )
      .run();
    return { created: true };
  }

  const sqlite = await getSqliteDatabase();
  if (sqlite) {
    const res = sqlite
      .prepare(
        `
          INSERT OR IGNORE INTO sim_entries (
            id, round_id, market, feed_id, round_start_ms, round_end_ms, wallet, direction, stake_bucks, joined_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        entry.id,
        entry.roundId,
        entry.market,
        entry.feedId,
        entry.roundStartMs,
        entry.roundEndMs,
        entry.wallet,
        entry.direction,
        entry.stakeBucks,
        entry.joinedAtMs
      );

    return { created: Boolean((res.changes ?? 0) > 0) };
  }

  const pool = await getPgPool();
  if (pool) {
    const res = await pool.query(
      `
        INSERT INTO sim_entries (
          id, round_id, market, feed_id, round_start_ms, round_end_ms, wallet, direction, stake_bucks, joined_at_ms
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        entry.id,
        entry.roundId,
        entry.market,
        entry.feedId,
        entry.roundStartMs,
        entry.roundEndMs,
        entry.wallet,
        entry.direction,
        entry.stakeBucks,
        entry.joinedAtMs
      ]
    );
    return { created: (res.rowCount ?? 0) > 0 };
  }

  return requireDbBackend("addSimEntry");
}

export async function readSimRoundSettlement(roundId: string): Promise<SimRoundSettlementRecord | null> {
  const d1 = await getD1Database();
  if (d1) {
    const row = await d1
      .prepare(
        `
          SELECT round_id, settlement_mode, winner_side, start_price, end_price, fee_cents, payouts_json, settled_at_ms
          FROM sim_round_settlements
          WHERE round_id = ?
          LIMIT 1
        `
      )
      .bind(roundId)
      .first<{
        round_id: string;
        settlement_mode: "WIN" | "REFUND";
        winner_side: string | null;
        start_price: number;
        end_price: number;
        fee_cents: number;
        payouts_json: string;
        settled_at_ms: number;
      }>();

    if (!row) {
      return null;
    }

    const payoutsObj = JSON.parse(row.payouts_json) as Record<string, number>;
    return {
      roundId: row.round_id,
      settlement: {
        mode: row.settlement_mode,
        winnerSide: (row.winner_side ?? undefined) as SimDirection | undefined,
        startPrice: Number(row.start_price),
        endPrice: Number(row.end_price)
      },
      payoutsByEntryId: new Map(Object.entries(payoutsObj).map(([k, v]) => [k, Number(v)])),
      feeCents: Number(row.fee_cents),
      settledAtMs: Number(row.settled_at_ms)
    };
  }

  const sqlite = await getSqliteDatabase();
  if (sqlite) {
    const row = sqlite
      .prepare(
        `
          SELECT round_id, settlement_mode, winner_side, start_price, end_price, fee_cents, payouts_json, settled_at_ms
          FROM sim_round_settlements
          WHERE round_id = ?
          LIMIT 1
        `
      )
      .get(roundId) as
      | {
          round_id: string;
          settlement_mode: "WIN" | "REFUND";
          winner_side: string | null;
          start_price: number;
          end_price: number;
          fee_cents: number;
          payouts_json: string;
          settled_at_ms: number;
        }
      | undefined;

    if (!row) {
      return null;
    }

    const payoutsObj = JSON.parse(row.payouts_json) as Record<string, number>;
    return {
      roundId: row.round_id,
      settlement: {
        mode: row.settlement_mode,
        winnerSide: (row.winner_side ?? undefined) as SimDirection | undefined,
        startPrice: Number(row.start_price),
        endPrice: Number(row.end_price)
      },
      payoutsByEntryId: new Map(Object.entries(payoutsObj).map(([k, v]) => [k, Number(v)])),
      feeCents: Number(row.fee_cents),
      settledAtMs: Number(row.settled_at_ms)
    };
  }

  return requireDbBackend("readSimRoundSettlement");
}

export async function writeSimRoundSettlement(record: SimRoundSettlementRecord): Promise<void> {
  const d1 = await getD1Database();
  if (d1) {
    const payoutsObj = Object.fromEntries(record.payoutsByEntryId.entries());
    await d1
      .prepare(
        `
          INSERT INTO sim_round_settlements (
            round_id, settlement_mode, winner_side, start_price, end_price, fee_cents, payouts_json, settled_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(round_id) DO NOTHING
        `
      )
      .bind(
        record.roundId,
        record.settlement.mode,
        record.settlement.winnerSide ?? null,
        record.settlement.startPrice,
        record.settlement.endPrice,
        record.feeCents,
        JSON.stringify(payoutsObj),
        record.settledAtMs
      )
      .run();
    return;
  }

  const sqlite = await getSqliteDatabase();
  if (sqlite) {
    const payoutsObj = Object.fromEntries(record.payoutsByEntryId.entries());
    sqlite
      .prepare(
        `
          INSERT INTO sim_round_settlements (
            round_id, settlement_mode, winner_side, start_price, end_price, fee_cents, payouts_json, settled_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(round_id) DO NOTHING
        `
      )
      .run(
        record.roundId,
        record.settlement.mode,
        record.settlement.winnerSide ?? null,
        record.settlement.startPrice,
        record.settlement.endPrice,
        record.feeCents,
        JSON.stringify(payoutsObj),
        record.settledAtMs
      );
    return;
  }

  return requireDbBackend("writeSimRoundSettlement");
}

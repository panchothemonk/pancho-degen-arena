import { mkdir } from "fs/promises";
import path from "path";

type RateLimitParams = {
  key: string;
  limit: number;
  windowMs: number;
  nowMs: number;
};

type RateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

type D1RunResult<T = unknown> = { results?: T[] };
type D1StatementLike = {
  bind: (...values: unknown[]) => {
    all: <T = unknown>() => Promise<D1RunResult<T>>;
    run: () => Promise<unknown>;
  };
};
type D1DatabaseLike = {
  prepare: (sql: string) => D1StatementLike;
};

type PoolType = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
};

type SqliteStatementLike = {
  get: (...params: unknown[]) => any;
  run: (...params: unknown[]) => { changes?: number };
};
type SqliteDatabaseLike = {
  prepare: (sql: string) => SqliteStatementLike;
  exec: (sql: string) => unknown;
  pragma: (sql: string) => unknown;
};

const SQLITE_DB_PATH = path.join(process.cwd(), "data", "rate-limit.db");
const MEMORY_BUCKETS = new Map<string, { count: number; resetAtMs: number }>();
let d1Promise: Promise<D1DatabaseLike | null> | null = null;
let pgPoolPromise: Promise<PoolType | null> | null = null;
let sqlitePromise: Promise<SqliteDatabaseLike | null> | null = null;
let d1SchemaReady = false;
let pgSchemaReady = false;
let sqliteSchemaReady = false;

function bucketStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

function inMemoryConsume(params: RateLimitParams): RateLimitResult {
  const nowMs = params.nowMs;
  const key = `${params.key}:${bucketStart(nowMs, params.windowMs)}`;
  const resetAtMs = bucketStart(nowMs, params.windowMs) + params.windowMs;
  const existing = MEMORY_BUCKETS.get(key);
  if (!existing) {
    MEMORY_BUCKETS.set(key, { count: 1, resetAtMs });
    return { ok: true };
  }
  if (existing.count >= params.limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000)) };
  }
  existing.count += 1;
  MEMORY_BUCKETS.set(key, existing);
  return { ok: true };
}

async function getD1Database(): Promise<D1DatabaseLike | null> {
  const mode = (process.env.PANCHO_SHARED_RL_D1 ?? "auto").toLowerCase();
  if (mode === "off") {
    return null;
  }
  if (!d1Promise) {
    d1Promise = (async () => {
      try {
        const mod = await import("@opennextjs/cloudflare");
        const context = mod.getCloudflareContext();
        const env = (context?.env ?? {}) as Record<string, unknown>;
        const db = (env.PANCHO_SIM_DB ?? env.DB) as D1DatabaseLike | undefined;
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
          CREATE TABLE IF NOT EXISTS api_rate_limits (
            bucket_key TEXT NOT NULL,
            window_start_ms INTEGER NOT NULL,
            count INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY (bucket_key, window_start_ms)
          )
        `
      )
      .bind()
      .run();
    d1SchemaReady = true;
  }
  return db;
}

async function getPgPool(): Promise<PoolType | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }
  if (!pgPoolPromise) {
    pgPoolPromise = (async () => {
      try {
        const { Pool } = await import("pg");
        return new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: false } : undefined
        }) as PoolType;
      } catch {
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
      CREATE TABLE IF NOT EXISTS api_rate_limits (
        bucket_key TEXT NOT NULL,
        window_start_ms BIGINT NOT NULL,
        count INTEGER NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (bucket_key, window_start_ms)
      )
    `);
    pgSchemaReady = true;
  }
  return pool;
}

async function getSqliteDatabase(): Promise<SqliteDatabaseLike | null> {
  if (process.env.PANCHO_SHARED_RL_SQLITE === "off") {
    return null;
  }
  if (!sqlitePromise) {
    sqlitePromise = (async () => {
      try {
        await mkdir(path.dirname(SQLITE_DB_PATH), { recursive: true });
        const mod = await import("better-sqlite3");
        const DatabaseCtor = (mod as unknown as { default?: new (file: string) => SqliteDatabaseLike }).default;
        if (!DatabaseCtor) return null;
        const db = new DatabaseCtor(SQLITE_DB_PATH);
        db.pragma("journal_mode = WAL");
        db.pragma("synchronous = NORMAL");
        return db;
      } catch {
        return null;
      }
    })();
  }
  const db = await sqlitePromise;
  if (!db) return null;
  if (!sqliteSchemaReady) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_rate_limits (
        bucket_key TEXT NOT NULL,
        window_start_ms INTEGER NOT NULL,
        count INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (bucket_key, window_start_ms)
      );
    `);
    sqliteSchemaReady = true;
  }
  return db;
}

async function consumeWithD1(db: D1DatabaseLike, params: RateLimitParams): Promise<RateLimitResult> {
  const windowStart = bucketStart(params.nowMs, params.windowMs);
  await db
    .prepare(
      `
        INSERT INTO api_rate_limits (bucket_key, window_start_ms, count, updated_at_ms)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(bucket_key, window_start_ms) DO UPDATE
          SET count = count + 1, updated_at_ms = excluded.updated_at_ms
      `
    )
    .bind(params.key, windowStart, params.nowMs)
    .run();
  const row = await db
    .prepare(
      `
        SELECT count
        FROM api_rate_limits
        WHERE bucket_key = ? AND window_start_ms = ?
        LIMIT 1
      `
    )
    .bind(params.key, windowStart)
    .all<{ count: number }>();
  const count = Number(row.results?.[0]?.count ?? 0);
  if (count > params.limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowStart + params.windowMs - params.nowMs) / 1000));
    return { ok: false, retryAfterSec };
  }
  return { ok: true };
}

async function consumeWithPg(pool: PoolType, params: RateLimitParams): Promise<RateLimitResult> {
  const windowStart = bucketStart(params.nowMs, params.windowMs);
  const result = await pool.query(
    `
      INSERT INTO api_rate_limits (bucket_key, window_start_ms, count, updated_at_ms)
      VALUES ($1, $2, 1, $3)
      ON CONFLICT(bucket_key, window_start_ms)
      DO UPDATE SET count = api_rate_limits.count + 1, updated_at_ms = EXCLUDED.updated_at_ms
      RETURNING count
    `,
    [params.key, windowStart, params.nowMs]
  );
  const count = Number(result.rows?.[0]?.count ?? 0);
  if (count > params.limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowStart + params.windowMs - params.nowMs) / 1000));
    return { ok: false, retryAfterSec };
  }
  return { ok: true };
}

async function consumeWithSqlite(db: SqliteDatabaseLike, params: RateLimitParams): Promise<RateLimitResult> {
  const windowStart = bucketStart(params.nowMs, params.windowMs);
  db.prepare(
    `
      INSERT INTO api_rate_limits (bucket_key, window_start_ms, count, updated_at_ms)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(bucket_key, window_start_ms)
      DO UPDATE SET count = count + 1, updated_at_ms = excluded.updated_at_ms
    `
  ).run(params.key, windowStart, params.nowMs);
  const row = db
    .prepare(
      `
        SELECT count
        FROM api_rate_limits
        WHERE bucket_key = ? AND window_start_ms = ?
        LIMIT 1
      `
    )
    .get(params.key, windowStart);
  const count = Number(row?.count ?? 0);
  if (count > params.limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowStart + params.windowMs - params.nowMs) / 1000));
    return { ok: false, retryAfterSec };
  }
  return { ok: true };
}

export async function consumeSharedRateLimit(params: RateLimitParams): Promise<RateLimitResult> {
  const d1 = await getD1Database();
  if (d1) {
    return consumeWithD1(d1, params);
  }
  const pg = await getPgPool();
  if (pg) {
    return consumeWithPg(pg, params);
  }
  const sqlite = await getSqliteDatabase();
  if (sqlite) {
    return consumeWithSqlite(sqlite, params);
  }
  return inMemoryConsume(params);
}

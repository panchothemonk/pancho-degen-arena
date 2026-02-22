import { Connection, clusterApiUrl } from "@solana/web3.js";

const PYTH_HERMES_URL = "https://hermes.pyth.network";
const DEFAULT_MARKET = "SOL";
const LATEST_SNAPSHOT_CACHE_MS = 10_000;
const STALE_ON_429_MAX_AGE_MS = 60_000;
const MARKET_STALE_FALLBACK_MAX_AGE_MS = 180_000;

export type MarketConfig = {
  key: string;
  label: string;
  asset: string;
  feedId: string;
};

export const MARKET_CONFIGS: MarketConfig[] = [
  { key: "SOL", label: "SOL", asset: "SOL/USD", feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" },
  { key: "BTC", label: "BTC", asset: "BTC/USD", feedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
  { key: "ETH", label: "ETH", asset: "ETH/USD", feedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
  { key: "XRP", label: "XRP", asset: "XRP/USD", feedId: "ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8" },
  { key: "PEPE", label: "PEPE", asset: "1000PEPE/USD", feedId: "7f3febb69d47fd18c6e29697fc2c19ee70b9877111410238d8587f2cffacb232" },
  { key: "BONK", label: "BONK", asset: "BONK/USD", feedId: "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419" }
];

const MARKET_BY_KEY = new Map(MARKET_CONFIGS.map((market) => [market.key, market]));
const MARKET_BY_FEED = new Map(MARKET_CONFIGS.map((market) => [market.feedId, market]));

export type OracleSnapshot = {
  market: string;
  asset: string;
  source: "Pyth Hermes";
  feedId: string;
  price: number;
  confidence: number;
  publishTime: number;
  devnetSlot: number;
  devnetEndpoint: string;
  fetchedAt: string;
};

let devnetConnection: Connection | undefined;
const snapshotCache = new Map<string, { snapshot: OracleSnapshot; cachedAtMs: number }>();
const marketSnapshotCache = new Map<string, { snapshot: OracleSnapshot; cachedAtMs: number }>();
const inflightRequests = new Map<string, Promise<OracleSnapshot>>();
const MAX_STALE_SERVE_MS = 10 * 60 * 1000;

function getDevnetConnection() {
  if (!devnetConnection) {
    const endpoint = process.env.SOLANA_RPC_URL ?? clusterApiUrl("devnet");
    devnetConnection = new Connection(endpoint, "processed");
  }

  return devnetConnection;
}

async function getRpcMetaSafe(): Promise<{ slot: number; endpoint: string }> {
  const endpoint = process.env.SOLANA_RPC_URL ?? clusterApiUrl("devnet");

  try {
    const connection = getDevnetConnection();
    const slot = await connection.getSlot("processed");
    return { slot, endpoint: connection.rpcEndpoint };
  } catch {
    // Some hosted runtimes/IP ranges are blocked by public RPC providers.
    // Oracle pricing should still work, so we degrade slot telemetry gracefully.
    return { slot: 0, endpoint };
  }
}

function scaleToNumber(raw: string, exponent: number): number {
  return Number(raw) * 10 ** exponent;
}

export function resolveMarketByKey(marketKey?: string | null): MarketConfig {
  if (!marketKey) {
    return MARKET_BY_KEY.get(DEFAULT_MARKET)!;
  }

  return MARKET_BY_KEY.get(marketKey.toUpperCase()) ?? MARKET_BY_KEY.get(DEFAULT_MARKET)!;
}

export function resolveMarketByFeedId(feedId?: string | null): MarketConfig {
  if (!feedId) {
    return MARKET_BY_KEY.get(DEFAULT_MARKET)!;
  }

  return MARKET_BY_FEED.get(feedId) ?? MARKET_BY_KEY.get(DEFAULT_MARKET)!;
}

export async function fetchOracleSnapshot(marketKey?: string | null): Promise<OracleSnapshot> {
  const market = resolveMarketByKey(marketKey);
  const url = `${PYTH_HERMES_URL}/v2/updates/price/latest?ids[]=${market.feedId}&parsed=true`;
  return fetchOracleSnapshotFromUrl(url, market, {
    cacheTtlMs: LATEST_SNAPSHOT_CACHE_MS,
    allowStaleOn429: true
  });
}

export function getCachedOracleSnapshot(marketKey?: string | null): OracleSnapshot | null {
  const market = resolveMarketByKey(marketKey);
  const cached = marketSnapshotCache.get(market.key);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.cachedAtMs > MAX_STALE_SERVE_MS) {
    return null;
  }
  return cached.snapshot;
}

export async function fetchOracleSnapshotAtTimestamp(
  marketKey: string,
  unixTimestampSec: number
): Promise<OracleSnapshot> {
  const market = resolveMarketByKey(marketKey);
  const clampedTs = Math.max(0, Math.floor(unixTimestampSec));
  const url = `${PYTH_HERMES_URL}/v2/updates/price/${clampedTs}?ids[]=${market.feedId}&parsed=true`;
  return fetchOracleSnapshotFromUrl(url, market, {
    cacheTtlMs: 0,
    allowStaleOn429: false
  });
}

async function fetchOracleSnapshotFromUrl(
  url: string,
  market: MarketConfig,
  options: { cacheTtlMs: number; allowStaleOn429: boolean }
): Promise<OracleSnapshot> {
  const now = Date.now();
  const cached = snapshotCache.get(url);
  if (cached && options.cacheTtlMs > 0 && now - cached.cachedAtMs <= options.cacheTtlMs) {
    return cached.snapshot;
  }

  const existingInflight = inflightRequests.get(url);
  if (existingInflight) {
    return existingInflight;
  }

  const request = (async () => {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });

    if (!res.ok) {
      if (res.status === 429 && options.allowStaleOn429 && cached && now - cached.cachedAtMs <= STALE_ON_429_MAX_AGE_MS) {
        return cached.snapshot;
      }
      if (res.status === 429 && options.allowStaleOn429) {
        const marketCached = marketSnapshotCache.get(market.key);
        if (marketCached && now - marketCached.cachedAtMs <= MARKET_STALE_FALLBACK_MAX_AGE_MS) {
          return marketCached.snapshot;
        }
      }
      throw new Error(`Pyth request failed with status ${res.status}`);
    }

    const data = (await res.json()) as {
      parsed?: Array<{
        price?: {
          price: string;
          conf: string;
          expo: number;
          publish_time: number;
        };
      }>;
    };

    const parsed = data.parsed?.[0]?.price;
    if (!parsed) {
      throw new Error("Pyth response missing parsed price payload");
    }

    const rpcMeta = await getRpcMetaSafe();
    const snapshot: OracleSnapshot = {
      market: market.key,
      asset: market.asset,
      source: "Pyth Hermes",
      feedId: market.feedId,
      price: scaleToNumber(parsed.price, parsed.expo),
      confidence: scaleToNumber(parsed.conf, parsed.expo),
      publishTime: parsed.publish_time,
      devnetSlot: rpcMeta.slot,
      devnetEndpoint: rpcMeta.endpoint,
      fetchedAt: new Date().toISOString()
    };

    snapshotCache.set(url, { snapshot, cachedAtMs: Date.now() });
    marketSnapshotCache.set(market.key, { snapshot, cachedAtMs: Date.now() });
    return snapshot;
  })();

  inflightRequests.set(url, request);
  try {
    return await request;
  } finally {
    inflightRequests.delete(url);
  }
}

import { Keypair } from '@solana/web3.js';

const BASE = 'http://localhost:3000';
const OPEN_SECONDS = 60;
const LOCK_SECONDS = 60;
const CYCLE_MS = (OPEN_SECONDS + LOCK_SECONDS) * 1000;
const SETTLE_SECONDS = 5 * 60;
const MARKETS = ['SOL', 'BTC', 'ETH', 'XRP', 'PEPE', 'BONK'];
const FEED_BY_MARKET = {
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  BTC: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  XRP: 'ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
  PEPE: '7f3febb69d47fd18c6e29697fc2c19ee70b9877111410238d8587f2cffacb232',
  BONK: '72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419'
};
const STAKES = [5, 10, 25, 50, 100, 250];
const DIRS = ['UP', 'DOWN'];
const TOTAL = Number(process.env.STRESS_TOTAL ?? 5000);
const CONCURRENCY = Number(process.env.STRESS_CONCURRENCY ?? 120);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function choose(arr, i) { return arr[i % arr.length]; }

async function fetchJsonWithTimeout(url, init = {}, timeoutMs = 10000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

function getRoundStartMs(now = Date.now()) {
  const cycleStart = Math.floor(now / CYCLE_MS) * CYCLE_MS;
  const lockMs = cycleStart + OPEN_SECONDS * 1000;
  const openLeftMs = lockMs - now;
  if (openLeftMs > 25000) return cycleStart;
  return cycleStart + CYCLE_MS;
}

async function waitForOpen(roundStartMs) {
  while (Date.now() < roundStartMs + 200) {
    await sleep(80);
  }
}

async function postEntry(payload) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let timer = null;
    try {
      const ctl = new AbortController();
      timer = setTimeout(() => ctl.abort(), 10000);
      const res = await fetch(`${BASE}/api/sim/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal
      });
      clearTimeout(timer);
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, json, attempt };
    } catch (error) {
      lastErr = error;
      await sleep(120 * attempt);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    ok: false,
    status: 0,
    json: { error: lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'network error') },
    attempt: 3
  };
}

async function getPool(roundId) {
  return fetchJsonWithTimeout(`${BASE}/api/sim/pool?roundId=${encodeURIComponent(roundId)}`);
}

async function getResults(wallet) {
  return fetchJsonWithTimeout(`${BASE}/api/sim/results?wallet=${wallet}`);
}

const roundStartMs = getRoundStartMs();
await waitForOpen(roundStartMs);
const roundEndMs = roundStartMs + (OPEN_SECONDS + SETTLE_SECONDS) * 1000;

const expected = new Map();
const wallets = [];
let sent = 0;
let ok = 0;
let fail = 0;
let retried = 0;
const errors = new Map();
const started = Date.now();

const jobs = [];
for (let i = 0; i < TOTAL; i++) {
  jobs.push(async () => {
    const market = choose(MARKETS, i + Math.floor(Math.random() * 1000));
    const feedId = FEED_BY_MARKET[market] ?? FEED_BY_MARKET.SOL;
    const roundId = `${market}-${Math.floor(roundStartMs / 1000)}-5m`;
    const direction = choose(DIRS, i + Math.floor(Math.random() * 1000));
    const stakeBucks = choose(STAKES, i + Math.floor(Math.random() * 1000));
    const wallet = Keypair.generate().publicKey.toBase58();
    wallets.push(wallet);

    const stats = expected.get(roundId) ?? { entries: 0, totalBucks: 0, upBucks: 0, downBucks: 0, players: new Set() };
    stats.entries += 1;
    stats.totalBucks += stakeBucks;
    stats.players.add(wallet);
    if (direction === 'UP') stats.upBucks += stakeBucks;
    else stats.downBucks += stakeBucks;
    expected.set(roundId, stats);

    const payload = {
      id: `stress-${Date.now()}-${i}-${Math.random().toString(16).slice(2)}`,
      roundId,
      market,
      feedId,
      roundStartMs,
      roundEndMs,
      wallet,
      direction,
      stakeBucks,
      joinedAtMs: Date.now()
    };

    const result = await postEntry(payload);
    sent += 1;
    if (result.attempt > 1) retried += 1;

    if (result.ok && result.json?.ok) {
      ok += 1;
    } else {
      fail += 1;
      const key = `${result.status}:${result.json?.error ?? 'unknown'}`;
      errors.set(key, (errors.get(key) ?? 0) + 1);
    }
  });
}

for (let i = 0; i < jobs.length; i += CONCURRENCY) {
  await Promise.all(jobs.slice(i, i + CONCURRENCY).map((fn) => fn()));
}

const tookMs = Date.now() - started;

const poolChecks = [];
for (const [roundId, exp] of expected.entries()) {
  const got = await getPool(roundId);
  poolChecks.push({
    roundId,
    expected: {
      entries: exp.entries,
      totalBucks: exp.totalBucks,
      upBucks: exp.upBucks,
      downBucks: exp.downBucks,
      players: exp.players.size
    },
    actual: got.json?.stats ?? null,
    status: got.status
  });
}

const sampleWallets = wallets.slice(0, 10);
const walletResults = [];
for (const w of sampleWallets) {
  const r = await getResults(w);
  walletResults.push({ wallet: w, status: r.status, rounds: r.json?.rounds?.length ?? 0, mode: r.json?.mode });
}

const summary = {
  totalTarget: TOTAL,
  sent,
  ok,
  fail,
  retried,
  durationSec: Number((tookMs / 1000).toFixed(2)),
  errors: Object.fromEntries(errors.entries()),
  roundStartMs,
  roundEndMs,
  poolChecks,
  walletResults
};

console.log(JSON.stringify(summary, null, 2));

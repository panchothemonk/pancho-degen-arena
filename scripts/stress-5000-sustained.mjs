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
const WORKERS = Number(process.env.STRESS_WORKERS ?? 250);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getWindow(now = Date.now()) {
  const cycleStart = Math.floor(now / CYCLE_MS) * CYCLE_MS;
  const lockMs = cycleStart + OPEN_SECONDS * 1000;
  const isOpen = now >= cycleStart && now < lockMs;
  return { now, cycleStart, lockMs, isOpen };
}

async function waitUntilOpen() {
  for (;;) {
    const w = getWindow();
    if (w.isOpen) return w;
    const nextOpen = Math.floor(w.now / CYCLE_MS) * CYCLE_MS + CYCLE_MS;
    await sleep(Math.max(50, nextOpen - w.now + 20));
  }
}

async function postEntry(payload) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10000);
      const res = await fetch(`${BASE}/api/sim/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal
      });
      clearTimeout(timer);
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok && json?.ok, status: res.status, error: json?.error ?? null };
    } catch (error) {
      lastErr = error;
      await sleep(100 * attempt);
    }
  }
  return {
    ok: false,
    status: 0,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'network error')
  };
}

let issued = 0;
let ok = 0;
let fail = 0;
const errors = new Map();
const countsByRound = new Map();
const wallets = [];

async function workerRun(workerId) {
  for (;;) {
    const index = issued;
    if (index >= TOTAL) return;
    issued += 1;

    const market = MARKETS[(index + workerId) % MARKETS.length];
    const feedId = FEED_BY_MARKET[market] ?? FEED_BY_MARKET.SOL;
    const direction = DIRS[(index + workerId * 7) % DIRS.length];
    const stakeBucks = STAKES[(index + workerId * 3) % STAKES.length];
    const wallet = Keypair.generate().publicKey.toBase58();
    wallets.push(wallet);

    const w = await waitUntilOpen();
    const roundStartMs = w.cycleStart;
    const roundId = `${market}-${Math.floor(roundStartMs / 1000)}-5m`;
    const roundEndMs = roundStartMs + (OPEN_SECONDS + SETTLE_SECONDS) * 1000;

    const payload = {
      id: `sustain-${Date.now()}-${workerId}-${index}-${Math.random().toString(16).slice(2)}`,
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
    if (result.ok) {
      ok += 1;
      countsByRound.set(roundId, (countsByRound.get(roundId) ?? 0) + 1);
    } else {
      fail += 1;
      const key = `${result.status}:${result.error ?? 'unknown'}`;
      errors.set(key, (errors.get(key) ?? 0) + 1);
    }
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: WORKERS }, (_, idx) => workerRun(idx)));
const tookSec = Number(((Date.now() - started) / 1000).toFixed(2));

console.log(
  JSON.stringify(
    {
      totalTarget: TOTAL,
      workers: WORKERS,
      ok,
      fail,
      durationSec: tookSec,
      roundsUsed: countsByRound.size,
      countsByRound: Object.fromEntries([...countsByRound.entries()].slice(0, 20)),
      sampleWallets: wallets.slice(0, 10),
      errors: Object.fromEntries(errors.entries())
    },
    null,
    2
  )
);

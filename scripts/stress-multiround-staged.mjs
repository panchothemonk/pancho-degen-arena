import { Keypair } from '@solana/web3.js';

const BASE = process.env.STRESS_BASE ?? 'http://localhost:3000';
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

const STAGES = (process.env.STRESS_STAGE_TARGETS ?? '5000,20000,50000')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const PER_ROUND_ATTEMPTS = Number(process.env.STRESS_PER_ROUND_ATTEMPTS ?? 3800);
const CONCURRENCY = Number(process.env.STRESS_CONCURRENCY ?? 700);
const REQUEST_TIMEOUT_MS = Number(process.env.STRESS_TIMEOUT_MS ?? 10000);
const MIN_OPEN_BUFFER_MS = Number(process.env.STRESS_MIN_OPEN_BUFFER_MS ?? 7000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getWindow(now = Date.now()) {
  const cycleStart = Math.floor(now / CYCLE_MS) * CYCLE_MS;
  const lockMs = cycleStart + OPEN_SECONDS * 1000;
  return {
    now,
    cycleStart,
    lockMs,
    isOpen: now >= cycleStart && now < lockMs,
    openLeftMs: Math.max(0, lockMs - now)
  };
}

async function waitForOpenWindow() {
  for (;;) {
    const w = getWindow();
    if (w.isOpen && w.openLeftMs > MIN_OPEN_BUFFER_MS) return w;
    const nextOpen = w.isOpen ? w.cycleStart + CYCLE_MS : (Math.floor(w.now / CYCLE_MS) * CYCLE_MS + CYCLE_MS);
    await sleep(Math.max(100, nextOpen - w.now + 150));
  }
}

async function postEntry(payload) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let timer = null;
    try {
      const ctl = new AbortController();
      timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(`${BASE}/api/sim/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal
      });
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok && json?.ok, status: res.status, error: json?.error ?? null };
    } catch (error) {
      lastError = error;
      await sleep(120 * attempt);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    ok: false,
    status: 0,
    error: lastError instanceof Error ? lastError.message : String(lastError ?? 'network error')
  };
}

function makePayload(index, roundStartMs) {
  const market = MARKETS[index % MARKETS.length];
  const feedId = FEED_BY_MARKET[market] ?? FEED_BY_MARKET.SOL;
  const direction = DIRS[(index * 7) % DIRS.length];
  const stakeBucks = STAKES[(index * 3) % STAKES.length];
  const wallet = Keypair.generate().publicKey.toBase58();
  const roundId = `${market}-${Math.floor(roundStartMs / 1000)}-5m`;
  const roundEndMs = roundStartMs + (OPEN_SECONDS + SETTLE_SECONDS) * 1000;
  return {
    id: `mr-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
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
}

async function runRound({ stageName, remaining, globalOffset }) {
  const w = await waitForOpenWindow();
  const roundStartMs = w.cycleStart;
  const maxAttempts = Math.min(remaining, PER_ROUND_ATTEMPTS);

  const stats = {
    stageName,
    roundStartMs,
    attempts: 0,
    ok: 0,
    fail: 0,
    errors: {}
  };

  let issued = 0;
  async function worker(workerId) {
    for (;;) {
      const idx = issued;
      if (idx >= maxAttempts) return;
      issued += 1;

      if (getWindow().openLeftMs <= MIN_OPEN_BUFFER_MS) return;

      const payload = makePayload(globalOffset + idx + workerId, roundStartMs);
      const result = await postEntry(payload);
      stats.attempts += 1;
      if (result.ok) {
        stats.ok += 1;
      } else {
        stats.fail += 1;
        const key = `${result.status}:${result.error ?? 'unknown'}`;
        stats.errors[key] = (stats.errors[key] ?? 0) + 1;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

  return stats;
}

async function runStage(totalTarget, stageIndex) {
  const stageName = `stage${stageIndex + 1}-${totalTarget}`;
  const started = Date.now();
  let attempted = 0;
  let ok = 0;
  let fail = 0;
  let roundCount = 0;
  let globalOffset = stageIndex * 1_000_000;
  const errors = {};
  const rounds = [];

  while (attempted < totalTarget) {
    const remaining = totalTarget - attempted;
    const round = await runRound({ stageName, remaining, globalOffset });
    roundCount += 1;
    attempted += round.attempts;
    ok += round.ok;
    fail += round.fail;
    rounds.push(round);

    Object.entries(round.errors).forEach(([k, v]) => {
      errors[k] = (errors[k] ?? 0) + v;
    });

    globalOffset += round.attempts + 1000;

    if (round.attempts === 0) {
      await sleep(500);
    }
  }

  return {
    stage: stageName,
    totalTarget,
    attempted,
    ok,
    fail,
    successRate: Number(((ok / Math.max(1, attempted)) * 100).toFixed(2)),
    roundsUsed: roundCount,
    durationSec: Number(((Date.now() - started) / 1000).toFixed(2)),
    errors,
    roundSummaries: rounds.map((r) => ({
      roundStartMs: r.roundStartMs,
      attempts: r.attempts,
      ok: r.ok,
      fail: r.fail
    }))
  };
}

const suiteStarted = Date.now();
const stageResults = [];

for (let i = 0; i < STAGES.length; i++) {
  const stageTotal = STAGES[i];
  const result = await runStage(stageTotal, i);
  stageResults.push(result);
}

const summary = {
  base: BASE,
  config: {
    openSeconds: OPEN_SECONDS,
    lockSeconds: LOCK_SECONDS,
    settleSeconds: SETTLE_SECONDS,
    stages: STAGES,
    perRoundAttempts: PER_ROUND_ATTEMPTS,
    concurrency: CONCURRENCY,
    timeoutMs: REQUEST_TIMEOUT_MS,
    minOpenBufferMs: MIN_OPEN_BUFFER_MS
  },
  durationSec: Number(((Date.now() - suiteStarted) / 1000).toFixed(2)),
  stages: stageResults
};

console.log(JSON.stringify(summary, null, 2));

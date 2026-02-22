import { Keypair } from '@solana/web3.js';

const BASE = process.env.STRESS_BASE ?? 'http://localhost:3000';
const OPEN_SECONDS = 60;
const LOCK_SECONDS = 60;
const SETTLE_SECONDS = 5 * 60;
const CYCLE_MS = (OPEN_SECONDS + LOCK_SECONDS) * 1000;
const ROUND_TOTAL = Number(process.env.STRESS_TOTAL ?? 4500);
const ENTRY_CONCURRENCY = Number(process.env.STRESS_ENTRY_CONCURRENCY ?? 700);
const RESULTS_CONCURRENCY = Number(process.env.STRESS_RESULTS_CONCURRENCY ?? 250);
const REQUEST_TIMEOUT_MS = Number(process.env.STRESS_TIMEOUT_MS ?? 12000);
const OPEN_BUFFER_MS = Number(process.env.STRESS_MIN_OPEN_BUFFER_MS ?? 5000);
const SETTLE_GRACE_MS = Number(process.env.STRESS_SETTLE_GRACE_MS ?? 3000);
const VERIFY_SAMPLE = Number(process.env.STRESS_VERIFY_SAMPLE ?? 500);
const VERIFY_RECHECK_DELAY_MS = Number(process.env.STRESS_VERIFY_RECHECK_DELAY_MS ?? 600);
const RESULTS_WALLET_LIMIT = Number(process.env.STRESS_RESULTS_WALLET_LIMIT ?? 0);
const RESULTS_BATCH_SIZE = Number(process.env.STRESS_RESULTS_BATCH_SIZE ?? 0);
const RESULTS_BATCH_DELAY_MS = Number(process.env.STRESS_RESULTS_BATCH_DELAY_MS ?? 250);

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
const DIRECTIONS = ['UP', 'DOWN'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowWindow(now = Date.now()) {
  const start = Math.floor(now / CYCLE_MS) * CYCLE_MS;
  const lockMs = start + OPEN_SECONDS * 1000;
  return {
    now,
    roundStartMs: start,
    lockMs,
    openLeftMs: Math.max(0, lockMs - now),
    isOpen: now >= start && now < lockMs
  };
}

async function waitForOpenWindow() {
  for (;;) {
    const w = nowWindow();
    if (w.isOpen && w.openLeftMs > OPEN_BUFFER_MS) return w;
    const nextOpen = w.isOpen ? w.roundStartMs + CYCLE_MS : Math.floor(w.now / CYCLE_MS) * CYCLE_MS + CYCLE_MS;
    await sleep(Math.max(100, nextOpen - w.now + 120));
  }
}

async function fetchJson(url, init = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(fn, retries = 3) {
  let last = null;
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await sleep(120 * i);
    }
  }
  throw last ?? new Error('request failed');
}

async function postEntry(payload) {
  try {
    const result = await withRetry(
      () =>
        fetchJson(`${BASE}/api/sim/entries`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        }),
      3
    );
    return {
      ok: Boolean(result.ok && result.json?.ok),
      status: result.status,
      error: result.json?.error ?? null
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error ?? 'network error')
    };
  }
}

async function getResults(wallet) {
  return withRetry(() => fetchJson(`${BASE}/api/sim/results?wallet=${wallet}`), 3);
}

function buildPayload(index, roundStartMs) {
  const market = MARKETS[index % MARKETS.length];
  const feedId = FEED_BY_MARKET[market] ?? FEED_BY_MARKET.SOL;
  const direction = DIRECTIONS[Math.floor(index / MARKETS.length) % DIRECTIONS.length];
  const stakeBucks = STAKES[(index * 3) % STAKES.length];
  const wallet = Keypair.generate().publicKey.toBase58();
  const roundId = `${market}-${Math.floor(roundStartMs / 1000)}-5m`;
  const roundEndMs = roundStartMs + (OPEN_SECONDS + SETTLE_SECONDS) * 1000;
  return {
    payload: {
      id: `settle-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
      roundId,
      market,
      feedId,
      roundStartMs,
      roundEndMs,
      wallet,
      direction,
      stakeBucks,
      joinedAtMs: Date.now()
    },
    wallet,
    roundId,
    market,
    direction
  };
}

const startWindow = await waitForOpenWindow();
const roundStartMs = startWindow.roundStartMs;
const roundEndMs = roundStartMs + (OPEN_SECONDS + SETTLE_SECONDS) * 1000;

const joined = [];
let issued = 0;
let ok = 0;
let fail = 0;
const joinErrors = {};

async function entryWorker(workerId) {
  for (;;) {
    const idx = issued;
    if (idx >= ROUND_TOTAL) return;
    issued += 1;

    if (nowWindow().openLeftMs <= OPEN_BUFFER_MS) return;
    const built = buildPayload(idx + workerId, roundStartMs);
    const result = await postEntry(built.payload);
    if (result.ok) {
      ok += 1;
      joined.push({
        wallet: built.wallet,
        roundId: built.roundId,
        market: built.market,
        direction: built.direction,
        entryId: built.payload.id
      });
    } else {
      fail += 1;
      const key = `${result.status}:${result.error ?? 'unknown'}`;
      joinErrors[key] = (joinErrors[key] ?? 0) + 1;
    }
  }
}

const entryStart = Date.now();
await Promise.all(Array.from({ length: ENTRY_CONCURRENCY }, (_, i) => entryWorker(i)));
const entryDurationSec = Number(((Date.now() - entryStart) / 1000).toFixed(2));

const waitMs = Math.max(0, roundEndMs + SETTLE_GRACE_MS - Date.now());
if (waitMs > 0) {
  await sleep(waitMs);
}

if (joined.length === 0) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        reason: 'no_successful_entries',
        config: { roundTotal: ROUND_TOTAL, entryConcurrency: ENTRY_CONCURRENCY },
        join: { ok, fail, errors: joinErrors, durationSec: entryDurationSec }
      },
      null,
      2
    )
  );
  process.exit(0);
}

const targetEntriesAll = joined.map((j) => ({
  wallet: j.wallet,
  roundId: j.roundId,
  market: j.market,
  entryId: j.entryId
}));
const targetEntries =
  RESULTS_WALLET_LIMIT > 0 ? targetEntriesAll.slice(0, Math.min(RESULTS_WALLET_LIMIT, targetEntriesAll.length)) : targetEntriesAll;
let resultOk = 0;
let resultFail = 0;
const resultErrors = {};
const statuses = { PENDING: 0, WIN: 0, LOSS: 0, REFUND: 0, MISSING: 0 };
const statusByMarket = {};
const entrySnapshot = new Map();

let resultIssued = 0;
async function resultsWorker(entriesBatch) {
  for (;;) {
    const idx = resultIssued;
    if (idx >= entriesBatch.length) return;
    resultIssued += 1;

    const target = entriesBatch[idx];
    const wallet = target.wallet;
    try {
      const res = await getResults(wallet);
      if (!res.ok) {
        resultFail += 1;
        const key = `${res.status}:${res.json?.error ?? 'unknown'}`;
        resultErrors[key] = (resultErrors[key] ?? 0) + 1;
        continue;
      }

      resultOk += 1;
      const round = (res.json?.rounds ?? []).find((r) => r.roundId === target.roundId && r.entrySignature === target.entryId);
      if (!round) {
        statuses.MISSING += 1;
        continue;
      }
      const st = round.status ?? 'MISSING';
      if (!statuses[st]) statuses[st] = 0;
      statuses[st] += 1;

      const market = target.market;
      if (!statusByMarket[market]) statusByMarket[market] = { WIN: 0, LOSS: 0, REFUND: 0, PENDING: 0, MISSING: 0 };
      if (!statusByMarket[market][st]) statusByMarket[market][st] = 0;
      statusByMarket[market][st] += 1;

      entrySnapshot.set(target.entryId, {
        status: st,
        payoutLamports: round.payoutLamports ?? null,
        pnlLamports: round.pnlLamports ?? null
      });
    } catch (error) {
      resultFail += 1;
      const key = `0:${error instanceof Error ? error.message : String(error ?? 'unknown')}`;
      resultErrors[key] = (resultErrors[key] ?? 0) + 1;
    }
  }
}

const settleStart = Date.now();
const walletBatches = (() => {
  if (!RESULTS_BATCH_SIZE || RESULTS_BATCH_SIZE <= 0) {
    return [targetEntries];
  }
  const out = [];
  for (let i = 0; i < targetEntries.length; i += RESULTS_BATCH_SIZE) {
    out.push(targetEntries.slice(i, i + RESULTS_BATCH_SIZE));
  }
  return out;
})();

for (let i = 0; i < walletBatches.length; i++) {
  const batch = walletBatches[i];
  resultIssued = 0;
  await Promise.all(Array.from({ length: Math.min(RESULTS_CONCURRENCY, batch.length || 1) }, () => resultsWorker(batch)));
  if (i < walletBatches.length - 1 && RESULTS_BATCH_DELAY_MS > 0) {
    await sleep(RESULTS_BATCH_DELAY_MS);
  }
}
const settleDurationSec = Number(((Date.now() - settleStart) / 1000).toFixed(2));

const sample = targetEntries.slice(0, Math.min(VERIFY_SAMPLE, targetEntries.length));
let verifyMismatches = 0;
let verifyErrors = 0;
for (const item of sample) {
  try {
    const res = await getResults(item.wallet);
    if (!res.ok) continue;
    const round = (res.json?.rounds ?? []).find((r) => r.roundId === item.roundId && r.entrySignature === item.entryId);
    if (!round) continue;
    const prev = entrySnapshot.get(item.entryId);
    if (!prev) continue;
    if (prev.status !== round.status || prev.payoutLamports !== (round.payoutLamports ?? null)) {
      if (VERIFY_RECHECK_DELAY_MS > 0) {
        await sleep(VERIFY_RECHECK_DELAY_MS);
      }
      const retry = await getResults(item.wallet);
      if (!retry.ok) {
        verifyErrors += 1;
        continue;
      }
      const retryRound = (retry.json?.rounds ?? []).find((r) => r.roundId === item.roundId && r.entrySignature === item.entryId);
      if (!retryRound) continue;
      if (prev.status !== retryRound.status || prev.payoutLamports !== (retryRound.payoutLamports ?? null)) {
        verifyMismatches += 1;
      }
    }
  } catch {
    verifyErrors += 1;
  }
}

const pendingLike = (statuses.PENDING ?? 0) + (statuses.MISSING ?? 0);
const summary = {
  ok: pendingLike === 0 && resultFail === 0,
  config: {
    base: BASE,
    roundTotal: ROUND_TOTAL,
    entryConcurrency: ENTRY_CONCURRENCY,
    resultsConcurrency: RESULTS_CONCURRENCY,
    timeoutMs: REQUEST_TIMEOUT_MS,
    verifyRecheckDelayMs: VERIFY_RECHECK_DELAY_MS,
    resultsWalletLimit: RESULTS_WALLET_LIMIT,
    resultsBatchSize: RESULTS_BATCH_SIZE,
    resultsBatchDelayMs: RESULTS_BATCH_DELAY_MS
  },
  round: {
    roundStartMs,
    roundEndMs,
    settleGraceMs: SETTLE_GRACE_MS
  },
  join: {
    attempted: issued,
    ok,
    fail,
    errors: joinErrors,
    durationSec: entryDurationSec
  },
  settlement: {
    queriedWallets: targetEntries.length,
    resultOk,
    resultFail,
    resultErrors,
    statuses,
    statusByMarket,
    pendingOrMissing: pendingLike,
    durationSec: settleDurationSec
  },
  idempotencyCheck: {
    sampleSize: sample.length,
    mismatches: verifyMismatches,
    errors: verifyErrors
  }
};

console.log(JSON.stringify(summary, null, 2));

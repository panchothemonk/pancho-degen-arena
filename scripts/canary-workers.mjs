import { Keypair } from "@solana/web3.js";

const BASE = process.env.CANARY_BASE ?? "https://pancho-degen-arena.panchothemonk.workers.dev";
const OPEN_SECONDS = 60;
const LOCK_SECONDS = 60;
const SETTLE_SECONDS = 5 * 60;
const CYCLE_MS = (OPEN_SECONDS + LOCK_SECONDS) * 1000;
const OPEN_BUFFER_MS = Number(process.env.CANARY_OPEN_BUFFER_MS ?? 8_000);
const WAIT_TIMEOUT_MS = Number(process.env.CANARY_WAIT_TIMEOUT_MS ?? 180_000);
const MARKET = process.env.CANARY_MARKET ?? "SOL";
const FEED_BY_MARKET = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  XRP: "ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
  PEPE: "7f3febb69d47fd18c6e29697fc2c19ee70b9877111410238d8587f2cffacb232",
  BONK: "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419"
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function windowState(now = Date.now()) {
  const roundStartMs = Math.floor(now / CYCLE_MS) * CYCLE_MS;
  const lockMs = roundStartMs + OPEN_SECONDS * 1000;
  const roundEndMs = roundStartMs + (OPEN_SECONDS + SETTLE_SECONDS) * 1000;
  const openLeftMs = Math.max(0, lockMs - now);
  return {
    now,
    roundStartMs,
    lockMs,
    roundEndMs,
    openLeftMs,
    isOpen: now >= roundStartMs && now < lockMs
  };
}

async function waitForOpenWindow() {
  const start = Date.now();
  for (;;) {
    const state = windowState();
    if (state.isOpen && state.openLeftMs > OPEN_BUFFER_MS) {
      return state;
    }
    if (Date.now() - start > WAIT_TIMEOUT_MS) {
      throw new Error("Timed out waiting for open entry window");
    }
    await sleep(750);
  }
}

async function fetchJson(url, init = undefined) {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

function makeEntry({ market, roundStartMs, roundEndMs, direction, stakeBucks }) {
  const feedId = FEED_BY_MARKET[market] ?? FEED_BY_MARKET.SOL;
  const wallet = Keypair.generate().publicKey.toBase58();
  const roundId = `${market}-${Math.floor(roundStartMs / 1000)}-5m`;
  return {
    wallet,
    roundId,
    payload: {
      id: `canary-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      roundId,
      market,
      feedId,
      roundStartMs,
      roundEndMs,
      wallet,
      direction,
      stakeBucks,
      joinedAtMs: Date.now()
    }
  };
}

async function main() {
  const oracle = await fetchJson(`${BASE}/api/oracle?market=${encodeURIComponent(MARKET)}`);
  if (!oracle.ok || !oracle.json?.price) {
    throw new Error(`Oracle check failed: ${oracle.status}`);
  }

  const state = await waitForOpenWindow();
  const up = makeEntry({
    market: MARKET,
    roundStartMs: state.roundStartMs,
    roundEndMs: state.roundEndMs,
    direction: "UP",
    stakeBucks: 10
  });
  const down = makeEntry({
    market: MARKET,
    roundStartMs: state.roundStartMs,
    roundEndMs: state.roundEndMs,
    direction: "DOWN",
    stakeBucks: 25
  });

  const [joinUp, joinDown] = await Promise.all([
    fetchJson(`${BASE}/api/sim/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(up.payload)
    }),
    fetchJson(`${BASE}/api/sim/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(down.payload)
    })
  ]);

  if (!joinUp.ok || !joinUp.json?.ok) {
    throw new Error(`Join UP failed: ${joinUp.status} ${joinUp.json?.error ?? ""}`.trim());
  }
  if (!joinDown.ok || !joinDown.json?.ok) {
    throw new Error(`Join DOWN failed: ${joinDown.status} ${joinDown.json?.error ?? ""}`.trim());
  }

  const pool = await fetchJson(`${BASE}/api/sim/pool?roundId=${encodeURIComponent(up.roundId)}`);
  if (!pool.ok) {
    throw new Error(`Pool check failed: ${pool.status}`);
  }

  const [r1, r2] = await Promise.all([
    fetchJson(`${BASE}/api/sim/results?wallet=${encodeURIComponent(up.wallet)}`),
    fetchJson(`${BASE}/api/sim/results?wallet=${encodeURIComponent(down.wallet)}`)
  ]);
  if (!r1.ok || !r2.ok) {
    throw new Error(`Results check failed: ${r1.status}/${r2.status}`);
  }

  const upRound = (r1.json?.rounds ?? []).find((x) => x.roundId === up.roundId && x.entrySignature === up.payload.id);
  const downRound = (r2.json?.rounds ?? []).find((x) => x.roundId === down.roundId && x.entrySignature === down.payload.id);
  if (!upRound || !downRound) {
    throw new Error("Result round lookup failed after successful joins");
  }

  const summary = {
    ok: true,
    base: BASE,
    market: MARKET,
    roundId: up.roundId,
    joins: { up: joinUp.status, down: joinDown.status },
    pool: pool.json?.stats ?? null,
    statuses: {
      up: upRound.status,
      down: downRound.status
    }
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});

import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { addSimEntry } from "@/lib/sim-ledger";
import { MARKET_CONFIGS } from "@/lib/oracle";
import { checkRateLimit, getClientIp, rateLimitExceededResponse } from "@/lib/api-guards";

export const runtime = "nodejs";

const OPEN_ENTRY_SECONDS = 60;
const LOCK_SECONDS = 60;
const ENTRY_CYCLE_SECONDS = OPEN_ENTRY_SECONDS + LOCK_SECONDS;
const SETTLEMENT_DURATION_SECONDS = 5 * 60;
const ALLOWED_DIRECTIONS = new Set(["UP", "DOWN"]);
const ALLOWED_MARKETS = new Set(MARKET_CONFIGS.map((market) => market.key));
const FEED_BY_MARKET = new Map(MARKET_CONFIGS.map((market) => [market.key, market.feedId]));
const ALLOWED_STAKES = new Set([5, 10, 25, 50, 100, 250]);
const MAX_ENTRY_ID_LEN = 128;

export async function POST(req: Request) {
  try {
    if (process.env.PANCHO_PAUSE_JOINS === "on") {
      return NextResponse.json({ error: "Joins are temporarily paused." }, { status: 503 });
    }

    const ip = getClientIp(req);
    const ipRate = checkRateLimit({
      key: `sim-entries:ip:${ip}`,
      // Shared home/mobile IPs can have multiple legit players; keep this generous by default.
      limit: Number(process.env.PANCHO_RL_SIM_ENTRIES_IP_LIMIT ?? 150),
      windowMs: Number(process.env.PANCHO_RL_SIM_ENTRIES_IP_WINDOW_MS ?? 10_000)
    });
    if (!ipRate.ok) {
      return rateLimitExceededResponse(ipRate.retryAfterSec, "Too many join attempts from this IP.");
    }

    const body = (await req.json()) as {
      id: string;
      roundId: string;
      market: string;
      feedId: string;
      roundStartMs: number;
      roundEndMs: number;
      wallet: string;
      direction: "UP" | "DOWN";
      stakeBucks: number;
      joinedAtMs: number;
    };

    if (
      !body.id ||
      !body.roundId ||
      !body.market ||
      !body.feedId ||
      !body.wallet ||
      !body.direction ||
      !Number.isFinite(body.roundStartMs) ||
      !Number.isFinite(body.roundEndMs) ||
      !Number.isInteger(body.roundStartMs) ||
      !Number.isInteger(body.roundEndMs) ||
      !Number.isFinite(body.stakeBucks) ||
      !Number.isFinite(body.joinedAtMs)
    ) {
      return NextResponse.json({ error: "Invalid sim entry payload" }, { status: 400 });
    }

    if (body.id.length > MAX_ENTRY_ID_LEN) {
      return NextResponse.json({ error: "Entry id too long." }, { status: 400 });
    }

    if (!ALLOWED_DIRECTIONS.has(body.direction)) {
      return NextResponse.json({ error: "Invalid direction." }, { status: 400 });
    }

    if (!ALLOWED_MARKETS.has(body.market)) {
      return NextResponse.json({ error: "Invalid market." }, { status: 400 });
    }

    const expectedFeedId = FEED_BY_MARKET.get(body.market);
    if (!expectedFeedId || body.feedId !== expectedFeedId) {
      return NextResponse.json({ error: "Invalid oracle feed for selected market." }, { status: 400 });
    }

    if (!ALLOWED_STAKES.has(body.stakeBucks)) {
      return NextResponse.json({ error: "Invalid Pancho Bucks tier." }, { status: 400 });
    }

    const expectedRoundId = `${body.market}-${Math.floor(body.roundStartMs / 1000)}-5m`;
    if (body.roundId !== expectedRoundId) {
      return NextResponse.json({ error: "Round ID does not match round start." }, { status: 400 });
    }
    if (body.roundStartMs % (ENTRY_CYCLE_SECONDS * 1000) !== 0) {
      return NextResponse.json({ error: "Round start is not aligned to cycle boundary." }, { status: 400 });
    }
    const expectedRoundEndMs = body.roundStartMs + (OPEN_ENTRY_SECONDS + SETTLEMENT_DURATION_SECONDS) * 1000;
    if (body.roundEndMs !== expectedRoundEndMs) {
      return NextResponse.json({ error: "Round end does not match configured duration." }, { status: 400 });
    }

    const nowMs = Date.now();
    const lockMs = body.roundStartMs + OPEN_ENTRY_SECONDS * 1000;
    const nowInOpenWindow = nowMs >= body.roundStartMs && nowMs < lockMs;

    if (!nowInOpenWindow) {
      return NextResponse.json({ error: "Sim round is not open right now." }, { status: 400 });
    }

    try {
      new PublicKey(body.wallet);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    const walletRate = checkRateLimit({
      key: `sim-entries:wallet:${body.wallet}`,
      limit: Number(process.env.PANCHO_RL_SIM_ENTRIES_WALLET_LIMIT ?? 20),
      windowMs: Number(process.env.PANCHO_RL_SIM_ENTRIES_WALLET_WINDOW_MS ?? 10_000)
    });
    if (!walletRate.ok) {
      return rateLimitExceededResponse(walletRate.retryAfterSec, "Too many join attempts from this wallet.");
    }

    const result = await addSimEntry({
      id: body.id,
      roundId: body.roundId,
      market: body.market,
      feedId: body.feedId,
      roundStartMs: body.roundStartMs,
      roundEndMs: body.roundEndMs,
      wallet: body.wallet,
      direction: body.direction,
      stakeBucks: body.stakeBucks,
      // Use server receive time as the source of truth to avoid client clock skew issues.
      joinedAtMs: nowMs
    });

    return NextResponse.json({ ok: true, created: result.created });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sim entries error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

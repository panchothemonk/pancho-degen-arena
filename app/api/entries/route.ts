import { NextResponse } from "next/server";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import {
  addLedgerEntry,
  countRecentJoinAttempts,
  hasLedgerEntrySignature,
  recordJoinAttempt
} from "@/lib/round-ledger";
import { auditLog } from "@/lib/audit";
import { MARKET_CONFIGS, resolveMarketByKey } from "@/lib/oracle";

export const runtime = "nodejs";
const OPEN_ENTRY_SECONDS = 60;
const LOCK_SECONDS = 60;
const ENTRY_CYCLE_SECONDS = OPEN_ENTRY_SECONDS + LOCK_SECONDS;
const SETTLEMENT_DURATION_SECONDS = 5 * 60;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const MAX_ATTEMPTS_PER_WALLET_PER_WINDOW = 12;
const MAX_ATTEMPTS_PER_IP_PER_WINDOW = 30;
const MIN_STAKE_USD = 1;
const MAX_STAKE_USD = 5000;
const MAX_STAKE_LAMPORTS = 25 * 1_000_000_000;
const ALLOWED_DIRECTIONS = new Set(["UP", "DOWN"]);
const ALLOWED_MARKETS = new Set(MARKET_CONFIGS.map((market) => market.key));
const ALLOWED_STAKES = new Set([5, 10, 25, 50, 100, 250]);

function getClientIp(req: Request): string | null {
  const cfConnectingIp = req.headers.get("cf-connecting-ip");
  if (cfConnectingIp?.trim()) {
    return cfConnectingIp.trim();
  }

  const xForwardedFor = req.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const first = xForwardedFor.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  const realIp = req.headers.get("x-real-ip");
  return realIp?.trim() || null;
}

export async function POST(req: Request) {
  try {
    if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_USE_ONCHAIN_PROGRAM !== "true") {
      return NextResponse.json(
        { error: "Real-money off-chain custody mode is disabled in production. Enable on-chain program mode." },
        { status: 503 }
      );
    }

    const body = (await req.json()) as {
      roundId: string;
      market: string;
      feedId: string;
      roundStartMs: number;
      roundEndMs: number;
      wallet: string;
      direction: "UP" | "DOWN";
      stakeUsd: number;
      stakeLamports: number;
      signature: string;
      joinedAtMs: number;
      startPrice: number;
    };

    if (
      !body.roundId ||
      !body.market ||
      !body.feedId ||
      !body.wallet ||
      !body.direction ||
      !body.signature ||
      !Number.isFinite(body.roundStartMs) ||
      !Number.isFinite(body.roundEndMs) ||
      !Number.isInteger(body.roundStartMs) ||
      !Number.isInteger(body.roundEndMs) ||
      !Number.isFinite(body.stakeUsd) ||
      !Number.isFinite(body.stakeLamports) ||
      !Number.isInteger(body.stakeLamports) ||
      !Number.isFinite(body.startPrice)
    ) {
      await auditLog("WARN", "join.invalid_payload");
      return NextResponse.json({ error: "Invalid entry payload" }, { status: 400 });
    }

    if (!ALLOWED_DIRECTIONS.has(body.direction)) {
      await auditLog("WARN", "join.invalid_direction", { direction: body.direction });
      return NextResponse.json({ error: "Invalid direction." }, { status: 400 });
    }

    if (!ALLOWED_MARKETS.has(body.market)) {
      await auditLog("WARN", "join.invalid_market", { market: body.market });
      return NextResponse.json({ error: "Invalid market." }, { status: 400 });
    }

    if (!ALLOWED_STAKES.has(body.stakeUsd)) {
      await auditLog("WARN", "join.invalid_stake_tier", { stakeUsd: body.stakeUsd });
      return NextResponse.json({ error: "Invalid stake tier." }, { status: 400 });
    }

    if (body.stakeUsd < MIN_STAKE_USD || body.stakeUsd > MAX_STAKE_USD || body.stakeLamports <= 0 || body.stakeLamports > MAX_STAKE_LAMPORTS) {
      await auditLog("WARN", "join.invalid_stake", {
        stakeUsd: body.stakeUsd,
        stakeLamports: body.stakeLamports
      });
      return NextResponse.json({ error: "Stake amount is outside allowed range." }, { status: 400 });
    }

    const expectedRoundId = `${body.market}-${Math.floor(body.roundStartMs / 1000)}-5m`;
    if (body.roundId !== expectedRoundId) {
      await auditLog("WARN", "join.invalid_round_id", { roundId: body.roundId, expectedRoundId });
      return NextResponse.json({ error: "Round ID does not match round start." }, { status: 400 });
    }
    if (body.roundStartMs % (ENTRY_CYCLE_SECONDS * 1000) !== 0) {
      await auditLog("WARN", "join.invalid_round_start", { roundStartMs: body.roundStartMs });
      return NextResponse.json({ error: "Round start is not aligned to cycle boundary." }, { status: 400 });
    }
    const expectedRoundEndMs = body.roundStartMs + (OPEN_ENTRY_SECONDS + SETTLEMENT_DURATION_SECONDS) * 1000;
    if (body.roundEndMs !== expectedRoundEndMs) {
      await auditLog("WARN", "join.invalid_round_end", { roundEndMs: body.roundEndMs, expectedRoundEndMs });
      return NextResponse.json({ error: "Round end does not match configured duration." }, { status: 400 });
    }

    try {
      new PublicKey(body.wallet);
    } catch {
      await auditLog("WARN", "join.invalid_wallet", { wallet: body.wallet });
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    const clientIp = getClientIp(req);
    await recordJoinAttempt(body.wallet, clientIp);
    const rate = await countRecentJoinAttempts({
      wallet: body.wallet,
      ip: clientIp,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS
    });
    if (rate.walletCount > MAX_ATTEMPTS_PER_WALLET_PER_WINDOW || rate.ipCount > MAX_ATTEMPTS_PER_IP_PER_WINDOW) {
      await auditLog("WARN", "join.rate_limited", {
        wallet: body.wallet,
        ip: clientIp,
        walletCount: rate.walletCount,
        ipCount: rate.ipCount
      });
      return NextResponse.json(
        {
          error: "Too many requests. Slow down and try again.",
          limits: {
            windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
            wallet: MAX_ATTEMPTS_PER_WALLET_PER_WINDOW,
            ip: MAX_ATTEMPTS_PER_IP_PER_WINDOW
          }
        },
        { status: 429 }
      );
    }

    const existingSignature = await hasLedgerEntrySignature(body.signature);
    if (existingSignature) {
      await auditLog("WARN", "join.replay_signature", { wallet: body.wallet, signature: body.signature });
      return NextResponse.json({ ok: true, created: false });
    }

    const market = resolveMarketByKey(body.market);
    if (market.feedId !== body.feedId) {
      await auditLog("WARN", "join.market_feed_mismatch", { market: body.market, feedId: body.feedId });
      return NextResponse.json({ error: "Market feed mismatch" }, { status: 400 });
    }

    const escrowAddress = process.env.NEXT_PUBLIC_ESCROW_WALLET ?? process.env.ESCROW_WALLET ?? "Dkm5UeGTaeXDkauBMtNwbHGw7q2aXbrqb9HBQVN5GFx8";
    const connection = new Connection(process.env.SOLANA_RPC_URL ?? clusterApiUrl("devnet"), "confirmed");
    const parsedTx = await connection.getParsedTransaction(body.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });

    if (!parsedTx || parsedTx.meta?.err) {
      await auditLog("WARN", "join.tx_not_confirmed", { wallet: body.wallet, signature: body.signature });
      return NextResponse.json({ error: "Transaction not confirmed onchain" }, { status: 400 });
    }
    if (typeof parsedTx.blockTime !== "number") {
      await auditLog("WARN", "join.tx_missing_blocktime", { wallet: body.wallet, signature: body.signature });
      return NextResponse.json({ error: "Transaction block time unavailable for join-window validation." }, { status: 400 });
    }

    const txMs = parsedTx.blockTime * 1000;
    const lockMs = body.roundStartMs + OPEN_ENTRY_SECONDS * 1000;
    if (txMs < body.roundStartMs || txMs >= lockMs) {
      await auditLog("WARN", "join.tx_outside_open_window", { wallet: body.wallet, signature: body.signature, txMs, roundStartMs: body.roundStartMs, lockMs });
      return NextResponse.json({ error: "Transaction was not submitted during open entry window." }, { status: 400 });
    }

    const transferIx = parsedTx.transaction.message.instructions.find((instruction) => {
      if (!("parsed" in instruction) || !instruction.parsed || !("program" in instruction)) {
        return false;
      }
      if (instruction.program !== "system") {
        return false;
      }
      const parsed = instruction.parsed as { type?: string; info?: { source?: string; destination?: string; lamports?: number } };
      return (
        parsed.type === "transfer" &&
        parsed.info?.source === body.wallet &&
        parsed.info?.destination === escrowAddress &&
        parsed.info?.lamports === Math.floor(body.stakeLamports)
      );
    });

    if (!transferIx) {
      await auditLog("WARN", "join.transfer_mismatch", { wallet: body.wallet, signature: body.signature });
      return NextResponse.json({ error: "Onchain transfer does not match entry payload" }, { status: 400 });
    }

    const expectedMemo = `PANCHO|${body.market}|${body.roundId}|${body.direction}|${body.stakeUsd}`;
    const memoIx = parsedTx.transaction.message.instructions.find((instruction) => {
      if (!("program" in instruction) || instruction.program !== "spl-memo" || !("parsed" in instruction)) {
        return false;
      }
      return instruction.parsed === expectedMemo;
    });

    if (!memoIx) {
      await auditLog("WARN", "join.memo_mismatch", { wallet: body.wallet, signature: body.signature });
      return NextResponse.json({ error: "Onchain memo does not match entry payload" }, { status: 400 });
    }

    const result = await addLedgerEntry({
      roundId: body.roundId,
      market: body.market,
      feedId: body.feedId,
      roundStartMs: body.roundStartMs,
      roundEndMs: body.roundEndMs,
      wallet: body.wallet,
      direction: body.direction,
      stakeUsd: body.stakeUsd,
      stakeLamports: Math.floor(body.stakeLamports),
      signature: body.signature,
      joinedAtMs: body.joinedAtMs || Date.now(),
      startPrice: 0,
      clientIp: clientIp ?? undefined
    });

    await auditLog("INFO", "join.accepted", {
      roundId: body.roundId,
      market: body.market,
      wallet: body.wallet,
      signature: body.signature,
      created: result.created
    });

    return NextResponse.json({ ok: true, created: result.created });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown entries error";
    await auditLog("ERROR", "join.unhandled_error", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

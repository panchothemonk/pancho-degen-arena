import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { checkRateLimit, getClientIp, rateLimitExceededResponse } from "@/lib/api-guards";
import { settleSimRoundOnce, type SimRoundSettlementSnapshot } from "@/lib/sim-settlement";
import { readSimRoundSettlement, readSimWalletEntries, type SimEntry } from "@/lib/sim-ledger";

export const runtime = "nodejs";

const LAG_ALERT_COOLDOWN_MS = 60_000;
let lastLagAlertMs = 0;

async function buildWalletResults(wallet: string, walletEntries: SimEntry[], pauseSettlement: boolean) {
  const entriesByRound = new Map<string, SimEntry[]>();
  for (const entry of walletEntries) {
    const current = entriesByRound.get(entry.roundId) ?? [];
    current.push(entry);
    entriesByRound.set(entry.roundId, current);
  }

  const nowMs = Date.now();
  const settledByRound = new Map<string, SimRoundSettlementSnapshot>();

  for (const [roundId, userEntriesInRound] of entriesByRound) {
    const endMs = userEntriesInRound[0]?.roundEndMs ?? 0;
    if (endMs > nowMs) {
      continue;
    }

    const persisted = await readSimRoundSettlement(roundId);
    if (persisted) {
      settledByRound.set(roundId, {
        settlement: persisted.settlement,
        payoutsByEntryId: persisted.payoutsByEntryId,
        feeCents: persisted.feeCents,
        settledAtMs: persisted.settledAtMs
      });
      continue;
    }

    if (!pauseSettlement) {
      const settled = await settleSimRoundOnce(roundId);
      if (settled) {
        settledByRound.set(roundId, settled);
      }
    }
  }

  if (pauseSettlement) {
    const overdue = [...entriesByRound.values()]
      .map((group) => group[0])
      .filter((entry) => entry && entry.roundEndMs <= nowMs && !settledByRound.has(entry.roundId))
      .map((entry) => nowMs - entry.roundEndMs);
    const maxLagMs = overdue.length > 0 ? Math.max(...overdue) : 0;
    const lagThresholdMs = Number(process.env.PANCHO_ALERT_SETTLEMENT_LAG_MS ?? 120_000);
    if (maxLagMs >= lagThresholdMs && nowMs - lastLagAlertMs >= LAG_ALERT_COOLDOWN_MS) {
      lastLagAlertMs = nowMs;
      await auditLog("WARN", "sim_results.settlement_lag_detected", {
        wallet,
        overdueRounds: overdue.length,
        maxLagMs
      });
    }
  }

  const rounds = walletEntries
    .map((entry) => {
      const settled = settledByRound.get(entry.roundId);
      const stakeCents = Math.round(entry.stakeBucks * 100);
      const payoutCents = settled?.payoutsByEntryId.get(entry.id) ?? 0;
      const settlement = settled?.settlement ?? null;

      let status: "PENDING" | "WIN" | "LOSS" | "REFUND" = "PENDING";
      if (settlement) {
        if (settlement.mode === "REFUND") {
          status = "REFUND";
        } else {
          status = settlement.winnerSide === entry.direction ? "WIN" : "LOSS";
        }
      }

      return {
        roundId: entry.roundId,
        roundStartMs: entry.roundStartMs,
        roundEndMs: entry.roundEndMs,
        joinedAtMs: entry.joinedAtMs,
        direction: entry.direction,
        entrySignature: entry.id,
        stakeLamports: stakeCents,
        stakeUsd: entry.stakeBucks,
        status,
        payoutLamports: payoutCents,
        payoutSignatures: [],
        pnlLamports: settlement ? payoutCents - stakeCents : null,
        settlement: settlement
          ? {
              mode: settlement.mode,
              winnerSide: settlement.winnerSide,
              startPrice: settlement.startPrice,
              endPrice: settlement.endPrice,
              settledAtMs: settled?.settledAtMs ?? entry.roundEndMs
            }
          : null
      };
    })
    .sort((a, b) => b.joinedAtMs - a.joinedAtMs);

  const settledRounds = rounds.filter((round) => round.status !== "PENDING");
  const totals = {
    stakedLamports: rounds.reduce((sum, round) => sum + round.stakeLamports, 0),
    paidLamports: settledRounds.reduce((sum, round) => sum + round.payoutLamports, 0),
    pnlLamports: settledRounds.reduce((sum, round) => sum + (round.pnlLamports ?? 0), 0)
  };

  return {
    wallet,
    rounds,
    totals,
    mode: "SIM" as const,
    unit: "PANCHO_BUCKS" as const
  };
}

export async function GET(req: Request) {
  try {
    const ip = getClientIp(req);
    const ipRate = await checkRateLimit({
      key: `sim-results:ip:${ip}`,
      limit: Number(process.env.PANCHO_RL_SIM_RESULTS_IP_LIMIT ?? 80),
      windowMs: Number(process.env.PANCHO_RL_SIM_RESULTS_IP_WINDOW_MS ?? 10_000)
    });
    if (!ipRate.ok) {
      return rateLimitExceededResponse(ipRate.retryAfterSec, "Too many results requests from this IP.");
    }

    const url = new URL(req.url);
    const wallet = url.searchParams.get("wallet");
    if (!wallet) {
      return NextResponse.json({ error: "Missing wallet query parameter" }, { status: 400 });
    }

    try {
      new PublicKey(wallet);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    const walletRate = await checkRateLimit({
      key: `sim-results:wallet:${wallet}`,
      limit: Number(process.env.PANCHO_RL_SIM_RESULTS_WALLET_LIMIT ?? 30),
      windowMs: Number(process.env.PANCHO_RL_SIM_RESULTS_WALLET_WINDOW_MS ?? 10_000)
    });
    if (!walletRate.ok) {
      return rateLimitExceededResponse(walletRate.retryAfterSec, "Too many results requests for this wallet.");
    }

    const walletEntries = await readSimWalletEntries(wallet);
    const payload = await buildWalletResults(wallet, walletEntries, process.env.PANCHO_PAUSE_SIM_SETTLEMENTS === "on");
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sim results error";
    await auditLog("ERROR", "sim_results.unhandled_error", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

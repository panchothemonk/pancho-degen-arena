import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp, rateLimitExceededResponse } from "@/lib/api-guards";
import { readSimLedger, readSimRoundSettlement } from "@/lib/sim-ledger";
import { safeHeaderSecretMatch } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const DUE_SCAN_LIMIT = Number(process.env.PANCHO_OPS_SUMMARY_DUE_SCAN_LIMIT ?? 400);
const ENTRIES_BREAKDOWN_LIMIT = Number(process.env.PANCHO_OPS_SUMMARY_ENTRIES_LIMIT ?? 10_000);

function isAuthorized(req: Request): boolean {
  const key = process.env.OPS_API_KEY;
  if (!key) {
    return process.env.NODE_ENV !== "production";
  }
  return safeHeaderSecretMatch(key, req.headers.get("x-ops-key"));
}

function distinctRecentRoundIds(entries: Awaited<ReturnType<typeof readSimLedger>>["entries"], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.roundId)) continue;
    seen.add(entry.roundId);
    out.push(entry.roundId);
    if (out.length >= limit) break;
  }
  return out;
}

function distinctDueRounds(
  entries: Awaited<ReturnType<typeof readSimLedger>>["entries"],
  nowMs: number,
  limit: number
): Array<{ roundId: string; roundEndMs: number }> {
  const out: Array<{ roundId: string; roundEndMs: number }> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.roundEndMs > nowMs) continue;
    if (seen.has(entry.roundId)) continue;
    seen.add(entry.roundId);
    out.push({ roundId: entry.roundId, roundEndMs: entry.roundEndMs });
    if (out.length >= limit) break;
  }
  return out;
}

export async function GET(req: Request) {
  try {
    const ip = getClientIp(req);
    const ipRate = checkRateLimit({
      key: `ops-summary:ip:${ip}`,
      limit: Number(process.env.PANCHO_RL_OPS_SUMMARY_IP_LIMIT ?? 30),
      windowMs: Number(process.env.PANCHO_RL_OPS_SUMMARY_IP_WINDOW_MS ?? 10_000)
    });
    if (!ipRate.ok) {
      return rateLimitExceededResponse(ipRate.retryAfterSec, "Ops summary is rate-limited. Retry shortly.");
    }

    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const recentLimit = Math.max(10, Math.min(120, Number(url.searchParams.get("limit") ?? 40)));
    const nowMs = Date.now();
    const ledger = await readSimLedger();
    const recentRoundIds = distinctRecentRoundIds(ledger.entries, recentLimit);
    const settlements = await Promise.all(recentRoundIds.map((roundId) => readSimRoundSettlement(roundId)));
    const settlementByRoundId = new Map<string, Awaited<ReturnType<typeof readSimRoundSettlement>>>(
      recentRoundIds.map((roundId, index) => [roundId, settlements[index] ?? null])
    );

    let pendingDueRounds = 0;
    let maxSettlementLagMs = 0;
    const dueRounds = distinctDueRounds(ledger.entries, nowMs, DUE_SCAN_LIMIT);
    const dueChecks = await Promise.all(
      dueRounds.map(async (due) => ({
        due,
        settled: settlementByRoundId.get(due.roundId) ?? (await readSimRoundSettlement(due.roundId))
      }))
    );

    for (const check of dueChecks) {
      const settled = check.settled;
      if (!settled) {
        pendingDueRounds += 1;
        maxSettlementLagMs = Math.max(maxSettlementLagMs, nowMs - check.due.roundEndMs);
      }
    }

    const marketBreakdown: Record<string, { entries: number; stakeBucks: number }> = {};
    for (const entry of ledger.entries.slice(0, ENTRIES_BREAKDOWN_LIMIT)) {
      const current = marketBreakdown[entry.market] ?? { entries: 0, stakeBucks: 0 };
      current.entries += 1;
      current.stakeBucks += Number(entry.stakeBucks);
      marketBreakdown[entry.market] = current;
    }

    const recentSettlements = settlements
      .map((item, idx) => {
        if (!item) return null;
        return {
          roundId: recentRoundIds[idx],
          mode: item.settlement.mode,
          winnerSide: item.settlement.winnerSide ?? null,
          startPrice: item.settlement.startPrice,
          endPrice: item.settlement.endPrice,
          feeCents: item.feeCents,
          settledAtMs: item.settledAtMs
        };
      })
      .filter(Boolean)
      .slice(0, recentLimit);

    const response = {
      ok: true,
      nowMs,
      totals: {
        entries: ledger.entries.length,
        distinctRoundsInLedger: new Set(ledger.entries.map((entry) => entry.roundId)).size,
        pendingDueRounds,
        maxSettlementLagMs
      },
      marketBreakdown,
      recentSettlements
    };

    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown ops summary error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

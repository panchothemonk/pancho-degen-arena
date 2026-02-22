import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp, rateLimitExceededResponse } from "@/lib/api-guards";
import { readSimLedger, readSimRoundSettlement } from "@/lib/sim-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PublicStatus = {
  ok: boolean;
  status: "ok" | "degraded" | "paused";
  joinsPaused: boolean;
  settlementPaused: boolean;
  pendingDueRounds: number;
  maxSettlementLagMs: number;
  updatedAtMs: number;
};

const STATUS_CACHE_MS = Number(process.env.PANCHO_STATUS_CACHE_MS ?? 8_000);
const DUE_SCAN_LIMIT = Number(process.env.PANCHO_STATUS_DUE_SCAN_LIMIT ?? 300);
let cachedStatus: { atMs: number; data: PublicStatus } | null = null;

function flags() {
  return {
    joinsPaused: process.env.PANCHO_PAUSE_JOINS === "on",
    settlementPaused: process.env.PANCHO_PAUSE_SIM_SETTLEMENTS === "on"
  };
}

function buildDueRoundIds(entries: Awaited<ReturnType<typeof readSimLedger>>["entries"], nowMs: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.roundEndMs > nowMs) continue;
    if (seen.has(entry.roundId)) continue;
    seen.add(entry.roundId);
    out.push(entry.roundId);
    if (out.length >= DUE_SCAN_LIMIT) break;
  }
  return out;
}

async function computeStatus(): Promise<PublicStatus> {
  const nowMs = Date.now();
  const { joinsPaused, settlementPaused } = flags();
  const ledger = await readSimLedger();
  const dueRoundIds = buildDueRoundIds(ledger.entries, nowMs);

  let pendingDueRounds = 0;
  let maxSettlementLagMs = 0;
  if (dueRoundIds.length > 0) {
    const settlementRows = await Promise.all(dueRoundIds.map((roundId) => readSimRoundSettlement(roundId)));
    for (let i = 0; i < dueRoundIds.length; i++) {
      if (settlementRows[i]) continue;
      pendingDueRounds += 1;
      const roundId = dueRoundIds[i];
      const roundEndMs = ledger.entries.find((entry) => entry.roundId === roundId)?.roundEndMs ?? nowMs;
      maxSettlementLagMs = Math.max(maxSettlementLagMs, nowMs - roundEndMs);
    }
  }

  const status: PublicStatus["status"] =
    joinsPaused || settlementPaused ? "paused" : pendingDueRounds > 0 ? "degraded" : "ok";

  return {
    ok: status === "ok",
    status,
    joinsPaused,
    settlementPaused,
    pendingDueRounds,
    maxSettlementLagMs,
    updatedAtMs: nowMs
  };
}

export async function GET(req: Request) {
  try {
    const ip = getClientIp(req);
    const rate = await checkRateLimit({
      key: `status:ip:${ip}`,
      limit: Number(process.env.PANCHO_RL_STATUS_IP_LIMIT ?? 80),
      windowMs: Number(process.env.PANCHO_RL_STATUS_IP_WINDOW_MS ?? 10_000)
    });
    if (!rate.ok) {
      return rateLimitExceededResponse(rate.retryAfterSec, "Status endpoint is rate-limited. Retry shortly.");
    }

    const nowMs = Date.now();
    if (cachedStatus && nowMs - cachedStatus.atMs < STATUS_CACHE_MS) {
      return NextResponse.json(cachedStatus.data, {
        headers: { "Cache-Control": "no-store" }
      });
    }

    const status = await computeStatus();
    cachedStatus = { atMs: nowMs, data: status };
    return NextResponse.json(status, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch {
    const { joinsPaused, settlementPaused } = flags();
    return NextResponse.json(
      {
        ok: false,
        status: "degraded",
        joinsPaused,
        settlementPaused,
        pendingDueRounds: -1,
        maxSettlementLagMs: -1,
        updatedAtMs: Date.now()
      } satisfies PublicStatus,
      {
        status: 200,
        headers: { "Cache-Control": "no-store" }
      }
    );
  }
}

import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp, rateLimitExceededResponse } from "@/lib/api-guards";
import { readSimLedger, readSimRoundSettlement } from "@/lib/sim-ledger";
import { auditLog } from "@/lib/audit";

export const runtime = "nodejs";

const ALERT_COOLDOWN_MS = 60_000;
let lastOpsAlertMs = 0;
const DUE_SCAN_LIMIT = Number(process.env.PANCHO_OPS_HEALTH_DUE_SCAN_LIMIT ?? 500);

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

function isAuthorized(req: Request): boolean {
  const key = process.env.OPS_API_KEY;
  if (!key) {
    return process.env.NODE_ENV !== "production";
  }
  return req.headers.get("x-ops-key") === key;
}

export async function GET(req: Request) {
  try {
    const ip = getClientIp(req);
    const ipRate = checkRateLimit({
      key: `ops-health:ip:${ip}`,
      limit: Number(process.env.PANCHO_RL_OPS_HEALTH_IP_LIMIT ?? 50),
      windowMs: Number(process.env.PANCHO_RL_OPS_HEALTH_IP_WINDOW_MS ?? 10_000)
    });
    if (!ipRate.ok) {
      return rateLimitExceededResponse(ipRate.retryAfterSec, "Ops health is rate-limited. Retry shortly.");
    }

    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const nowMs = Date.now();
    const ledger = await readSimLedger();
    const dueRounds = distinctDueRounds(ledger.entries, nowMs, DUE_SCAN_LIMIT);
    const settlements = await Promise.all(dueRounds.map((due) => readSimRoundSettlement(due.roundId)));

    let pendingDueRounds = 0;
    let maxSettlementLagMs = 0;
    for (let i = 0; i < dueRounds.length; i += 1) {
      const settled = settlements[i];
      if (!settled) {
        pendingDueRounds += 1;
        maxSettlementLagMs = Math.max(maxSettlementLagMs, nowMs - dueRounds[i].roundEndMs);
      }
    }

    const status = pendingDueRounds > 0 ? "degraded" : "ok";
    const warnPendingThreshold = Number(process.env.PANCHO_ALERT_PENDING_DUE_ROUNDS ?? 25);
    const warnLagThresholdMs = Number(process.env.PANCHO_ALERT_SETTLEMENT_LAG_MS ?? 120_000);

    if (
      (pendingDueRounds >= warnPendingThreshold || maxSettlementLagMs >= warnLagThresholdMs) &&
      nowMs - lastOpsAlertMs >= ALERT_COOLDOWN_MS
    ) {
      lastOpsAlertMs = nowMs;
      await auditLog("WARN", "ops.health_settlement_alert", {
        pendingDueRounds,
        maxSettlementLagMs,
        dueRoundCount: dueRounds.length
      });
    }

    return NextResponse.json({
      ok: status === "ok",
      status,
      nowMs,
      totals: {
        entries: ledger.entries.length,
        dueRoundCount: dueRounds.length,
        pendingDueRounds
      },
      settlement: {
        maxSettlementLagMs
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown ops health error";
    await auditLog("ERROR", "ops.health_unhandled_error", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

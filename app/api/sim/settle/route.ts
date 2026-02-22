import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { safeHeaderSecretMatch } from "@/lib/auth";
import { settleDueSimRounds } from "@/lib/sim-settlement";

export const runtime = "nodejs";

function isAuthorized(req: Request): boolean {
  return safeHeaderSecretMatch(process.env.SIM_SETTLE_API_KEY, req.headers.get("x-sim-settle-key"));
}

export async function POST(req: Request) {
  try {
    if (process.env.PANCHO_PAUSE_SIM_SETTLEMENTS === "on") {
      await auditLog("WARN", "sim_settle.paused_by_flag");
      return NextResponse.json({ error: "Sim settlements are paused." }, { status: 503 });
    }

    if (!isAuthorized(req)) {
      await auditLog("WARN", "sim_settle.unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const limit = Number(process.env.PANCHO_SIM_SETTLE_LIMIT ?? 300);
    const result = await settleDueSimRounds(limit);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sim settle error";
    await auditLog("ERROR", "sim_settle.unhandled_error", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

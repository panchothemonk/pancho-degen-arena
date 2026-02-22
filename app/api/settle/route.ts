import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { settleDueRounds } from "@/lib/settlement";
import { auditLog } from "@/lib/audit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (process.env.PANCHO_PAUSE_SETTLE_API === "on") {
    await auditLog("WARN", "settle.paused_by_flag");
    return NextResponse.json({ error: "Settlement is temporarily paused." }, { status: 503 });
  }

  const requiredKey = process.env.SETTLE_API_KEY;
  if (!requiredKey) {
    await auditLog("ERROR", "settle.misconfigured_missing_key");
    return NextResponse.json({ error: "Settlement API key is not configured." }, { status: 503 });
  }

  const providedKey = req.headers.get("x-settle-key");
  if (!providedKey) {
    await auditLog("WARN", "settle.missing_key");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const expectedBuffer = Buffer.from(requiredKey, "utf8");
  const providedBuffer = Buffer.from(providedKey, "utf8");
  const valid =
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer);
  if (!valid) {
    await auditLog("WARN", "settle.unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const settled = await settleDueRounds();
    await auditLog("INFO", "settle.triggered", { settledCount: settled.length });
    return NextResponse.json({ ok: true, settled });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown settle error";
    await auditLog("ERROR", "settle.unhandled_error", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

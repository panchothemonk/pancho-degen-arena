import { NextResponse } from "next/server";
import { readSimRoundPoolStats } from "@/lib/sim-ledger";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const roundId = url.searchParams.get("roundId");
    if (!roundId) {
      return NextResponse.json({ error: "Missing roundId query parameter" }, { status: 400 });
    }

    const stats = await readSimRoundPoolStats(roundId);
    return NextResponse.json({
      roundId,
      stats: stats ?? {
        roundId,
        market: "",
        totalBucks: 0,
        upBucks: 0,
        downBucks: 0,
        players: 0,
        entries: 0
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sim pool error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


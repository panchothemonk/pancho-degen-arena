import { NextResponse } from "next/server";
import { fetchOracleSnapshot, getCachedOracleSnapshot } from "@/lib/oracle";
import { checkRateLimit, getClientIp, rateLimitExceededResponse } from "@/lib/api-guards";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const ip = getClientIp(req);
    const rate = checkRateLimit({
      key: `oracle:ip:${ip}`,
      limit: Number(process.env.PANCHO_RL_ORACLE_IP_LIMIT ?? 100),
      windowMs: Number(process.env.PANCHO_RL_ORACLE_IP_WINDOW_MS ?? 10_000)
    });
    if (!rate.ok) {
      return rateLimitExceededResponse(rate.retryAfterSec, "Oracle feed is rate-limited. Try again.");
    }

    const { searchParams } = new URL(req.url);
    const market = searchParams.get("market");
    const snapshot = await fetchOracleSnapshot(market);

    return NextResponse.json(snapshot, {
      headers: {
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown oracle error";
    const { searchParams } = new URL(req.url);
    const market = searchParams.get("market");
    const fallback = getCachedOracleSnapshot(market);
    if (fallback) {
      return NextResponse.json(
        {
          ...fallback,
          warning: `${message}; served cached oracle snapshot`
        },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Pancho-Oracle-Stale": "1"
          }
        }
      );
    }

    return NextResponse.json(
      {
        error: message
      },
      {
        status: 500
      }
    );
  }
}

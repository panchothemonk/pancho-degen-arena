import { NextResponse } from "next/server";

type RateWindow = {
  count: number;
  resetAtMs: number;
};

const buckets = new Map<string, RateWindow>();
const SWEEP_INTERVAL_MS = 60_000;
let lastSweepMs = 0;

function sweepExpired(nowMs: number): void {
  if (nowMs - lastSweepMs < SWEEP_INTERVAL_MS) {
    return;
  }
  lastSweepMs = nowMs;
  for (const [key, value] of buckets.entries()) {
    if (value.resetAtMs <= nowMs) {
      buckets.delete(key);
    }
  }
}

export function getClientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) {
    return cf;
  }
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) {
    return real;
  }
  return "unknown";
}

export function checkRateLimit(params: {
  key: string;
  limit: number;
  windowMs: number;
  nowMs?: number;
}): { ok: true } | { ok: false; retryAfterSec: number } {
  const nowMs = params.nowMs ?? Date.now();
  sweepExpired(nowMs);

  const current = buckets.get(params.key);
  if (!current || current.resetAtMs <= nowMs) {
    buckets.set(params.key, { count: 1, resetAtMs: nowMs + params.windowMs });
    return { ok: true };
  }

  if (current.count >= params.limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((current.resetAtMs - nowMs) / 1000)) };
  }

  current.count += 1;
  buckets.set(params.key, current);
  return { ok: true };
}

export function rateLimitExceededResponse(retryAfterSec: number, message = "Too many requests") {
  return NextResponse.json(
    { error: message, retryAfterSec },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSec)
      }
    }
  );
}

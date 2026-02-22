import { NextResponse } from "next/server";
import { consumeSharedRateLimit } from "@/lib/rate-limit-store";

export function getClientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) {
    return cf;
  }
  if (process.env.NODE_ENV === "production") {
    return "unknown";
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

export async function checkRateLimit(params: {
  key: string;
  limit: number;
  windowMs: number;
  nowMs?: number;
}): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  const nowMs = params.nowMs ?? Date.now();
  return consumeSharedRateLimit({
    key: params.key,
    limit: params.limit,
    windowMs: params.windowMs,
    nowMs
  });
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

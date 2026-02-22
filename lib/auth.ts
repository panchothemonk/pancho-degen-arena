import { timingSafeEqual } from "crypto";

export function safeHeaderSecretMatch(expected: string | undefined, provided: string | null): boolean {
  if (!expected || !provided) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

export type AuditLevel = "INFO" | "WARN" | "ERROR";

export async function auditLog(
  level: AuditLevel,
  event: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    payload
  };

  if (level === "ERROR") {
    console.error(JSON.stringify(entry));
  } else if (level === "WARN") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }

  const webhook = process.env.AUDIT_WEBHOOK_URL;
  if (!webhook) {
    return;
  }

  // Send high-signal events only to external alerting.
  if (level === "INFO") {
    return;
  }

  try {
    await fetch(webhook, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(entry),
      cache: "no-store"
    });
  } catch {
    // Best-effort signal path; ignore failures.
  }
}

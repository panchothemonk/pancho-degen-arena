const base = process.env.OPS_BASE ?? "https://pancho-degen-arena.panchothemonk.workers.dev";
const key = process.env.OPS_API_KEY ?? "";
const lagMsThreshold = Number(process.env.OPS_ALERT_MAX_LAG_MS ?? 180_000);
const pendingThreshold = Number(process.env.OPS_ALERT_PENDING_ROUNDS ?? 3);
const webhook = process.env.OPS_ALERT_WEBHOOK_URL ?? "";

function makeHeaders() {
  const headers = {};
  if (key) headers["x-ops-key"] = key;
  return headers;
}

async function sendWebhook(payload) {
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    // best effort
  }
}

async function fetchJson(path) {
  const res = await fetch(`${base}${path}`, { headers: makeHeaders(), cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function main() {
  const [{ res: healthRes, data: health }, { res: statusRes, data: status }] = await Promise.all([
    fetchJson("/api/ops/health"),
    fetchJson("/api/status")
  ]);

  const problems = [];
  if (!healthRes.ok) {
    problems.push(`ops_health_http_${healthRes.status}`);
  }
  if (!statusRes.ok) {
    problems.push(`public_status_http_${statusRes.status}`);
  }
  if (health?.ok === false || status?.ok === false) {
    problems.push("health_not_ok");
  }
  if ((health?.totals?.pendingDueRounds ?? 0) > pendingThreshold) {
    problems.push("pending_due_rounds_threshold");
  }
  if ((health?.settlement?.maxSettlementLagMs ?? 0) > lagMsThreshold) {
    problems.push("settlement_lag_threshold");
  }

  const payload = {
    ok: problems.length === 0,
    base,
    checkedAt: new Date().toISOString(),
    thresholds: { lagMsThreshold, pendingThreshold },
    problems,
    health: {
      statusCode: healthRes.status,
      data: health
    },
    status: {
      statusCode: statusRes.status,
      data: status
    }
  };

  console.log(JSON.stringify(payload, null, 2));
  if (problems.length > 0) {
    await sendWebhook(payload);
    process.exit(1);
  }
}

main().catch(async (error) => {
  const payload = {
    ok: false,
    base,
    checkedAt: new Date().toISOString(),
    problems: ["unhandled_error"],
    error: error instanceof Error ? error.message : String(error ?? "unknown error")
  };
  console.log(JSON.stringify(payload, null, 2));
  await sendWebhook(payload);
  process.exit(1);
});

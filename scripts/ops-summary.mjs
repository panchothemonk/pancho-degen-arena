const base = process.env.OPS_BASE ?? "https://pancho-degen-arena.panchothemonk.workers.dev";
const key = process.env.OPS_API_KEY ?? "";
const limit = Number(process.env.OPS_SUMMARY_LIMIT ?? 40);

async function main() {
  const headers = {};
  if (key) {
    headers["x-ops-key"] = key;
  }

  const res = await fetch(`${base}/api/ops/summary?limit=${Math.max(10, Math.min(120, limit))}`, {
    headers,
    cache: "no-store"
  });
  const data = await res.json().catch(() => ({}));
  console.log(JSON.stringify({ ok: res.ok, statusCode: res.status, base, summary: data }, null, 2));
  if (!res.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error ?? "unknown ops summary error");
  console.error(JSON.stringify({ ok: false, base, error: message }, null, 2));
  process.exit(1);
});

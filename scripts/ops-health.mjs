const base = process.env.OPS_BASE ?? "https://pancho-degen-arena.panchothemonk.workers.dev";
const key = process.env.OPS_API_KEY ?? "";

async function main() {
  const headers = {};
  if (key) {
    headers["x-ops-key"] = key;
  }

  const res = await fetch(`${base}/api/ops/health`, { headers, cache: "no-store" });
  const data = await res.json().catch(() => ({}));

  const output = {
    ok: res.ok && Boolean(data.ok),
    statusCode: res.status,
    base,
    health: data
  };

  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error ?? "unknown ops health error");
  console.error(JSON.stringify({ ok: false, base, error: message }, null, 2));
  process.exit(1);
});

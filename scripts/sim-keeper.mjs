const baseUrl = process.env.SIM_KEEPER_BASE_URL ?? 'https://pancho-degen-arena.panchothemonk.workers.dev';
const key = process.env.SIM_SETTLE_API_KEY;
const intervalMs = Number(process.env.SIM_KEEPER_INTERVAL_MS ?? 5000);

if (!key) {
  console.error('[sim-keeper] missing SIM_SETTLE_API_KEY');
  process.exit(1);
}

async function tick() {
  try {
    const res = await fetch(`${baseUrl}/api/sim/settle`, {
      method: 'POST',
      headers: {
        'x-sim-settle-key': key
      }
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[sim-keeper] ${new Date().toISOString()} ERROR`, data);
      return;
    }

    if ((data.settled ?? 0) > 0) {
      console.log(
        `[sim-keeper] ${new Date().toISOString()} settled=${data.settled} checked=${data.checked} rounds=${(data.rounds ?? []).length}`
      );
    }
  } catch (error) {
    console.error(`[sim-keeper] ${new Date().toISOString()} request failed`, error);
  }
}

console.log(`[sim-keeper] started -> ${baseUrl}/api/sim/settle every ${intervalMs}ms`);
await tick();
setInterval(tick, intervalMs);

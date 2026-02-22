const baseUrl = process.env.KEEPER_BASE_URL ?? 'http://localhost:3000';
const intervalMs = Number(process.env.KEEPER_INTERVAL_MS ?? 7000);
const key = process.env.SETTLE_API_KEY;

if (!key) {
  console.error('Missing SETTLE_API_KEY in environment.');
  process.exit(1);
}

async function tick() {
  try {
    const res = await fetch(`${baseUrl}/api/settle`, {
      method: 'POST',
      headers: {
        'x-settle-key': key
      }
    });

    const data = await res.json();
    if (!res.ok) {
      console.error(`[keeper] ${new Date().toISOString()} ERROR`, data);
      return;
    }

    const settled = Array.isArray(data.settled) ? data.settled.length : 0;
    if (settled > 0) {
      console.log(`[keeper] ${new Date().toISOString()} settled ${settled} round(s)`);
    }
  } catch (error) {
    console.error(`[keeper] ${new Date().toISOString()} request failed`, error);
  }
}

console.log(`[keeper] started -> ${baseUrl}/api/settle every ${intervalMs}ms`);
await tick();
setInterval(tick, intervalMs);

import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

const RPC = process.env.PANCHO_DEVNET_RPC ?? "https://api.devnet.solana.com";
const TARGET = new PublicKey(process.env.PANCHO_DEVNET_TARGET ?? "AhMGeiHah6mCTU2DMEHwYDyGDoAZSXp7zzYhMjkdwdbF");
const GOAL_SOL = Number(process.env.PANCHO_DEVNET_GOAL_SOL ?? 5);
const PER_ATTEMPT_SOL = Number(process.env.PANCHO_DEVNET_PER_ATTEMPT_SOL ?? 1);

const MIN_DELAY_MS = 15_000;
const MAX_DELAY_MS = 10 * 60_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function jitter(ms) {
  const spread = Math.floor(ms * 0.25);
  const delta = Math.floor(Math.random() * (spread * 2 + 1)) - spread;
  return Math.max(0, ms + delta);
}

function ts() {
  return new Date().toISOString();
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  console.log(`[faucet-watch] rpc=${RPC}`);
  console.log(`[faucet-watch] target=${TARGET.toBase58()}`);
  console.log(`[faucet-watch] goal=${GOAL_SOL} SOL (per-attempt ${PER_ATTEMPT_SOL} SOL)`);

  let delay = MIN_DELAY_MS;
  for (;;) {
    const lamports = await connection.getBalance(TARGET, "confirmed");
    const sol = lamports / LAMPORTS_PER_SOL;
    console.log(`[${ts()}] balance=${sol.toFixed(9)} SOL`);
    if (sol >= GOAL_SOL) {
      console.log(`[${ts()}] goal reached`);
      return;
    }

    try {
      console.log(`[${ts()}] requesting airdrop ${PER_ATTEMPT_SOL} SOL...`);
      const sig = await connection.requestAirdrop(TARGET, Math.round(PER_ATTEMPT_SOL * LAMPORTS_PER_SOL));
      await connection.confirmTransaction(sig, "confirmed");
      console.log(`[${ts()}] airdrop confirmed sig=${sig}`);
      delay = MIN_DELAY_MS;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? "");
      const isRateLimit = /429|Too Many Requests|airdrop limit|faucet has run dry/i.test(msg);
      console.log(`[${ts()}] airdrop failed: ${msg.replaceAll("\n", " ").slice(0, 220)}`);
      delay = clamp(isRateLimit ? delay * 1.6 : delay * 1.2, MIN_DELAY_MS, MAX_DELAY_MS);
    }

    await sleep(jitter(delay));
  }
}

main().catch((err) => {
  console.error(`[faucet-watch] fatal`, err);
  process.exit(1);
});

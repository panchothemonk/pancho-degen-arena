import { spawnSync } from "node:child_process";
import { PublicKey } from "@solana/web3.js";

const base = process.env.OPS_BASE ?? "https://pancho-degen-arena.panchothemonk.workers.dev";
const opsKey = process.env.OPS_API_KEY ?? "";
const requireSmoke = process.env.PRELAUNCH_SKIP_SMOKE !== "true";
const requireOnchainPreflight = process.env.PANCHO_PRELAUNCH_ONCHAIN === "true";

function check(ok, message, details = undefined) {
  return { ok, message, details };
}

function parseWallet(label, value, blockers, checks) {
  if (!value) {
    blockers.push(check(false, `${label} missing.`));
    return null;
  }
  try {
    const pk = new PublicKey(value);
    checks.push(check(true, `${label} parsed.`, { [label]: pk.toBase58() }));
    return pk;
  } catch (error) {
    blockers.push(
      check(false, `${label} invalid.`, { error: error instanceof Error ? error.message : String(error) })
    );
    return null;
  }
}

function requireFlagOff(name, blockers, checks) {
  const value = (process.env[name] ?? "off").toLowerCase();
  if (value === "on") {
    blockers.push(check(false, `${name} must be off for launch.`, { value }));
  } else {
    checks.push(check(true, `${name} is off.`, { value }));
  }
}

function runNodeScript(scriptPath) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8"
  });
}

async function checkHealth(blockers, checks) {
  try {
    const headers = {};
    if (opsKey) {
      headers["x-ops-key"] = opsKey;
    }

    const res = await fetch(`${base}/api/ops/health`, { headers, cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      blockers.push(check(false, "Ops health endpoint returned non-200.", { status: res.status, data }));
      return;
    }
    if (!data.ok) {
      blockers.push(check(false, "Ops health is degraded.", data));
      return;
    }
    checks.push(check(true, "Ops health is ok.", data));
  } catch (error) {
    blockers.push(
      check(false, "Ops health request failed.", { error: error instanceof Error ? error.message : String(error) })
    );
  }
}

async function main() {
  const blockers = [];
  const warnings = [];
  const checks = [];

  requireFlagOff("PANCHO_PAUSE_JOINS", blockers, checks);
  requireFlagOff("PANCHO_PAUSE_SIM_SETTLEMENTS", blockers, checks);
  requireFlagOff("PANCHO_PAUSE_SETTLE_API", blockers, checks);

  if (!process.env.SIM_SETTLE_API_KEY) {
    blockers.push(check(false, "SIM_SETTLE_API_KEY missing."));
  } else {
    checks.push(check(true, "SIM_SETTLE_API_KEY present."));
  }

  const expectedTreasury = parseWallet(
    "PANCHO_EXPECTED_TREASURY_WALLET",
    process.env.PANCHO_EXPECTED_TREASURY_WALLET,
    blockers,
    checks
  );
  const configuredTreasuryRaw = process.env.TREASURY_WALLET ?? process.env.PANCHO_TREASURY_WALLET ?? "";
  const configuredTreasury = configuredTreasuryRaw
    ? parseWallet("configured_treasury_wallet", configuredTreasuryRaw, blockers, checks)
    : null;

  if (expectedTreasury && configuredTreasury && !expectedTreasury.equals(configuredTreasury)) {
    blockers.push(
      check(false, "Treasury lock mismatch.", {
        expectedTreasury: expectedTreasury.toBase58(),
        configuredTreasury: configuredTreasury.toBase58()
      })
    );
  } else if (expectedTreasury && configuredTreasury) {
    checks.push(check(true, "Treasury lock matched.", { treasury: expectedTreasury.toBase58() }));
  } else if (expectedTreasury && !configuredTreasury) {
    warnings.push(
      check(false, "Configured treasury wallet not set in env; runtime may fallback in some modes.", {
        expectedTreasury: expectedTreasury.toBase58()
      })
    );
  }

  if (process.env.NEXT_PUBLIC_ESCROW_WALLET) {
    parseWallet("NEXT_PUBLIC_ESCROW_WALLET", process.env.NEXT_PUBLIC_ESCROW_WALLET, blockers, checks);
  } else {
    warnings.push(check(false, "NEXT_PUBLIC_ESCROW_WALLET not set. Using code default."));
  }

  await checkHealth(blockers, checks);

  if (requireSmoke) {
    const smoke = runNodeScript("scripts/canary-workers.mjs");
    if (smoke.status !== 0) {
      blockers.push(check(false, "Smoke check failed.", { stdout: smoke.stdout, stderr: smoke.stderr }));
    } else {
      checks.push(check(true, "Smoke check passed."));
    }
  } else {
    warnings.push(check(false, "Smoke check skipped (PRELAUNCH_SKIP_SMOKE=true)."));
  }

  if (requireOnchainPreflight) {
    const preflight = runNodeScript("scripts/onchain-preflight.mjs");
    if (preflight.status !== 0) {
      blockers.push(check(false, "Onchain preflight failed.", { stdout: preflight.stdout, stderr: preflight.stderr }));
    } else {
      checks.push(check(true, "Onchain preflight passed."));
    }
  }

  const report = {
    ok: blockers.length === 0,
    base,
    blockers,
    warnings,
    checks
  };

  console.log(JSON.stringify(report, null, 2));
  if (blockers.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        fatal: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )
  );
  process.exit(1);
});

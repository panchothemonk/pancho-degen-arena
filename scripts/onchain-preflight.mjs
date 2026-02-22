import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { clusterApiUrl, Connection, Keypair, PublicKey } from "@solana/web3.js";

const ROOT = process.cwd();
const PROGRAM_RS = path.join(ROOT, "onchain", "programs", "pancho_pvp", "src", "lib.rs");
const PROGRAM_SO = path.join(ROOT, "onchain", "target", "deploy", "pancho_pvp.so");
const PROGRAM_KEYPAIR = path.join(ROOT, "onchain", "target", "deploy", "pancho_pvp-keypair.json");

function parseDeclareId() {
  if (!existsSync(PROGRAM_RS)) return null;
  const src = readFileSync(PROGRAM_RS, "utf8");
  const match = src.match(/declare_id!\("([^"]+)"\);/);
  return match?.[1] ?? null;
}

function loadKeeperKeypair() {
  const inlineSecret = process.env.PANCHO_KEEPER_SECRET_KEY;
  if (inlineSecret) {
    const arr = JSON.parse(inlineSecret);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  const keypairPath = process.env.PANCHO_KEEPER_KEYPAIR_PATH;
  if (!keypairPath) return null;
  const arr = JSON.parse(readFileSync(keypairPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function status(ok, message, details = undefined) {
  return { ok, message, details };
}

async function checkOracleAccount(connection, oracleProgram, envKey) {
  const value = process.env[envKey];
  if (!value) {
    return status(false, `Missing ${envKey}`);
  }
  try {
    const key = new PublicKey(value);
    const account = await connection.getAccountInfo(key, "confirmed");
    if (!account) return status(false, `${envKey} account does not exist`, { pubkey: key.toBase58() });
    if (!account.owner.equals(oracleProgram)) {
      return status(false, `${envKey} owner mismatch`, {
        pubkey: key.toBase58(),
        owner: account.owner.toBase58(),
        expectedOwner: oracleProgram.toBase58()
      });
    }
    return status(true, `${envKey} ok`, { pubkey: key.toBase58(), owner: account.owner.toBase58() });
  } catch (error) {
    return status(false, `${envKey} invalid`, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function main() {
  const checks = [];
  const blockers = [];
  const warnings = [];

  const rustProgramId = parseDeclareId();
  const configuredProgramId = process.env.PANCHO_PROGRAM_ID ?? process.env.NEXT_PUBLIC_PANCHO_PROGRAM_ID ?? rustProgramId;
  if (!configuredProgramId) {
    blockers.push(status(false, "Program id missing (no declare_id and no PANCHO_PROGRAM_ID)."));
    console.log(JSON.stringify({ ok: false, blockers, warnings, checks }, null, 2));
    process.exit(1);
  }

  let programPk;
  try {
    programPk = new PublicKey(configuredProgramId);
  } catch (error) {
    blockers.push(status(false, "Configured program id is invalid.", { configuredProgramId, error: String(error) }));
    console.log(JSON.stringify({ ok: false, blockers, warnings, checks }, null, 2));
    process.exit(1);
  }

  if (rustProgramId && rustProgramId !== programPk.toBase58()) {
    blockers.push(
      status(false, "Program id mismatch between Rust declare_id and environment.", {
        rustProgramId,
        configuredProgramId: programPk.toBase58()
      })
    );
  } else {
    checks.push(status(true, "Program id aligned.", { programId: programPk.toBase58() }));
  }

  const rpc = process.env.SOLANA_RPC_URL ?? process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? clusterApiUrl("devnet");
  const connection = new Connection(rpc, "confirmed");
  try {
    const slot = await connection.getSlot("confirmed");
    checks.push(status(true, "RPC reachable.", { rpc, slot }));
  } catch (error) {
    blockers.push(status(false, "RPC not reachable.", { rpc, error: error instanceof Error ? error.message : String(error) }));
  }

  const keeper = loadKeeperKeypair();
  if (!keeper) {
    blockers.push(status(false, "Missing keeper signer. Set PANCHO_KEEPER_SECRET_KEY or PANCHO_KEEPER_KEYPAIR_PATH."));
  } else {
    checks.push(status(true, "Keeper signer loaded.", { keeper: keeper.publicKey.toBase58() }));
    try {
      const lamports = await connection.getBalance(keeper.publicKey, "confirmed");
      const balanceSol = lamports / 1_000_000_000;
      const minSol = Number(process.env.PANCHO_MIN_DEPLOY_SOL ?? 3);
      if (balanceSol < minSol) {
        blockers.push(
          status(false, "Keeper wallet balance too low for deploy/cutover.", {
            keeper: keeper.publicKey.toBase58(),
            balanceSol,
            requiredMinSol: minSol
          })
        );
      } else {
        checks.push(status(true, "Keeper wallet balance sufficient.", { balanceSol, requiredMinSol: minSol }));
      }
    } catch (error) {
      blockers.push(status(false, "Failed to read keeper balance.", { error: error instanceof Error ? error.message : String(error) }));
    }
  }

  if (!existsSync(PROGRAM_SO)) {
    blockers.push(status(false, "Build artifact missing.", { requiredFile: PROGRAM_SO }));
  } else {
    const soSizeBytes = readFileSync(PROGRAM_SO).byteLength;
    checks.push(status(true, "Program artifact exists.", { file: PROGRAM_SO, soSizeBytes }));
    try {
      // Approximate upgradeable deploy cost:
      // rent(program) + rent(programData) + temporary buffer + tx fee headroom.
      const programRent = await connection.getMinimumBalanceForRentExemption(36);
      const programDataRent = await connection.getMinimumBalanceForRentExemption(45 + soSizeBytes);
      const bufferRent = await connection.getMinimumBalanceForRentExemption(soSizeBytes);
      const estimateLamports = programRent + programDataRent + bufferRent + 50_000_000; // +0.05 SOL headroom
      const estimateSol = estimateLamports / 1_000_000_000;
      checks.push(
        status(true, "Estimated deploy funding computed.", {
          soSizeBytes,
          estimateLamports,
          estimateSol
        })
      );
    } catch (error) {
      warnings.push(
        status(false, "Could not compute deploy funding estimate.", {
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  if (!existsSync(PROGRAM_KEYPAIR)) {
    blockers.push(status(false, "Program keypair missing.", { requiredFile: PROGRAM_KEYPAIR }));
  } else {
    checks.push(status(true, "Program keypair exists.", { file: PROGRAM_KEYPAIR }));
  }

  try {
    const programInfo = await connection.getAccountInfo(programPk, "confirmed");
    if (programInfo) {
      checks.push(status(true, "Program account exists on target cluster.", { programId: programPk.toBase58() }));
    } else {
      warnings.push(
        status(false, "Program account not found on target cluster. Deploy required before onchain keeper.", {
          programId: programPk.toBase58()
        })
      );
    }
  } catch (error) {
    warnings.push(status(false, "Unable to verify program account.", { error: error instanceof Error ? error.message : String(error) }));
  }

  const oracleProgramId = process.env.PANCHO_ORACLE_PROGRAM_ID;
  if (!oracleProgramId) {
    blockers.push(status(false, "Missing PANCHO_ORACLE_PROGRAM_ID."));
  } else {
    try {
      const oracleProgramPk = new PublicKey(oracleProgramId);
      checks.push(status(true, "Oracle program id parsed.", { oracleProgramId: oracleProgramPk.toBase58() }));
      const oracleChecks = await Promise.all([
        checkOracleAccount(connection, oracleProgramPk, "PANCHO_ORACLE_ACCOUNT_SOL"),
        checkOracleAccount(connection, oracleProgramPk, "PANCHO_ORACLE_ACCOUNT_BTC"),
        checkOracleAccount(connection, oracleProgramPk, "PANCHO_ORACLE_ACCOUNT_ETH")
      ]);
      for (const result of oracleChecks) {
        if (result.ok) checks.push(result);
        else blockers.push(result);
      }
    } catch (error) {
      blockers.push(status(false, "PANCHO_ORACLE_PROGRAM_ID invalid.", { error: error instanceof Error ? error.message : String(error) }));
    }
  }

  if (!process.env.PANCHO_TREASURY_WALLET) {
    warnings.push(status(false, "PANCHO_TREASURY_WALLET missing. Auto-init config will fail."));
  } else {
    try {
      const treasury = new PublicKey(process.env.PANCHO_TREASURY_WALLET);
      checks.push(status(true, "Treasury wallet parsed.", { treasury: treasury.toBase58() }));
      if (process.env.PANCHO_EXPECTED_TREASURY_WALLET) {
        const expected = new PublicKey(process.env.PANCHO_EXPECTED_TREASURY_WALLET);
        if (!treasury.equals(expected)) {
          blockers.push(
            status(false, "Treasury lock mismatch.", {
              configuredTreasury: treasury.toBase58(),
              expectedTreasury: expected.toBase58()
            })
          );
        } else {
          checks.push(status(true, "Treasury lock matched.", { treasury: treasury.toBase58() }));
        }
      }
    } catch (error) {
      blockers.push(status(false, "PANCHO_TREASURY_WALLET invalid.", { error: error instanceof Error ? error.message : String(error) }));
    }
  }

  const ok = blockers.length === 0;
  const report = {
    ok,
    rpc,
    programId: programPk.toBase58(),
    blockers,
    warnings,
    checks
  };
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exit(1);
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

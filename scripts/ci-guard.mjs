import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`[ci-guard] ${message}`);
  process.exit(1);
}

const tracked = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const forbiddenPathMatchers = [
  /(^|\/).*keypair\.json$/i,
  /(^|\/)id\.json$/i,
  /^data\//i,
  /^onchain\/\.anchor\//i,
  /^onchain\/target\//i
];

const forbidden = tracked.filter((path) => forbiddenPathMatchers.some((rx) => rx.test(path)));
if (forbidden.length > 0) {
  fail(`Forbidden tracked artifacts detected:\n${forbidden.join("\n")}`);
}

const idlPath = "onchain/abi/pancho_pvp.idl.json";
const typesPath = "onchain/abi/pancho_pvp.types.ts";

let idl;
try {
  idl = JSON.parse(readFileSync(idlPath, "utf8"));
} catch (err) {
  fail(`Unable to read ABI snapshot ${idlPath}: ${err instanceof Error ? err.message : String(err)}`);
}

const initializeConfig = Array.isArray(idl?.instructions)
  ? idl.instructions.find((ix) => ix?.name === "initializeConfig" || ix?.name === "initialize_config")
  : null;
if (!initializeConfig) {
  fail("ABI snapshot missing initializeConfig instruction.");
}

const argNames = Array.isArray(initializeConfig.args) ? initializeConfig.args.map((arg) => arg?.name) : [];
for (const requiredArg of ["oracleAccountSol", "oracleAccountBtc", "oracleAccountEth"]) {
  const snake = requiredArg.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  if (!argNames.includes(requiredArg) && !argNames.includes(snake)) {
    fail(`ABI snapshot drift: initializeConfig missing arg ${requiredArg}.`);
  }
}

const typesText = readFileSync(typesPath, "utf8");
for (const required of ["oracleAccountSol", "oracleAccountBtc", "oracleAccountEth"]) {
  if (!typesText.includes(required)) {
    fail(`Type snapshot drift: ${typesPath} missing ${required}.`);
  }
}

console.log("[ci-guard] OK");

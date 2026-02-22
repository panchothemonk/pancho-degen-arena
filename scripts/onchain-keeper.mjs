import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { clusterApiUrl, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey(process.env.PANCHO_PROGRAM_ID ?? "52nguesHaBuF4psFr2uybVnW4angLW2ZtsBRSRmdF8k3");
const RPC_URL = process.env.SOLANA_RPC_URL ?? process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? clusterApiUrl("devnet");
const INTERVAL_MS = Number(process.env.ONCHAIN_KEEPER_INTERVAL_MS ?? 4000);

const OPEN_SECONDS = Number(process.env.PANCHO_OPEN_SECONDS ?? 60);
const LOCK_SECONDS = Number(process.env.PANCHO_LOCK_SECONDS ?? 60);
const ENTRY_CYCLE_SECONDS = OPEN_SECONDS + LOCK_SECONDS;
const SETTLEMENT_SECONDS = Number(process.env.PANCHO_SETTLEMENT_SECONDS ?? 300);

const FEE_BPS = Number(process.env.PANCHO_FEE_BPS ?? 600);
const ORACLE_MAX_AGE_SEC = Number(process.env.PANCHO_ORACLE_MAX_AGE_SEC ?? 120);
const AUTO_INIT_CONFIG = process.env.PANCHO_AUTO_INIT_CONFIG === "true";

const MARKETS = [
  {
    key: "SOL",
    code: 0,
    feedIdHex: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    oraclePriceAccountEnv: "PANCHO_ORACLE_ACCOUNT_SOL"
  },
  {
    key: "BTC",
    code: 1,
    feedIdHex: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    oraclePriceAccountEnv: "PANCHO_ORACLE_ACCOUNT_BTC"
  },
  {
    key: "ETH",
    code: 2,
    feedIdHex: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    oraclePriceAccountEnv: "PANCHO_ORACLE_ACCOUNT_ETH"
  }
];

const SYSTEM_PROGRAM_ID = SystemProgram.programId;
const ROUND_ACCOUNT_DISCRIMINATOR = createDiscriminator("account:Round");
const ROUND_STATUS_OPEN = 0;
const ROUND_STATUS_LOCKED = 1;
const ROUND_STATUS_SETTLED = 2;

function createDiscriminator(label) {
  return createHash("sha256").update(label).digest().subarray(0, 8);
}

function ixDiscriminator(name) {
  return createDiscriminator(`global:${name}`);
}

function loadKeeperKeypair() {
  const inlineSecret = process.env.PANCHO_KEEPER_SECRET_KEY;
  if (inlineSecret) {
    const arr = JSON.parse(inlineSecret);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }

  const path = process.env.PANCHO_KEEPER_KEYPAIR_PATH;
  if (!path) {
    throw new Error("Missing PANCHO_KEEPER_SECRET_KEY or PANCHO_KEEPER_KEYPAIR_PATH");
  }
  const raw = readFileSync(path, "utf8");
  const arr = JSON.parse(raw);
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function deriveConfigPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
}

function deriveRoundPda(marketCode, roundId) {
  const roundIdBytes = Buffer.alloc(8);
  roundIdBytes.writeBigInt64LE(roundId, 0);
  return PublicKey.findProgramAddressSync([Buffer.from("round"), Buffer.from([marketCode]), roundIdBytes], PROGRAM_ID)[0];
}

function deriveVaultPda(round, side) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), round.toBuffer(), Buffer.from([side])], PROGRAM_ID)[0];
}

function encodeInitializeConfig({ feeBps, oracleMaxAgeSec, oracleProgram }) {
  const data = Buffer.alloc(8 + 2 + 4 + 32);
  ixDiscriminator("initialize_config").copy(data, 0);
  data.writeUInt16LE(feeBps, 8);
  data.writeUInt32LE(oracleMaxAgeSec, 10);
  new PublicKey(oracleProgram).toBuffer().copy(data, 14);
  return data;
}

function encodeCreateRound({ marketCode, roundId, lockTs, endTs, feedIdHex, oraclePriceAccount }) {
  const data = Buffer.alloc(8 + 1 + 8 + 8 + 8 + 32 + 32);
  ixDiscriminator("create_round").copy(data, 0);
  data.writeUInt8(marketCode, 8);
  data.writeBigInt64LE(roundId, 9);
  data.writeBigInt64LE(BigInt(lockTs), 17);
  data.writeBigInt64LE(BigInt(endTs), 25);
  Buffer.from(feedIdHex, "hex").copy(data, 33);
  new PublicKey(oraclePriceAccount).toBuffer().copy(data, 65);
  return data;
}

function encodeNoArgsIx(name) {
  const data = Buffer.alloc(8);
  ixDiscriminator(name).copy(data, 0);
  return data;
}

async function sendIx(connection, payer, instruction) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: payer.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight
  }).add(instruction);

  tx.sign(payer);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed"
  );
  return signature;
}

async function fetchConfig(connection, configPda) {
  const info = await connection.getAccountInfo(configPda, "confirmed");
  if (!info || info.data.length < 120) {
    return null;
  }
  const data = Buffer.from(info.data);
  return {
    admin: new PublicKey(data.subarray(8, 40)),
    treasury: new PublicKey(data.subarray(40, 72)),
    oracleProgram: new PublicKey(data.subarray(72, 104)),
    feeBps: data.readUInt16LE(104),
    oracleMaxAgeSec: data.readUInt32LE(106),
    paused: data.readUInt8(110) === 1
  };
}

function parseRound(data) {
  const buf = Buffer.from(data);
  if (buf.length < 160 || !buf.subarray(0, 8).equals(ROUND_ACCOUNT_DISCRIMINATOR)) {
    return null;
  }
  return {
    roundId: buf.readBigInt64LE(8),
    market: buf.readUInt8(16),
    lockTs: Number(buf.readBigInt64LE(81)),
    endTs: Number(buf.readBigInt64LE(89)),
    status: buf.readUInt8(117)
  };
}

function getOracleAccount(market) {
  const value = process.env[market.oraclePriceAccountEnv];
  if (!value) {
    throw new Error(`Missing ${market.oraclePriceAccountEnv}`);
  }
  return new PublicKey(value);
}

function assertTreasuryLock(configTreasury) {
  const expected = process.env.PANCHO_EXPECTED_TREASURY_WALLET;
  if (!expected) {
    return;
  }

  const expectedPk = new PublicKey(expected);
  if (!configTreasury.equals(expectedPk)) {
    throw new Error(
      `Treasury lock mismatch: config=${configTreasury.toBase58()} expected=${expectedPk.toBase58()}. Refusing keeper actions.`
    );
  }
}

function computeRoundSchedule(roundIdSec) {
  const lockTs = roundIdSec + OPEN_SECONDS;
  const endTs = lockTs + SETTLEMENT_SECONDS;
  return { lockTs, endTs };
}

function candidateRoundIds(nowSec) {
  const cycleStart = Math.floor(nowSec / ENTRY_CYCLE_SECONDS) * ENTRY_CYCLE_SECONDS;
  return [
    cycleStart - ENTRY_CYCLE_SECONDS * 3,
    cycleStart - ENTRY_CYCLE_SECONDS * 2,
    cycleStart - ENTRY_CYCLE_SECONDS,
    cycleStart,
    cycleStart + ENTRY_CYCLE_SECONDS
  ];
}

async function maybeInitializeConfig(connection, payer, configPda) {
  const cfg = await fetchConfig(connection, configPda);
  if (cfg) {
    return cfg;
  }
  if (!AUTO_INIT_CONFIG) {
    throw new Error("Config PDA is not initialized. Set PANCHO_AUTO_INIT_CONFIG=true to auto-create it.");
  }

  const treasury = process.env.PANCHO_TREASURY_WALLET;
  const oracleProgram = process.env.PANCHO_ORACLE_PROGRAM_ID;
  if (!treasury || !oracleProgram) {
    throw new Error("Missing PANCHO_TREASURY_WALLET or PANCHO_ORACLE_PROGRAM_ID for config initialization.");
  }

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(treasury), isSigner: false, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: encodeInitializeConfig({
      feeBps: FEE_BPS,
      oracleMaxAgeSec: ORACLE_MAX_AGE_SEC,
      oracleProgram
    })
  });

  const sig = await sendIx(connection, payer, ix);
  console.log(`[onchain-keeper] initialized config ${configPda.toBase58()} tx=${sig}`);
  const initialized = await fetchConfig(connection, configPda);
  if (!initialized) {
    throw new Error("Config init confirmed but account is not readable.");
  }
  return initialized;
}

async function maybeCreateRound(connection, payer, configPda, market, roundIdSec) {
  const { lockTs } = computeRoundSchedule(roundIdSec);
  const now = Math.floor(Date.now() / 1000);
  if (now >= lockTs) {
    return;
  }

  const roundId = BigInt(roundIdSec);
  const roundPda = deriveRoundPda(market.code, roundId);
  const existing = await connection.getAccountInfo(roundPda, "confirmed");
  if (existing) {
    return;
  }

  const { endTs } = computeRoundSchedule(roundIdSec);
  const upVault = deriveVaultPda(roundPda, 0);
  const downVault = deriveVaultPda(roundPda, 1);
  const oraclePrice = getOracleAccount(market);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: roundPda, isSigner: false, isWritable: true },
      { pubkey: upVault, isSigner: false, isWritable: true },
      { pubkey: downVault, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: encodeCreateRound({
      marketCode: market.code,
      roundId,
      lockTs,
      endTs,
      feedIdHex: market.feedIdHex,
      oraclePriceAccount: oraclePrice
    })
  });

  const sig = await sendIx(connection, payer, ix);
  console.log(`[onchain-keeper] created ${market.key} round ${roundIdSec} tx=${sig}`);
}

async function maybeLockRound(connection, payer, configPda, market, roundIdSec) {
  const roundPda = deriveRoundPda(market.code, BigInt(roundIdSec));
  const info = await connection.getAccountInfo(roundPda, "confirmed");
  if (!info) return;
  const round = parseRound(info.data);
  if (!round || round.status !== ROUND_STATUS_OPEN) return;

  const now = Math.floor(Date.now() / 1000);
  if (now < round.lockTs) return;

  const oraclePrice = getOracleAccount(market);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: roundPda, isSigner: false, isWritable: true },
      { pubkey: oraclePrice, isSigner: false, isWritable: false }
    ],
    data: encodeNoArgsIx("lock_round")
  });
  const sig = await sendIx(connection, payer, ix);
  console.log(`[onchain-keeper] locked ${market.key} round ${roundIdSec} tx=${sig}`);
}

async function maybeSettleRound(connection, payer, configPda, treasury, market, roundIdSec) {
  const roundPda = deriveRoundPda(market.code, BigInt(roundIdSec));
  const info = await connection.getAccountInfo(roundPda, "confirmed");
  if (!info) return;
  const round = parseRound(info.data);
  if (!round || round.status === ROUND_STATUS_SETTLED) return;

  const now = Math.floor(Date.now() / 1000);
  if (now < round.endTs) return;

  const upVault = deriveVaultPda(roundPda, 0);
  const downVault = deriveVaultPda(roundPda, 1);
  const oraclePrice = getOracleAccount(market);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: roundPda, isSigner: false, isWritable: true },
      { pubkey: upVault, isSigner: false, isWritable: true },
      { pubkey: downVault, isSigner: false, isWritable: true },
      { pubkey: oraclePrice, isSigner: false, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true }
    ],
    data: encodeNoArgsIx("settle_round")
  });
  const sig = await sendIx(connection, payer, ix);
  console.log(`[onchain-keeper] settled ${market.key} round ${roundIdSec} tx=${sig}`);
}

async function keeperTick(connection, payer, configPda) {
  const config = await maybeInitializeConfig(connection, payer, configPda);
  assertTreasuryLock(config.treasury);
  if (config.paused) {
    console.log("[onchain-keeper] config is paused; skipping tick");
    return;
  }

  const treasury = config.treasury;
  const nowSec = Math.floor(Date.now() / 1000);
  const rounds = candidateRoundIds(nowSec);
  const currentCycle = Math.floor(nowSec / ENTRY_CYCLE_SECONDS) * ENTRY_CYCLE_SECONDS;

  async function safeStep(stepLabel, fn) {
    try {
      await fn();
    } catch (error) {
      console.error(`[onchain-keeper] ${stepLabel} failed`, error instanceof Error ? error.message : error);
    }
  }

  for (const market of MARKETS) {
    await safeStep(`create ${market.key} current`, async () => {
      await maybeCreateRound(connection, payer, configPda, market, currentCycle);
    });
    await safeStep(`create ${market.key} next`, async () => {
      await maybeCreateRound(
        connection,
        payer,
        configPda,
        market,
        currentCycle + ENTRY_CYCLE_SECONDS
      );
    });

    for (const roundIdSec of rounds) {
      await safeStep(`lock ${market.key} ${roundIdSec}`, async () => {
        await maybeLockRound(connection, payer, configPda, market, roundIdSec);
      });
      await safeStep(`settle ${market.key} ${roundIdSec}`, async () => {
        await maybeSettleRound(connection, payer, configPda, treasury, market, roundIdSec);
      });
    }
  }
}

async function main() {
  const payer = loadKeeperKeypair();
  const connection = new Connection(RPC_URL, "confirmed");
  const configPda = deriveConfigPda();

  console.log(`[onchain-keeper] rpc=${RPC_URL}`);
  console.log(`[onchain-keeper] keeper=${payer.publicKey.toBase58()}`);
  console.log(`[onchain-keeper] program=${PROGRAM_ID.toBase58()}`);
  console.log(`[onchain-keeper] config=${configPda.toBase58()}`);
  console.log(
    `[onchain-keeper] cadence=${ENTRY_CYCLE_SECONDS}s cycle (${OPEN_SECONDS}s open + ${LOCK_SECONDS}s lock), settle=${SETTLEMENT_SECONDS}s`
  );

  await keeperTick(connection, payer, configPda);
  setInterval(async () => {
    try {
      await keeperTick(connection, payer, configPda);
    } catch (error) {
      console.error(`[onchain-keeper] ${new Date().toISOString()} tick error`, error);
    }
  }, INTERVAL_MS);
}

main().catch((error) => {
  console.error("[onchain-keeper] fatal", error);
  process.exit(1);
});

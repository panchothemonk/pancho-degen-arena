import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";

export const PANCHO_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PANCHO_PROGRAM_ID ?? "52nguesHaBuF4psFr2uybVnW4angLW2ZtsBRSRmdF8k3"
);

export const JOIN_ROUND_DISCRIMINATOR = Buffer.from([191, 222, 86, 25, 234, 174, 157, 249]);
export const CLAIM_DISCRIMINATOR = Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]);
const ROUND_ACCOUNT_DISCRIMINATOR = Buffer.from([190, 136, 93, 11, 235, 95, 57, 251]);
const POSITION_ACCOUNT_DISCRIMINATOR = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]);

export type OnchainRoundState = {
  status: number;
  winnerSide: number;
  lockTs: number;
  endTs: number;
  distributableLamports: bigint;
  upTotal: bigint;
  downTotal: bigint;
};

export type OnchainPositionState = {
  side: number;
  amountLamports: bigint;
  claimed: boolean;
};

export function marketKeyToCode(market: string): number {
  const key = market.toUpperCase();
  if (key === "SOL") return 0;
  if (key === "BTC") return 1;
  if (key === "ETH") return 2;
  throw new Error(`Unsupported market key: ${market}`);
}

export function directionToSide(direction: "UP" | "DOWN"): number {
  return direction === "UP" ? 0 : 1;
}

export function roundIdFromStartMs(roundStartMs: number): bigint {
  return BigInt(Math.floor(roundStartMs / 1000));
}

export function roundStartMsFromRoundId(roundId: string): number {
  const parts = roundId.split("-");
  if (parts.length < 2) {
    throw new Error(`Invalid round id: ${roundId}`);
  }
  const sec = Number(parts[1]);
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new Error(`Invalid round id timestamp: ${roundId}`);
  }
  return sec * 1000;
}

export function deriveConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], PANCHO_PROGRAM_ID)[0];
}

export function deriveRoundPda(marketCode: number, roundId: bigint): PublicKey {
  const roundIdBytes = Buffer.alloc(8);
  roundIdBytes.writeBigUInt64LE(roundId, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round"), Buffer.from([marketCode]), roundIdBytes],
    PANCHO_PROGRAM_ID
  )[0];
}

export function deriveVaultPda(round: PublicKey, side: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), round.toBuffer(), Buffer.from([side])],
    PANCHO_PROGRAM_ID
  )[0];
}

export function derivePositionPda(round: PublicKey, user: PublicKey, side: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), round.toBuffer(), user.toBuffer(), Buffer.from([side])],
    PANCHO_PROGRAM_ID
  )[0];
}

export function buildJoinRoundInstruction(params: {
  user: PublicKey;
  marketKey: string;
  roundStartMs: number;
  direction: "UP" | "DOWN";
  lamports: number;
}): TransactionInstruction {
  const marketCode = marketKeyToCode(params.marketKey);
  const roundId = roundIdFromStartMs(params.roundStartMs);
  const side = directionToSide(params.direction);

  const config = deriveConfigPda();
  const round = deriveRoundPda(marketCode, roundId);
  const position = derivePositionPda(round, params.user, side);
  const sideVault = deriveVaultPda(round, side);

  const data = Buffer.alloc(8 + 1 + 8);
  JOIN_ROUND_DISCRIMINATOR.copy(data, 0);
  data.writeUInt8(side, 8);
  data.writeBigUInt64LE(BigInt(Math.floor(params.lamports)), 9);

  return new TransactionInstruction({
    programId: PANCHO_PROGRAM_ID,
    keys: [
      { pubkey: params.user, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: round, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: sideVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data
  });
}

export function buildClaimInstruction(params: {
  user: PublicKey;
  marketKey: string;
  roundStartMs: number;
  direction: "UP" | "DOWN";
}): TransactionInstruction {
  const marketCode = marketKeyToCode(params.marketKey);
  const roundId = roundIdFromStartMs(params.roundStartMs);
  const side = directionToSide(params.direction);

  const round = deriveRoundPda(marketCode, roundId);
  const position = derivePositionPda(round, params.user, side);
  const upVault = deriveVaultPda(round, 0);
  const downVault = deriveVaultPda(round, 1);

  return new TransactionInstruction({
    programId: PANCHO_PROGRAM_ID,
    keys: [
      { pubkey: params.user, isSigner: true, isWritable: true },
      { pubkey: round, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: upVault, isSigner: false, isWritable: true },
      { pubkey: downVault, isSigner: false, isWritable: true }
    ],
    data: CLAIM_DISCRIMINATOR
  });
}

export function decodeRoundAccount(data: Buffer): OnchainRoundState | null {
  if (data.length < 152 || !data.subarray(0, 8).equals(ROUND_ACCOUNT_DISCRIMINATOR)) {
    return null;
  }
  return {
    lockTs: Number(data.readBigInt64LE(81)),
    endTs: Number(data.readBigInt64LE(89)),
    status: data.readUInt8(117),
    winnerSide: data.readUInt8(118),
    upTotal: data.readBigUInt64LE(119),
    downTotal: data.readBigUInt64LE(127),
    distributableLamports: data.readBigUInt64LE(143)
  };
}

export function decodePositionAccount(data: Buffer): OnchainPositionState | null {
  if (data.length < 83 || !data.subarray(0, 8).equals(POSITION_ACCOUNT_DISCRIMINATOR)) {
    return null;
  }
  return {
    side: data.readUInt8(72),
    amountLamports: data.readBigUInt64LE(73),
    claimed: data.readUInt8(81) === 1
  };
}

export function estimatePositionPayoutLamports(round: OnchainRoundState, position: OnchainPositionState): bigint {
  const zero = BigInt(0);
  if (position.amountLamports === zero) {
    return zero;
  }
  const total = round.upTotal + round.downTotal;
  if (total <= zero || round.distributableLamports <= zero) {
    return zero;
  }
  if (round.winnerSide === 255) {
    return (position.amountLamports * round.distributableLamports) / total;
  }
  if (position.side !== round.winnerSide) {
    return zero;
  }
  const winnerTotal = round.winnerSide === 0 ? round.upTotal : round.downTotal;
  if (winnerTotal <= zero) {
    return zero;
  }
  return (position.amountLamports * round.distributableLamports) / winnerTotal;
}

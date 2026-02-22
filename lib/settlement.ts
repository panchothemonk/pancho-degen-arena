import { readFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import {
  addRoundSettlement,
  appendSettlementTransfer,
  releaseRoundProcessingLock,
  markSettlementCompleted,
  readLedger,
  tryAcquireRoundProcessingLock,
  type PlannedTransfer,
  type RoundSettlement,
} from "@/lib/round-ledger";
import { auditLog } from "@/lib/audit";
import { fetchOracleSnapshotAtTimestamp, resolveMarketByFeedId } from "@/lib/oracle";

type SettledRoundSummary = {
  roundId: string;
  mode: "WIN" | "REFUND";
  winnerSide?: "UP" | "DOWN";
  feeLamports: number;
  transferCount: number;
};

type Recipient = {
  wallet: string;
  lamports: number;
};

const FEE_BPS = 600;
const OPEN_ENTRY_SECONDS = 60;
let settleLock: Promise<void> = Promise.resolve();

function resolveTreasuryWallet(signer: Keypair): string {
  const configured = process.env.TREASURY_WALLET ?? process.env.PANCHO_TREASURY_WALLET ?? signer.publicKey.toBase58();
  const expected = process.env.PANCHO_EXPECTED_TREASURY_WALLET;

  const configuredPk = new PublicKey(configured);
  if (expected) {
    const expectedPk = new PublicKey(expected);
    if (!configuredPk.equals(expectedPk)) {
      throw new Error(
        `Treasury lock mismatch: configured=${configuredPk.toBase58()} expected=${expectedPk.toBase58()}. Refusing settlement.`
      );
    }
  }

  return configuredPk.toBase58();
}

function getConnection(): Connection {
  const endpoint = process.env.SOLANA_RPC_URL ?? clusterApiUrl("devnet");
  return new Connection(endpoint, "confirmed");
}

async function loadPayoutSigner(): Promise<Keypair> {
  const keypairPath = process.env.PAYOUT_KEYPAIR_PATH ?? path.join(os.homedir(), ".config/solana/id.json");
  const raw = await readFile(keypairPath, "utf8");
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function addProRataPayouts(
  winners: Recipient[],
  distributableLamports: number,
  winnerStakeTotalLamports: number
): Recipient[] {
  if (winnerStakeTotalLamports <= 0 || distributableLamports <= 0 || winners.length === 0) {
    return [];
  }

  const payouts = winners.map((winner) => ({
    wallet: winner.wallet,
    lamports: Math.floor((distributableLamports * winner.lamports) / winnerStakeTotalLamports)
  }));

  const paid = payouts.reduce((sum, item) => sum + item.lamports, 0);
  const remainder = distributableLamports - paid;
  if (remainder > 0 && payouts.length > 0) {
    payouts[0].lamports += remainder;
  }

  return payouts;
}

async function sendTransfer(connection: Connection, signer: Keypair, recipient: Recipient): Promise<string> {
  if (recipient.lamports <= 0) {
    return "skipped";
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: new PublicKey(recipient.wallet),
      lamports: recipient.lamports
    })
  );

  return sendAndConfirmTransaction(connection, tx, [signer], {
    commitment: "confirmed"
  });
}

export async function settleDueRounds(): Promise<SettledRoundSummary[]> {
  const run = async () => {
    const now = Date.now();
    const ledger = await readLedger();
    const byRound = new Map<string, typeof ledger.entries>();

    for (const entry of ledger.entries) {
      if (entry.roundEndMs > now) {
        continue;
      }
      const current = byRound.get(entry.roundId) ?? [];
      current.push(entry);
      byRound.set(entry.roundId, current);
    }

    if (byRound.size === 0) {
      return [];
    }

    const signer = await loadPayoutSigner();
    const connection = getConnection();
    const treasuryWallet = resolveTreasuryWallet(signer);
    const summaries: SettledRoundSummary[] = [];

    for (const [roundId, entries] of byRound.entries()) {
      const hasLock = await tryAcquireRoundProcessingLock(roundId);
      if (!hasLock) {
        continue;
      }

      try {
        const latestLedger = await readLedger();
        const existing = latestLedger.settlements.find((item) => item.roundId === roundId);
        if (existing?.state === "COMPLETED") {
          continue;
        }

        let settlement: RoundSettlement;
        if (existing) {
          settlement = existing;
        } else {
          settlement = await createProcessingSettlement(roundId, entries, treasuryWallet, signer.publicKey.toBase58());
          await addRoundSettlement(settlement);
        }

        const planned = settlement.plannedTransfers ?? [];
        for (const transfer of planned) {
          const alreadySent = settlement.transfers.some((item) => item.id === transfer.id);
          if (alreadySent) {
            continue;
          }

          const signature = await sendTransfer(connection, signer, {
            wallet: transfer.wallet,
            lamports: transfer.lamports
          });
          if (signature === "skipped") {
            continue;
          }

          await appendSettlementTransfer(roundId, {
            id: transfer.id,
            wallet: transfer.wallet,
            lamports: transfer.lamports,
            signature
          });
          settlement = {
            ...settlement,
            transfers: [...settlement.transfers, { id: transfer.id, wallet: transfer.wallet, lamports: transfer.lamports, signature }]
          };
        }

        const refreshed = (await readLedger()).settlements.find((item) => item.roundId === roundId) ?? settlement;
        const refreshedPlanned = refreshed.plannedTransfers ?? [];
        const allSent = refreshedPlanned.every((transfer) => refreshed.transfers.some((item) => item.id === transfer.id));
        if (allSent) {
          await markSettlementCompleted(roundId);
          await auditLog("INFO", "settle.round_completed", {
            roundId,
            mode: refreshed.mode,
            winnerSide: refreshed.winnerSide,
            feeLamports: refreshed.feeLamports,
            transferCount: refreshed.transfers.length
          });
        }

        summaries.push({
          roundId,
          mode: refreshed.mode,
          winnerSide: refreshed.winnerSide,
          feeLamports: refreshed.feeLamports,
          transferCount: refreshed.transfers.length
        });
      } catch (error) {
        await auditLog("ERROR", "settle.round_error", {
          roundId,
          message: error instanceof Error ? error.message : "Unknown round settlement error"
        });
      } finally {
        await releaseRoundProcessingLock(roundId);
      }
    }

    return summaries;
  };

  const queued = settleLock.then(run, run);
  settleLock = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

async function createProcessingSettlement(
  roundId: string,
  entries: Array<{
    direction: "UP" | "DOWN";
    wallet: string;
    stakeLamports: number;
    roundStartMs: number;
    roundEndMs: number;
    startPrice: number;
    feedId?: string;
  }>,
  treasuryWallet: string,
  signerWallet: string
): Promise<RoundSettlement> {
  const market = resolveMarketByFeedId(entries[0]?.feedId);
  const roundStartMs = entries[0]?.roundStartMs ?? Date.now();
  const lockTimestampSec = Math.floor((roundStartMs + OPEN_ENTRY_SECONDS * 1000) / 1000);
  const endSnapshot = await fetchOracleSnapshotAtTimestamp(market.key, Math.floor((entries[0]?.roundEndMs ?? Date.now()) / 1000));
  const startSnapshot = await fetchOracleSnapshotAtTimestamp(market.key, lockTimestampSec);
  const up = entries.filter((item) => item.direction === "UP");
  const down = entries.filter((item) => item.direction === "DOWN");

  const upLamports = up.reduce((sum, item) => sum + item.stakeLamports, 0);
  const downLamports = down.reduce((sum, item) => sum + item.stakeLamports, 0);
  const totalLamports = upLamports + downLamports;
  const startPrice = startSnapshot.price;
  const endPrice = endSnapshot.price;

  let mode: "WIN" | "REFUND" = "WIN";
  let winnerSide: "UP" | "DOWN" | undefined;
  let payoutRecipients: Recipient[] = [];

  const feeLamports = Math.floor((totalLamports * FEE_BPS) / 10_000);
  const distributable = Math.max(0, totalLamports - feeLamports);

  if (upLamports === 0 || downLamports === 0 || endPrice === startPrice) {
    mode = "REFUND";
    const merged = new Map<string, number>();
    for (const entry of entries) {
      merged.set(entry.wallet, (merged.get(entry.wallet) ?? 0) + entry.stakeLamports);
    }
    const recipients = [...merged.entries()].map(([wallet, lamports]) => ({ wallet, lamports }));
    const recipientStakeTotal = recipients.reduce((sum, item) => sum + item.lamports, 0);
    payoutRecipients = addProRataPayouts(recipients, distributable, recipientStakeTotal);
  } else {
    winnerSide = endPrice > startPrice ? "UP" : "DOWN";
    const winners = (winnerSide === "UP" ? up : down).map((item) => ({
      wallet: item.wallet,
      lamports: item.stakeLamports
    }));
    const winnerStakeTotal = winners.reduce((sum, item) => sum + item.lamports, 0);
    payoutRecipients = addProRataPayouts(winners, distributable, winnerStakeTotal);
  }

  const plannedTransfers: PlannedTransfer[] = [];
  if (feeLamports > 0 && treasuryWallet && treasuryWallet !== signerWallet) {
    plannedTransfers.push({
      id: "fee-0",
      wallet: treasuryWallet,
      lamports: feeLamports,
      kind: "fee"
    });
  }

  payoutRecipients.forEach((recipient, index) => {
    if (recipient.lamports <= 0) {
      return;
    }
    plannedTransfers.push({
      id: `payout-${index}`,
      wallet: recipient.wallet,
      lamports: recipient.lamports,
      kind: "payout"
    });
  });

  return {
    roundId,
    state: "PROCESSING",
    settledAtMs: Date.now(),
    mode,
    winnerSide,
    startPrice,
    endPrice,
    feeLamports,
    plannedTransfers,
    transfers: []
  };
}

import { auditLog } from "@/lib/audit";
import { fetchOracleSnapshot, fetchOracleSnapshotAtTimestamp } from "@/lib/oracle";
import {
  readSimEntriesForRoundIds,
  readSimLedger,
  readSimRoundSettlement,
  writeSimRoundSettlement,
  type SimDirection,
  type SimEntry
} from "@/lib/sim-ledger";

const FEE_BPS = 600;
const inFlightSettlements = new Map<
  string,
  Promise<SimRoundSettlementSnapshot | null>
>();

export type SimRoundSettlement = {
  mode: "WIN" | "REFUND";
  winnerSide?: SimDirection;
  startPrice: number;
  endPrice: number;
};

export type SimRoundSettlementSnapshot = {
  settlement: SimRoundSettlement;
  payoutsByEntryId: Map<string, number>;
  feeCents: number;
  settledAtMs: number;
};

function proRataCents(
  recipients: Array<{ entryId: string; cents: number }>,
  distributableCents: number,
  inputTotalCents: number
): Map<string, number> {
  const allocations = new Map<string, number>();
  if (distributableCents <= 0 || inputTotalCents <= 0 || recipients.length === 0) {
    return allocations;
  }

  const prepared = recipients.map((item) => ({
    entryId: item.entryId,
    cents: Math.floor((distributableCents * item.cents) / inputTotalCents)
  }));
  const paid = prepared.reduce((sum, item) => sum + item.cents, 0);
  const remainder = distributableCents - paid;
  if (remainder > 0 && prepared.length > 0) {
    prepared[0].cents += remainder;
  }

  for (const item of prepared) {
    allocations.set(item.entryId, item.cents);
  }
  return allocations;
}

async function fetchSnapshotNearTimestamp(market: string, unixTimestampSec: number) {
  const offsets = [0, -1, -2, -5, -10, 1, 2, 5, 10];
  for (const offset of offsets) {
    const ts = Math.max(0, unixTimestampSec + offset);
    try {
      return await fetchOracleSnapshotAtTimestamp(market, ts);
    } catch {
      // continue searching nearby historical points
    }
  }
  return fetchOracleSnapshot(market);
}

async function settleRound(entries: SimEntry[]): Promise<SimRoundSettlementSnapshot> {
  const market = entries[0]?.market ?? "SOL";
  const roundStartMs = entries[0]?.roundStartMs ?? Date.now();
  const roundEndMs = entries[0]?.roundEndMs ?? Date.now();
  const lockTimestampSec = Math.floor((roundStartMs + 60_000) / 1000);
  const roundEndSec = Math.floor(roundEndMs / 1000);

  const [startSnapshot, endSnapshot] = await Promise.all([
    fetchSnapshotNearTimestamp(market, lockTimestampSec),
    fetchSnapshotNearTimestamp(market, roundEndSec)
  ]);

  const up = entries.filter((item) => item.direction === "UP");
  const down = entries.filter((item) => item.direction === "DOWN");
  const totalCents = entries.reduce((sum, item) => sum + Math.round(item.stakeBucks * 100), 0);
  const isRefundRound = up.length === 0 || down.length === 0 || endSnapshot.price === startSnapshot.price;
  const feeCents = isRefundRound ? 0 : Math.floor((totalCents * FEE_BPS) / 10_000);
  const distributableCents = Math.max(0, totalCents - feeCents);

  let mode: "WIN" | "REFUND" = "WIN";
  let winnerSide: SimDirection | undefined;

  if (up.length === 0 || down.length === 0) {
    mode = "REFUND";
  } else {
    if (endSnapshot.price > startSnapshot.price) {
      winnerSide = "UP";
    } else if (endSnapshot.price < startSnapshot.price) {
      winnerSide = "DOWN";
    } else {
      // Tie at scheduled timestamps is always a refund.
      mode = "REFUND";
    }
  }

  const payoutsByEntryId =
    mode === "REFUND"
      ? proRataCents(
          entries.map((item) => ({ entryId: item.id, cents: Math.round(item.stakeBucks * 100) })),
          distributableCents,
          totalCents
        )
      : proRataCents(
          entries
            .filter((item) => item.direction === winnerSide)
            .map((item) => ({ entryId: item.id, cents: Math.round(item.stakeBucks * 100) })),
          distributableCents,
          entries
            .filter((item) => item.direction === winnerSide)
            .reduce((sum, item) => sum + Math.round(item.stakeBucks * 100), 0)
        );

  return {
    settlement: {
      mode,
      winnerSide,
      startPrice: startSnapshot.price,
      endPrice: endSnapshot.price
    },
    payoutsByEntryId,
    feeCents,
    settledAtMs: Date.now()
  };
}

function buildRefundSettlement(entries: SimEntry[]): SimRoundSettlementSnapshot {
  const totalCents = entries.reduce((sum, item) => sum + Math.round(item.stakeBucks * 100), 0);
  const feeCents = 0;
  const distributableCents = Math.max(0, totalCents - feeCents);
  const payoutsByEntryId = proRataCents(
    entries.map((item) => ({ entryId: item.id, cents: Math.round(item.stakeBucks * 100) })),
    distributableCents,
    totalCents
  );
  return {
    settlement: {
      mode: "REFUND",
      startPrice: 0,
      endPrice: 0
    },
    payoutsByEntryId,
    feeCents,
    settledAtMs: Date.now()
  };
}

function fromPersistedSettlement(
  persisted: Awaited<ReturnType<typeof readSimRoundSettlement>>
): SimRoundSettlementSnapshot | null {
  if (!persisted) {
    return null;
  }
  return {
    settlement: persisted.settlement,
    payoutsByEntryId: persisted.payoutsByEntryId,
    feeCents: persisted.feeCents,
    settledAtMs: persisted.settledAtMs
  };
}

async function settleRoundSafe(entries: SimEntry[]): Promise<SimRoundSettlementSnapshot> {
  try {
    return await settleRound(entries);
  } catch {
    return buildRefundSettlement(entries);
  }
}

export async function settleSimRoundOnce(roundId: string): Promise<SimRoundSettlementSnapshot | null> {
  const existing = fromPersistedSettlement(await readSimRoundSettlement(roundId));
  if (existing) {
    return existing;
  }

  const inFlight = inFlightSettlements.get(roundId);
  if (inFlight) {
    return inFlight;
  }

  const run = (async () => {
    const recheck = fromPersistedSettlement(await readSimRoundSettlement(roundId));
    if (recheck) {
      return recheck;
    }

    const fullRoundEntries = await readSimEntriesForRoundIds([roundId]);
    if (fullRoundEntries.length === 0) {
      return null;
    }

    const settled = await settleRoundSafe(fullRoundEntries);
    await writeSimRoundSettlement({
      roundId,
      settlement: settled.settlement,
      payoutsByEntryId: settled.payoutsByEntryId,
      feeCents: settled.feeCents,
      settledAtMs: settled.settledAtMs
    });
    const canonical = fromPersistedSettlement(await readSimRoundSettlement(roundId));
    return canonical ?? settled;
  })().finally(() => {
    inFlightSettlements.delete(roundId);
  });

  inFlightSettlements.set(roundId, run);
  return run;
}

export async function settleDueSimRounds(limit = 250): Promise<{ checked: number; settled: number; rounds: string[] }> {
  const nowMs = Date.now();
  const ledger = await readSimLedger();
  const dueRoundIds = [...new Set(ledger.entries.filter((entry) => entry.roundEndMs <= nowMs).map((entry) => entry.roundId))].slice(
    0,
    limit
  );
  let settled = 0;
  const settledRoundIds: string[] = [];

  for (const roundId of dueRoundIds) {
    const existing = await readSimRoundSettlement(roundId);
    if (existing) {
      continue;
    }
    const result = await settleSimRoundOnce(roundId);
    if (result) {
      settled += 1;
      settledRoundIds.push(roundId);
    }
  }

  if (settled > 0) {
    await auditLog("INFO", "sim_settle.batch_completed", {
      checked: dueRoundIds.length,
      settled
    });
  }

  return { checked: dueRoundIds.length, settled, rounds: settledRoundIds };
}

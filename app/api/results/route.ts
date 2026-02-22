import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { readLedger } from "@/lib/round-ledger";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const wallet = url.searchParams.get("wallet");
    const limitParam = Number(url.searchParams.get("limit") ?? "50");
    const offsetParam = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number.isFinite(limitParam) ? Math.min(200, Math.max(1, Math.floor(limitParam))) : 50;
    const offset = Number.isFinite(offsetParam) ? Math.max(0, Math.floor(offsetParam)) : 0;

    if (!wallet) {
      return NextResponse.json({ error: "Missing wallet query parameter" }, { status: 400 });
    }

    try {
      new PublicKey(wallet);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    const ledger = await readLedger();

    const walletEntries = ledger.entries.filter((entry) => entry.wallet === wallet);

    const settlementByRound = new Map(ledger.settlements.map((item) => [item.roundId, item]));
    const payoutBySignature = new Map<string, number>();

    const entriesByRound = new Map<string, typeof walletEntries>();
    for (const entry of walletEntries) {
      const current = entriesByRound.get(entry.roundId) ?? [];
      current.push(entry);
      entriesByRound.set(entry.roundId, current);
    }

    for (const [roundId, entries] of entriesByRound) {
      const settlement = settlementByRound.get(roundId);
      const settlementFinal = settlement && settlement.state !== "PROCESSING" ? settlement : null;
      if (!settlementFinal) {
        continue;
      }

      const walletRoundPayout =
        settlementFinal.transfers
          .filter((transfer) => transfer.wallet === wallet)
          .reduce((sum, transfer) => sum + transfer.lamports, 0) ?? 0;

      if (settlementFinal.mode === "REFUND") {
        const roundWalletStake = entries.reduce((sum, entry) => sum + entry.stakeLamports, 0);
        if (roundWalletStake === 0 || walletRoundPayout === 0) {
          for (const entry of entries) {
            payoutBySignature.set(entry.signature, 0);
          }
          continue;
        }

        const allocations = entries.map((entry) => ({
          signature: entry.signature,
          lamports: Math.floor((walletRoundPayout * entry.stakeLamports) / roundWalletStake)
        }));
        const allocated = allocations.reduce((sum, item) => sum + item.lamports, 0);
        const remainder = walletRoundPayout - allocated;
        if (remainder > 0 && allocations.length > 0) {
          allocations[0].lamports += remainder;
        }

        for (const entry of entries) {
          payoutBySignature.set(entry.signature, 0);
        }
        for (const item of allocations) {
          payoutBySignature.set(item.signature, item.lamports);
        }
        continue;
      }

      const winningEntries = entries.filter((entry) => settlementFinal.winnerSide === entry.direction);
      const winningStake = winningEntries.reduce((sum, entry) => sum + entry.stakeLamports, 0);
      if (winningEntries.length === 0 || winningStake === 0 || walletRoundPayout === 0) {
        for (const entry of entries) {
          payoutBySignature.set(entry.signature, 0);
        }
        continue;
      }

      const allocations = winningEntries.map((entry) => ({
        signature: entry.signature,
        lamports: Math.floor((walletRoundPayout * entry.stakeLamports) / winningStake)
      }));
      const allocated = allocations.reduce((sum, item) => sum + item.lamports, 0);
      const remainder = walletRoundPayout - allocated;
      if (remainder > 0 && allocations.length > 0) {
        allocations[0].lamports += remainder;
      }

      for (const entry of entries) {
        payoutBySignature.set(entry.signature, 0);
      }
      for (const item of allocations) {
        payoutBySignature.set(item.signature, item.lamports);
      }
    }

    const rounds = walletEntries
      .map((entry) => {
      const settlement = settlementByRound.get(entry.roundId);
        const settlementFinal = settlement && settlement.state !== "PROCESSING" ? settlement : null;
        const payoutLamports = settlementFinal ? payoutBySignature.get(entry.signature) ?? 0 : 0;
        const payoutSignatures =
          settlementFinal?.transfers
            .filter((transfer) => transfer.wallet === wallet)
            .map((transfer) => transfer.signature) ?? [];

        let status: "PENDING" | "WIN" | "LOSS" | "REFUND" = "PENDING";
        if (settlementFinal) {
          if (settlementFinal.mode === "REFUND") {
            status = "REFUND";
          } else {
            status = settlementFinal.winnerSide === entry.direction ? "WIN" : "LOSS";
          }
        }

        return {
          roundId: entry.roundId,
          roundStartMs: entry.roundStartMs,
          roundEndMs: entry.roundEndMs,
          joinedAtMs: entry.joinedAtMs,
          direction: entry.direction,
          entrySignature: entry.signature,
          stakeLamports: entry.stakeLamports,
          stakeUsd: entry.stakeUsd,
          status,
          payoutLamports,
          payoutSignatures,
          pnlLamports: settlementFinal ? payoutLamports - entry.stakeLamports : null,
          settlement: settlementFinal
            ? {
                mode: settlementFinal.mode,
                winnerSide: settlementFinal.winnerSide,
                startPrice: settlementFinal.startPrice,
                endPrice: settlementFinal.endPrice,
                settledAtMs: settlementFinal.settledAtMs
              }
            : null
        };
      })
      .sort((a, b) => b.joinedAtMs - a.joinedAtMs);
    const pagedRounds = rounds.slice(offset, offset + limit);

    const settledRounds = rounds.filter((round) => round.status !== "PENDING");
    const totals = {
      stakedLamports: rounds.reduce((sum, round) => sum + round.stakeLamports, 0),
      paidLamports: settledRounds.reduce((sum, round) => sum + round.payoutLamports, 0),
      pnlLamports: settledRounds.reduce((sum, round) => sum + (round.pnlLamports ?? 0), 0)
    };

    return NextResponse.json({ wallet, rounds: pagedRounds, totals, paging: { limit, offset, total: rounds.length } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown results error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

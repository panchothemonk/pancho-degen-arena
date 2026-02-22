"use client";

import {
  clusterApiUrl,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildClaimInstruction,
  buildJoinRoundInstruction,
  decodePositionAccount,
  decodeRoundAccount,
  derivePositionPda,
  deriveRoundPda,
  estimatePositionPayoutLamports,
  marketKeyToCode,
  roundStartMsFromRoundId
} from "@/lib/onchain-pvp";
import { MARKET_CONFIGS, type MarketConfig } from "@/lib/oracle";

type Direction = "UP" | "DOWN";
type Stake = 5 | 10 | 25 | 50 | 100 | 250;

type OracleSnapshot = {
  market: string;
  asset: string;
  source: "Pyth Hermes";
  feedId: string;
  price: number;
  confidence: number;
  publishTime: number;
  devnetSlot: number;
  devnetEndpoint: string;
  fetchedAt: string;
};

type WalletRoundResult = {
  roundId: string;
  roundStartMs: number;
  roundEndMs: number;
  joinedAtMs: number;
  direction: Direction;
  entrySignature: string;
  stakeLamports: number;
  stakeUsd: number;
  status: "PENDING" | "WIN" | "LOSS" | "REFUND";
  payoutLamports: number;
  payoutSignatures: string[];
  pnlLamports: number | null;
  settlement: {
    mode: "WIN" | "REFUND";
    winnerSide?: Direction;
    startPrice: number;
    endPrice: number;
    settledAtMs: number;
  } | null;
};

type TxReceipt = {
  market: string;
  roundId: string;
  direction: Direction;
  stakeUsd: number;
  stakeSol: number;
  signature: string;
  explorer: string;
  status: "CONFIRMED" | "SUBMITTED";
};

type OnchainReceipt = TxReceipt & {
  joinedAtMs: number;
};

type OnchainClaimState = {
  roundStatus: "OPEN" | "LOCKED" | "SETTLED" | "UNKNOWN";
  claimableLamports: number;
  claimed: boolean;
  claimTxSignature?: string;
  error?: string;
  updatedAtMs: number;
};

type ToastTone = "SUCCESS" | "ERROR";

type ClaimToast = {
  id: string;
  tone: ToastTone;
  text: string;
};

type ClaimHistoryItem = {
  id: string;
  roundId: string;
  market: string;
  direction: Direction;
  claimLamports: number;
  claimTxSignature?: string;
  status: "SUCCESS" | "FAILED";
  timestampMs: number;
  error?: string;
};

type EntryWindow = {
  startMs: number;
  lockMs: number;
  nextStartMs: number;
  status: "OPEN" | "LOCKED";
};

type RoundWindow = {
  roundId: string;
  startMs: number;
  endMs: number;
};


type WalletProvider = {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: PublicKey;
  connect: (options?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PublicKey }>;
  disconnect?: () => Promise<void>;
  signAndSendTransaction: (tx: Transaction) => Promise<{ signature: string }>;
};

type SimPoolStats = {
  roundId: string;
  market: string;
  totalBucks: number;
  upBucks: number;
  downBucks: number;
  players: number;
  entries: number;
};

type RuntimeStatus = {
  ok: boolean;
  status: "ok" | "degraded" | "paused";
  joinsPaused: boolean;
  settlementPaused: boolean;
  pendingDueRounds: number;
  maxSettlementLagMs: number;
  updatedAtMs: number;
};

type WalletWindow = Window & {
  phantom?: {
    solana?: WalletProvider;
  };
  solflare?: WalletProvider;
  solana?: WalletProvider;
};

const STAKES: Stake[] = [5, 10, 25, 50, 100, 250];
const OPEN_ENTRY_SECONDS = 60;
const LOCK_SECONDS = 60;
const ENTRY_CYCLE_SECONDS = OPEN_ENTRY_SECONDS + LOCK_SECONDS;
const SETTLEMENT_DURATION_SECONDS = 5 * 60;
const PLATFORM_FEE_BPS = 600;
const ESCROW_WALLET = process.env.NEXT_PUBLIC_ESCROW_WALLET ?? "Dkm5UeGTaeXDkauBMtNwbHGw7q2aXbrqb9HBQVN5GFx8";
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USE_ONCHAIN_PROGRAM = process.env.NEXT_PUBLIC_USE_ONCHAIN_PROGRAM === "true";
const SIM_MODE = process.env.NEXT_PUBLIC_SIM_MODE === "true";
const FETCH_TIMEOUT_MS = 12_000;
const MAX_PENDING_MS = 20_000;
const ROUNDS_CACHE_KEY_PREFIX = "pancho_rounds_cache_v1:";
const CLAIM_HISTORY_CACHE_KEY_PREFIX = "pancho_claim_history_v1:";
const ROUND_STATUS_OPEN = 0;
const ROUND_STATUS_LOCKED = 1;
const ROUND_STATUS_SETTLED = 2;

function toRoundStatusLabel(status: number): "OPEN" | "LOCKED" | "SETTLED" | "UNKNOWN" {
  if (status === ROUND_STATUS_OPEN) return "OPEN";
  if (status === ROUND_STATUS_LOCKED) return "LOCKED";
  if (status === ROUND_STATUS_SETTLED) return "SETTLED";
  return "UNKNOWN";
}

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  let maxFractionDigits = 4;
  if (abs >= 1) {
    maxFractionDigits = 4;
  } else if (abs >= 0.01) {
    maxFractionDigits = 6;
  } else if (abs >= 0.0001) {
    maxFractionDigits = 8;
  } else {
    maxFractionDigits = 10;
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: maxFractionDigits
  }).format(value);
}

function formatSol(value: number): string {
  return `${value.toFixed(5)} SOL`;
}

function formatLamports(lamports: number): string {
  return formatSol(lamports / LAMPORTS_PER_SOL);
}

function formatBucksFromCents(cents: number): string {
  return `${(cents / 100).toFixed(2)} PB`;
}

function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(minutes).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;
}

function directionLabel(direction: Direction): "BULL" | "BEAR" {
  return direction === "UP" ? "BULL" : "BEAR";
}

function winnerLabel(winnerSide?: Direction): string {
  if (!winnerSide) {
    return "Refund";
  }
  return directionLabel(winnerSide);
}

function shortAddress(value: string, lead = 10, tail = 8): string {
  if (value.length <= lead + tail + 3) {
    return value;
  }
  return `${value.slice(0, lead)}...${value.slice(-tail)}`;
}

function getStatusClass(status: "OPEN" | "LOCKED" | "PENDING" | "WIN" | "LOSS" | "REFUND"): string {
  switch (status) {
    case "OPEN":
    case "WIN":
      return "status-pill status-pill-win";
    case "LOCKED":
    case "PENDING":
      return "status-pill status-pill-pending";
    case "LOSS":
      return "status-pill status-pill-loss";
    case "REFUND":
      return "status-pill status-pill-refund";
    default:
      return "status-pill";
  }
}

function claimHistoryCacheKey(wallet: string): string {
  return `${CLAIM_HISTORY_CACHE_KEY_PREFIX}${wallet}`;
}

function getEntryWindow(nowMs: number): EntryWindow {
  const windowMs = ENTRY_CYCLE_SECONDS * 1000;
  const startMs = Math.floor(nowMs / windowMs) * windowMs;
  const lockMs = startMs + OPEN_ENTRY_SECONDS * 1000;
  const nextStartMs = startMs + windowMs;
  const status = nowMs < lockMs ? "OPEN" : "LOCKED";

  return {
    startMs,
    lockMs,
    nextStartMs,
    status
  };
}

function getRoundWindow(entryStartMs: number, marketKey: string): RoundWindow {
  const settleStartMs = entryStartMs + OPEN_ENTRY_SECONDS * 1000;
  return {
    roundId: `${marketKey}-${Math.floor(entryStartMs / 1000)}-5m`,
    startMs: entryStartMs,
    endMs: settleStartMs + SETTLEMENT_DURATION_SECONDS * 1000
  };
}

function getProvider(): WalletProvider | null {
  if (typeof window === "undefined") {
    return null;
  }

  const win = window as WalletWindow;
  const phantom = win.phantom?.solana;
  const solflare = win.solflare;
  const injected = win.solana;

  // Prefer explicit Solana wallets over any generic injected provider.
  if (phantom?.isPhantom) {
    return phantom;
  }
  if (solflare?.isSolflare) {
    return solflare;
  }
  if (injected?.isPhantom || injected?.isSolflare) {
    return injected;
  }
  return phantom ?? solflare ?? injected ?? null;
}

function getStakeSol(stakeUsd: Stake, price: number | null): number {
  if (!price || price <= 0) {
    return 0;
  }

  return stakeUsd / price;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function toFriendlyWalletError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const msg = raw.trim();
  if (!msg) {
    return fallback;
  }

  if (/operation not permitted|not permitted|user rejected|rejected/i.test(msg)) {
    return "Wallet blocked the request. Open Phantom/Solflare, unlock, and approve the action.";
  }

  return msg;
}

async function waitForConfirmation(connection: Connection, signature: string, timeoutMs = 25000): Promise<"confirmed" | "timed_out"> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatus(signature);
    const value = status.value;

    if (value?.err) {
      throw new Error("Transaction failed onchain.");
    }

    if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") {
      return "confirmed";
    }

    await sleep(1200);
  }

  return "timed_out";
}

export default function UpDownTerminal() {
  const [snapshot, setSnapshot] = useState<OracleSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [direction, setDirection] = useState<Direction>("UP");
  const [stake, setStake] = useState<Stake>(10);
  const [selectedMarketKey, setSelectedMarketKey] = useState<string>("SOL");

  const [tick, setTick] = useState<number>(0);
  const [mounted, setMounted] = useState<boolean>(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [txPending, setTxPending] = useState<boolean>(false);
  const [txPendingStartedAt, setTxPendingStartedAt] = useState<number | null>(null);
  const [txReceipt, setTxReceipt] = useState<TxReceipt | null>(null);
  const [onchainReceipts, setOnchainReceipts] = useState<OnchainReceipt[]>([]);
  const [onchainClaimStates, setOnchainClaimStates] = useState<Record<string, OnchainClaimState>>({});
  const [claimPendingByReceipt, setClaimPendingByReceipt] = useState<Record<string, boolean>>({});
  const [claimHistory, setClaimHistory] = useState<ClaimHistoryItem[]>([]);
  const [claimToasts, setClaimToasts] = useState<ClaimToast[]>([]);
  const [walletRounds, setWalletRounds] = useState<WalletRoundResult[]>([]);
  const [roundCarouselIndex, setRoundCarouselIndex] = useState<number>(0);
  const [showHowTo, setShowHowTo] = useState<boolean>(false);
  const [showPayoutMath, setShowPayoutMath] = useState<boolean>(false);
  const [walletTotals, setWalletTotals] = useState<{ stakedLamports: number; paidLamports: number; pnlLamports: number } | null>(null);
  const [poolStats, setPoolStats] = useState<SimPoolStats | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const pendingResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const nowMs = tick || 1;
  const entryWindow = useMemo(() => getEntryWindow(nowMs), [nowMs]);
  const selectedMarket = useMemo<MarketConfig>(() => {
    return MARKET_CONFIGS.find((market) => market.key === selectedMarketKey) ?? MARKET_CONFIGS[0];
  }, [selectedMarketKey]);
  const currentRound = useMemo(
    () => getRoundWindow(entryWindow.startMs, selectedMarket.key),
    [entryWindow.startMs, selectedMarket.key]
  );

  const secondsToLock = Math.max(0, (entryWindow.lockMs - nowMs) / 1000);
  const secondsToNextRound = Math.max(0, (entryWindow.nextStartMs - nowMs) / 1000);

  const stakeSol = useMemo(() => getStakeSol(stake, snapshot?.price ?? null), [stake, snapshot?.price]);
  const feeUsd = useMemo(() => stake * (PLATFORM_FEE_BPS / 10_000), [stake]);
  const roughWinUsd = useMemo(() => stake * (2 - PLATFORM_FEE_BPS / 10_000), [stake]);
  const canJoinRound = !!snapshot && !!walletAddress && entryWindow.status === "OPEN" && !txPending;
  const isProgramMode = USE_ONCHAIN_PROGRAM;
  const activeCardsCount = isProgramMode ? onchainReceipts.length : walletRounds.length;
  const maxCarouselStart = Math.max(0, activeCardsCount - 3);
  const carouselIndex = Math.min(roundCarouselIndex, maxCarouselStart);
  const claimReadyReceipts = useMemo(
    () =>
      onchainReceipts.filter((receipt) => {
        const claimState = onchainClaimStates[receipt.signature];
        return Boolean(
          claimState &&
            claimState.roundStatus === "SETTLED" &&
            !claimState.claimed &&
            claimState.claimableLamports > 0 &&
            !claimPendingByReceipt[receipt.signature]
        );
      }),
    [onchainReceipts, onchainClaimStates, claimPendingByReceipt]
  );
  const totalClaimableLamports = useMemo(
    () =>
      onchainReceipts.reduce((sum, receipt) => {
        const claimState = onchainClaimStates[receipt.signature];
        if (!claimState || claimState.claimed || claimState.claimableLamports <= 0) {
          return sum;
        }
        return sum + claimState.claimableLamports;
      }, 0),
    [onchainReceipts, onchainClaimStates]
  );
  const claimedReceiptsCount = useMemo(
    () => onchainReceipts.filter((receipt) => onchainClaimStates[receipt.signature]?.claimed).length,
    [onchainReceipts, onchainClaimStates]
  );

  function pushClaimToast(tone: ToastTone, text: string) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    setClaimToasts((prev) => [...prev, { id, tone, text }].slice(-4));
    setTimeout(() => {
      setClaimToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 4200);
  }

  function appendClaimHistory(item: ClaimHistoryItem) {
    setClaimHistory((prev) => {
      const next = [item, ...prev].slice(0, 40);
      if (walletAddress && typeof window !== "undefined") {
        localStorage.setItem(claimHistoryCacheKey(walletAddress), JSON.stringify(next));
      }
      return next;
    });
  }

  function clearPendingGuard() {
    if (pendingResetRef.current) {
      clearTimeout(pendingResetRef.current);
      pendingResetRef.current = null;
    }
    setTxPending(false);
    setTxPendingStartedAt(null);
  }

  function armPendingGuard() {
    if (pendingResetRef.current) {
      clearTimeout(pendingResetRef.current);
    }
    pendingResetRef.current = setTimeout(() => {
      setTxPending(false);
      setTxPendingStartedAt(null);
      setError("Request took too long. No bet was confirmed. Try again.");
    }, MAX_PENDING_MS);
  }

  async function loadSnapshot() {
    try {
      const res = await fetchWithTimeout(`/api/oracle?market=${selectedMarket.key}`, { cache: "no-store" }, 8_000);
      const data = (await res.json()) as OracleSnapshot | { error: string };

      if (!res.ok) {
        throw new Error("error" in data ? data.error : "Failed to fetch oracle data");
      }

      setSnapshot(data as OracleSnapshot);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "");
      if (/status 429/i.test(message)) {
        // Rate-limit bursts are expected on public endpoints; keep retrying silently.
        return;
      }
      // Avoid flashing transient oracle poll errors when we already have a recent quote.
      if (!snapshot) {
        setError(message || "Unknown error");
      }
    }
  }

  async function loadWalletResults(wallet: string) {
    if (USE_ONCHAIN_PROGRAM) {
      return;
    }

    try {
      const endpoint = SIM_MODE ? `/api/sim/results?wallet=${wallet}` : `/api/results?wallet=${wallet}`;
      const res = await fetch(endpoint, { cache: "no-store" });
      const data = (await res.json()) as
        | { wallet: string; rounds: WalletRoundResult[]; totals: { stakedLamports: number; paidLamports: number; pnlLamports: number } }
        | { error: string };

      if (!res.ok) {
        throw new Error("error" in data ? data.error : "Failed to load wallet results");
      }
      if (!("rounds" in data)) {
        throw new Error("Invalid wallet results payload");
      }

      setWalletRounds(data.rounds);
      setWalletTotals(data.totals);
      if (typeof window !== "undefined") {
        localStorage.setItem(`${ROUNDS_CACHE_KEY_PREFIX}${wallet}`, JSON.stringify({ rounds: data.rounds, totals: data.totals }));
      }
    } catch (err) {
      if (typeof window !== "undefined") {
        const cached = localStorage.getItem(`${ROUNDS_CACHE_KEY_PREFIX}${wallet}`);
        if (cached) {
          try {
            const parsed = JSON.parse(cached) as {
              rounds: WalletRoundResult[];
              totals: { stakedLamports: number; paidLamports: number; pnlLamports: number };
            };
            setWalletRounds(parsed.rounds ?? []);
            setWalletTotals(parsed.totals ?? null);
          } catch {
            // ignore broken cache
          }
        }
      }
      setError(err instanceof Error ? err.message : "Failed to load wallet results");
    }
  }

  async function loadPoolStats(roundId: string) {
    if (!SIM_MODE) {
      return;
    }
    try {
      const res = await fetch(`/api/sim/pool?roundId=${encodeURIComponent(roundId)}`, { cache: "no-store" });
      const data = (await res.json()) as { stats?: SimPoolStats; error?: string };
      if (!res.ok) {
        return;
      }
      if (data.stats) {
        setPoolStats(data.stats);
      }
    } catch {
      // Ignore transient pool poll errors.
    }
  }

  async function loadRuntimeStatus() {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as RuntimeStatus;
      setRuntimeStatus(data);
    } catch {
      // Ignore transient status poll errors.
    }
  }

  async function refreshOnchainClaimStates(targetReceipts: OnchainReceipt[] = onchainReceipts) {
    if (!USE_ONCHAIN_PROGRAM || !walletAddress || targetReceipts.length === 0) {
      return;
    }

    const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? clusterApiUrl("devnet");
    const connection = new Connection(endpoint, "confirmed");
    const user = new PublicKey(walletAddress);
    const next: Record<string, OnchainClaimState> = {};

    for (const receipt of targetReceipts) {
      try {
        const roundStartMs = roundStartMsFromRoundId(receipt.roundId);
        const marketCode = marketKeyToCode(receipt.market);
        const roundPda = deriveRoundPda(marketCode, BigInt(Math.floor(roundStartMs / 1000)));
        const side = receipt.direction === "UP" ? 0 : 1;
        const positionPda = derivePositionPda(roundPda, user, side);
        const [roundInfo, positionInfo] = await connection.getMultipleAccountsInfo([roundPda, positionPda], "confirmed");

        if (!roundInfo || !positionInfo) {
          next[receipt.signature] = {
            roundStatus: "UNKNOWN",
            claimableLamports: 0,
            claimed: false,
            error: "Round/position account not found yet",
            updatedAtMs: Date.now()
          };
          continue;
        }

        const round = decodeRoundAccount(Buffer.from(roundInfo.data));
        const position = decodePositionAccount(Buffer.from(positionInfo.data));
        if (!round || !position) {
          next[receipt.signature] = {
            roundStatus: "UNKNOWN",
            claimableLamports: 0,
            claimed: false,
            error: "Failed to decode round/position data",
            updatedAtMs: Date.now()
          };
          continue;
        }

        const payout = round.status === ROUND_STATUS_SETTLED ? estimatePositionPayoutLamports(round, position) : BigInt(0);
        next[receipt.signature] = {
          roundStatus: toRoundStatusLabel(round.status),
          claimableLamports: Number(payout),
          claimed: position.claimed,
          claimTxSignature: onchainClaimStates[receipt.signature]?.claimTxSignature,
          updatedAtMs: Date.now()
        };
      } catch (error) {
        next[receipt.signature] = {
          roundStatus: "UNKNOWN",
          claimableLamports: 0,
          claimed: false,
          error: error instanceof Error ? error.message : "Failed to fetch onchain claim state",
          updatedAtMs: Date.now()
        };
      }
    }

    setOnchainClaimStates((prev) => ({ ...prev, ...next }));
  }

  async function claimRound(receipt: OnchainReceipt, options: { batch?: boolean } = {}): Promise<boolean> {
    if (!walletAddress) {
      setError("Connect wallet first.");
      return false;
    }
    const claimState = onchainClaimStates[receipt.signature];
    if (!claimState || claimState.roundStatus !== "SETTLED") {
      setError("Round not settled yet.");
      return false;
    }
    if (claimState.claimed) {
      setError("Already claimed.");
      return false;
    }

    const provider = getProvider();
    if (!provider) {
      setError("Wallet provider not found.");
      return false;
    }

    setClaimPendingByReceipt((prev) => ({ ...prev, [receipt.signature]: true }));
    setError(null);
    try {
      const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? clusterApiUrl("devnet");
      const connection = new Connection(endpoint, "confirmed");
      const user = new PublicKey(walletAddress);
      const roundStartMs = roundStartMsFromRoundId(receipt.roundId);
      const claimIx = buildClaimInstruction({
        user,
        marketKey: receipt.market,
        roundStartMs,
        direction: receipt.direction
      });

      const latest = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({
        feePayer: user,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight
      }).add(claimIx);
      const sent = await provider.signAndSendTransaction(tx);
      await waitForConfirmation(connection, sent.signature);

      setOnchainClaimStates((prev) => ({
        ...prev,
        [receipt.signature]: {
          ...(prev[receipt.signature] ?? {
            roundStatus: "SETTLED",
            claimableLamports: 0,
            claimed: false,
            updatedAtMs: Date.now()
          }),
          claimTxSignature: sent.signature,
          error: undefined
        }
      }));
      await refreshOnchainClaimStates([receipt]);
      const claimLamports = onchainClaimStates[receipt.signature]?.claimableLamports ?? 0;
      appendClaimHistory({
        id: `claim-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        roundId: receipt.roundId,
        market: receipt.market,
        direction: receipt.direction,
        claimLamports,
        claimTxSignature: sent.signature,
        status: "SUCCESS",
        timestampMs: Date.now()
      });
      if (!options.batch) {
        pushClaimToast("SUCCESS", `Claim confirmed: ${formatLamports(claimLamports)} (${receipt.market})`);
      }
      return true;
    } catch (err) {
      const friendly = toFriendlyWalletError(err, "Claim failed");
      setError(friendly);
      appendClaimHistory({
        id: `claim-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        roundId: receipt.roundId,
        market: receipt.market,
        direction: receipt.direction,
        claimLamports: onchainClaimStates[receipt.signature]?.claimableLamports ?? 0,
        status: "FAILED",
        timestampMs: Date.now(),
        error: friendly
      });
      if (!options.batch) {
        pushClaimToast("ERROR", `${receipt.market} claim failed. Retry.`);
      }
      return false;
    } finally {
      setClaimPendingByReceipt((prev) => ({ ...prev, [receipt.signature]: false }));
    }
  }

  async function claimAllReady() {
    if (claimReadyReceipts.length === 0) {
      return;
    }
    setError(null);
    let success = 0;
    let failed = 0;
    for (const receipt of claimReadyReceipts) {
      const ok = await claimRound(receipt, { batch: true });
      if (ok) success += 1;
      else failed += 1;
      await sleep(250);
    }
    await refreshOnchainClaimStates(onchainReceipts);
    if (failed === 0) {
      pushClaimToast("SUCCESS", `Claim All complete: ${success} claimed.`);
    } else {
      pushClaimToast("ERROR", `Claim All partial: ${success} claimed, ${failed} failed.`);
    }
  }

  async function connectWallet() {
    try {
      const provider = getProvider();
      if (!provider) {
        throw new Error("No Solana wallet detected. Install Phantom or Solflare.");
      }

      const connected = await provider.connect();
      const wallet = connected.publicKey.toBase58();
      setWalletAddress(wallet);
      setTxReceipt(null);
      if (typeof window !== "undefined") {
        const cachedClaims = localStorage.getItem(claimHistoryCacheKey(wallet));
        if (cachedClaims) {
          try {
            const parsed = JSON.parse(cachedClaims) as ClaimHistoryItem[];
            setClaimHistory(Array.isArray(parsed) ? parsed : []);
          } catch {
            setClaimHistory([]);
          }
        } else {
          setClaimHistory([]);
        }
      }
      if (!USE_ONCHAIN_PROGRAM) {
        await loadWalletResults(wallet);
      } else if (onchainReceipts.length > 0) {
        await refreshOnchainClaimStates(onchainReceipts);
      }
    } catch (err) {
      setError(toFriendlyWalletError(err, "Wallet connection failed"));
    }
  }

  async function disconnectWallet() {
    const provider = getProvider();
    if (provider?.disconnect) {
      await provider.disconnect();
    }
    setWalletAddress(null);
    setOnchainClaimStates({});
    setClaimPendingByReceipt({});
    setClaimHistory([]);
  }

  async function joinRound() {
    if (txPending) {
      return;
    }
    if (!snapshot || !walletAddress || !canJoinRound) {
      return;
    }

    if (SIM_MODE) {
      setTxPending(true);
      setTxPendingStartedAt(Date.now());
      armPendingGuard();
      setTxReceipt(null);
      setError(null);
      try {
        const simulatedSignature = `SIM-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const payload = {
          id: simulatedSignature,
          roundId: currentRound.roundId,
          market: selectedMarket.key,
          feedId: selectedMarket.feedId,
          roundStartMs: currentRound.startMs,
          roundEndMs: currentRound.endMs,
          wallet: walletAddress,
          direction,
          stakeBucks: stake,
          joinedAtMs: Date.now()
        };

        let placed = false;
        let lastError = "Failed to place sim bet.";
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const res = await fetchWithTimeout("/api/sim/entries", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const data = (await res.json()) as { ok?: boolean; error?: string; retryAfterSec?: number };
          if (res.ok && data.ok) {
            placed = true;
            break;
          }

          lastError = data.error ?? "Failed to place sim bet.";
          if (res.status !== 429 || attempt === 1) {
            break;
          }

          const retryAfterSec = Number(data.retryAfterSec ?? 0);
          const waitMs = Math.max(150, Math.min(1_000, Math.floor(retryAfterSec * 1000)));
          await sleep(waitMs);
        }
        if (!placed) {
          throw new Error(lastError);
        }

        setTxReceipt({
          market: selectedMarket.key,
          roundId: currentRound.roundId,
          direction,
          stakeUsd: stake,
          stakeSol: 0,
          signature: simulatedSignature,
          explorer: "#",
          status: "CONFIRMED"
        });
        await loadWalletResults(walletAddress);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setError("Request timed out. Try again in the next open window.");
        } else {
          setError(err instanceof Error ? err.message : "Sim bet failed");
        }
      } finally {
        clearPendingGuard();
      }
      return;
    }

    if (stakeSol <= 0) {
      setError("Stake conversion unavailable. Wait for oracle price.");
      return;
    }

    const provider = getProvider();
    if (!provider) {
      setError("Wallet provider not found.");
      return;
    }

    setTxPending(true);
    setTxPendingStartedAt(Date.now());
    armPendingGuard();
    setTxReceipt(null);
    setError(null);

    try {
      const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? clusterApiUrl("devnet");
      const connection = new Connection(endpoint, "confirmed");
      const from = new PublicKey(walletAddress);
      const lamports = Math.max(1, Math.round(stakeSol * LAMPORTS_PER_SOL));
      const joinIx = buildJoinRoundInstruction({
        user: from,
        marketKey: selectedMarket.key,
        roundStartMs: currentRound.startMs,
        direction,
        lamports
      });
      const to = new PublicKey(ESCROW_WALLET);
      const memo = `PANCHO|${selectedMarket.key}|${currentRound.roundId}|${direction}|${stake}`;
      const transferIx = SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
      const memoIx = new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from(memo, "utf8") });

      const latest = await connection.getLatestBlockhash("confirmed");
      const balance = await connection.getBalance(from, "confirmed");
      if (balance < lamports + 10_000) {
        throw new Error("Insufficient devnet SOL for stake + network fee. Fund wallet on devnet and try again.");
      }

      const tx = new Transaction({
        feePayer: from,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight
      }).add(...(USE_ONCHAIN_PROGRAM ? [joinIx] : [transferIx, memoIx]));

      const sent = await provider.signAndSendTransaction(tx);
      const confirmState = await waitForConfirmation(connection, sent.signature);
      const explorer = `https://explorer.solana.com/tx/${sent.signature}?cluster=devnet`;
      const receipt: OnchainReceipt = {
        market: selectedMarket.key,
        roundId: currentRound.roundId,
        direction,
        stakeUsd: stake,
        stakeSol,
        signature: sent.signature,
        explorer,
        status: confirmState === "confirmed" ? "CONFIRMED" : "SUBMITTED",
        joinedAtMs: Date.now()
      };

      if (confirmState === "confirmed") {
        if (USE_ONCHAIN_PROGRAM) {
          setTxReceipt(receipt);
          setOnchainReceipts((prev) => [receipt, ...prev].slice(0, 20));
          return;
        }

        const registerRes = await fetch("/api/entries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roundId: currentRound.roundId,
            market: selectedMarket.key,
            feedId: selectedMarket.feedId,
            roundStartMs: currentRound.startMs,
            roundEndMs: currentRound.endMs,
            wallet: walletAddress,
            direction,
            stakeUsd: stake,
            stakeLamports: lamports,
            signature: sent.signature,
            joinedAtMs: Date.now(),
            startPrice: snapshot.price
          })
        });

        if (!registerRes.ok) {
          throw new Error("Entry registered onchain but failed to register in ledger.");
        }

        setTxReceipt(receipt);

        await loadWalletResults(walletAddress);
      } else {
        setTxReceipt(receipt);
        if (USE_ONCHAIN_PROGRAM) {
          setOnchainReceipts((prev) => [receipt, ...prev].slice(0, 20));
        }
      }
    } catch (err) {
      const msg = toFriendlyWalletError(err, "Transaction failed");
      if (USE_ONCHAIN_PROGRAM && /0x0|AccountNotInitialized|custom program error/i.test(msg)) {
        setError("On-chain round account is not initialized yet. Run the round creation/lock/settle keeper for this market.");
      } else {
        setError(msg);
      }
    } finally {
      clearPendingGuard();
    }
  }

  async function refreshResultsNow() {
    if (!walletAddress || USE_ONCHAIN_PROGRAM) {
      return;
    }
    await loadWalletResults(walletAddress);
  }

  useEffect(() => {
    setMounted(true);
    setTick(Date.now());

    const provider = getProvider();
    if (provider?.publicKey) {
      const wallet = provider.publicKey.toBase58();
      setWalletAddress(wallet);
      if (typeof window !== "undefined") {
        const cachedClaims = localStorage.getItem(claimHistoryCacheKey(wallet));
        if (cachedClaims) {
          try {
            const parsed = JSON.parse(cachedClaims) as ClaimHistoryItem[];
            setClaimHistory(Array.isArray(parsed) ? parsed : []);
          } catch {
            setClaimHistory([]);
          }
        }
      }
      void loadWalletResults(wallet);
    }

    const clock = setInterval(() => setTick(Date.now()), 250);

    return () => {
      clearInterval(clock);
    };
  }, []);

  useEffect(() => {
    void loadRuntimeStatus();
    const polling = setInterval(() => {
      void loadRuntimeStatus();
    }, 8000);
    return () => clearInterval(polling);
  }, []);

  useEffect(() => {
    void loadSnapshot();
    const polling = setInterval(() => {
      void loadSnapshot();
    }, 8000);

    return () => {
      clearInterval(polling);
    };
  }, [selectedMarket.key]);

  useEffect(() => {
    if (!SIM_MODE) {
      return;
    }
    void loadPoolStats(currentRound.roundId);
    const polling = setInterval(() => {
      void loadPoolStats(currentRound.roundId);
    }, 4000);
    return () => {
      clearInterval(polling);
    };
  }, [currentRound.roundId]);

  useEffect(() => {
    if (!USE_ONCHAIN_PROGRAM || !walletAddress || onchainReceipts.length === 0) {
      return;
    }
    void refreshOnchainClaimStates(onchainReceipts);
    const polling = setInterval(() => {
      void refreshOnchainClaimStates(onchainReceipts);
    }, 8000);
    return () => {
      clearInterval(polling);
    };
  }, [walletAddress, onchainReceipts]);

  useEffect(() => {
    if (USE_ONCHAIN_PROGRAM) {
      return;
    }

    if (!walletAddress) {
      setWalletRounds([]);
      setWalletTotals(null);
      setRoundCarouselIndex(0);
      return;
    }

    void loadWalletResults(walletAddress);
    const resultsPoll = setInterval(() => {
      void loadWalletResults(walletAddress);
    }, 5000);

    return () => {
      clearInterval(resultsPoll);
    };
  }, [walletAddress]);

  useEffect(() => {
    setRoundCarouselIndex((prev) => Math.min(prev, Math.max(0, activeCardsCount - 3)));
  }, [activeCardsCount]);

  useEffect(() => {
    if (!txPending || !txPendingStartedAt) {
      return;
    }

    const elapsed = Date.now() - txPendingStartedAt;
    const remaining = Math.max(0, MAX_PENDING_MS - elapsed);
    const timeout = setTimeout(() => {
      setTxPending(false);
      setTxPendingStartedAt(null);
      setError("Request took too long. No bet was confirmed. Try again.");
    }, remaining);

    return () => clearTimeout(timeout);
  }, [txPending, txPendingStartedAt]);

  useEffect(() => {
    return () => {
      if (pendingResetRef.current) {
        clearTimeout(pendingResetRef.current);
      }
    };
  }, []);

  return (
    <section className="terminal">
      <div className="terminal-head">
        <h2>Pancho Degen Round Terminal</h2>
        <div className="wallet-actions">
          {walletAddress ? (
            <button type="button" className="ghost-button" onClick={() => void disconnectWallet()}>
              Disconnect {walletAddress.slice(0, 4)}...{walletAddress.slice(-4)}
            </button>
          ) : (
            <button type="button" className="ghost-button" onClick={() => void connectWallet()}>
              Connect Phantom Wallet
            </button>
          )}
        </div>
      </div>

      <p className="launch-banner">
        <span className="launch-live-dot" aria-hidden="true" />
        SOL MAINNET PLAYER VS PLAYER launch coming soon. This is the degen preview.
      </p>
      {runtimeStatus && runtimeStatus.status !== "ok" ? (
        <div className={`runtime-alert runtime-alert-${runtimeStatus.status}`}>
          {runtimeStatus.status === "paused"
            ? "Arena safety mode is active. New joins or settlement may be temporarily paused."
            : `Arena is in degraded mode. Pending due rounds: ${Math.max(0, runtimeStatus.pendingDueRounds)}.`}
        </div>
      ) : null}

      <div className="oracle-grid">
        <article>
          <span>Market</span>
          <strong>{selectedMarket.label}</strong>
        </article>
        <article>
          <span>Oracle Price</span>
          <strong>{snapshot ? formatUsd(snapshot.price) : "Loading"}</strong>
        </article>
        <article>
          <span>Pool Id</span>
          <strong>{currentRound.roundId}</strong>
        </article>
        <article>
          <span>Entry Status</span>
          <strong>
            <span className={getStatusClass(entryWindow.status)}>{entryWindow.status}</span>
          </strong>
        </article>
      </div>

      <div className={`round-live ${entryWindow.status === "OPEN" ? "round-live-open" : "round-live-locked"}`}>
        <div className="round-live-head">
          <p>Pancho Arena Window</p>
          <div className="guide-actions">
            <button type="button" className="ghost-button guide-toggle" onClick={() => setShowHowTo((prev) => !prev)}>
              {showHowTo ? "Hide How To" : "How To Degen"}
            </button>
            <button type="button" className="ghost-button guide-toggle" onClick={() => setShowPayoutMath((prev) => !prev)}>
              {showPayoutMath ? "Hide Payout Math" : "Payout Math"}
            </button>
          </div>
        </div>
        <strong className={entryWindow.status === "OPEN" ? "timer-pulse" : ""}>
          {entryWindow.status === "OPEN"
            ? `Join closes in ${secondsToLock.toFixed(1)}s`
            : `Next round opens in ${secondsToNextRound.toFixed(1)}s`}
        </strong>
        {SIM_MODE ? (
          <span className="round-live-pool">
            Pool: {poolStats ? `${poolStats.totalBucks.toFixed(2)} PB` : "0.00 PB"} | Bull: {poolStats ? `${poolStats.upBucks.toFixed(2)} PB` : "0.00 PB"} | Bear:{" "}
            {poolStats ? `${poolStats.downBucks.toFixed(2)} PB` : "0.00 PB"} | Players: {poolStats?.players ?? 0}
          </span>
        ) : null}
      </div>

      {showHowTo ? (
        <div className="degen-how">
          <p>How Pancho Works</p>
          <div className="degen-steps">
            <span>1. Pick coin. Pick BULL or BEAR. Lock your size.</span>
            <span>2. If timer says OPEN, ape in. If LOCKED, wait next window.</span>
            <span>3. Oracle settles 5 minutes after lock.</span>
            <span>4. Win = stake back + profit. Lose = payout $0 (you lose your stake).</span>
          </div>
        </div>
      ) : null}

      {showPayoutMath ? (
        <div className="degen-how">
          <p>Payout Math (Pro-Rata)</p>
          <div className="degen-steps">
            <span>This ain&apos;t 1v1. It&apos;s one big degen pool.</span>
            <span>After Pancho takes 6%, winners split the rest by bag size.</span>
            <span>Payout pool = (Winner Side + Loser Side) * 0.94</span>
            <span>Your payout = (Your stake / Total winner stake) * Payout pool</span>
            <span>Win = stake back + profit. Lose = payout $0 (you lose your stake).</span>
            <span>Example: Bull side total $250, Bear side total $90, total pool $340, fee 6%, payout pool $319.60.</span>
            <span>If Bull wins: $25 stake gets $31.96. $10 stake gets $12.78.</span>
          </div>
        </div>
      ) : null}

      <div className="status-strip">
        <article>
          <span>Live Feed</span>
          <strong>{snapshot?.asset ?? "..."}</strong>
        </article>
        <article>
          <span>Price</span>
          <strong>{snapshot ? formatUsd(snapshot.price) : "..."}</strong>
        </article>
        <article>
          <span>Platform Fee</span>
          <strong>6%</strong>
        </article>
        <article>
          <span>Settlement</span>
          <strong>5m post-lock</strong>
        </article>
      </div>

      <div className="picker-row">
        <div>
          <p>Market</p>
          <div className="chips">
            {MARKET_CONFIGS.map((market) => (
              <button
                key={market.key}
                type="button"
                className={selectedMarket.key === market.key ? "chip active" : "chip"}
                onClick={() => setSelectedMarketKey(market.key)}
                disabled={!mounted || entryWindow.status !== "OPEN"}
              >
                {market.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p>Direction</p>
          <div className="chips">
            <button
              type="button"
              className={direction === "UP" ? "chip active" : "chip"}
              onClick={() => setDirection("UP")}
              disabled={!mounted || entryWindow.status !== "OPEN"}
            >
              BULL
            </button>
            <button
              type="button"
              className={direction === "DOWN" ? "chip active" : "chip"}
              onClick={() => setDirection("DOWN")}
              disabled={!mounted || entryWindow.status !== "OPEN"}
            >
              BEAR
            </button>
          </div>
        </div>

        <div>
          <p>{SIM_MODE ? "Stake (Pancho Bucks)" : "Stake (USD Target)"}</p>
          <div className="chips">
            {STAKES.map((item) => (
              <button
                key={item}
                type="button"
                className={stake === item ? "chip active" : "chip"}
                onClick={() => setStake(item)}
                disabled={!mounted || entryWindow.status !== "OPEN"}
              >
                ${item}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p>{SIM_MODE ? "Pancho Bucks Slip" : "Escrow Deposit"}</p>
          <div className="escrow-box">
            {SIM_MODE ? (
              <>
                <span>{stake.toFixed(2)} PB play stake</span>
                <span>Pancho tax: {(stake * 0.06).toFixed(2)} PB (6%)</span>
                <span>Est. upside (balanced pool): ~{(stake * 1.94).toFixed(2)} PB</span>
                <span className="mono">Sim mode: no real SOL leaves wallet.</span>
              </>
            ) : (
              <>
                <span>{snapshot ? `${formatUsd(stake)} -> ${formatSol(stakeSol)}` : "Waiting for oracle quote"}</span>
                <span>Platform fee: {formatUsd(feeUsd)} (6%)</span>
                <span>Est. upside (balanced pool): ~{formatUsd(roughWinUsd)}</span>
                <span className="mono">Escrow: {ESCROW_WALLET.slice(0, 6)}...{ESCROW_WALLET.slice(-6)}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="actions">
        <button type="button" className="primary-button" onClick={() => void joinRound()} disabled={!canJoinRound}>
          {txPending ? "Confirming..." : SIM_MODE ? "Ape Sim Bet (Pancho Bucks)" : "Join Round (Devnet Deposit)"}
        </button>
      </div>

      {txReceipt ? (
        <article className="trade-ticket">
          <div className="trade-ticket-head">
            <strong>Trade Ticket</strong>
            <span>{txReceipt.status}</span>
          </div>
          <p>
            {SIM_MODE
              ? `${txReceipt.market} | ${directionLabel(txReceipt.direction)} | ${txReceipt.stakeUsd.toFixed(2)} PB`
              : `${txReceipt.market} | ${directionLabel(txReceipt.direction)} | ${formatUsd(txReceipt.stakeUsd)} (${formatSol(txReceipt.stakeSol)})`}
          </p>
          <p className="mono">Round: {txReceipt.roundId}</p>
          <div className="trade-ticket-actions">
            <span className="mono">{shortAddress(txReceipt.signature)}</span>
            {!SIM_MODE ? (
              <a href={txReceipt.explorer} target="_blank" rel="noreferrer" className="ticket-link">
                View tx
              </a>
            ) : (
              <span className="ticket-link">Sim ticket</span>
            )}
          </div>
        </article>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      <p className="footnote">
        Source: {snapshot?.source ?? "Pyth"} | Feed: {snapshot?.feedId.slice(0, 10) ?? "-"}... | Slot: {snapshot?.devnetSlot ?? "-"}
      </p>
      <p className="footnote">
        {SIM_MODE
          ? "Preview mode is live with Pancho Bucks on shared pools. Real SOL wagers go live at mainnet launch."
          : USE_ONCHAIN_PROGRAM
          ? "Onchain mode live: your join hits Pancho program directly."
          : "Keeper mode live: server settles and pays results."}
      </p>

      <div className="results-panel">
        <div className="results-head">
          <h3>{USE_ONCHAIN_PROGRAM ? "Recent Transactions" : "Your Rounds"}</h3>
          {!USE_ONCHAIN_PROGRAM ? (
            <button type="button" className="ghost-button" onClick={() => void refreshResultsNow()} disabled={!walletAddress}>
              Refresh Results
            </button>
          ) : null}
        </div>
        {USE_ONCHAIN_PROGRAM ? (
          <>
            <p className="footnote">
              Onchain mode: join now, then claim later after settle. Claims can stack across rounds.
            </p>
            {!walletAddress ? <p className="footnote">Connect wallet to view transactions.</p> : null}
            {walletAddress && onchainReceipts.length === 0 ? <p className="footnote">No join transactions yet in this session.</p> : null}
            {onchainReceipts.length > 0 ? (
              <div className="results-carousel">
                <article className="claim-queue">
                  <strong>Claim Queue</strong>
                  <span>Ready now: {claimReadyReceipts.length}</span>
                  <span>Total claimable: {formatLamports(totalClaimableLamports)}</span>
                  <span>Already claimed: {claimedReceiptsCount}</span>
                  <div className="trade-ticket-actions">
                    <button type="button" className="expand-toggle" onClick={() => void refreshOnchainClaimStates(onchainReceipts)}>
                      Refresh Claims
                    </button>
                    <button type="button" className="primary-button" onClick={() => void claimAllReady()} disabled={claimReadyReceipts.length === 0}>
                      Claim All Ready
                    </button>
                  </div>
                </article>
                <div className="carousel-track">
                  {onchainReceipts.slice(carouselIndex, carouselIndex + 3).map((receipt) => (
                    <article key={receipt.signature} className="result-card">
                      {(() => {
                        const claimState = onchainClaimStates[receipt.signature];
                        const claimPending = Boolean(claimPendingByReceipt[receipt.signature]);
                        const canClaim = Boolean(
                          claimState &&
                            claimState.roundStatus === "SETTLED" &&
                            !claimState.claimed &&
                            claimState.claimableLamports > 0 &&
                            !claimPending
                        );
                        return (
                          <>
                            <strong>{receipt.roundId}</strong>
                            <span className={getStatusClass(receipt.status === "CONFIRMED" ? "WIN" : "PENDING")}>{receipt.status}</span>
                            <span>
                              {receipt.market} | {directionLabel(receipt.direction)} | {formatUsd(receipt.stakeUsd)} ({formatSol(receipt.stakeSol)})
                            </span>
                            <span className="mono">Bet tx: {shortAddress(receipt.signature)}</span>
                            <span>{new Date(receipt.joinedAtMs).toLocaleString()}</span>
                            <span>
                              Round:{" "}
                              {claimState ? (
                                <span className={getStatusClass(claimState.roundStatus === "SETTLED" ? "WIN" : claimState.roundStatus === "UNKNOWN" ? "PENDING" : claimState.roundStatus)}>
                                  {claimState.roundStatus}
                                </span>
                              ) : (
                                "Loading..."
                              )}
                            </span>
                            <span>
                              Claimable: {claimState ? formatLamports(claimState.claimableLamports) : "..."}{" "}
                              {claimState?.claimed ? "(already claimed)" : ""}
                            </span>
                            <div className="timeline-row">
                              <span className={getStatusClass("WIN")}>Joined</span>
                              <span className={getStatusClass(claimState?.roundStatus === "OPEN" ? "OPEN" : "LOCKED")}>Locked</span>
                              <span className={getStatusClass(claimState?.roundStatus === "SETTLED" ? "WIN" : "PENDING")}>Settled</span>
                              <span className={getStatusClass(claimState?.claimed ? "WIN" : claimState?.claimableLamports ? "REFUND" : "PENDING")}>
                                {claimState?.claimed ? "Claimed" : claimState?.claimableLamports ? "Claimable" : "Pending"}
                              </span>
                            </div>
                            {claimState?.error ? <span className="footnote">{claimState.error}</span> : null}
                            <div className="trade-ticket-actions">
                              <a href={receipt.explorer} target="_blank" rel="noreferrer" className="ticket-link">
                                View bet tx
                              </a>
                              {claimState?.claimTxSignature ? (
                                <a
                                  href={`https://explorer.solana.com/tx/${claimState.claimTxSignature}?cluster=devnet`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="ticket-link"
                                >
                                  View claim tx
                                </a>
                              ) : null}
                              <button type="button" className="expand-toggle" onClick={() => void claimRound(receipt)} disabled={!canClaim}>
                                {claimPending ? "Claiming..." : claimState?.claimed ? "Claimed" : "Claim"}
                              </button>
                            </div>
                          </>
                        );
                      })()}
                    </article>
                  ))}
                </div>
                {onchainReceipts.length > 3 ? (
                  <div className="carousel-nav">
                    <button type="button" className="expand-toggle" onClick={() => setRoundCarouselIndex((prev) => Math.max(0, prev - 1))} disabled={carouselIndex === 0}>
                      ← Newer
                    </button>
                    <span className="footnote">
                      Showing {carouselIndex + 1}-{Math.min(carouselIndex + 3, onchainReceipts.length)} of {onchainReceipts.length}
                    </span>
                    <button
                      type="button"
                      className="expand-toggle"
                      onClick={() => setRoundCarouselIndex((prev) => Math.min(maxCarouselStart, prev + 1))}
                      disabled={carouselIndex >= maxCarouselStart}
                    >
                      Older →
                    </button>
                  </div>
                ) : null}
                <article className="claim-history">
                  <strong>Claim History</strong>
                  {claimHistory.length === 0 ? (
                    <span className="footnote">No claims yet.</span>
                  ) : (
                    <div className="claim-history-list">
                      {claimHistory.slice(0, 8).map((item) => (
                        <div key={item.id} className="claim-history-item">
                          <span className={getStatusClass(item.status === "SUCCESS" ? "WIN" : "LOSS")}>{item.status}</span>
                          <span>
                            {item.market} | {item.roundId}
                          </span>
                          <span>Amount: {formatLamports(item.claimLamports)}</span>
                          <span>{new Date(item.timestampMs).toLocaleString()}</span>
                          {item.claimTxSignature ? (
                            <a
                              href={`https://explorer.solana.com/tx/${item.claimTxSignature}?cluster=devnet`}
                              target="_blank"
                              rel="noreferrer"
                              className="ticket-link"
                            >
                              Claim tx
                            </a>
                          ) : item.error ? (
                            <span className="footnote">{item.error}</span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              </div>
            ) : null}
          </>
        ) : !walletAddress ? (
          <p className="footnote">Connect wallet to view your rounds.</p>
        ) : (
          <>
            {walletTotals ? (
              <p className="footnote">
                Total Staked: {SIM_MODE ? formatBucksFromCents(walletTotals.stakedLamports) : formatLamports(walletTotals.stakedLamports)} | Total Paid:{" "}
                {SIM_MODE ? formatBucksFromCents(walletTotals.paidLamports) : formatLamports(walletTotals.paidLamports)} | Net:{" "}
                {SIM_MODE ? formatBucksFromCents(walletTotals.pnlLamports) : formatLamports(walletTotals.pnlLamports)}
              </p>
            ) : null}
            {walletRounds.length === 0 ? (
              <p className="footnote">No rounds yet for this wallet.</p>
            ) : (
              <div className="results-carousel">
                <div className="carousel-track">
                  {walletRounds.slice(carouselIndex, carouselIndex + 3).map((roundResult) => (
                    <article key={roundResult.entrySignature} className="result-card">
                      <strong>{roundResult.roundId}</strong>
                      <span className={getStatusClass(roundResult.status)}>{roundResult.status}</span>
                      <span>Side: {directionLabel(roundResult.direction)}</span>
                      <span className="mono">Bet tx: {shortAddress(roundResult.entrySignature)}</span>
                      <span>
                        Stake: {SIM_MODE ? formatBucksFromCents(roundResult.stakeLamports) : formatLamports(roundResult.stakeLamports)} | Paid:{" "}
                        {SIM_MODE ? formatBucksFromCents(roundResult.payoutLamports) : formatLamports(roundResult.payoutLamports)}
                      </span>
                      <span>Net: {roundResult.pnlLamports === null ? "Pending" : SIM_MODE ? formatBucksFromCents(roundResult.pnlLamports) : formatLamports(roundResult.pnlLamports)}</span>
                      <span>
                        Settlement timer:{" "}
                        {roundResult.status === "PENDING"
                          ? roundResult.roundEndMs > nowMs
                            ? formatCountdown((roundResult.roundEndMs - nowMs) / 1000)
                            : "Awaiting keeper"
                          : "Settled"}
                      </span>
                      {roundResult.settlement ? (
                        <span>
                          Round price: {formatUsd(roundResult.settlement.startPrice)} {"->"} {formatUsd(roundResult.settlement.endPrice)} | Winner: {winnerLabel(roundResult.settlement.winnerSide)}
                        </span>
                      ) : (
                        <span>Waiting for settlement...</span>
                      )}
                    </article>
                  ))}
                </div>
                {walletRounds.length > 3 ? (
                  <div className="carousel-nav">
                    <button type="button" className="expand-toggle" onClick={() => setRoundCarouselIndex((prev) => Math.max(0, prev - 1))} disabled={carouselIndex === 0}>
                      ← Newer
                    </button>
                    <span className="footnote">
                      Showing {carouselIndex + 1}-{Math.min(carouselIndex + 3, walletRounds.length)} of {walletRounds.length}
                    </span>
                    <button
                      type="button"
                      className="expand-toggle"
                      onClick={() => setRoundCarouselIndex((prev) => Math.min(maxCarouselStart, prev + 1))}
                      disabled={carouselIndex >= maxCarouselStart}
                    >
                      Older →
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
      {claimToasts.length > 0 ? (
        <div className="toast-stack" aria-live="polite">
          {claimToasts.map((toast) => (
            <article key={toast.id} className={`toast ${toast.tone === "SUCCESS" ? "toast-success" : "toast-error"}`}>
              {toast.text}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

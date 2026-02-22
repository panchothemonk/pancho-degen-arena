#!/usr/bin/env bash
set +e +o pipefail

TARGET="${TARGET:-Dkm5UeGTaeXDkauBMtNwbHGw7q2aXbrqb9HBQVN5GFx8}"
SLEEP_SEC="${SLEEP_SEC:-900}"
LOG="${LOG:-/Users/dirdiebirdies/Documents/New project/data/devnet-keepalive.log}"
PID="${PID:-/Users/dirdiebirdies/Documents/New project/data/devnet-keepalive.pid}"

mkdir -p /Users/dirdiebirdies/Documents/New\ project/data

echo $$ > "$PID"

ts() { date -Iseconds; }

while true; do
  {
    echo "[$(ts)] keepalive cycle start"

    # QuickNode health signal for this target
    scripts/devnet-fleet.sh quicknode-probe "$TARGET" || true

    # Official Devnet CLI fanout (wallet fleet)
    scripts/devnet-fleet.sh airdrop 1 1 || true

    # Consolidate any funded fleet wallets into target
    scripts/devnet-fleet.sh sweep "$TARGET" || true

    # Required verification command
    echo "[$(ts)] verify command"
    solana balance "$TARGET" --url devnet || true

    echo "[$(ts)] sleeping ${SLEEP_SEC}s"
    echo
  } >> "$LOG" 2>&1

  sleep "$SLEEP_SEC"
done

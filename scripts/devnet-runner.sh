#!/usr/bin/env bash
set +e +o pipefail

TARGET="${TARGET:-Dkm5UeGTaeXDkauBMtNwbHGw7q2aXbrqb9HBQVN5GFx8}"
SLEEP_SEC="${SLEEP_SEC:-900}"
AIRDROP_AMT="${AIRDROP_AMT:-1}"
RESERVE_SOL="${RESERVE_SOL:-0.002}"
LOG="${LOG:-/Users/dirdiebirdies/Documents/New project/data/devnet-runner.log}"
PID="${PID:-/Users/dirdiebirdies/Documents/New project/data/devnet-runner.pid}"

mkdir -p /Users/dirdiebirdies/Documents/New\ project/data
cd /Users/dirdiebirdies/Documents/New\ project || exit 1

echo $$ > "$PID"

ts() { date -Iseconds; }
balance() { solana balance "$1" --url devnet 2>/dev/null | awk '{print $1}'; }

while true; do
  {
    echo "[$(ts)] runner cycle start"

    # QuickNode availability probe (target)
    qhtml=$(curl -m 12 -sS 'https://faucet.quicknode.com/solana/devnet' \
      -H 'content-type: application/x-www-form-urlencoded' \
      --data "wallet=${TARGET}&chain=solana&network=devnet&authToken=&_action=step-one" || true)
    if echo "$qhtml" | rg -q 'Insufficient SOL balance\.'; then
      echo "[$(ts)] quicknode=Insufficient SOL balance."
    else
      echo "[$(ts)] quicknode=unknown_or_available"
    fi

    # Attempt target first
    echo "[$(ts)] airdrop target $TARGET amount=$AIRDROP_AMT"
    solana airdrop "$AIRDROP_AMT" "$TARGET" --url devnet || true
    echo "[$(ts)] verify: solana balance $TARGET --url devnet"
    solana balance "$TARGET" --url devnet || true

    # Attempt fleet wallets
    for kp in data/wallets/faucet-*.json; do
      [ -f "$kp" ] || continue
      addr=$(solana-keygen pubkey "$kp")
      echo "[$(ts)] airdrop fleet $addr amount=$AIRDROP_AMT"
      solana airdrop "$AIRDROP_AMT" "$addr" --url devnet || true
      echo "[$(ts)] verify: solana balance $TARGET --url devnet"
      solana balance "$TARGET" --url devnet || true
      sleep 3
    done

    # Sweep fleet to target if funded
    for kp in data/wallets/faucet-*.json; do
      [ -f "$kp" ] || continue
      addr=$(solana-keygen pubkey "$kp")
      bal=$(balance "$addr")
      sendable=$(awk -v b="$bal" -v r="$RESERVE_SOL" 'BEGIN{v=b-r; if(v<0)v=0; printf "%.9f", v}')
      gt=$(awk -v x="$sendable" 'BEGIN{print (x>0.000001)?1:0}')
      if [ "$gt" = "1" ]; then
        echo "[$(ts)] sweep $sendable from $addr to $TARGET"
        solana transfer "$TARGET" "$sendable" --from "$kp" --fee-payer "$kp" --allow-unfunded-recipient --url devnet || true
      fi
    done

    echo "[$(ts)] cycle done target_balance=$(balance "$TARGET")"
    echo "[$(ts)] sleeping ${SLEEP_SEC}s"
    echo
  } >> "$LOG" 2>&1

  sleep "$SLEEP_SEC"
done

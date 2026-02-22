#!/usr/bin/env bash
set -u

WALLET="Dkm5UeGTaeXDkauBMtNwbHGw7q2aXbrqb9HBQVN5GFx8"
RPC="devnet"
GOAL=5.0
MIN_GOAL=3.0

get_balance() {
  solana balance "$WALLET" --url "$RPC" | awk '{print $1}'
}

is_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN{exit (a+0 >= b+0) ? 0 : 1}'
}

next_amount() {
  local bal="$1"
  local rem
  rem=$(awk -v g="$GOAL" -v b="$bal" 'BEGIN{r=g-b; if (r<0) r=0; print r}')
  awk -v r="$rem" 'BEGIN{
    if (r >= 2.0) print 2;
    else if (r >= 1.0) print 1;
    else if (r >= 0.5) print 0.5;
    else print r;
  }'
}

solana config set --url https://api.devnet.solana.com >/dev/null 2>&1

echo "[$(date -Iseconds)] worker started for $WALLET"
while true; do
  bal=$(get_balance)
  echo "[$(date -Iseconds)] balance=$bal"

  if is_ge "$bal" "$GOAL"; then
    echo "[$(date -Iseconds)] goal reached: $bal >= $GOAL"
    exit 0
  fi

  amt=$(next_amount "$bal")
  if awk -v a="$amt" 'BEGIN{exit (a<=0.0000001)?0:1}'; then
    echo "[$(date -Iseconds)] tiny remainder; exiting"
    exit 0
  fi

  echo "[$(date -Iseconds)] requesting airdrop $amt"
  out=$(solana airdrop "$amt" "$WALLET" --url "$RPC" 2>&1 || true)
  echo "$out"

  vbal=$(get_balance)
  echo "[$(date -Iseconds)] verify balance=$vbal"

  if echo "$out" | rg -qi '429|rate|too many|limit|run dry'; then
    sleep 900
    continue
  fi

  if echo "$out" | rg -qi 'Signature|Requesting airdrop|transaction signature'; then
    sleep 20
    continue
  fi

  sleep 120
done

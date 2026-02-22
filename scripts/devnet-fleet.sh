#!/usr/bin/env bash
set -euo pipefail

RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
SOLANA_URL="${SOLANA_URL:-devnet}"
WALLETS_GLOB="${WALLETS_GLOB:-data/wallets/faucet-*.json}"
TARGET_DEFAULT="${TARGET_DEFAULT:-Dkm5UeGTaeXDkauBMtNwbHGw7q2aXbrqb9HBQVN5GFx8}"
RESERVE_SOL="${RESERVE_SOL:-0.002}"
QUICKNODE_URL="https://faucet.quicknode.com/solana/devnet"

usage() {
  cat <<USAGE
Usage:
  scripts/devnet-fleet.sh init [count] [prefix]
  scripts/devnet-fleet.sh status [target_wallet]
  scripts/devnet-fleet.sh airdrop [amount_sol] [retries]
  scripts/devnet-fleet.sh sweep [target_wallet]
  scripts/devnet-fleet.sh quicknode-probe [wallet]
  scripts/devnet-fleet.sh quicknode-probe-all

Defaults:
  target wallet: ${TARGET_DEFAULT}
  wallets glob:  ${WALLETS_GLOB}
USAGE
}

wallet_files() {
  compgen -G "$WALLETS_GLOB" || true
}

wallet_pubkey() {
  local kp="$1"
  solana-keygen pubkey "$kp"
}

balance_sol() {
  local addr="$1"
  solana balance "$addr" --url "$SOLANA_URL" | awk '{print $1}'
}

is_gt() {
  awk -v a="$1" -v b="$2" 'BEGIN { exit (a+0 > b+0) ? 0 : 1 }'
}

safe_sleep() {
  local sec="$1"
  sleep "$sec"
}

do_init() {
  local count="${1:-5}"
  local prefix="${2:-faucet}"
  mkdir -p data/wallets
  local i
  for ((i=1; i<=count; i++)); do
    local file="data/wallets/${prefix}-${i}.json"
    if [[ -f "$file" ]]; then
      echo "exists: $file $(wallet_pubkey "$file")"
    else
      solana-keygen new --no-bip39-passphrase --silent -o "$file" >/dev/null
      chmod 600 "$file"
      echo "created: $file $(wallet_pubkey "$file")"
    fi
  done
}

do_status() {
  local target="${1:-$TARGET_DEFAULT}"
  echo "RPC: $RPC_URL"
  echo "Target: $target"
  solana config set --url "$RPC_URL" >/dev/null

  local total="0"
  local kp
  for kp in $(wallet_files); do
    local addr bal
    addr=$(wallet_pubkey "$kp")
    bal=$(balance_sol "$addr")
    total=$(awk -v t="$total" -v b="$bal" 'BEGIN{printf "%.9f", t+b}')
    echo "$kp $addr balance=$bal"
  done
  echo "fleet_total=$total SOL"
  echo "target_balance=$(balance_sol "$target") SOL"
}

do_airdrop() {
  local amt="${1:-1}"
  local retries="${2:-4}"
  solana config set --url "$RPC_URL" >/dev/null

  local kp
  for kp in $(wallet_files); do
    local addr
    addr=$(wallet_pubkey "$kp")
    echo "== airdrop wallet=$addr amount=$amt =="
    local try
    for ((try=1; try<=retries; try++)); do
      local out
      out=$(solana airdrop "$amt" "$addr" --url "$SOLANA_URL" 2>&1 || true)
      echo "$out"
      echo "verify: solana balance $addr --url devnet"
      solana balance "$addr" --url "$SOLANA_URL"

      if echo "$out" | rg -qi 'airdrop transaction signature|signature:' && ! echo "$out" | rg -qi '^Error:|failed|rate limit|429'; then
        echo "success on try $try"
        break
      fi

      if echo "$out" | rg -qi '429|rate|too many|limit|run dry'; then
        local wait=$(( try * 25 + RANDOM % 10 ))
        echo "rate-limited; sleeping ${wait}s"
        safe_sleep "$wait"
      else
        local wait=$(( 8 + RANDOM % 5 ))
        echo "retrying in ${wait}s"
        safe_sleep "$wait"
      fi
    done
  done
}

do_sweep() {
  local target="${1:-$TARGET_DEFAULT}"
  solana config set --url "$RPC_URL" >/dev/null

  local kp
  for kp in $(wallet_files); do
    local addr bal sendable
    addr=$(wallet_pubkey "$kp")
    bal=$(balance_sol "$addr")
    sendable=$(awk -v b="$bal" -v r="$RESERVE_SOL" 'BEGIN{v=b-r; if (v<0) v=0; printf "%.9f", v}')

    if is_gt "$sendable" "0.000001"; then
      echo "sweep $sendable SOL from $addr -> $target"
      solana transfer "$target" "$sendable" \
        --from "$kp" \
        --fee-payer "$kp" \
        --allow-unfunded-recipient \
        --url "$SOLANA_URL" || true
      echo "verify source: $(balance_sol "$addr")"
      echo "verify target: $(balance_sol "$target")"
    else
      echo "skip $addr (balance=$bal, sendable=$sendable)"
    fi
  done
}

quicknode_probe_wallet() {
  local wallet="$1"
  local html
  html=$(curl -m 12 -sS "$QUICKNODE_URL" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data "wallet=${wallet}&chain=solana&network=devnet&authToken=&_action=step-one" || true)

  local msg
  if echo "$html" | rg -q 'Insufficient SOL balance\.'; then
    msg="Insufficient SOL balance."
  elif echo "$html" | rg -q 'formErrors'; then
    msg=$(echo "$html" | rg -o '"send","[^"]+"' | head -n 1 | sed -E 's/^"send","(.*)"$/\1/' || true)
  elif echo "$html" | rg -q 'one drip per network every 12 hours'; then
    msg="one drip per network every 12 hours"
  elif echo "$html" | rg -q 'tweet about this faucet, share the tweet and get a single token'; then
    msg="tweet/share gate present"
  else
    msg=""
  fi
  if [[ -z "$msg" ]]; then
    msg="no known gate message found"
  fi
  echo "$wallet => $msg"
}

do_quicknode_probe() {
  local wallet="${1:-$TARGET_DEFAULT}"
  quicknode_probe_wallet "$wallet"
}

do_quicknode_probe_all() {
  local kp
  for kp in $(wallet_files); do
    quicknode_probe_wallet "$(wallet_pubkey "$kp")"
  done
  quicknode_probe_wallet "$TARGET_DEFAULT"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    init) shift; do_init "$@" ;;
    status) shift; do_status "$@" ;;
    airdrop) shift; do_airdrop "$@" ;;
    sweep) shift; do_sweep "$@" ;;
    quicknode-probe) shift; do_quicknode_probe "$@" ;;
    quicknode-probe-all) shift; do_quicknode_probe_all "$@" ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"

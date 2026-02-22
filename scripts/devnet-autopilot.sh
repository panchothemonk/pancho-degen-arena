#!/usr/bin/env bash
# Force non-errexit behavior even when parent shell exports SHELLOPTS=errexit.
set +e +o pipefail
set -u

TARGET_WALLET="${TARGET_WALLET:-Dkm5UeGTaeXDkauBMtNwbHGw7q2aXbrqb9HBQVN5GFx8}"
GOAL_SOL="${GOAL_SOL:-5}"
MIN_SOL="${MIN_SOL:-3}"
WALLETS_GLOB="${WALLETS_GLOB:-data/wallets/faucet-*.json}"
LOG_FILE="${LOG_FILE:-data/devnet-autopilot.log}"
STATE_FILE="${STATE_FILE:-data/devnet-autopilot.state}"
HEARTBEAT_FILE="${HEARTBEAT_FILE:-data/devnet-autopilot.heartbeat}"
PID_FILE="${PID_FILE:-data/devnet-autopilot.pid}"
RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
SOLANA_URL="${SOLANA_URL:-devnet}"
AIRDROP_AMT="${AIRDROP_AMT:-1}"

# Conservative cadence for faucet limits
CYCLE_SLEEP_OK="${CYCLE_SLEEP_OK:-300}"       # 5m
CYCLE_SLEEP_RATE="${CYCLE_SLEEP_RATE:-900}"   # 15m

mkdir -p data

log() {
  echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE"
}

on_exit() {
  local ec=$?
  echo "[$(date -Iseconds)] autopilot exit code=$ec" >> "$LOG_FILE"
}
trap on_exit EXIT

write_state() {
  cat > "$STATE_FILE" <<STATE
last_cycle=$1
last_result=$2
target_balance=$3
min_goal=$MIN_SOL
goal=$GOAL_SOL
STATE
}

balance_of() {
  local addr="$1"
  solana balance "$addr" --url "$SOLANA_URL" 2>/dev/null | awk '{print $1}'
}

is_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN{ exit (a+0 >= b+0) ? 0 : 1 }'
}

wallet_files() {
  compgen -G "$WALLETS_GLOB" || true
}

wallet_pubkey() {
  solana-keygen pubkey "$1"
}

attempt_airdrop() {
  local addr="$1"
  local out
  out=$(solana airdrop "$AIRDROP_AMT" "$addr" --url "$SOLANA_URL" 2>&1 || true)
  log "airdrop wallet=$addr amount=$AIRDROP_AMT out=$(echo "$out" | tr '\n' ' ' | sed 's/  */ /g')"

  # Required verification command after each attempt
  local verify
  verify=$(solana balance "$TARGET_WALLET" --url devnet 2>&1 || true)
  log "verify_target_cmd='solana balance $TARGET_WALLET --url devnet' result='$verify'"

  if echo "$out" | rg -qi '429|rate|too many|limit|run dry|failed'; then
    return 2
  fi
  if echo "$out" | rg -qi 'airdrop transaction signature|signature:'; then
    return 0
  fi
  return 1
}

sweep_all() {
  log "sweep phase start"
  scripts/devnet-fleet.sh sweep "$TARGET_WALLET" >> "$LOG_FILE" 2>&1 || true
  local tb
  tb=$(balance_of "$TARGET_WALLET")
  log "sweep phase done target_balance=$tb"
}

probe_quicknode() {
  local tmp html msg
  tmp="$(mktemp -d)"
  log "quicknode probe start wallet=$TARGET_WALLET"
  html=$(
    curl -m 12 -sS -c "$tmp/cj.txt" -b "$tmp/cj.txt" \
      -X POST "https://faucet.quicknode.com/solana/devnet" \
      -H 'content-type: application/x-www-form-urlencoded' \
      --data "_action=step-one&wallet=$TARGET_WALLET&chain=solana&network=devnet" \
      || true
  )
  rm -rf "$tmp"

  if echo "$html" | rg -q 'Insufficient SOL balance\.'; then
    msg="Insufficient SOL balance."
  elif echo "$html" | rg -q '"send","'; then
    msg=$(echo "$html" | rg -o '"send","[^"]+"' | head -n 1 | sed -E 's/^"send","(.*)"$/\1/')
  elif echo "$html" | rg -q 'one drip per network every 12 hours'; then
    msg="one drip per network every 12 hours"
  elif [ -z "$html" ]; then
    msg="probe failed/no response"
  else
    msg="probe ok/unknown"
  fi
  log "quicknode probe done msg='$msg'"
}

main_loop() {
  echo $$ > "$PID_FILE"
  solana config set --url "$RPC_URL" >/dev/null 2>&1 || true
  log "autopilot started pid=$$ target=$TARGET_WALLET goal=$GOAL_SOL min=$MIN_SOL"

  local cycle=0
  while true; do
    cycle=$((cycle + 1))
    date -Iseconds > "$HEARTBEAT_FILE"

    local tb
    tb=$(balance_of "$TARGET_WALLET")
    log "cycle=$cycle target_balance=$tb"

    if is_ge "$tb" "$GOAL_SOL"; then
      log "goal reached ($tb >= $GOAL_SOL). stopping."
      write_state "$cycle" "goal_reached" "$tb"
      exit 0
    fi

    # Probe quicknode each cycle (lightweight POST parsing via existing script)
    probe_quicknode

    local rate_limited=0

    # 1) Try target directly first
    attempt_airdrop "$TARGET_WALLET"
    rc=$?
    if [ "$rc" -eq 2 ]; then
      rate_limited=1
    fi

    # 2) Try fleet wallets and later sweep
    local kp addr
    for kp in $(wallet_files); do
      addr=$(wallet_pubkey "$kp")
      attempt_airdrop "$addr"
      rc=$?
      if [ "$rc" -eq 2 ]; then
        rate_limited=1
      fi
      sleep 3
    done

    # 3) Consolidate any successful drips to target
    sweep_all

    tb=$(balance_of "$TARGET_WALLET")
    if is_ge "$tb" "$MIN_SOL"; then
      log "minimum useful amount reached ($tb >= $MIN_SOL)"
    fi

    if [ "$rate_limited" -eq 1 ]; then
      write_state "$cycle" "rate_limited" "$tb"
      log "cycle=$cycle sleeping=${CYCLE_SLEEP_RATE}s (rate-limited)"
      sleep "$CYCLE_SLEEP_RATE"
    else
      write_state "$cycle" "ok" "$tb"
      log "cycle=$cycle sleeping=${CYCLE_SLEEP_OK}s"
      sleep "$CYCLE_SLEEP_OK"
    fi
  done
}

main_loop

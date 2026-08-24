#!/usr/bin/env bash
# Batch reward distribution — CSV in, CSV out. Built for the G's on Ape campaign but
# chain-agnostic: works on any EVM chain via ETH_RPC_URL.
#
# Input CSV:  address,amount            (amount in human units, e.g. 12.5)
# Output CSV: address,amount,tx,status  (written next to input as <name>.sent.csv)
#
# Usage:
#   ETH_RPC_URL=<rpc> ./distribute.sh <recipients.csv> [token-address]
#     no token address  -> sends native coin (ETH/APE)
#     token address     -> ERC-20 transfer(to, amount) using the token's decimals
#
# Signing: never pass a raw key to this script. Use whatever `cast send` supports:
#   CAST_FLAGS="--account mykeystore"      (foundry keystore, prompts for password)
#   CAST_FLAGS="--ledger"                  (hardware wallet)
#   CAST_FLAGS="--private-key $PK"         (only if you accept env exposure)
#
# Safety:
#   DRY_RUN=1     print every transfer, send nothing
#   Resume:       rows already marked "sent" in the output CSV are skipped, so a
#                 crashed run can simply be re-run with the same arguments.

set -euo pipefail

CSV="${1:?usage: distribute.sh <recipients.csv> [token-address]}"
TOKEN="${2:-}"
OUT="${CSV%.csv}.sent.csv"
: "${ETH_RPC_URL:?set ETH_RPC_URL to the target chain RPC}"
CAST_FLAGS="${CAST_FLAGS:-}"
DRY_RUN="${DRY_RUN:-0}"

[ -f "$OUT" ] || echo "address,amount,tx,status" > "$OUT"

DECIMALS=18
SYMBOL="native"
if [ -n "$TOKEN" ]; then
  DECIMALS=$(cast call "$TOKEN" 'decimals()(uint8)' --rpc-url "$ETH_RPC_URL")
  SYMBOL=$(cast call "$TOKEN" 'symbol()(string)' --rpc-url "$ETH_RPC_URL" | tr -d '"')
fi

total=0; sent=0; skipped=0; failed=0

# Strip an optional header row and CRLF endings; ignore blank lines.
while IFS=, read -r addr amount _rest; do
  addr=$(echo "$addr" | tr -d ' \r')
  amount=$(echo "$amount" | tr -d ' \r')
  [ -z "$addr" ] && continue
  case "$addr" in 0x*) ;; *) continue ;; esac   # skips the header line
  total=$((total + 1))

  if grep -qi "^$addr,.*,sent$" "$OUT"; then
    skipped=$((skipped + 1)); continue
  fi

  raw=$(cast to-wei "$amount" "$( [ "$DECIMALS" = "18" ] && echo ether || echo "$DECIMALS" )" 2>/dev/null \
        || python3 -c "print(int(round(float('$amount') * 10**$DECIMALS)))")

  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY  $addr  $amount $SYMBOL  (raw $raw)"
    continue
  fi

  if [ -n "$TOKEN" ]; then
    tx=$(cast send "$TOKEN" 'transfer(address,uint256)' "$addr" "$raw" \
         --rpc-url "$ETH_RPC_URL" $CAST_FLAGS --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['transactionHash'])" || true)
  else
    tx=$(cast send "$addr" --value "$raw" \
         --rpc-url "$ETH_RPC_URL" $CAST_FLAGS --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['transactionHash'])" || true)
  fi

  if [ -n "$tx" ]; then
    echo "$addr,$amount,$tx,sent" >> "$OUT"
    echo "SENT $addr  $amount $SYMBOL  $tx"
    sent=$((sent + 1))
  else
    echo "$addr,$amount,,failed" >> "$OUT"
    echo "FAIL $addr  $amount $SYMBOL" >&2
    failed=$((failed + 1))
  fi
done < "$CSV"

echo "----"
echo "rows: $total  sent: $sent  skipped(already sent): $skipped  failed: $failed"
echo "receipts: $OUT"
[ "$failed" = "0" ] || exit 1

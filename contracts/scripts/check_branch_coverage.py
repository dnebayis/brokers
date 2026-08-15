#!/usr/bin/env python3
"""Fail unless mainnet-critical contracts each meet the branch threshold."""
from pathlib import Path

TARGETS = {"CoatRouter.sol", "CoatFeeHook.sol", "BuybackBurner.sol", "COAT.sol"}
THRESHOLD = 85.0
records = Path("lcov.info").read_text().split("end_of_record")

seen = set()
for record in records:
    source = next((line[3:] for line in record.splitlines() if line.startswith("SF:")), "")
    name = Path(source).name
    normalized = source.replace("\\", "/")
    if name not in TARGETS or not (normalized.startswith("src/") or "/src/" in normalized):
        continue
    branches = [line.split(",")[-1] for line in record.splitlines() if line.startswith("BRDA:")]
    covered = sum(hit not in ("-", "0") for hit in branches)
    percent = 100.0 if not branches else covered * 100.0 / len(branches)
    print(f"{name}: {percent:.2f}% branch coverage")
    if percent < THRESHOLD:
        raise SystemExit(f"{name} branch coverage is below {THRESHOLD:.0f}%")
    seen.add(name)

missing = TARGETS - seen
if missing:
    raise SystemExit(f"Missing coverage records: {', '.join(sorted(missing))}")

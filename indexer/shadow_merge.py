"""Union of two shadow-history series (JSONL rows keyed by their `at` timestamp).

The scheduled indexer keeps the series in an Actions cache and republishes it to the
`data` branch every pass. A cache miss would start a fresh, near-empty file and the next
publish would overwrite the full published series with it; the scorecard's smart
benchmark would then lose every hour before the miss. Before the first pass, the workflow
merges the local file with the published copy so neither side can shrink the series.

    python shadow_merge.py <local file> <published url>
"""

from __future__ import annotations

import json
import sys
import urllib.request


def parse(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict) and row.get("at"):
            rows.append(row)
    return rows


def merge(*series: list[dict]) -> list[dict]:
    """Rows from every series, one per timestamp (the later-listed series wins ties), sorted."""
    by_at: dict[str, dict] = {}
    for rows in series:
        for row in rows:
            by_at[row["at"]] = row
    return [by_at[k] for k in sorted(by_at)]


def dump(rows: list[dict]) -> str:
    return "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows)


def main(argv: list[str]) -> int:
    path, url = argv[1], argv[2]
    try:
        local = parse(open(path).read())
    except FileNotFoundError:
        local = []
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "coattail-indexer/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            published = parse(r.read().decode())
    except Exception as exc:  # noqa: BLE001 - keep the local file, say why
        print(f"shadow_merge: published copy unavailable ({str(exc)[:80]}); keeping {len(local)} local rows")
        return 0
    merged = merge(published, local)
    if len(merged) != len(local):
        with open(path, "w") as fh:
            fh.write(dump(merged))
    print(f"shadow_merge: local {len(local)} + published {len(published)} -> {len(merged)} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

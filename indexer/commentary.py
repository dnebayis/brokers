"""A short plain-language note on the current basket, written by a model from the facts.

Shape of the guarantee: the model only ever sees numbers we computed (weights, who bought
what, what was left out and why); the note is regenerated only when those facts change
(`input_hash`); and `validate_note` refuses a note that names a ticker we did not give
it, reads as advice, or runs long. A refused or failed note is simply absent: the site
shows the facts without it. Provider: Gemini's REST API, key in GEMINI_API_KEY.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
# A note lives at least this long even if the facts move: the basket rebalances hourly by
# design, and a note that rewrites itself every hour reads as noise, not information.
NOTE_MIN_HOURS = float(os.environ.get("NOTE_MIN_HOURS", "5"))
# Bump when the prompt changes: a note written by an older prompt is replaced on the next
# pass regardless of its age.
PROMPT_VERSION = 2
MAX_CHARS = 900
# Upper-case tokens that are not tickers and may appear in a sentence.
_NOT_TICKERS = {
    "USD", "US", "AI", "ETF", "NFT", "COAT", "SPY", "ETH", "CEO", "IPO", "SEC", "GDP", "Q1", "Q2",
    "Q3", "Q4", "STOCK", "ACT", "HOUSE", "SENATE", "OK", "AM", "PM", "UTC", "LLC", "LP", "INC",
    "II", "III", "IV", "JR", "SR",  # name suffixes ("William R. Timmons IV")
}
_ADVICE = re.compile(
    r"\b(you should|should buy|should sell|buy now|sell now|guaranteed|will (?:rise|go up|fall|drop|moon)"
    r"|financial advice|not financial advice|recommend(?:ed|ation)?|price target)\b",
    re.IGNORECASE,
)
_TICKERISH = re.compile(r"\b[A-Z]{2,5}\b")


def _money(n: float) -> str:
    if n >= 1_000_000:
        return f"${n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"${n / 1_000:.0f}K"
    return f"${n:.0f}"


def facts(payload: Dict) -> Dict:
    """The exact, minimal facts the model is allowed to use (also what gets hashed)."""
    attribution = payload.get("attribution") or {}
    names = []
    for ticker, bps in zip(payload.get("tickers", []), payload.get("weightsBps", [])):
        buyers = (attribution.get(ticker) or {}).get("buyers", [])[:3]
        names.append({
            "ticker": ticker,
            "weightPct": round(bps / 100, 1),
            "buyers": [{
                "member": b["member"], "chamber": b.get("chamber", ""), "buys": b["buys"],
                "notional": _money(b["notionalUsd"]), "latestTraded": b.get("latestTraded", ""),
                "latestFiled": b.get("latestFiled", ""),
            } for b in buyers],
            "buyerCount": (attribution.get(ticker) or {}).get("buyerCount", 0),
            "sellCount": (attribution.get(ticker) or {}).get("sellCount", 0),
        })
    missed = []
    missed_attr = payload.get("missedAttribution") or {}
    for m in (payload.get("missedCoverage") or [])[:3]:
        buyers = (missed_attr.get(m["ticker"]) or {}).get("buyers", [])[:2]
        missed.append({
            "ticker": m["ticker"],
            "netNotional": _money(m["netNotional"]),
            "shareOfBuying": round(m["shareOfBuying"] * 100, 1),
            "buyers": [b["member"] for b in buyers],
            "reason": "not tokenized or not tradable on this chain",
        })
    return {
        "basket": names,
        "coveragePct": round((payload.get("coverage") or 0) * 100, 1),
        "leftOut": missed,
        "windowDays": 90,
    }


def input_hash(payload: Dict) -> str:
    return hashlib.sha256(json.dumps(facts(payload), sort_keys=True).encode()).hexdigest()[:16]


def build_prompt(payload: Dict) -> str:
    f = facts(payload)
    return (
        "You write a short note for holders of Coattail Brokers, NFTs whose wallets automatically buy a "
        "basket of tokenized stocks built from US Congress stock-trade disclosures.\n"
        "Write 70 to 110 words of plain English about the basket below, the way a sharp newsletter "
        "would brief a reader in one paragraph. Rules:\n"
        "- Use ONLY the facts in the JSON. Never add tickers, people, prices, dates or numbers that are not there.\n"
        "- Lead with the position that matters most and the member behind it, with their amount range "
        "(notional) and the traded and filed dates.\n"
        "- Name at most three members in the whole note; summarize the rest as a count.\n"
        "- One sentence on the largest name that could not be bought (leftOut) and why.\n"
        "- One sentence with coveragePct: the share of disclosed buying dollars the basket could actually buy.\n"
        "- Describe, never advise: no recommendations, no predictions, no 'should'. Do not open with a list of tickers.\n"
        "- No headings, no bullet points, no emoji, no preamble. Output the note only.\n\n"
        f"FACTS:\n{json.dumps(f, indent=1)}"
    )


def validate_note(text: str, allowed_tickers: List[str], allowed_words: Iterable[str] = ()) -> Tuple[bool, str]:
    """`allowed_words`: upper-case tokens that legitimately occur in the facts (parts of
    member names, for instance), so a name never trips the unknown-ticker check."""
    text = (text or "").strip()
    if len(text) < 120:
        return False, "too short"
    if len(text) > MAX_CHARS:
        return False, "too long"
    if _ADVICE.search(text):
        return False, "reads as advice"
    allowed = {t.upper() for t in allowed_tickers} | {w.upper() for w in allowed_words}
    for tok in set(_TICKERISH.findall(text)):
        if tok in _NOT_TICKERS or tok in allowed:
            continue
        # a plain English word in caps (e.g. a sentence-initial "THE") is not a ticker
        if tok.lower() in {"the", "and", "for", "with", "that", "this", "from", "into"}:
            continue
        return False, f"unknown ticker-like token {tok}"
    return True, "ok"


def _gemini(prompt: str, key: str, model: str) -> str:
    # Gemini 2.5 spends "thinking" tokens out of the same output budget: with a small cap
    # the visible answer came back empty ("too short"). Thinking is switched off for this
    # short factual note and the cap is generous; the validator still bounds the length.
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.4,
            "maxOutputTokens": 1024,
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }).encode()
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
        data=body, headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        payload = json.load(r)
    try:
        return "".join(p.get("text", "") for p in payload["candidates"][0]["content"]["parts"]).strip()
    except (KeyError, IndexError, TypeError):
        raise RuntimeError(f"unexpected Gemini response: {str(payload)[:200]}")


def _fresh(previous: Optional[Dict], now: datetime, min_hours: float) -> bool:
    try:
        made = datetime.fromisoformat(str(previous["generatedAt"]).replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError):
        return False
    if made.tzinfo is None:
        made = made.replace(tzinfo=timezone.utc)
    return (now - made).total_seconds() < min_hours * 3600


def generate(payload: Dict, previous: Optional[Dict] = None, key: str = "",
             model: str = GEMINI_MODEL, call=_gemini, now: Optional[datetime] = None,
             min_hours: float = NOTE_MIN_HOURS) -> Optional[Dict]:
    """Return {"text","model","generatedAt","inputHash"} or None.

    Reuses `previous` (the last published note) when the facts have not changed, and
    also while it is younger than `min_hours`, so the model is called at most once per
    that window and only on real changes.
    """
    now = now or datetime.now(timezone.utc)
    h = input_hash(payload)
    if previous and previous.get("text") and previous.get("promptVersion", 1) == PROMPT_VERSION:
        if previous.get("inputHash") == h or _fresh(previous, now, min_hours):
            return dict(previous)
    if not key:
        return None
    allowed = list(payload.get("tickers", [])) + [m["ticker"] for m in payload.get("missedCoverage") or []]
    prompt = build_prompt(payload)
    # every upper-case token the facts themselves contain is fair game in the note
    fact_words = set(_TICKERISH.findall(json.dumps(facts(payload))))
    last = ""
    for _attempt in range(2):
        try:
            text = call(prompt, key, model)
        except (urllib.error.URLError, RuntimeError, TimeoutError, OSError) as exc:
            last = f"provider error: {str(exc)[:120]}"
            continue
        ok, reason = validate_note(text, allowed, fact_words)
        if not ok:
            print(f"basket note attempt rejected ({reason}; {len(text)} chars): {text[:200]!r}")
        if ok:
            return {
                "text": text, "model": model,
                "generatedAt": now.isoformat(timespec="seconds"),
                "inputHash": h,
                "promptVersion": PROMPT_VERSION,
            }
        last = f"rejected: {reason}"
    print(f"::warning::basket note not generated ({last})")
    return None

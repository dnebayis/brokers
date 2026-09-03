"""Best-effort operator alerts to a Discord webhook.

GitHub ::warning:: annotations only exist inside run logs nobody watches — the keeper's
low-gas warning sat unseen until someone happened to read a log. When OPS_WEBHOOK_URL is
set (a plain Discord channel webhook), the handful of warnings that actually require a
human land in that channel too. Unset, every call is a silent no-op, and a delivery
failure must never break the run it is reporting on.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request

ATTEMPTS = 2
RETRY_DELAY_S = 2.0


def alert(message: str) -> bool:
    from config import redact
    message = redact(message)
    url = os.environ.get("OPS_WEBHOOK_URL", "")
    if not url:
        return False
    data = json.dumps({
        "username": "Coattail Ops",
        "content": message[:1900],  # Discord hard limit 2000
    }).encode()
    last: Exception | None = None
    for attempt in range(ATTEMPTS):
        try:
            req = urllib.request.Request(
                url,
                data=data,
                # Discord sits behind Cloudflare, which rejects the default Python-urllib
                # User-Agent — the same 1010 class the RPC config already works around.
                headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
            )
            urllib.request.urlopen(req, timeout=10)
            return True
        except Exception as exc:  # a 429 from Discord is the common case here
            last = exc
            if attempt < ATTEMPTS - 1:
                time.sleep(RETRY_DELAY_S)
    # This is the only path that reaches a human, so its own failure must at least be
    # visible in the run log rather than vanish.
    print(f"::warning::ops alert not delivered after {ATTEMPTS} attempts: {str(last)[:160]}")
    return False

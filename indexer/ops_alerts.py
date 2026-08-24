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
import urllib.request


def alert(message: str) -> bool:
    url = os.environ.get("OPS_WEBHOOK_URL", "")
    if not url:
        return False
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps({
                "username": "Coattail Ops",
                "content": message[:1900],  # Discord hard limit 2000
            }).encode(),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=10)
        return True
    except Exception:
        return False

#!/usr/bin/env python3
"""Local-only JSON-RPC proxy that adds an Origin header for allowlisted providers.

The upstream URL is read from RH_UPSTREAM_RPC and is never logged. This exists because
Foundry's fork client does not forward `cast --rpc-headers` to its internal provider.
"""

import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


UPSTREAM = os.environ["RH_UPSTREAM_RPC"]
ORIGIN = os.environ.get("RH_RPC_ORIGIN", "http://localhost:3000")
PORT = int(os.environ.get("RH_PROXY_PORT", "18545"))
ATTEMPTS = int(os.environ.get("RH_PROXY_ATTEMPTS", "5"))


class Handler(BaseHTTPRequestHandler):
    # Reuse connections; a heavy fork run (thousands of calls) reconnecting each
    # time is what caused upstream drops mid-request.
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length)
        status, body = 502, b'{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"proxy upstream error"}}'
        # A busy archive fork makes the upstream occasionally reset a connection.
        # Retry transient transport errors instead of dropping the client connection,
        # which Foundry reports as "connection closed before message completed".
        for attempt in range(ATTEMPTS):
            request = urllib.request.Request(
                UPSTREAM,
                data=payload,
                headers={"Content-Type": "application/json", "Origin": ORIGIN},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=120) as response:
                    body = response.read()
                    status = response.status
                break
            except urllib.error.HTTPError as error:
                body = error.read()
                status = error.code
                break
            except Exception:  # noqa: BLE001 - URLError/timeout/reset: retry with backoff
                if attempt == ATTEMPTS - 1:
                    break
                time.sleep(0.25 * (attempt + 1))
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception:  # noqa: BLE001 - client went away; nothing to do
            return

    def log_message(self, _format, *_args):
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

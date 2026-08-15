#!/usr/bin/env python3
"""Local-only JSON-RPC proxy that adds an Origin header for allowlisted providers.

The upstream URL is read from RH_UPSTREAM_RPC and is never logged. This exists because
Foundry's fork client does not forward `cast --rpc-headers` to its internal provider.
"""

import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


UPSTREAM = os.environ["RH_UPSTREAM_RPC"]
ORIGIN = os.environ.get("RH_RPC_ORIGIN", "http://localhost:3000")
PORT = int(os.environ.get("RH_PROXY_PORT", "18545"))


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length)
        request = urllib.request.Request(
            UPSTREAM,
            data=payload,
            headers={"Content-Type": "application/json", "Origin": ORIGIN},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                body = response.read()
                self.send_response(response.status)
        except urllib.error.HTTPError as error:
            body = error.read()
            self.send_response(error.code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

"""Hand an authenticated loopback URL to the default browser without shell fragments."""

from http.server import BaseHTTPRequestHandler, HTTPServer
import os
from pathlib import Path
import re
import secrets
import sys
from time import monotonic


def open_page(page):
    if page not in ("/", "/social"):
        raise ValueError("Unsupported console page")
    root = Path(os.environ.get("QQ_BRIDGE_HOME") or Path(__file__).resolve().parents[1])
    token = (root / ".private/admin-token").read_text(encoding="ascii").strip()
    if not re.fullmatch("[0-9a-f]{64}", token):
        raise ValueError("Invalid local credential")
    ticket = "/" + secrets.token_urlsafe(32)

    class Handoff(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.headers.get("Host") != address or self.path != ticket:
                self.send_error(404)
                return
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:19327{page}#token={token}")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.server.delivered = True

    class LocalServer(HTTPServer):
        def get_request(self):
            connection, peer = super().get_request()
            connection.settimeout(2)
            return connection, peer

    with LocalServer(("127.0.0.1", 0), Handoff) as server:
        address = f"127.0.0.1:{server.server_port}"
        server.delivered = False
        deadline = monotonic() + 45
        os.startfile(f"http://{address}{ticket}")
        while not server.delivered:
            server.timeout = deadline - monotonic()
            if server.timeout <= 0:
                raise TimeoutError("Browser did not open the console")
            server.handle_request()


if __name__ == "__main__":
    open_page(sys.argv[1])

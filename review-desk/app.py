#!/usr/bin/env python3
"""Run the owner-facing review desk on this computer only (Python 3.10+)."""
from __future__ import annotations

import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sys
import threading
from urllib.parse import urlsplit
import webbrowser

from review_core import ReviewDesk, ReviewError, file_json


MAX_REQUEST_BYTES = 256 * 1024
STATIC_PATHS = {"/": ("web/index.html", "text/html; charset=utf-8"),
                "/index.html": ("web/index.html", "text/html; charset=utf-8"),
                "/app.css": ("web/app.css", "text/css; charset=utf-8"),
                "/app.js": ("web/app.js", "text/javascript; charset=utf-8")}
SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; font-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
}


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, port, desk):
        # Deliberately no host option. A reverse proxy or public bind is not an
        # authentication boundary and is not supported by this owner-only app.
        super().__init__(("127.0.0.1", port), ReviewHandler)
        self.desk = desk


class ReviewHandler(BaseHTTPRequestHandler):
    server_version = "UptightReviewDesk/1.0"
    sys_version = ""

    def log_message(self, format, *args):
        # Request URLs and error bodies can contain private review material.
        # No access logs, credentials, query strings or submitted text are printed.
        pass

    def _security_check(self, mutation=False):
        host_values = self.headers.get_all("Host", [])
        if len(host_values) != 1:
            raise ReviewError("A single local Host header is required.", 403, "HOST_REJECTED")
        host = host_values[0]
        allowed = {"127.0.0.1:" + str(self.server.server_port), "localhost:" + str(self.server.server_port)}
        if host not in allowed:
            raise ReviewError("This review desk only accepts its local browser address.", 403, "HOST_REJECTED")
        origins = self.headers.get_all("Origin", [])
        if len(origins) > 1 or (origins and origins[0] != "http://" + host):
            raise ReviewError("Cross-origin requests are not accepted by the local review desk.", 403, "ORIGIN_REJECTED")
        if self.headers.get("Sec-Fetch-Site", "") not in ("", "same-origin", "none"):
            raise ReviewError("Open the review desk directly on its local address.", 403, "ORIGIN_REJECTED")
        if mutation:
            values = self.headers.get_all("X-Review-Token", [])
            if len(values) != 1 or not hmac.compare_digest(values[0].encode("utf-8"), self.server.desk.csrf_token.encode("ascii")):
                raise ReviewError("The local review session changed. Reload this page before saving or publishing.", 403, "CSRF_REJECTED")

    def _send_bytes(self, content, content_type, status=200, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def _send_json(self, value, status=200, extra=None):
        if not isinstance(value, dict):
            value = {"error": "The local server returned an invalid response.", "code": "INVALID_RESPONSE"}
            status = 500
        self._send_bytes(file_json(value), "application/json; charset=utf-8", status, extra)

    def _error(self, error):
        if isinstance(error, ReviewError):
            self._send_json({"error": error.message, "code": error.code}, error.status)
        else:
            # No raw exception, path, trace, request body or credential is exposed.
            self._send_json({"error": "The local review desk could not complete this request. Your last saved draft is retained.",
                             "code": "LOCAL_SERVER_ERROR"}, 500)

    @staticmethod
    def _route(path, stem):
        match = re.fullmatch(re.escape(stem) + r"/([1-9]\d{0,9})", path)
        return int(match.group(1)) if match else None

    def do_GET(self):
        try:
            self._security_check()
            path = urlsplit(self.path).path
            if path in STATIC_PATHS:
                relative, mime = STATIC_PATHS[path]
                asset = self.server.desk.app_root / relative
                if not asset.is_file():
                    raise ReviewError("The review interface is missing. Use the complete local app download.", 503, "ASSET_MISSING")
                return self._send_bytes(asset.read_bytes(), mime)
            if path == "/context.json":
                asset = self.server.desk.project_root / "data/cleveland-context.json"
                if not asset.is_file():
                    raise ReviewError("The offline street context is missing from this package.", 503, "ASSET_MISSING")
                return self._send_bytes(asset.read_bytes(), "application/json; charset=utf-8")
            if path == "/vendor/d3.min.js":
                asset = self.server.desk.project_root / "lib/d3.min.js"
                if not asset.is_file():
                    raise ReviewError("The map drawing library is missing from this package.", 503, "ASSET_MISSING")
                return self._send_bytes(asset.read_bytes(), "text/javascript; charset=utf-8")
            if path == "/api/bootstrap":
                return self._send_json(self.server.desk.bootstrap())
            if path == "/api/export":
                return self._send_json(self.server.desk.export(), extra={"Content-Disposition": 'attachment; filename="uptight-local-review-backup.json"'})
            frame = self._route(path, "/api/frame")
            if frame is not None:
                return self._send_bytes(self.server.desk.frame_bytes(frame), "image/jpeg")
            number = self._route(path, "/api/issues")
            if number is not None:
                return self._send_json(self.server.desk.issue_detail(number))
            raise ReviewError("This route is not available in the local review desk.", 404, "NOT_FOUND")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self._error(error)

    def _body(self):
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not re.fullmatch(r"\d+", lengths[0]):
            raise ReviewError("A valid request length is required.", 411, "LENGTH_REQUIRED")
        if self.headers.get("Transfer-Encoding"):
            raise ReviewError("Chunked request bodies are not supported.", 400, "INVALID_REQUEST")
        length = int(lengths[0])
        if length > MAX_REQUEST_BYTES:
            raise ReviewError("The submitted review is too large.", 413, "REQUEST_TOO_LARGE")
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ReviewError("Use a JSON request body.", 415, "JSON_REQUIRED")
        try:
            content = self.rfile.read(length)
            if len(content) != length:
                raise ValueError()
            def reject_constant(value):
                raise ValueError("Nonfinite numbers are not JSON review data")
            result = json.loads(content, parse_constant=reject_constant)
        except (ValueError, UnicodeError):
            raise ReviewError("The request body must be valid JSON with finite numbers.", 400, "INVALID_JSON") from None
        if not isinstance(result, dict):
            raise ReviewError("The request body must be a JSON object.", 400, "INVALID_JSON")
        return result

    def do_POST(self):
        try:
            self._security_check(mutation=True)
            body = self._body()
            path = urlsplit(self.path).path
            desk = self.server.desk
            if path == "/api/connection":
                return self._send_json(desk.connect(body.get("mode"), body.get("token")))
            if path == "/api/disconnect":
                return self._send_json(desk.disconnect())
            if path == "/api/refresh":
                return self._send_json(desk.refresh())
            for stem, method in (("/api/drafts", desk.save_draft), ("/api/preview", desk.preview),
                                 ("/api/publish", desk.publish), ("/api/sync-issue", desk.sync_issue)):
                number = self._route(path, stem)
                if number is None:
                    continue
                if stem == "/api/drafts":
                    result = method(number, body)
                elif stem == "/api/publish":
                    result = method(number, body.get("previewId"))
                else:
                    result = method(number)
                return self._send_json(result)
            raise ReviewError("This action is not available in the local review desk.", 404, "NOT_FOUND")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self._error(error)

    def do_OPTIONS(self):
        self._send_json({"error": "Cross-origin access is not supported.", "code": "ORIGIN_REJECTED"}, 403)

    def do_HEAD(self):
        self.do_GET()

    def _unsupported_method(self):
        try:
            self._security_check()
            self._send_json({"error": "This HTTP method is not supported by the local review desk.", "code": "METHOD_NOT_ALLOWED"}, 405)
        except ReviewError as error:
            self._error(error)

    do_PUT = _unsupported_method
    do_PATCH = _unsupported_method
    do_DELETE = _unsupported_method


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read and approve Uptight location evidence in a local-only review desk.")
    parser.add_argument("--port", type=int, default=8765, help="Loopback port (default: 8765)")
    parser.add_argument("--data-dir", type=Path, default=Path.home() / ".uptight-review-desk",
                        help="Private local state folder (default: ~/.uptight-review-desk)")
    parser.add_argument("--no-browser", "--no-open", dest="no_browser", action="store_true",
                        help="Print the local URL without opening the browser")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    try:
        desk = ReviewDesk(Path(__file__).resolve().parents[1], args.data_dir)
        server = LocalServer(args.port, desk)
    except ReviewError as error:
        print(error.message, file=sys.stderr)
        return 1
    except OSError:
        print("The local port could not be opened. Close the previous review desk or choose another --port.", file=sys.stderr)
        return 1
    url = "http://127.0.0.1:" + str(server.server_port) + "/"
    print("Uptight local review desk: " + url, flush=True)
    print("Your review drafts stay on this computer. Press Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        opener = threading.Timer(0.35, webbrowser.open, args=(url,))
        opener.daemon = True
        opener.start()
    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        desk.disconnect()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

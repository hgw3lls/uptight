"""Exercise the actual loopback HTTP boundary; no public network requests."""
import contextlib
import http.client
import io
import json
from pathlib import Path
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import LocalServer
from review_core import ReviewError
from test_review_core import DeskCase


class HTTPTests(DeskCase):
    def setUp(self):
        super().setUp()
        web = self.root / "review-desk/web"
        web.mkdir()
        (web / "index.html").write_text("<!doctype html><title>Local review desk</title>")
        (web / "app.css").write_text("body{color:black}")
        (web / "app.js").write_text("'use strict';")
        (self.root / "lib").mkdir()
        (self.root / "lib/d3.min.js").write_text("/* bundled test library */")
        self.server = LocalServer(0, self.desk)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.host = "127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        super().tearDown()

    def request(self, method, path, body=None, headers=None, authenticated=True, raw=False):
        request_headers = {"Host": self.host}
        if method == "POST":
            request_headers.update({"Content-Type": "application/json", "Origin": "http://" + self.host})
            if authenticated:
                request_headers["X-Review-Token"] = self.desk.csrf_token
            body = b"{}" if body is None else body if isinstance(body, bytes) else json.dumps(body).encode()
        request_headers.update(headers or {})
        client = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            client.request(method, path, body=body, headers=request_headers)
            response = client.getresponse()
            content = response.read()
            data = content if raw or not content else json.loads(content) if response.getheader("Content-Type", "").startswith("application/json") else content
            return response.status, dict(response.getheaders()), data
        finally:
            client.close()

    def test_server_is_bound_only_to_loopback_and_bootstrap_exposes_no_images_or_auth(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        status, headers, data = self.request("GET", "/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertEqual(data["csrfToken"], self.desk.csrf_token)
        self.assertFalse(data["connection"]["connected"])
        self.assertNotIn("image", data["sites"][0]["frames"][0])
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_dns_rebinding_host_and_cross_origin_get_cannot_read_session(self):
        for headers in ({"Host": "evil.example:" + str(self.server.server_port)},
                        {"Host": "127.0.0.1:1"}, {"Host": "127.0.0.1"},
                        {"Origin": "https://evil.example"}, {"Origin": "null"},
                        {"Origin": "http://localhost:" + str(self.server.server_port)},
                        {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}):
            with self.subTest(headers=headers):
                status, _, data = self.request("GET", "/api/bootstrap", headers=headers)
                self.assertEqual(status, 403)
                self.assertNotIn("csrfToken", data)

    def test_every_post_requires_session_token_even_refresh_and_disconnect(self):
        for path in ("/api/refresh", "/api/disconnect", "/api/connection", "/api/drafts/1", "/api/preview/1", "/api/publish/1", "/api/sync-issue/1"):
            with self.subTest(path=path):
                status, _, data = self.request("POST", path, authenticated=False)
                self.assertEqual(status, 403)
                self.assertEqual(data["code"], "CSRF_REJECTED")
        self.assertEqual(self.github.calls, [])

    def test_wrong_token_origin_and_preflight_cannot_mutate(self):
        for headers in ({"X-Review-Token": "wrong"}, {"X-Review-Token": "é"},
                        {"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                status, _, _ = self.request("POST", "/api/drafts/1", self.draft(), headers=headers)
                self.assertEqual(status, 403)
        status, headers, _ = self.request("OPTIONS", "/api/drafts/1", headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.desk.bootstrap()["drafts"], {})

    def test_json_boundary_rejects_nonfinite_types_content_type_and_large_body(self):
        for body in (b"not-json", b"[]", b'{"latitude": NaN}', b'{"latitude": Infinity}'):
            with self.subTest(body=body):
                status, _, data = self.request("POST", "/api/drafts/1", body)
                self.assertEqual(status, 400)
                self.assertEqual(data["code"], "INVALID_JSON")
        status, _, _ = self.request("POST", "/api/drafts/1", b"{}", headers={"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        status, _, _ = self.request("POST", "/api/drafts/1", b"{}", headers={"Content-Length": str(300000)})
        self.assertEqual(status, 413)

    def test_private_state_repository_files_and_path_traversal_are_not_served(self):
        self.desk.save_draft(1, self.draft())
        for path in ("/state.json", "/private/state.json", "/../private/state.json", "/%2e%2e/private/state.json",
                     "/review_core.py", "/app.py", "/config.js", "/data/map-data.json", "/.git/config", "/api/frame/../../state.json"):
            with self.subTest(path=path):
                status, _, body = self.request("GET", path)
                self.assertEqual(status, 404)
                self.assertNotIn("PRIVATE-NOTE", json.dumps(body))

    def test_fixed_static_and_image_routes_work_and_out_of_range_frames_do_not_proxy(self):
        for path in ("/", "/index.html", "/app.css", "/app.js", "/vendor/d3.min.js", "/context.json"):
            with self.subTest(path=path):
                status, headers, _ = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertIn("frame-src 'none'", headers["Content-Security-Policy"])
        status, headers, content = self.request("GET", "/api/frame/658", raw=True)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/jpeg")
        self.assertEqual(content, b"\xff\xd8\xffTESTJPEG")
        for path in ("/api/frame/0", "/api/frame/683", "/api/frame/-1", "/api/frame/658.0", "/api/frame/https://evil.example/x"):
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path)
                self.assertEqual(status, 404)
        self.assertEqual(self.github.calls, [])

    def test_local_save_preview_publish_and_label_retry_flow_through_http(self):
        status, _, data = self.request("POST", "/api/drafts/1", self.draft())
        self.assertEqual(status, 200)
        self.assertEqual(data["draft"]["decision"], "approved")
        self.assertEqual(self.github.head, self.github.initial_head)
        status, _, connection = self.request("POST", "/api/connection", {"mode": "token", "token": "HTTP-SESSION-SECRET"})
        self.assertEqual(status, 200)
        self.assertTrue(connection["connection"]["canPublish"])
        status, _, preview = self.request("POST", "/api/preview/1")
        self.assertEqual(status, 200)
        self.assertEqual(self.writes(), [])
        self.github.labels_fail = True
        status, _, result = self.request("POST", "/api/publish/1", {"previewId": preview["previewId"]})
        self.assertEqual(status, 200)
        self.assertTrue(result["published"])
        self.assertFalse(result["issueSynced"])
        self.github.labels_fail = False
        status, _, synced = self.request("POST", "/api/sync-issue/1")
        self.assertEqual(status, 200)
        self.assertTrue(synced["issueSynced"])
        self.assertEqual(len(self.writes("/git/commits")), 1)
        self.assertNotIn("HTTP-SESSION-SECRET", (self.data_dir / "state.json").read_text())

    def test_issue_comments_and_offline_cache_are_readable(self):
        self.github.comments = [{"body": "A dated comparison source.", "user": {"login": "reader"},
                                 "html_url": "https://github.com/" + self.desk.bootstrap()["repository"] + "/issues/1#issuecomment-1",
                                 "created_at": "2026-10-18T16:00:00Z"}]
        status, _, result = self.request("GET", "/api/issues/1")
        self.assertEqual(status, 200)
        self.assertEqual(result["comments"][0]["author"], "reader")
        self.github.offline = True
        status, _, result = self.request("GET", "/api/issues/1")
        self.assertEqual(status, 200)
        self.assertEqual(len(result["comments"]), 1)
        self.assertIn("cached", result["warning"])

    def test_export_is_local_explicit_backup_with_no_session_secrets(self):
        self.request("POST", "/api/drafts/1", self.draft())
        self.request("POST", "/api/connection", {"mode": "token", "token": "LOCAL-SESSION-SECRET"})
        status, headers, backup = self.request("GET", "/api/export")
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers["Content-Disposition"])
        encoded = json.dumps(backup)
        self.assertIn(self.draft()["privateNote"], encoded)
        self.assertNotIn("LOCAL-SESSION-SECRET", encoded)
        self.assertNotIn(self.desk.csrf_token, encoded)

    def test_unexpected_errors_and_access_logs_do_not_expose_private_text(self):
        output = io.StringIO()
        def private_exception():
            raise RuntimeError("EXCEPTION-SECRET-PRIVATE-TOKEN")
        self.desk.refresh = private_exception
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            status, _, data = self.request("POST", "/api/refresh?token=QUERY-SECRET")
        self.assertEqual(status, 500)
        self.assertEqual(data["code"], "LOCAL_SERVER_ERROR")
        self.assertNotIn("SECRET", json.dumps(data))
        self.assertEqual(output.getvalue(), "")

    def test_unsupported_mutation_methods_return_json_without_action(self):
        for method in ("PUT", "PATCH", "DELETE"):
            with self.subTest(method=method):
                status, headers, data = self.request(method, "/api/drafts/1")
                self.assertEqual(status, 405)
                self.assertEqual(data["code"], "METHOD_NOT_ALLOWED")
                self.assertTrue(headers["Content-Type"].startswith("application/json"))
        self.assertEqual(self.github.calls, [])


if __name__ == "__main__":
    unittest.main()

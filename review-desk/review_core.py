"""Local review state and a narrowly scoped, preview-first GitHub publisher.

Python 3.10+, standard library only. Importing this module performs no network
requests. Tests supply a fake GitHub transport; production writes only happen
inside publish() / sync_issue() after a local, explicit request.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


REPOSITORY = "hgw3lls/uptight"
BRANCH = "main"
API_ROOT = "/repos/" + REPOSITORY
SITE_URL = "https://hgw3lls.github.io/uptight/"
BOUNDS = [-81.74, 41.43, -81.57, 41.56]
MAP_PATH = "data/map-data.json"
DECISIONS_PATH = "data/review-decisions.json"
REVIEW_LABELS = {
    "pending": "evidence:received",
    "under-review": "evidence:under-review",
    "disputed": "evidence:disputed",
    "approved": "evidence:incorporated",
}
PREVIEW_SECONDS = 15 * 60
MAX_API_BYTES = 32 * 1024 * 1024
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
TEXT_FIELDS = (
    "name", "address", "confidenceLabel", "confidenceNote", "pinNote",
    "publicNote", "privateNote", "baseIssueUpdatedAt",
)


class ReviewError(Exception):
    def __init__(self, message, status=400, code="VALIDATION_ERROR"):
        super().__init__(message)
        self.message, self.status, self.code = message, status, code


class GithubError(ReviewError):
    def __init__(self, message, status=502, code="GITHUB_ERROR", ambiguous=False):
        super().__init__(message, status, code)
        self.ambiguous = ambiguous


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def file_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def git_blob_sha(content):
    return hashlib.sha1(b"blob " + str(len(content)).encode("ascii") + b"\0" + content).hexdigest()


def fingerprint(value):
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _clean(value):
    return value.strip() if isinstance(value, str) else ""


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def valid_frame(value):
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 682


def within_bounds(latitude, longitude, bounds=BOUNDS):
    lat, lon = _number(latitude), _number(longitude)
    return lat is not None and lon is not None and bounds[0] <= lon <= bounds[2] and bounds[1] <= lat <= bounds[3]


def safe_url(value):
    value = _clean(value)
    if not value or len(value) > 4096 or re.search(r"[\s\x00-\x1f\x7f]", value):
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            return None
        # Reading .port also rejects malformed ports instead of leaking them to UI.
        parsed.port
    except ValueError:
        return None
    return value


def source_urls(text):
    result = []
    for value in re.findall(r"https?://[^\s<>\[\]`\"']+", text or ""):
        # GitHub issue-form links are bare URLs or Markdown links. Keep balanced
        # parentheses in archive identifiers while removing Markdown punctuation.
        value = value.rstrip(".,;")
        while value.endswith(")") and value.count(")") > value.count("("):
            value = value[:-1]
        value = safe_url(value)
        if value and value not in result:
            result.append(value)
    return result


def _sections(body):
    parts = re.split(r"(?m)^###\s+([^\n]+)\s*$", body or "")
    result = {}
    for index in range(1, len(parts) - 1, 2):
        key = parts[index].strip().lower()
        value = parts[index + 1].strip()
        if value.lower() in ("_no response_", "no response", "not supplied"):
            value = ""
        result[key] = value
    return result


def normalise_issue(raw):
    if not isinstance(raw, dict) or raw.get("pull_request") or not valid_issue_number(raw.get("number")):
        return None
    number = raw["number"]
    labels = [str(label.get("name", "") if isinstance(label, dict) else label).lower()
              for label in raw.get("labels", []) if isinstance(label, (str, dict))]
    title, body = _clean(raw.get("title")), _clean(raw.get("body"))
    if not (title.lower().startswith("[location evidence]") or "UPTIGHT-EVIDENCE-V1" in body or "location-evidence" in labels):
        return None
    expected_url = "https://github.com/" + REPOSITORY + "/issues/" + str(number)
    if raw.get("html_url") != expected_url:
        return None
    fields = _sections(body)
    reference = fields.get("site reference", "")
    frame_text = fields.get("frame number", "")
    match = re.fullmatch(r"[1-9]\d{0,2}", frame_text)
    frame = int(frame_text) if match and int(frame_text) <= 682 else None
    if frame is None:
        match = re.search(r"(?m)^frame:\s*([1-9]\d{0,2})\s*$", reference)
        if match and int(match.group(1)) <= 682:
            frame = int(match.group(1))
    place_match = re.search(r"(?m)^place:\s*([a-zA-Z0-9_-]{1,100})\s*$", reference)
    question_match = re.search(r"(?m)^question:\s*([^\n]+)\s*$", reference)
    proposal = fields.get("proposed address or map point", "")
    latitude = longitude = None
    point = re.search(r"latitude\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)(?!\w|\.\d)\s*,?\s*longitude\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)(?!\w|\.\d)", proposal, re.I)
    if not point:
        # The native issue form also accepts a standalone decimal latitude,
        # longitude line. Multiple pairs, exponents and embedded prose are not
        # guessed; their original text remains visible for manual assessment.
        pairs = []
        for line in proposal.splitlines():
            line = line.strip()
            if line.startswith("(") and line.endswith(")"):
                line = line[1:-1].strip()
            candidate = re.fullmatch(r"([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)", line)
            if candidate:
                pairs.append(candidate)
        if len(pairs) == 1:
            point = pairs[0]
    if point:
        lat, lon = float(point.group(1)), float(point.group(2))
        if abs(lat) <= 90 and abs(lon) <= 180:
            latitude, longitude = lat, lon
    statuses = [label.split(":", 1)[1] for label in REVIEW_LABELS.values() if label in labels]
    remote_status = "conflicting" if len(statuses) > 1 else statuses[0] if statuses else "received"
    links = source_urls(fields.get("source links", ""))
    attachments = source_urls(fields.get("image and document attachments", ""))
    # Images may be attached inside the evidence text, not only its dedicated box.
    for url in source_urls(fields.get("evidence statement", "")):
        if "github.com/user-attachments/" in url or "githubusercontent.com/" in url:
            if url not in attachments:
                attachments.append(url)
    return {
        "number": number, "title": title[:1000], "url": expected_url,
        "author": _clean((raw.get("user") or {}).get("login")) or "Contributor",
        "state": "closed" if raw.get("state") == "closed" else "open",
        "createdAt": _clean(raw.get("created_at")), "updatedAt": _clean(raw.get("updated_at")),
        "body": body, "remoteStatus": remote_status,
        "fields": {"location": fields.get("location or area", ""), "frame": frame,
                   "question": fields.get("research question", "") or (question_match.group(1) if question_match else ""),
                   "kind": fields.get("contribution type", ""), "evidence": fields.get("evidence statement", ""),
                   "sourceDate": fields.get("source date", ""), "attribution": fields.get("attribution and catalogue reference", ""),
                   "links": links, "proposedAddress": proposal, "latitude": latitude, "longitude": longitude,
                   "place": place_match.group(1) if place_match else "", "attachments": attachments},
    }


def valid_issue_number(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value < 2 ** 31


def strip_images(sites):
    result = copy.deepcopy(sites)
    for site in result:
        for frame in site.get("frames", []):
            frame.pop("image", None)
    return result


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a session token through a redirected request.
        return None


class GitHubClient:
    """Only the fixed repository and /user are reachable through this client."""
    def __init__(self):
        self.mode = "public"
        self._token = None
        self.opener = build_opener(_NoRedirect)

    def disconnect(self):
        self._token = None
        self.mode = "public"

    def set_auth(self, mode, token=None):
        if mode == "token":
            if not isinstance(token, str) or not 10 <= len(token) <= 2000 or re.search(r"[\s\x00-\x1f\x7f]", token):
                raise ReviewError("Enter a valid GitHub token without spaces or line breaks.")
            self._token, self.mode = token, mode
        elif mode == "gh":
            if not shutil.which("gh"):
                raise ReviewError("GitHub CLI is not installed. Install and sign in to gh, or use a session token.", 400, "GH_NOT_INSTALLED")
            self._token, self.mode = None, mode
        else:
            raise ReviewError("Choose GitHub CLI or a session token.")

    def request(self, method, path, payload=None):
        method = method.upper()
        if not (path == "/user" or path == API_ROOT or path.startswith(API_ROOT + "/")) or ".." in path or "\n" in path:
            raise ReviewError("The review desk only accesses its fixed GitHub repository.", 400, "REPOSITORY_RESTRICTED")
        if method not in ("GET", "POST", "PATCH", "DELETE"):
            raise ReviewError("Unsupported GitHub operation.")
        if method != "GET" and self.mode == "public":
            raise ReviewError("Connect a GitHub account before publishing.", 401, "NOT_CONNECTED")
        if self.mode == "gh":
            return self._gh_request(method, path, payload)
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "Uptight-Local-Review-Desk/1.0",
                   "X-GitHub-Api-Version": "2022-11-28"}
        if self._token:
            headers["Authorization"] = "Bearer " + self._token
        data = None
        if payload is not None:
            data = canonical_json(payload)
            headers["Content-Type"] = "application/json"
        request = Request("https://api.github.com" + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=25) as response:
                content = response.read(MAX_API_BYTES + 1)
            if len(content) > MAX_API_BYTES:
                raise GithubError("GitHub returned more data than this review desk can safely read.")
            return json.loads(content) if content else None
        except HTTPError as error:
            # Do not echo raw GitHub bodies, request headers, or token strings.
            messages = {401: "GitHub authentication failed. Reconnect your account.",
                        403: "GitHub denied this operation or its request limit was reached.",
                        404: "The requested GitHub record is unavailable to this account.",
                        409: "GitHub reported a conflict. Refresh and preview the decision again.",
                        422: "GitHub rejected the update. The branch may have changed; preview again.",
                        429: "GitHub's request limit was reached. Try again later."}
            raise GithubError(messages.get(error.code, "GitHub could not complete this operation."),
                              error.code if error.code in (401, 403, 404, 409, 422, 429) else 502,
                              "GITHUB_HTTP_" + str(error.code), ambiguous=method != "GET" and error.code >= 500) from None
        except (URLError, TimeoutError, OSError):
            raise GithubError("The connection to GitHub was interrupted. No success is assumed.",
                              ambiguous=method != "GET") from None
        except (ValueError, UnicodeError):
            raise GithubError("GitHub returned an unreadable response. No success is assumed.",
                              ambiguous=method != "GET") from None

    def _gh_request(self, method, path, payload):
        args = ["gh", "api", "--hostname", "github.com", "--method", method,
                "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28",
                path.lstrip("/")]
        stdin = None
        if payload is not None:
            args.extend(["--input", "-"])
            stdin = canonical_json(payload)
        try:
            result = subprocess.run(args, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=30, check=False)
        except FileNotFoundError:
            raise ReviewError("GitHub CLI is no longer available. Reconnect using an installed CLI or session token.", 401, "GH_NOT_INSTALLED") from None
        except (subprocess.TimeoutExpired, OSError):
            raise GithubError("GitHub CLI did not confirm the operation. No success is assumed.", ambiguous=method != "GET") from None
        if result.returncode:
            # stderr may contain account or environment information; never return it.
            match = re.search(rb"HTTP (\d{3})", result.stderr)
            status = int(match.group(1)) if match else 502
            raise GithubError("GitHub CLI could not complete this operation. Check its sign-in and repository permissions.",
                              status if status in (401, 403, 404, 409, 422, 429) else 502,
                              "GITHUB_HTTP_" + str(status), ambiguous=method != "GET" and status >= 500)
        if len(result.stdout) > MAX_API_BYTES:
            raise GithubError("GitHub CLI returned too much data.", ambiguous=method != "GET")
        try:
            return json.loads(result.stdout) if result.stdout.strip() else None
        except (ValueError, UnicodeError):
            raise GithubError("GitHub CLI returned an unreadable response.", ambiguous=method != "GET") from None


class ReviewDesk:
    def __init__(self, project_root, data_dir, github=None, now=utc_now, monotonic=time.monotonic):
        self.project_root = Path(project_root).resolve()
        self.app_root = self.project_root / "review-desk"
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.github = github or GitHubClient()
        self.now, self.monotonic = now, monotonic
        self.csrf_token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.previews = {}
        self.connection = self._disconnected_connection()
        self.bounds = list(BOUNDS)
        try:
            context = json.loads((self.project_root / "data/cleveland-context.json").read_text("utf-8"))
            if context.get("bounds") == BOUNDS:
                self.bounds = context["bounds"]
        except (OSError, ValueError):
            pass
        self.local_map = self._read_project_map()
        self.state = self._load_state()

    @staticmethod
    def _disconnected_connection():
        return {"connected": False, "mode": "public", "login": None, "canPublish": False,
                "message": "Public reading and local drafts are available. Connect GitHub only when you want to publish."}

    def _read_project_map(self):
        try:
            value = json.loads((self.project_root / MAP_PATH).read_text("utf-8"))
            self._validate_map(value)
            return value
        except (OSError, ValueError):
            raise ReviewError("The local map data is missing or unreadable. Download the complete review-desk package.", 500, "LOCAL_DATA_MISSING") from None

    @staticmethod
    def _validate_map(value):
        if not isinstance(value, dict) or not isinstance(value.get("sites"), list):
            raise ReviewError("Map data has an unexpected structure; it will not be overwritten.", 502, "MAP_FORMAT_CHANGED")
        ids = []
        for site in value["sites"]:
            if not isinstance(site, dict) or not isinstance(site.get("id"), str) or not isinstance(site.get("frames", []), list):
                raise ReviewError("A map site has an unexpected structure; it will not be overwritten.", 502, "MAP_FORMAT_CHANGED")
            ids.append(site["id"])
        if len(ids) != len(set(ids)):
            raise ReviewError("The map has duplicate site IDs; resolve them before publishing.", 409, "MAP_FORMAT_CHANGED")

    def _load_state(self):
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.data_dir, 0o700)
        except OSError:
            pass
        path = self.data_dir / "state.json"
        if path.exists():
            try:
                value = json.loads(path.read_text("utf-8"))
                if value.get("schemaVersion") != 1 or not isinstance(value.get("drafts"), dict) or not isinstance(value.get("publications"), dict):
                    raise ValueError("Unexpected state format")
                return value
            except (OSError, ValueError, AttributeError):
                raise ReviewError("Local review state could not be read. Keep the existing state.json backup and use a new --data-dir; it has not been overwritten.", 500, "STATE_UNREADABLE") from None
        value = {"schemaVersion": 1, "rawIssues": [], "comments": {}, "drafts": {}, "history": [],
                 "publications": {}, "lastRefresh": None, "refreshError": "", "truncated": False,
                 "sites": strip_images(self.local_map["sites"])}
        seed = self.app_root / "seed/issues.json"
        try:
            snapshot = json.loads(seed.read_text("utf-8"))
            raw_issues = snapshot.get("issues", []) if isinstance(snapshot, dict) else snapshot
            value["rawIssues"] = [raw for raw in raw_issues if normalise_issue(raw)]
            value["lastRefresh"] = snapshot.get("snapshotAt") if isinstance(snapshot, dict) else None
            value["refreshError"] = "Showing the bundled public snapshot. Refresh to check for newer submissions."
        except (OSError, ValueError, TypeError):
            value["refreshError"] = "No cached submissions yet. Refresh to read the public inbox."
        return value

    def _persist(self):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="wb", prefix="state-", suffix=".tmp", dir=self.data_dir, delete=False) as handle:
                temporary = Path(handle.name)
                try:
                    os.chmod(temporary, 0o600)
                except OSError:
                    pass
                handle.write(file_json(self.state))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.data_dir / "state.json")
        except OSError:
            raise ReviewError("The local review state could not be saved. Check disk space and folder permissions before publishing.", 500, "STATE_WRITE_FAILED") from None
        finally:
            if temporary and temporary.exists():
                temporary.unlink(missing_ok=True)

    def bootstrap(self):
        with self.lock:
            return {"csrfToken": self.csrf_token, "repository": REPOSITORY, "siteUrl": SITE_URL,
                    "bounds": list(self.bounds), "connection": copy.deepcopy(self.connection),
                    "issues": sorted([item for raw in self.state["rawIssues"] if (item := normalise_issue(raw))],
                                     key=lambda item: item["updatedAt"], reverse=True),
                    "sites": copy.deepcopy(self.state["sites"]), "drafts": copy.deepcopy(self.state["drafts"]),
                    "history": copy.deepcopy(self.state["history"]), "lastRefresh": self.state["lastRefresh"],
                    "refreshError": self.state["refreshError"], "truncated": self.state["truncated"]}

    def connect(self, mode, token=None):
        with self.lock:
            self.previews.clear()
            self.github.disconnect()
            self.connection = self._disconnected_connection()
            try:
                self.github.set_auth(mode, token)
                repo = self.github.request("GET", API_ROOT)
                permissions = repo.get("permissions", {}) if isinstance(repo, dict) else {}
                if not (isinstance(repo, dict) and repo.get("full_name", "").lower() == REPOSITORY.lower() and permissions.get("push") is True):
                    raise ReviewError("This account does not have push access to hgw3lls/uptight. Reading and local drafts remain available.", 403, "PUSH_ACCESS_REQUIRED")
                user = self.github.request("GET", "/user")
                login = _clean(user.get("login")) if isinstance(user, dict) else ""
                if not login:
                    raise ReviewError("GitHub did not identify the connected account.", 401, "AUTH_IDENTITY_MISSING")
                self.connection = {"connected": True, "mode": mode, "login": login, "canPublish": True,
                                   "message": "Connected as " + login + ". Publication still requires an explicit preview and Publish action."}
            except Exception:
                self.github.disconnect()
                raise
            return {"connection": copy.deepcopy(self.connection)}

    def disconnect(self):
        with self.lock:
            self.previews.clear()
            self.github.disconnect()
            self.connection = self._disconnected_connection()
            return {"connection": copy.deepcopy(self.connection)}

    def _cache_issue(self, raw):
        issue = normalise_issue(raw)
        if not issue:
            raise ReviewError("This issue is not a recognized Uptight location-evidence submission.", 404, "ISSUE_NOT_FOUND")
        self.state["rawIssues"] = [item for item in self.state["rawIssues"] if item.get("number") != issue["number"]] + [copy.deepcopy(raw)]
        return issue

    def _cached_issue(self, number):
        if not valid_issue_number(number):
            raise ReviewError("Invalid issue number.", 404, "ISSUE_NOT_FOUND")
        for raw in self.state["rawIssues"]:
            if raw.get("number") == number:
                issue = normalise_issue(raw)
                if issue:
                    return issue
        raise ReviewError("This submission is not in the local inbox. Refresh the public records first.", 404, "ISSUE_NOT_FOUND")

    def _latest_issue(self, number):
        raw = self.github.request("GET", API_ROOT + "/issues/" + str(number))
        issue = self._cache_issue(raw)
        self._persist()
        return issue

    def refresh(self):
        with self.lock:
            fetched, complete, last_success, error = [], False, None, ""
            for page in range(1, 11):
                try:
                    rows = self.github.request("GET", API_ROOT + "/issues?state=all&sort=updated&direction=desc&per_page=100&page=" + str(page))
                    if not isinstance(rows, list):
                        raise GithubError("GitHub returned an unexpected issue list.")
                    fetched.extend(raw for raw in rows if normalise_issue(raw))
                    last_success = self.now()
                    if len(rows) < 100:
                        complete = True
                        break
                except ReviewError as exc:
                    error = exc.message
                    break
            if last_success:
                merged = {} if complete else {raw["number"]: raw for raw in self.state["rawIssues"]}
                merged.update({raw["number"]: raw for raw in fetched})
                self.state["rawIssues"] = list(merged.values())
                self.state["lastRefresh"] = last_success
                self.state["truncated"] = not complete
            self.state["refreshError"] = error or ("The inbox reached its 1,000-issue scan limit; older cached records are retained." if not complete else "")
            if last_success:
                try:
                    snapshot = self._snapshot()
                    map_data = self._read_json_blob(snapshot, MAP_PATH)
                    self._validate_map(map_data)
                    self.state["sites"] = strip_images(map_data["sites"])
                except ReviewError as exc:
                    message = "The issue check completed, but current map data could not be refreshed: " + exc.message
                    self.state["refreshError"] = (self.state["refreshError"] + " " + message).strip()
            self._persist()
            return self.bootstrap()

    def issue_detail(self, number):
        with self.lock:
            cached = self._cached_issue(number)
            comments, warning = [], ""
            try:
                issue = self._latest_issue(number)
                for page in range(1, 11):
                    rows = self.github.request("GET", API_ROOT + "/issues/" + str(number) + "/comments?per_page=100&page=" + str(page))
                    if not isinstance(rows, list):
                        raise GithubError("GitHub returned an unexpected comment list.")
                    for raw in rows:
                        comments.append({"body": _clean(raw.get("body")), "author": _clean((raw.get("user") or {}).get("login")),
                                         "url": safe_url(raw.get("html_url")) or "", "createdAt": _clean(raw.get("created_at"))})
                    if len(rows) < 100:
                        break
                else:
                    warning = "Showing the first 1,000 comments. The issue retains the complete discussion."
                self.state["comments"][str(number)] = {"items": comments, "checkedAt": self.now()}
                self._persist()
            except ReviewError as exc:
                issue = self._cached_issue(number) if self.state["rawIssues"] else cached
                saved = self.state["comments"].get(str(number), {})
                comments = comments or saved.get("items", [])
                warning = "Showing cached or partially fetched evidence. " + exc.message
            return {"issue": issue, "comments": comments, "warning": warning}

    def save_draft(self, number, raw):
        with self.lock:
            issue = self._cached_issue(number)
            if not isinstance(raw, dict):
                raise ReviewError("A review draft must be a JSON object.")
            defaults = {"decision": "pending", "mode": "evidence", "place": issue["fields"]["place"],
                        "status": "Candidate", "latitude": None, "longitude": None}
            draft = {}
            for key, default in defaults.items():
                draft[key] = raw.get(key, default)
            for key in TEXT_FIELDS:
                value = raw.get(key, issue["updatedAt"] if key == "baseIssueUpdatedAt" else "")
                if not isinstance(value, str):
                    raise ReviewError(key + " must be text.")
                if len(value) > (30000 if key in ("publicNote", "privateNote") else 12000):
                    raise ReviewError(key + " is too long.")
                draft[key] = value.strip()
            if draft["decision"] not in REVIEW_LABELS or draft["mode"] not in ("evidence", "location"):
                raise ReviewError("Choose a valid review decision and edit mode.")
            if draft["status"] not in ("Candidate", "Strong match", "Unplaced"):
                raise ReviewError("Choose Candidate, Strong match or Unplaced for map confidence.")
            site_ids = {site["id"] for site in self.state["sites"]}
            if not isinstance(draft["place"], str) or draft["place"] not in site_ids | {"new", ""}:
                raise ReviewError("Choose an existing map location or a new location.")
            for key in ("latitude", "longitude"):
                value = draft[key]
                if value is not None and _number(value) is None:
                    raise ReviewError(key + " must be a finite number or empty.")
            previous = self.state["drafts"].get(str(number))
            self.state["drafts"][str(number)] = draft
            try:
                self._persist()
            except ReviewError:
                if previous is None:
                    self.state["drafts"].pop(str(number), None)
                else:
                    self.state["drafts"][str(number)] = previous
                raise
            return {"draft": copy.deepcopy(draft)}

    def _head(self):
        ref = self.github.request("GET", API_ROOT + "/git/ref/heads/" + BRANCH)
        sha = (ref.get("object") or {}).get("sha") if isinstance(ref, dict) else None
        if not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
            raise GithubError("GitHub did not return a valid main-branch head.")
        return sha

    def _tree(self, sha):
        tree = self.github.request("GET", API_ROOT + "/git/trees/" + sha + "?recursive=1")
        if not isinstance(tree, dict) or tree.get("truncated") is not False or not isinstance(tree.get("tree"), list):
            raise ReviewError("GitHub did not return the complete repository tree; publication is blocked to protect existing files.", 409, "TREE_INCOMPLETE")
        entries = {}
        for item in tree["tree"]:
            if item.get("type") == "tree":
                continue
            path = item.get("path")
            if not isinstance(path, str) or path in entries or item.get("type") not in ("blob", "commit") or not SHA_RE.fullmatch(str(item.get("sha", ""))):
                raise ReviewError("The repository tree could not be verified.", 409, "TREE_INVALID")
            entries[path] = {key: item.get(key) for key in ("mode", "type", "sha")}
        return entries

    def _snapshot(self):
        head = self._head()
        commit = self.github.request("GET", API_ROOT + "/git/commits/" + head)
        tree_sha = (commit.get("tree") or {}).get("sha") if isinstance(commit, dict) else None
        if not isinstance(tree_sha, str) or not SHA_RE.fullmatch(tree_sha):
            raise GithubError("The current commit does not have a verifiable tree.")
        return {"head": head, "tree": tree_sha, "entries": self._tree(tree_sha)}

    def _read_json_blob(self, snapshot, path, default=None):
        entry = snapshot["entries"].get(path)
        if entry is None:
            if default is not None:
                return copy.deepcopy(default)
            raise ReviewError("Required repository file is missing: " + path, 409, "REMOTE_FILE_MISSING")
        if entry["type"] != "blob" or entry["mode"] not in ("100644", "100755"):
            raise ReviewError("A review data file is not a regular file: " + path, 409, "REMOTE_FILE_UNSAFE")
        blob = self.github.request("GET", API_ROOT + "/git/blobs/" + entry["sha"])
        try:
            if blob.get("encoding") != "base64" or not isinstance(blob.get("content"), str):
                raise ValueError()
            content = base64.b64decode("".join(blob["content"].split()), validate=True)
            if git_blob_sha(content) != entry["sha"]:
                raise ValueError()
            return json.loads(content)
        except (ValueError, TypeError, AttributeError, UnicodeError):
            raise ReviewError("Remote JSON could not be verified: " + path, 409, "REMOTE_FILE_UNVERIFIED") from None

    def _validate_publication(self, draft, issue, sites):
        if draft["baseIssueUpdatedAt"] != issue["updatedAt"]:
            raise ReviewError("The submission changed after this draft was started. Refresh its evidence, save the reviewed draft against the new version, then preview again.", 409, "ISSUE_CHANGED")
        if len(draft["publicNote"]) < 20:
            raise ReviewError("Add a public review note of at least 20 characters explaining the decision and its limits.")
        by_id = {site["id"]: site for site in sites}
        if draft["place"] not in ("", "new") and draft["place"] not in by_id:
            raise ReviewError("The selected map location no longer exists. Refresh and choose a current location.", 409, "SITE_CHANGED")
        if draft["decision"] == "approved" and draft["mode"] == "location":
            if draft["place"] == "":
                raise ReviewError("Choose the existing location to update or explicitly choose a new location.")
            if not valid_frame(issue["fields"]["frame"]):
                raise ReviewError("A location change requires a valid submission frame from 1 to 682. General historical evidence can be approved in evidence-only mode.")
            if not within_bounds(draft["latitude"], draft["longitude"], self.bounds):
                raise ReviewError("Choose a coordinate inside the Cleveland research boundary before publishing a location.", 400, "POINT_OUTSIDE_AREA")
            if draft["status"] == "Unplaced":
                raise ReviewError("A published coordinate needs Candidate or Strong match confidence. Use evidence-only review to leave a scene unplaced.")
            for key, minimum in (("name", 2), ("confidenceLabel", 3), ("confidenceNote", 20), ("pinNote", 20)):
                if len(draft[key]) < minimum:
                    raise ReviewError("Complete " + key + " before publishing this coordinate. Explain what the point represents and what remains uncertain.")
            if draft["place"] == "new" and "issue-" + str(issue["number"]) in by_id:
                raise ReviewError("This issue already created a map location. Select that existing location to revise it.", 409, "SITE_ALREADY_EXISTS")

    def _frame_reference(self, frame, sites):
        for site in sites:
            for item in site.get("frames", []):
                if item.get("id") == frame:
                    return copy.deepcopy(item)
        seconds = None
        try:
            index = json.loads((self.project_root / "data/film-frames.json").read_text("utf-8"))
            seconds = next((row[1] for row in index.get("frames", []) if row[0] == frame), None)
        except (OSError, ValueError, TypeError, IndexError):
            pass
        stamp = ""
        if isinstance(seconds, (int, float)) and math.isfinite(seconds) and seconds >= 0:
            milliseconds = round(seconds * 1000)
            stamp = "%02d:%02d:%02d.%03d" % (milliseconds // 3600000, milliseconds // 60000 % 60, milliseconds // 1000 % 60, milliseconds % 1000)
        return {"id": frame, "time": stamp, "image": "media/frames/%08d.jpg" % frame}

    def _build_change(self, number, draft, issue, snapshot):
        map_data = self._read_json_blob(snapshot, MAP_PATH)
        self._validate_map(map_data)
        self._validate_publication(draft, issue, map_data["sites"])
        ledger = self._read_json_blob(snapshot, DECISIONS_PATH, {"schemaVersion": 1, "updatedAt": None, "decisions": []})
        if not isinstance(ledger, dict) or ledger.get("schemaVersion") != 1 or not isinstance(ledger.get("decisions"), list):
            raise ReviewError("The public review ledger has an unexpected format; it will not be overwritten.", 409, "LEDGER_FORMAT_CHANGED")
        reviewed_at = self.now()
        record_id = "review-" + str(number) + "-" + secrets.token_hex(8)
        source_links = list(dict.fromkeys(issue["fields"]["links"] + issue["fields"]["attachments"]))
        site_id = ("issue-" + str(number) if draft["decision"] == "approved" and draft["mode"] == "location" else None) if draft["place"] == "new" else draft["place"] or None
        record = {"id": record_id, "issueNumber": number, "issueUrl": issue["url"], "issueUpdatedAt": issue["updatedAt"],
                  "reviewedAt": reviewed_at, "reviewer": self.connection["login"] or "Maintainer",
                  "decision": draft["decision"], "mode": draft["mode"], "siteId": site_id,
                  "frame": issue["fields"]["frame"], "publicNote": draft["publicNote"], "sourceLinks": source_links,
                  "sourceDate": issue["fields"]["sourceDate"], "attribution": issue["fields"]["attribution"], "changes": []}
        before_sites = copy.deepcopy(map_data["sites"])
        site = next((item for item in map_data["sites"] if item["id"] == site_id), None)
        warnings = []
        if draft["decision"] == "approved":
            if draft["mode"] == "location":
                if draft["place"] == "new":
                    site = {"id": site_id, "name": draft["name"], "coord": None, "address": "", "status": "Unplaced",
                            "frames": [self._frame_reference(issue["fields"]["frame"], map_data["sites"])],
                            "connection": "Location proposed in public evidence issue #" + str(number) + ".",
                            "history": "", "sources": []}
                    map_data["sites"].append(site)
                    record["changes"].append({"field": "sites." + site_id, "before": None, "after": "New map location for frame " + str(issue["fields"]["frame"])})
                before = {key: copy.deepcopy(site.get(key)) for key in ("name", "address", "coord", "status", "confidenceLabel", "confidenceNote", "pinNote")}
                old_coordinate_metadata = {key: copy.deepcopy(site[key]) for key in ("coordinateSourceIds", "coordinateUncertaintyMeters", "coordinateReview") if key in site}
                proposed = {key: draft[key] for key in ("name", "address", "status", "confidenceLabel", "confidenceNote", "pinNote")}
                proposed["coord"] = [draft["longitude"], draft["latitude"]]
                for key, value in proposed.items():
                    if before[key] != value:
                        record["changes"].append({"field": "sites." + site_id + "." + key, "before": before[key], "after": value})
                    site[key] = copy.deepcopy(value)
                if before["coord"] != proposed["coord"] and draft["place"] != "new":
                    previous = site.setdefault("previousMapPositions", [])
                    if not isinstance(previous, list):
                        raise ReviewError("Existing position history has an unexpected structure; it will not be overwritten.", 409, "MAP_FORMAT_CHANGED")
                    previous.append({**before, **old_coordinate_metadata, "supersededAt": reviewed_at, "reviewId": record_id, "issueUrl": issue["url"],
                                     "assessment": "Superseded by the explicit location review in issue #" + str(number) + ". Original research is retained."})
                if before["coord"] != proposed["coord"]:
                    for key in ("coordinateSourceIds", "coordinateUncertaintyMeters"):
                        if key in site:
                            record["changes"].append({"field": "sites." + site_id + "." + key, "before": copy.deepcopy(site[key]), "after": None})
                            site.pop(key)
                    coordinate_review = {"issueNumber": number, "issueUrl": issue["url"], "reviewId": record_id,
                                         "reviewDate": reviewed_at[:10], "note": draft["pinNote"]}
                    record["changes"].append({"field": "sites." + site_id + ".coordinateReview", "before": old_coordinate_metadata.get("coordinateReview"), "after": coordinate_review})
                    site["coordinateReview"] = coordinate_review
                if not any(frame.get("id") == issue["fields"]["frame"] for frame in site["frames"]):
                    before_frames = [frame.get("id") for frame in site["frames"]]
                    site["frames"].append(self._frame_reference(issue["fields"]["frame"], map_data["sites"]))
                    record["changes"].append({"field": "sites." + site_id + ".frames", "before": before_frames,
                                               "after": [frame.get("id") for frame in site["frames"]]})
                warnings.append("This point represents a landmark, site or area. It does not establish the film camera station.")
                if draft["status"] == "Candidate":
                    warnings.append("Approval will publish a Candidate pin; it will not turn this identification into a Strong match.")
            elif draft["place"] == "new":
                site = None
                warnings.append("Evidence-only approval records the review without creating a new map location.")
            if site is not None:
                reviews = site.setdefault("reviewedContributions", [])
                if not isinstance(reviews, list):
                    raise ReviewError("Existing site review records have an unexpected structure.", 409, "MAP_FORMAT_CHANGED")
                review_note = {"issueNumber": number, "issueUrl": issue["url"], "reviewDate": reviewed_at[:10],
                               "decision": draft["decision"], "publicNote": draft["publicNote"],
                               "sourceLinks": source_links, "mode": draft["mode"]}
                reviews.append(review_note)
                site["reviewDate"] = reviewed_at[:10]
                sources = site.setdefault("sources", [])
                if not isinstance(sources, list):
                    raise ReviewError("Existing site sources have an unexpected structure.", 409, "MAP_FORMAT_CHANGED")
                existing_urls = {entry[1] for entry in sources if isinstance(entry, list) and len(entry) >= 2 and isinstance(entry[1], str)}
                for url in source_links:
                    if url not in existing_urls:
                        sources.append(["Source submitted with issue #" + str(number), url])
                        existing_urls.add(url)
                if issue["url"] not in existing_urls:
                    sources.append(["Public evidence and review: issue #" + str(number), issue["url"]])
                record["changes"].append({"field": "sites." + site_id + ".reviewedContributions", "before": len(reviews) - 1,
                                           "after": review_note})
            else:
                warnings.append("No existing location is linked. This approval is retained in the public review ledger only.")
        else:
            warnings.append("This publishes the review status and public note only. It does not change any map location.")
        record["changes"].append({"field": "issue.reviewStatus", "before": issue["remoteStatus"],
                                   "after": REVIEW_LABELS[draft["decision"]].split(":", 1)[1]})
        ledger["decisions"].append(record)
        ledger["updatedAt"] = reviewed_at
        files = {DECISIONS_PATH: file_json(ledger)}
        if map_data["sites"] != before_sites:
            files[MAP_PATH] = file_json(map_data)
        return {"record": record, "files": files, "warnings": warnings, "sites": strip_images(map_data["sites"])}

    def _pending_for_issue(self, number):
        pending = [item for item in self.state["publications"].values()
                   if item["issueNumber"] == number and item["state"] in ("prepared", "ambiguous")]
        return pending[-1] if pending else None

    def preview(self, number):
        with self.lock:
            pending = self._pending_for_issue(number)
            if pending:
                resolution = self._reconcile(pending)
                if resolution == "published":
                    raise ReviewError("The earlier publication is now verified. Refresh the desk to see its history; retry issue-label synchronization if marked pending.", 409, "ALREADY_PUBLISHED")
                if resolution == "parent":
                    issue = self._latest_issue(number)
                    draft = self.state["drafts"].get(str(number))
                    identity_matches = not self.connection["connected"] or self.connection["login"] == pending["record"]["reviewer"]
                    if draft is not None and fingerprint(draft) == pending["draftFingerprint"] and issue["updatedAt"] == pending["issueUpdatedAt"] and identity_matches:
                        result = copy.deepcopy(pending["preview"])
                        result["warnings"].append("An earlier network response was interrupted. Publishing this preview retries the same existing commit; it will not create a second review.")
                        return result
                    # A stale, unpublished transaction must not permanently trap
                    # the editor in its old preview. A future race is still guarded
                    # by the new preview's exact parent and non-force ref update.
                    pending["state"] = "retired"
                    pending["warning"] = "The prepared commit is not on main and its draft or evidence changed. It was retired before creating a fresh preview."
                    self._persist()
                elif resolution != "published":
                    raise ReviewError("The branch changed during an earlier unconfirmed publication. Its commit was not found on main; review the current records and save a fresh decision.", 409, "HEAD_CHANGED")
            draft = self.state["drafts"].get(str(number))
            if not draft:
                raise ReviewError("Save the local review draft before previewing it.")
            issue = self._latest_issue(number)
            snapshot = self._snapshot()
            built = self._build_change(number, draft, issue, snapshot)
            if not self.connection["connected"]:
                built["warnings"].append("This is a read-only preview. Connect the publishing account and create a fresh preview so the review records the correct reviewer.")
            preview_id = secrets.token_urlsafe(24)
            result = {"previewId": preview_id, "issueNumber": number, "decision": draft["decision"],
                      "changes": built["record"]["changes"], "publicNote": draft["publicNote"],
                      "sourceLinks": built["record"]["sourceLinks"], "files": sorted(built["files"]),
                      "warnings": built["warnings"],
                      "summary": "Publish " + draft["decision"] + " review for issue #" + str(number) +
                                 (" and its explicit location change." if draft["decision"] == "approved" and draft["mode"] == "location" else ".")}
            self.previews[preview_id] = {"public": result, "draftFingerprint": fingerprint(draft),
                                         "issueUpdatedAt": issue["updatedAt"], "snapshot": snapshot,
                                         "expires": self.monotonic() + PREVIEW_SECONDS, **built}
            self.state["sites"] = strip_images(self._read_json_blob(snapshot, MAP_PATH)["sites"])
            self._persist()
            self.previews = {key: value for key, value in self.previews.items() if value["expires"] > self.monotonic()}
            return copy.deepcopy(result)

    def _require_connection(self):
        if not self.connection.get("canPublish"):
            raise ReviewError("Connect an account with repository push access before publishing.", 401, "NOT_CONNECTED")

    def _check_unchanged(self, number, draft_fingerprint, issue_updated_at, parent):
        draft = self.state["drafts"].get(str(number))
        if draft is None or fingerprint(draft) != draft_fingerprint:
            raise ReviewError("The saved draft changed after preview. Create a fresh preview before publishing.", 409, "DRAFT_CHANGED")
        issue = self._latest_issue(number)
        if issue["updatedAt"] != issue_updated_at:
            raise ReviewError("The public submission changed after preview. Read its latest evidence and preview again.", 409, "ISSUE_CHANGED")
        if self._head() != parent:
            raise ReviewError("The website changed after preview. Create a fresh preview against the current version.", 409, "HEAD_CHANGED")

    def _verify_tree(self, original, new_tree, files):
        expected = copy.deepcopy(original)
        for path, content in files.items():
            expected[path] = {"mode": original.get(path, {}).get("mode", "100644"), "type": "blob", "sha": git_blob_sha(content)}
        if self._tree(new_tree) != expected:
            raise ReviewError("The proposed repository tree did not preserve every unrelated file. The branch was not updated.", 409, "TREE_PRESERVATION_FAILED")

    def publish(self, number, preview_id):
        with self.lock:
            self._require_connection()
            if not isinstance(preview_id, str) or not preview_id:
                raise ReviewError("A saved preview is required before publishing.")
            previous = self.state["publications"].get(preview_id)
            if previous:
                if previous["issueNumber"] != number:
                    raise ReviewError("This preview belongs to a different issue.", 409, "PREVIEW_MISMATCH")
                if previous["state"] == "published":
                    return self._publication_result(previous)
                if previous["state"] in ("prepared", "ambiguous"):
                    resolution = self._reconcile(previous)
                    if resolution == "published":
                        return self._finish_labels(previous)
                    if resolution == "parent":
                        self._check_unchanged(number, previous["draftFingerprint"], previous["issueUpdatedAt"], previous["parentSha"])
                        return self._advance_ref(previous)
                raise ReviewError("This old publication cannot be retried. Create a fresh preview against the current website.", 409, "HEAD_CHANGED")
            pending = self._pending_for_issue(number)
            if pending:
                raise ReviewError("An earlier publication must be reconciled first. Use a fresh preview to inspect its existing commit.", 409, "PUBLICATION_AMBIGUOUS")
            preview = self.previews.get(preview_id)
            if not preview or preview["public"]["issueNumber"] != number or preview["expires"] <= self.monotonic():
                raise ReviewError("This preview expired or belongs to a previous server session. Create a fresh preview.", 409, "PREVIEW_EXPIRED")
            if preview["record"]["reviewer"] != self.connection["login"]:
                raise ReviewError("The publishing account differs from this preview. Create a fresh authenticated preview.", 409, "REVIEWER_CHANGED")
            snapshot = preview["snapshot"]
            self._check_unchanged(number, preview["draftFingerprint"], preview["issueUpdatedAt"], snapshot["head"])
            tree_items = []
            for path, content in sorted(preview["files"].items()):
                created = self.github.request("POST", API_ROOT + "/git/blobs", {"content": base64.b64encode(content).decode("ascii"), "encoding": "base64"})
                expected_sha = git_blob_sha(content)
                if not isinstance(created, dict) or created.get("sha") != expected_sha:
                    raise ReviewError("GitHub did not confirm the exact previewed file bytes. The branch was not updated.", 502, "BLOB_UNVERIFIED")
                tree_items.append({"path": path, "mode": snapshot["entries"].get(path, {}).get("mode", "100644"), "type": "blob", "sha": expected_sha})
            tree = self.github.request("POST", API_ROOT + "/git/trees", {"base_tree": snapshot["tree"], "tree": tree_items})
            tree_sha = tree.get("sha") if isinstance(tree, dict) else None
            if not isinstance(tree_sha, str) or not SHA_RE.fullmatch(tree_sha):
                raise GithubError("GitHub did not confirm the proposed tree. The branch was not updated.")
            self._verify_tree(snapshot["entries"], tree_sha, preview["files"])
            self._check_unchanged(number, preview["draftFingerprint"], preview["issueUpdatedAt"], snapshot["head"])
            created = self.github.request("POST", API_ROOT + "/git/commits", {
                "message": "Review location evidence #" + str(number) + ": " + preview["record"]["decision"] + " (" + preview["record"]["mode"] + ")",
                "tree": tree_sha, "parents": [snapshot["head"]]})
            commit_sha = created.get("sha") if isinstance(created, dict) else None
            if not isinstance(commit_sha, str) or not SHA_RE.fullmatch(commit_sha):
                raise GithubError("GitHub did not confirm the review commit. The branch was not updated.")
            commit = self.github.request("GET", API_ROOT + "/git/commits/" + commit_sha)
            if (commit.get("tree") or {}).get("sha") != tree_sha or [parent.get("sha") for parent in commit.get("parents", [])] != [snapshot["head"]]:
                raise ReviewError("The new commit does not match the preview parent and tree. The branch was not updated.", 502, "COMMIT_UNVERIFIED")
            self._check_unchanged(number, preview["draftFingerprint"], preview["issueUpdatedAt"], snapshot["head"])
            journal = {"id": preview_id, "issueNumber": number, "state": "prepared", "parentSha": snapshot["head"],
                       "commitSha": commit_sha, "treeSha": tree_sha, "createdAt": self.now(),
                       "draftFingerprint": preview["draftFingerprint"], "issueUpdatedAt": preview["issueUpdatedAt"],
                       "record": copy.deepcopy(preview["record"]), "preview": copy.deepcopy(preview["public"]),
                       "sites": preview["sites"], "issueSynced": False, "warning": "Publication has not been confirmed."}
            self.state["publications"][preview_id] = journal
            # Durably journal the exact commit BEFORE touching main. An interrupted
            # response is retried with this same commit, never a duplicate review.
            self._persist()
            return self._advance_ref(journal)

    def _commit_reachable(self, commit_sha, head):
        if head == commit_sha:
            return True
        comparison = self.github.request("GET", API_ROOT + "/compare/" + commit_sha + "..." + head)
        return isinstance(comparison, dict) and comparison.get("status") in ("ahead", "identical") and (comparison.get("merge_base_commit") or {}).get("sha") == commit_sha

    def _reconcile(self, journal):
        try:
            head = self._head()
            if head == journal["commitSha"] or (head != journal["parentSha"] and self._commit_reachable(journal["commitSha"], head)):
                self._mark_published(journal, update_sites=head == journal["commitSha"])
                if head != journal["commitSha"]:
                    try:
                        snapshot = self._snapshot()
                        current_map = self._read_json_blob(snapshot, MAP_PATH)
                        self._validate_map(current_map)
                        self.state["sites"] = strip_images(current_map["sites"])
                        self._persist()
                    except ReviewError:
                        self.state["refreshError"] = "The review commit is verified, but newer map data could not be refreshed. Refresh the inbox when the connection is available."
                return "published"
            if head == journal["parentSha"]:
                return "parent"
            journal["state"] = "rejected"
            journal["warning"] = "Main changed and does not contain the prepared review commit. A fresh preview is required."
            self._persist()
            return "diverged"
        except ReviewError as exc:
            if exc.code == "STATE_WRITE_FAILED":
                raise
            journal["state"] = "ambiguous"
            journal["warning"] = "The branch could not be checked. Publication is unconfirmed; do not create a duplicate review."
            self._persist()
            raise ReviewError(journal["warning"], 409, "PUBLICATION_AMBIGUOUS") from None

    def _advance_ref(self, journal):
        if journal["record"]["reviewer"] != self.connection["login"]:
            raise ReviewError("This prepared commit belongs to a different reviewing account. Create a fresh preview with the connected account.", 409, "REVIEWER_CHANGED")
        # Enforce this on EVERY attempt, including a retry after an earlier disk
        # error. An in-memory journal alone is not safe crash recovery.
        self._persist()
        try:
            self.github.request("PATCH", API_ROOT + "/git/refs/heads/" + BRANCH, {"sha": journal["commitSha"], "force": False})
        except ReviewError as exc:
            # Even a rejected response is checked: a previous identical retry may
            # already have succeeded. Never equate a request error with no write.
            journal["state"] = "ambiguous"
            journal["warning"] = "The branch update was not confirmed. Its exact commit will be checked before any retry."
            self._persist()
            try:
                resolution = self._reconcile(journal)
            except ReviewError:
                raise ReviewError("Publication is unconfirmed because the connection was interrupted. Preview again to reconcile the existing commit before retrying.", 409, "PUBLICATION_AMBIGUOUS") from None
            if resolution == "published":
                return self._finish_labels(journal)
            if resolution == "parent" and not getattr(exc, "ambiguous", True) and exc.status in (401, 403, 404, 409, 422):
                journal["state"] = "rejected"
                journal["warning"] = "GitHub rejected the branch update. No publication was found on main."
                self._persist()
                raise ReviewError(journal["warning"] + " Reconnect if needed, then create a fresh preview.", exc.status, exc.code) from None
            if resolution == "diverged":
                raise ReviewError("Main changed before the review could be published. Create a fresh preview; unrelated work has been preserved.", 409, "HEAD_CHANGED") from None
            raise ReviewError("Publication is unconfirmed. Preview again to check and, if necessary, retry the same existing commit.", 409, "PUBLICATION_AMBIGUOUS") from None
        if self._reconcile(journal) != "published":
            raise ReviewError("GitHub's response did not establish that the review is on main. Preview again to reconcile it.", 409, "PUBLICATION_AMBIGUOUS")
        return self._finish_labels(journal)

    def _mark_published(self, journal, update_sites=True):
        first = journal["state"] != "published"
        journal["state"] = "published"
        journal.setdefault("publishedAt", self.now())
        if first:
            journal["warning"] = "Review committed; issue label synchronization is pending."
        if update_sites:
            self.state["sites"] = copy.deepcopy(journal["sites"])
        self._update_history(journal)
        self._persist()

    def _record(self, journal):
        return {**copy.deepcopy(journal["record"]), "commitSha": journal["commitSha"],
                "commitUrl": "https://github.com/" + REPOSITORY + "/commit/" + journal["commitSha"],
                "publishedAt": journal.get("publishedAt"), "issueSynced": journal["issueSynced"], "warning": journal["warning"]}

    def _update_history(self, journal):
        record = self._record(journal)
        self.state["history"] = [item for item in self.state["history"] if item["id"] != record["id"]] + [record]

    def _publication_result(self, journal):
        record = self._record(journal)
        return {"published": True, "commitSha": journal["commitSha"], "commitUrl": record["commitUrl"],
                "issueUrl": record["issueUrl"], "issueSynced": journal["issueSynced"], "warning": journal["warning"], "record": record}

    def _sync_labels(self, journal):
        number = journal["issueNumber"]
        raw = self.github.request("GET", API_ROOT + "/issues/" + str(number))
        if not normalise_issue(raw):
            raise ReviewError("The evidence issue could not be verified for label synchronization.", 409, "ISSUE_NOT_FOUND")
        names = {label.get("name") if isinstance(label, dict) else label for label in raw.get("labels", [])}
        target = REVIEW_LABELS[journal["record"]["decision"]]
        # Modify only the four known review labels. Never PUT the entire label set:
        # that could erase a concurrent, unrelated label added by another person.
        for label in sorted(set(REVIEW_LABELS.values()) & names - {target}):
            try:
                self.github.request("DELETE", API_ROOT + "/issues/" + str(number) + "/labels/" + quote(label, safe=""))
            except GithubError as exc:
                if exc.status != 404:
                    raise
        if target not in names:
            self.github.request("POST", API_ROOT + "/issues/" + str(number) + "/labels", {"labels": [target]})
        checked = self.github.request("GET", API_ROOT + "/issues/" + str(number))
        checked_names = {label.get("name") if isinstance(label, dict) else label for label in checked.get("labels", [])}
        if checked_names & set(REVIEW_LABELS.values()) != {target}:
            raise ReviewError("The published decision is safe, but GitHub's review labels have not converged to the expected status.", 409, "LABEL_SYNC_PENDING")
        self._cache_issue(checked)

    def _finish_labels(self, journal):
        try:
            self._assert_latest_publication(journal)
            self._sync_labels(journal)
            journal["issueSynced"] = True
            journal["warning"] = ""
        except ReviewError as exc:
            journal["issueSynced"] = False
            journal["warning"] = "Publication succeeded. Issue label synchronization is pending: " + exc.message
        self._update_history(journal)
        self._persist()
        return self._publication_result(journal)

    def sync_issue(self, number):
        with self.lock:
            self._require_connection()
            records = [item for item in self.state["publications"].values() if item["issueNumber"] == number and item["state"] == "published"]
            if not records:
                raise ReviewError("There is no verified local publication for this issue to synchronize.", 409, "NO_PUBLICATION")
            journal = records[-1]
            return self._finish_labels(journal)

    def _assert_latest_publication(self, journal):
        snapshot = self._snapshot()
        ledger = self._read_json_blob(snapshot, DECISIONS_PATH)
        decisions = ledger.get("decisions", []) if isinstance(ledger, dict) else []
        matching = [item for item in decisions if isinstance(item, dict) and item.get("issueNumber") == journal["issueNumber"]]
        if not matching or matching[-1].get("id") != journal["record"]["id"]:
            raise ReviewError("The latest public review differs from this local record. An older decision will not overwrite its status.", 409, "REVIEW_SUPERSEDED")
        if not self._commit_reachable(journal["commitSha"], snapshot["head"]):
            raise ReviewError("The publication commit is no longer on main. Review the current website before synchronizing.", 409, "PUBLICATION_NOT_REACHABLE")

    def export(self):
        with self.lock:
            # Explicit local backup, including the owner's local private notes.
            # Authentication objects and CSRF token are never part of persisted state.
            return {"exportedAt": self.now(), "repository": REPOSITORY, "localReviewBackup": copy.deepcopy(self.state)}

    def frame_bytes(self, frame):
        if not valid_frame(frame):
            raise ReviewError("Frame numbers must be whole numbers from 1 to 682.", 404, "FRAME_NOT_FOUND")
        name = "%08d.jpg" % frame
        local = self.project_root / "media/frames" / name
        cached = self.data_dir / "frames" / name
        for path in (local, cached):
            try:
                if path.is_file() and path.stat().st_size <= 8 * 1024 * 1024:
                    content = path.read_bytes()
                    if content.startswith(b"\xff\xd8\xff"):
                        return content
            except OSError:
                pass
        # Bundled map thumbnails cover several already identified sites offline.
        for site in self.local_map["sites"]:
            for item in site.get("frames", []):
                if item.get("id") == frame and isinstance(item.get("image"), str) and item["image"].startswith("data:image/jpeg;base64,"):
                    try:
                        content = base64.b64decode(item["image"].split(",", 1)[1], validate=True)
                        if content.startswith(b"\xff\xd8\xff") and len(content) <= 8 * 1024 * 1024:
                            return content
                    except ValueError:
                        pass
        url = SITE_URL + "media/frames/" + name
        try:
            with build_opener(_NoRedirect).open(Request(url, headers={"User-Agent": "Uptight-Local-Review-Desk/1.0"}), timeout=20) as response:
                content = response.read(8 * 1024 * 1024 + 1)
            if len(content) > 8 * 1024 * 1024 or not content.startswith(b"\xff\xd8\xff"):
                raise ValueError()
        except (OSError, ValueError, URLError, TimeoutError):
            raise ReviewError("This still is not cached and could not be downloaded. Reconnect and try loading it again.", 503, "FRAME_UNAVAILABLE") from None
        try:
            cached.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=cached.parent, delete=False) as handle:
                temp_path = Path(handle.name)
                handle.write(content)
            os.replace(temp_path, cached)
        except OSError:
            pass  # An image can still be viewed when its optional cache cannot be saved.
        return content

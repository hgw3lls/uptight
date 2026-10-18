"""Real review workflow with a deterministic in-memory GitHub and fault injection."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from review_core import (API_ROOT, BOUNDS, DECISIONS_PATH, MAP_PATH, REPOSITORY,
                         GitHubClient, GithubError, ReviewDesk, ReviewError,
                         canonical_json, file_json, git_blob_sha, normalise_issue,
                         safe_url, within_bounds)


def raw_issue(number=1, frame=658, place="third", proposal=None):
    return {"number": number, "title": "[Location evidence] Frame " + str(frame) + " — New candidate",
            "html_url": "https://github.com/" + REPOSITORY + "/issues/" + str(number),
            "user": {"login": "contributor"}, "state": "open", "created_at": "2026-10-18T15:00:00Z",
            "updated_at": "2026-10-18T15:01:00Z", "labels": [{"name": "location-evidence"}, {"name": "evidence:received"}, {"name": "keep-me"}],
            "body": "\n\n".join([
                "### Location or area\n\nFormer Clark Avenue Bridge / steelworks area",
                "### Frame number\n\n" + str(frame),
                "### Research question\n\nclark-road-level",
                "### Contribution type\n\nNew candidate",
                "### Evidence statement\n\nThe roof and transverse bridge frames appear to match; the camera position remains uncertain.",
                "### Source date\n\n1935 and 1984",
                "### Attribution and catalogue reference\n\nPublic archival catalogue comparison",
                "### Source links\n\nhttps://archive.example/item/1/\nhttps://archive.example/item/2/",
                "### Proposed address or map point\n\n" + (proposal if proposal is not None else "Former crossing\nUser-proposed point (unverified): latitude 41.470289, longitude -81.675500. This does not establish a landmark footprint or camera position."),
                "### Image and document attachments\n\n_No response_",
                "### Site reference\n\nUPTIGHT-EVIDENCE-V1\nplace: " + place + "\nframe: " + str(frame),
            ])}


def map_fixture():
    return {"sites": [
        {"id": "third", "name": "Former Clark Avenue Bridge / steelworks area", "coord": None,
         "address": "Exact film viewpoint unresolved", "status": "Candidate", "confidenceLabel": "Probable candidate",
         "confidenceNote": "Original comparison still leaves the camera position unresolved.", "pinNote": "Original unpinned working note.",
         "frames": [{"id": 658, "time": "01:41:20.700", "image": "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xffTESTJPEG").decode()}],
         "connection": "Original film research.", "history": "Original historical text must survive.",
         "sources": [["Existing archive", "https://archive.example/item/1/"]], "sourceIds": ["S12", "S29"],
         "previousAttributions": [{"name": "West Third", "coord": [-81.68, 41.48]}]},
        {"id": "madison", "name": "Madison Square", "coord": [-81.63391, 41.50913], "status": "Candidate", "address": "7812 Hough",
         "confidenceLabel": "Approximate", "confidenceNote": "Original evidence for another site.", "pinNote": "Area pin.",
         "frames": [{"id": 63, "time": "00:06:29.430", "image": "original-image"}, {"id": 659, "time": "01:41:30.000", "image": "other-image"}],
         "history": "Original second site", "sources": [["Other archive", "https://archive.example/other"]],
         "coordinateSourceIds": ["S32"], "coordinateUncertaintyMeters": 30,
         "sourceIds": ["S32"]}],
        "roads": {"type": "FeatureCollection", "features": []}, "river": ["original-water"], "neighborhoods": ["original-neighborhoods"]}


class FakeGitHub:
    def __init__(self, map_data=None):
        self.mode, self.login, self.push = "public", "owner", True
        self.calls, self.blobs, self.trees, self.commits = [], {}, {}, {}
        self.issue = raw_issue()
        self.issue_pages = None
        self.comments = []
        self.patch_mode = "success"
        self.fail_head_reads = 0
        self.fail_after_patch = 0
        self.labels_fail = False
        self.offline = False
        self.tamper_tree = False
        self.truncated = False
        self.before = None
        self.counter = 0
        files = {MAP_PATH: file_json(map_data or map_fixture()), "index.html": b"PUBLIC MAP", "config.js": b"UNCHANGED PRIVATE CONFIG PLACEHOLDER",
                 "support.js": b"KEEP", ".github/workflows/pages.yml": b"KEEP WORKFLOW", "data/unknown-future-file.json": b"KEEP FUTURE DATA"}
        for frame in range(1, 683):
            files["media/frames/%08d.jpg" % frame] = b"still-" + str(frame).encode()
        entries = {name: {"mode": "100644", "type": "blob", "sha": self.put_blob(data)} for name, data in files.items()}
        self.head = self.put_commit(self.put_tree(entries), [])
        self.initial_head = self.head
        self.initial_entries = copy.deepcopy(entries)

    def set_auth(self, mode, token=None):
        self.mode = mode

    def disconnect(self):
        self.mode = "public"

    def put_blob(self, data):
        sha = git_blob_sha(data)
        self.blobs[sha] = data
        return sha

    def put_tree(self, entries):
        sha = hashlib.sha1(canonical_json(entries)).hexdigest()
        self.trees[sha] = copy.deepcopy(entries)
        return sha

    def put_commit(self, tree, parents):
        self.counter += 1
        sha = hashlib.sha1(canonical_json([tree, parents, self.counter])).hexdigest()
        self.commits[sha] = {"sha": sha, "tree": {"sha": tree}, "parents": [{"sha": parent} for parent in parents]}
        return sha

    def ancestor(self, ancestor, head):
        while head:
            if ancestor == head:
                return True
            parents = self.commits.get(head, {}).get("parents", [])
            head = parents[0]["sha"] if parents else None
        return False

    def current_entries(self):
        return self.trees[self.commits[self.head]["tree"]["sha"]]

    def read_file(self, path):
        return self.blobs[self.current_entries()[path]["sha"]]

    def external_commit(self, changes):
        entries = copy.deepcopy(self.current_entries())
        for path, data in changes.items():
            entries[path] = {"mode": "100644", "type": "blob", "sha": self.put_blob(data)}
        self.head = self.put_commit(self.put_tree(entries), [self.head])
        return self.head

    def request(self, method, path, payload=None):
        self.calls.append((method, path, copy.deepcopy(payload)))
        if self.before:
            self.before(method, path, payload)
        if self.offline:
            raise GithubError("Fake network offline", ambiguous=method != "GET")
        if method == "GET" and path == API_ROOT:
            return {"full_name": REPOSITORY, "permissions": {"push": self.push}}
        if method == "GET" and path == "/user":
            return {"login": self.login}
        relative = path[len(API_ROOT):] if path.startswith(API_ROOT) else path
        if method == "GET" and relative.startswith("/issues?"):
            page = int(relative.rsplit("page=", 1)[1])
            if self.issue_pages is not None:
                value = self.issue_pages.get(page, [])
                if isinstance(value, Exception):
                    raise value
                return copy.deepcopy(value)
            return [copy.deepcopy(self.issue)] if page == 1 else []
        if method == "GET" and relative.startswith("/issues/1/comments?"):
            return copy.deepcopy(self.comments)
        if method == "GET" and relative == "/issues/1":
            return copy.deepcopy(self.issue)
        if method == "GET" and relative == "/git/ref/heads/main":
            if self.fail_head_reads:
                self.fail_head_reads -= 1
                raise GithubError("Fake interrupted verification")
            return {"object": {"sha": self.head}}
        if method == "GET" and relative.startswith("/git/commits/"):
            return copy.deepcopy(self.commits[relative.rsplit("/", 1)[1]])
        if method == "GET" and relative.startswith("/git/trees/"):
            sha = relative.split("/git/trees/", 1)[1].split("?", 1)[0]
            return {"sha": sha, "truncated": self.truncated, "tree": [{"path": name, **entry} for name, entry in self.trees[sha].items()]}
        if method == "GET" and relative.startswith("/git/blobs/"):
            sha = relative.rsplit("/", 1)[1]
            return {"sha": sha, "encoding": "base64", "content": base64.b64encode(self.blobs[sha]).decode()}
        if method == "GET" and relative.startswith("/compare/"):
            base, head = relative.split("/compare/", 1)[1].split("...")
            if self.ancestor(base, head):
                return {"status": "identical" if base == head else "ahead", "merge_base_commit": {"sha": base}}
            return {"status": "behind" if self.ancestor(head, base) else "diverged", "merge_base_commit": {"sha": head if self.ancestor(head, base) else self.initial_head}}
        if method == "POST" and relative == "/git/blobs":
            return {"sha": self.put_blob(base64.b64decode(payload["content"]))}
        if method == "POST" and relative == "/git/trees":
            entries = copy.deepcopy(self.trees[payload["base_tree"]])
            for item in payload["tree"]:
                entries[item["path"]] = {key: item[key] for key in ("mode", "type", "sha")}
            if self.tamper_tree:
                entries.pop("media/frames/00000001.jpg")
            return {"sha": self.put_tree(entries)}
        if method == "POST" and relative == "/git/commits":
            return {"sha": self.put_commit(payload["tree"], payload["parents"])}
        if method == "PATCH" and relative == "/git/refs/heads/main":
            assert payload["force"] is False
            if self.patch_mode == "fail_422":
                raise GithubError("Fake rejected ref", 422, "GITHUB_HTTP_422", ambiguous=False)
            if self.patch_mode == "ambiguous_no_write":
                raise GithubError("Fake dropped request", ambiguous=True)
            candidate = payload["sha"]
            if not self.ancestor(self.head, candidate):
                raise GithubError("Fake non-fast-forward", 422, "GITHUB_HTTP_422", ambiguous=False)
            self.head = candidate
            if self.fail_after_patch:
                self.fail_head_reads = self.fail_after_patch
                self.fail_after_patch = 0
            if self.patch_mode == "ambiguous_written":
                raise GithubError("Fake dropped successful response", ambiguous=True)
            return {"object": {"sha": self.head}}
        if method == "DELETE" and relative.startswith("/issues/1/labels/"):
            if self.labels_fail:
                raise GithubError("Fake missing Issues write permission", 403, "GITHUB_HTTP_403")
            name = unquote(relative.rsplit("/", 1)[1])
            self.issue["labels"] = [label for label in self.issue["labels"] if label["name"] != name]
            return copy.deepcopy(self.issue["labels"])
        if method == "POST" and relative == "/issues/1/labels":
            if self.labels_fail:
                raise GithubError("Fake missing Issues write permission", 403, "GITHUB_HTTP_403")
            names = {label["name"] for label in self.issue["labels"]} | set(payload["labels"])
            self.issue["labels"] = [{"name": name} for name in sorted(names)]
            return copy.deepcopy(self.issue["labels"])
        raise AssertionError("Unexpected fake API call: " + method + " " + path)


class DeskCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "project"
        self.root.mkdir()
        (self.root / "data").mkdir()
        (self.root / "review-desk/seed").mkdir(parents=True)
        (self.root / MAP_PATH).write_bytes(file_json(map_fixture()))
        (self.root / "data/cleveland-context.json").write_bytes(file_json({"bounds": BOUNDS}))
        (self.root / "data/film-frames.json").write_bytes(file_json({"frames": [[658, 6080.7], [660, 6100.9]]}))
        (self.root / "review-desk/seed/issues.json").write_bytes(file_json({"snapshotAt": "2026-10-18T15:10:00Z", "issues": [raw_issue()]}))
        self.data_dir = Path(self.temp.name) / "private"
        self.github = FakeGitHub()
        self.elapsed = 100.0
        self.desk = ReviewDesk(self.root, self.data_dir, self.github, now=lambda: "2026-10-18T17:00:00Z", monotonic=lambda: self.elapsed)

    def tearDown(self):
        self.temp.cleanup()

    def connect(self):
        return self.desk.connect("token", "session-only-token-test")

    def draft(self, **changes):
        result = {"decision": "approved", "mode": "evidence", "place": "third", "name": "Former Clark Avenue Bridge",
                  "address": "Former Clark crossing", "latitude": None, "longitude": None, "status": "Candidate",
                  "confidenceLabel": "Provisional landmark", "confidenceNote": "The historic bridge alignment is plausible; the camera position is unresolved.",
                  "pinNote": "This pin marks the former crossing area and does not claim an exact camera station.",
                  "publicNote": "The archive comparison supports this candidate; the exact camera station remains unresolved.",
                  "privateNote": "PRIVATE-NOTE-DO-NOT-PUBLISH-9f3c", "baseIssueUpdatedAt": self.github.issue["updated_at"]}
        result.update(changes)
        return result

    def preview(self, **changes):
        self.desk.save_draft(1, self.draft(**changes))
        return self.desk.preview(1)

    def publish(self, **changes):
        self.connect()
        preview = self.preview(**changes)
        return self.desk.publish(1, preview["previewId"])

    def writes(self, suffix=None):
        return [call for call in self.github.calls if call[0] != "GET" and (suffix is None or call[1].endswith(suffix))]


class ParsingTests(unittest.TestCase):
    def test_issue_form_parser_preserves_evidence_and_extracts_point(self):
        issue = normalise_issue(raw_issue())
        self.assertEqual(issue["fields"]["frame"], 658)
        self.assertEqual(issue["fields"]["place"], "third")
        self.assertEqual(issue["fields"]["latitude"], 41.470289)
        self.assertEqual(issue["fields"]["longitude"], -81.6755)
        self.assertEqual(issue["remoteStatus"], "received")
        self.assertIn("position remains uncertain", issue["fields"]["evidence"])
        self.assertEqual(issue["fields"]["attachments"], [])

    def test_bare_coordinate_line_and_scientific_malformed_rejections(self):
        for proposal in ("41.470289, -81.675500", "Former approach\n(41.470289, -81.675500)"):
            with self.subTest(proposal=proposal):
                issue = normalise_issue(raw_issue(proposal=proposal))
                self.assertEqual(issue["fields"]["latitude"], 41.470289)
        for proposal in ("41e0, -81.6", "41.47, -81.6e1", "NaN, -81.6", "41.47, Infinity", "41.4, -81.6\n41.5, -81.7",
                         "latitude 41.4, longitude -81.6e1", "latitude 41.4e1, longitude -81.6"):
            with self.subTest(proposal=proposal):
                self.assertIsNone(normalise_issue(raw_issue(proposal=proposal))["fields"]["latitude"])

    def test_filters_pull_requests_foreign_urls_and_invalid_frames(self):
        issue = raw_issue()
        issue["pull_request"] = {"url": "https://example.org"}
        self.assertIsNone(normalise_issue(issue))
        issue = raw_issue()
        issue["html_url"] = "https://github.com/other/repo/issues/1"
        self.assertIsNone(normalise_issue(issue))
        self.assertIsNone(normalise_issue(raw_issue(frame=683))["fields"]["frame"])

    def test_conflicting_review_labels_remain_uncertain(self):
        raw = raw_issue()
        raw["labels"].append({"name": "evidence:disputed"})
        self.assertEqual(normalise_issue(raw)["remoteStatus"], "conflicting")

    def test_strict_urls_and_geographic_limits(self):
        self.assertTrue(within_bounds(41.43, -81.74))
        self.assertTrue(within_bounds(41.56, -81.57))
        for lat, lon in ((41.57, -81.6), (41.4, -81.6), (True, -81.6), (float("nan"), -81.6), (41.5, float("inf"))):
            self.assertFalse(within_bounds(lat, lon))
        for value in ("javascript:alert(1)", "https://user:password@example.org/", "https://example.org/a b", "https://example.org:bad/"):
            self.assertIsNone(safe_url(value))


class WorkflowTests(DeskCase):
    def test_opening_is_offline_and_defaults_are_not_approvals(self):
        self.assertEqual(self.github.calls, [])
        boot = self.desk.bootstrap()
        self.assertEqual(boot["issues"][0]["number"], 1)
        self.assertEqual(boot["history"], [])
        self.assertFalse(boot["connection"]["connected"])
        self.assertNotIn("image", boot["sites"][0]["frames"][0])
        draft = self.desk.save_draft(1, {})["draft"]
        self.assertEqual(draft["mode"], "evidence")
        self.assertEqual(draft["decision"], "pending")
        self.assertIsNone(draft["latitude"])
        self.assertIsNone(draft["longitude"])

    def test_draft_validation_and_private_backup(self):
        for changes in ({"latitude": True}, {"longitude": float("nan")}, {"place": "unknown"}, {"decision": "accept"}, {"publicNote": []}):
            with self.subTest(changes=changes), self.assertRaises(ReviewError):
                self.desk.save_draft(1, self.draft(**changes))
        self.desk.save_draft(1, {**self.draft(), "token": "IGNORED-SECRET"})
        encoded = json.dumps(self.desk.export())
        self.assertIn("PRIVATE-NOTE-DO-NOT-PUBLISH", encoded)
        self.assertNotIn("IGNORED-SECRET", encoded)
        self.assertNotIn(self.desk.csrf_token, encoded)
        self.connect()
        self.assertNotIn("session-only-token-test", json.dumps(self.desk.export()))

    def test_readonly_preview_has_no_remote_mutation_and_requires_authenticated_repreview(self):
        preview = self.preview()
        self.assertEqual(self.writes(), [])
        self.assertNotIn("privateNote", json.dumps(preview))
        self.assertEqual(self.github.head, self.github.initial_head)
        self.connect()
        with self.assertRaises(ReviewError) as error:
            self.desk.publish(1, preview["previewId"])
        self.assertEqual(error.exception.code, "PREVIEW_EXPIRED")
        self.assertEqual(self.writes(), [])

    def test_evidence_approval_preserves_positions_confidence_all_photos_and_unrelated_tree(self):
        before = json.loads(self.github.read_file(MAP_PATH))
        result = self.publish()
        after = json.loads(self.github.read_file(MAP_PATH))
        self.assertTrue(result["published"])
        self.assertTrue(result["issueSynced"])
        self.assertEqual(after["sites"][1], before["sites"][1])
        for key in ("coord", "status", "confidenceLabel", "confidenceNote", "pinNote", "frames", "history", "connection", "sourceIds", "previousAttributions"):
            self.assertEqual(after["sites"][0][key], before["sites"][0][key])
        self.assertEqual(after["roads"], before["roads"])
        self.assertEqual(after["river"], before["river"])
        note = after["sites"][0]["reviewedContributions"][0]
        self.assertEqual(note["reviewDate"], "2026-10-18")
        self.assertEqual(note["mode"], "evidence")
        for path, entry in self.github.initial_entries.items():
            if path != MAP_PATH:
                self.assertEqual(self.github.current_entries()[path], entry, path)
        self.assertEqual(sum(path.startswith("media/frames/") for path in self.github.current_entries()), 682)
        self.assertEqual(sum(source[1] == "https://archive.example/item/1/" for source in after["sites"][0]["sources"]), 1)
        for content in self.github.blobs.values():
            self.assertNotIn(b"PRIVATE-NOTE-DO-NOT-PUBLISH", content)
        labels = {label["name"] for label in self.github.issue["labels"]}
        self.assertEqual(labels, {"location-evidence", "evidence:incorporated", "keep-me"})
        patch_index = next(i for i, call in enumerate(self.github.calls) if call[0] == "PATCH")
        label_index = next(i for i, call in enumerate(self.github.calls) if call[0] != "GET" and "/labels" in call[1])
        self.assertGreater(label_index, patch_index)
        self.assertFalse(any(call[0] != "GET" and "/comments" in call[1] for call in self.github.calls))
        self.assertEqual(self.github.issue["state"], "open")

    def test_approved_location_remains_candidate_and_saves_prior_position(self):
        result = self.publish(mode="location", latitude=41.470289, longitude=-81.6755)
        site = json.loads(self.github.read_file(MAP_PATH))["sites"][0]
        self.assertEqual(site["coord"], [-81.6755, 41.470289])
        self.assertEqual(site["status"], "Candidate")
        self.assertIsNone(site["previousMapPositions"][-1]["coord"])
        self.assertEqual(site["coordinateReview"]["issueNumber"], 1)
        self.assertEqual(result["record"]["reviewer"], "owner")

    def test_location_validations_never_publish_submitted_point_by_default(self):
        self.connect()
        for changes in ({"mode": "location"}, {"mode": "location", "latitude": 42, "longitude": -81.6},
                        {"mode": "location", "latitude": 41.47, "longitude": -81.67, "pinNote": "short"},
                        {"mode": "location", "latitude": 41.47, "longitude": -81.67, "status": "Unplaced"}):
            with self.subTest(changes=changes), self.assertRaises(ReviewError):
                self.preview(**changes)
        self.assertEqual(self.writes(), [])

    def test_location_adds_missing_frame_without_removing_other_site_assignments(self):
        self.github.issue = raw_issue(frame=659)
        self.desk._cache_issue(self.github.issue)
        result = self.publish(mode="location", latitude=41.47, longitude=-81.67)
        sites = json.loads(self.github.read_file(MAP_PATH))["sites"]
        self.assertEqual([frame["id"] for frame in sites[0]["frames"]], [658, 659])
        self.assertEqual(sites[0]["frames"][1]["image"], "other-image")
        self.assertEqual([frame["id"] for frame in sites[1]["frames"]], [63, 659])
        self.assertTrue(any(change["field"] == "sites.third.frames" for change in result["record"]["changes"]))

    def test_location_move_retires_old_coordinate_specific_provenance(self):
        result = self.publish(mode="location", place="madison", latitude=41.51, longitude=-81.63)
        site = json.loads(self.github.read_file(MAP_PATH))["sites"][1]
        self.assertNotIn("coordinateSourceIds", site)
        self.assertNotIn("coordinateUncertaintyMeters", site)
        self.assertEqual(site["sourceIds"], ["S32"])
        self.assertEqual(site["previousMapPositions"][-1]["coordinateSourceIds"], ["S32"])
        self.assertEqual(site["previousMapPositions"][-1]["coordinateUncertaintyMeters"], 30)
        fields = {change["field"] for change in result["record"]["changes"]}
        self.assertIn("sites.madison.coordinateUncertaintyMeters", fields)
        self.assertIn("sites.madison.coordinateSourceIds", fields)

    def test_new_location_has_stable_issue_id_and_valid_frame(self):
        self.publish(mode="location", place="new", latitude=41.47, longitude=-81.67)
        sites = json.loads(self.github.read_file(MAP_PATH))["sites"]
        self.assertEqual(len(sites), 3)
        self.assertEqual(sites[-1]["id"], "issue-1")
        self.assertEqual(sites[-1]["frames"][0], map_fixture()["sites"][0]["frames"][0])

    def test_evidence_new_does_not_claim_nonexistent_site(self):
        before = self.github.current_entries()[MAP_PATH]["sha"]
        result = self.publish(mode="evidence", place="new")
        self.assertIsNone(result["record"]["siteId"])
        self.assertEqual(self.github.current_entries()[MAP_PATH]["sha"], before)

    def test_nonapproval_changes_ledger_and_label_only(self):
        before = self.github.read_file(MAP_PATH)
        result = self.publish(decision="disputed", mode="location", latitude=41.47, longitude=-81.67)
        self.assertEqual(self.github.read_file(MAP_PATH), before)
        self.assertEqual(result["record"]["decision"], "disputed")
        self.assertIn({"name": "evidence:disputed"}, self.github.issue["labels"])

    def test_not_connected_and_no_push_access_cannot_publish(self):
        preview = self.preview()
        with self.assertRaises(ReviewError) as error:
            self.desk.publish(1, preview["previewId"])
        self.assertEqual(error.exception.code, "NOT_CONNECTED")
        self.github.push = False
        with self.assertRaises(ReviewError):
            self.connect()
        self.assertFalse(self.desk.bootstrap()["connection"]["connected"])
        self.assertEqual(self.github.mode, "public")
        self.assertEqual(self.writes(), [])

    def test_switching_accounts_invalidates_preview(self):
        self.connect()
        preview = self.preview()
        self.github.login = "another-owner"
        self.connect()
        with self.assertRaises(ReviewError) as error:
            self.desk.publish(1, preview["previewId"])
        self.assertEqual(error.exception.code, "PREVIEW_EXPIRED")
        self.assertEqual(self.writes(), [])

    def test_stale_draft_issue_head_and_expiry_block_before_mutation(self):
        for cause in ("draft", "issue", "head", "expired"):
            with self.subTest(cause=cause):
                # A separate fixture per case keeps the before-mutation claim exact.
                self.connect()
                self.desk._cache_issue(self.github.issue)
                preview = self.preview()
                if cause == "draft":
                    self.desk.save_draft(1, self.draft(publicNote="A materially revised public assessment after preview."))
                elif cause == "issue":
                    self.github.issue["updated_at"] = "2026-10-18T16:00:00Z"
                elif cause == "head":
                    self.github.external_commit({"unrelated.txt": b"Newer owner work"})
                else:
                    self.elapsed += 901
                with self.assertRaises(ReviewError) as error:
                    self.desk.publish(1, preview["previewId"])
                self.assertEqual(error.exception.code, {"draft": "DRAFT_CHANGED", "issue": "ISSUE_CHANGED", "head": "HEAD_CHANGED", "expired": "PREVIEW_EXPIRED"}[cause])
                self.assertEqual(self.writes(), [])

    def test_incomplete_tree_and_tampered_tree_never_touch_main(self):
        self.connect()
        self.github.truncated = True
        with self.assertRaises(ReviewError) as error:
            self.preview()
        self.assertEqual(error.exception.code, "TREE_INCOMPLETE")
        self.github.truncated = False
        preview = self.preview()
        self.github.tamper_tree = True
        with self.assertRaises(ReviewError) as error:
            self.desk.publish(1, preview["previewId"])
        self.assertEqual(error.exception.code, "TREE_PRESERVATION_FAILED")
        self.assertEqual(self.writes("/git/refs/heads/main"), [])
        self.assertEqual(self.github.head, self.github.initial_head)

    def test_failed_ref_update_is_not_reported_as_approval(self):
        self.connect()
        preview = self.preview()
        self.github.patch_mode = "fail_422"
        with self.assertRaises(ReviewError):
            self.desk.publish(1, preview["previewId"])
        self.assertEqual(self.desk.bootstrap()["history"], [])
        self.assertEqual(self.github.head, self.github.initial_head)
        self.assertFalse(any("/labels" in call[1] and call[0] != "GET" for call in self.github.calls))
        self.assertNotEqual(self.desk.preview(1)["previewId"], preview["previewId"])

    def test_concurrent_commit_after_final_read_is_not_overwritten(self):
        self.connect()
        preview = self.preview()
        changed = []
        def concurrent(method, path, payload):
            if method == "PATCH" and not changed:
                changed.append(self.github.external_commit({"new-owner-work.txt": b"Protected concurrent edit"}))
        self.github.before = concurrent
        with self.assertRaises(ReviewError) as error:
            self.desk.publish(1, preview["previewId"])
        self.assertEqual(error.exception.code, "HEAD_CHANGED")
        self.assertEqual(self.github.head, changed[0])
        self.assertEqual(self.github.read_file("new-owner-work.txt"), b"Protected concurrent edit")

    def test_ambiguous_success_is_reconciled_and_repeated_publish_is_idempotent(self):
        self.connect()
        preview = self.preview()
        self.github.patch_mode = "ambiguous_written"
        first = self.desk.publish(1, preview["previewId"])
        second = self.desk.publish(1, preview["previewId"])
        self.assertTrue(first["published"])
        self.assertEqual(first["commitSha"], second["commitSha"])
        self.assertEqual(len(self.writes("/git/commits")), 1)
        self.assertEqual(len(json.loads(self.github.read_file(DECISIONS_PATH))["decisions"]), 1)

    def test_unconfirmed_no_write_recovers_same_commit_after_restart(self):
        self.connect()
        preview = self.preview()
        self.github.patch_mode = "ambiguous_no_write"
        with self.assertRaises(ReviewError) as error:
            self.desk.publish(1, preview["previewId"])
        self.assertEqual(error.exception.code, "PUBLICATION_AMBIGUOUS")
        self.assertEqual(self.desk.bootstrap()["history"], [])
        self.desk = ReviewDesk(self.root, self.data_dir, self.github, now=lambda: "2026-10-18T17:00:00Z")
        self.connect()
        recovered = self.desk.preview(1)
        self.assertEqual(recovered["previewId"], preview["previewId"])
        self.github.patch_mode = "success"
        result = self.desk.publish(1, recovered["previewId"])
        self.assertTrue(result["published"])
        self.assertEqual(len(self.writes("/git/commits")), 1)

    def test_stale_ambiguous_draft_and_issue_can_get_fresh_preview(self):
        self.connect()
        preview = self.preview()
        self.github.patch_mode = "ambiguous_no_write"
        with self.assertRaises(ReviewError):
            self.desk.publish(1, preview["previewId"])
        self.desk.save_draft(1, self.draft(publicNote="Updated assessment that deliberately replaces the interrupted review."))
        new_preview = self.desk.preview(1)
        self.assertNotEqual(preview["previewId"], new_preview["previewId"])
        with self.assertRaises(ReviewError):
            self.desk.publish(1, new_preview["previewId"])
        self.github.issue["updated_at"] = "2026-10-18T17:05:00Z"
        with self.assertRaises(ReviewError) as error:
            self.desk.preview(1)
        self.assertEqual(error.exception.code, "ISSUE_CHANGED")
        self.desk.save_draft(1, self.draft(publicNote="Updated assessment following the contributor's corrected evidence."))
        fresh = self.desk.preview(1)
        self.assertNotEqual(new_preview["previewId"], fresh["previewId"])

    def test_every_ref_retry_requires_durable_journal_even_after_disk_failure(self):
        self.connect()
        preview = self.preview()
        original_persist = self.desk._persist
        fail = [True]
        def failing_persist():
            if self.desk.state["publications"] and fail[0]:
                raise ReviewError("Fake disk full", 500, "STATE_WRITE_FAILED")
            return original_persist()
        self.desk._persist = failing_persist
        for _ in range(2):
            with self.assertRaises(ReviewError):
                self.desk.publish(1, preview["previewId"])
            self.assertEqual(self.writes("/git/refs/heads/main"), [])
            self.assertEqual(self.github.head, self.github.initial_head)
        fail[0] = False
        result = self.desk.publish(1, preview["previewId"])
        self.assertTrue(result["published"])
        self.assertEqual(len(self.writes("/git/commits")), 1)

    def test_label_failure_does_not_hide_success_and_retry_creates_no_commit(self):
        self.github.labels_fail = True
        result = self.publish()
        self.assertTrue(result["published"])
        self.assertFalse(result["issueSynced"])
        self.assertIn("Publication succeeded", result["warning"])
        before = len(self.writes("/git/commits"))
        self.github.labels_fail = False
        synced = self.desk.sync_issue(1)
        self.assertTrue(synced["issueSynced"])
        self.assertEqual(len(self.writes("/git/commits")), before)
        self.assertEqual(len(self.desk.bootstrap()["history"]), 1)

    def test_recovery_never_overwrites_newer_review_label_or_map_cache(self):
        self.connect()
        preview = self.preview()
        self.github.fail_after_patch = 1
        with self.assertRaises(ReviewError) as error:
            self.desk.publish(1, preview["previewId"])
        self.assertEqual(error.exception.code, "PUBLICATION_AMBIGUOUS")
        ledger = json.loads(self.github.read_file(DECISIONS_PATH))
        newer = {**ledger["decisions"][-1], "id": "newer-owner-review", "decision": "disputed"}
        ledger["decisions"].append(newer)
        updated_map = json.loads(self.github.read_file(MAP_PATH))
        updated_map["sites"][0]["name"] = "A newer owner's carefully revised location"
        self.github.external_commit({DECISIONS_PATH: file_json(ledger), MAP_PATH: file_json(updated_map)})
        self.github.issue["labels"] = [{"name": "evidence:disputed"}, {"name": "keep-me"}]
        result = self.desk.publish(1, preview["previewId"])
        self.assertTrue(result["published"])
        self.assertFalse(result["issueSynced"])
        self.assertIn("older decision", result["warning"])
        self.assertEqual(self.github.issue["labels"], [{"name": "evidence:disputed"}, {"name": "keep-me"}])
        self.assertEqual(self.desk.bootstrap()["sites"][0]["name"], updated_map["sites"][0]["name"])
        self.assertFalse(any(call[0] != "GET" and "/labels" in call[1] for call in self.github.calls))

    def test_partial_refresh_keeps_cached_evidence_and_saved_draft(self):
        self.desk.save_draft(1, self.draft())
        self.github.issue_pages = {1: [raw_issue(number) for number in range(2, 102)], 2: GithubError("Fake page-two interruption")}
        result = self.desk.refresh()
        self.assertEqual(len(result["issues"]), 101)
        self.assertTrue(result["truncated"])
        self.assertIn("page-two", result["refreshError"])
        self.assertEqual(result["drafts"]["1"]["privateNote"], self.draft()["privateNote"])
        checked = result["lastRefresh"]
        self.github.offline = True
        result = self.desk.refresh()
        self.assertEqual(result["lastRefresh"], checked)
        self.assertEqual(len(result["issues"]), 101)

    def test_offline_frame_uses_fixed_bundled_still_and_rejects_out_of_range(self):
        self.assertEqual(self.desk.frame_bytes(658), b"\xff\xd8\xffTESTJPEG")
        for frame in (0, 683, True, "658"):
            with self.assertRaises(ReviewError):
                self.desk.frame_bytes(frame)
        self.assertEqual(self.github.calls, [])


class AuthTransportTests(unittest.TestCase):
    def test_cli_uses_stdin_for_payload_and_has_no_token_argument(self):
        client = GitHubClient()
        client.mode = "gh"
        result = type("Completed", (), {"returncode": 0, "stdout": b'{"ok":true}', "stderr": b""})()
        with patch("review_core.subprocess.run", return_value=result) as run:
            client.request("POST", API_ROOT + "/git/commits", {"message": "a literal `command` and $VALUE"})
        args, kwargs = run.call_args
        self.assertIn("--input", args[0])
        self.assertEqual(args[0][-1], "-")
        self.assertNotIn("a literal", " ".join(args[0]))
        self.assertEqual(json.loads(kwargs["input"])["message"], "a literal `command` and $VALUE")
        self.assertNotIn("shell", kwargs)

    def test_token_is_session_only_and_fixed_repository_is_enforced(self):
        client = GitHubClient()
        client.set_auth("token", "github-token-session-only")
        self.assertEqual(client._token, "github-token-session-only")
        with self.assertRaises(ReviewError):
            client.request("GET", "/repos/other/project/issues")
        client.disconnect()
        self.assertIsNone(client._token)
        with self.assertRaises(ReviewError):
            client.request("PATCH", API_ROOT + "/git/refs/heads/main", {})


if __name__ == "__main__":
    unittest.main()

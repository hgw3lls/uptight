"""Release-boundary checks for the public site and local review-desk bundle."""

import importlib.util
import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pages = load_script("build_pages")
package = load_script("package_review_desk")


class ReleaseBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()

    def write(self, name, value=None):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value if value is not None else (name + "\n").encode())
        return path

    def populate_public(self):
        for name in pages.REQUIRED_PUBLIC_FILES:
            self.write(name)

    def populate_package(self):
        for name in package.REQUIRED_PACKAGE_FILES:
            self.write(name)
        self.write("review-desk/tests/test_review_desk.py", b"# review tests\n")

    def test_preserves_entire_established_runtime_and_all_682_frames(self):
        self.populate_public()
        self.write("data/review-decisions.json", b'{"decisions": []}\n')
        out = self.root / "_site"
        result = pages.stage_site(self.root, out)
        actual = {str(p.relative_to(out)) for p in out.rglob("*") if p.is_file()}
        expected = set(pages.REQUIRED_PUBLIC_FILES) | {"data/review-decisions.json"}
        self.assertEqual(actual, expected)
        self.assertEqual(len(pages.REQUIRED_PUBLIC_FILES), 723)
        self.assertEqual(result["files"], 724)
        self.assertEqual(len(list((out / "media/frames").glob("*.jpg"))), 682)
        for frame in range(1, 683):
            name = "media/frames/%08d.jpg" % frame
            self.assertEqual((out / name).read_bytes(), (self.root / name).read_bytes())
        for name in ("fonts/font-0.woff2", "lib/image-slot.js", "data/locations.csv", "config.js", ".nojekyll"):
            self.assertEqual((out / name).read_bytes(), (self.root / name).read_bytes())

    def test_public_staging_excludes_unknown_files_even_in_public_directories(self):
        self.populate_public()
        excluded = (
            "review-desk/app.py", "review-desk/web/index.html", "scripts/secret.py",
            "tests/test_local.py", ".git/config", ".env", "README.md", "admin.html",
            "token.json", "data/private-notes.json", "data/review-desk/state.json",
            "assets/local-token.json", "media/frames/private-draft.jpg", "fonts/.env",
        )
        for name in excluded:
            self.write(name, b"PRIVATE-DO-NOT-PUBLISH")
        out = self.root / "_site"
        pages.stage_site(self.root, out)
        for name in excluded:
            self.assertFalse((out / name).exists(), name)
        self.assertFalse(any(b"PRIVATE-DO-NOT-PUBLISH" in p.read_bytes() for p in out.rglob("*") if p.is_file()))

    def test_missing_required_file_fails_before_replacing_previous_artifact(self):
        self.populate_public()
        (self.root / "media/frames/00000658.jpg").unlink()
        sentinel = self.write("_site/previous.html", b"previous verified deployment")
        with self.assertRaisesRegex(pages.BuildError, "00000658.jpg"):
            pages.stage_site(self.root, self.root / "_site")
        self.assertEqual(sentinel.read_bytes(), b"previous verified deployment")

    def test_rebuild_removes_stale_private_files_from_old_output(self):
        self.populate_public()
        self.write("_site/review-desk/state.json", b"old secret")
        pages.stage_site(self.root, self.root / "_site")
        self.assertFalse((self.root / "_site/review-desk").exists())
        self.assertTrue((self.root / "_site/index.html").exists())

    def test_rejects_public_file_and_parent_directory_symlinks(self):
        self.populate_public()
        outside = Path(self.temp.name) / "outside"
        outside.write_bytes(b"private")
        selected = self.root / "data/map-data.json"
        selected.unlink()
        try:
            selected.symlink_to(outside)
        except (NotImplementedError, OSError):
            self.skipTest("Filesystem does not support test symlinks")
        with self.assertRaisesRegex(pages.BuildError, "[Ss]ymlink"):
            pages.stage_site(self.root, self.root / "_site")
        self.assertFalse((self.root / "_site").exists())
        selected.unlink()
        selected.write_bytes(b"restored public data")
        fonts = self.root / "fonts"
        moved_fonts = Path(self.temp.name) / "fonts-outside"
        fonts.rename(moved_fonts)
        fonts.symlink_to(moved_fonts, target_is_directory=True)
        with self.assertRaisesRegex(pages.BuildError, "[Ss]ymlink"):
            pages.stage_site(self.root, self.root / "_site")

    def test_rejects_output_that_could_replace_source_or_follow_symlink(self):
        self.populate_public()
        for output in (self.root, self.root.parent, self.root / "data", self.root / "review-desk"):
            with self.subTest(output=output):
                with self.assertRaises(pages.BuildError):
                    pages.stage_site(self.root, output)
        outside = Path(self.temp.name) / "existing-output"
        outside.mkdir()
        (outside / "keep").write_text("keep")
        try:
            (self.root / "_site").symlink_to(outside, target_is_directory=True)
        except (NotImplementedError, OSError):
            self.skipTest("Filesystem does not support test symlinks")
        with self.assertRaisesRegex(pages.BuildError, "[Ss]ymlink"):
            pages.stage_site(self.root, self.root / "_site")
        self.assertEqual((outside / "keep").read_text(), "keep")

    def test_offline_bundle_contains_runtime_and_launchers_but_no_local_state(self):
        self.populate_package()
        excluded = (
            "review-desk/state.json", "review-desk/token.json", "review-desk/.env",
            "review-desk/web/token.json", "review-desk/seed/private-drafts.json",
            "review-desk/tests/credentials.json", "review-desk/__pycache__/app.pyc",
            ".git/config", "data/private-notes.json", "config.js", "support.js",
        )
        for name in excluded:
            self.write(name, b"PRIVATE-DO-NOT-PACKAGE")
        output = Path(self.temp.name) / "Review-Desk.zip"
        summary = package.build_package(self.root, output)
        with zipfile.ZipFile(output) as archive:
            prefix = "Uptight-Review-Desk/"
            names = set(archive.namelist())
            for name in package.REQUIRED_PACKAGE_FILES:
                self.assertIn(prefix + name, names)
                self.assertEqual(archive.read(prefix + name), (self.root / name).read_bytes())
            self.assertIn(prefix + "review-desk/tests/test_review_desk.py", names)
            self.assertIn(prefix + "Start-Review-Desk.command", names)
            self.assertIn(prefix + "start-review-desk.bat", names)
            self.assertTrue((archive.getinfo(prefix + "Start-Review-Desk.command").external_attr >> 16) & 0o111)
            for name in excluded:
                self.assertNotIn(prefix + name, names)
            self.assertFalse(any(b"PRIVATE-DO-NOT-PACKAGE" in archive.read(name) for name in names))
            self.assertEqual(summary["files"], len(names))

    def test_bundle_missing_runtime_or_symlink_does_not_overwrite_existing_zip(self):
        self.populate_package()
        output = Path(self.temp.name) / "Review-Desk.zip"
        output.write_bytes(b"previous bundle")
        source = self.root / "lib/d3.min.js"
        source.unlink()
        with self.assertRaisesRegex(package.PackageError, "d3.min.js"):
            package.build_package(self.root, output)
        self.assertEqual(output.read_bytes(), b"previous bundle")
        outside = Path(self.temp.name) / "private.js"
        outside.write_bytes(b"private")
        try:
            source.symlink_to(outside)
        except (NotImplementedError, OSError):
            self.skipTest("Filesystem does not support test symlinks")
        with self.assertRaisesRegex(package.PackageError, "[Ss]ymlink"):
            package.build_package(self.root, output)
        self.assertEqual(output.read_bytes(), b"previous bundle")

    @unittest.skipUnless(shutil.which("bash"), "Mac launcher check requires Bash")
    def test_mac_launcher_explains_old_python_and_runs_a_supported_interpreter(self):
        launcher = self.write("Folder with spaces/Start-Review-Desk.command", (ROOT / "review-desk/Start-Review-Desk.command").read_bytes())
        self.write("Folder with spaces/review-desk/app.py", b"# app location\n")
        fake_bin = self.root / "fake-bin"
        fake_bin.mkdir()
        invoked = self.root / "invoked.txt"
        environment = dict(os.environ)
        environment["PATH"] = str(fake_bin) + os.pathsep + environment.get("PATH", "")
        environment["REVIEW_DESK_TEST_CALLED"] = str(invoked)
        for version_exit in (1, 0):
            with self.subTest(version_exit=version_exit):
                fake_python = fake_bin / "python3"
                fake_python.write_text("#!/bin/bash\nif [ \"$1\" = \"-c\" ]; then exit %d; fi\nprintf '%%s\\n' \"$PWD\" \"$@\" > \"$REVIEW_DESK_TEST_CALLED\"\n" % version_exit)
                fake_python.chmod(0o755)
                result = subprocess.run([shutil.which("bash"), str(launcher), "--no-browser"],
                                        input="\n", capture_output=True, text=True, env=environment, timeout=5)
                if version_exit:
                    self.assertEqual(result.returncode, 1)
                    self.assertIn("Python 3.10 or newer", result.stdout)
                    self.assertFalse(invoked.exists())
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(invoked.read_text().splitlines(), [str(launcher.parent / "review-desk"), "app.py", "--no-browser"])
if __name__ == "__main__":
    unittest.main()

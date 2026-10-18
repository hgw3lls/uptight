#!/usr/bin/env python3
"""Create a small local review-app ZIP without credentials or saved decisions.

Run from a complete checkout. The package contains public issue seed data,
shared modern map geometry, D3, and the project's official frame 658 still.
Saved drafts, local caches, tokens and unrelated repository files are omitted.
"""

import argparse
import hashlib
import json
import os
import stat
import tempfile
import zipfile
from pathlib import Path


BUNDLE_DIRECTORY = "Uptight-Review-Desk"
REQUIRED_PACKAGE_FILES = (
    "review-desk/app.py",
    "review-desk/review_core.py",
    "review-desk/web/index.html",
    "review-desk/web/app.css",
    "review-desk/web/app.js",
    "review-desk/seed/issues.json",
    "review-desk/README.md",
    "review-desk/CONTRACT.md",
    "review-desk/THIRD-PARTY-NOTICES.md",
    "review-desk/Start-Review-Desk.command",
    "review-desk/start-review-desk.bat",
    "data/map-data.json",
    "data/cleveland-context.json",
    "data/film-frames.json",
    "lib/d3.min.js",
    "media/frames/00000658.jpg",
)
OPTIONAL_PACKAGE_FILES = (
    "review-desk/tests/test_review_core.py",
    "review-desk/tests/test_review_http.py",
    "review-desk/tests/test_review_desk.py",
    "review-desk/tests/review-ui.test.cjs",
)


class PackageError(ValueError):
    pass


def _source_file(root, relative, required=True):
    current = root
    for component in Path(relative).parts:
        current = current / component
        if current.is_symlink():
            raise PackageError("Symlink in package path: " + relative)
    if not current.exists():
        if required:
            raise PackageError("Missing required package file: " + relative)
        return None
    if not stat.S_ISREG(current.stat().st_mode):
        raise PackageError("Package path must be a regular file: " + relative)
    return current


def package_files(source):
    root = Path(source).expanduser()
    if root.is_symlink():
        raise PackageError("Symlink source directories are not allowed")
    root = root.resolve()
    if not root.is_dir():
        raise PackageError("Source must be an existing repository directory")
    files = [(name, _source_file(root, name)) for name in REQUIRED_PACKAGE_FILES]
    for name in OPTIONAL_PACKAGE_FILES:
        source_file = _source_file(root, name, required=False)
        if source_file is not None:
            files.append((name, source_file))
    return root, files


def _zip_entry(relative):
    entry = zipfile.ZipInfo(BUNDLE_DIRECTORY + "/" + relative, date_time=(2026, 1, 1, 0, 0, 0))
    entry.compress_type = zipfile.ZIP_DEFLATED
    entry.create_system = 3
    mode = 0o755 if relative.endswith(".command") else 0o644
    entry.external_attr = (stat.S_IFREG | mode) << 16
    return entry


def build_package(source, output):
    root, files = package_files(source)
    target = Path(output).expanduser()
    if target.is_symlink():
        raise PackageError("Symlink package output is not allowed")
    target = target.resolve()
    if target.suffix.lower() != ".zip":
        raise PackageError("Package output must have a .zip extension")
    if target.exists() and not target.is_file():
        raise PackageError("Package output must be a regular file")
    if any(target == path for _, path in files):
        raise PackageError("Package output cannot replace source files")
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".uptight-review-", suffix=".zip", dir=str(target.parent))
    os.close(fd)
    temporary = Path(temp_name)
    manifest = []
    try:
        with zipfile.ZipFile(str(temporary), "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for relative, source_file in files:
                source_file = _source_file(root, relative)
                contents = source_file.read_bytes()
                archive.writestr(_zip_entry(relative), contents)
                manifest.append({"path": relative, "bytes": len(contents), "sha256": hashlib.sha256(contents).hexdigest()})
            # Same launchers work here and in a normal checkout's review-desk/.
            for relative in ("Start-Review-Desk.command", "start-review-desk.bat"):
                contents = _source_file(root, "review-desk/" + relative).read_bytes()
                archive.writestr(_zip_entry(relative), contents)
                manifest.append({"path": relative, "bytes": len(contents), "sha256": hashlib.sha256(contents).hexdigest()})
            info = {"format": 1, "repository": "hgw3lls/uptight", "files": manifest}
            archive.writestr(_zip_entry("BUNDLE-INFO.json"), json.dumps(info, indent=2, sort_keys=True) + "\n")
        os.replace(str(temporary), str(target))
    finally:
        if temporary.exists():
            temporary.unlink()
    return {"files": len(manifest) + 1, "bytes": target.stat().st_size, "output": str(target)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, help="Defaults to <source>/dist/Uptight-Review-Desk.zip")
    args = parser.parse_args(argv)
    try:
        result = build_package(args.source, args.output or args.source / "dist" / "Uptight-Review-Desk.zip")
    except (PackageError, OSError) as error:
        parser.exit(1, "Review-desk packaging failed: %s\n" % error)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build a fail-closed GitHub Pages artifact from approved public runtime files.

The repository also contains a local owner review app. Never upload the whole
repository to Pages: extend this allowlist deliberately when adding public files.
This script uses only the Python standard library.
"""

import argparse
import json
import os
import shutil
import stat
import tempfile
from pathlib import Path


# Established runtime at ed598f839125ccefccc80e43faa8c923efa8e60d.
# These are exact files, not recursive directory copies. Unknown JSON, scripts,
# draft images, authentication files and future owner pages are excluded.
REQUIRED_PUBLIC_FILES = (
    ".nojekyll",
    "index.html",
    "uptight-map.html",
    "contribute.html",
    "evidence.html",
    "location-review.html",
    "research-board.html",
    "config.js",
    "support.js",
    "assets/contributions.js",
    "assets/map-navigation.css",
    "assets/map-navigation.js",
    "assets/research.css",
    "assets/research.js",
    "data/cleveland-context.json",
    "data/evidence-cases.json",
    "data/film-frames.json",
    "data/location-review.json",
    "data/locations.csv",
    "data/map-data.json",
    "data/research-log.json",
    "data/research-questions.json",
    "fonts/font-0.woff2",
    "fonts/font-1.woff2",
    "fonts/font-2.woff2",
    "fonts/font-3.woff2",
    "fonts/font-4.woff2",
    "fonts/font-5.woff2",
    "fonts/font-7.woff2",
    "lib/d3.min.js",
    "lib/image-slot.js",
    "media/evidence/carter-big-four-pair-2002.jpg",
    "media/evidence/carter-southeast-approach-haer-1986.jpg",
    "media/evidence/clark-bridge-cea0144-1984.jpg",
    "media/evidence/clark-proposed-coordinate-county-2019.jpg",
    "media/evidence/clark-republic-steel-1935.jpg",
    "media/evidence/clark-road-truss-cea0146-1984.jpg",
    "media/evidence/eagle-figure-xiii.png",
    "media/evidence/hough-e79-1964.jpg",
    "media/evidence/hough-e79-aerial-1972.jpg",
    "media/evidence/madison-hopkins-1921-plate6b-detail.jpg",
) + tuple("media/frames/%08d.jpg" % frame for frame in range(1, 683))

# Created only by an explicitly published owner decision. Private drafts stay
# in the local app's state directory and have no public allowlist entry.
OPTIONAL_PUBLIC_FILES = ("data/review-decisions.json",)


class BuildError(ValueError):
    pass


def _source_root(source):
    root = Path(source).expanduser()
    if root.is_symlink():
        raise BuildError("Symlink source directories are not allowed")
    root = root.resolve()
    if not root.is_dir():
        raise BuildError("Source must be an existing repository directory")
    return root


def _public_file(root, relative, required=True):
    current = root
    for component in Path(relative).parts:
        current = current / component
        if current.is_symlink():
            raise BuildError("Symlink in public path: " + relative)
    if not current.exists():
        if required:
            raise BuildError("Missing required public file: " + relative)
        return None
    if not stat.S_ISREG(current.stat().st_mode):
        raise BuildError("Public path must be a regular file: " + relative)
    return current


def public_files(source):
    """Validate every source before any existing staged artifact is changed."""
    root = _source_root(source)
    files = [(name, _public_file(root, name)) for name in REQUIRED_PUBLIC_FILES]
    for name in OPTIONAL_PUBLIC_FILES:
        source_file = _public_file(root, name, required=False)
        if source_file is not None:
            files.append((name, source_file))
    return root, files


def _output_directory(root, output):
    target = Path(output).expanduser()
    if target.is_symlink():
        raise BuildError("Symlink output directories are not allowed")
    target = target.resolve()
    if target == root or target in root.parents:
        raise BuildError("Output cannot replace the repository or its parent")
    # Inside a checkout only the designated staging directory may be replaced.
    # An explicit external output (for example in a CI temporary dir) is allowed.
    if root in target.parents and target != root / "_site":
        raise BuildError("Output inside the repository must be _site")
    if target.exists() and not target.is_dir():
        raise BuildError("Output must be a directory")
    return target


def stage_site(source, output):
    root, files = public_files(source)
    target = _output_directory(root, output)
    target.parent.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix=".uptight-pages-", dir=str(target.parent)))
    backup = None
    try:
        for relative, source_file in files:
            destination = staged / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            source_file = _public_file(root, relative)
            shutil.copyfile(str(source_file), str(destination), follow_symlinks=False)
        if target.exists():
            backup = Path(tempfile.mkdtemp(prefix=".uptight-pages-old-", dir=str(target.parent)))
            os.replace(str(target), str(backup))
        os.replace(str(staged), str(target))
    except Exception:
        if backup is not None and backup.exists() and not target.exists():
            os.replace(str(backup), str(target))
            backup = None
        raise
    finally:
        if staged.exists():
            shutil.rmtree(staged)
        if backup is not None and backup.exists():
            shutil.rmtree(backup)
    return {"files": len(files), "frames": 682, "output": str(target)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, help="Defaults to <source>/_site")
    parser.add_argument("--check", action="store_true", help="Validate required public files without copying")
    args = parser.parse_args(argv)
    try:
        if args.check:
            _, files = public_files(args.source)
            result = {"files": len(files), "frames": 682, "checked": True}
        else:
            result = stage_site(args.source, args.output or args.source / "_site")
    except (BuildError, OSError) as error:
        parser.exit(1, "Pages staging failed: %s\n" % error)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# Uptight Review Desk

A local inbox for reviewing contributions to the *Uptight* Cleveland location
map. Read a submission, inspect its film frame and sources, compare its proposed
point with the current map, and publish a decision from this app.

The source is kept in this repository. **The review app is excluded from GitHub
Pages.** It runs on your computer at a loopback address. You do not need to use
GitHub's issue editor to review evidence.

## Start the app

Requires **Python 3.10 or newer**. There are no Python packages to install.

On a Mac, open `Start-Review-Desk.command` in this folder. It starts the local
server and opens the review desk in your browser. Leave its Terminal window open
while using the app. Press **Control-C** in that window to stop it.
The default address is **http://127.0.0.1:8765/**.

From a terminal, starting at the repository root:

```sh
python3 review-desk/app.py
```

On Windows, open `start-review-desk.bat`, or run:

```powershell
py -3 review-desk/app.py
```

If Python is missing, install it from [python.org](https://www.python.org/downloads/)
and run the launcher again. A downloaded Mac command file may need to be opened
through Finder's **Open With → Terminal**. The terminal command above also works.

The compact ZIP has the same folder structure: keep its `review-desk`, `data`,
`lib`, and `media` folders together. A full repository checkout works too. The
first opening includes a dated snapshot of submission **#1, frame 658**. Choose
**Refresh submissions** to retrieve the current public submissions and location data.

## Review a submission

1. Select a record in the inbox. Read the evidence, source dates, archive links,
   attachments and discussion alongside the film frame.
2. Compare the submitted point with the current location. The map distinguishes
   the submitted coordinate from an existing location pin and your edited point.
3. Choose what to approve. **Evidence & review record** retains the contribution without
   placing or moving a pin. **Location record & map pin** lets you choose an existing
   location or create a new one, then review its coordinates and map wording.
4. Set a decision and write the public review note. You can keep a submission
   pending, mark it under review, dispute it, or approve it. Private notes are
   saved separately on your computer.
5. **Save draft** retains your work locally. To update the project, open the
   publication preview, inspect its before/after changes, then explicitly
   publish the decision.

**Approval is a publication decision, not a confidence rating.** A pin can be
approved for the public map while remaining a **Candidate**. Choose the matching
confidence text and explain its limits. A map pin denotes a landmark, site or
area; it does not automatically establish a film camera position. Camera claims
can be retained as evidence without repurposing the location pin.

When changing an existing location, the change applies to that location's linked
frames. Check the linked-frame list before publishing. Keep a genuinely separate
place as a new location rather than moving an unrelated existing record.

## Connect publishing once

Reading public submissions and saving drafts work without signing in. Publishing
requires an account with write access to `hgw3lls/uptight`.

### Use your GitHub CLI account

If [GitHub CLI](https://cli.github.com/) is already installed, sign in once:

```sh
gh auth login --hostname github.com --git-protocol https --web
```

In the review desk, open the connection settings and choose the GitHub CLI
connection. The app delegates authenticated requests to `gh`; it does not copy
the CLI's token into its files or the browser. GitHub CLI normally uses the
system credential store. Its own [authentication documentation](https://cli.github.com/manual/gh_auth_login)
describes its credential-storage behavior.

### Or use a session token

The connection dialog also accepts a fine-grained personal access token. Select
only `hgw3lls/uptight` and grant **Contents: read and write** and **Issues: read and
write**, with the automatically included metadata access. See GitHub's
[token setup guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

The app holds a pasted token in server memory for the current running session.
It does not save it in browser storage, drafts, backups or the repository.
Disconnecting or stopping the app clears that session connection. Do not put
tokens into source files or review notes.

## What publication does

The preview is generated against the current repository and submission. It
shows the exact changes before any public write:

- A dated decision is added to `data/review-decisions.json`.
- The public contribution history displays the latest published review note and
  source links, including under-review and disputed decisions.
- An approved contribution linked to a location adds a published review note and
  its sources to that location. The map displays the dated review note.
- A location approval updates the selected location's coordinates and reviewed
  wording, or creates the requested new location. Evidence-only approval leaves
  coordinates and confidence unchanged.
- The app commits those changes, then synchronizes the issue's review status.
  Approved becomes **Incorporated**; the other public decisions are **Under
  review** and **Disputed**. It preserves unrelated labels and does not close the
  issue or post a discussion comment.
- The repository's existing Pages workflow publishes the website update. The
  review app itself stays outside the Pages artifact.

The app preserves other map records, source history, the map background, and all
film images. Existing research reports remain dated research snapshots; the
new review note records the later decision and its scope.

If the repository, issue or draft changes after preview, the app requires a fresh
preview. It never force-pushes over someone else's work. If the commit succeeds
but issue-label synchronization fails, the app reports **published, status sync
pending** and offers a label-only retry. This avoids publishing the same decision
again merely to repair a status label.

## Saved work and backups

Drafts, cached submissions and publication history are stored under
`~/.uptight-review-desk/`, outside the source repository. The local HTTP server
does not expose this folder. **Download local backup** downloads your local review state,
including your private review notes, without credentials.

For a different local data directory or port:

```sh
python3 review-desk/app.py --data-dir /path/to/review-work --port 8678
```

`--no-browser` starts the app without opening a browser window. The server always
binds to `127.0.0.1`; it is not a shared network service.

## Development and verification

Run the backend and local HTTP behavior checks from the repository root:

```sh
python3 -m unittest discover -s review-desk/tests -p 'test_*.py'
node --test --test-isolation=none review-desk/tests/*.cjs
node --test --test-isolation=none tests/*.cjs
```

The tests use temporary local state and a simulated GitHub service for public
writes. They must never approve a real submission as a test. The documented API
is in `CONTRACT.md`; third-party attributions are in `THIRD-PARTY-NOTICES.md`.

Before deploying Pages, `scripts/build_pages.py` stages only the public website
files. Its allowlist includes the future public decision log, and excludes this
app, tests, scripts, credentials and local state. Keep that separation intact
when adding public assets.

# Uptight local review desk

Owner-facing, local-only browser app. Source may be public in GitHub; the Pages
artifact must exclude `review-desk/`, scripts, tests, and local state. Bind the
server to `127.0.0.1` only. No review is approved by installing or opening the app.

## Workflow

Read public issues, inspect film/source/current location, edit a local decision,
save it, preview the exact public change, then explicitly publish that decision.
The local draft distinguishes an approval from a successful publication. A
location may be published as a **Candidate**; approval never implies certainty.
Keep original research and photographs. Append a dated review record and source
links. Notes marked private must never be committed or sent to GitHub.

Publication uses the user's installed/authenticated GitHub CLI, or an optional
fine-grained token held in server memory for this running session only. Fixed
repository: `hgw3lls/uptight`; fixed branch: `main`. No credentials in browser
storage, logs, files, command arguments, repository, or exported decisions.

## JSON API (same-origin only)

All JSON responses are objects. Errors use `{error: string, code?: string}` and
appropriate HTTP status. Every POST requires `X-Review-Token` from bootstrap.

`GET /api/bootstrap` returns:

```
{ csrfToken, repository, siteUrl, bounds: [west,south,east,north],
  connection: {connected,mode,login,canPublish,message},
  issues: [Issue], sites: [SiteWithoutEmbeddedImages],
  drafts: {"1": Draft}, history: [PublishedRecord],
  lastRefresh, refreshError, truncated }
```

An Issue has `{number,title,url,author,state,createdAt,updatedAt,body,
remoteStatus,fields:{location,frame,question,kind,evidence,sourceDate,attribution,
links:[string],proposedAddress,latitude,longitude,place,attachments:[string]}}`.
Frames are numeric 1..682 or null; coordinates numeric or null. Sites preserve
the public map fields but each `frames[].image` is omitted from bootstrap.

`POST /api/refresh` with `{}` returns bootstrap (without changing saved drafts).
Use authenticated reads when connected; otherwise read the public API. Preserve
cached evidence on failures and report refresh time/partial results accurately.

`GET /api/issues/1` returns `{issue,comments:[{body,author,url,createdAt}]}`.
`GET /api/frame/658` returns the official still, from local files, cached bytes,
or the fixed project's public frame URL. No arbitrary proxy URLs.
`GET /context.json` and `/vendor/d3.min.js` serve the existing project assets.

`POST /api/connection` accepts `{mode:"gh"}` or `{mode:"token",token:string}`;
returns `{connection}` after validating repository push access. Token mode is
optional session-only auth; clear the password field immediately after sending.
`POST /api/disconnect` clears session authentication and returns `{connection}`.

`POST /api/drafts/1` accepts Draft and returns `{draft}`. Draft fields:

```
{ decision: "pending"|"under-review"|"disputed"|"approved",
  mode: "evidence"|"location", place: "third"|"new",
  name, address, latitude, longitude,
  status: "Candidate"|"Strong match"|"Unplaced",
  confidenceLabel, confidenceNote, pinNote, publicNote, privateNote,
  baseIssueUpdatedAt }
```

Text fields are strings, coords numeric or null. `place:"new"` creates a new
location using the submission frame and an issue-derived stable ID. A location
pin means a landmark/site/area, not an exact camera station. Camera claims can be
retained in evidence. Require explicit location mode, bounded coordinates,
frame/site context, a meaningful public review note and pin/confidence notes
before publishing a coordinate. Do not default submitted coordinates into an
approved location change. An evidence-only approval preserves all map positions
and confidence; add its dated review note and sources to the location if linked.

`POST /api/preview/1` takes `{}` and previews the saved Draft against the latest
remote head and issue. Returns `{previewId,issueNumber,decision,changes:[{field,
before,after}],publicNote,sourceLinks,files:[string],warnings:[string],summary}`.
The preview is in server memory, short-lived, tied to the draft fingerprint,
issue update timestamp and remote head. No remote mutations.

`POST /api/publish/1` takes `{previewId}`. Returns
`{published:true,commitSha,commitUrl,issueUrl,issueSynced,warning,record}` after
verified publication. Non-force update from the exact preview parent; detect
stale heads/drafts/issues and require a fresh preview. Record decisions in
`data/review-decisions.json`; preserve all unmodified tree entries. Approved
location/evidence records also update only the relevant site in
`data/map-data.json`. After successful commit, synchronize the existing review
labels, preserving unrelated labels. No automatic comments or closing issues.
If label sync fails after the commit, report publication succeeded with sync
pending; persist enough state to retry label synchronization without a new
commit. A network-ambiguous publication must be reconciled before retry.

`POST /api/sync-issue/1` retries the label for an already published decision.
`GET /api/export` downloads a local review backup, excluding credentials.

Local state defaults to `~/.uptight-review-desk/`; `--data-dir` can override for
tests/portable use. The HTTP API never serves this directory. Seed issue #1 is a
public, dated snapshot for first opening/offline use, never an approved record.

## Verification

Test parsing and validation, issue timestamp conflicts, before/after patches,
unrelated site/source/frame preservation, private-note exclusion, CSRF/Host/
Origin restrictions, bounded frame/static routes, failed/ambiguous/non-fast-
forward publishing and label-sync retry. Test Pages staging exclusion, preserving
all public runtime assets. Do not create a live test issue or publish a decision.

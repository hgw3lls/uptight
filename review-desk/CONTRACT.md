# Uptight local review desk

Owner-facing, local-only browser app. Source may be public in GitHub; the Pages
artifact must exclude `review-desk/`, scripts, tests, and local state. Bind the
server to `127.0.0.1` only. No review is approved by installing or opening the app.

## Workflow

Read public issues, inspect film/source/current location, edit the proposed
website information, preview the exact public change, then explicitly approve
and publish it. The primary `content` mode updates the location's actual name,
address, film/location description (`connection`) and historical context
(`history`). A coordinate change is optional and must be selected explicitly.
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
  mode: "content"|"evidence"|"location", place: existingSiteId|"new",
  name, address, connection, history, updatePin: false,
  latitude, longitude,
  status: "Candidate"|"Strong match"|"Unplaced",
  confidenceLabel, confidenceNote, pinNote, publicNote, privateNote,
  baseIssueUpdatedAt }
```

Text fields are strings, `updatePin` is a strict boolean, and coords numeric or
null. Content publication requires a location name and meaningful description.
The UI starts the editable description from the submitted evidence and retains
the current history for editing. A blank content-mode public note gets a concise
audit note automatically; private notes are never used for this. Exact old/new
values are recorded in the preview and public decision ledger.

For an existing location, content mode retains its coordinate, status, confidence
and pin explanation unless `updatePin:true` is explicitly selected. Content
mode can create an unpinned candidate when the submission has a valid frame.
`place:"new"` uses the submission frame and an issue-derived stable ID. A location
pin means a landmark/site/area, not an exact camera station. Camera claims can be
retained in evidence. Require explicit location mode or content `updatePin:true`, bounded coordinates,
frame/site context, a meaningful public review note and pin/confidence notes
before publishing a coordinate. Do not default submitted coordinates into an
approved location change. Saved legacy drafts retain their original mode and
meaning. An evidence-only approval preserves all map positions
and confidence; add its dated review note and sources to the location if linked.

`POST /api/preview/1` takes `{}` and previews the saved Draft against the latest
remote head and issue. Returns `{previewId,issueNumber,decision,changes:[{field,
before,after}],publicNote,sourceLinks,files:[string],warnings:[string],summary}`.
The preview is in server memory, short-lived, tied to the draft fingerprint,
issue update timestamp and remote head. No remote mutations.

`POST /api/publish/1` takes `{previewId}`. Returns
`{published:true,commitSha,commitUrl,issueUrl,siteUrl,issueSynced,warning,record}` after
verified publication. Non-force update from the exact preview parent; detect
stale heads/drafts/issues and require a fresh preview. Record decisions in
`data/review-decisions.json`; preserve all unmodified tree entries. Approved
content/location/evidence records also update only the relevant site in
`data/map-data.json`. After successful commit, synchronize the existing review
labels, preserving unrelated labels. No automatic comments or closing issues.
If label sync fails after the commit, report publication succeeded with sync
pending; persist enough state to retry label synchronization without a new
commit. A network-ambiguous publication must be reconciled before retry.

`POST /api/sync-issue/1` retries the label for an already published decision.
`GET /api/export` downloads a local review backup, excluding credentials.

Content records and their `reviewedContributions` entries include the strict
`updatePin` boolean so the public site can label website text and pin changes
accurately. The main map renders the updated site fields; separate dated research
reports retain their historical assessments. `siteUrl` links to the canonical
public map location and does not assert that the Pages deployment has finished.

Local state defaults to `~/.uptight-review-desk/`; `--data-dir` can override for
tests/portable use. The HTTP API never serves this directory. Seed issue #1 is a
public, dated snapshot for first opening/offline use. It reflects the issue's
public status and never creates a local draft decision or a new approval.

## Verification

Test parsing and validation, issue timestamp conflicts, before/after patches,
unrelated site/source/frame preservation, private-note exclusion, CSRF/Host/
Origin restrictions, bounded frame/static routes, failed/ambiguous/non-fast-
forward publishing and label-sync retry. Test Pages staging exclusion, preserving
all public runtime assets. Do not create a live test issue or publish a decision.

# Uptight — location map

Static build of the v2 map interface, served by GitHub Pages.

Live at `https://hgw3lls.github.io/uptight/`

The public map keeps votes, flags and camera drafts in each visitor's browser.
The header labels this **VOTES · THIS BROWSER**. Public evidence contributions
have a separate, durable record in this repository's GitHub Issues.

## Location review

`location-review.html` presents the 17 October 2026 review, including searchable
coverage of all 682 indexed stills, confidence assessments, sources and downloads.
It links to individual stills with `#shot=<frame_id>`. Existing
`#place=<site_id>&frame=<index>` links remain supported.

The research data is stored in `data/location-review.json`, with matching
frame annotations in `data/locations.csv` and map records in `data/map-data.json`.
Historical landmark pins are distinguished from camera positions; documented
filming areas without a matched still appear in the review rather than being
assigned an invented frame.

## Evidence comparisons and research board

`evidence.html` presents three illustrated cases: Eagle Avenue Lift Bridge,
Madison Square Building, and the probable former Clark Avenue Bridge. Film
stills and reference photographs retain their dates, credits and source links.
The case notes state which features support an identification and what remains
unresolved. Reference photographs are comparisons, not automatically photographs
from the filming year or a verified film camera position.

`research-board.html` turns the remaining work into five specific questions:
Madison's complete facade; the former Clark bridge roadway; the Leader
Drug/Kronheim business pairing; the Colonial Hotel/blood-bank streetscape;
and a connection between documented East 86th/Wade Park filming and a shot.
The research records live in `data/evidence-cases.json` and
`data/research-questions.json`.

## Contributing evidence

Use `contribute.html`, or **Send evidence** from a selected map still. The form
retains the actual frame ID, source/date/attribution, explanation and proposed
location context. Opening a GitHub draft does not submit it. Contributors review
the draft, add their actual images or documents in GitHub's editor, and use
GitHub's final submission button. A GitHub account is required for the public
record. The page explains the public visibility before continuing.

GitHub retains the evidence, attachments, discussion and issue history. The
website reads public evidence issues without a client-side GitHub token and
links to the canonical records. A failed or limited feed is shown explicitly;
opening a draft or saving a local camera bearing is never treated as a received
contribution. A downloadable draft is available, and the optional existing email
route sends a note and source links only; it is not the public attachment route.

### Review status

A submitted evidence issue is **Received — awaiting review** until a maintainer
sets a review label. The `Prepare evidence review labels` workflow creates these
labels if missing when its configuration is published, and can be run manually.
Apply one status label at a time in GitHub:

- `evidence:received`
- `evidence:under-review`
- `evidence:incorporated`
- `evidence:disputed`

Only use **incorporated** after the site/research record has actually been
updated. Closing an issue does not imply incorporation. Conflicting review labels
are surfaced for correction. The website does not let a visitor change the
published location confidence through a vote or submission.

The optional local research server remains supported by the map. Its multipart
upload route now preserves the selected still rather than choosing the first
still in a location record. Public GitHub Pages submissions use the contribution
page and GitHub issue form in `.github/ISSUE_TEMPLATE/location-evidence.yml`.

## Checks

Run the focused contribution, map and research-page checks with:

```sh
node --test --test-isolation=none tests/*.cjs
```

They cover selected-frame preservation, unresolved stills, proposed map points,
local camera drafts, the optional local-server upload frame, GitHub draft and
review-status handling, safe public record rendering, and recovery from stalled
requests. Research-page checks cover comparison navigation, image annotations,
source links, image dialogs and the five question-specific contribution routes.
DOM simulations verify behavior; they do not replace browser layout checks or
a signed-in GitHub attachment test.

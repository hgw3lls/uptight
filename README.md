# Uptight — location map

Static build of the v2 map interface, served by GitHub Pages.

Live at `https://hgw3lls.github.io/uptight/`

The public map keeps votes, flags and camera drafts in each visitor's browser.
The header labels this **VOTES · THIS BROWSER**. Public evidence contributions
have a separate, durable record in this repository's GitHub Issues.

## Map navigation

The **Find a spot** field accepts a modern address/place name or decimal
latitude, longitude, such as `41.494325, -81.701799`. Submit with **Go** or
Enter. Address results stay within the Cleveland research area; coordinates
are resolved in the browser without an address-service request. Unambiguous
longitude-first pairs are accepted too.

Selecting a result centers a blue temporary pin while retaining the selected
film still. **Use pin for frame …** opens the evidence draft with that actual
frame ID, the proposed coordinates and the entered address. **Adjust on map**
lets the visitor choose a nearby point through the existing pin proposal flow.
A lookup does not create a verified film location or submit an evidence record.
**Fit** returns to the landmark overview; **Area** shows the research boundary.

The search and geographic context share the research rectangle
`[-81.74, 41.43, -81.57, 41.56]` in west/south/east/north order. It covers the
Flats, southern industrial valley, Hough and Glenville with surrounding context.
It is a project research extent, not the Cleveland municipal boundary. Direct
map pin proposals are checked against the same boundary.

Map drag, wheel and touch gestures are attached only to the map SVG. Details,
film-viewer and evidence panels retain native scrolling, contain overscroll,
and accept keyboard focus. Keyboard shortcuts respect panels and editing
controls. On phones, the explicit sheet handle expands/collapses the details;
scrolling the text does not change the scene or sheet state.

### Street and water context

`data/cleveland-context.json` bundles expanded **January 2026** modern street
and water geometry from [Census TIGERweb](https://tigerweb.geo.census.gov/tigerwebmain/TIGERweb_main.html).
The file retains source URLs, data date, public-domain attribution and the
exact research bounds. It includes 4,696 source road records grouped into
2,402 drawing features and 34 water polygons. Separate street segments stay
separate; labels appear on visible segments when zoomed in. Water rings follow
D3's spherical winding convention. Original map geometry remains a loading
fallback. The modern background supplies geographic context, including changed
roads, and does not reconstruct the 1968 street layout.

### Address search service

`assets/map-navigation.js` provides local coordinate parsing and a configurable
[Photon](https://github.com/komoot/photon#demo-server) address client. The public
service permits reasonable project use, may throttle requests, and does not
promise availability. The UI attributes Photon and OpenStreetMap contributors.
Requests run only after explicit submission, use the API's hard bounding box,
check every returned point locally, and apply a submit debounce, a minimum
one-second request interval, an in-memory cache and an eight-second timeout.
Typing cancels stale work without running autocomplete requests. Coordinates
remain usable if address search fails. No API key or live map tile service is
needed. Higher traffic should use a separately configured search service.

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

`evidence.html` presents four illustrated cases: Eagle Avenue Lift Bridge,
Madison Square Building, the probable former Clark Avenue Bridge, and Carter Road Bridge. Film
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

### Focused follow-up, 18 October 2026

Research completed on 17 October adds Hopkins plate 6b (1921, revised 1924),
which reconciles Madison Square's Hough address forms within one named frontage,
and County Engineer photograph cea0146 (1984), which supplies a direct Clark
central-truss comparison. Madison's approximate marker now follows the historic
southwest-corner footprint. The 1974 Kronheim and Leader directory entries are
recorded as later controls; the filming-period storefront pairing remains open.

`data/research-log.json` retains the bounded searches, primary record identifiers,
source dates, remaining archive requests, access limits, and reproducible marker
calculation. Original PDF observations remain in the coverage provenance fields;
the follow-up does not upgrade either film identification to confirmed.

### Frame 639 pass, 18 October 2026

The Carter Road comparison pairs frame 639 (01:39:27.628) with a July 1986
HAER southeast-approach photograph and a 2002 context image. Its assessment is
**Strong visual identification**; the later references do not establish the
1968 camera position. The research board retains its five existing questions.

### Additional frame and visitor claims, 18 October 2026

The follow-up log and individual frame notes assess the supplied hotel, storefront,
bridge, church, and street-route claims. Frame 602 gains a probable B&O No. 463
background landmark while the hotel name stays unresolved. Frame 646 gains a
probable Union Terminal viaduct comparison. Frame 667 remains ore-handling
apparatus in an unplaced yard. Flat Iron, United Electric and Leader address claims
are distinguished from verified film locations, and the present St. Agnes / Our
Lady of Fatima church is dated to 1983.

The Clark case adds a county aerial check showing that the supplied pier coordinate
falls on an industrial roof in 2019. County photographs document demolition in
1984–85, and ODOT dates the I-490 crossing to 1990. No camera coordinate or
public access promise is inferred from these historical and geographic controls.

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
local camera drafts, native panel/map gesture boundaries, keyboard and touch
focus, bounded address/coordinate searches, temporary pin handoff, the optional
local-server upload frame, GitHub draft and
review-status handling, safe public record rendering, and recovery from stalled
requests. Research-page checks cover comparison navigation, image annotations,
source links, image dialogs and the five question-specific contribution routes.
DOM simulations verify behavior; they do not replace browser layout checks or
a signed-in GitHub attachment test.

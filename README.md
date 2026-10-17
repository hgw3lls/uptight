# Uptight — location map

Static build of the v2 map interface, served by GitHub Pages.

Live at `https://hgw3lls.github.io/uptight/`

On Pages there is no server, so the header reads **OFFLINE · THIS BROWSER**:
votes, notes and added places are saved in each visitor's own browser only.
Run the Python server locally for shared, persistent research records.

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

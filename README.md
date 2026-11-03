# SEQ School Explorer

A map of every school in South East Queensland: 1,110 schools across the 12 ShapingSEQ council areas, with enrolments, ICSEA, staffing and student mix for each year from 2008 to 2025.

Plain HTML, CSS and JavaScript ([Leaflet](https://leafletjs.com/) from a CDN). There's no build step, and it runs on GitHub Pages as is.

## Features

- Government, Catholic and Independent layers, each with its own shape and colour
- Colour markers by sector, school type (primary/secondary/combined) or ICSEA band
- Marker size scaled by enrolment, and clustering of nearby schools
- Filters for school type, council area and special schools
- A year timeline (2008–2025) with stacked enrolment bars and a play button
- A school detail panel with four tabs:
  - **Overview:** students, ICSEA, teachers, students per teacher and non-teaching staff, each against the SEQ median for that school type
  - **Students:** girls/boys split, socio-educational advantage quarters, Indigenous % and language background other than English %
  - **Trends:** charts for 2008–2025 with the SEQ median and the middle half of schools shaded
  - **NAPLAN:** deep links to the school's My School results and progress pages
- Queensland state school catchments (primary, junior secondary, senior secondary), which you can toggle on and off and click through to the school
- Search by name, suburb or postcode (Ctrl K)
- Shareable links, e.g. `#s=46410` (Ormiston State School), `#s=46410&y=2015&t=trends` or `#c=primary`
- Light and dark themes

## Run locally

```sh
python -m http.server
# open http://localhost:8000
```

Opening `index.html` directly from disk won't work, because browsers block `fetch()` on `file://` URLs.

## Update the data

`data/schools.json` is generated from ACARA's open datasets:

```sh
pip install pandas openpyxl
python scripts/build_data.py
```

The script downloads *School Profile 2008–2025* and *School Location 2025* from the [ACARA Data Access Program](https://www.acara.edu.au/contact-us/acara-data-access) into `raw/`, which is git-ignored. It keeps QLD schools in the SEQ council areas and writes a compact JSON file of about 1 MB. When ACARA publishes a new year, update the file names in the script and run it again.

Catchment boundaries come from Queensland Government open data (CC BY 4.0):

```sh
pip install shapely
python scripts/build_catchments.py
```

The script downloads the 2026 primary, junior secondary and senior secondary catchment KML files and matches each catchment to its ACARA school by name. It simplifies the boundaries to about 10 m and writes `data/catchments-*.geojson`, roughly 1–2 MB each. The browser loads them only when you turn the layer on.

## Deploy to GitHub Pages

Push to GitHub, then go to **Settings → Pages → Deploy from a branch → `main` / root**.

## Notes and limitations

- School coordinates come from the 2025 location file, so schools that have closed since don't appear.
- NAPLAN results aren't copied into the site. Clause 6.4 of My School's terms of use doesn't allow its content to be posted on another public website without ACARA's written permission, so the NAPLAN tab links to the school's My School pages. School-level NAPLAN data can be requested through ACARA's data access program.
- Basemap: Esri World Gray Canvas. School data © ACARA, used under its data access terms.

"""Build data/schools.json for South East Queensland from ACARA open data.

Usage:
    python scripts/build_data.py            # downloads the ACARA files into raw/
    python scripts/build_data.py --no-download

Source: ACARA Data Access Program (School Profile 2008-2025, School Location 2025),
https://www.acara.edu.au/contact-us/acara-data-access
"""
import json
import math
import sys
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
OUT = ROOT / "data" / "schools.json"

BASE = "https://dataandreporting.blob.core.windows.net/anrdataportal/Data-Access-Program/"
PROFILE = "School Profile 2008-2025.xlsx"
LOCATION = "School Location 2025.xlsx"

# Local government areas covered by the ShapingSEQ regional plan.
SEQ_LGAS = {
    "Brisbane", "Gold Coast", "Ipswich", "Lockyer Valley", "Logan", "Moreton Bay",
    "Noosa", "Redland", "Scenic Rim", "Somerset", "Sunshine Coast", "Toowoomba",
}

# Per-year metrics kept for each school, in output order.
METRICS = {
    "enr": "Total Enrolments",
    "icsea": "ICSEA",
    "pct": "ICSEA Percentile",
    "tfte": "Full Time Equivalent Teaching Staff",
    "nfte": "Full Time Equivalent Non-Teaching Staff",
    "q1": "Bottom SEA Quarter (%)",
    "q2": "Lower Middle SEA Quarter (%)",
    "q3": "Upper Middle SEA Quarter (%)",
    "q4": "Top SEA Quarter (%)",
    "ind": "Indigenous Enrolments (%)",
    "lbote": "Language Background Other Than English - Yes (%)",
    "girls": "Girls Enrolments",
    "boys": "Boys Enrolments",
}


def download():
    RAW.mkdir(exist_ok=True)
    for name in (PROFILE, LOCATION):
        dest = RAW / name
        if dest.exists():
            continue
        print(f"downloading {name}")
        urllib.request.urlretrieve(BASE + name.replace(" ", "%20"), dest)


def clean(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def main():
    if "--no-download" not in sys.argv:
        download()

    loc = pd.read_excel(RAW / LOCATION, sheet_name=1)
    loc = loc[(loc["State"] == "QLD") & loc["Local Government Area Name"].isin(SEQ_LGAS)]

    prof = pd.read_excel(RAW / PROFILE, sheet_name=1)
    prof = prof[prof["ACARA SML ID"].isin(loc["ACARA SML ID"])]

    years = sorted(int(y) for y in prof["Calendar Year"].unique())
    by_school = {sid: g.set_index("Calendar Year") for sid, g in prof.groupby("ACARA SML ID")}

    schools = []
    for row in loc.to_dict("records"):
        sid = int(row["ACARA SML ID"])
        hist = by_school.get(sid)
        latest = hist.loc[hist.index.max()] if hist is not None else None
        series = {}
        for key, col in METRICS.items():
            series[key] = [
                clean(hist.at[y, col]) if hist is not None and y in hist.index else None
                for y in years
            ]
        schools.append({
            "id": sid,
            "name": row["School Name"],
            "suburb": row["Suburb"],
            "postcode": str(row["Postcode"]),
            "sector": row["School Sector"],
            "type": row["School Type"],
            "special": bool(row["Special school"]),
            "campus": row["Campus Type"],
            "lga": row["Local Government Area Name"],
            "lat": round(float(row["Latitude"]), 6),
            "lng": round(float(row["Longitude"]), 6),
            "yr": clean(latest["Year Range"]) if latest is not None else None,
            "url": clean(latest["School URL"]) if latest is not None else None,
            "gov": clean(latest["Governing Body"]) if latest is not None else None,
            **series,
        })

    schools.sort(key=lambda s: s["name"])
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"years": years, "schools": schools}, separators=(",", ":")),
                   encoding="utf-8")
    print(f"{len(schools)} schools, years {years[0]}-{years[-1]} -> {OUT} "
          f"({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()

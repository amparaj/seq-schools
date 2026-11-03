"""Build data/catchments-{primary,junior,senior}.geojson for SEQ state schools.

Usage:
    python scripts/build_catchments.py            # downloads the KML files into raw/catchments/
    python scripts/build_catchments.py --no-download

Run build_data.py first: catchments are matched to ACARA school IDs by name.

Source: Queensland state schools - geographic information (CC BY 4.0),
https://www.data.qld.gov.au/dataset/queensland-state-schools-geographic-information
"""
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from shapely.geometry import MultiPolygon, Polygon, box, mapping

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw" / "catchments"
DATA = ROOT / "data"

BASE = "https://www.data.qld.gov.au/dataset/b01b50fc-b8ab-4c88-bc4a-34d42930fea8/resource/"
LAYERS = {
    "primary": ("a35846d9-e320-46fc-aea1-b477001ca485", "primary_catchments_2026.kml"),
    "junior": ("2557305a-5339-4945-819f-551bd917fe39", "junior_secondary_catchments_2026.kml"),
    "senior": ("930ba950-9661-4edb-bb04-8cdfb3305d33", "senior_secondary_catchments_2026.kml"),
}

SIMPLIFY = 0.0001  # degrees, roughly 10 m
NS = {"k": "http://earth.google.com/kml/2.1"}


def download():
    RAW.mkdir(parents=True, exist_ok=True)
    for res, name in LAYERS.values():
        dest = RAW / name
        if not dest.exists():
            print(f"downloading {name}")
            urllib.request.urlretrieve(f"{BASE}{res}/download/{name}", dest)


def norm(name):
    name = name.lower().replace("&", "and")
    name = re.sub(r"\bshs\b", "state high school", name)
    name = re.sub(r"\bss\b", "state school", name)
    name = re.sub(r"\bsips\b", "state infants and primary school", name)
    return re.sub(r"[^a-z0-9]+", " ", name).strip()


def ring(el):
    text = el.find(".//k:coordinates", NS).text
    return [tuple(map(float, p.split(",")[:2])) for p in text.split()]


def placemarks(path):
    for pm in ET.parse(path).getroot().iter(f"{{{NS['k']}}}Placemark"):
        name = pm.find("k:name", NS).text.strip()
        desc = pm.find("k:description", NS).text or ""
        code = re.search(r"Centre_code</td><td>([^<]+)", desc)
        polys = []
        for p in pm.iter(f"{{{NS['k']}}}Polygon"):
            outer = ring(p.find("k:outerBoundaryIs", NS))
            inner = [ring(i) for i in p.findall("k:innerBoundaryIs", NS)]
            polys.append(Polygon(outer, inner))
        geom = polys[0] if len(polys) == 1 else MultiPolygon(polys)
        yield name, code.group(1) if code else None, geom


def round_coords(obj, nd=5):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], float):
            return [round(v, nd) for v in obj]
        return [round_coords(o, nd) for o in obj]
    return obj


def main():
    if "--no-download" not in sys.argv:
        download()

    schools = json.loads((DATA / "schools.json").read_text(encoding="utf-8"))["schools"]
    gov = [s for s in schools if s["sector"] == "Government"]
    by_name = {norm(s["name"]): s["id"] for s in gov}
    lats = [s["lat"] for s in schools]
    lngs = [s["lng"] for s in schools]
    seq = box(min(lngs) - 0.2, min(lats) - 0.2, max(lngs) + 0.2, max(lats) + 0.2)

    for key, (_, fname) in LAYERS.items():
        feats, unmatched = [], []
        for name, code, geom in placemarks(RAW / fname):
            if not geom.intersects(seq):
                continue
            sid = by_name.get(norm(name))
            if sid is None:
                # Neighbouring schools outside the SEQ councils fall in the bounding box too.
                unmatched.append(name)
                continue
            g = geom.simplify(SIMPLIFY, preserve_topology=True)
            feats.append({
                "type": "Feature",
                "properties": {"name": name, "code": code, "id": sid},
                "geometry": {"type": g.geom_type,
                             "coordinates": round_coords(mapping(g)["coordinates"])},
            })
        out = DATA / f"catchments-{key}.geojson"
        out.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                  separators=(",", ":")), encoding="utf-8")
        print(f"{key}: {len(feats)} catchments, {len(unmatched)} skipped (not an SEQ school) "
              f"-> {out.name} ({out.stat().st_size / 1e6:.1f} MB)")
        if "-v" in sys.argv:
            for n in unmatched:
                print("   skipped:", n)


if __name__ == "__main__":
    main()

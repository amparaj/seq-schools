"""Build data/annual.json from Queensland state school annual reports.

Usage:
    python scripts/build_annual_reports.py               # downloads PDFs into raw/annual/
    python scripts/build_annual_reports.py --no-download
    python scripts/build_annual_reports.py -v            # list schools that failed to download or parse

Run build_data.py first: the school list and websites come from data/schools.json.

Every Queensland state school publishes an annual report on its *.eq.edu.au site from one
Department of Education template, so the tables parse the same way for every school:
attendance (overall and by year level), average class size, School Opinion Survey items
(parents/caregivers, students, staff) and school disciplinary absences, each for three years.
Catholic and Independent schools publish their own reports in their own formats, so they're
not included.

Source: State of Queensland (Department of Education), school annual reports. Department
websites are licensed CC BY 4.0 (https://qed.qld.gov.au/copyright-statement).
"""
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw" / "annual"
DATA = ROOT / "data"

REPORT_YEAR = 2025
YEARS_OUT = [REPORT_YEAR - 2, REPORT_YEAR - 1, REPORT_YEAR]  # each report covers three years
REPORT_PATH = f"/supportandresources/formsanddocuments/annualreports/annual-report-{REPORT_YEAR}.pdf"
USER_AGENT = "seq-schools-explorer data build (https://github.com/amparaj)"
DELAY = 0.5  # seconds between downloads; these are school websites

# A table cell: a percentage, a count, or one of the template's "not available" markers.
VALUE = re.compile(r"^(?:\d+(?:\.\d+)?%?|<5|–|-|—|DW|N/?A)$")
SURVEYS = {
    "parent": "Percentage of parents/caregivers who agree",
    "student": "Percentage of students who agree",
    "staff": "Percentage of staff who agree",
}
SDA_ROWS = {"Short Suspension": "short", "Long Suspension": "long", "Exclusion": "excl", "Cancellation": "canc", "Total": "total"}


def schools():
    data = json.loads((DATA / "schools.json").read_text(encoding="utf-8"))
    out = []
    for s in data["schools"]:
        m = re.match(r"^https?://([a-z0-9-]+\.eq\.edu\.au)", s.get("url") or "", re.I)
        if s["sector"] == "Government" and m:
            out.append((s, m.group(1).lower()))
    return out


def download(host, dest):
    """Save the report to dest; return an error string, or None on success."""
    req = urllib.request.Request(f"https://{host}{REPORT_PATH}", headers={"User-Agent": USER_AGENT})
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt == 0:
                time.sleep(60)  # the server asked us to slow down; try once more
                continue
            return f"HTTP {e.code}"
        except (urllib.error.URLError, TimeoutError) as e:
            return str(e)
    if not body.startswith(b"%PDF"):
        return "not a PDF"
    dest.write_bytes(body)
    return None


def num(cell):
    """'86.3%' -> 86.3, '22' -> 22, anything suppressed -> None."""
    m = re.match(r"^(\d+(?:\.\d+)?)%?$", cell)
    if not m:
        return None
    v = float(m.group(1))
    return int(v) if v.is_integer() else v


def clean(text):
    """Normalise a row label: ligatures, whitespace, footnote marks, and the change column a
    few schools add ("Increase", "+13.4%"), which lands at the start of the next label."""
    text = re.sub(r"[¹²³⁴]+$", "", re.sub(r"\s+", " ", text).strip())
    text = re.sub(r"^(?:(?:Increase|Decrease|[+-]\d+(?:\.\d+)?%)\s+)+", "", text)
    return unicodedata.normalize("NFKC", text).strip()


def lines_of(pdf):
    doc = pymupdf.open(pdf)
    out = []
    for page in doc:
        out += [ln.strip() for ln in page.get_text().splitlines()]
    return [ln for ln in out if ln]


YEAR = re.compile(r"^(20\d\d)(\*?)$")
# A table ends at its notes or where the next table or section starts.
STOP = ("Notes", "Table ", "Type of school", "Description", "Percentage of", "School disciplinary")


def header(lines, i):
    """The run of year headers at or after line i: [(year, starred)], and the line after them.

    A starred year ("2023*") means "data not available"; the report may give it a column of
    DW/– markers or leave the column out, so rows() checks how many values each row has.
    """
    while i < len(lines) and not YEAR.match(lines[i]):
        i += 1
    hdr = []
    while i < len(lines) and YEAR.match(lines[i]):
        m = YEAR.match(lines[i])
        hdr.append((int(m.group(1)), bool(m.group(2))))
        i += 1
    return hdr, i


def rows(lines, i, hdr):
    """Label/value rows from line i to the end of the table, each aligned to YEARS_OUT.

    A label may run over several lines; its values follow, one per column.
    """
    every = [y for y, _ in hdr]
    shown = [y for y, star in hdr if not star]
    out, label = [], []
    while i < len(lines) and not lines[i].startswith(STOP):
        if label and VALUE.match(lines[i]):
            n = 0
            while i + n < len(lines) and n < len(every) and VALUE.match(lines[i + n]):
                n += 1
            cols = every if n == len(every) else shown if n == len(shown) else None
            if cols:
                got = dict(zip(cols, (num(v) for v in lines[i:i + n])))
                out.append((clean(" ".join(label)), [got.get(y) for y in YEARS_OUT]))
            label = []
            i += n
            continue
        label.append(lines[i])
        i += 1
    return out


def find(lines, prefix, start=0):
    return next((k for k in range(start, len(lines)) if lines[k].startswith(prefix)), None)


def table(lines, anchor):
    """Rows of the table whose title or lead line starts with `anchor`."""
    k = find(lines, anchor)
    if k is None:
        return []
    hdr, k = header(lines, k + 1)
    return rows(lines, k, hdr) if hdr else []


def parse(pdf):
    lines = lines_of(pdf)
    rec = {}
    title = lines[3] if len(lines) > 3 else ""

    for key, head in SURVEYS.items():
        items = table(lines, head)
        if items:
            rec.setdefault("sos", {})[key] = [[q, v] for q, v in items]

    att = [v for lbl, v in table(lines, "Table 8: Overall student attendance") if lbl.startswith("Overall attendance")]
    if att:
        rec["att"] = att[0]
    rec["attYr"] = [[y, v] for y, v in table(lines, "Table 9: Student attendance rates") if y.startswith(("Prep", "Year"))]
    rec["cls"] = [[y, v] for y, v in table(lines, "Table 2: Average class size") if y.startswith(("Prep", "Year"))]
    rec["sda"] = {SDA_ROWS[lbl]: v for lbl, v in table(lines, "Type of school disciplinary absence") if lbl in SDA_ROWS}
    rec = {k: v for k, v in rec.items() if v}
    if rec:
        rec["years"] = YEARS_OUT
    return title, rec


def norm(name):
    return re.sub(r"[^a-z0-9]+", " ", name.lower().replace("&", "and")).strip()


def main():
    verbose = "-v" in sys.argv
    fetch = "--no-download" not in sys.argv
    RAW.mkdir(parents=True, exist_ok=True)
    targets = schools()
    by_host = {}
    for s, host in targets:
        by_host.setdefault(host, []).append(s)

    failed, out = [], {}
    for n, (host, group) in enumerate(sorted(by_host.items()), 1):
        pdf = RAW / f"{host.split('.')[0]}-{REPORT_YEAR}.pdf"
        if not pdf.exists():
            if not fetch:
                failed.append((host, "not downloaded"))
                continue
            err = download(host, pdf)
            time.sleep(DELAY)
            if err:
                failed.append((host, err))
                continue
            if n % 50 == 0:
                print(f"  {n}/{len(by_host)} downloaded")
        try:
            title, rec = parse(pdf)
        except Exception as e:  # noqa: BLE001
            failed.append((host, f"parse error: {e}"))
            continue
        if not rec.get("sos") and not rec.get("att"):
            failed.append((host, "no tables found"))
            continue
        # Campuses can share a website; give the report only to the school it names.
        named = [s for s in group if norm(s["name"]) == norm(title)]
        for s in named or group[:1]:
            out[str(s["id"])] = rec

    DATA.mkdir(exist_ok=True)
    meta = {"reportYear": REPORT_YEAR, "source": "State of Queensland (Department of Education) school annual reports, CC BY 4.0"}
    (DATA / "annual.json").write_text(json.dumps({**meta, "schools": out}, separators=(",", ":")), encoding="utf-8")
    print(f"wrote data/annual.json: {len(out)} schools; {len(failed)} websites failed")
    if verbose:
        for host, err in failed:
            print(f"  {host}: {err}")


if __name__ == "__main__":
    main()

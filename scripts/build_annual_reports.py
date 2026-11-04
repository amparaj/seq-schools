"""Build data/annual.json from Queensland state school annual reports.

Usage:
    python scripts/build_annual_reports.py               # downloads PDFs into raw/annual/
    python scripts/build_annual_reports.py --no-download
    python scripts/build_annual_reports.py -v            # list schools that failed to download or parse

Run build_data.py first: the school list and websites come from data/schools.json.

Every Queensland state school publishes an annual report on its *.eq.edu.au site from one
Department of Education template, and older reports usually stay up at the same path with the
year changed (though many schools have removed some). Each report covers three years; for each
year the newest report that has it wins. Measures: overall attendance, attendance by year level
(2016 on), average class size, School Opinion Survey items (parents/caregivers, students, staff)
and school disciplinary absences. Catholic and Independent schools publish their own reports in
their own formats, so they're not included.

The template has changed over time:
  2010–2012  single-year "% satisfied" measures and class size targets: not used
  2013–2019  survey items in older wording tagged with item codes (S2035 ...), matched to today's
             wording by code; notes printed between a table's header and its rows; no Total row
             for suspensions; short suspensions were 1–5 days before 2017 (now 1–10)
  2020–      today's wording; 2020's surveys weren't run (COVID), so those columns are left out

Source: State of Queensland (Department of Education), school annual reports. Department
websites are licensed CC BY 4.0 (https://qed.qld.gov.au/copyright-statement).
"""
import json
import re
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw" / "annual"
DATA = ROOT / "data"

REPORT_YEAR = 2025  # the newest report
REPORT_YEARS = range(2013, REPORT_YEAR + 1)
YEARS_OUT = list(range(2013, REPORT_YEAR + 1))
USER_AGENT = "seq-schools-explorer data build (https://github.com/amparaj)"
DELAY = 0.5  # seconds between downloads per worker; these are school websites
WORKERS = 4
MISSING = RAW / "missing.json"  # {host: [years]} that returned 404, so reruns skip them

# A table cell: a percentage, a count, or one of the template's "not available" markers.
VALUE = re.compile(r"^(?:\d+(?:\.\d+)?%?|<5|–|-|—|DW|N/?A)$")
YEAR = re.compile(r"^(20\d\d)(\*+)?$")
SURVEYS = {
    "parent": re.compile(r"^Percentage of parents?/caregivers who agree"),
    "student": re.compile(r"^Percentage of students who agree"),
    "staff": re.compile(r"^Percentage of (?:school )?staff who agree"),
}
# Today's survey items, in order, with the item codes the 2013–2019 reports tag them with.
SURVEY_ITEMS = {
    "parent": {
        "S2035": "This is a good school.",
        "S2001": "My child likes being at this school.",
        "S2002": "My child feels safe at this school.",
        "S2003": "My child's learning needs are being met at this school.",
        "S2004": "My child is making good progress at this school.",
        "S2005": "Teachers at this school expect my child to do their best.",
        "S2006": "Teachers at this school provide my child with useful feedback about their schoolwork.",
        "S2007": "Teachers at this school motivate my child to learn.",
        "S2008": "Teachers at this school treat students fairly.",
        "S2009": "I can talk to my child's teachers about my concerns.",
        "S2010": "This school works with me to support my child's learning.",
        "S2011": "This school takes parents' opinions seriously.",
        "S2012": "Student behaviour is well managed at this school.",
        "S2013": "This school looks for ways to improve.",
        "S2014": "This school is well maintained.",
    },
    "student": {
        "S2036": "I like being at my school.",
        "S2037": "I feel safe at my school.",
        "S2038": "My teachers motivate me to learn.",
        "S2039": "My teachers expect me to do my best.",
        "S2040": "My teachers provide me with useful feedback about my schoolwork.",
        "S2041": "Teachers at my school treat students fairly.",
        "S2042": "I can talk to my teachers about my concerns.",
        "S2043": "My school takes students' opinions seriously.",
        "S2044": "Student behaviour is well managed at my school.",
        "S2045": "My school looks for ways to improve.",
        "S2046": "My school is well maintained.",
        "S2047": "My school gives me opportunities to do interesting things.",
    },
    "staff": {
        "S2114": "I feel confident embedding Aboriginal and Torres Strait Islander perspectives across the learning areas.",
        "S2069": "I enjoy working at this school.",
        "S2070": "I feel this school is a safe place in which to work.",
        "S2071": "I receive useful feedback about my work at this school.",
        "S2072": "Students are encouraged to do their best at this school.",
        "S2073": "Students are treated fairly at this school.",
        "S2074": "Student behaviour is well managed at this school.",
        "S2075": "Staff are well supported at this school.",
        "S2076": "This school takes staff opinions seriously.",
        "S2077": "This school looks for ways to improve.",
        "S2078": "This school is well maintained.",
    },
}
SDA_KEYS = (("short susp", "short"), ("long susp", "long"), ("exclusion", "excl"), ("cancellation", "canc"), ("total", "total"))


def schools():
    data = json.loads((DATA / "schools.json").read_text(encoding="utf-8"))
    out = []
    for s in data["schools"]:
        m = re.match(r"^https?://([a-z0-9-]+\.eq\.edu\.au)", s.get("url") or "", re.I)
        if s["sector"] == "Government" and m:
            out.append((s, m.group(1).lower()))
    return out


def pdf_path(host, year):
    return RAW / f"{host.split('.')[0]}-{year}.pdf"


def download(host, year):
    """Save one report; return None on success, "missing" for a 404, or an error string."""
    url = f"https://{host}/supportandresources/formsanddocuments/annualreports/annual-report-{year}.pdf"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt == 0:
                time.sleep(60)  # the server asked us to slow down; try once more
                continue
            return "missing" if e.code == 404 else f"HTTP {e.code}"
        except (urllib.error.URLError, TimeoutError) as e:
            return str(e)
    if not body.startswith(b"%PDF"):
        return "missing"
    pdf_path(host, year).write_bytes(body)
    return None


def fetch_all(hosts):
    """Download every report not already in raw/annual/ or known to be missing."""
    missing = json.loads(MISSING.read_text()) if MISSING.exists() else {}
    todo = [(h, y) for h in hosts for y in REPORT_YEARS if not pdf_path(h, y).exists() and y not in missing.get(h, [])]
    print(f"  {len(todo)} reports to try")
    lock, done, errors = threading.Lock(), [0], []

    def one(job):
        host, year = job
        err = download(host, year)
        time.sleep(DELAY)
        with lock:
            done[0] += 1
            if err == "missing":
                missing.setdefault(host, []).append(year)
            elif err:
                errors.append((host, f"{year}: {err}"))
            if done[0] % 250 == 0:
                print(f"  {done[0]}/{len(todo)}")
                MISSING.write_text(json.dumps(missing))

    with ThreadPoolExecutor(WORKERS) as pool:
        list(pool.map(one, todo))
    MISSING.write_text(json.dumps(missing))
    return errors


def num(cell):
    """'86.3%' -> 86.3, '22' -> 22, anything suppressed -> None."""
    m = re.match(r"^(\d+(?:\.\d+)?)%?$", cell)
    if not m:
        return None
    v = float(m.group(1))
    return int(v) if v.is_integer() else v


def clean(text):
    """Normalise a row label: ligatures, bullets, whitespace, footnote marks, and the change
    column a few schools add ("Increase", "+13.4%"), which lands at the start of the next label."""
    text = unicodedata.normalize("NFKC", re.sub(r"\s+", " ", text)).strip()
    text = re.sub(r"^[^\w(]+", "", text)
    text = re.sub(r"[¹²³⁴*]+$", "", text)
    text = re.sub(r"^(?:(?:Increase|Decrease|[+-]\d+(?:\.\d+)?%)\s+)+", "", text)
    return text.strip()


def lines_of(pdf):
    doc = pymupdf.open(pdf)
    out = []
    for page in doc:
        out += [ln.strip() for ln in page.get_text().splitlines()]
    return [ln for ln in out if ln]


# Once a table has rows, it ends at its notes or where the next table or section starts.
STOP = ("Note", "Table ", "Type of school", "Description", "Percentage of", "School disciplinary")


def header(lines, i):
    """The run of year headers at or after line i: [(year, starred)], and the line after them.

    In today's template a starred year ("2023*") means "data not available", and the report may
    give it a column of DW/– markers or leave the column out, so rows() checks how many values
    each row has. In older reports a star is just a footnote.
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
    """[(label, {year: value})] from line i to the end of the table.

    A label may run over several lines; its values follow, one per column. Notes printed
    before the first row are skipped: a line ending a sentence starts a new label.
    """
    every = [y for y, _ in hdr]
    shown = [y for y, star in hdr if not star]
    out, label, start = [], [], i
    while i < len(lines) and not YEAR.match(lines[i]):
        if out and lines[i].startswith(STOP):
            break
        if not out and i - start > 40:
            break  # no rows: an empty table
        if label and VALUE.match(lines[i]):
            n = 0
            while i + n < len(lines) and n < len(every) and VALUE.match(lines[i + n]):
                n += 1
            if n == len(every):
                cols = every
            elif n == len(shown):
                cols = shown
            elif n == len(every) - 1 and 2020 in every:
                cols = [y for y in every if y != 2020]  # 2020 surveys weren't run
            else:
                cols = None
            if cols:
                out.append((clean(" ".join(label)), dict(zip(cols, (num(v) for v in lines[i:i + n])))))
            label = []
            i += n
            continue
        if label and label[-1].endswith((".", ":")):
            label = []
        label.append(lines[i])
        i += 1
    return out


def tables(lines, anchor):
    """Rows of every table whose title or lead line matches the `anchor` regex (surveys can
    restart their header on a new page)."""
    out = []
    for k, ln in enumerate(lines):
        if anchor.match(ln):
            hdr, j = header(lines, k + 1)
            if hdr:
                out += rows(lines, j, hdr)
    return out


def table(lines, anchor):
    """Rows of the first table matching `anchor` that has any."""
    for k, ln in enumerate(lines):
        if anchor.match(ln):
            hdr, j = header(lines, k + 1)
            got = rows(lines, j, hdr) if hdr else []
            if got:
                return got
    return []


def labelled_row(lines, pattern):
    """A single row found by its label, with the year header just above it."""
    for k, ln in enumerate(lines):
        if not pattern.match(ln):
            continue
        before = lines[max(0, k - 15):k]
        ends = [j for j in range(len(before)) if YEAR.match(before[j])]
        if not ends:
            continue
        j = ends[-1]
        while j > 0 and YEAR.match(before[j - 1]):
            j -= 1
        hdr, _ = header(before, j)
        got = rows(lines, k, hdr)
        if got and pattern.match(got[0][0]):
            return got[0][1]
    return None


def sig(text):
    return re.sub(r"[^a-z]", "", text.lower().replace("his or her", "their"))


SURVEY_SIGS = {key: {sig(q): q for q in items.values()} for key, items in SURVEY_ITEMS.items()}


def survey_label(key, label):
    code = re.search(r"\((S\d{4})\)", label)
    if code:
        return SURVEY_ITEMS[key].get(code.group(1))
    return SURVEY_SIGS[key].get(sig(label))


PHASE = re.compile(r"(?:Prep|Year \d+) – Year \d+")


def phase(label):
    """'Year 4 - Year 7 Primary' -> 'Year 4 – Year 7'; 'Year 7 Secondary – Year 10' -> 'Year 7 – Year 10'.

    Phases a school doesn't teach have no values, so their labels run into the next one
    ('Prep – Year 3 Year 4 – Year 7 Year 8 – Year 10'): the values belong to the last.
    Anything that isn't made only of phases (another table caught by mistake) gives None.
    """
    label = re.sub(r"\s*[-–±]\s*", " – ", label)
    label = re.sub(r" (?:Primary|Secondary)\b", "", label)
    found = PHASE.findall(label)
    return found[-1] if found and not PHASE.sub("", label).strip() else None


ATT_OVERALL = re.compile(r"^(?:The )?overall attendance rate\*? for (?:the )?students", re.I)
ATT_LEVELS = re.compile(r"^Table \d+: (?:Average )?student attendance rates for each year level", re.I)
CLASS = re.compile(r"^(?:Table \d+: )?Average class size", re.I)
SDA = re.compile(r"^(?:Type of school disciplinary|Disciplinary Absences$|SCHOOL DISCIPLINARY ABSENCES$)")


def parse(pdf):
    """(title, {measure: ...}) with every series as {year: value}."""
    lines = lines_of(pdf)
    rec = {}
    title = lines[3] if len(lines) > 3 else ""

    for key, anchor in SURVEYS.items():
        items = {}
        for lbl, vals in tables(lines, anchor):
            q = survey_label(key, lbl)
            if q and q not in items:
                items[q] = vals
        if items:
            rec.setdefault("sos", {})[key] = items

    att = labelled_row(lines, ATT_OVERALL)
    if att:
        rec["att"] = att
    rec["attYr"] = {("Prep Year" if y == "Prep" else y): v for y, v in table(lines, ATT_LEVELS) if re.fullmatch(r"Prep(?: Year)?|Year \d+", y)}
    rec["cls"] = {phase(y): v for y, v in table(lines, CLASS) if phase(y) and any(x is not None for x in v.values())}
    sda = {}
    for lbl, v in table(lines, SDA):
        key = next((k for prefix, k in SDA_KEYS if lbl.lower().startswith(prefix)), None)
        if key and key not in sda:
            sda[key] = v
    if sda and "total" not in sda:
        years = {y for v in sda.values() for y in v}
        sda["total"] = {y: sum(v.get(y) or 0 for v in sda.values()) for y in years
                        if any(v.get(y) is not None for v in sda.values())}
    rec["sda"] = sda
    return title, {k: v for k, v in rec.items() if v}


def merge(reports):
    """Combine one school's reports, newest first: each year's value comes from the newest
    report that has it. Returns the record in the output's layout, aligned to YEARS_OUT."""
    def series(get):
        out = [None] * len(YEARS_OUT)
        for rec in reports:
            for y, v in (get(rec) or {}).items():
                if y in YEARS_OUT and v is not None and out[YEARS_OUT.index(y)] is None:
                    out[YEARS_OUT.index(y)] = v
        return out if any(v is not None for v in out) else None

    def labelled(get):
        labels = []
        for rec in reports:
            labels += [k for k in (get(rec) or {}) if k not in labels]
        pairs = [[k, series(lambda r: (get(r) or {}).get(k))] for k in labels]
        return [p for p in pairs if p[1]]

    out = {}
    if (att := series(lambda r: r.get("att"))):
        out["att"] = att
    if (lv := labelled(lambda r: r.get("attYr"))):
        out["attYr"] = lv
    if (cls := labelled(lambda r: r.get("cls"))):
        out["cls"] = cls
    sda = {key: s for _, key in SDA_KEYS if (s := series(lambda r: r.get("sda", {}).get(key)))}
    if sda:
        out["sda"] = sda
    sos = {}
    for key, items in SURVEY_ITEMS.items():
        vals = [series(lambda r: r.get("sos", {}).get(key, {}).get(q)) for q in items.values()]
        if any(vals):
            sos[key] = vals  # aligned to the top-level "items" list
    if sos:
        out["sos"] = sos
    return out


def norm(name):
    return re.sub(r"[^a-z0-9]+", " ", name.lower().replace("&", "and")).strip()


def main():
    verbose = "-v" in sys.argv
    RAW.mkdir(parents=True, exist_ok=True)
    targets = schools()
    by_host = {}
    for s, host in targets:
        by_host.setdefault(host, []).append(s)

    failed = []
    if "--no-download" not in sys.argv:
        failed += fetch_all(sorted(by_host))

    out, counts = {}, {}
    for host, group in sorted(by_host.items()):
        reports, title = [], None
        for year in sorted(REPORT_YEARS, reverse=True):
            pdf = pdf_path(host, year)
            if not pdf.exists():
                continue
            try:
                t, rec = parse(pdf)
            except Exception as e:  # noqa: BLE001
                failed.append((host, f"{year}: parse error: {e}"))
                continue
            if not rec.get("sos") and not rec.get("att"):
                failed.append((host, f"{year}: no tables found"))
                continue
            reports.append(rec)
            title = title or t
            counts[year] = counts.get(year, 0) + 1
        if not reports:
            failed.append((host, "no usable reports"))
            continue
        rec = merge(reports)
        # Campuses can share a website; give the reports only to the school the newest one names.
        named = [s for s in group if norm(s["name"]) == norm(title)]
        for s in named or group[:1]:
            out[str(s["id"])] = rec

    DATA.mkdir(exist_ok=True)
    meta = {
        "reportYear": REPORT_YEAR,
        "years": YEARS_OUT,
        "items": {key: list(items.values()) for key, items in SURVEY_ITEMS.items()},
        "source": "State of Queensland (Department of Education) school annual reports, CC BY 4.0",
    }
    (DATA / "annual.json").write_text(json.dumps({**meta, "schools": out}, separators=(",", ":")), encoding="utf-8")
    print(f"wrote data/annual.json: {len(out)} schools; reports parsed per year: "
          + ", ".join(f"{y} {counts.get(y, 0)}" for y in REPORT_YEARS))
    print(f"{len(failed)} problems (-v to list)")
    if verbose:
        for host, err in failed:
            print(f"  {host}: {err}")


if __name__ == "__main__":
    main()

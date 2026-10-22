#!/usr/bin/env python3
"""
Weekly updater for Price Watch Pakistan.

Downloads the Pakistan Bureau of Statistics (PBS) weekly SPI report(s) published
since the last PBS date in data/price-history.json, extracts the 37 tracked
essentials, and appends new rows (current week + previous week if missing).

Safe by design: if a report can't be parsed cleanly, the script exits with an
error and writes nothing, so bad data never reaches the live site.

Usage:
  python scripts/update_spi.py                 # fetch from PBS
  python scripts/update_spi.py --text FILE --date YYYY-MM-DD   # parse local text (testing)
"""
import argparse
import datetime as dt
import hashlib
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILES = [ROOT / "data" / "price-history.json", ROOT / "public" / "data" / "price-history.json"]

PDF_URL = "https://www.pbs.gov.pk/wp-content/uploads/2020/07/Executive-Summary-SPI-Report_{d}.pdf"
SOURCE_NAME = "Pakistan Bureau of Statistics"

# (site good name, regex anchor in the PBS table, divisor to convert to site unit,
#  site unit, category, priority)
ITEMS = [
    ("Atta / Wheat Flour", r"Wheat Flour", 20, "kg", "Staples", 1),
    ("Petrol", r"Petrol Super", 1, "litre", "Fuel", 2),
    ("Diesel", r"Hi-?Speed Diesel", 1, "litre", "Fuel", 3),
    ("Milk", r"Milk fresh", 1, "litre", "Meat & Dairy", 4),
    ("Chicken Broiler Live", r"Chicken Farm Broiler", 1, "kg", "Meat & Dairy", 6),
    ("Eggs", r"Eggs Hen", 1, "dozen", "Meat & Dairy", 7),
    ("Sugar", r"Sugar Refined", 1, "kg", "Staples", 8),
    ("Cooking Oil", r"Cooking Oil", 5, "litre", "Staples", 9),
    ("Ghee", r"Vegetable Ghee DALDA/HABIB or Other", 1, "kg", "Staples", 10),
    ("Basmati Rice Broken", r"Rice Basmati Broken", 1, "kg", "Staples", 12),
    ("Rice IRRI", r"Rice IRRI", 1, "kg", "Staples", 13),
    ("Potatoes", r"Potatoes", 1, "kg", "Vegetables", 14),
    ("Onions", r"Onions", 1, "kg", "Vegetables", 15),
    ("Tomatoes", r"Tomatoes", 1, "kg", "Vegetables", 16),
    ("Garlic", r"Garlic", 1, "kg", "Vegetables", 17),
    ("Pulse Gram", r"Pulse Gram", 1, "kg", "Staples", 21),
    ("Pulse Masoor", r"Pulse Masoor", 1, "kg", "Staples", 22),
    ("Pulse Moong", r"Pulse Moong", 1, "kg", "Staples", 23),
    ("Pulse Mash", r"Pulse Mash", 1, "kg", "Staples", 24),
    ("Mutton", r"Mutton", 1, "kg", "Meat & Dairy", 26),
    ("Bread", r"Bread plain", 1, "piece", "Staples", 27),
    ("Tea", r"Tea Lipton", 1, "190g packet", "Staples", 28),
    ("Toilet Soap", r"Toilet Soap", 1, "115g cake", "Household", 29),
    ("Washing Soap", r"Sufi Washing Soap", 1, "250g cake", "Household", 30),
    ("LPG Cylinder", r"LPG 11\.67", 1, "11.67 kg cylinder", "Fuel", 31),
    ("Firewood", r"Firewood", 1, "40kg bundle", "Household", 500),
    ("Match Box", r"Match Box", 1, "piece", "Household", 500),
    ("Beef with Bone", r"Beef with Bone", 1, "kg", "Meat & Dairy", 500),
    ("Curd / Dahi", r"Curd \(Dahi\)", 1, "kg", "Meat & Dairy", 500),
    ("Powdered Milk NIDO", r"Powdered Milk NIDO", 1, "390g pack", "Meat & Dairy", 500),
    ("Electricity Charges Q1", r"Electricity Charges", 1, "unit", "Misc", 500),
    ("Gas Charges Q1", r"Gas Charges", 1, "MMBTU", "Misc", 500),
    ("Chilies Powder", r"Chilies Powder", 1, "200g packet", "Staples", 500),
    # "Vegetable Ghee DALDA/HABIB 2.5 kg Tin" — the other ghee line contains "or Other",
    # so require the tin size right after the brand.
    ("Ghee Tin", r"Vegetable Ghee DALDA/HABIB\s+2\.5", 2.5, "kg", "Staples", 500),
    ("Gur", r"Gur \(", 1, "kg", "Staples", 500),
    ("Mustard Oil", r"Mustard Oil", 1, "kg", "Staples", 500),
    ("Salt Powdered", r"Salt Powdered", 1, "800g packet", "Staples", 500),
    ("Bananas", r"Bananas", 1, "dozen", "Fruits", 500),
]

MIN_MATCHED = 32          # refuse to write if fewer items parse
MAX_WEEKLY_SWING = 0.5    # current vs previous week in the same report (50%)
NUM = re.compile(r"^-?\d[\d,]*(?:\.\d+)?$")


def log(*a):
    print(*a, file=sys.stderr)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (PriceWatchPK updater)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def pdf_text(data):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


def parse_report(text):
    """Return {good: (current, previous_week)} in site units, or raise."""
    flat = re.sub(r"\s+", " ", text)
    out = {}
    for good, anchor, div, *_ in ITEMS:
        run = None
        # The item name can also appear in the summary prose; accept only an
        # occurrence where a row of >= 7 numbers starts within a few words
        # (the rest of the name + unit), i.e. an actual table row.
        for m in re.finditer(anchor, flat, re.IGNORECASE):
            tokens = flat[m.end():].strip().split(" ")
            for start in range(0, 14):
                window = tokens[start:start + 7]
                if len(window) == 7 and all(NUM.match(t) for t in window):
                    run = [float(t.replace(",", "")) for t in window]
                    break
            if run:
                break
        if not run:
            log(f"  ! not found: {good}")
            continue
        cur, prev = run[0] / div, run[1] / div
        if cur <= 0 or prev <= 0 or abs(cur / prev - 1) > MAX_WEEKLY_SWING:
            log(f"  ! implausible: {good} {cur} vs {prev}")
            continue
        out[good] = (round(cur, 2), round(prev, 2))
    if len(out) < MIN_MATCHED:
        raise ValueError(f"Only {len(out)}/{len(ITEMS)} items parsed — report format may have changed")
    return out


def find_report_dates(text):
    """Report header lists the current and previous week dates, e.g. '15.10.26 08.10.26'."""
    m = re.search(r"(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2})\.(\d{2})\.(\d{2})", text)
    if not m:
        return None
    a = dt.date(2000 + int(m[3]), int(m[2]), int(m[1]))
    b = dt.date(2000 + int(m[6]), int(m[5]), int(m[4]))
    return a, b


def make_row(good, price, date, report_date, url):
    meta = next(i for i in ITEMS if i[0] == good)
    _, _, _, unit, category, priority = meta
    rd = report_date.strftime("%d.%m.%Y")
    return {
        "id": hashlib.sha1(f"pbs|{good}|{date}".encode()).hexdigest()[:16],
        "good": good,
        "urdu": "",
        "category": category,
        "unit": unit,
        "price": price,
        "date": date.isoformat(),
        "sourceType": "government",
        "sourceName": SOURCE_NAME,
        "sourceUrl": url,
        "sourceDocument": f"Executive-Summary-SPI-Report_{rd}.pdf",
        "sourceLine": f"PBS SPI Report {rd} comparative item prices (auto-imported).",
        "note": "",
        "priority": priority,
    }


def merge(rows, parsed, cur_date, prev_date, report_date, url):
    have = {(r["good"], r["date"]) for r in rows if r.get("sourceName") == SOURCE_NAME}
    # sanity: our stored previous-week price should match this report's previous-week column
    for r in rows:
        if r.get("sourceName") == SOURCE_NAME and r["date"] == prev_date.isoformat() and r["good"] in parsed:
            p = parsed[r["good"]][1]
            if abs(p / r["price"] - 1) > 0.05:
                raise ValueError(f"{r['good']}: stored {r['date']} price {r['price']} vs report {p} — mis-parse?")
    added = 0
    for good, (cur, prev) in parsed.items():
        for date, price in ((cur_date, cur), (prev_date, prev)):
            if (good, date.isoformat()) not in have:
                rows.append(make_row(good, price, date, report_date, url))
                have.add((good, date.isoformat()))
                added += 1
    return added


def candidate_reports(last_date, today):
    """Yield (report_date, url) for weekly reports after last_date. PBS reports are
    usually dated Thursday; try nearby days to cover holiday shifts."""
    d = last_date + dt.timedelta(days=7)
    while d <= today:
        for off in (0, -1, 1, -2, 2):
            cand = d + dt.timedelta(days=off)
            if cand <= last_date or cand > today:
                continue
            yield d, cand
        d += dt.timedelta(days=7)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", help="parse a local text file instead of downloading")
    ap.add_argument("--date", help="report date for --text (YYYY-MM-DD)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = json.loads(DATA_FILES[0].read_text(encoding="utf-8"))
    pbs_dates = sorted({r["date"] for r in rows if r.get("sourceName") == SOURCE_NAME})
    last = dt.date.fromisoformat(pbs_dates[-1])
    total = 0

    if args.text:
        rd = dt.date.fromisoformat(args.date)
        text = Path(args.text).read_text(encoding="utf-8")
        parsed = parse_report(text)
        total += merge(rows, parsed, rd, rd - dt.timedelta(days=7), rd, "local-test")
    else:
        today = dt.date.today()
        done_slots = set()
        for slot, cand in candidate_reports(last, today):
            if slot in done_slots:
                continue
            url = PDF_URL.format(d=cand.strftime("%d.%m.%Y"))
            try:
                data = fetch(url)
            except Exception as e:
                continue
            if not data.startswith(b"%PDF"):
                continue
            log(f"Found report {cand}: {url}")
            text = pdf_text(data)
            dates = find_report_dates(text)
            cur_date, prev_date = dates if dates else (cand, cand - dt.timedelta(days=7))
            parsed = parse_report(text)  # raises -> workflow fails, nothing written
            n = merge(rows, parsed, cur_date, prev_date, cand, url)
            log(f"  parsed {len(parsed)} items, added {n} rows")
            total += n
            done_slots.add(slot)

    if total == 0:
        log("No new PBS data.")
        return
    rows.sort(key=lambda r: (r["date"], r.get("priority", 500), r["good"]))
    if args.dry_run:
        log(f"Dry run: would add {total} rows")
        return
    out = json.dumps(rows, indent=2, ensure_ascii=False) + "\n"
    for f in DATA_FILES:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(out, encoding="utf-8")
    log(f"Added {total} rows.")


if __name__ == "__main__":
    main()

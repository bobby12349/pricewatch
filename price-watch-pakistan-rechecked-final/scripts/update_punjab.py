#!/usr/bin/env python3
"""
Weekly importer for the Lahore (Punjab) official fruit, vegetable and poultry
rate lists. The lists are published only as photos of printed Urdu rate sheets,
so each sheet is read by Claude (vision) and the result is checked before saving.

- Takes the newest sheet of each list (fruits, vegetables, poultry) that isn't
  imported yet.
- Uses the first-grade (اول) retail price, as the existing data does.
- Skips any list whose reading looks wrong; never writes partial garbage.
- Needs ANTHROPIC_API_KEY; without it the script exits quietly.
"""
import base64
import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILES = [ROOT / "data" / "price-history.json", ROOT / "public" / "data" / "price-history.json"]
NAMES_FILE = ROOT / "data" / "punjab-names.json"   # Urdu -> English name memory
BASE = "https://lahore.punjab.gov.pk"
SOURCE = "Punjab Official Rate List"
MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5")

LISTS = {
    "Vegetables": ("/vegetables-rate-list", "Vegetables"),
    "Fruits": ("/fruits-rate-list", "Fruits"),
    "Poultry": ("/poultry-rate-list", "Poultry"),
}
# Goods the weekly PBS import already covers; the Lahore readings of these
# would mix two different price series, so they are skipped.
PBS_GOODS = {"Onions", "Tomatoes", "Eggs"}
UNITS = {"kg", "dozen", "piece", "crate"}


def log(*a):
    print(*a, file=sys.stderr)


def fetch(url, data=None, headers=None, timeout=90):
    h = {"User-Agent": "Mozilla/5.0 (PriceWatchPK updater)"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def latest_sheet(path):
    """Return (date, absolute image url) for the newest row of a rate-list page."""
    page = fetch(BASE + path).decode("utf-8", "replace")
    rows = re.findall(r'<time datetime="(\d{4}-\d{2}-\d{2})[^"]*".*?<a href="([^"]+)"', page, re.S)
    if not rows:
        raise ValueError(f"no rows found on {path}")
    rows.sort(reverse=True)
    d, href = rows[0]
    return dt.date.fromisoformat(d), BASE + html.unescape(href)


def norm_ur(s):
    return re.sub(r"[\s‌‍ً-ٟ()\-/.]+", "", s or "")


def ask_claude(img, known, list_name):
    known_txt = "\n".join(f"- {g} | {u} | {ur}" for g, u, ur in known)
    prompt = f"""This photo is an official Lahore government retail rate sheet ({list_name}), printed in Urdu.
Read every item row. For each item give the FIRST-grade (اول) retail price. If an item has no first-grade price ("-" or blank) use the second-grade (دوم) price; if both are missing, skip the item.

Known items (English name | unit | Urdu name). If a row is one of these, use that exact English name and unit:
{known_txt}

For an item not in the list, give a short, plain English name in Title Case (e.g. "Guava", "Orange Kinnow") and its unit.
Units must be one of: kg, dozen, piece, crate.

Also read the sheet's printed date.

Reply with JSON only, no other text:
{{"sheet_date": "YYYY-MM-DD", "items": [{{"good": "...", "urdu": "<Urdu name as printed>", "unit": "kg", "price": 123}}]}}"""
    body = {
        "model": MODEL,
        "max_tokens": 4000,
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                         "data": base64.b64encode(img).decode()}},
            {"type": "text", "text": prompt},
        ]}],
    }
    raw = fetch("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(), headers={
        "x-api-key": os.environ["ANTHROPIC_API_KEY"],
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }, timeout=180)
    text = "".join(b.get("text", "") for b in json.loads(raw)["content"])
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("model reply had no JSON")
    return json.loads(m.group(0))


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        log("ANTHROPIC_API_KEY not set — skipping Lahore rate lists.")
        return
    rows = json.loads(DATA_FILES[0].read_text(encoding="utf-8"))
    names = json.loads(NAMES_FILE.read_text(encoding="utf-8")) if NAMES_FILE.exists() else {}
    punjab = [r for r in rows if r.get("sourceName") == SOURCE]
    total = 0

    for list_name, (path, category) in LISTS.items():
        try:
            sheet_date, img_url = latest_sheet(path)
        except Exception as e:
            log(f"[{list_name}] could not read list page: {e}")
            continue
        mine = [r for r in punjab if r["category"] == category]
        last_date = max((r["date"] for r in mine), default="")
        if sheet_date.isoformat() <= last_date:
            log(f"[{list_name}] latest sheet {sheet_date} already imported")
            continue

        # last known price/unit/urdu per good in this list
        latest = {}
        for r in sorted(mine, key=lambda r: r["date"]):
            latest[r["good"]] = r
        known = [(g, r["unit"], r.get("urdu") or "") for g, r in sorted(latest.items())]
        known += [(en, "kg", ur) for ur, en in names.items() if en not in latest]

        try:
            img = fetch(img_url)
            res = ask_claude(img, known, list_name)
        except Exception as e:
            log(f"[{list_name}] reading failed: {e}")
            continue

        accepted, rejected = [], []
        for it in res.get("items", []):
            try:
                good = str(it["good"]).strip()
                urdu = str(it.get("urdu", "")).strip()
                unit = str(it.get("unit", "kg")).strip().lower()
                price = float(it["price"])
            except (KeyError, TypeError, ValueError):
                continue
            # stable naming: an Urdu name seen before keeps its English name
            key = norm_ur(urdu)
            if key and key in names and good not in latest:
                good = names[key]
            if good in PBS_GOODS:
                continue
            if unit not in UNITS or not (1 <= price <= 20000):
                rejected.append((good, price, "unit/range")); continue
            prev = latest.get(good)
            if prev:
                unit = prev["unit"]
                ratio = price / prev["price"]
                if not (0.25 <= ratio <= 4):
                    rejected.append((good, price, f"vs last {prev['price']}")); continue
            accepted.append((good, urdu, unit, price))
            if key and key not in names:
                names[key] = good

        if len(accepted) < 8 or len(rejected) > max(3, len(accepted) // 4):
            log(f"[{list_name}] reading looks unreliable ({len(accepted)} ok, {len(rejected)} rejected) — skipped")
            for r in rejected:
                log("   rejected:", r)
            continue

        printed = res.get("sheet_date", "")
        if printed and printed != sheet_date.isoformat():
            log(f"[{list_name}] note: sheet prints {printed}, site lists {sheet_date}; using site date")

        d = sheet_date.isoformat()
        nice = sheet_date.strftime("%d-%m-%Y")
        seen = set()
        for good, urdu, unit, price in accepted:
            if good in seen:
                continue
            seen.add(good)
            prev = latest.get(good)
            rows.append({
                "id": hashlib.sha1(f"punjab|{good}|{d}".encode()).hexdigest()[:16],
                "good": good,
                "urdu": urdu or (prev or {}).get("urdu", ""),
                "category": category,
                "unit": unit,
                "price": round(price, 2),
                "date": d,
                "sourceType": "government",
                "sourceName": SOURCE,
                "sourceUrl": BASE + path,
                "sourceDocument": f"Official {list_name.lower()} retail rate-list image dated {nice}",
                "sourceLine": f"Lahore {list_name.lower()} rate list {nice}; first-grade retail price read automatically from the official image ({img_url}).",
                "note": f"Urdu item: {urdu}" if urdu else "",
                "priority": (prev or {}).get("priority", 500),
            })
        total += len(seen)
        log(f"[{list_name}] {d}: added {len(seen)} prices ({len(rejected)} rejected)")
        for r in rejected:
            log("   rejected:", r)

    if not total:
        log("No new Lahore prices.")
        return
    rows.sort(key=lambda r: (r["date"], r.get("priority", 500), r["good"]))
    out = json.dumps(rows, indent=2, ensure_ascii=False) + "\n"
    for f in DATA_FILES:
        f.write_text(out, encoding="utf-8")
    NAMES_FILE.write_text(json.dumps(names, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    log(f"Added {total} Lahore prices.")


if __name__ == "__main__":
    main()

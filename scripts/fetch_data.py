#!/usr/bin/env python3
"""株価（Yahoo!ファイナンス）とニュース（Googleニュース RSS）を取得し、data/ に積み上げる。

標準ライブラリのみ。取得に失敗した項目は既存データを残して続行する。
"""
import hashlib
import json
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
JST = timezone(timedelta(hours=9))
UA = {"User-Agent": "Mozilla/5.0 (kabu-note; learning use)"}
KEEP_NEWS_DAYS = 800


def http_get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read()


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def now_jst():
    return datetime.now(JST).strftime("%Y-%m-%dT%H:%M")


def fetch_prices(symbol, rng):
    url = "https://query1.finance.yahoo.com/v8/finance/chart/%s?range=%s&interval=1d" % (
        urllib.parse.quote(symbol), rng)
    result = json.loads(http_get(url))["chart"]["result"][0]
    closes = result["indicators"]["quote"][0]["close"]
    out = {}
    for ts, close in zip(result["timestamp"], closes):
        if close is None:
            continue
        day = datetime.fromtimestamp(ts, JST).strftime("%Y-%m-%d")
        out[day] = round(close, 2)
    return out


def update_prices(symbol, path):
    old = load_json(path, {"series": []})
    merged = {d: v for d, v in old["series"]}
    rng = "10d" if merged else "2y"
    merged.update(fetch_prices(symbol, rng))
    save_json(path, {
        "symbol": symbol,
        "updated": now_jst(),
        "series": sorted([d, v] for d, v in merged.items()),
    })
    print("prices ok:", symbol, len(merged))


def fetch_news(query, kind, when):
    q = "%s when:%s" % (query, when)
    url = "https://news.google.com/rss/search?q=%s&hl=ja&gl=JP&ceid=JP:ja" % urllib.parse.quote(q)
    root = ET.fromstring(http_get(url))
    items = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        src = (it.findtext("source") or "").strip()
        pub = it.findtext("pubDate")
        if not (title and link and pub):
            continue
        if src and title.endswith(" - " + src):
            title = title[: -len(" - " + src)]
        published = parsedate_to_datetime(pub).astimezone(JST).strftime("%Y-%m-%dT%H:%M")
        items.append({
            "id": hashlib.sha1(link.encode()).hexdigest()[:12],
            "title": title,
            "source": src,
            "link": link,
            "published": published,
            "kind": kind,
            "q": query,
        })
    return items


def update_news(queries, path):
    old = load_json(path, {"items": []})
    merged = {i["id"]: i for i in old["items"]}
    when = "14d" if merged else "60d"
    ok = False
    for spec in queries:
        try:
            for item in fetch_news(spec["q"], spec["kind"], when):
                merged.setdefault(item["id"], item)
            ok = True
        except Exception as e:  # noqa: BLE001 - 1件の失敗で全体を止めない
            print("news failed:", spec["q"], e, file=sys.stderr)
    cutoff = (datetime.now(JST) - timedelta(days=KEEP_NEWS_DAYS)).strftime("%Y-%m-%dT%H:%M")
    items = sorted((i for i in merged.values() if i["published"] >= cutoff),
                   key=lambda i: i["published"], reverse=True)
    if ok:
        save_json(path, {"updated": now_jst(), "items": items})
        print("news ok:", path.name, len(items))


def main():
    cfg = load_json(DATA / "config.json", None)
    if not cfg:
        sys.exit("data/config.json が読めません")
    failures = 0
    jobs = [(s["symbol"], DATA / "prices" / (s["code"] + ".json")) for s in cfg["stocks"]]
    jobs += [(i["symbol"], DATA / "prices" / (i["key"] + ".json")) for i in cfg["market"]["indices"]]
    for symbol, path in jobs:
        try:
            update_prices(symbol, path)
        except Exception as e:  # noqa: BLE001
            failures += 1
            print("prices failed:", symbol, e, file=sys.stderr)
    for s in cfg["stocks"]:
        update_news(s["queries"], DATA / "news" / (s["code"] + ".json"))
    update_news(cfg["market"]["queries"], DATA / "news" / "market.json")
    if failures == len(jobs):
        sys.exit("株価をひとつも取得できませんでした")


if __name__ == "__main__":
    main()

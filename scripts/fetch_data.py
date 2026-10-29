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


def drop_spikes(series, jump=2.5, back=1.43, look=5):
    """無料の株価データには、桁がずれた値（例：380 が 37.6）が数日だけ混ざることがある。
    前の値から 2.5倍以上／2.5分の1以下に飛び、数日以内に元の水準（±30%）へ戻る点を取り除く。
    戻らない大きな変化（本当の急落や、調整されていない株式分割）は残す。"""
    out, dropped, i = [], [], 0
    while i < len(series):
        if out:
            prev = out[-1][1]
            ratio = series[i][1] / prev if prev else 1
            if ratio >= jump or ratio <= 1 / jump:
                back_at = next((k for k in range(i + 1, min(len(series), i + 1 + look))
                                if 1 / back <= series[k][1] / prev <= back), None)
                if back_at is not None:
                    dropped += [d for d, _ in series[i:back_at]]
                    i = back_at
                    continue
        out.append(series[i])
        i += 1
    return out, dropped


def update_prices(symbol, path):
    old = load_json(path, {"series": []})
    merged = {d: v for d, v in old["series"]}
    rng = "10d" if merged else "2y"
    merged.update(fetch_prices(symbol, rng))
    series, dropped = drop_spikes(sorted([d, v] for d, v in merged.items()))
    if dropped:
        print("prices: dropped suspicious values", symbol, dropped, file=sys.stderr)
    save_json(path, {
        "symbol": symbol,
        "updated": now_jst(),
        "series": series,
    })
    print("prices ok:", symbol, len(series))


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


def classify(item, match, company_qs=()):
    """検索結果には他社の記事も混ざるので、タイトルに社名がない「会社」記事は「業界」に回す。
    会社名の検索で取れた記事は毎回判定し直すので、match（略称など）を増やすと過去の記事にも反映される。"""
    if not match:
        return item
    if item.get("q") in company_qs:
        item["kind"] = "company" if any(m in item["title"] for m in match) else "sector"
    elif item["kind"] == "company" and not any(m in item["title"] for m in match):
        item["kind"] = "sector"
    return item


def update_news(queries, path, match=None):
    old = load_json(path, {"items": []})
    company_qs = {q["q"] for q in queries if q["kind"] == "company"}
    merged = {i["id"]: classify(i, match, company_qs) for i in old["items"]}
    seen_qs = {i.get("q") for i in merged.values()}
    ok = False
    for spec in queries:
        # 初めて使う検索語（新しい銘柄や、検索語を変えたとき）は60日分さかのぼる
        when = "14d" if spec["q"] in seen_qs else "60d"
        try:
            for item in fetch_news(spec["q"], spec["kind"], when):
                merged.setdefault(item["id"], classify(item, match, company_qs))
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
        update_news(s["queries"], DATA / "news" / (s["code"] + ".json"), s.get("match"))
    update_news(cfg["market"]["queries"], DATA / "news" / "market.json")
    if failures == len(jobs):
        sys.exit("株価をひとつも取得できませんでした")


if __name__ == "__main__":
    main()

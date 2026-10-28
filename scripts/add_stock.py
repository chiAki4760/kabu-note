#!/usr/bin/env python3
"""GitHub Issue の本文から銘柄を data/config.json に追加する。

本文の書式（アプリの「銘柄を追加」が作る）:
  コード: 7203
  名前: トヨタ自動車
  業種: 自動車
結果のメッセージを $RESULT_FILE に、成否を $GITHUB_OUTPUT の ok= に書く。
"""
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "data" / "config.json"
MAX_STOCKS = 30


def field(body, label):
    m = re.search(r"^\s*" + label + r"\s*[:：]\s*(.+?)\s*$", body, re.M)
    return m.group(1).strip() if m else ""


def finish(ok, message):
    Path(os.environ.get("RESULT_FILE", "result.txt")).write_text(message, encoding="utf-8")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("ok=%s\n" % ("true" if ok else "false"))
    print(message)


def main():
    body = os.environ.get("ISSUE_BODY", "")
    code = field(body, "コード").upper()
    name = field(body, "名前")
    sector = field(body, "業種")
    if not re.fullmatch(r"[0-9]{3}[0-9A-Z]", code):
        return finish(False, "証券コードは4桁（例：7203、285A）で入力してください。")
    if not (1 <= len(name) <= 30) or not (1 <= len(sector) <= 20):
        return finish(False, "名前（30字以内）と業種（20字以内）を入力してください。")
    if re.search(r"[\x00-\x1f\"\\]", name + sector):
        return finish(False, "名前と業種に使えない文字が含まれています。")
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    if any(s["code"] == code for s in cfg["stocks"]):
        return finish(False, "%s はすでに登録されています。" % code)
    if len(cfg["stocks"]) >= MAX_STOCKS:
        return finish(False, "登録できる銘柄は%d件までです。" % MAX_STOCKS)
    cfg["stocks"].append({
        "code": code,
        "symbol": code + ".T",
        "name": name,
        "sector": sector,
        "match": [name, code],
        "queries": [
            {"q": '"%s"' % name, "kind": "company"},
            {"q": "%s 市況" % sector, "kind": "sector"},
        ],
    })
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    finish(True, "%s（%s）を追加しました。株価とニュースを取得したので、アプリを開き直すとタブに出ます。" % (name, code))


if __name__ == "__main__":
    main()

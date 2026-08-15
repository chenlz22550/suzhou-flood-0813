#!/usr/bin/env python3
"""拉取台风实况路径，写入 data/typhoon-tracks.json。

数据源：浙江省水利厅台风路径 API（免费、无 Key）
  - 活跃列表：/Api/TyhoonActivity（站点拼写缺 p，照搬）
  - 年列表：/Api/TyphoonList/{year}
  - 详情：/Api/TyphoonInfo/{tfid}

策略：活跃台风全量；并纳入生命周期与研究时段重叠的台风（保证「白海豚」等主过程有路径）。
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from datetime import date, datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://typhoon.slt.zj.gov.cn"
UA = "Mozilla/5.0 (compatible; rain-flood-map/1.0; +typhoon-track)"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--year", type=int, default=2026)
    p.add_argument("--start", default="2026-08-10")
    p.add_argument("--end", default="2026-08-20")
    p.add_argument("--out", default=str(ROOT / "data" / "typhoon-tracks.json"))
    p.add_argument("--timeout", type=float, default=30.0)
    return p.parse_args()


def http_json(url: str, timeout: float):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_dt(s: str | None) -> date | None:
    if not s:
        return None
    s = str(s).strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s[: len(fmt.replace("%", "0"))], fmt).date()
        except ValueError:
            continue
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def overlaps(storm: dict, start: date, end: date) -> bool:
    a = parse_dt(storm.get("starttime"))
    b = parse_dt(storm.get("endtime")) or a
    if not a:
        return False
    if not b:
        b = a
    return a <= end and b >= start


def trim_point(pt: dict) -> dict:
    out = {
        "time": pt.get("time") or "",
        "lng": float(pt["lng"]),
        "lat": float(pt["lat"]),
        "strong": pt.get("strong") or "",
        "power": pt.get("power") or "",
        "speed": pt.get("speed") or "",
        "pressure": pt.get("pressure") or "",
        "movespeed": pt.get("movespeed") or "",
        "movedirection": pt.get("movedirection") or "",
        "radius7": pt.get("radius7") or "",
        "radius10": pt.get("radius10") or "",
        "radius12": pt.get("radius12") or "",
    }
    return out


def extract_cma_forecast(points: list[dict]) -> list[dict]:
    """取最后一个实况点上的中国台预报折线（活跃台风用）。"""
    if not points:
        return []
    last = points[-1]
    for fc in last.get("forecast") or []:
        if (fc.get("tm") or "") in ("中国", "中国大陆", "CMA"):
            out = []
            for fp in fc.get("forecastpoints") or []:
                try:
                    out.append(
                        {
                            "time": fp.get("time") or "",
                            "lng": float(fp["lng"]),
                            "lat": float(fp["lat"]),
                            "strong": fp.get("strong") or "",
                            "power": fp.get("power") or "",
                            "speed": fp.get("speed") or "",
                            "pressure": fp.get("pressure") or "",
                        }
                    )
                except (KeyError, TypeError, ValueError):
                    continue
            return out
    return []


def normalize_storm(raw: dict) -> dict | None:
    points = raw.get("points") or []
    track = []
    for pt in points:
        try:
            track.append(trim_point(pt))
        except (KeyError, TypeError, ValueError):
            continue
    if len(track) < 2:
        return None
    land = []
    for L in raw.get("land") or []:
        try:
            land.append(
                {
                    "address": L.get("landaddress") or "",
                    "time": L.get("landtime") or "",
                    "lng": float(L["lng"]),
                    "lat": float(L["lat"]),
                    "info": L.get("info") or "",
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    is_active = str(raw.get("isactive", "0")) in ("1", "true", "True")
    storm = {
        "tfid": str(raw.get("tfid") or ""),
        "name": raw.get("name") or "",
        "enname": raw.get("enname") or "",
        "isactive": is_active,
        "starttime": raw.get("starttime") or "",
        "endtime": raw.get("endtime") or "",
        "warnlevel": raw.get("warnlevel") or "",
        "land": land,
        "track": track,
    }
    if is_active:
        storm["forecast"] = extract_cma_forecast(points)
    return storm


def select_tfids(year: int, start: date, end: date, timeout: float) -> list[str]:
    chosen: dict[str, str] = {}
    try:
        active = http_json(f"{BASE}/Api/TyhoonActivity", timeout) or []
    except Exception as exc:  # noqa: BLE001
        print(f"  warn: active list failed: {exc}")
        active = []
    for s in active:
        tfid = str(s.get("tfid") or "")
        if tfid:
            chosen[tfid] = "active"

    try:
        year_list = http_json(f"{BASE}/Api/TyphoonList/{year}", timeout) or []
    except Exception as exc:  # noqa: BLE001
        print(f"  warn: year list failed: {exc}")
        year_list = []
    for s in year_list:
        tfid = str(s.get("tfid") or "")
        if not tfid:
            continue
        if overlaps(s, start, end):
            chosen.setdefault(tfid, "period")

    # 叙事主台风兜底：白海豚
    if "202613" not in chosen and year == 2026:
        chosen["202613"] = "narrative"

    print(f"  selected {len(chosen)} storms: {chosen}")
    return list(chosen.keys())


def main() -> None:
    args = parse_args()
    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end)
    tfids = select_tfids(args.year, start, end, args.timeout)
    storms = []
    for tfid in tfids:
        url = f"{BASE}/Api/TyphoonInfo/{tfid}"
        try:
            raw = http_json(url, args.timeout)
        except Exception as exc:  # noqa: BLE001
            print(f"  skip {tfid}: {exc}")
            continue
        storm = normalize_storm(raw if isinstance(raw, dict) else {})
        if storm:
            storms.append(storm)
            print(f"  ok {tfid} {storm['name']} points={len(storm['track'])}")
        else:
            print(f"  skip {tfid}: too few points")

    # 活跃优先，其次按结束时间
    storms.sort(key=lambda s: (not s["isactive"], s.get("endtime") or "", s["tfid"]))

    pack = {
        "updated": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
        "source": "浙江省水利厅台风路径 API (typhoon.slt.zj.gov.cn)",
        "period": f"{args.start}/{args.end}",
        "year": args.year,
        "storms": storms,
    }
    out = Path(args.out)
    out.write_text(json.dumps(pack, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {out} storms={len(storms)}")


if __name__ == "__main__":
    main()

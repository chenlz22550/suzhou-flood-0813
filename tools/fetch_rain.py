#!/usr/bin/env python3
"""Pull Open-Meteo daily precipitation grid.

Default profile: 全国（中国大陆 bbox）2026-08-10 至 2026-08-20 逐日累计。
可用 CLI 参数覆盖范围 / 日期 / 步长 / 输出文件，供 .cnb.yml 定时任务复用。

示例（旧江浙沪皖口径）：
  python3 tools/fetch_rain.py --lon-min 114.88 --lat-min 27.05 \
    --lon-max 122.35 --lat-max 35.15 --step 0.22 --out data/rain-grid-jszj.json
"""

from __future__ import annotations

import argparse
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

TZ = "Asia/Shanghai"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    # 全国大陆范围（含海域边缘，前端用国界掩膜裁掉）
    p.add_argument("--lon-min", type=float, default=73.0)
    p.add_argument("--lat-min", type=float, default=17.5)
    p.add_argument("--lon-max", type=float, default=135.5)
    p.add_argument("--lat-max", type=float, default=54.0)
    p.add_argument("--step", type=float, default=0.5)
    p.add_argument("--start", default="2026-08-10")
    p.add_argument("--end", default="2026-08-20")
    p.add_argument("--batch", type=int, default=40)
    p.add_argument("--sleep", type=float, default=0.28)
    p.add_argument("--out", default=str(ROOT / "data" / "rain-grid.json"))
    p.add_argument("--note", default="模式分析场，非自动站实况。全国 2026-08-10 至 2026-08-20 逐日累计。")
    return p.parse_args()


def date_range(start: str, end: str) -> list[str]:
    from datetime import date, timedelta

    a = date.fromisoformat(start)
    b = date.fromisoformat(end)
    days = []
    while a <= b:
        days.append(a.isoformat())
        a += timedelta(days=1)
    return days


def grid_points(args: argparse.Namespace) -> list[tuple[float, float]]:
    pts = []
    lat = args.lat_min
    while lat <= args.lat_max + 1e-9:
        lon = args.lon_min
        while lon <= args.lon_max + 1e-9:
            pts.append((round(lat, 4), round(lon, 4)))
            lon = round(lon + args.step, 4)
        lat = round(lat + args.step, 4)
    return pts


def fetch_batch(points: list[tuple[float, float]], args: argparse.Namespace) -> dict:
    lats = ",".join(str(p[0]) for p in points)
    lons = ",".join(str(p[1]) for p in points)
    qs = urllib.parse.urlencode(
        {
            "latitude": lats,
            "longitude": lons,
            "hourly": "precipitation",
            "start_date": args.start,
            "end_date": args.end,
            "timezone": TZ,
        }
    )
    url = f"https://historical-forecast-api.open-meteo.com/v1/forecast?{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": "rain-field-cn/2.0"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode("utf-8"))


def summarize(times: list[str], precip: list[float | None], days: list[str]) -> dict:
    daily = {d: 0.0 for d in days}
    max_hour = 0.0
    max_hour_t = None
    for i, t in enumerate(times):
        v = precip[i]
        p = float(v) if v is not None else 0.0
        day = t[:10]
        if day in daily:
            daily[day] += p
        if p > max_hour:
            max_hour = p
            max_hour_t = t
    return {
        "d": [round(daily[k], 1) for k in days],
        "mh": round(max_hour, 1),
        "mhat": max_hour_t,
    }


def normalize_payload(raw, points: list[tuple[float, float]], days: list[str]) -> list[dict]:
    items = raw if isinstance(raw, list) else [raw]
    out = []
    for i, item in enumerate(items):
        if "hourly" not in item:
            raise RuntimeError(f"unexpected payload at {i}: {item}")
        lat = float(item.get("latitude", points[i][0]))
        lon = float(item.get("longitude", points[i][1]))
        hourly = item["hourly"]
        stats = summarize(hourly["time"], hourly["precipitation"], days)
        out.append({"lat": round(lat, 4), "lon": round(lon, 4), **stats})
    return out


def main() -> None:
    args = parse_args()
    days = date_range(args.start, args.end)
    points = grid_points(args)
    print(f"grid points: {len(points)}  step={args.step}  days={len(days)}", flush=True)
    cells = []
    for i in range(0, len(points), args.batch):
        batch = points[i : i + args.batch]
        print(f"  fetch {i + 1}-{i + len(batch)} / {len(points)}", flush=True)
        last_err = None
        for attempt in range(4):
            try:
                raw = fetch_batch(batch, args)
                cells.extend(normalize_payload(raw, batch, days))
                last_err = None
                break
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                print(f"    retry {attempt + 1}: {exc}", flush=True)
                time.sleep(1.4 * (attempt + 1))
        if last_err:
            raise last_err
        time.sleep(args.sleep)

    uniq = {}
    for c in cells:
        key = (c["lat"], c["lon"])
        if key not in uniq or sum(c["d"]) > sum(uniq[key]["d"]):
            uniq[key] = c
    cells = list(uniq.values())

    totals = [sum(c["d"]) for c in cells]
    peak = max(cells, key=lambda c: sum(c["d"]))
    peak_h = max(cells, key=lambda c: c["mh"])
    payload = {
        "source": "Open-Meteo Historical Forecast API (precipitation)",
        "note": args.note,
        "timezone": TZ,
        "start": args.start,
        "end": args.end,
        "days": days,
        "stepDeg": args.step,
        "bbox": [args.lon_min, args.lat_min, args.lon_max, args.lat_max],
        "stats": {
            "n": len(cells),
            "totalMin": round(min(totals), 1),
            "totalMax": round(max(totals), 1),
            "totalMean": round(sum(totals) / len(totals), 1),
            "maxHourMax": peak_h["mh"],
            "p95": round(sorted(totals)[max(0, math.ceil(0.95 * len(totals)) - 1)], 1),
            "peak": peak,
            "peakHour": peak_h,
        },
        "cells": cells,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {out}  n={len(cells)}  kb={out.stat().st_size / 1024:.1f}")
    print(f"total min={payload['stats']['totalMin']} max={payload['stats']['totalMax']} mean={payload['stats']['totalMean']}")
    print(f"peak  {peak['lat']},{peak['lon']}  sum={sum(peak['d']):.1f}  d={peak['d']}")
    print(f"peak hour {peak_h}")


if __name__ == "__main__":
    main()

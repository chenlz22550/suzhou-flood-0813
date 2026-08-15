#!/usr/bin/env python3
"""用 DeepSeek LLM 汇总全国暴雨 / 内涝 / 台风舆情事件，写入 data/events.json 的 nationalEvents。

- 保留 events.json 里已人工核验的苏州明细（events）与江浙沪皖事件（regionalEvents）、hotspots 不动；
- 仅重新生成 nationalEvents 数组（LLM 汇总，前端标注「待核验」）；
- 供本地与 .cnb.yml 定时任务共用。

用法：
  DEEPSEEK_API_KEY=sk-xxx python3 tools/update_events.py
  python3 tools/update_events.py --api-key sk-xxx --start 2026-08-10 --end 2026-08-20
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events.json"

API_URL = "https://api.deepseek.com/chat/completions"
DEFAULT_MODEL = "deepseek-v4-flash"

PROMPT_TMPL = """你是气象灾情资料整理员。请整理 {start} 至 {end} 期间，中国全国范围内公开报道过的灾情事件。

重点（必须优先）：全国各地的城市积水、内涝、雨水/河水/海水倒灌、地下空间进水。这些要覆盖尽量多的省份与城市，作为全国标注点。
次要：洪水、山洪、暴雨预警、台风登陆/影响。

要求：
1. 覆盖全国各主要受影响省份（如浙江、江苏、上海、安徽、福建、广东、广西、湖南、湖北、江西、河南、山东、四川、重庆、贵州、云南、陕西、山西、河北、北京、天津、辽宁、吉林、黑龙江、海南、台湾等），有报道才列，没有的省份不要编造。
2. 积水/倒灌类事件不少于输出总数的 60%。凡报道道路积水、小区内涝、下穿通道积水、地铁站进水、车库进水、管网/河道倒灌、海水倒灌，必须单独成点，不要只写「暴雨」概括。
3. 每个事件给出：name（简短名称，优先含「积水」「倒灌」「内涝」「进水」等字样）、province、city、lat、lon（事件地点经纬度，精确到 0.05 度，务必真实合理）、date（YYYY-MM-DD，事件主要发生日）、kind（waterlog 内涝积水 / flood 洪水山洪 / warning 暴雨预警 / typhoon 台风相关）、severity（garage 地下车库进水 / backflow 倒灌 / knee 及膝积水 / road 道路积水 / alert 预警）、rain_mm（报道中的雨量毫米数，没有就给 null）、desc（30-60 字事实描述，写明积水深度或倒灌情形）、source（信息来源名称，如 央视/新华社/地方气象台/微博热搜）。
4. 输出 20 到 40 个事件，按影响从大到小排序；积水/倒灌点分散到不同城市，避免同一城市堆过多雷同点。
5. 只输出一个 JSON 数组，不要任何解释文字、不要 markdown 代码围栏。"""


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--api-key", default=os.environ.get("DEEPSEEK_API_KEY", ""))
    p.add_argument("--model", default=os.environ.get("DEEPSEEK_MODEL", DEFAULT_MODEL))
    p.add_argument("--start", default="2026-08-10")
    p.add_argument("--end", default="2026-08-20")
    p.add_argument("--out", default=str(EVENTS))
    return p.parse_args()


def call_deepseek(args: argparse.Namespace) -> str:
    body = {
        "model": args.model,
        "messages": [
            {"role": "system", "content": "你是严谨的资料整理员，只输出合法 JSON。"},
            {"role": "user", "content": PROMPT_TMPL.format(start=args.start, end=args.end)},
        ],
        "max_tokens": 16000,
        "temperature": 0.2,
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {args.api_key}",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return payload["choices"][0]["message"]["content"]


def extract_json(text: str):
    text = text.strip()
    text = re.sub(r"^```(json)?|```$", "", text, flags=re.MULTILINE).strip()
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1:
        raise ValueError("LLM 输出中没有 JSON 数组")
    return json.loads(text[start : end + 1])


def validate(items) -> list[dict]:
    out = []
    seen = set()
    for it in items:
        try:
            lat = float(it["lat"])
            lon = float(it["lon"])
            name = str(it["name"]).strip()
            if not (17.0 <= lat <= 54.5 and 73.0 <= lon <= 135.5):
                print(f"  drop(坐标越界): {name} {lat},{lon}")
                continue
            if not name:
                continue
            key = (name, round(lat, 1), round(lon, 1))
            if key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "name": name,
                    "province": str(it.get("province", "")).strip(),
                    "city": str(it.get("city", "")).strip(),
                    "lat": round(lat, 4),
                    "lon": round(lon, 4),
                    "date": str(it.get("date", "")).strip(),
                    "kind": str(it.get("kind", "waterlog")).strip(),
                    "severity": str(it.get("severity", "road")).strip(),
                    "rainMm": it.get("rain_mm"),
                    "desc": str(it.get("desc", "")).strip(),
                    "source": str(it.get("source", "")).strip() or "LLM 汇总",
                    "verify": "llm",
                }
            )
        except (KeyError, TypeError, ValueError) as exc:
            print(f"  drop(字段异常): {it} -> {exc}")
    return out


def main() -> None:
    args = parse_args()
    if not args.api_key:
        sys.exit("缺少 DeepSeek API key：--api-key 或环境变量 DEEPSEEK_API_KEY")

    out_path = Path(args.out)
    pack = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}

    last_err = None
    events = None
    for attempt in range(3):
        try:
            raw = call_deepseek(args)
            events = validate(extract_json(raw))
            if len(events) < 5:
                raise ValueError(f"有效事件过少: {len(events)}")
            last_err = None
            break
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            print(f"  retry {attempt + 1}: {exc}", flush=True)
            time.sleep(2 * (attempt + 1))
    if last_err:
        raise last_err

    pack["nationalEvents"] = events
    pack["nationalUpdated"] = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")
    pack["nationalModel"] = args.model
    out_path.write_text(json.dumps(pack, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {out_path}  nationalEvents={len(events)}")
    for e in events[:5]:
        print(f"  {e['date']} {e['province']}{e['city']} {e['name']} ({e['lat']},{e['lon']})")


if __name__ == "__main__":
    main()

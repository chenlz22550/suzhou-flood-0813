(function () {
  const $ = (id) => document.getElementById(id);
  const SEV = { garage: 1, backflow: 0.9, knee: 0.8, road: 0.45, alert: 0.3 };

  const state = {
    view: { kind: "day", idx: 0 },
    showNational: true,
    showRegional: true,
    showEvents: true,
    showHotspots: true,
    showPrior: true,
    fields: {},
    mask: null,
    suzhouMask: null,
    currentField: null,
    overlay: null,
    contourLayer: null,
    layers: {},
    rain: null,
    pack: null,
    districts: null,
    region: null,
    china: null,
    anim: null,
    BBOX: null,
    DAYS: [],
    COLS: 320,
    ROWS: 187,
  };

  // ---------- 地图 ----------
  const map = L.map("map", {
    zoomControl: true,
    minZoom: 4,
    maxZoom: 13,
    attributionControl: true,
    zoomSnap: 0.25,
  });
  map.zoomControl.setPosition("topright");

  const dark = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { maxZoom: 19, attribution: "&copy; OSM &copy; CARTO" }
  );
  const gaode = L.tileLayer(
    "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
    { subdomains: "1234", maxZoom: 18, attribution: "高德" }
  );
  dark.addTo(map);
  dark.on("tileerror", function once() {
    if (!map.hasLayer(gaode)) {
      map.removeLayer(dark);
      gaode.addTo(map);
    }
  });

  // ---------- 工具 ----------
  function fmt(n, d = 1) {
    return Number(n).toFixed(d);
  }
  function daySum(c, i) {
    return c.d[i] || 0;
  }
  function sum(arr) {
    return arr.reduce((a, b) => a + b, 0);
  }
  function rangeSum(c, a, b) {
    let s = 0;
    for (let i = a; i <= b; i++) s += c.d[i] || 0;
    return s;
  }
  function viewValue(c, view) {
    if (view.kind === "day") return daySum(c, view.idx);
    if (view.kind === "range") return rangeSum(c, view.a, view.b);
    return c.mh;
  }
  function nearest(lat, lon) {
    let best = null;
    let dmin = Infinity;
    for (const c of state.rain.cells) {
      const d = (c.lat - lat) ** 2 + (c.lon - lon) ** 2;
      if (d < dmin) {
        dmin = d;
        best = c;
      }
    }
    return best;
  }
  function rainNorm(v) {
    const p95 = state.rain.stats.p95 || 300;
    return Math.max(0, Math.min(1, v / p95));
  }
  function cellInsideMask(c, mask) {
    if (!mask) return true;
    const [west, south, east, north] = state.BBOX;
    const i = Math.round(((c.lon - west) / (east - west)) * (state.COLS - 1));
    const j = Math.round(((north - c.lat) / (north - south)) * (state.ROWS - 1));
    if (i < 0 || j < 0 || i >= state.COLS || j >= state.ROWS) return false;
    return !!mask[j * state.COLS + i];
  }
  function suzhouCells() {
    return state.rain.cells.filter((c) => cellInsideMask(c, state.suzhouMask));
  }
  function dateIdx(dateStr) {
    const i = state.rain.days.indexOf(dateStr);
    if (i >= 0) return i;
    return -1;
  }
  function dayLabel(i) {
    const d = state.rain.days[i]; // YYYY-MM-DD
    return `${+d.slice(5, 7)}月${+d.slice(8, 10)}日`;
  }

  // 全国主要城市（地名粗定位）
  const NAMED = [
    ["北京", 39.9, 116.4], ["天津", 39.13, 117.2], ["上海", 31.23, 121.47],
    ["重庆", 29.56, 106.55], ["广州", 23.13, 113.26], ["深圳", 22.54, 114.06],
    ["杭州", 30.27, 120.16], ["南京", 32.06, 118.8], ["苏州", 31.3, 120.6],
    ["无锡", 31.57, 120.3], ["宁波", 29.87, 121.55], ["温州", 28.0, 120.65],
    ["台州", 28.66, 121.42], ["舟山", 30.0, 122.2], ["合肥", 31.82, 117.23],
    ["黄山", 29.71, 118.34], ["福州", 26.07, 119.3], ["厦门", 24.48, 118.09],
    ["泉州", 24.87, 118.68], ["南昌", 28.68, 115.86], ["武汉", 30.59, 114.31],
    ["长沙", 28.23, 112.94], ["郑州", 34.75, 113.63], ["济南", 36.65, 117.12],
    ["青岛", 36.07, 120.38], ["石家庄", 38.04, 114.51], ["太原", 37.87, 112.55],
    ["西安", 34.34, 108.94], ["兰州", 36.06, 103.83], ["西宁", 36.62, 101.78],
    ["成都", 30.57, 104.07], ["贵阳", 26.65, 106.63], ["昆明", 25.04, 102.71],
    ["南宁", 22.82, 108.37], ["桂林", 25.27, 110.29], ["海口", 20.02, 110.35],
    ["三亚", 18.25, 109.51], ["沈阳", 41.8, 123.43], ["大连", 38.91, 121.61],
    ["长春", 43.88, 125.32], ["哈尔滨", 45.8, 126.53], ["呼和浩特", 40.84, 111.75],
    ["银川", 38.49, 106.23], ["乌鲁木齐", 43.83, 87.62], ["拉萨", 29.65, 91.14],
    ["珠海", 22.27, 113.58], ["汕头", 23.35, 116.68], ["湛江", 21.27, 110.36],
    ["台北", 25.03, 121.57], ["香港", 22.32, 114.17], ["澳门", 22.2, 113.55],
    ["徐州", 34.2, 117.18], ["宜昌", 30.69, 111.29], ["九江", 29.71, 116.0],
    ["安庆", 30.53, 117.06], ["怀化", 27.57, 110.0], ["柳州", 24.33, 109.42],
  ];
  function placeName(cell) {
    let best = NAMED[0];
    let dmin = Infinity;
    for (const n of NAMED) {
      const d = (n[1] - cell.lat) ** 2 + (n[2] - cell.lon) ** 2;
      if (d < dmin) {
        dmin = d;
        best = n;
      }
    }
    return best[0] + "一带";
  }
  const NAMED_SZ = [
    ["吴中·光福", 31.25, 120.28], ["吴中·胥口", 31.24, 120.5], ["姑苏古城", 31.31, 120.62],
    ["工业园区", 31.32, 120.73], ["高新区·狮山", 31.3, 120.55], ["相城区", 31.37, 120.64],
    ["昆山", 31.38, 120.96], ["常熟", 31.65, 120.75], ["张家港", 31.87, 120.56],
    ["太仓", 31.46, 121.1], ["吴江", 31.16, 120.65],
  ];
  function placeNameSz(cell) {
    let best = NAMED_SZ[0];
    let dmin = Infinity;
    for (const n of NAMED_SZ) {
      const d = (n[1] - cell.lat) ** 2 + (n[2] - cell.lon) ** 2;
      if (d < dmin) {
        dmin = d;
        best = n;
      }
    }
    return best[0];
  }
  function labelWarn(w) {
    return { red: "暴雨红", orange: "暴雨橙", yellow: "暴雨黄" }[w] || w;
  }

  // ---------- 雨量场 ----------
  function viewKey(view) {
    if (view.kind === "day") return "day" + view.idx;
    if (view.kind === "range") return `r${view.a}-${view.b}`;
    return "maxHour";
  }
  function pointsFor(view) {
    return state.rain.cells.map((c) => ({ lat: c.lat, lon: c.lon, v: viewValue(c, view) }));
  }
  function ensureField(view) {
    const key = viewKey(view);
    if (state.fields[key]) return state.fields[key];
    const built = RainIDW.idwGrid(
      pointsFor(view), state.BBOX, state.COLS, state.ROWS, 2.3, 1.0, state.mask
    );
    state.fields[key] = built.field;
    return built.field;
  }
  function fieldMax(field) {
    let m = 0;
    for (let i = 0; i < field.length; i++) if (state.mask[i] && field[i] > m) m = field[i];
    return m;
  }
  function niceCeil(v) {
    const steps = [10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 125, 150, 200, 250, 300, 400, 500, 800];
    for (const s of steps) if (v <= s) return s;
    return 1000;
  }
  function scaledStops(view, vmax) {
    const base = view.kind === "maxHour" ? RainIDW.STOPS_HOUR : RainIDW.STOPS_RAIN;
    const baseMax = base[base.length - 1][0];
    const top = niceCeil(Math.max(vmax, baseMax * 0.3));
    return { stops: base.map(([v, c]) => [(v / baseMax) * top, c]), top };
  }

  function drawField(field, view, instant) {
    const vmax = fieldMax(field);
    const { stops, top } = scaledStops(view, vmax);
    const canvas = document.createElement("canvas");
    const url = RainIDW.paint(canvas, field, state.COLS, state.ROWS, stops, state.mask);
    const bounds = [
      [state.BBOX[1], state.BBOX[0]],
      [state.BBOX[3], state.BBOX[2]],
    ];
    if (state.overlay) {
      if (instant) state.overlay.setUrl(url);
      else {
        const next = L.imageOverlay(url, bounds, { opacity: 0 }).addTo(map);
        fadeSwap(state.overlay, next);
        state.overlay = next;
      }
    } else {
      state.overlay = L.imageOverlay(url, bounds, { opacity: 0.78 }).addTo(map);
    }
    drawContours(field, view, top);
    state.currentField = field;
    updateLegend(view, top);
  }

  function fadeSwap(oldL, newL) {
    let t = 0;
    const step = () => {
      t += 0.08;
      const e = t < 1 ? t * t * (3 - 2 * t) : 1;
      newL.setOpacity(0.78 * e);
      oldL.setOpacity(0.78 * (1 - e));
      if (t < 1) requestAnimationFrame(step);
      else map.removeLayer(oldL);
    };
    requestAnimationFrame(step);
  }

  function drawContours(field, view, top) {
    if (state.contourLayer) {
      map.removeLayer(state.contourLayer);
      state.contourLayer = null;
    }
    const levels =
      view.kind === "maxHour" ? [top * 0.35, top * 0.6] : [top * 0.3, top * 0.55, top * 0.8];
    const lines = RainIDW.contours(field, state.COLS, state.ROWS, state.BBOX, levels.map(Math.round));
    const group = L.layerGroup();
    const [west, south, east, north] = state.BBOX;
    const inside = (lat, lon) => {
      const i = Math.round(((lon - west) / (east - west)) * (state.COLS - 1));
      const j = Math.round(((north - lat) / (north - south)) * (state.ROWS - 1));
      if (i < 0 || j < 0 || i >= state.COLS || j >= state.ROWS) return false;
      return !state.mask || state.mask[j * state.COLS + i];
    };
    for (const pack of lines) {
      for (const seg of pack.segs) {
        if (!inside(seg[0][0], seg[0][1]) && !inside(seg[1][0], seg[1][1])) continue;
        L.polyline(seg, {
          color: "rgba(255,255,255,0.5)",
          weight: 1.0,
          opacity: 0.4,
          interactive: false,
        }).addTo(group);
      }
    }
    group.addTo(map);
    state.contourLayer = group;
  }

  function viewTitle(view) {
    if (view.kind === "day") return `${dayLabel(view.idx)} 日累计降水（IDW 平滑）`;
    if (view.kind === "range") return `${dayLabel(view.a)}–${dayLabel(view.b)} 累计降水（IDW 平滑）`;
    return "过程最大小时雨强";
  }
  function updateLegend(view, top) {
    $("legend-bar").classList.toggle("hour", view.kind === "maxHour");
    const unit = view.kind === "maxHour" ? " mm/h" : " mm";
    $("legend-ticks").innerHTML = [0, 0.2, 0.4, 0.6, 0.8, 1]
      .map((f) => `<span>${f === 1 ? Math.round(top) + unit : Math.round(top * f)}</span>`)
      .join("");
    $("legend-title").textContent = viewTitle(view);
  }

  function setView(view, animate = true) {
    const from = state.currentField;
    const to = ensureField(view);
    const sameView = viewKey(view) === viewKey(state.view) && from;
    state.view = view;
    if (!animate || !from || sameView) {
      drawField(to, view, true);
      if (state.overlay) state.overlay.setOpacity(0.78);
      return;
    }
    if (state.anim) cancelAnimationFrame(state.anim);
    const start = performance.now();
    const dur = 380;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const e = t * t * (3 - 2 * t);
      const mixed = RainIDW.blend(from, to, e);
      drawField(mixed, view, true);
      if (state.overlay) state.overlay.setOpacity(0.78);
      if (t < 1) state.anim = requestAnimationFrame(tick);
      else drawField(to, view, true);
    };
    requestAnimationFrame(tick);
  }

  // ---------- 舆情关注打分（全国事件 × 邻近格点雨量） ----------
  function scoreEvent(ev) {
    const cell = nearest(ev.lat, ev.lon);
    let rain = 0;
    if (cell) {
      const i = dateIdx(ev.date);
      if (i >= 0) rain = daySum(cell, i) + 0.5 * (daySum(cell, i - 1) || 0) + 0.5 * (daySum(cell, i + 1) || 0);
      else rain = sum(cell.d) / state.rain.days.length;
    }
    const score = 0.55 * rainNorm(rain) + 0.45 * (SEV[ev.severity] || 0.3);
    return { score, cell, rain };
  }
  function buildRanking() {
    const rows = (state.pack.nationalEvents || []).map((ev) => ({ ...ev, ...scoreEvent(ev) }));
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  function renderRanking(rows) {
    const top = rows.slice(0, 5);
    $("rank-list").innerHTML = top
      .map(
        (r, i) => `
      <article class="card" data-lat="${r.lat}" data-lon="${r.lon}">
        <div class="top">
          <div class="name">${i + 1}. ${r.name}</div>
          <div class="score">${fmt(r.score * 100, 0)}</div>
        </div>
        <p>
          <span class="tag cyan">${r.province} · ${r.city}</span>
          ${r.date ? r.date.slice(5).replace("-", "/") : ""}
          ${r.rainMm ? ` · 报道 ${r.rainMm} mm` : ""}
        </p>
        <p>${r.desc || ""}</p>
      </article>`
      )
      .join("");
    $("rank-list").querySelectorAll(".card").forEach((el) => {
      el.addEventListener("click", () => map.flyTo([+el.dataset.lat, +el.dataset.lon], 8, { duration: 0.9 }));
    });

    // KPI（只统计国界掩膜内的格点，原始 stats 含境外海域）
    const inChina = state.rain.cells.filter((c) => cellInsideMask(c, state.mask));
    const rgPeak = [...inChina].sort((a, b) => sum(b.d) - sum(a.d))[0];
    // 全国单日峰值
    let bestDay = { v: -1, cell: null, idx: 0 };
    for (const c of inChina) {
      for (let i = 0; i < c.d.length; i++) {
        if (c.d[i] > bestDay.v) bestDay = { v: c.d[i], cell: c, idx: i };
      }
    }
    const sz = suzhouCells();
    const szPeak = sz.length
      ? [...sz].sort((a, b) => rangeSum(b, 3, 4) - rangeSum(a, 3, 4))[0]
      : null;
    const hourPeak = [...inChina].sort((a, b) => b.mh - a.mh)[0];
    const worst = top[0];

    $("kpi-peak").textContent = fmt(sum(rgPeak.d), 0) + " mm";
    $("kpi-peak-where").textContent = "全国累计峰值 · " + placeName(rgPeak);
    if (bestDay.cell) {
      $("kpi-d14").textContent = fmt(bestDay.v, 0) + " mm";
      $("kpi-d14-where").textContent = `${dayLabel(bestDay.idx)} · ${placeName(bestDay.cell)}`;
    }
    if (szPeak) {
      $("kpi-sz").textContent = fmt(rangeSum(szPeak, 3, 4), 0) + " mm";
      $("kpi-sz-where").textContent = "苏州 13–14 日 · " + placeNameSz(szPeak);
    }
    if (worst) {
      $("kpi-event").textContent = worst.name;
      $("kpi-event-sub").textContent = `舆情首位 · ${worst.province}${worst.city} · ${fmt(worst.score * 100, 0)} 分`;
    }

    $("verdict").innerHTML = `
      本轮过程全国累计雨峰 <strong>${fmt(sum(rgPeak.d), 0)} mm</strong>（${placeName(rgPeak)}），
      单日峰值 <strong>${bestDay.cell ? fmt(bestDay.v, 0) + " mm（" + dayLabel(bestDay.idx) + "·" + placeName(bestDay.cell) + "）" : "—"}</strong>；
      最大小时雨强 <strong>${fmt(hourPeak.mh)} mm/h（${placeName(hourPeak)}）</strong>。
      苏州 13–14 日残涡回马枪，峰值 <strong>${szPeak ? fmt(rangeSum(szPeak, 3, 4), 0) + " mm（" + placeNameSz(szPeak) + "）" : "—"}</strong>，
      体感最淹在「雨量高值 + 河网顶托 + 已有积水点」叠加处。
      舆情关注首位：<strong>${worst ? worst.province + worst.city + " " + worst.name : "—"}</strong>。
      全国事件为 LLM 汇总舆情，请以官方通报复核。`;
  }

  // ---------- 事件图层 ----------
  function markerColor(ev) {
    if (ev.period === "prior") return "#7d8b96";
    if (ev.kind === "hydro") return "#3ec7c9";
    return "#ff5d4d";
  }
  function nationalStyle(ev) {
    if (ev.kind === "typhoon")
      return { radius: 9, color: "#ffd166", weight: 2, fillColor: "#ffd166", fillOpacity: 0.9 };
    if (ev.kind === "warning")
      return { radius: 6, color: "#ff9e5e", weight: 1.6, fillColor: "#ff9e5e", fillOpacity: 0.3 };
    return {
      radius: ev.severity === "garage" || ev.severity === "backflow" ? 8 : 6,
      color: "#04121c",
      weight: 1,
      fillColor: "#22d3ee",
      fillOpacity: 0.9,
    };
  }
  function nationalPopup(ev) {
    const cell = nearest(ev.lat, ev.lon);
    const i = dateIdx(ev.date);
    const dayTxt = i >= 0 && cell ? `${dayLabel(i)} 邻近格点 ${fmt(daySum(cell, i))} mm · ` : "";
    return `
      <div class="popup">
        <h3>${ev.name}</h3>
        <div class="dim">${ev.province} · ${ev.city} · ${ev.date || "日期不详"}</div>
        ${ev.rainMm ? `<div>报道雨量 <b>${ev.rainMm} mm</b></div>` : ""}
        <p>${ev.desc || ""}</p>
        <div class="dim">${dayTxt}全程 ${cell ? fmt(sum(cell.d), 0) : "—"} mm · 来源：${ev.source || "—"}</div>
        <span class="llm">LLM 汇总舆情 · 待核验</span>
      </div>`;
  }

  function drawEvents() {
    for (const k of Object.keys(state.layers)) {
      map.removeLayer(state.layers[k]);
      delete state.layers[k];
    }

    // 全国事件（LLM）
    const nat = L.layerGroup();
    if (state.showNational) {
      for (const ev of state.pack.nationalEvents || []) {
        L.circleMarker([ev.lat, ev.lon], nationalStyle(ev))
          .bindPopup(nationalPopup(ev))
          .addTo(nat);
      }
    }
    nat.addTo(map);
    state.layers.national = nat;

    // 江浙沪皖区域事件（人工整理）
    const reg = L.layerGroup();
    if (state.showRegional) {
      for (const ev of state.pack.regionalEvents || []) {
        const cell = nearest(ev.lat, ev.lon);
        const win = ev.period === "0910" ? [0, 1] : [3, 4];
        const winLabel = ev.period === "0910" ? "10–11日" : "13–14日";
        const style =
          ev.kind === "landfall"
            ? { radius: 9, color: "#ffd166", weight: 2, fillColor: "#ffd166", fillOpacity: 0.9 }
            : ev.kind === "warn"
              ? { radius: 6, color: "#ff9e5e", weight: 1.6, fillColor: "#ff9e5e", fillOpacity: 0.3 }
              : { radius: ev.severity === "garage" ? 8 : 6, color: "#081018", weight: 1, fillColor: "#c084fc", fillOpacity: 0.9 };
        L.circleMarker([ev.lat, ev.lon], style)
          .bindPopup(`
            <div class="popup">
              <h3>${ev.name}</h3>
              <div class="dim">${ev.region} · ${ev.city} · ${winLabel}</div>
              <div><b>${ev.depth}</b></div>
              <p>${ev.desc}</p>
              <div class="dim">邻近格点 ${winLabel} ${fmt(rangeSum(cell, win[0], win[1]))} mm / 全程 ${fmt(rangeSum(cell, 0, 10))} mm</div>
            </div>`)
          .addTo(reg);
      }
    }
    reg.addTo(map);
    state.layers.regional = reg;

    // 苏州明细
    const evs = L.layerGroup();
    for (const ev of state.pack.events || []) {
      if (ev.period === "prior" && !state.showPrior) continue;
      if (ev.period !== "prior" && !state.showEvents) continue;
      const cell = nearest(ev.lat, ev.lon);
      L.circleMarker([ev.lat, ev.lon], {
        radius: ev.severity === "garage" || ev.severity === "backflow" ? 8 : 6,
        color: "#081018",
        weight: 1,
        fillColor: markerColor(ev),
        fillOpacity: ev.period === "prior" ? 0.55 : 0.92,
      })
        .bindPopup(`
          <div class="popup">
            <h3>${ev.name}</h3>
            <div class="dim">${ev.district} · ${ev.town} · ${ev.period === "prior" ? "9–11日背景" : "本轮/持续"}</div>
            <div><b>${ev.depth}</b></div>
            <p>${ev.desc}</p>
            <div class="dim">邻近格点 13–14日 ${fmt(rangeSum(cell, 3, 4))} mm / 全程 ${fmt(rangeSum(cell, 0, 10))} mm</div>
          </div>`)
        .addTo(evs);
    }
    evs.addTo(map);
    state.layers.events = evs;

    // 苏州预警镇街
    const hots = L.layerGroup();
    if (state.showHotspots) {
      for (const h of state.pack.hotspots || []) {
        const color = h.warn === "red" ? "#ff8a3d" : h.warn === "orange" ? "#f0b429" : "#c8c070";
        L.circleMarker([h.lat, h.lon], {
          radius: 4,
          color,
          weight: 1.2,
          fillColor: color,
          fillOpacity: 0.25,
        })
          .bindPopup(
            `<div class="popup"><h3>${h.name}</h3><div class="dim">${h.district} · ${labelWarn(h.warn)}</div><p>${h.note}</p></div>`
          )
          .addTo(hots);
      }
    }
    hots.addTo(map);
    state.layers.hots = hots;

    // 舆情 Top3 脉冲
    const pulses = L.layerGroup();
    for (const r of buildRanking().slice(0, 3)) {
      L.marker([r.lat, r.lon], {
        interactive: false,
        icon: L.divIcon({
          className: "",
          html: '<div class="pulse-wrap"><div class="pulse-ring"></div><div class="pulse-core"></div></div>',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        }),
      }).addTo(pulses);
    }
    pulses.addTo(map);
    state.layers.pulses = pulses;
  }

  function drawBoundaries() {
    L.geoJSON(state.china, {
      style: { color: "rgba(140,215,245,0.32)", weight: 1.0, fill: false },
      onEachFeature: (f, layer) =>
        layer.bindTooltip(f.properties.name, { sticky: true, opacity: 0.85 }),
    }).addTo(map);
    L.geoJSON(state.districts, {
      style: { color: "rgba(120,200,220,0.5)", weight: 1.0, fill: false, dashArray: "4 3" },
      onEachFeature: (f, layer) =>
        layer.bindTooltip("苏州 · " + f.properties.name, { sticky: true, opacity: 0.85 }),
    }).addTo(map);
  }

  function fillRangeSelects() {
    const opts = state.rain.days.map((d, i) => `<option value="${i}">${dayLabel(i)}</option>`).join("");
    $("range-start").innerHTML = opts;
    $("range-end").innerHTML = opts;
    $("range-start").value = "0";
    $("range-end").value = String(state.rain.days.length - 1);
  }

  async function boot() {
    const [rain, pack, districts, china] = await Promise.all([
      fetch("data/rain-grid.json").then((r) => r.json()),
      fetch("data/events.json").then((r) => r.json()),
      fetch("data/districts.geojson").then((r) => r.json()),
      fetch("data/china.geojson").then((r) => r.json()),
    ]);
    state.rain = rain;
    state.pack = pack;
    state.districts = districts;
    state.china = china;
    state.BBOX = rain.bbox;
    state.DAYS = rain.days;
    const aspect =
      (rain.bbox[3] - rain.bbox[1]) / (rain.bbox[2] - rain.bbox[0]);
    state.ROWS = Math.round(state.COLS * aspect);
    state.mask = RainIDW.rasterMask(china, state.BBOX, state.COLS, state.ROWS);
    state.suzhouMask = RainIDW.rasterMask(districts, state.BBOX, state.COLS, state.ROWS);

    map.fitBounds(
      [
        [rain.bbox[1], rain.bbox[0]],
        [rain.bbox[3], rain.bbox[2]],
      ],
      { padding: [10, 10] }
    );

    const inChinaCells = rain.cells.filter((c) => cellInsideMask(c, state.mask));
    const cnTotals = inChinaCells.map((c) => sum(c.d));
    $("stat-n").textContent = rain.stats.n + " 格点";
    $("stat-mean").textContent =
      "全国均 " + fmt(cnTotals.reduce((a, b) => a + b, 0) / cnTotals.length, 0) + " mm";
    $("stat-max").textContent = "峰值 " + fmt(Math.max(...cnTotals), 0) + " mm";
    if (pack.nationalUpdated) {
      $("foot-updated").textContent =
        `舆情更新 ${pack.nationalUpdated.slice(0, 16).replace("T", " ")}（${pack.nationalModel || "LLM"}） · 格点非自动站实况，仅供研判。`;
    }

    // 单日滑条刻度
    const ticks = document.querySelector(".day-ticks");
    ticks.innerHTML = rain.days.map((d) => `<span>${+d.slice(8, 10)}</span>`).join("");
    $("day-slider").max = String(rain.days.length - 1);

    fillRangeSelects();
    const slider = $("day-slider");
    slider.value = "0";
    $("day-label").textContent = dayLabel(0);
    drawBoundaries();
    setView({ kind: "day", idx: 0 }, false);
    renderRanking(buildRanking());
    drawEvents();

    slider.addEventListener("input", () => {
      const idx = +slider.value;
      $("day-label").textContent = dayLabel(idx);
      $("btn-maxhour").classList.remove("active");
      $("range-result").textContent = "";
      setView({ kind: "day", idx });
    });

    $("btn-maxhour").addEventListener("click", () => {
      const active = state.view.kind === "maxHour";
      if (active) {
        const idx = +slider.value;
        $("btn-maxhour").classList.remove("active");
        $("day-label").textContent = dayLabel(idx);
        setView({ kind: "day", idx });
      } else {
        $("btn-maxhour").classList.add("active");
        $("day-label").textContent = "小时雨强";
        setView({ kind: "maxHour" });
      }
    });

    $("range-go").addEventListener("click", () => {
      let a = +$("range-start").value;
      let b = +$("range-end").value;
      if (a > b) [a, b] = [b, a];
      const view = { kind: "range", a, b };
      $("btn-maxhour").classList.remove("active");
      setView(view);
      const inChina = state.rain.cells.filter((c) => cellInsideMask(c, state.mask));
      const peak = [...inChina].sort((x, y) => rangeSum(y, a, b) - rangeSum(x, a, b))[0];
      const inSz = suzhouCells();
      const szPeak = inSz.length
        ? [...inSz].sort((x, y) => rangeSum(y, a, b) - rangeSum(x, a, b))[0]
        : null;
      $("range-result").innerHTML =
        `${dayLabel(a)}–${dayLabel(b)}：全国峰值 <b>${fmt(rangeSum(peak, a, b), 0)} mm</b>（${placeName(peak)}）` +
        (szPeak
          ? ` · 苏州峰值 <b>${fmt(rangeSum(szPeak, a, b), 0)} mm</b>（${placeNameSz(szPeak)}）`
          : "");
    });

    document.querySelectorAll("[data-toggle]").forEach((b) => {
      b.addEventListener("click", () => {
        const key = b.dataset.toggle;
        state[key] = !state[key];
        b.classList.toggle("active", state[key]);
        drawEvents();
      });
    });

    // 移动端 tab
    document.querySelectorAll("#tabs button").forEach((b) => {
      b.addEventListener("click", () => {
        document.body.dataset.tab = b.dataset.goto;
        document
          .querySelectorAll("#tabs button")
          .forEach((x) => x.classList.toggle("active", x === b));
      });
    });
  }

  boot().catch((err) => {
    $("verdict").textContent = "数据加载失败：" + err.message;
    console.error(err);
  });
})();

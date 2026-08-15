/* Inverse-distance rain field + smooth color ramp. */
(function (global) {
  const STOPS_RAIN = [
    [0, [20, 36, 52, 0]],
    [8, [56, 96, 140, 40]],
    [20, [56, 168, 196, 130]],
    [35, [64, 196, 140, 165]],
    [50, [230, 214, 72, 188]],
    [70, [244, 148, 36, 205]],
    [95, [228, 56, 48, 220]],
    [125, [176, 16, 88, 230]],
  ];
  const STOPS_HOUR = [
    [0, [20, 36, 52, 0]],
    [3, [40, 120, 150, 80]],
    [8, [70, 190, 160, 150]],
    [15, [230, 210, 70, 190]],
    [25, [255, 122, 24, 210]],
    [40, [255, 45, 85, 230]],
  ];

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function mix4(c0, c1, t) {
    return [
      lerp(c0[0], c1[0], t),
      lerp(c0[1], c1[1], t),
      lerp(c0[2], c1[2], t),
      lerp(c0[3], c1[3], t),
    ];
  }
  function colorAt(value, stops) {
    if (value <= stops[0][0]) return stops[0][1].slice();
    for (let i = 1; i < stops.length; i++) {
      if (value <= stops[i][0]) {
        const t = (value - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
        const s = t * t * (3 - 2 * t); // smoothstep, avoids banding
        return mix4(stops[i - 1][1], stops[i][1], s);
      }
    }
    return stops[stops.length - 1][1].slice();
  }

  function idwGrid(points, bbox, cols, rows, power, maxDistDeg, mask) {
    const [west, south, east, north] = bbox;
    const field = new Float32Array(cols * rows);
    const dx = (east - west) / (cols - 1);
    const dy = (north - south) / (rows - 1);
    const r2 = maxDistDeg * maxDistDeg;

    // 空间分桶：桶宽 = 影响半径，3×3 邻域必含全部候选点
    const bs = maxDistDeg;
    const bkey = (bi, bj) => bi * 100003 + bj;
    const buckets = new Map();
    for (const p of points) {
      const k = bkey(Math.floor(p.lon / bs), Math.floor(p.lat / bs));
      let arr = buckets.get(k);
      if (!arr) buckets.set(k, (arr = []));
      arr.push(p);
    }

    for (let j = 0; j < rows; j++) {
      const lat = north - j * dy;
      const bj = Math.floor(lat / bs);
      for (let i = 0; i < cols; i++) {
        const fi = j * cols + i;
        if (mask && !mask[fi]) continue;
        const lon = west + i * dx;
        const bi = Math.floor(lon / bs);
        let num = 0;
        let den = 0;
        let exact = false;
        for (let u = bi - 1; u <= bi + 1 && !exact; u++) {
          for (let v = bj - 1; v <= bj + 1 && !exact; v++) {
            const arr = buckets.get(bkey(u, v));
            if (!arr) continue;
            for (const p of arr) {
              const dlon = lon - p.lon;
              const dlat = lat - p.lat;
              const d2 = dlon * dlon + dlat * dlat;
              if (d2 > r2) continue;
              if (d2 < 1e-12) {
                num = p.v;
                den = 1;
                exact = true;
                break;
              }
              const w = 1 / Math.pow(d2, power / 2);
              num += w * p.v;
              den += w;
            }
          }
        }
        if (den > 0) {
          field[fi] = num / den;
          continue;
        }
        // 影响半径内无点：逐圈外扩找最近点（规则格网下极少触发）
        let nearest = 0;
        let nearestD = Infinity;
        for (let ring = 2; ring <= 64 && nearestD === Infinity; ring++) {
          for (let u = bi - ring; u <= bi + ring; u++) {
            for (let v = bj - ring; v <= bj + ring; v++) {
              if (Math.max(Math.abs(u - bi), Math.abs(v - bj)) !== ring) continue;
              const arr = buckets.get(bkey(u, v));
              if (!arr) continue;
              for (const p of arr) {
                const d2 = (lon - p.lon) ** 2 + (lat - p.lat) ** 2;
                if (d2 < nearestD) {
                  nearestD = d2;
                  nearest = p.v;
                }
              }
            }
          }
        }
        field[fi] = nearest;
      }
    }
    return { field, dx, dy };
  }

  function rasterMask(geojson, bbox, cols, rows) {
    const canvas = document.createElement("canvas");
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext("2d");
    const [west, south, east, north] = bbox;
    const toX = (lon) => ((lon - west) / (east - west)) * (cols - 1);
    const toY = (lat) => ((north - lat) / (north - south)) * (rows - 1);
    ctx.fillStyle = "#fff";
    for (const f of geojson.features) {
      const polys =
        f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) {
        ctx.beginPath();
        poly.forEach((ring, ri) => {
          ring.forEach((p, i) => {
            const x = toX(p[0]);
            const y = toY(p[1]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
        });
        ctx.fill("evenodd");
      }
    }
    const px = ctx.getImageData(0, 0, cols, rows).data;
    const mask = new Uint8Array(cols * rows);
    for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3] > 8 ? 1 : 0;
    return mask;
  }

  function paint(canvas, field, cols, rows, stops, mask) {
    const ctx = canvas.getContext("2d");
    canvas.width = cols;
    canvas.height = rows;
    const img = ctx.createImageData(cols, rows);
    const data = img.data;
    for (let i = 0; i < field.length; i++) {
      if (mask && !mask[i]) continue;
      const c = colorAt(field[i], stops);
      const o = i * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = c[3];
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png");
  }

  function blend(a, b, t) {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
    return out;
  }

  function contours(field, cols, rows, bbox, levels) {
    // marching-squares isolines as Leaflet latlngs
    const [west, south, east, north] = bbox;
    const dx = (east - west) / (cols - 1);
    const dy = (north - south) / (rows - 1);
    const at = (i, j) => field[j * cols + i];
    const ll = (i, j) => [north - j * dy, west + i * dx];
    const out = [];
    for (const level of levels) {
      const segs = [];
      for (let j = 0; j < rows - 1; j++) {
        for (let i = 0; i < cols - 1; i++) {
          const v0 = at(i, j);
          const v1 = at(i + 1, j);
          const v2 = at(i + 1, j + 1);
          const v3 = at(i, j + 1);
          const b0 = v0 >= level ? 1 : 0;
          const b1 = v1 >= level ? 2 : 0;
          const b2 = v2 >= level ? 4 : 0;
          const b3 = v3 >= level ? 8 : 0;
          const idx = b0 | b1 | b2 | b3;
          if (idx === 0 || idx === 15) continue;
          const lerpE = (va, vb, pa, pb) => {
            const t = (level - va) / ((vb - va) || 1e-9);
            return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
          };
          const top = () => lerpE(v0, v1, ll(i, j), ll(i + 1, j));
          const right = () => lerpE(v1, v2, ll(i + 1, j), ll(i + 1, j + 1));
          const bottom = () => lerpE(v3, v2, ll(i, j + 1), ll(i + 1, j + 1));
          const left = () => lerpE(v0, v3, ll(i, j), ll(i, j + 1));
          const pairs = {
            1: [left, top],
            2: [top, right],
            3: [left, right],
            4: [right, bottom],
            5: [left, top, right, bottom],
            6: [top, bottom],
            7: [left, bottom],
            8: [bottom, left],
            9: [top, bottom],
            10: [top, right, bottom, left],
            11: [right, bottom],
            12: [right, left],
            13: [top, right],
            14: [top, left],
          }[idx];
          if (!pairs) continue;
          for (let p = 0; p < pairs.length; p += 2) {
            segs.push([pairs[p](), pairs[p + 1]()]);
          }
        }
      }
      out.push({ level, segs });
    }
    return out;
  }

  global.RainIDW = {
    STOPS_RAIN,
    STOPS_HOUR,
    colorAt,
    idwGrid,
    paint,
    blend,
    contours,
    rasterMask,
  };
})(window);

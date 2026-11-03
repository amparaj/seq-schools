/* SEQ School Explorer — plain Leaflet, no build step. */
(() => {
  "use strict";

  const SECTORS = [
    { key: "Government", short: "Government", cls: "gov", css: "--gov", shape: "circle" },
    { key: "Catholic", short: "Catholic", cls: "cath", css: "--cath", shape: "square" },
    { key: "Independent", short: "Independent", cls: "ind", css: "--ind", shape: "diamond" },
  ];
  const TYPE_COLORS = { Primary: "#7a5af5", Secondary: "#d1497f", Combined: "#2f9bb8" };
  const ICSEA_BANDS = [
    { max: 900, label: "< 900", color: "#e4d9f7" },
    { max: 1000, label: "900–999", color: "#b39ce6" },
    { max: 1100, label: "1000–1099", color: "#7b55cf" },
    { max: Infinity, label: "1100+", color: "#43208f" },
  ];
  const ICSEA_NONE = "#9aa1ad";

  const state = {
    yearIdx: 0,
    layers: new Set(SECTORS.map((s) => s.key)),
    types: new Set(["Primary", "Secondary", "Combined"]),
    lga: "",
    special: true,
    colorBy: "sector",
    sizeByEnr: true,
    cluster: true,
    inactive: false,
    selected: null,
    tab: "overview",
    catch: "",
  };

  let DATA, YEARS, map, tiles, groups = {}, playing = null;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => (n == null ? "–" : Number(n).toLocaleString("en-AU"));
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const sectorOf = (key) => SECTORS.find((s) => s.key === key);

  /* ---------------- theme ---------------- */
  function isDark() {
    const t = document.documentElement.dataset.theme;
    return t === "dark" || (!t && matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function applyTheme(mode) {
    if (mode === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
    try { localStorage.setItem("theme", mode); } catch (e) {}
    document.querySelectorAll("[data-theme-set]").forEach((b) => b.classList.toggle("on", b.dataset.themeSet === mode));
    if (map) {
      setTiles();
      render();
      restyleCatchments();
    }
  }
  function setTiles() {
    if (tiles) map.removeLayer(tiles);
    // Esri grey canvas basemap (no API key) with a separate labels layer on top.
    const style = isDark() ? "Dark_Gray" : "Light_Gray";
    const esri = (layer) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${style}_${layer}/MapServer/tile/{z}/{y}/{x}`;
    tiles = L.layerGroup([
      L.tileLayer(esri("Base"), {
        attribution: 'Basemap &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; OpenStreetMap contributors · Data: <a href="https://www.acara.edu.au/">ACARA</a>',
        maxNativeZoom: 16,
        maxZoom: 19,
      }),
      L.tileLayer(esri("Reference"), { maxNativeZoom: 16, maxZoom: 19 }),
    ]).addTo(map);
  }

  /* ---------------- markers ---------------- */
  function colorFor(s, v) {
    if (state.colorBy === "type") return TYPE_COLORS[s.type] || ICSEA_NONE;
    if (state.colorBy === "icsea") {
      const x = s.icsea[state.yearIdx];
      if (x == null) return ICSEA_NONE;
      return ICSEA_BANDS.find((b) => x < b.max).color;
    }
    return v.sectorColor;
  }

  function shapeSvg(shape, size, fill, faded) {
    const h = size / 2, sw = 1.6, stroke = faded ? fill : "#fff";
    const dash = faded ? ' stroke-dasharray="2.5 2"' : "";
    const fo = faded ? 0.25 : 1;
    let body;
    if (shape === "square") {
      const p = 1.5;
      body = `<rect x="${p}" y="${p}" width="${size - 2 * p}" height="${size - 2 * p}" rx="${size * 0.22}"`;
    } else if (shape === "diamond") {
      const p = 1;
      body = `<polygon points="${h},${p} ${size - p},${h} ${h},${size - p} ${p},${h}"`;
    } else {
      body = `<circle cx="${h}" cy="${h}" r="${h - 1.2}"`;
    }
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body} fill="${fill}" fill-opacity="${fo}" stroke="${stroke}" stroke-width="${sw}"${dash}/></svg>`;
  }

  function markerSize(s) {
    if (!state.sizeByEnr) return 16;
    const e = s.enr[state.yearIdx];
    if (e == null) return 12;
    return Math.round(Math.min(36, Math.max(11, 9 + Math.sqrt(e) * 0.6)));
  }

  function makeGroup(sector) {
    if (!state.cluster) return L.layerGroup();
    return L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 45,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 14,
      iconCreateFunction: (c) => {
        const n = c.getChildCount();
        const d = Math.round(Math.min(46, 26 + Math.sqrt(n) * 2.6));
        return L.divIcon({
          html: `<div class="cluster ${sector.cls}" style="width:${d}px;height:${d}px">${n}</div>`,
          className: "",
          iconSize: [d, d],
        });
      },
    });
  }

  function rebuildGroups() {
    Object.values(groups).forEach((g) => map.removeLayer(g));
    groups = {};
    SECTORS.forEach((sec) => (groups[sec.key] = makeGroup(sec).addTo(map)));
  }

  function passesFilters(s) {
    if (!state.types.has(s.type)) return false;
    if (state.lga && s.lga !== state.lga) return false;
    if (!state.special && s.special) return false;
    return true;
  }
  const reporting = (s) => s.enr[state.yearIdx] != null;

  function render() {
    const counts = {};
    const sectorColors = Object.fromEntries(SECTORS.map((s) => [s.key, cssVar(s.css)]));
    const batches = Object.fromEntries(SECTORS.map((s) => [s.key, []]));

    for (const s of DATA.schools) {
      if (!passesFilters(s)) continue;
      const active = reporting(s);
      if (active) counts[s.sector] = (counts[s.sector] || 0) + 1;
      if (!state.layers.has(s.sector)) continue;
      if (!active && !state.inactive) continue;

      const sec = sectorOf(s.sector);
      const size = markerSize(s);
      const fill = colorFor(s, { sectorColor: sectorColors[s.sector] });
      const icon = L.divIcon({
        html: shapeSvg(sec.shape, size, fill, !active),
        className: "school-icon" + (state.selected === s.id ? " sel" : ""),
        iconSize: [size, size],
      });
      const m = L.marker([s.lat, s.lng], { icon, keyboard: false, riseOnHover: true, zIndexOffset: s.enr[state.yearIdx] || 0 });
      m.bindTooltip(
        `<strong>${esc(s.name)}</strong><br><span class="muted">${esc(s.type)} · ${active ? fmt(s.enr[state.yearIdx]) + " students" : "not reporting"}</span>`,
        { direction: "top", offset: [0, -size / 2] }
      );
      m.on("click", () => select(s.id, false));
      batches[s.sector].push(m);
    }

    SECTORS.forEach((sec) => {
      const g = groups[sec.key];
      g.clearLayers();
      if (g.addLayers) g.addLayers(batches[sec.key]);
      else batches[sec.key].forEach((m) => g.addLayer(m));
    });

    renderChips(counts);
    renderSectorToggles(counts);
    renderLegend();
    renderTimeline();
    if (state.selected != null) renderDetail();
  }

  /* ---------------- header chips + layer toggles ---------------- */
  function glyph(sec, size = 18) {
    return `<span class="glyph">${shapeSvg(sec.shape, size, cssVar(sec.css), false)}</span>`;
  }

  function renderChips(counts) {
    $("sector-chips").innerHTML = SECTORS.map(
      (sec) => `<button class="chip${state.layers.has(sec.key) ? "" : " off"}" data-sector="${sec.key}" title="Toggle ${sec.key} schools">
        ${glyph(sec)} ${sec.short} <span class="mono">${fmt(counts[sec.key] || 0)}</span></button>`
    ).join("");
  }

  function renderSectorToggles(counts) {
    $("sector-count").textContent = `${state.layers.size} of ${SECTORS.length} on`;
    $("sector-toggles").innerHTML = SECTORS.map(
      (sec) => `<label class="switch"><span class="lbl">${glyph(sec, 16)} ${sec.key} <span class="mono muted">${fmt(counts[sec.key] || 0)}</span></span>
        <input type="checkbox" data-sector="${sec.key}" ${state.layers.has(sec.key) ? "checked" : ""}><i></i></label>`
    ).join("");
  }

  function toggleSector(key) {
    state.layers.has(key) ? state.layers.delete(key) : state.layers.add(key);
    render();
  }

  function renderLegend() {
    const el = $("color-legend");
    if (state.colorBy === "type") {
      el.innerHTML = Object.entries(TYPE_COLORS).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join("");
    } else if (state.colorBy === "icsea") {
      el.innerHTML =
        ICSEA_BANDS.map((b) => `<span><i style="background:${b.color}"></i>${b.label}</span>`).join("") +
        `<span><i style="background:${ICSEA_NONE}"></i>No ICSEA</span>`;
    } else {
      el.innerHTML = "";
    }
  }

  /* ---------------- timeline ---------------- */
  function renderTimeline() {
    const totals = YEARS.map((_, i) => {
      const t = {};
      for (const s of DATA.schools) {
        if (!passesFilters(s) || !state.layers.has(s.sector)) continue;
        const e = s.enr[i];
        if (e != null) t[s.sector] = (t[s.sector] || 0) + e;
      }
      return t;
    });
    const sum = (t) => Object.values(t).reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...totals.map(sum));

    $("bars").innerHTML = YEARS.map((y, i) => {
      const segs = SECTORS.slice().reverse()
        .map((sec) => {
          const v = totals[i][sec.key] || 0;
          return v ? `<div class="seg-s" style="height:${(v / max) * 100}%;background:var(${sec.css})"></div>` : "";
        }).join("");
      return `<button class="bar${i === state.yearIdx ? " on" : ""}" data-i="${i}" role="option" aria-selected="${i === state.yearIdx}"
        title="${y}: ${fmt(sum(totals[i]))} students">${segs}<span class="yl">${String(y).slice(2)}</span></button>`;
    }).join("");

    const yr = YEARS[state.yearIdx];
    $("year-label").textContent = yr;
    $("year-total").textContent = `${fmt(sum(totals[state.yearIdx]))} students`;
  }

  function setYear(i) {
    state.yearIdx = Math.max(0, Math.min(YEARS.length - 1, i));
    writeHash();
    render();
  }

  function togglePlay() {
    const btn = $("play");
    if (playing) {
      clearInterval(playing);
      playing = null;
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
      btn.setAttribute("aria-label", "Play");
      return;
    }
    if (state.yearIdx === YEARS.length - 1) setYear(0);
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>';
    btn.setAttribute("aria-label", "Pause");
    playing = setInterval(() => {
      if (state.yearIdx >= YEARS.length - 1) return togglePlay();
      setYear(state.yearIdx + 1);
    }, 900);
  }

  /* ---------------- benchmarks (SEQ median + middle half, by school type) ---------------- */
  const BENCH = {};
  function quantile(sorted, q) {
    const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
  }
  function benchFor(type, key) {
    const id = type + "|" + key;
    if (!BENCH[id]) {
      BENCH[id] = YEARS.map((_, i) => {
        const v = DATA.schools
          .filter((s) => s.type === type && !s.special && s[key][i] != null)
          .map((s) => s[key][i])
          .sort((a, b) => a - b);
        return v.length < 5 ? null : { n: v.length, p25: quantile(v, 0.25), p50: quantile(v, 0.5), p75: quantile(v, 0.75) };
      });
    }
    return BENCH[id];
  }

  /* ---------------- charts ---------------- */
  function niceTicks(lo, hi, count = 4) {
    const span = hi - lo || 1;
    const step0 = span / count, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
    const start = Math.floor(lo / step) * step, ticks = [];
    for (let t = start; t <= hi + step * 0.001; t += step) ticks.push(+t.toFixed(6));
    if (ticks[ticks.length - 1] < hi) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }

  function lineChart({ values, color, bench, fmtV = fmt }) {
    const W = 300, H = 132, L = 38, R = 8, T = 8, B = 20;
    const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
    if (pts.length < 2) return `<p class="muted small">Not enough data to chart.</p>`;
    const all = pts.map(([, v]) => v);
    if (bench) bench.forEach((b) => b && all.push(b.p25, b.p75));
    const ticks = niceTicks(Math.min(0, ...all) < 0 ? Math.min(...all) : Math.min(...all) * 0.9, Math.max(...all));
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const x = (i) => L + (i / (YEARS.length - 1)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const ci = state.yearIdx;

    let g = "";
    ticks.forEach((t) => {
      g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/>`;
      g += `<text x="${L - 6}" y="${y(t) + 3.5}" text-anchor="end" class="tick">${fmtV(t)}</text>`;
    });
    YEARS.forEach((yr, i) => {
      if (yr % 4 === 0) g += `<text x="${x(i)}" y="${H - 5}" text-anchor="middle" class="tick">${yr}</text>`;
    });
    if (bench) {
      const segs = bench.map((b, i) => (b ? [i, b] : null)).filter(Boolean);
      if (segs.length > 1) {
        const top = segs.map(([i, b]) => `${x(i)},${y(b.p75)}`).join(" ");
        const bot = segs.slice().reverse().map(([i, b]) => `${x(i)},${y(b.p25)}`).join(" ");
        g += `<polygon points="${top} ${bot}" class="band"/>`;
        g += `<polyline points="${segs.map(([i, b]) => `${x(i)},${y(b.p50)}`).join(" ")}" class="median"/>`;
      }
    }
    g += `<line x1="${x(ci)}" x2="${x(ci)}" y1="${T}" y2="${H - B}" class="cursor"/>`;
    const d = pts.map(([i, v], k) => `${k && pts[k - 1][0] === i - 1 ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    g += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`;
    pts.forEach(([i, v]) => {
      const on = i === ci;
      g += `<circle cx="${x(i)}" cy="${y(v)}" r="${on ? 4.5 : 2.6}" fill="${color}" ${on ? 'stroke="var(--bg)" stroke-width="2"' : ""}><title>${YEARS[i]}: ${fmtV(v)}</title></circle>`;
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}">${g}</svg>`;
  }

  function chartCard(title, unit, body, note) {
    return `<div class="card"><div class="card-head"><h4>${title}</h4><span class="mono muted">${unit}</span></div>${body}${note ? `<p class="note">${note}</p>` : ""}</div>`;
  }

  function stackBar(parts) {
    return `<div class="stackbar">${parts.filter((p) => p.v > 0).map((p) =>
      `<span style="flex:${p.v};background:${p.c}" title="${esc(p.label)}: ${p.v}%"></span>`).join("")}</div>
      <div class="legend">${parts.map((p) => `<span><i style="background:${p.c}"></i>${esc(p.label)} ${p.v ?? "–"}%</span>`).join("")}</div>`;
  }

  /* ---------------- detail panel ---------------- */
  const TABS = [["overview", "Overview"], ["students", "Students"], ["trends", "Trends"], ["naplan", "NAPLAN"]];
  const CATCH_FOR_TYPE = { Primary: "primary", Combined: "primary", Secondary: "junior" };

  function benchLine(s, key, i, fmtV = fmt) {
    if (s.special) return "";
    const b = benchFor(s.type, key)[i];
    return b ? `<div class="cmp">SEQ ${s.type.toLowerCase()} median ${fmtV(b.p50)}</div>` : "";
  }

  function overviewTab(s, i, col) {
    const website = s.url ? (/^https?:/i.test(s.url) ? s.url : "https://" + s.url) : null;
    const r1 = (v) => (v == null ? "–" : (+v).toFixed(1));
    const hasCatch = s.sector === "Government" && !s.special;
    return `
      <div class="stats">
        <div class="stat"><div class="k">Students</div><div class="v">${fmt(s.enr[i])}</div>${benchLine(s, "enr", i, (v) => fmt(Math.round(v)))}</div>
        <div class="stat"><div class="k">ICSEA</div><div class="v">${fmt(s.icsea[i])}${s.pct[i] != null ? `<small>${s.pct[i]}th pct</small>` : ""}</div>${benchLine(s, "icsea", i, (v) => fmt(Math.round(v)))}</div>
        <div class="stat"><div class="k">Teachers (FTE)</div><div class="v">${r1(s.tfte[i])}</div>${benchLine(s, "tfte", i, r1)}</div>
        <div class="stat"><div class="k">Students per teacher</div><div class="v">${r1(s.ratio[i])}</div>${benchLine(s, "ratio", i, r1)}</div>
        <div class="stat"><div class="k">Non-teaching staff (FTE)</div><div class="v">${r1(s.nfte[i])}</div>${benchLine(s, "nfte", i, r1)}</div>
        <div class="stat"><div class="k">Year levels</div><div class="v">${esc(s.yr || "–")}</div></div>
      </div>
      ${s.gov ? `<p class="muted small" style="margin:0 0 10px">Governing body: ${esc(s.gov)}</p>` : ""}
      <div class="links">
        ${hasCatch ? `<a href="#" id="show-catchment">Show catchment on map <span>${state.catch ? "fit to view" : "turns on layer"}</span></a>` : ""}
        <a class="primary" href="https://www.myschool.edu.au/school/${s.id}" target="_blank" rel="noopener">My School profile <span>NAPLAN, finances ↗</span></a>
        ${website ? `<a href="${esc(website)}" target="_blank" rel="noopener">School website <span>↗</span></a>` : ""}
        <a href="https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}" target="_blank" rel="noopener">Open in Google Maps <span>↗</span></a>
      </div>`;
  }

  function studentsTab(s, i) {
    const g = s.girls[i], b = s.boys[i], tot = (g || 0) + (b || 0);
    const gp = tot ? Math.round((g / tot) * 100) : null;
    const q = [s.q1[i], s.q2[i], s.q3[i], s.q4[i]];
    return `
      ${chartCard("Girls and boys", fmt(tot || null), tot ? stackBar([
        { label: "Girls", v: gp, c: "#c25aa0" },
        { label: "Boys", v: 100 - gp, c: "#3d7fc4" },
      ]) : `<p class="muted small">Not reported.</p>`)}
      ${chartCard("Socio-educational advantage", "quarters", q.some((v) => v != null) ? stackBar([
        { label: "Bottom", v: q[0], c: "#e4d9f7" },
        { label: "Lower middle", v: q[1], c: "#b39ce6" },
        { label: "Upper middle", v: q[2], c: "#7b55cf" },
        { label: "Top", v: q[3], c: "#43208f" },
      ]) : `<p class="muted small">Not reported.</p>`,
        "Share of students in each national quarter of socio-educational advantage. Australia-wide, each quarter holds 25%.")}
      <div class="stats">
        <div class="stat"><div class="k">Indigenous students</div><div class="v">${s.ind[i] ?? "–"}<small>%</small></div>${benchLine(s, "ind", i, (v) => Math.round(v) + "%")}</div>
        <div class="stat"><div class="k">Language other than English</div><div class="v">${s.lbote[i] ?? "–"}<small>%</small></div>${benchLine(s, "lbote", i, (v) => Math.round(v) + "%")}</div>
      </div>`;
  }

  function trendsTab(s, col) {
    const bench = (key) => (s.special ? null : benchFor(s.type, key));
    const r1 = (v) => (+v).toFixed(Math.abs(v) < 100 ? 1 : 0).replace(/\.0$/, "");
    const note = s.special ? "" : `Dashed line: median of SEQ ${s.type.toLowerCase()} schools; shaded band: the middle half.`;
    return [
      chartCard("Students", "enrolments", lineChart({ values: s.enr, color: col, bench: bench("enr") }), note),
      chartCard("Students per teacher", "ratio", lineChart({ values: s.ratio, color: col, bench: bench("ratio"), fmtV: r1 }),
        "Enrolments divided by teaching staff (FTE). Descriptive, not a quality measure."),
      chartCard("Teachers", "FTE", lineChart({ values: s.tfte, color: col, bench: bench("tfte"), fmtV: r1 })),
      chartCard("Non-teaching staff", "FTE", lineChart({ values: s.nfte, color: col, bench: bench("nfte"), fmtV: r1 })),
      chartCard("ICSEA", "index", lineChart({ values: s.icsea, color: "#7b55cf", bench: bench("icsea") }),
        "Index of Community Socio-Educational Advantage. The national average is 1000."),
      chartCard("Language other than English", "%", lineChart({ values: s.lbote, color: col, bench: bench("lbote") })),
      chartCard("Indigenous students", "%", lineChart({ values: s.ind, color: col, bench: bench("ind") })),
    ].join("");
  }

  function naplanTab(s) {
    const ms = `https://www.myschool.edu.au/school/${s.id}`;
    return `
      <p class="small" style="margin-top:0">NAPLAN results and student progress for ${esc(s.name)} are published on My School.</p>
      <div class="links">
        <a class="primary" href="${ms}/naplan/results" target="_blank" rel="noopener">NAPLAN results <span>by year level & domain ↗</span></a>
        <a href="${ms}/naplan" target="_blank" rel="noopener">Student progress <span>gain vs similar students ↗</span></a>
      </div>
      <p class="note">My School's terms of use (clause 6.4) don't allow its content to be reposted on another public website without ACARA's written permission, so the results aren't copied into this map. School-level NAPLAN data can be requested through ACARA's <a href="https://www.acara.edu.au/contact-us/acara-data-access" target="_blank" rel="noopener">data access program</a>.</p>`;
  }

  function renderDetail() {
    const s = DATA.schools.find((x) => x.id === state.selected);
    const el = $("detail");
    if (!s) { el.hidden = true; return; }
    const i = state.yearIdx, yr = YEARS[i];
    const sec = sectorOf(s.sector), col = cssVar(sec.css);
    const scroll = el.querySelector(".detail-body")?.scrollTop || 0;

    const body = {
      overview: () => overviewTab(s, i, col),
      students: () => studentsTab(s, i),
      trends: () => trendsTab(s, col),
      naplan: () => naplanTab(s),
    }[state.tab]();

    el.innerHTML = `
      <div class="detail-head">
        <div class="eyebrow"><i style="background:${col}"></i>${esc(s.sector)} school</div>
        <h2>${esc(s.name)}</h2>
        <button class="icon-btn" id="detail-close" title="Close">&times;</button>
        <div class="tags">
          <span class="tag">${esc(s.type)}</span>
          ${s.yr ? `<span class="tag">${esc(s.yr)}</span>` : ""}
          ${s.special ? `<span class="tag">Special school</span>` : ""}
          <span class="tag">${esc(s.suburb)} ${esc(s.postcode)}</span>
          <span class="tag">${esc(s.lga)}</span>
        </div>
        <nav class="tabs" role="tablist">${TABS.map(([k, label]) =>
          `<button role="tab" data-tab="${k}" class="${state.tab === k ? "on" : ""}" aria-selected="${state.tab === k}">${label}</button>`).join("")}</nav>
      </div>
      <div class="detail-body">
        ${state.tab !== "naplan" ? `<p class="muted small" style="margin:0 0 8px"><span class="mono">${yr}</span>${s.enr[i] == null ? " · no data reported this year" : ""}</p>` : ""}
        ${body}
      </div>`;
    el.hidden = false;
    el.querySelector(".detail-body").scrollTop = scroll;
    $("detail-close").onclick = () => select(null);
    el.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => {
      state.tab = b.dataset.tab;
      writeHash();
      renderDetail();
      el.querySelector(".detail-body").scrollTop = 0;
    }));
    const sc = $("show-catchment");
    if (sc) sc.onclick = (e) => { e.preventDefault(); showCatchmentOf(s); };
  }

  /* ---------------- catchments ---------------- */
  const catchCache = {};
  let catchLayer = null, catchRenderer = null;

  function catchStyle(f) {
    const dark = isDark();
    const sel = f.properties.id === state.selected;
    const gov = cssVar("--gov");
    return sel
      ? { color: gov, weight: 3, opacity: 1, fillColor: gov, fillOpacity: 0.14 }
      : { color: dark ? "#c9d1df" : "#33415c", weight: 1, opacity: dark ? 0.55 : 0.6, fillColor: dark ? "#c9d1df" : "#33415c", fillOpacity: 0.03 };
  }

  async function setCatchments(key) {
    state.catch = key;
    document.querySelectorAll("#catch-by button").forEach((b) => b.classList.toggle("on", b.dataset.v === key));
    $("catch-status").textContent = key ? "on" : "off";
    writeHash();
    if (catchLayer) { map.removeLayer(catchLayer); catchLayer = null; }
    if (!key) { if (state.selected != null) renderDetail(); return; }
    try {
      if (!catchCache[key]) {
        $("catch-status").textContent = "loading…";
        catchCache[key] = await fetch(`data/catchments-${key}.geojson`).then((r) => r.json());
      }
    } catch (err) {
      $("catch-status").textContent = "failed to load";
      return;
    }
    if (state.catch !== key) return; // switched again while loading
    $("catch-status").textContent = "on";
    catchRenderer = catchRenderer || L.canvas({ padding: 0.5 });
    catchLayer = L.geoJSON(catchCache[key], {
      renderer: catchRenderer,
      style: catchStyle,
      onEachFeature: (f, layer) => {
        layer.bindTooltip(`<strong>${esc(f.properties.name)}</strong><br><span class="muted">catchment · click to open</span>`, { sticky: true });
        layer.on("mouseover", () => layer.setStyle({ weight: 2.5, fillOpacity: 0.1 }));
        layer.on("mouseout", () => catchLayer && catchLayer.resetStyle(layer));
        layer.on("click", () => f.properties.id && select(f.properties.id, false));
      },
    }).addTo(map);
    if (state.selected != null) renderDetail();
  }

  function restyleCatchments() {
    if (catchLayer) catchLayer.setStyle(catchStyle);
  }

  async function showCatchmentOf(s) {
    const order = [CATCH_FOR_TYPE[s.type] || "primary", "primary", "junior", "senior"];
    const key = state.catch && order.includes(state.catch) && hasCatchment(state.catch, s.id) ? state.catch : null;
    for (const k of key ? [key] : order) {
      if (state.catch !== k) await setCatchments(k);
      if (!catchLayer) return;
      const hit = catchLayer.getLayers().find((l) => l.feature.properties.id === s.id);
      if (hit) { map.flyToBounds(hit.getBounds(), { padding: [40, 40], duration: 0.8 }); return; }
    }
  }
  function hasCatchment(key, id) {
    return !!catchCache[key] && catchCache[key].features.some((f) => f.properties.id === id);
  }

  function select(id, fly = true) {
    state.selected = id;
    writeHash();
    render();
    restyleCatchments();
    if (id == null) { $("detail").hidden = true; return; }
    const s = DATA.schools.find((x) => x.id === id);
    if (s && fly) map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 15), { duration: 0.8 });
  }

  /* ---------------- search ---------------- */
  function setupSearch() {
    const input = $("search"), list = $("search-results");
    let hits = [], active = 0;

    const draw = () => {
      if (!hits.length) { list.hidden = true; return; }
      list.innerHTML = hits.map((s, k) => {
        const sec = sectorOf(s.sector);
        return `<li role="option" data-id="${s.id}" class="${k === active ? "active" : ""}">
          ${glyph(sec, 14)}<div><div>${esc(s.name)}</div><div class="sub">${esc(s.suburb)} ${esc(s.postcode)} · ${esc(s.type)}</div></div></li>`;
      }).join("");
      list.hidden = false;
    };

    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      active = 0;
      if (q.length < 2) { hits = []; return draw(); }
      const starts = [], has = [];
      for (const s of DATA.schools) {
        const n = s.name.toLowerCase();
        if (n.startsWith(q)) starts.push(s);
        else if (n.includes(q) || s.suburb.toLowerCase().includes(q) || s.postcode.startsWith(q)) has.push(s);
      }
      hits = starts.concat(has).slice(0, 10);
      draw();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { active = Math.min(hits.length - 1, active + 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter" && hits[active]) pick(hits[active].id);
      else if (e.key === "Escape") { hits = []; draw(); input.blur(); }
    });
    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li");
      if (li) { e.preventDefault(); pick(+li.dataset.id); }
    });
    input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 100));
    input.addEventListener("focus", () => hits.length && draw());

    function pick(id) {
      const s = DATA.schools.find((x) => x.id === id);
      // Make sure the picked school is visible under the current filters.
      state.layers.add(s.sector);
      state.types.add(s.type);
      if (state.lga && state.lga !== s.lga) { state.lga = ""; $("lga-filter").value = ""; }
      if (s.special) { state.special = true; $("opt-special").checked = true; }
      if (!reporting(s)) { state.inactive = true; $("opt-inactive").checked = true; }
      syncPills();
      input.value = s.name;
      hits = [];
      draw();
      input.blur();
      select(id);
    }

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.focus(); input.select(); }
    });
  }

  /* ---------------- URL hash (#s=46410&y=2025&c=primary) ---------------- */
  function writeHash() {
    const p = new URLSearchParams();
    if (state.selected != null) p.set("s", state.selected);
    if (state.yearIdx !== YEARS.length - 1) p.set("y", YEARS[state.yearIdx]);
    if (state.catch) p.set("c", state.catch);
    if (state.selected != null && state.tab !== "overview") p.set("t", state.tab);
    const h = p.toString();
    history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const y = YEARS.indexOf(+p.get("y"));
    if (y >= 0) state.yearIdx = y;
    const id = +p.get("s");
    if (id && DATA.schools.some((s) => s.id === id)) state.selected = id;
    if (["primary", "junior", "senior"].includes(p.get("c"))) state.catch = p.get("c");
    if (TABS.some(([k]) => k === p.get("t"))) state.tab = p.get("t");
  }

  /* ---------------- controls ---------------- */
  function syncPills() {
    document.querySelectorAll("#type-filter button").forEach((b) => b.classList.toggle("on", state.types.has(b.dataset.v)));
  }

  function setupControls() {
    document.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip[data-sector]");
      if (chip) toggleSector(chip.dataset.sector);
      const bar = e.target.closest(".bar");
      if (bar) setYear(+bar.dataset.i);
    });
    $("sector-toggles").addEventListener("change", (e) => {
      if (e.target.dataset.sector) toggleSector(e.target.dataset.sector);
    });

    $("color-by").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      state.colorBy = b.dataset.v;
      $("color-by").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      render();
    });

    $("type-filter").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const v = b.dataset.v;
      state.types.has(v) ? state.types.delete(v) : state.types.add(v);
      syncPills();
      render();
    });

    const lgas = [...new Set(DATA.schools.map((s) => s.lga))].sort();
    $("lga-filter").insertAdjacentHTML("beforeend", lgas.map((l) => `<option>${esc(l)}</option>`).join(""));
    $("lga-filter").addEventListener("change", (e) => {
      state.lga = e.target.value;
      render();
      const pts = DATA.schools.filter((s) => !state.lga || s.lga === state.lga).map((s) => [s.lat, s.lng]);
      if (pts.length) map.flyToBounds(pts, { padding: [40, 40], duration: 0.8 });
    });

    $("catch-by").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) setCatchments(b.dataset.v);
    });

    $("opt-special").addEventListener("change", (e) => { state.special = e.target.checked; render(); });
    $("opt-size").addEventListener("change", (e) => { state.sizeByEnr = e.target.checked; render(); });
    $("opt-inactive").addEventListener("change", (e) => { state.inactive = e.target.checked; render(); });
    $("opt-cluster").addEventListener("change", (e) => { state.cluster = e.target.checked; rebuildGroups(); render(); });

    $("panel-close").onclick = () => { $("panel").hidden = true; $("panel-open").hidden = false; };
    $("panel-open").onclick = () => { $("panel").hidden = false; $("panel-open").hidden = true; };
    if (innerWidth <= 640) $("panel-close").click();

    $("play").onclick = togglePlay;
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, select, textarea")) return;
      if (e.key === "ArrowLeft") setYear(state.yearIdx - 1);
      else if (e.key === "ArrowRight") setYear(state.yearIdx + 1);
      else if (e.key === "Escape" && state.selected != null) select(null);
    });

    document.querySelectorAll("[data-theme-set]").forEach((b) => (b.onclick = () => applyTheme(b.dataset.themeSet)));
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (!document.documentElement.dataset.theme) { setTiles(); render(); restyleCatchments(); }
    });

    $("bar-legend").innerHTML = SECTORS.map((s) => `<span><i style="background:var(${s.css})"></i>${s.key}</span>`).join("");
  }

  /* ---------------- boot ---------------- */
  let savedTheme = "auto";
  try { savedTheme = localStorage.getItem("theme") || "auto"; } catch (e) {}
  applyTheme(savedTheme);

  fetch("data/schools.json")
    .then((r) => r.json())
    .then((d) => {
      DATA = d;
      YEARS = d.years;
      state.yearIdx = YEARS.length - 1;
      for (const s of d.schools) {
        s.ratio = s.enr.map((e, i) => (e != null && s.tfte[i] ? +(e / s.tfte[i]).toFixed(1) : null));
      }
      readHash();

      map = L.map("map", { zoomControl: false, preferCanvas: false }).fitBounds(
        d.schools.map((s) => [s.lat, s.lng]), { padding: [20, 20] }
      );
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
      setTiles();
      rebuildGroups();
      setupControls();
      setupSearch();
      render();
      if (state.catch) setCatchments(state.catch);

      if (state.selected != null) {
        const s = DATA.schools.find((x) => x.id === state.selected);
        map.setView([s.lat, s.lng], 15);
      }
    })
    .catch((err) => {
      document.getElementById("map").innerHTML =
        `<p style="padding:24px">Couldn't load school data (${esc(err.message)}). If you opened index.html directly, serve the folder instead: <code>python -m http.server</code></p>`;
    });
})();

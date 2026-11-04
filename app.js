/* SEQ Schools Explorer — plain Leaflet, no build step. */
(() => {
  "use strict";

  const SECTORS = [
    { key: "Government", short: "Government", cls: "gov", css: "--gov", shape: "circle" },
    { key: "Catholic", short: "Catholic", cls: "cath", css: "--cath", shape: "square" },
    { key: "Independent", short: "Independent", cls: "ind", css: "--ind", shape: "diamond" },
  ];
  const TYPE_COLORS = { Primary: "#e0663f", Secondary: "#2f6db3", Combined: "#4f9a3a" };
  const ICSEA_BANDS = [
    { max: 900, label: "< 900", color: "#f3d9df" },
    { max: 1000, label: "900–999", color: "#dc93a6" },
    { max: 1100, label: "1000–1099", color: "#a8405f" },
    { max: Infinity, label: "1100+", color: "#5e1029" },
  ];
  const ICSEA_NONE = "#9aa1ad";
  const ICSEA = `<abbr title="Index of Community Socio-Educational Advantage">ICSEA</abbr>`;
  // Compared schools get categorical slots 1–4 (CSS vars --c1..--c4), fixed by position.
  const MAX_COMPARE = 4;
  const cmpColor = (k) => cssVar(`--c${k + 1}`);

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
    compare: [], // further school ids shown alongside `selected`
    picking: false, // while true, map clicks and search add to the comparison
    tab: "overview",
    catchMode: "", // level drawn when no school is selected: "", "primary", "junior" or "senior"
    catch: "", // the catchment layer on the map now ("" for none)
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
        className: "school-icon" + (inView(s.id) ? " sel" : ""),
        iconSize: [size, size],
      });
      const m = L.marker([s.lat, s.lng], { icon, keyboard: false, riseOnHover: true, zIndexOffset: s.enr[state.yearIdx] || 0 });
      m.bindTooltip(
        `<strong>${esc(s.name)}</strong><br><span class="muted">${esc(s.type)} · ${active ? fmt(s.enr[state.yearIdx]) + " students" : "not reporting"}</span>`,
        { direction: "top", offset: [0, -size / 2] }
      );
      m.on("click", () => choose(s.id, false));
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
    renderYear();
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
        `<span><i style="background:${ICSEA_NONE}"></i>No ${ICSEA}</span>`;
    } else {
      el.innerHTML = SECTORS.map((sec) => `<span>${glyph(sec, 12)}${sec.key}</span>`).join("");
    }
  }

  /* ---------------- year control ---------------- */
  function renderYear() {
    $("year-label").textContent = YEARS[state.yearIdx];
    $("year-range").value = state.yearIdx;
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

  // `series` is [{values, color, name}]; a single school can pass `values` and `color` instead.
  function lineChart({ values, color, series, bench, fmtV = fmt }) {
    const W = 300, H = 132, L = 38, R = 8, T = 8, B = 20;
    series = (series || [{ values, color }]).map((sr) => ({
      ...sr, pts: sr.values.map((v, i) => [i, v]).filter(([, v]) => v != null),
    }));
    if (!series.some((sr) => sr.pts.length >= 2)) return `<p class="muted small">Not enough data to chart.</p>`;
    const all = series.flatMap((sr) => sr.pts.map(([, v]) => v));
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
    series.forEach(({ pts, color, name }) => {
      const d = pts.map(([i, v], k) => `${k && pts[k - 1][0] === i - 1 ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
      g += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`;
      pts.forEach(([i, v]) => {
        const on = i === ci;
        g += `<circle cx="${x(i)}" cy="${y(v)}" r="${on ? 4.5 : 2.6}" fill="${color}" ${on ? 'stroke="var(--bg)" stroke-width="2"' : ""}><title>${name ? esc(name) + ", " : ""}${YEARS[i]}: ${fmtV(v)}</title></circle>`;
      });
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}">${g}</svg>`;
  }

  function chartCard(title, unit, body, note) {
    return `<div class="card"><div class="card-head"><h4>${title}</h4><span class="mono muted">${unit}</span></div>${body}${note ? `<p class="note">${note}</p>` : ""}</div>`;
  }

  function stackBar(parts, legend = true) {
    return `<div class="stackbar">${parts.filter((p) => p.v > 0).map((p) =>
      `<span style="flex:${p.v};background:${p.c}" title="${esc(p.label)}: ${p.v}%"></span>`).join("")}</div>
      ${legend ? stackLegend(parts) : ""}`;
  }
  function stackLegend(parts, values = true) {
    return `<div class="legend">${parts.map((p) => `<span><i style="background:${p.c}"></i>${esc(p.label)}${values ? ` ${p.v ?? "–"}%` : ""}</span>`).join("")}</div>`;
  }

  /* ---------------- detail panel ---------------- */
  const TABS = [["overview", "Overview"], ["students", "Students"], ["trends", "Trends"], ["report", "Report"], ["naplan", "NAPLAN"]];
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
        <div class="stat"><div class="k">${ICSEA}</div><div class="v">${fmt(s.icsea[i])}${s.pct[i] != null ? `<small>${s.pct[i]}th pct</small>` : ""}</div>${benchLine(s, "icsea", i, (v) => fmt(Math.round(v)))}</div>
        <div class="stat"><div class="k">Teachers (FTE)</div><div class="v">${r1(s.tfte[i])}</div>${benchLine(s, "tfte", i, r1)}</div>
        <div class="stat"><div class="k">Students per teacher</div><div class="v">${r1(s.ratio[i])}</div>${benchLine(s, "ratio", i, r1)}</div>
        <div class="stat"><div class="k">Non-teaching staff (FTE)</div><div class="v">${r1(s.nfte[i])}</div>${benchLine(s, "nfte", i, r1)}</div>
        <div class="stat"><div class="k">Year levels</div><div class="v">${esc(s.yr || "–")}</div></div>
      </div>
      ${s.gov ? `<p class="muted small" style="margin:0 0 10px">Governing body: ${esc(s.gov)}</p>` : ""}
      <div class="links">
        ${hasCatch ? `<a href="#" id="show-catchment">Show catchment on map <span>zoom to fit</span></a>` : ""}
        <a class="primary" href="https://www.myschool.edu.au/school/${s.id}" target="_blank" rel="noopener">My School profile <span>NAPLAN, finances ↗</span></a>
        ${website ? `<a href="${esc(website)}" target="_blank" rel="noopener">School website <span>↗</span></a>` : ""}
        <a href="https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}" target="_blank" rel="noopener">Open in Google Maps <span>↗</span></a>
      </div>`;
  }

  // Stack-bar parts for one school and year; null when the school didn't report.
  function genderParts(s, i) {
    const g = s.girls[i], b = s.boys[i], tot = (g || 0) + (b || 0);
    if (!tot) return null;
    const gp = Math.round((g / tot) * 100);
    return [{ label: "Girls", v: gp, c: "#c25aa0" }, { label: "Boys", v: 100 - gp, c: "#3d7fc4" }];
  }
  function quarterParts(s, i) {
    const q = [s.q1[i], s.q2[i], s.q3[i], s.q4[i]];
    if (!q.some((v) => v != null)) return null;
    return [
      { label: "Bottom", v: q[0], c: "#f3d9df" },
      { label: "Lower middle", v: q[1], c: "#dc93a6" },
      { label: "Upper middle", v: q[2], c: "#a8405f" },
      { label: "Top", v: q[3], c: "#5e1029" },
    ];
  }
  const QUARTER_NOTE = "Share of students in each national quarter of socio-educational advantage. Australia-wide, each quarter holds 25%.";

  function studentsTab(s, i) {
    const g = genderParts(s, i), q = quarterParts(s, i);
    const tot = (s.girls[i] || 0) + (s.boys[i] || 0);
    return `
      ${chartCard("Girls and boys", fmt(tot || null), g ? stackBar(g) : `<p class="muted small">Not reported.</p>`)}
      ${chartCard("Socio-educational advantage", "quarters", q ? stackBar(q) : `<p class="muted small">Not reported.</p>`, QUARTER_NOTE)}
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
      chartCard(ICSEA, "index", lineChart({ values: s.icsea, color: "#a8405f", bench: bench("icsea") }),
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

  /* ---------------- state school annual reports (Report tab) ---------------- */
  // data/annual.json: {reportYear, schools: {id: {years, att, attYr, cls, sda, sos: {parent, student, staff}}}}.
  // Only Government schools publish this template, so Catholic and Independent schools have no entry.
  let ANNUAL = null;
  const annualOf = (s) => (ANNUAL && ANNUAL.schools[s.id]) || null;
  const SURVEY_LABELS = { parent: "Parents and caregivers", student: "Students", staff: "Staff" };
  const pct = (v) => (v == null ? "–" : (Number.isInteger(v) ? v : v.toFixed(1)) + "%");
  const last = (arr) => (arr ? arr[arr.length - 1] : null);
  const reportUrl = (s) => `${s.url.replace(/\/$/, "")}/supportandresources/formsanddocuments/annualreports/annual-report-${ANNUAL.reportYear}.pdf`;

  // SEQ median of the latest year across non-special state schools of the same type.
  const ABENCH = {};
  function annualMedian(type, key, get) {
    const id = type + "|" + key;
    if (!(id in ABENCH)) {
      const v = DATA.schools
        .filter((s) => s.type === type && !s.special && annualOf(s))
        .map((s) => get(s, annualOf(s)))
        .filter((x) => x != null)
        .sort((a, b) => a - b);
      ABENCH[id] = v.length < 5 ? null : quantile(v, 0.5);
    }
    return ABENCH[id];
  }
  const sosItem = (a, survey, q) => last(((a.sos || {})[survey] || []).find(([x]) => x === q)?.[1]);
  const sdaPer100 = (s, a) => {
    const e = s.enr[YEARS.indexOf(last(a.years))], t = last(a.sda?.total);
    return e && t != null ? +((t / e) * 100).toFixed(1) : null;
  };

  function reportMissing(s) {
    const why = s.sector === "Government"
      ? `No ${ANNUAL ? ANNUAL.reportYear : ""} annual report was found on this school's website.`
      : `${esc(s.sector)} schools publish their own annual reports in their own formats, so this data isn't collected for them.`;
    return `<p class="small" style="margin-top:0">Attendance, class sizes, School Opinion Survey results and disciplinary absences come from Queensland state school annual reports.</p>
      <p class="muted small">${why}</p>
      ${s.url ? `<div class="links"><a href="${esc(/^https?:/i.test(s.url) ? s.url : "https://" + s.url)}" target="_blank" rel="noopener">School website <span>↗</span></a></div>` : ""}`;
  }

  function surveyCard(s, a, key) {
    const items = (a.sos || {})[key];
    if (!items || !items.length) return "";
    const ys = a.years;
    const body = items.map(([q, vals]) => {
      const v = last(vals), med = s.special ? null : annualMedian(s.type, `sos|${key}|${q}`, (_, x) => sosItem(x, key, q));
      return `<div class="sos-row">
        <div class="sos-q">${esc(q)}</div>
        <div class="sos-bar" title="${ys.map((y, k) => `${y}: ${pct(vals[k])}`).join(" · ")}${med != null ? ` · SEQ median ${pct(+med.toFixed(1))}` : ""}">
          <span style="width:${v ?? 0}%"></span>${med != null ? `<b style="left:${med}%"></b>` : ""}
        </div>
        <div class="sos-v mono">${pct(v)}</div>
        <div class="sos-prev mono muted">${ys.slice(0, -1).map((y, k) => `${y} ${pct(vals[k])}`).join(" · ")}</div>
      </div>`;
    }).join("");
    return chartCard(SURVEY_LABELS[key], `% agree, ${last(ys)}`, body,
      s.special ? "" : `Tick: median of SEQ state ${s.type.toLowerCase()} schools.`);
  }

  function yearTable(ys, rows, fmtV) {
    return `<table class="cmp-table yr-table"><thead><tr><th></th>${ys.map((y) => `<th>${y}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(([label, vals]) => `<tr><th scope="row">${esc(label)}</th>${vals.map((v) => `<td>${fmtV(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }

  function reportTab(s) {
    if (!ANNUAL) return `<p class="muted small">Loading annual report data…</p>`;
    const a = annualOf(s);
    if (!a) return reportMissing(s);
    const ys = a.years, yr = last(ys);
    const med = (key, get, f) => {
      const m = s.special ? null : annualMedian(s.type, key, get);
      return m != null ? `<div class="cmp">SEQ state ${s.type.toLowerCase()} median ${f(m)}</div>` : "";
    };
    const sdaNames = { short: "Short suspensions", long: "Long suspensions", excl: "Exclusions", canc: "Cancellations", total: "Total" };
    return `
      <p class="muted small" style="margin:0 0 8px">From the school's <a href="${esc(reportUrl(s))}" target="_blank" rel="noopener">${ANNUAL.reportYear} annual report ↗</a> · ${ys[0]}–${yr}</p>
      <div class="stats">
        <div class="stat"><div class="k">Attendance ${yr}</div><div class="v">${pct(last(a.att))}</div>${med("att", (_, x) => last(x.att), (v) => pct(Math.round(v)))}</div>
        <div class="stat"><div class="k">Disciplinary absences per 100 students</div><div class="v">${sdaPer100(s, a) ?? "–"}</div>${med("sda100", sdaPer100, (v) => v.toFixed(1))}</div>
        ${(a.cls || []).map(([phase, vals]) => `<div class="stat"><div class="k">Average class size, ${esc(phase.replace(/Year /g, "Yr ").replace("Prep Yr", "Prep"))}</div><div class="v">${vals[2] ?? "–"}</div></div>`).join("")}
      </div>
      ${surveyCard(s, a, "parent")}
      ${surveyCard(s, a, "student")}
      ${surveyCard(s, a, "staff")}
      ${a.attYr && a.attYr.length ? chartCard("Attendance by year level", "%", yearTable(ys, a.attYr, pct), "Days attended as a share of enrolled school days, full-time students.") : ""}
      ${a.sda ? chartCard("School disciplinary absences", "count", yearTable(ys, Object.entries(sdaNames).filter(([k]) => a.sda[k]).map(([k, n]) => [n, a.sda[k]]), (v) => (v == null ? "–" : fmt(v))),
        "Each suspension is counted, so one student can account for several. Per 100 students uses this year's enrolment.") : ""}
      <p class="note">Source: State of Queensland (Department of Education), school annual reports, CC BY 4.0. The Department notes the reports are an information source only.</p>`;
  }

  function compareReport(list) {
    if (!ANNUAL) return `<p class="muted small">Loading annual report data…</p>`;
    const have = list.filter(annualOf), without = list.filter((s) => !annualOf(s));
    const skipped = without.length
      ? `<p class="muted small" style="margin:0 0 10px">Not compared: ${without.map((s) => `${esc(s.name)} (${s.sector === "Government" ? "no report found" : esc(s.sector) + " schools don't publish this report"})`).join("; ")}.</p>`
      : "";
    if (have.length < 2) {
      return skipped + `<p class="small">Annual report data can only be compared between state schools. ${have.length ? `Open <strong>${esc(have[0].name)}</strong> on its own to see its report.` : ""}</p>`;
    }
    const v = (s, f) => f(annualOf(s));
    const phases = [...new Set(have.flatMap((s) => (annualOf(s).cls || []).map(([p]) => p)))];
    const rows = [
      [`Attendance ${last(annualOf(have[0]).years)}`, (s) => v(s, (a) => pct(last(a.att)))],
      ...phases.map((p) => [`Class size, ${esc(p.replace(/Year /g, "Yr "))}`, (s) => v(s, (a) => last((a.cls || []).find(([x]) => x === p)?.[1]) ?? "–")]),
      ["Disciplinary absences", (s) => v(s, (a) => fmt(last(a.sda?.total)))],
      ["… per 100 students", (s) => v(s, (a) => sdaPer100(s, a) ?? "–")],
    ];
    const surveys = Object.keys(SURVEY_LABELS).map((key) => {
      const qs = [...new Set(have.flatMap((s) => ((annualOf(s).sos || {})[key] || []).map(([q]) => q)))];
      if (!qs.length) return "";
      return chartCard(SURVEY_LABELS[key], "% agree", cmpTable(have, qs.map((q) => [esc(q), (s) => pct(sosItem(annualOf(s), key, q))])));
    }).join("");
    return `${skipped}${cmpTable(have, rows)}${surveys}
      <p class="note">Latest year from each school's ${ANNUAL.reportYear} annual report. Source: State of Queensland (Department of Education), CC BY 4.0.</p>`;
  }

  /* ---------------- comparison (2–4 schools side by side) ---------------- */
  const inView = (id) => id === state.selected || state.compare.includes(id);
  const compared = () => [state.selected, ...state.compare].map((id) => DATA.schools.find((x) => x.id === id)).filter(Boolean);
  const shortName = (s) => s.name
    .replace(/ State High School$/, " SHS").replace(/ State School$/, " SS")
    .replace(/ State College$/, " SC").replace(/ Primary School$/, " PS");

  // A metrics table with one column per school; each row is [label, school => html].
  function cmpTable(list, rows) {
    return `<table class="cmp-table">
      <thead><tr><th></th>${list.map((s) => `<th title="${esc(s.name)}"><i style="background:${cmpColor(compared().indexOf(s))}"></i>${esc(shortName(s))}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(([label, f]) => `<tr><th scope="row">${label}</th>${list.map((s) => `<td>${f(s)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>`;
  }

  function compareOverview(list, i) {
    const r1 = (v) => (v == null ? "–" : (+v).toFixed(1));
    return cmpTable(list, [
      ["Sector", (s) => esc(s.sector)],
      ["Type", (s) => esc(s.type) + (s.special ? " (special)" : "")],
      ["Year levels", (s) => esc(s.yr || "–")],
      ["Suburb", (s) => esc(s.suburb)],
      ["Students", (s) => fmt(s.enr[i])],
      [ICSEA, (s) => fmt(s.icsea[i])],
      [`${ICSEA} percentile`, (s) => (s.pct[i] == null ? "–" : s.pct[i] + "th")],
      ["Teachers (FTE)", (s) => r1(s.tfte[i])],
      ["Students per teacher", (s) => r1(s.ratio[i])],
      ["Non-teaching staff (FTE)", (s) => r1(s.nfte[i])],
      ["My School", (s) => `<a href="https://www.myschool.edu.au/school/${s.id}" target="_blank" rel="noopener">Profile ↗</a>`],
    ]);
  }

  function compareStudents(list, i) {
    const rows = (partsOf) => list.map((s, k) => {
      const parts = partsOf(s, i);
      return `<div class="cmp-bar"><div class="cmp-name"><i style="background:${cmpColor(k)}"></i>${esc(s.name)}</div>
        ${parts ? stackBar(parts, false) + `<div class="mono muted cmp-vals">${parts.map((p) => esc(p.label) + " " + (p.v ?? "–") + "%").join(" · ")}</div>`
          : `<p class="muted small" style="margin:0">Not reported.</p>`}</div>`;
    }).join("");
    const legendOf = (partsOf) => {
      const parts = list.map((s) => partsOf(s, i)).find(Boolean);
      return parts ? stackLegend(parts, false) : "";
    };
    return `
      ${chartCard("Girls and boys", "%", rows(genderParts) + legendOf(genderParts))}
      ${chartCard("Socio-educational advantage", "quarters", rows(quarterParts) + legendOf(quarterParts), QUARTER_NOTE)}
      ${cmpTable(list, [
        ["Students", (s) => fmt(s.enr[i])],
        ["Girls", (s) => fmt(s.girls[i])],
        ["Boys", (s) => fmt(s.boys[i])],
        ["Indigenous students", (s) => (s.ind[i] == null ? "–" : s.ind[i] + "%")],
        ["Language other than English", (s) => (s.lbote[i] == null ? "–" : s.lbote[i] + "%")],
      ])}`;
  }

  function compareTrends(list) {
    // The SEQ median band only makes sense when every school is the same (non-special) type.
    const type = list.every((s) => !s.special && s.type === list[0].type) ? list[0].type : null;
    const bench = (key) => (type ? benchFor(type, key) : null);
    const r1 = (v) => (+v).toFixed(Math.abs(v) < 100 ? 1 : 0).replace(/\.0$/, "");
    const series = (key) => list.map((s, k) => ({ values: s[key], color: cmpColor(k), name: s.name }));
    const legend = `<div class="legend">${list.map((s, k) => `<span><i style="background:${cmpColor(k)}"></i>${esc(shortName(s))}</span>`).join("")}</div>`;
    const note = type ? `Dashed line: median of SEQ ${type.toLowerCase()} schools; shaded band: the middle half.` : "";
    const card = (title, unit, key, fmtV, extra) =>
      chartCard(title, unit, lineChart({ series: series(key), bench: bench(key), fmtV }) + legend, [extra, note].filter(Boolean).join(" "));
    return [
      card("Students", "enrolments", "enr"),
      card("Students per teacher", "ratio", "ratio", r1, "Enrolments divided by teaching staff (FTE). Descriptive, not a quality measure."),
      card("Teachers", "FTE", "tfte", r1),
      card("Non-teaching staff", "FTE", "nfte", r1),
      card(ICSEA, "index", "icsea", fmt, "Index of Community Socio-Educational Advantage. The national average is 1000."),
      card("Language other than English", "%", "lbote"),
      card("Indigenous students", "%", "ind"),
    ].join("");
  }

  function compareNaplan(list) {
    return `
      <p class="small" style="margin-top:0">NAPLAN results and student progress are published on My School. Open each school's pages to compare them:</p>
      ${list.map((s, k) => `<div class="cmp-name"><i style="background:${cmpColor(k)}"></i>${esc(s.name)}</div>
        <div class="links" style="margin-bottom:12px">
          <a href="https://www.myschool.edu.au/school/${s.id}/naplan/results" target="_blank" rel="noopener">NAPLAN results <span>↗</span></a>
          <a href="https://www.myschool.edu.au/school/${s.id}/naplan" target="_blank" rel="noopener">Student progress <span>↗</span></a>
        </div>`).join("")}
      <p class="note">My School's terms of use don't allow its content to be reposted on another public website, so the results aren't copied into this map.</p>`;
  }

  function pickerHtml() {
    return `<div class="picker">
      <div class="picker-row">
        <input id="cmp-search" type="search" placeholder="Search a school, or click one on the map" autocomplete="off" aria-label="Add a school to compare">
        <button id="cmp-done" class="btn-ghost">Done</button>
      </div>
      <ul id="cmp-results" class="search-results" role="listbox" hidden></ul>
    </div>`;
  }

  function setupPicker() {
    const input = $("cmp-search"), list = $("cmp-results");
    $("cmp-done").onclick = () => { state.picking = false; renderDetail(); };
    let hits = [], active = 0;
    const draw = () => {
      list.hidden = !hits.length;
      list.innerHTML = hits.map((s, k) => `<li role="option" data-id="${s.id}" class="${k === active ? "active" : ""}">
        ${glyph(sectorOf(s.sector), 14)}<div><div>${esc(s.name)}</div><div class="sub">${esc(s.suburb)} ${esc(s.postcode)} · ${esc(s.type)}</div></div></li>`).join("");
    };
    input.addEventListener("input", () => {
      active = 0;
      hits = findSchools(input.value, 8).filter((s) => !inView(s.id));
      draw();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { active = Math.min(hits.length - 1, active + 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter" && hits[active]) choose(hits[active].id);
      else if (e.key === "Escape") { state.picking = false; renderDetail(); }
    });
    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li");
      if (li) { e.preventDefault(); choose(+li.dataset.id); }
    });
    input.focus({ preventScroll: true });
  }

  function compareHead(list) {
    return `
        <div class="eyebrow">Comparing ${list.length} of up to ${MAX_COMPARE} schools</div>
        <button class="icon-btn" id="detail-close" title="Close">&times;</button>
        <ul class="cmp-list">${list.map((s, k) => `<li>
          <i style="background:${cmpColor(k)}"></i>
          <div><div class="cmp-title">${esc(s.name)}</div><div class="sub">${esc(s.sector)} · ${esc(s.type)} · ${esc(s.suburb)}</div></div>
          <button class="icon-btn" data-remove="${s.id}" title="Remove from comparison">&times;</button></li>`).join("")}</ul>
        ${state.picking ? pickerHtml() : list.length < MAX_COMPARE ? `<button class="btn-ghost" id="cmp-add">+ Add another school</button>` : ""}`;
  }

  function singleHead(s, col) {
    return `
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
        ${state.picking ? pickerHtml() : `<button class="btn-ghost" id="cmp-add">+ Compare with other schools</button>`}`;
  }

  function renderDetail() {
    const s = DATA.schools.find((x) => x.id === state.selected);
    const el = $("detail");
    if (!s) { el.hidden = true; return; }
    const i = state.yearIdx, yr = YEARS[i];
    const sec = sectorOf(s.sector), col = cssVar(sec.css);
    const scroll = el.querySelector(".detail-body")?.scrollTop || 0;
    const list = compared(), many = list.length > 1;

    const body = many
      ? { overview: () => compareOverview(list, i), students: () => compareStudents(list, i), trends: () => compareTrends(list), report: () => compareReport(list), naplan: () => compareNaplan(list) }[state.tab]()
      : { overview: () => overviewTab(s, i, col), students: () => studentsTab(s, i), trends: () => trendsTab(s, col), report: () => reportTab(s), naplan: () => naplanTab(s) }[state.tab]();
    const missing = list.filter((x) => x.enr[i] == null).length;
    const missingNote = !missing ? "" : many ? ` · ${missing === 1 ? "one school" : missing + " schools"} didn't report this year` : " · no data reported this year";

    el.classList.toggle("comparing", many);
    el.innerHTML = `
      <div class="detail-head">
        ${many ? compareHead(list) : singleHead(s, col)}
        <nav class="tabs" role="tablist">${TABS.map(([k, label]) =>
          `<button role="tab" data-tab="${k}" class="${state.tab === k ? "on" : ""}" aria-selected="${state.tab === k}">${label}</button>`).join("")}</nav>
      </div>
      <div class="detail-body">
        ${!["naplan", "report"].includes(state.tab) ? `<p class="muted small" style="margin:0 0 8px"><span class="mono">${yr}</span>${missingNote}</p>` : ""}
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
    el.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => removeCompared(+b.dataset.remove)));
    const add = $("cmp-add");
    if (add) add.onclick = () => { state.picking = true; renderDetail(); };
    if (state.picking) setupPicker();
    const sc = $("show-catchment");
    if (sc) sc.onclick = (e) => { e.preventDefault(); fitCatchment(s); };
  }

  // Map clicks and search picks land here: while picking they join the comparison, otherwise they select.
  function choose(id, fly = true) {
    if (!state.picking || state.selected == null) return select(id, fly);
    if (!inView(id)) state.compare.push(id);
    if (state.compare.length >= MAX_COMPARE - 1) state.picking = false;
    writeHash();
    render();
    syncCatchments();
    fitCompared();
  }

  function removeCompared(id) {
    if (id === state.selected) state.selected = state.compare.shift() ?? null;
    else state.compare = state.compare.filter((x) => x !== id);
    if (state.selected == null) return select(null);
    writeHash();
    render();
    syncCatchments();
  }

  function fitCompared() {
    const pts = compared().map((s) => [s.lat, s.lng]);
    if (pts.length > 1) map.flyToBounds(pts, { padding: [60, 60], maxZoom: 15, duration: 0.8 });
  }

  /* ---------------- catchments ---------------- */
  // With no school selected, state.catchMode picks one level to draw over the whole region ("" for none).
  // With a school selected the control is hidden and the map shows that school's own catchment plus the
  // state school (primary) and state high school (junior) catchments around it; state.catchMode is kept
  // and comes back on deselect.
  const CATCH_LEVELS = ["primary", "junior", "senior"];
  const CATCH_NAMES = { primary: "primary", junior: "junior secondary", senior: "senior secondary" };
  const NEAR_METRES = 5000; // how far around a selected school to draw neighbouring catchments
  const catchCache = {}, catchData = {};
  let catchLayer = null, catchRenderer = null, catchOwn = new Set(), catchHits = new Set(), catchToken = 0;

  function loadCatch(key) {
    catchCache[key] = catchCache[key] || fetch(`data/catchments-${key}.geojson`)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((d) => { d.features.forEach((f) => (f._lvl = key)); return (catchData[key] = d); })
      .catch((err) => { delete catchCache[key]; throw err; });
    return catchCache[key];
  }
  const ownFeatures = (key, id) => (catchData[key] ? catchData[key].features.filter((f) => f.properties.id === id) : []);
  const bbox = (f) => (f._bb = f._bb || L.geoJSON(f).getBounds());
  const schoolById = (id) => DATA.schools.find((x) => x.id === id);

  // Even-odd ray cast over every ring, so holes are respected. pt is [lng, lat].
  function inGeometry(pt, geom) {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    return polys.some((rings) => {
      let inside = false;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i], [xj, yj] = ring[j];
          if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
        }
      }
      return inside;
    });
  }
  function containing(key, s) {
    return catchData[key].features.filter((f) => bbox(f).contains([s.lat, s.lng]) && inGeometry([s.lng, s.lat], f.geometry));
  }

  // Levels drawn around selected schools, bottom first: high school under state school, plus senior
  // when a selected school's only catchment is a senior one.
  async function nearLevels(schools) {
    await Promise.all(["primary", "junior"].map(loadCatch));
    const seniorOnly = schools.some((s) => s.sector === "Government" && !s.special &&
      !ownFeatures("primary", s.id).length && !ownFeatures("junior", s.id).length);
    if (!seniorOnly) return ["junior", "primary"];
    await loadCatch("senior");
    return schools.some((s) => ownFeatures("senior", s.id).length) ? ["senior", "junior", "primary"] : ["junior", "primary"];
  }
  function nearFeatures(levels, schools) {
    const area = L.latLngBounds([]);
    schools.forEach((s) => {
      area.extend(L.latLng(s.lat, s.lng).toBounds(NEAR_METRES));
      levels.forEach((k) => ownFeatures(k, s.id).forEach((f) => area.extend(bbox(f))));
    });
    return levels.flatMap((k) => catchData[k].features.filter((f) => area.intersects(bbox(f))));
  }

  function catchStyle(f) {
    const dark = isDark();
    const gov = cssVar("--gov"), line = dark ? "#e3cfd4" : "#6b1a33";
    const dash = f._lvl === "primary" ? null : "6 4";
    if (catchOwn.has(f)) return { color: gov, weight: 3, opacity: 1, dashArray: dash, fillColor: gov, fillOpacity: 0.16 };
    if (catchHits.has(f)) return { color: gov, weight: 2, opacity: 0.9, dashArray: dash, fillColor: gov, fillOpacity: 0.05 };
    return { color: line, weight: 1, opacity: dark ? 0.55 : 0.6, dashArray: dash, fillColor: line, fillOpacity: 0.03 };
  }

  // Bring the map, the control and the note in line with state.catchMode and the selection.
  async function syncCatchments() {
    const token = ++catchToken, mode = state.catchMode;
    const schools = state.selected == null ? [] : compared();
    const near = schools.length > 0;
    $("catch-by").hidden = near;
    document.querySelectorAll("#catch-by button").forEach((b) => b.classList.toggle("on", b.dataset.v === mode));
    let levels = mode ? [mode] : [];
    try {
      if (near || levels.some((k) => !catchData[k])) $("catch-status").textContent = "loading…";
      levels = near ? await nearLevels(schools) : levels;
      await Promise.all(levels.map(loadCatch));
    } catch (err) {
      if (token === catchToken) $("catch-status").textContent = "failed to load";
      return;
    }
    if (token !== catchToken) return; // changed again while loading

    const sig = near ? "near:" + schools.map((s) => s.id).join(",") : levels.join(",");
    if (sig !== state.catch || (sig && !catchLayer)) {
      if (catchLayer) { map.removeLayer(catchLayer); catchLayer = null; }
      if (sig) {
        catchRenderer = catchRenderer || L.canvas({ padding: 0.5 });
        catchLayer = L.geoJSON(near ? nearFeatures(levels, schools) : catchData[levels[0]], {
          renderer: catchRenderer,
          style: catchStyle,
          onEachFeature: (f, layer) => {
            layer.bindTooltip(`<strong>${esc(f.properties.name)}</strong><br><span class="muted">${CATCH_NAMES[f._lvl]} catchment · click to open</span>`, { sticky: true });
            layer.on("mouseover", () => layer.setStyle({ weight: 2.5, fillOpacity: 0.1 }));
            layer.on("mouseout", () => catchLayer && catchLayer.resetStyle(layer));
            layer.on("click", () => f.properties.id && choose(f.properties.id, false));
          },
        }).addTo(map);
        catchLayer.bringToBack();
      }
    }
    state.catch = sig;

    catchOwn = new Set(schools.flatMap((s) => levels.flatMap((k) => ownFeatures(k, s.id))));
    catchHits = new Set(schools.flatMap((s) => levels.flatMap((k) => containing(k, s))));
    restyleCatchments();
    $("catch-status").textContent = near ? "selected" : mode ? "on" : "off";
    $("catch-note").innerHTML = catchNote(levels, schools);
  }

  function catchNote(levels, schools) {
    if (!schools.length) return "";
    const legend = `<br><span class="muted">Solid outlines: state school catchments. Dashed: state high school catchments.</span>`;
    if (schools.length > 1) return `Showing the catchments of and around the ${schools.length} compared schools.${legend}`;
    const s = schools[0];
    const own = levels.filter((k) => ownFeatures(k, s.id).length).reverse();
    const lead = own.length
      ? `Showing <strong>${esc(s.name)}</strong>'s ${own.map((k) => CATCH_NAMES[k]).join(" and ")} catchment.`
      : s.sector === "Government"
        ? `${esc(s.name)} doesn't have its own catchment.`
        : `${esc(s.sector)} schools don't have catchments.`;
    const inside = levels.filter((k) => !own.includes(k)).reverse().map((k) => {
      const names = containing(k, s).map((f) => `<strong>${esc(f.properties.name)}</strong>`);
      return names.length ? `the ${names.join(" and ")} ${CATCH_NAMES[k]}` : "";
    }).filter(Boolean);
    return lead + (inside.length ? ` It's inside ${inside.join(" and ")} catchment${inside.length > 1 ? "s" : ""}.` : "") + legend;
  }

  function setCatchMode(mode) {
    state.catchMode = mode;
    writeHash();
    return syncCatchments();
  }

  function restyleCatchments() {
    if (catchLayer) catchLayer.setStyle(catchStyle);
  }

  // Frame the school's own catchment(s) on the map; false when none is drawn.
  function fitCatchment(s) {
    const own = catchLayer ? catchLayer.getLayers().filter((l) => l.feature.properties.id === s.id) : [];
    if (own.length) map.flyToBounds(L.featureGroup(own).getBounds(), { padding: [40, 40], duration: 0.8 });
    return own.length > 0;
  }

  function select(id, fly = true) {
    state.selected = id;
    state.compare = [];
    state.picking = false;
    writeHash();
    render();
    const synced = syncCatchments();
    if (id == null) { $("detail").hidden = true; return; }
    const s = schoolById(id);
    if (!s || !fly) return;
    // From search: frame the school's own catchment when it has one, otherwise zoom to the school.
    synced.then(() => fitCatchment(s) || map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 15), { duration: 0.8 }));
  }

  /* ---------------- search ---------------- */
  function findSchools(q, limit = 10) {
    q = q.trim().toLowerCase();
    if (q.length < 2) return [];
    const starts = [], has = [];
    for (const s of DATA.schools) {
      const n = s.name.toLowerCase();
      if (n.startsWith(q)) starts.push(s);
      else if (n.includes(q) || s.suburb.toLowerCase().includes(q) || s.postcode.startsWith(q)) has.push(s);
    }
    return starts.concat(has).slice(0, limit);
  }

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
      active = 0;
      const q = input.value;
      hits = findSchools(q);
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
      input.value = state.picking ? "" : s.name;
      hits = [];
      draw();
      input.blur();
      choose(id);
    }

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.focus(); input.select(); }
    });
  }

  /* ---------------- URL hash (#s=46410&y=2025&c=primary) ---------------- */
  function writeHash() {
    const p = new URLSearchParams();
    if (state.selected != null) p.set("s", state.selected);
    if (state.compare.length) p.set("cmp", state.compare.join(","));
    if (state.yearIdx !== YEARS.length - 1) p.set("y", YEARS[state.yearIdx]);
    if (state.catchMode) p.set("c", state.catchMode);
    if (state.selected != null && state.tab !== "overview") p.set("t", state.tab);
    const h = p.toString();
    history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const y = YEARS.indexOf(+p.get("y"));
    if (y >= 0) state.yearIdx = y;
    const id = +p.get("s");
    if (id && DATA.schools.some((s) => s.id === id)) {
      state.selected = id;
      state.compare = [...new Set((p.get("cmp") || "").split(",").map(Number))]
        .filter((c) => c && c !== id && DATA.schools.some((s) => s.id === c))
        .slice(0, MAX_COMPARE - 1);
    }
    if (CATCH_LEVELS.includes(p.get("c"))) state.catchMode = p.get("c");
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
      if (b) setCatchMode(b.dataset.v === state.catchMode ? "" : b.dataset.v); // click again to hide
    });

    $("opt-special").addEventListener("change", (e) => { state.special = e.target.checked; render(); });
    $("opt-size").addEventListener("change", (e) => { state.sizeByEnr = e.target.checked; render(); });
    $("opt-inactive").addEventListener("change", (e) => { state.inactive = e.target.checked; render(); });
    $("opt-cluster").addEventListener("change", (e) => { state.cluster = e.target.checked; rebuildGroups(); render(); });

    $("panel-close").onclick = () => { $("panel").hidden = true; $("panel-open").hidden = false; };
    $("panel-open").onclick = () => { $("panel").hidden = false; $("panel-open").hidden = true; };
    if (innerWidth <= 640) $("panel-close").click();

    $("play").onclick = togglePlay;
    $("year-range").max = YEARS.length - 1;
    $("year-range").addEventListener("input", (e) => setYear(+e.target.value));
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, select, textarea")) return;
      if (e.key === "ArrowLeft") setYear(state.yearIdx - 1);
      else if (e.key === "ArrowRight") setYear(state.yearIdx + 1);
      else if (e.key === "Escape" && state.picking) { state.picking = false; renderDetail(); }
      else if (e.key === "Escape" && state.selected != null) select(null);
    });

    document.querySelectorAll("[data-theme-set]").forEach((b) => (b.onclick = () => applyTheme(b.dataset.themeSet)));
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (!document.documentElement.dataset.theme) { setTiles(); render(); restyleCatchments(); }
    });
  }

  /* ---------------- boot ---------------- */
  let savedTheme = "auto";
  try { savedTheme = localStorage.getItem("theme") || "auto"; } catch (e) {}
  applyTheme(savedTheme);

  // Annual report data is optional extra detail; the map works without it.
  fetch("data/annual.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      ANNUAL = d || { reportYear: null, schools: {} };
      if (DATA && state.selected != null) renderDetail();
    })
    .catch(() => { ANNUAL = { reportYear: null, schools: {} }; });

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
      // Docked panels change the map's width, so redraw tiles whenever it resizes.
      new ResizeObserver(() => map.invalidateSize()).observe($("map"));
      setTiles();
      rebuildGroups();
      setupControls();
      setupSearch();
      render();
      syncCatchments();

      if (state.selected != null) {
        const s = DATA.schools.find((x) => x.id === state.selected);
        const pts = compared().map((x) => [x.lat, x.lng]);
        if (pts.length > 1) map.fitBounds(pts, { padding: [60, 60], maxZoom: 15 });
        else map.setView([s.lat, s.lng], 15);
      }
    })
    .catch((err) => {
      document.getElementById("map").innerHTML =
        `<p style="padding:24px">Couldn't load school data (${esc(err.message)}). If you opened index.html directly, serve the folder instead: <code>python -m http.server</code></p>`;
    });
})();

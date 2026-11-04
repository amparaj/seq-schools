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
  const ICSEA = `<abbr title="Index of Community Socio-Educational Advantage. Describes students' family backgrounds (parents' education and occupation), not school quality. Higher = more advantaged intake; national average 1000.">ICSEA</abbr>`;
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
    pickNote: "", // why the last pick was refused
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
        className: "school-icon" + (inView(s.id) ? " sel" : state.picking && !canCompare(s) ? " dim" : ""),
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
    $("yr-step-label").textContent = YEARS[state.yearIdx];
    $("yr-prev").disabled = state.yearIdx === 0;
    $("yr-next").disabled = state.yearIdx === YEARS.length - 1;
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
  const TABS = [["overview", "Overview"], ["students", "Students"], ["trends", "Trends"], ["report", "Report"], ["context", "Context"], ["naplan", "NAPLAN"]];
  const CATCH_FOR_TYPE = { Primary: "primary", Combined: "primary", Secondary: "junior" };

  // `short` drops the type from the label, for comparison tables where the Type row already shows it.
  function benchLine(s, key, i, fmtV = fmt, short = false) {
    if (s.special) return "";
    const b = benchFor(s.type, key)[i];
    return b ? `<div class="cmp">SEQ ${short ? "" : s.type.toLowerCase() + " "}median ${fmtV(b.p50)}</div>` : "";
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
    return `<div class="cards">${[
      chartCard("Students", "enrolments", lineChart({ values: s.enr, color: col, bench: bench("enr") }), note),
      chartCard("Students per teacher", "ratio", lineChart({ values: s.ratio, color: col, bench: bench("ratio"), fmtV: r1 }),
        "Enrolments divided by teaching staff (FTE). Descriptive, not a quality measure."),
      chartCard("Teachers", "FTE", lineChart({ values: s.tfte, color: col, bench: bench("tfte"), fmtV: r1 })),
      chartCard("Non-teaching staff", "FTE", lineChart({ values: s.nfte, color: col, bench: bench("nfte"), fmtV: r1 })),
      chartCard(ICSEA, "index", lineChart({ values: s.icsea, color: "#a8405f", bench: bench("icsea") }),
        "Index of Community Socio-Educational Advantage. The national average is 1000."),
      chartCard("Language other than English", "%", lineChart({ values: s.lbote, color: col, bench: bench("lbote") })),
      chartCard("Indigenous students", "%", lineChart({ values: s.ind, color: col, bench: bench("ind") })),
    ].join("")}</div>`;
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
  // data/annual.json: {reportYear, years, y12Years, items: {parent, student, staff}, schools: {id: {att, attYr, cls, sda, sos, y12}}},
  // every series aligned to `years` (2013–2025, merged from each school's reports). On load each school gets
  // `years`, and `sos` is rebuilt from values aligned to `items` into [question, values] pairs.
  // Only Government schools publish this template, so Catholic and Independent schools have no entry.
  let ANNUAL = null;
  const annualOf = (s) => (ANNUAL && ANNUAL.schools[s.id]) || null;
  const SURVEY_LABELS = { parent: "Parents and caregivers", student: "Students", staff: "Staff" };
  const pct = (v) => (v == null ? "–" : (Number.isInteger(v) ? v : v.toFixed(1)) + "%");
  const last = (arr) => (arr ? arr[arr.length - 1] : null);
  const reportUrl = (s) => `${s.url.replace(/\/$/, "")}/supportandresources/formsanddocuments/annualreports/annual-report-${ANNUAL.reportYear}.pdf`;

  // Reports cover only a few years (ANNUAL.years): follow the slider inside that range, else use the nearest end.
  const repYear = () => (ANNUAL.years.length ? Math.min(last(ANNUAL.years), Math.max(ANNUAL.years[0], YEARS[state.yearIdx])) : null);
  const atYear = (a, vals) => (vals ? vals[a.years.indexOf(repYear())] ?? null : null);
  function repYearNote() {
    const y = YEARS[state.yearIdx], ry = repYear();
    return ry != null && y !== ry ? ` · reports cover ${ANNUAL.years[0]}–${last(ANNUAL.years)}, so showing ${ry}, not ${y}` : "";
  }
  // Up to three report years ending at the one shown, for the year-by-year tables.
  const yearWindow = () => {
    const k = ANNUAL.years.indexOf(repYear());
    return ANNUAL.years.slice(Math.max(0, k - 2), k + 1);
  };
  const pick = (a, vals, ys) => ys.map((y) => vals[a.years.indexOf(y)] ?? null);
  // A series re-aligned to YEARS, for lineChart.
  const toYears = (a, vals) => YEARS.map((y) => (vals ? vals[a.years.indexOf(y)] ?? null : null));
  const sda100Years = (s, a) => YEARS.map((y, i) => {
    const t = a.sda?.total?.[a.years.indexOf(y)];
    return s.enr[i] && t != null ? +((t / s.enr[i]) * 100).toFixed(1) : null;
  });

  // SEQ median of the report year across non-special state schools of the same type.
  const ABENCH = {};
  function annualMedian(type, key, get) {
    const id = type + "|" + key + "|" + repYear();
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
  const sosItem = (a, survey, q) => atYear(a, ((a.sos || {})[survey] || []).find(([x]) => x === q)?.[1]);
  const sdaPer100 = (s, a) => {
    const e = s.enr[YEARS.indexOf(repYear())], t = atYear(a, a.sda?.total);
    return e && t != null ? +((t / e) * 100).toFixed(1) : null;
  };

  function reportMissing(s) {
    const why = s.sector === "Government"
      ? `No ${ANNUAL ? ANNUAL.reportYear : ""} annual report was found on this school's website.`
      : `${esc(s.sector)} schools publish their own annual reports in their own formats, so this data isn't collected for them.`;
    return `<p class="small" style="margin-top:0">Attendance, class sizes, School Opinion Survey results, disciplinary absences and Year 12 outcomes come from Queensland state school annual reports.</p>
      <p class="muted small">${why}</p>
      ${s.url ? `<div class="links"><a href="${esc(/^https?:/i.test(s.url) ? s.url : "https://" + s.url)}" target="_blank" rel="noopener">School website <span>↗</span></a></div>` : ""}`;
  }

  function surveyCard(s, a, key) {
    const items = (a.sos || {})[key];
    if (!items || !items.length) return "";
    const ys = a.years, ry = repYear(), prev = yearWindow().filter((y) => y !== ry);
    const body = items.map(([q, vals]) => {
      const v = atYear(a, vals), med = s.special ? null : annualMedian(s.type, `sos|${key}|${q}`, (_, x) => sosItem(x, key, q));
      return `<div class="sos-row">
        <div class="sos-q">${esc(q)}</div>
        <div class="sos-bar" title="${ys.map((y, k) => (vals[k] == null ? "" : `${y}: ${pct(vals[k])}`)).filter(Boolean).join(" · ")}${med != null ? ` · SEQ median ${pct(+med.toFixed(1))}` : ""}">
          <span style="width:${v ?? 0}%"></span>${med != null ? `<b style="left:${med}%"></b>` : ""}
        </div>
        <div class="sos-v mono">${pct(v)}</div>
        <div class="sos-prev mono muted">${prev.map((y) => `${y} ${pct(pick(a, vals, [y])[0])}`).join(" · ")}</div>
      </div>`;
    }).join("");
    return chartCard(SURVEY_LABELS[key], `% agree, ${ry}`, body,
      [ry === 2020 ? "The surveys weren't run in 2020 (COVID-19)." : "", s.special ? "" : `Tick: median of SEQ state ${s.type.toLowerCase()} schools.`].filter(Boolean).join(" "));
  }

  function yearTable(ys, rows, fmtV) {
    return `<table class="cmp-table yr-table"><thead><tr><th></th>${ys.map((y) => `<th>${y}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(([label, vals]) => `<tr><th scope="row">${esc(label)}</th>${vals.map((v) => `<td>${fmtV(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }

  /* Year 12 outcomes: a.y12 = {key: values aligned to ANNUAL.y12Years}, by cohort year. Up to 2019 Year 12s
     got an OP; from 2020 an ATAR, which the reports don't include (QTAC holds it). The table follows the
     slider year with no clamping, never spans the two systems, and marks missing years "n/a". */
  const LAST_OP = 2019;
  const Y12_ROWS = {
    both: [["ss", "Received a Senior Statement", fmt], ["qcia", "Awarded a QCIA", fmt]],
    op: [["qce", "Awarded a QCE", fmt], ["op", "Received an OP", fmt], ["op115", "OP 1–15 or IB Diploma, % of OP/IBD-eligible", pct],
      ["qtac", "QTAC applicants offered a place", pct]],
    atar: [["qcePct", "Awarded a QCE or QCIA", pct]],
    after: [["any", "Awarded a QCE, IBD or VET qualification, or doing a SAT", pct], ["vet", "Awarded one or more VET qualifications", fmt],
      ["cert2p", "… Certificate II or above", fmt], ["cert3p", "… Certificate III or above", fmt], ["sat", "Doing a school-based apprenticeship or traineeship (SAT)", fmt]],
  };
  const OP_BANDS = [["op1", "OP 1–5"], ["op6", "OP 6–10"], ["op11", "OP 11–15"], ["op16", "OP 16–20"], ["op21", "OP 21–25"]];
  const y12Rows = (y) => [...Y12_ROWS.both, ...(y <= LAST_OP ? Y12_ROWS.op : Y12_ROWS.atar), ...Y12_ROWS.after];
  const y12At = (a, key, y) => a?.y12?.[key]?.[(ANNUAL.y12Years || []).indexOf(y)] ?? null;
  const NA = `<span class="muted" title="Data unavailable">n/a</span>`;
  function y12Why(y) {
    if (y >= 2024) return "the reports stopped including Year 12 outcomes in 2024";
    if (y >= 2021) return "most 2021–2023 reports print the table as graphics, so it can't be read as text";
    if (y < (ANNUAL.y12Years || [])[0]) return `the oldest reports still online start with the ${ANNUAL.y12Years[0]} cohort`;
    return "the report that covered it is no longer on the school's website";
  }
  // "2023, as …; 2024–2025, as …": missing years grouped by reason.
  function y12Gaps(years) {
    const by = new Map();
    years.forEach((x) => by.set(y12Why(x), [...(by.get(y12Why(x)) || []), x]));
    return [...by].map(([why, ys]) => `${ys.length > 1 ? `${ys[0]}–${last(ys)}` : ys[0]}, as ${why}`).join("; ");
  }
  const y12Note = (y) => (y <= LAST_OP
    ? "Up to 2019, Year 12s received an Overall Position (OP); the 2020 cohort was the first to receive an ATAR instead."
    : "ATARs are calculated by QTAC, not the Department, so the reports don't include them. 2020 was the first ATAR year, a break in the series; from 2020 visa students are counted too.");

  function year12Card(s, a) {
    if (s.type === "Primary" && !a.y12) return "";  // some special schools listed as Primary teach Year 12
    const y = YEARS[state.yearIdx], era = (x) => x <= LAST_OP;
    const win = [y - 2, y - 1, y].filter((x) => era(x) === era(y));
    const missing = win.filter((x) => !Object.keys(a.y12 || {}).some((k) => y12At(a, k, x) != null));
    if (missing.length === win.length) {
      return chartCard("Year 12 outcomes", "", `<p class="muted small" style="margin:0">Data unavailable for ${y12Gaps(win)}.</p>`, y12Note(y));
    }
    const rows = y12Rows(y).map(([k, label, f]) => [label, win.map((x) => { const v = y12At(a, k, x); return v == null ? NA : f(v); })]);
    if (!era(y)) rows.splice(2, 0, ["ATAR", win.map(() => `<span class="muted">not published</span>`)]);
    const bands = era(y) ? OP_BANDS.map(([k, label]) => [label, win.map((x) => { const v = y12At(a, k, x); return v == null ? NA : fmt(v); })]) : [];
    const gaps = missing.length ? ` n/a: data unavailable for ${y12Gaps(missing)}.`
      : rows.some(([, v]) => v.includes(NA)) ? " n/a: not in that year's report." : "";
    return chartCard("Year 12 outcomes", "by Year 12 cohort", yearTable(win, rows, (v) => v), y12Note(y) + gaps) +
      (bands.some(([, v]) => v.some((x) => x !== NA)) ? chartCard("Overall Position bands", "students", yearTable(win, bands, (v) => v), "OP 1 is the highest. Only OP-eligible students received one.") : "");
  }

  function reportTab(s, col) {
    if (!ANNUAL) return `<p class="muted small">Loading annual report data…</p>`;
    const a = annualOf(s);
    if (!a) return reportMissing(s);
    const yr = repYear(), win = yearWindow();
    const med = (key, get, f) => {
      const m = s.special ? null : annualMedian(s.type, key, get);
      return m != null ? `<div class="cmp">SEQ state ${s.type.toLowerCase()} median ${f(m)}</div>` : "";
    };
    // Rows with something to show in the window, values cut to it.
    const winRows = (rows) => rows.map(([label, vals]) => [label, pick(a, vals, win)]).filter(([, v]) => v.some((x) => x != null));
    const sdaNames = { short: "Short suspensions", long: "Long suspensions", excl: "Exclusions", canc: "Cancellations", total: "Total" };
    const attRows = winRows(a.attYr || []);
    const sdaRows = winRows(Object.entries(sdaNames).filter(([k]) => a.sda?.[k]).map(([k, n]) => [n, a.sda[k]]));
    const shown = (a.cls || []).filter(([, vals]) => atYear(a, vals) != null);
    const r1 = (v) => (+v).toFixed(1).replace(/\.0$/, "");
    return `
      <p class="muted small" style="margin:0 0 8px">From the school's annual reports (latest: <a href="${esc(reportUrl(s))}" target="_blank" rel="noopener">${ANNUAL.reportYear} ↗</a>) · <span class="mono">${yr}</span>${repYearNote()}</p>
      <div class="stats">
        <div class="stat"><div class="k">Attendance ${yr}</div><div class="v">${pct(atYear(a, a.att))}</div>${med("att", (_, x) => atYear(x, x.att), (v) => pct(Math.round(v)))}</div>
        <div class="stat"><div class="k">Disciplinary absences per 100 students, ${yr}</div><div class="v">${sdaPer100(s, a) ?? "–"}</div>${med("sda100", sdaPer100, (v) => v.toFixed(1))}</div>
        ${shown.map(([phase, vals]) => `<div class="stat"><div class="k">Average class size, ${esc(phase.replace(/Year /g, "Yr ").replace("Prep Yr", "Prep"))}, ${yr}</div><div class="v">${atYear(a, vals)}</div></div>`).join("")}
      </div>
      ${surveyCard(s, a, "parent")}
      ${surveyCard(s, a, "student")}
      ${surveyCard(s, a, "staff")}
      <div class="cards">
        ${chartCard("Attendance", "%", lineChart({ values: toYears(a, a.att), color: col }), "Overall attendance, every year the school's reports cover.")}
        ${a.sda ? chartCard("Disciplinary absences", "per 100 students", lineChart({ values: sda100Years(s, a), color: col, fmtV: r1 })) : ""}
      </div>
      ${attRows.length ? chartCard("Attendance by year level", "%", yearTable(win, attRows, pct), "Days attended as a share of enrolled school days, full-time students.") : ""}
      ${sdaRows.length ? chartCard("School disciplinary absences", "count", yearTable(win, sdaRows, (v) => (v == null ? "–" : fmt(v))),
        "Each suspension is counted, so one student can account for several. Per 100 students uses this year's enrolment." +
        (win[0] < 2017 ? " Before 2017, short suspensions were 1–5 days and long suspensions 6–20 days (now 1–10 and 11–20)." : "")) : ""}
      ${year12Card(s, a)}
      <p class="note">Source: State of Queensland (Department of Education), school annual reports, CC BY 4.0. Each year comes from the newest report that includes it; years a school no longer publishes are blank. The Department notes the reports are an information source only.</p>`;
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
    const v = (s, f) => f(annualOf(s)), yr = repYear();
    const phases = [...new Set(have.flatMap((s) => (annualOf(s).cls || []).filter(([, vals]) => atYear(annualOf(s), vals) != null).map(([p]) => p)))];
    const rows = [
      [`Attendance ${yr}`, (s) => v(s, (a) => pct(atYear(a, a.att)))],
      ...phases.map((p) => [`Class size, ${esc(p.replace(/Year /g, "Yr "))}`, (s) => v(s, (a) => atYear(a, (a.cls || []).find(([x]) => x === p)?.[1]) ?? "–")]),
      [`Disciplinary absences ${yr}`, (s) => v(s, (a) => fmt(atYear(a, a.sda?.total)))],
      ["… per 100 students", (s) => v(s, (a) => sdaPer100(s, a) ?? "–")],
    ];
    const surveys = Object.keys(SURVEY_LABELS).map((key) => {
      const qs = [...new Set(have.flatMap((s) => ((annualOf(s).sos || {})[key] || []).map(([q]) => q)))];
      if (!qs.length) return "";
      return chartCard(SURVEY_LABELS[key], `% agree, ${yr}`, cmpTable(have, qs.map((q) => [esc(q), (s) => pct(sosItem(annualOf(s), key, q))])));
    }).join("");
    // Year 12 outcomes for the slider's cohort year, when the schools teach Year 12.
    const y = YEARS[state.yearIdx], y12 = have.filter((s) => s.type !== "Primary" || annualOf(s).y12);
    const y12Has = y12.filter((s) => Object.keys(annualOf(s).y12 || {}).some((k) => y12At(annualOf(s), k, y) != null));
    const year12 = y12.length < 2 ? ""
      : chartCard("Year 12 outcomes", `${y} cohort`, y12Has.length
        ? cmpTable(y12, [...y12Rows(y).map(([k, label, f]) => [esc(label), (s) => { const v = y12At(annualOf(s), k, y); return v == null ? NA : f(v); }]),
          ...(y <= LAST_OP ? OP_BANDS.map(([k, label]) => [label, (s) => { const v = y12At(annualOf(s), k, y); return v == null ? NA : fmt(v); }]) : [["ATAR", () => `<span class="muted">not published</span>`]])])
        : `<p class="muted small" style="margin:0">Data unavailable for ${y12Gaps([y])}.</p>`,
        y12Note(y) + (y12Has.length && y12Has.length < y12.length ? ` n/a: data unavailable, as ${y12Why(y)}.` : ""));
    return `<p class="muted small" style="margin:0 0 8px"><span class="mono">${yr}</span>${repYearNote()}</p>
      ${skipped}${cmpTable(have, rows)}${surveys}${year12}
      <p class="note">From each school's annual reports, which cover ${ANNUAL.years[0]}–${last(ANNUAL.years)} where the school still publishes them. Disciplinary absences count suspensions and exclusions in that one year, not students: one student suspended three times counts three. Compare the per 100 students row, since raw counts grow with school size. Source: State of Queensland (Department of Education), CC BY 4.0.</p>`;
  }

  /* ---------------- comparison (2–4 schools side by side) ---------------- */
  const inView = (id) => id === state.selected || state.compare.includes(id);
  const compared = () => [state.selected, ...state.compare].map((id) => DATA.schools.find((x) => x.id === id)).filter(Boolean);

  // Schools are compared only where they teach the same age group: a Combined school counts as both
  // primary and secondary, so it can sit with either, but Primary and Secondary never mix.
  const STAGES = { Primary: ["primary"], Secondary: ["secondary"], Combined: ["primary", "secondary"] };
  const sharedStages = (list) => ["primary", "secondary"].filter((st) => list.every((s) => (STAGES[s.type] || []).includes(st)));
  const canCompare = (s) => state.selected == null || sharedStages([...compared(), s]).length > 0;
  const stageHint = (stages) => stages.length === 1
    ? `${stages[0] === "primary" ? "Primary" : "Secondary"} and Combined schools`
    : "Schools that share a primary or secondary year level";
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
    const r0 = (v) => fmt(Math.round(v));
    const med = (s, key, f) => benchLine(s, key, i, f, true);
    return cmpTable(list, [
      ["Sector", (s) => esc(s.sector)],
      ["Type", (s) => esc(s.type) + (s.special ? " (special)" : "")],
      ["Year levels", (s) => esc(s.yr || "–")],
      ["Suburb", (s) => esc(s.suburb)],
      ["Students", (s) => fmt(s.enr[i]) + med(s, "enr", r0)],
      [ICSEA, (s) => fmt(s.icsea[i]) + med(s, "icsea", r0)],
      [`${ICSEA} percentile`, (s) => (s.pct[i] == null ? "–" : s.pct[i] + "th") + med(s, "pct", (v) => Math.round(v) + "th")],
      ["Teachers (FTE)", (s) => r1(s.tfte[i]) + med(s, "tfte", r1)],
      ["Students per teacher", (s) => r1(s.ratio[i]) + med(s, "ratio", r1)],
      ["Non-teaching staff (FTE)", (s) => r1(s.nfte[i]) + med(s, "nfte", r1)],
      ["My School", (s) => `<a href="https://www.myschool.edu.au/school/${s.id}" target="_blank" rel="noopener">Profile ↗</a>`],
    ]) + `<p class="note">Grey figures: median of SEQ schools of the same type (primary, secondary or combined) that year, excluding special schools.</p>`;
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
    return `<div class="cards">${[
      card("Students", "enrolments", "enr"),
      card("Students per teacher", "ratio", "ratio", r1, "Enrolments divided by teaching staff (FTE). Descriptive, not a quality measure."),
      card("Teachers", "FTE", "tfte", r1),
      card("Non-teaching staff", "FTE", "nfte", r1),
      card(ICSEA, "index", "icsea", fmt, "Index of Community Socio-Educational Advantage. The national average is 1000. Higher means a more advantaged intake, not a better school."),
      card("Language other than English", "%", "lbote"),
      card("Indigenous students", "%", "ind"),
    ].join("")}</div>`;
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

  /* ---------------- Context tab: each measure among schools with a similar intake ---------------- */
  // A school's peers are non-special SEQ schools of the same type whose ICSEA is within ICSEA_NEAR of its own,
  // across all sectors (the same idea as My School's "similar schools"). Position is the percentile within those
  // peers. This is deliberately not a composite score: the research doesn't support combining these measures.
  const ICSEA_NEAR = 50, MIN_PEERS = 10;
  const sosMean = (a, key) => {
    const v = ((a.sos || {})[key] || []).map(([, vals]) => atYear(a, vals)).filter((x) => x != null);
    return v.length ? +(v.reduce((p, q) => p + q, 0) / v.length).toFixed(1) : null;
  };
  const dp1 = (v) => (+v).toFixed(1);
  const EVIDENCE = { strong: "Strong evidence", moderate: "Moderate evidence", modest: "Modest evidence", none: "Descriptive only" };
  // `annual` measures come from state school annual reports, so only state schools are placed and compared.
  const CONTEXT = [
    { title: "Attendance", unit: "%", annual: true, ev: "strong", f: (v) => pct(+v.toFixed(1)),
      get: (s) => atYear(annualOf(s), annualOf(s).att),
      note: "Each day missed is linked to lower NAPLAN results, with no \"safe\" level of absence (Hancock et al., 2013). Attendance also reflects family circumstances, which is why it's set against similar-intake schools." },
    { title: "Parent opinion", unit: "avg % agree", annual: true, ev: "moderate", f: pct,
      get: (s) => sosMean(annualOf(s), "parent"),
      note: "The average across the 15 parent survey items (safety, teaching, progress, communication). A positive school climate is linked to better achievement and wellbeing (Thapa et al., 2013). Self-reported, and response rates vary." },
    { title: "Student opinion", unit: "avg % agree", annual: true, ev: "moderate", f: pct,
      get: (s) => sosMean(annualOf(s), "student"),
      note: "The average across the 12 student survey items. Students' sense of safety, fairness and connection is part of school climate (Thapa et al., 2013). Only some year levels are surveyed." },
    { title: "Staff opinion", unit: "avg % agree", annual: true, ev: "moderate", f: pct,
      get: (s) => sosMean(annualOf(s), "staff"),
      note: "The average across the 11 staff survey items. Teachers' views of their working conditions predict whether they stay (Ladd, 2011), and teacher turnover lowers achievement (Ronfeldt, Loeb & Wyckoff, 2013)." },
    { title: "Disciplinary absences", unit: "per 100 students", annual: true, ev: "moderate", f: dp1,
      get: (s) => sdaPer100(s, annualOf(s)),
      note: "Suspensions and exclusions per 100 students. Suspension is associated with lower achievement and disengagement (Noltemeyer, Ward & Mcloughlin, 2015). Rates reflect a school's behaviour policy as well as student behaviour, so a low rate isn't automatically better." },
    { title: "Students per teacher", unit: "ratio", ev: "modest", f: dp1,
      get: (s, i) => s.ratio[i],
      note: "Smaller classes help most in the first years of school and for disadvantaged students (Krueger, 1999, Tennessee STAR). Across studies the effect is modest (Hattie, 2009). This counts all teaching staff, so actual classes are larger." },
    { title: "Non-teaching staff", unit: "per 100 students", ev: "none", f: dp1,
      get: (s, i) => (s.nfte[i] != null && s.enr[i] ? (s.nfte[i] / s.enr[i]) * 100 : null),
      note: "Administration, teacher aides and specialist support staff (FTE). There's no consistent research link between this figure on its own and student outcomes." },
    { title: "Students", unit: "enrolments", ev: "none", f: (v) => fmt(Math.round(v)),
      get: (s, i) => s.enr[i],
      note: "Research on school size is mixed; smaller schools tend to suit disadvantaged students (Leithwood & Jantzi, 2009). Size tells you more about how a school feels than how good it is." },
  ];
  const CONTEXT_REFS = [
    "Hancock, K. J. et al. (2013). <em>Student attendance and educational outcomes: Every day counts.</em> Telethon Institute for Child Health Research.",
    "Hattie, J. (2009). <em>Visible Learning.</em> Routledge.",
    "Krueger, A. B. (1999). Experimental estimates of education production functions. <em>Quarterly Journal of Economics</em>, 114(2).",
    "Ladd, H. F. (2011). Teachers' perceptions of their working conditions. <em>Educational Evaluation and Policy Analysis</em>, 33(2).",
    "Leithwood, K. & Jantzi, D. (2009). A review of empirical evidence about school size effects. <em>Review of Educational Research</em>, 79(1).",
    "Noltemeyer, A. L., Ward, R. M. & Mcloughlin, C. (2015). Relationship between school suspension and student outcomes: A meta-analysis. <em>School Psychology Review</em>, 44(2).",
    "OECD (2008). <em>Measuring Improvements in Learning Outcomes: Best Practices to Assess the Value-Added of Schools.</em>",
    "Ronfeldt, M., Loeb, S. & Wyckoff, J. (2013). How teacher turnover harms student achievement. <em>American Educational Research Journal</em>, 50(1).",
    "Thapa, A. et al. (2013). A review of school climate research. <em>Review of Educational Research</em>, 83(3).",
  ];

  // {v, n, med, p25, p75, pos} for one school and measure, or {why} when it can't be placed.
  function placeAmongPeers(s, m, i) {
    if (s.special) return { why: "Special school, not compared" };
    if (m.annual && !annualOf(s)) return { why: s.sector === "Government" ? "No annual report found" : "State schools only" };
    const x = s.icsea[i], v = m.get(s, i);
    if (x == null) return { why: `No ${ICSEA} for this year` };
    if (v == null) return { why: "Not reported" };
    const peers = DATA.schools
      .filter((p) => p.type === s.type && !p.special && p.icsea[i] != null && Math.abs(p.icsea[i] - x) <= ICSEA_NEAR && (!m.annual || annualOf(p)))
      .map((p) => m.get(p, i)).filter((y) => y != null).sort((a, b) => a - b);
    if (peers.length < MIN_PEERS) return { v, why: `Only ${peers.length} similar schools` };
    const below = peers.filter((y) => y < v).length, same = peers.filter((y) => y === v).length;
    return { v, n: peers.length, med: quantile(peers, 0.5), p25: quantile(peers, 0.25), p75: quantile(peers, 0.75),
      pos: Math.round(((below + same / 2) / peers.length) * 100) };
  }

  // One card per measure: a 0–100 percentile strip with a dot per school, then each school's figures.
  function contextCard(m, list, colors, i) {
    const places = list.map((s) => placeAmongPeers(s, m, i));
    const dots = places.map((p, k) => (p.pos == null ? "" :
      `<b style="left:${p.pos}%;background:${colors[k]}" title="${esc(list[k].name)}: higher than ${p.pos}% of similar schools"></b>`)).join("");
    const rows = places.map((p, k) => `<div class="ctx-row">
        ${list.length > 1 ? `<i style="background:${colors[k]}"></i><span class="ctx-name">${esc(shortName(list[k]))}</span>` : ""}
        <span class="ctx-v">${p.v != null ? m.f(p.v) : "–"}</span>
        <span class="muted">${p.pos != null ? `higher than ${p.pos}% of ${p.n} similar schools · their median ${m.f(p.med)}` : esc(p.why)}</span>
      </div>`).join("");
    const yr = m.annual ? repYear() : YEARS[i];
    return `<div class="card ctx">
      <div class="card-head"><h4>${m.title} <span class="ctx-ev" data-ev="${m.ev}">${EVIDENCE[m.ev]}</span></h4><span class="mono muted">${m.unit} · ${yr}</span></div>
      ${places.some((p) => p.pos != null) ? `<div class="ctx-strip"><span class="ctx-mid"></span>${dots}</div>
        <div class="ctx-axis mono muted"><span>Lowest</span><span>Middle half</span><span>Highest</span></div>` : ""}
      ${rows}
      <p class="note">${m.note}</p>
    </div>`;
  }

  function contextTab(list, colors) {
    const i = state.yearIdx;
    if (!ANNUAL) return `<p class="muted small">Loading annual report data…</p>`;
    const ai = YEARS.indexOf(repYear()), idx = (m) => (m.annual && ai >= 0 ? ai : i);
    const one = list.length === 1, s = list[0];
    const intro = one
      ? (s.special || s.icsea[i] == null
        ? `<p class="small" style="margin-top:0">${s.special ? "Special schools serve very different needs, so they aren't placed against other schools." : `${esc(s.name)} has no ${ICSEA} for ${YEARS[i]}, so similar schools can't be found.`}</p>`
        : `<p class="small" style="margin-top:0">Each measure places ${esc(s.name)} among SEQ ${s.type.toLowerCase()} schools with a similar intake: ${ICSEA} within ±${ICSEA_NEAR} of its ${fmt(s.icsea[i])}, all sectors.</p>`)
      : `<p class="small" style="margin-top:0">Each school is placed among SEQ schools of its own type with a similar intake (${ICSEA} within ±${ICSEA_NEAR} of its own), so a dot further right means higher than its own peers, not higher than the other schools here.</p>`;
    return `${intro}
      <p class="note" style="margin:0 0 10px">This is context, not a ranking. None of these figures measures teaching quality directly, and there's no research basis for combining them into one score: league tables mostly reflect intake, and ranks overlap once uncertainty is counted (Goldstein &amp; Spiegelhalter, 1996).</p>
      <div class="card ctx">
        <div class="card-head"><h4>Learning progress <span class="ctx-ev" data-ev="strong">Strongest measure</span></h4><span class="mono muted">My School</span></div>
        <p class="small" style="margin:0">NAPLAN gain compared with students who had similar earlier scores and backgrounds is a value-added measure, the approach researchers recommend for judging schools (OECD, 2008). It's published on My School and can't be copied here.</p>
        <div class="links" style="margin-top:8px">${list.map((x, k) => `<a href="https://www.myschool.edu.au/school/${x.id}/naplan" target="_blank" rel="noopener">${one ? "Student progress" : `<span class="ctx-name"><i style="background:${colors[k]}"></i>${esc(shortName(x))}</span>`} <span>vs similar students ↗</span></a>`).join("")}</div>
      </div>
      ${CONTEXT.map((m) => contextCard(m, list, colors, idx(m))).join("")}
      <details class="ctx-refs"><summary>References</summary><ul>${[
        "Goldstein, H. &amp; Spiegelhalter, D. J. (1996). League tables and their limitations. <em>Journal of the Royal Statistical Society A</em>, 159(3).",
        ...CONTEXT_REFS].sort().map((r) => `<li>${r}</li>`).join("")}</ul></details>`;
  }

  function pickerHtml() {
    return `<div class="picker">
      <div class="picker-row">
        <input id="cmp-search" type="search" placeholder="Search a school, or click one on the map" autocomplete="off" aria-label="Add a school to compare">
        <button id="cmp-done" class="btn-ghost">Done</button>
      </div>
      <ul id="cmp-results" class="search-results" role="listbox" hidden></ul>
      <p class="note">${state.pickNote ? `<strong>${esc(state.pickNote)}</strong> ` : ""}Comparable: ${stageHint(sharedStages(compared()))}.</p>
    </div>`;
  }
  const stopPicking = () => { state.picking = false; state.pickNote = ""; render(); };

  function setupPicker() {
    const input = $("cmp-search"), list = $("cmp-results");
    $("cmp-done").onclick = stopPicking;
    let hits = [], active = 0;
    const draw = () => {
      list.hidden = !hits.length;
      list.innerHTML = hits.map((s, k) => `<li role="option" data-id="${s.id}" class="${k === active ? "active" : ""}${canCompare(s) ? "" : " off"}" aria-disabled="${!canCompare(s)}">
        ${glyph(sectorOf(s.sector), 14)}<div><div>${esc(s.name)}</div><div class="sub">${esc(s.suburb)} ${esc(s.postcode)} · ${esc(s.type)}${canCompare(s) ? "" : " · different age group"}</div></div></li>`).join("");
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
      else if (e.key === "Escape") stopPicking();
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
        ${mixedNote(list)}
        ${state.picking ? pickerHtml() : list.length < MAX_COMPARE ? `<button class="btn-ghost" id="cmp-add">+ Add another school</button>` : ""}`;
  }

  // ACARA reports Combined schools as a whole, so their figures include year levels the others don't teach.
  function mixedNote(list) {
    const combined = list.filter((s) => s.type === "Combined");
    if (!combined.length || combined.length === list.length) return "";
    const stage = sharedStages(list)[0];
    return `<p class="note">Compared as ${stage} schools. ${combined.map((s) => esc(shortName(s))).join(", ")}: figures cover the whole school${combined.length === 1 && combined[0].yr ? ` (${esc(combined[0].yr)})` : ""}, not only its ${stage} years.</p>`;
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
    if (!s) { closeDetail(); return; }
    const i = state.yearIdx, yr = YEARS[i];
    const sec = sectorOf(s.sector), col = cssVar(sec.css);
    const scroll = el.querySelector(".detail-body")?.scrollTop || 0;
    const list = compared(), many = list.length > 1;

    const body = many
      ? { overview: () => compareOverview(list, i), students: () => compareStudents(list, i), trends: () => compareTrends(list), report: () => compareReport(list), context: () => contextTab(list, list.map((_, k) => cmpColor(k))), naplan: () => compareNaplan(list) }[state.tab]()
      : { overview: () => overviewTab(s, i, col), students: () => studentsTab(s, i), trends: () => trendsTab(s, col), report: () => reportTab(s, col), context: () => contextTab([s], [col]), naplan: () => naplanTab(s) }[state.tab]();
    const missing = list.filter((x) => x.enr[i] == null).length;
    const missingNote = !missing ? "" : many ? ` · ${missing === 1 ? "one school" : missing + " schools"} didn't report this year` : " · no data reported this year";

    el.classList.toggle("comparing", many);
    el.innerHTML = `
      <div class="detail-head">
        <div class="sheet-grip" aria-hidden="true"></div>
        ${many ? compareHead(list) : singleHead(s, col)}
      </div>
      <div class="tab-bar">
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
    if (add) add.onclick = () => { state.picking = true; render(); };
    if (state.picking) setupPicker();
    const sc = $("show-catchment");
    if (sc) sc.onclick = (e) => { e.preventDefault(); showCatchmentOf(s); };
  }

  // Map clicks and search picks land here: while picking they join the comparison, otherwise they select.
  function choose(id, fly = true) {
    if (!state.picking || state.selected == null) return select(id, fly);
    const s = DATA.schools.find((x) => x.id === id);
    if (!inView(id) && !canCompare(s)) {
      state.pickNote = `${s.name} is a ${s.type.toLowerCase()} school, a different age group.`;
      return renderDetail();
    }
    state.pickNote = "";
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
  // state.catchMode is the level switched on ("" for off). With no school selected it's drawn over the
  // whole region; with a school selected, only the selected (and compared) schools' own catchments.
  const CATCH_LEVELS = ["primary", "junior", "senior"];
  const CATCH_NAMES = { primary: "primary", junior: "junior secondary", senior: "senior secondary" };
  const catchCache = {}, catchData = {};
  let catchLayer = null, catchRenderer = null, catchToken = 0;

  function loadCatch(key) {
    catchCache[key] = catchCache[key] || fetch(`data/catchments-${key}.geojson`)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((d) => { d.features.forEach((f) => (f._lvl = key)); return (catchData[key] = d); })
      .catch((err) => { delete catchCache[key]; throw err; });
    return catchCache[key];
  }
  const ownFeatures = (key, id) => (catchData[key] ? catchData[key].features.filter((f) => f.properties.id === id) : []);
  const schoolById = (id) => DATA.schools.find((x) => x.id === id);

  function catchStyle(f) {
    const dark = isDark();
    const gov = cssVar("--gov"), line = dark ? "#e3cfd4" : "#6b1a33";
    return inView(f.properties.id)
      ? { color: gov, weight: 3, opacity: 1, fillColor: gov, fillOpacity: 0.16 }
      : { color: line, weight: 1, opacity: dark ? 0.55 : 0.6, fillColor: line, fillOpacity: 0.03 };
  }

  // Bring the map, the control and the note in line with state.catchMode and the selection.
  async function syncCatchments() {
    const token = ++catchToken, mode = state.catchMode;
    const schools = state.selected == null ? [] : compared();
    document.querySelectorAll("#catch-by button").forEach((b) => b.classList.toggle("on", b.dataset.v === mode));
    try {
      if (mode && !catchData[mode]) $("catch-status").textContent = "loading…";
      if (mode) await loadCatch(mode);
    } catch (err) {
      if (token === catchToken) $("catch-status").textContent = "failed to load";
      return;
    }
    if (token !== catchToken) return; // changed again while loading

    const sig = !mode ? "" : schools.length ? `${mode}:${schools.map((s) => s.id).join(",")}` : mode;
    if (sig !== state.catch || (sig && !catchLayer)) {
      if (catchLayer) { map.removeLayer(catchLayer); catchLayer = null; }
      if (sig) {
        catchRenderer = catchRenderer || L.canvas({ padding: 0.5 });
        const features = schools.length ? schools.flatMap((s) => ownFeatures(mode, s.id)) : catchData[mode].features;
        catchLayer = L.geoJSON({ type: "FeatureCollection", features }, {
          renderer: catchRenderer,
          style: catchStyle,
          onEachFeature: (f, layer) => {
            layer.bindTooltip(`<strong>${esc(f.properties.name)}</strong><br><span class="muted">${CATCH_NAMES[mode]} catchment${schools.length ? "" : " · click to open"}</span>`, { sticky: true });
            layer.on("mouseover", () => layer.setStyle({ weight: 3, fillOpacity: 0.12 }));
            layer.on("mouseout", () => catchLayer && catchLayer.resetStyle(layer));
            layer.on("click", () => f.properties.id && choose(f.properties.id, false));
          },
        }).addTo(map);
        catchLayer.bringToBack();
      }
    }
    state.catch = sig;
    restyleCatchments();
    $("catch-status").textContent = mode ? "on" : "off";
    $("catch-note").innerHTML = catchNote(mode, schools);
  }

  function catchNote(mode, schools) {
    if (!mode || !schools.length) return "";
    const has = schools.filter((s) => ownFeatures(mode, s.id).length);
    if (schools.length > 1) {
      return has.length ? `Showing the ${CATCH_NAMES[mode]} catchments of ${has.length} of the ${schools.length} compared schools.`
        : `None of the compared schools has a ${CATCH_NAMES[mode]} catchment.`;
    }
    const s = schools[0];
    if (has.length) return `Showing <strong>${esc(s.name)}</strong>'s ${CATCH_NAMES[mode]} catchment.`;
    if (s.sector !== "Government") return `${esc(s.sector)} schools don't have catchments.`;
    const other = CATCH_LEVELS.filter((k) => k !== mode && ownFeatures(k, s.id).length);
    return `${esc(s.name)} has no ${CATCH_NAMES[mode]} catchment.` +
      (other.length ? ` Try ${other.map((k) => `<a href="#" data-catch="${k}">${CATCH_NAMES[k]}</a>`).join(" or ")}.` : "");
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

  // "Show catchment on map": switch on a level the school has a catchment at (the current one if it
  // can), then frame it.
  async function showCatchmentOf(s) {
    const order = [state.catchMode, CATCH_FOR_TYPE[s.type] || "primary", ...CATCH_LEVELS].filter(Boolean);
    for (const k of order) {
      try { await loadCatch(k); } catch (err) { continue; }
      if (ownFeatures(k, s.id).length) {
        if (state.catchMode !== k) await setCatchMode(k);
        fitCatchment(s);
        return;
      }
    }
  }

  // Every close goes through here so the phone sheet's drag position is cleared and it reopens at half.
  function closeDetail() {
    const el = $("detail");
    el.hidden = true;
    el.classList.remove("snapping");
    el.style.removeProperty("--sheet-top");
  }

  function select(id, fly = true) {
    state.selected = id;
    state.compare = [];
    state.picking = false;
    state.pickNote = "";
    writeHash();
    render();
    const synced = syncCatchments();
    if (id == null) { closeDetail(); return; }
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
      // Drop ids from older links that mix age groups; canCompare() checks against those kept so far.
      for (const c of new Set((p.get("cmp") || "").split(",").map(Number))) {
        const s = DATA.schools.find((x) => x.id === c);
        if (s && c !== id && state.compare.length < MAX_COMPARE - 1 && canCompare(s)) state.compare.push(c);
      }
    }
    if (CATCH_LEVELS.includes(p.get("c"))) state.catchMode = p.get("c");
    if (TABS.some(([k]) => k === p.get("t"))) state.tab = p.get("t");
  }

  /* ---------------- controls ---------------- */
  function syncPills() {
    document.querySelectorAll("#type-filter button").forEach((b) => b.classList.toggle("on", state.types.has(b.dataset.v)));
  }

  /* ---------------- phone bottom sheet ---------------- */
  // On phones the detail is a sheet (style.css): drag the head, or the content from the top of
  // its scroll, between half and full height; drag or flick down past half to close.
  // --sheet-top unset means half; "0px" means full.
  const PHONE = matchMedia("(max-width: 640px)");
  function setupSheet() {
    const el = $("detail");
    let drag = null;
    const halfTop = () => el.parentElement.clientHeight * 0.3 - 10;
    const snap = (top) => {
      el.classList.add("snapping");
      if (top == null) el.style.removeProperty("--sheet-top");
      else el.style.setProperty("--sheet-top", top + "px");
      setTimeout(() => el.classList.remove("snapping"), 300);
    };
    const close = () => {
      snap(el.parentElement.clientHeight);
      setTimeout(() => select(null), 260);
    };

    el.addEventListener("touchstart", (e) => {
      if (!PHONE.matches || e.touches.length > 1 || e.target.closest(".search-results")) return (drag = null);
      const t = e.touches[0];
      drag = { x0: t.clientX, y0: t.clientY, top0: el.offsetTop, body: e.target.closest(".detail-body"), on: null, track: [] };
    }, { passive: true });

    el.addEventListener("touchmove", (e) => {
      if (!drag) return;
      const t = e.touches[0], dx = t.clientX - drag.x0, dy = t.clientY - drag.y0;
      if (drag.on == null) {
        if (!dx && !dy) return;
        // In the content, move the sheet only where scrolling can't: pulling down from the top,
        // or pushing up while half open (the first swipe up expands the sheet, later ones scroll).
        drag.on = Math.abs(dy) > Math.abs(dx) &&
          (!drag.body || (dy > 0 && drag.body.scrollTop <= 0) || (dy < 0 && drag.top0 > 1));
        if (!drag.on) return (drag = null);
      }
      e.preventDefault();
      const top = Math.max(0, drag.top0 + dy);
      el.style.setProperty("--sheet-top", top + "px");
      drag.track.push([e.timeStamp, top]);
      if (drag.track.length > 5) drag.track.shift();
    }, { passive: false });

    const end = () => {
      const d = drag;
      drag = null;
      if (!d || !d.on || !d.track.length) return;
      const [t0, y0] = d.track[0], [t1, top] = d.track[d.track.length - 1];
      const v = (top - y0) / Math.max(1, t1 - t0), half = halfTop(); // px/ms, positive = down
      const fromFull = d.top0 < half / 2;
      if (v > 0.5) return fromFull ? snap(null) : close();
      if (v < -0.5) return snap(0);
      if (top > half + 100) return close();
      snap(top < half / 2 ? 0 : null);
    };
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
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
      if (b) setCatchMode(b.dataset.v);
    });
    $("catch-note").addEventListener("click", (e) => {
      const a = e.target.closest("[data-catch]");
      if (!a) return;
      e.preventDefault();
      setCatchMode(a.dataset.catch).then(() => fitCatchment(schoolById(state.selected)));
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
    $("yr-prev").onclick = () => setYear(state.yearIdx - 1);
    $("yr-next").onclick = () => setYear(state.yearIdx + 1);
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, select, textarea")) return;
      if (e.key === "ArrowLeft") setYear(state.yearIdx - 1);
      else if (e.key === "ArrowRight") setYear(state.yearIdx + 1);
      else if (e.key === "Escape" && state.picking) stopPicking();
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
      // Older builds kept `years` and [question, values] pairs on each school; leave those as they are.
      ANNUAL.years = ANNUAL.years || Object.values(ANNUAL.schools)[0]?.years || [];
      ANNUAL.y12Years = ANNUAL.y12Years || [];
      if (ANNUAL.items) Object.values(ANNUAL.schools).forEach((a) => {
        a.years = ANNUAL.years;
        Object.entries(a.sos || {}).forEach(([k, vals]) => {
          a.sos[k] = ANNUAL.items[k].map((q, j) => [q, vals[j]]).filter(([, v]) => v);
        });
      });
      if (DATA && state.selected != null) renderDetail();
    })
    .catch(() => { ANNUAL = { reportYear: null, schools: {}, years: [] }; });

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
      setupSheet();
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

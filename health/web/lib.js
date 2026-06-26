/* Era Health app logic. DATA is injected as a global (see template). */
(function () {
  "use strict";

  // ---- state ----
  var state = { chainIdx: 0, distSet: "all" };

  // ---- helpers ----
  function $(id) { return document.getElementById(id); }
  function chain() { return DATA[state.chainIdx]; }
  function tok(planckStr, c) { return Number(planckStr) / Math.pow(10, c.tokenDecimals); }

  function fmtToken(n) {
    var abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return n.toFixed(abs < 10 ? 2 : 0);
  }
  function fmtInt(n) { return n.toLocaleString("en-US"); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // Delta chip comparing newest vs previous era. `goodUp` = increase is "good".
  function deltaChip(curr, prev, opts) {
    opts = opts || {};
    if (prev == null || prev === 0) return '<span class="d flat">—</span>';
    var pct = ((curr - prev) / Math.abs(prev)) * 100;
    var cls = Math.abs(pct) < 0.05 ? "flat" : pct > 0 ? "up" : "down";
    var sign = pct > 0 ? "+" : "";
    return '<span class="d ' + cls + '">' + sign + pct.toFixed(1) + "%</span>";
  }

  function kpi(k, v, delta) {
    return '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v +
      (delta != null ? " " + delta : "") + "</div></div>";
  }

  // ---- canvas sizing (hi-dpi) ----
  function prep(canvas, cssH) {
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 520;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = cssH + "px";
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx: ctx, w: cssW, h: cssH };
  }

  // Grouped/line axis frame. Returns plot rect + helpers.
  function axes(ctx, w, h, opts) {
    var padL = opts.padL || 44, padR = opts.padR || 12, padT = 12, padB = 26;
    var x0 = padL, x1 = w - padR, y0 = h - padB, y1 = padT;
    var line = cssVar("--line"), faint = cssVar("--faint");
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.font = '10px ' + cssVar("--mono");
    ctx.fillStyle = faint;
    // horizontal gridlines
    var ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var y = y1 + (y0 - y1) * (i / ticks);
      ctx.globalAlpha = i === ticks ? 1 : 0.5;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.globalAlpha = 1;
      var val = opts.max * (1 - i / ticks);
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(opts.fmt ? opts.fmt(val) : fmtToken(val), x0 - 6, y);
    }
    return { x0: x0, x1: x1, y0: y0, y1: y1 };
  }

  function xLabels(ctx, fr, labels) {
    ctx.fillStyle = cssVar("--faint");
    ctx.font = '10px ' + cssVar("--mono");
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    var n = labels.length;
    for (var i = 0; i < n; i++) {
      var x = fr.x0 + (fr.x1 - fr.x0) * (n === 1 ? 0.5 : i / (n - 1));
      ctx.fillText(labels[i], x, fr.y0 + 6);
    }
  }

  // ---- charts ----
  // axes with an arbitrary [min,max] range (non-zero baseline), for tight data.
  function axesRange(ctx, w, h, lo, hi, fmt) {
    var padL = 48, padR = 12, padT = 12, padB = 26;
    var x0 = padL, x1 = w - padR, y0 = h - padB, y1 = padT;
    ctx.strokeStyle = cssVar("--line"); ctx.lineWidth = 1;
    ctx.font = '10px ' + cssVar("--mono"); ctx.fillStyle = cssVar("--faint");
    var ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var y = y1 + (y0 - y1) * (i / ticks);
      ctx.globalAlpha = i === ticks ? 1 : 0.5;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.globalAlpha = 1;
      var val = hi - (hi - lo) * (i / ticks);
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText((fmt || fmtToken)(val), x0 - 6, y);
    }
    return { x0: x0, x1: x1, y0: y0, y1: y1, lo: lo, hi: hi };
  }

  function drawElection(canvas, cssH) {
    var c = chain(), eras = c.eras;
    var p = prep(canvas, cssH || 150);
    // Realized minimal backing of the elected set per era, vs the governance
    // min-score threshold (a flat floor). Backings sit well above the floor and
    // close together, so use a zoomed baseline that still shows the threshold.
    var backing = eras.map(function (e) { return tok(e.activeMinBacking, c); });
    var thr = eras.map(function (e) { return e.minimumScore ? tok(e.minimumScore.minimalStake, c) : 0; });
    var dataMin = Math.min.apply(null, backing.concat(thr));
    var dataMax = Math.max.apply(null, backing);
    var lo = Math.max(0, dataMin - (dataMax - dataMin) * 0.4 - 1);
    var hi = dataMax + (dataMax - dataMin) * 0.25 + 1;
    var fr = axesRange(p.ctx, p.w, p.h, lo, hi);
    function yOf(v) { return fr.y0 - (fr.y0 - fr.y1) * ((v - lo) / (hi - lo)); }
    var n = eras.length, bw = (fr.x1 - fr.x0) / n;
    for (var i = 0; i < n; i++) {
      var cx = fr.x0 + bw * (i + 0.5);
      var yb = yOf(backing[i]);
      p.ctx.fillStyle = cssVar("--accent");
      p.ctx.fillRect(cx - bw * 0.28, yb, bw * 0.56, fr.y0 - yb);
    }
    // threshold floor as a dashed warn line across the frame
    var yt = yOf(thr[thr.length - 1]);
    p.ctx.strokeStyle = cssVar("--warn"); p.ctx.lineWidth = 1.5;
    p.ctx.setLineDash([5, 4]);
    p.ctx.beginPath(); p.ctx.moveTo(fr.x0, yt); p.ctx.lineTo(fr.x1, yt); p.ctx.stroke();
    p.ctx.setLineDash([]);
    xLabels(p.ctx, fr, eras.map(function (e) { return e.era; }));
  }

  function drawStaking1(canvas, cssH) {
    var c = chain(), eras = c.eras;
    var p = prep(canvas, cssH || 150);
    var noms = eras.map(function (e) { return e.nominatorCount; });
    var vals = eras.map(function (e) { return e.registeredValidatorCount; });
    var unb = eras.map(function (e) { return tok(e.unbonding.totalValue, c); });
    // Each series is auto-zoomed to its own range so small era-to-era movement
    // is visible; this is a multi-series trend frame, not a shared-axis chart.
    var padL = 12, padR = 12, padT = 12, padB = 26;
    var fr = { x0: padL, x1: p.w - padR, y0: p.h - padB, y1: padT };
    p.ctx.strokeStyle = cssVar("--line"); p.ctx.lineWidth = 1; p.ctx.globalAlpha = 0.5;
    p.ctx.beginPath(); p.ctx.moveTo(fr.x0, fr.y0); p.ctx.lineTo(fr.x1, fr.y0); p.ctx.stroke();
    p.ctx.globalAlpha = 1;
    function line(arr, color) {
      var lo = Math.min.apply(null, arr), hi = Math.max.apply(null, arr);
      var span = hi - lo || 1;
      // leave headroom so flat series sit mid-frame, not glued to an edge
      var pad = span * 0.35;
      lo -= pad; hi += pad; span = hi - lo;
      var n = arr.length;
      function pt(i) {
        return [
          fr.x0 + (fr.x1 - fr.x0) * (n === 1 ? 0.5 : i / (n - 1)),
          fr.y0 - (fr.y0 - fr.y1) * ((arr[i] - lo) / span)
        ];
      }
      p.ctx.strokeStyle = color; p.ctx.lineWidth = 2; p.ctx.beginPath();
      for (var i = 0; i < n; i++) { var a = pt(i); if (i === 0) p.ctx.moveTo(a[0], a[1]); else p.ctx.lineTo(a[0], a[1]); }
      p.ctx.stroke();
      p.ctx.fillStyle = color;
      for (var j = 0; j < n; j++) { var b = pt(j); p.ctx.beginPath(); p.ctx.arc(b[0], b[1], 2.6, 0, 7); p.ctx.fill(); }
      // end-value label
      var last = pt(n - 1);
      p.ctx.font = '10px ' + cssVar("--mono"); p.ctx.textAlign = "right"; p.ctx.textBaseline = "bottom";
      p.ctx.fillText(fmtToken(arr[n - 1]), last[0] - 4, last[1] - 3);
    }
    line(noms, cssVar("--accent"));
    line(vals, cssVar("--accent-2"));
    line(unb, cssVar("--warn"));
    xLabels(p.ctx, fr, eras.map(function (e) { return e.era; }));
  }

  function drawInflation(canvas, cssH) {
    var c = chain(), eras = c.eras;
    var p = prep(canvas, cssH || 150);
    // Per-era finalized pots: staker reward + validator incentive (these ARE per-era).
    // Buffer delta vs previous era approximates buffer-bound inflation.
    var staker = eras.map(function (e) { return tok(e.totalStakerReward, c); });
    var incent = eras.map(function (e) { return tok(e.validatorIncentiveBudget, c); });
    var bufDelta = eras.map(function (e, i) {
      if (i === 0) return 0;
      return Math.max(0, tok(e.pots.buffer, c) - tok(eras[i - 1].pots.buffer, c));
    });
    var totals = eras.map(function (_, i) { return staker[i] + incent[i] + bufDelta[i]; });
    var max = Math.max.apply(null, totals) * 1.12 || 1;
    var fr = axes(p.ctx, p.w, p.h, { max: max });
    var n = eras.length, bw = (fr.x1 - fr.x0) / n;
    var cols = [cssVar("--accent"), cssVar("--accent-2"), cssVar("--warn")];
    for (var i = 0; i < n; i++) {
      var cx = fr.x0 + bw * (i + 0.5);
      var segs = [staker[i], incent[i], bufDelta[i]];
      var acc = 0;
      for (var s = 0; s < 3; s++) {
        var hs = (fr.y0 - fr.y1) * (segs[s] / max);
        p.ctx.fillStyle = cols[s];
        p.ctx.fillRect(cx - bw * 0.3, fr.y0 - acc - hs, bw * 0.6, hs);
        acc += hs;
      }
    }
    xLabels(p.ctx, fr, eras.map(function (e) { return e.era; }));
  }

  // ---- distribution table ----
  // Buckets high→low. Zero-count rows are hidden (except the 0-stake row, which
  // is informative). Boundaries: lower inclusive, upper exclusive.
  var BUCKETS = [
    { label: "> 100k", test: function (t) { return t >= 100000; }, hideIfZero: true },
    { label: "30k – 100k", test: function (t) { return t >= 30000 && t < 100000; }, hideIfZero: true },
    { label: "10k – 30k", test: function (t) { return t >= 10000 && t < 30000; } },
    { label: "5k – 10k", test: function (t) { return t >= 5000 && t < 10000; } },
    { label: "0 – 5k", test: function (t) { return t > 0 && t < 5000; } },
    { label: "0", test: function (t) { return t === 0; } }
  ];

  function renderDist() {
    var c = chain();
    var latest = c.eras[c.eras.length - 1];
    var stakes = state.distSet === "active" ? latest.activeValidatorOwnStakes : latest.allValidatorOwnStakes;
    var toks = stakes.map(function (s) { return Math.floor(tok(s, c)); });
    var total = toks.length;
    var counts = BUCKETS.map(function (b) { return toks.filter(b.test).length; });
    var maxCount = Math.max.apply(null, counts) || 1;
    var ge10k = toks.filter(function (t) { return t >= 10000; }).length;
    var maxStake = total ? Math.max.apply(null, toks) : 0;
    // Pile-ups at round self-stake targets (exact planck match).
    var unit = Math.pow(10, c.tokenDecimals);
    function exactlyN(k) {
      var target = k * unit;
      return stakes.filter(function (s) { return Number(s) === target; }).length;
    }
    var exactTargets = [10000, 30000, 100000].map(function (k) {
      return { k: k, n: exactlyN(k) };
    }).filter(function (e) { return e.n > 0; });

    var scope = state.distSet === "active" ? "active set, era " + latest.era : "all registered";
    $("distHint").textContent = scope + " · " + fmtInt(total) + " validators · max " + fmtToken(maxStake) + " " + c.tokenSymbol;
    // (i) tooltip carries the provenance: the block these stakes were read at.
    // Only meaningful for "all" (queried at a block); active = era exposures.
    var info = $("distInfo");
    if (state.distSet === "all") {
      info.style.display = "";
      info.setAttribute("data-tip", "read at block " + fmtInt(latest.balanceBlock));
    } else {
      info.style.display = "none";
    }

    var rows = '<tr><th>self-stake</th><th>count</th><th></th><th>%</th></tr>';
    for (var i = 0; i < BUCKETS.length; i++) {
      if (BUCKETS[i].hideIfZero && counts[i] === 0) continue;
      var pct = total ? (counts[i] / total) * 100 : 0;
      var bw = (counts[i] / maxCount) * 100;
      rows += '<tr><td>' + BUCKETS[i].label + '</td><td style="text-align:right">' + fmtInt(counts[i]) +
        '</td><td class="bar-cell"><div class="bar" style="width:' + bw.toFixed(1) + '%"></div></td>' +
        '<td style="text-align:right">' + pct.toFixed(1) + '%</td></tr>';
    }
    rows += '<tr><td class="cum">≥ 10k (cum)</td><td class="cum" style="text-align:right">' + fmtInt(ge10k) +
      '</td><td></td><td class="cum" style="text-align:right">' + (total ? (ge10k / total * 100).toFixed(1) : "0") + '%</td></tr>';
    // Exact round-number targets (subset of the buckets above; many operators
    // park their self-stake on these levels).
    for (var e = 0; e < exactTargets.length; e++) {
      var et = exactTargets[e];
      var epct = total ? (et.n / total) * 100 : 0;
      rows += '<tr><td class="exact">= ' + fmtToken(et.k) + '</td><td class="exact" style="text-align:right">' + fmtInt(et.n) +
        '</td><td></td><td class="exact" style="text-align:right">' + epct.toFixed(1) + '%</td></tr>';
    }
    $("distTable").innerHTML = rows;
  }

  // ---- KPI panels ----
  function renderKpis() {
    var c = chain();
    var eras = c.eras, n = eras.length;
    var last = eras[n - 1], prev = n > 1 ? eras[n - 2] : null;

    // Election: realized min backing of the elected set vs the governance floor.
    $("electionHint").textContent = "round " + (last.electionRound != null ? last.electionRound : "—");
    var lastBack = tok(last.activeMinBacking, c);
    var prevBack = prev ? tok(prev.activeMinBacking, c) : null;
    var floor = last.minimumScore ? tok(last.minimumScore.minimalStake, c) : 0;
    var marginX = floor > 0 ? (lastBack / floor) : 0;
    $("electionKpis").innerHTML =
      kpi("min backing (elected)", fmtToken(lastBack) + ' <small>' + c.tokenSymbol + '</small>', deltaChip(lastBack, prevBack)) +
      kpi("min-score floor", fmtToken(floor) + ' <small>' + c.tokenSymbol + '</small>') +
      kpi("margin over floor", (marginX ? marginX.toFixed(2) + "×" : "—"));

    // Staking 1
    $("staking1Kpis").innerHTML =
      kpi("nominators", fmtInt(last.nominatorCount), deltaChip(last.nominatorCount, prev ? prev.nominatorCount : null)) +
      kpi("registered validators", fmtInt(last.registeredValidatorCount), deltaChip(last.registeredValidatorCount, prev ? prev.registeredValidatorCount : null)) +
      kpi("min active stake", fmtToken(tok(last.minimumActiveStake, c)) + ' <small>' + c.tokenSymbol + '</small>') +
      kpi("unbonding", fmtToken(tok(last.unbonding.totalValue, c)) + ' <small>' + c.tokenSymbol + '</small>',
        deltaChip(tok(last.unbonding.totalValue, c), prev ? tok(prev.unbonding.totalValue, c) : null)) +
      kpi("unbonding ledgers", fmtInt(last.unbonding.ledgerCount));

    // Inflation
    var stakerR = tok(last.totalStakerReward, c), incentR = tok(last.validatorIncentiveBudget, c);
    var bufDelta = prev ? Math.max(0, tok(last.pots.buffer, c) - tok(prev.pots.buffer, c)) : 0;
    var dayTotal = stakerR + incentR + bufDelta;
    $("inflationHint").textContent = "per era (≈ daily)";
    $("inflationKpis").innerHTML =
      kpi("total / era", fmtToken(dayTotal) + ' <small>' + c.tokenSymbol + '</small>') +
      kpi("staker rewards", fmtToken(stakerR) + ' <small>' + c.tokenSymbol + '</small>',
        deltaChip(stakerR, prev ? tok(prev.totalStakerReward, c) : null)) +
      kpi("validator incentive", fmtToken(incentR) + ' <small>' + c.tokenSymbol + '</small>') +
      kpi("buffer", fmtToken(tok(last.pots.buffer, c)) + ' <small>' + c.tokenSymbol + '</small>');
  }

  // ---- zoom overlay ----
  var CHART_FNS = {
    election: { fn: drawElection, title: "Election — min backing of elected set vs min-score floor",
      legend: '<span><i style="background:var(--accent)"></i>min backing of elected set</span><span><i style="background:var(--warn)"></i>min-score floor</span>' },
    staking1: { fn: drawStaking1, title: "Nominators / registered validators / unbonding (trend)",
      legend: '<span><i style="background:var(--accent)"></i>nominators</span><span><i style="background:var(--accent-2)"></i>registered validators</span><span><i style="background:var(--warn)"></i>unbonding (own scale)</span>' },
    inflation: { fn: drawInflation, title: "Inflation per era — staker / incentive / buffer Δ",
      legend: '<span><i style="background:var(--accent)"></i>staker rewards</span><span><i style="background:var(--accent-2)"></i>validator incentive</span><span><i style="background:var(--warn)"></i>buffer Δ</span>' }
  };

  function openZoom(card) {
    var meta = CHART_FNS[card];
    if (!meta) return; // staking2 (table) not zoomable
    $("overlayTitle").textContent = meta.title;
    $("overlayLegend").innerHTML = meta.legend;
    $("overlay").classList.add("open");
    meta.fn($("overlayChart"), Math.min(window.innerHeight * 0.62, 460));
  }
  function closeZoom() { $("overlay").classList.remove("open"); }

  // ---- render-all + wiring ----
  function renderCharts() {
    drawElection($("electionChart"));
    drawStaking1($("staking1Chart"));
    drawInflation($("inflationChart"));
    renderDist();
  }
  function renderAll() { renderKpis(); renderCharts(); renderFooter(); }

  function renderFooter() {
    var c = chain();
    var when = c.updatedAtMs ? new Date(Number(c.updatedAtMs)).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";
    var range = c.eras.length ? c.eras[0].era + "–" + c.eras[c.eras.length - 1].era : "—";
    $("basis").innerHTML = "Polkadot · eras <code>" + range + "</code> · snapshot updated <code>" + when + "</code>";
  }

  function init() {
    // theme: remember choice
    try {
      var saved = localStorage.getItem("st-theme");
      if (saved) document.documentElement.setAttribute("data-theme", saved);
    } catch (e) {}
    $("themeToggle").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      var isLight = cur === "light" || (!cur && window.matchMedia("(prefers-color-scheme: light)").matches);
      var next = isLight ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("st-theme", next); } catch (e) {}
      renderCharts(); // recolor canvases
    });

    // distribution active/all toggle
    var seg = $("distSeg");
    seg.addEventListener("click", function (ev) {
      var b = ev.target.closest("button"); if (!b) return;
      state.distSet = b.getAttribute("data-set");
      Array.prototype.forEach.call(seg.querySelectorAll("button"), function (x) {
        x.setAttribute("aria-pressed", x === b ? "true" : "false");
      });
      renderDist();
    });

    // zoom: click a card opens overlay
    Array.prototype.forEach.call(document.querySelectorAll(".card"), function (card) {
      card.addEventListener("click", function (ev) {
        if (ev.target.closest(".seg")) return; // toggles handle their own clicks
        openZoom(card.getAttribute("data-card"));
      });
    });
    $("overlayClose").addEventListener("click", closeZoom);
    $("overlay").addEventListener("click", function (ev) { if (ev.target === $("overlay")) closeZoom(); });
    document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") closeZoom(); });

    window.addEventListener("resize", renderCharts);
    renderAll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

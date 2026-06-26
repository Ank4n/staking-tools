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
    // Per-era min stake (least-backed winner) vs the governance min-required
    // floor. Use a ZERO baseline so bar heights and the floor line are
    // proportional — the headline here is the ratio to the floor (~1.44×), which
    // a zoomed baseline would distort. (Era-to-era variation is only ~4%, so it
    // reads near-flat; that's an acceptable trade for an honest ratio.)
    var backing = eras.map(function (e) { return tok(e.activeMinBacking, c); });
    var thr = eras.map(function (e) { return e.minimumScore ? tok(e.minimumScore.minimalStake, c) : 0; });
    var lo = 0;
    var hi = Math.max.apply(null, backing) * 1.12 || 1;
    var fr = axesRange(p.ctx, p.w, p.h, lo, hi);
    function yOf(v) { return fr.y0 - (fr.y0 - fr.y1) * ((v - lo) / (hi - lo)); }
    var n = eras.length, bw = (fr.x1 - fr.x0) / n;
    var hits = [];
    for (var i = 0; i < n; i++) {
      var cx = fr.x0 + bw * (i + 0.5);
      var yb = yOf(backing[i]);
      var rx = cx - bw * 0.28, rw = bw * 0.56;
      p.ctx.fillStyle = cssVar("--accent");
      p.ctx.fillRect(rx, yb, rw, fr.y0 - yb);
      var mult = thr[i] > 0 ? (backing[i] / thr[i]) : 0;
      hits.push({ rect: { x: rx, y: yb, w: rw, h: fr.y0 - yb },
        color: cssVar("--accent"), label: "min stake", era: eras[i].era,
        text: fmtToken(backing[i]) + " " + c.tokenSymbol + (mult ? "  (" + mult.toFixed(2) + "× floor)" : "") });
    }
    // threshold floor as a dashed warn line across the frame
    var yt = yOf(thr[thr.length - 1]);
    p.ctx.strokeStyle = cssVar("--warn"); p.ctx.lineWidth = 1.5;
    p.ctx.setLineDash([5, 4]);
    p.ctx.beginPath(); p.ctx.moveTo(fr.x0, yt); p.ctx.lineTo(fr.x1, yt); p.ctx.stroke();
    p.ctx.setLineDash([]);
    xLabels(p.ctx, fr, eras.map(function (e) { return e.era; }));
    canvas._hits = hits; canvas._cssW = p.w; attachHover(canvas);
  }

  function drawStaking1(canvas, cssH) {
    var c = chain(), eras = c.eras;
    var p = prep(canvas, cssH || 150);
    var noms = eras.map(function (e) { return e.nominatorCount; });
    var vals = eras.map(function (e) { return e.registeredValidatorCount; });
    var unb = eras.map(function (e) { return tok(e.unbonding.totalValue, c); });
    // Each series is auto-zoomed to its own range so small era-to-era movement
    // is visible; this is a multi-series trend frame, not a shared-axis chart.
    // Exact values aren't comparable by height, so they're shown on hover only.
    var padL = 12, padR = 12, padT = 14, padB = 26;
    var fr = { x0: padL, x1: p.w - padR, y0: p.h - padB, y1: padT };
    p.ctx.strokeStyle = cssVar("--line"); p.ctx.lineWidth = 1; p.ctx.globalAlpha = 0.5;
    p.ctx.beginPath(); p.ctx.moveTo(fr.x0, fr.y0); p.ctx.lineTo(fr.x1, fr.y0); p.ctx.stroke();
    p.ctx.globalAlpha = 1;
    var hits = [];
    function line(arr, color, label, fmtFn) {
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
      for (var j = 0; j < n; j++) {
        var b = pt(j);
        p.ctx.beginPath(); p.ctx.arc(b[0], b[1], 2.6, 0, 7); p.ctx.fill();
        hits.push({ x: b[0], y: b[1], color: color, label: label, era: eras[j].era, text: fmtFn(arr[j]) });
      }
    }
    line(noms, cssVar("--accent"), "nominators", fmtInt);
    line(vals, cssVar("--accent-2"), "registered validators", fmtInt);
    line(unb, cssVar("--warn"), "unbonding", function (v) { return fmtToken(v) + " " + c.tokenSymbol; });
    xLabels(p.ctx, fr, eras.map(function (e) { return e.era; }));
    // Stash hit-points + css size on the canvas so the hover handler (bound
    // once) can map cursor -> nearest point and show its exact value.
    canvas._hits = hits;
    canvas._cssW = p.w;
    attachHover(canvas);
  }

  // Bind a single mousemove/leave handler per canvas that highlights the nearest
  // recorded point and shows a floating tooltip with its exact value.
  function attachHover(canvas) {
    if (canvas._hoverBound) return;
    canvas._hoverBound = true;
    canvas.style.cursor = "crosshair";
    canvas.addEventListener("mousemove", function (ev) {
      var hits = canvas._hits;
      if (!hits || !hits.length) return;
      var rect = canvas.getBoundingClientRect();
      // canvas is drawn in CSS px (we setTransform by dpr), so map by clientWidth.
      var scale = (canvas._cssW || rect.width) / rect.width;
      var mx = (ev.clientX - rect.left) * scale;
      var my = (ev.clientY - rect.top) * scale;
      // Prefer rectangle containment (bar charts): any point inside a bar's box
      // wins. Falls back to nearest-point within a radius (line charts).
      var hit = null, bestD = 1e9;
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i];
        if (h.rect) {
          if (mx >= h.rect.x && mx <= h.rect.x + h.rect.w &&
              my >= h.rect.y && my <= h.rect.y + h.rect.h) { hit = h; break; }
        } else {
          var dx = h.x - mx, dy = h.y - my, d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; if (d <= 18 * 18) hit = h; }
        }
      }
      if (hit) showTip(ev.clientX, ev.clientY, hit);
      else hideTip();
    });
    canvas.addEventListener("mouseleave", hideTip);
  }

  function tipEl() {
    var el = $("hoverTip");
    if (!el) {
      el = document.createElement("div");
      el.id = "hoverTip";
      el.className = "hovertip";
      document.body.appendChild(el);
    }
    return el;
  }
  function showTip(clientX, clientY, hit) {
    var el = tipEl();
    el.innerHTML = '<span class="ht-dot" style="background:' + hit.color + '"></span>' +
      '<span class="ht-label">' + hit.label + '</span> · era ' + hit.era +
      '<br><span class="ht-val">' + hit.text + '</span>';
    el.style.display = "block";
    // position above-right of the cursor, clamped to viewport
    var x = clientX + 12, y = clientY - 12;
    el.style.left = Math.min(x, window.innerWidth - el.offsetWidth - 8) + "px";
    el.style.top = Math.max(8, y - el.offsetHeight) + "px";
  }
  function hideTip() {
    var el = $("hoverTip");
    if (el) el.style.display = "none";
  }

  function drawInflation(canvas, cssH) {
    var c = chain(), eras = c.eras;
    var p = prep(canvas, cssH || 150);
    // Per-era reward pots (both ARE per-era on-chain values): staker rewards +
    // validator incentive budget, stacked. Buffer now lives in its own card.
    var staker = eras.map(function (e) { return tok(e.totalStakerReward, c); });
    var incent = eras.map(function (e) { return tok(e.validatorIncentiveBudget, c); });
    var totals = eras.map(function (_, i) { return staker[i] + incent[i]; });
    var max = Math.max.apply(null, totals) * 1.12 || 1;
    var fr = axes(p.ctx, p.w, p.h, { max: max });
    var n = eras.length, bw = (fr.x1 - fr.x0) / n;
    var hits = [];
    for (var i = 0; i < n; i++) {
      var cx = fr.x0 + bw * (i + 0.5);
      var segs = [
        { v: staker[i], color: cssVar("--accent"), label: "staker rewards" },
        { v: incent[i], color: cssVar("--accent-2"), label: "validator incentive" }
      ];
      var acc = 0;
      for (var s = 0; s < segs.length; s++) {
        var hs = (fr.y0 - fr.y1) * (segs[s].v / max);
        var ry = fr.y0 - acc - hs;
        p.ctx.fillStyle = segs[s].color;
        p.ctx.fillRect(cx - bw * 0.3, ry, bw * 0.6, hs);
        // hit-test the whole segment rectangle (min 6px tall so thin/zero
        // segments are still hoverable).
        hits.push({ rect: { x: cx - bw * 0.3, y: ry, w: bw * 0.6, h: Math.max(hs, 6) },
          color: segs[s].color, label: segs[s].label, era: eras[i].era,
          text: fmtToken(segs[s].v) + " " + c.tokenSymbol });
        acc += hs;
      }
    }
    xLabels(p.ctx, fr, eras.map(function (e) { return e.era; }));
    canvas._hits = hits; canvas._cssW = p.w; attachHover(canvas);
  }

  function drawBuffer(canvas, cssH) {
    var c = chain(), eras = c.eras;
    var p = prep(canvas, cssH || 150);
    // Cumulative DAP buffer balance per era (a stock that keeps growing). Each
    // bar's bright TOP segment is that era's growth (Δ = balance - prevBalance);
    // the darker base is the prior balance. Hover shows exact balance + Δ.
    var bal = eras.map(function (e) { return tok(e.pots.buffer, c); });
    var delta = eras.map(function (e, i) { return i === 0 ? 0 : Math.max(0, bal[i] - bal[i - 1]); });
    var max = Math.max.apply(null, bal) * 1.1 || 1;
    var fr = axes(p.ctx, p.w, p.h, { max: max });
    var n = eras.length, bw = (fr.x1 - fr.x0) / n;
    var base = cssVar("--accent"), top = cssVar("--accent-2");
    var hits = [];
    for (var i = 0; i < n; i++) {
      var cx = fr.x0 + bw * (i + 0.5);
      var yTotal = fr.y0 - (fr.y0 - fr.y1) * (bal[i] / max);
      var yBase = fr.y0 - (fr.y0 - fr.y1) * ((bal[i] - delta[i]) / max);
      // base segment (prior balance)
      p.ctx.fillStyle = base;
      p.ctx.fillRect(cx - bw * 0.3, yBase, bw * 0.6, fr.y0 - yBase);
      // delta segment (this era's growth) on top, brighter
      p.ctx.fillStyle = top;
      p.ctx.fillRect(cx - bw * 0.3, yTotal, bw * 0.6, yBase - yTotal);
      // whole bar is one hit target -> shows balance + Δ anywhere on it
      hits.push({ rect: { x: cx - bw * 0.3, y: yTotal, w: bw * 0.6, h: fr.y0 - yTotal },
        color: top, label: "buffer", era: eras[i].era,
        text: fmtToken(bal[i]) + " " + c.tokenSymbol + "  (Δ " + (delta[i] > 0 ? "+" : "") + fmtToken(delta[i]) + ")" });
    }
    xLabels(p.ctx, fr, eras.map(function (e) { return e.era; }));
    canvas._hits = hits; canvas._cssW = p.w; attachHover(canvas);
  }

  // ---- distribution table ----
  // Buckets high→low, interleaving exact round-number targets (many operators
  // park their self-stake exactly on 10k/30k/100k) with the ranges between them.
  // Ranges strictly exclude the round numbers, so every validator lands in
  // exactly one row. `exact` rows match raw planck (100,002 stays in "> 100k").
  // `always` rows show even at count 0 (their presence/absence is the signal).
  var BUCKETS = [
    { label: "> 100k", lo: 100000, exLo: true, hideIfZero: true },
    { label: "= 100k", exact: 100000, always: true },
    { label: "30k – 100k", lo: 30000, hi: 100000, exLo: true, exHi: true, hideIfZero: true },
    { label: "= 30k", exact: 30000, always: true },
    { label: "10k – 30k", lo: 10000, hi: 30000, exLo: true, exHi: true },
    { label: "= 10k", exact: 10000, always: true },
    { label: "5k – 10k", lo: 5000, hi: 10000, exHi: true },
    { label: "0 – 5k", lo: 0, hi: 5000, exLo: true, exHi: true },
    { label: "0", exact: 0 }
  ];

  function renderDist() {
    var c = chain();
    var latest = c.eras[c.eras.length - 1];
    var stakes = state.distSet === "active" ? latest.activeValidatorOwnStakes : latest.allValidatorOwnStakes;
    var unit = BigInt(Math.pow(10, c.tokenDecimals));
    // Classify each validator once, by raw planck, into the first matching row.
    // Compare in BigInt: total stake in planck routinely exceeds 2^53, so Number
    // would lose precision and misclassify the round-number "exact" rows.
    var planck = stakes.map(function (s) { return BigInt(s); });
    var total = planck.length;
    // Bucket bounds (lo/hi/exact) are whole-token numbers; scale to planck.
    function matches(b, p) {
      if (b.exact != null) return p === BigInt(b.exact) * unit;
      if (b.lo != null) { var lo = BigInt(b.lo) * unit; if (b.exLo ? p <= lo : p < lo) return false; }
      if (b.hi != null) { var hi = BigInt(b.hi) * unit; if (b.exHi ? p >= hi : p > hi) return false; }
      return true;
    }
    var counts = BUCKETS.map(function (b) {
      return planck.filter(function (p) { return matches(b, p); }).length;
    });
    var maxCount = Math.max.apply(null, counts) || 1;
    var ge10kThr = BigInt(10000) * unit;
    var ge10k = planck.filter(function (p) { return p >= ge10kThr; }).length;
    // maxStake is display-only; Number-divide is fine here (loses <1 token).
    var maxStake = total
      ? planck.reduce(function (m, p) { return p > m ? p : m; }, 0n)
      : 0n;
    maxStake = Number(maxStake) / Math.pow(10, c.tokenDecimals);

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
      var b = BUCKETS[i];
      if (b.hideIfZero && counts[i] === 0) continue;
      var pct = total ? (counts[i] / total) * 100 : 0;
      var bw = (counts[i] / maxCount) * 100;
      var cls = b.exact != null && b.exact > 0 ? " class=\"exactrow\"" : "";
      rows += '<tr' + cls + '><td>' + b.label + '</td><td style="text-align:right">' + fmtInt(counts[i]) +
        '</td><td class="bar-cell"><div class="bar" style="width:' + bw.toFixed(1) + '%"></div></td>' +
        '<td style="text-align:right">' + pct.toFixed(1) + '%</td></tr>';
    }
    rows += '<tr><td class="cum">≥ 10k (cum)</td><td class="cum" style="text-align:right">' + fmtInt(ge10k) +
      '</td><td></td><td class="cum" style="text-align:right">' + (total ? (ge10k / total * 100).toFixed(1) : "0") + '%</td></tr>';
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
      kpi("min stake — era " + last.era, fmtToken(lastBack) + ' <small>' + c.tokenSymbol + '</small>', deltaChip(lastBack, prevBack)) +
      kpi("min required", fmtToken(floor) + ' <small>' + c.tokenSymbol + '</small>') +
      kpi("margin over floor", (marginX ? marginX.toFixed(2) + "×" : "—"));

    // Staking 1
    $("staking1Kpis").innerHTML =
      kpi("nominators", fmtInt(last.nominatorCount), deltaChip(last.nominatorCount, prev ? prev.nominatorCount : null)) +
      kpi("registered validators", fmtInt(last.registeredValidatorCount), deltaChip(last.registeredValidatorCount, prev ? prev.registeredValidatorCount : null)) +
      kpi("min active stake", fmtToken(tok(last.minimumActiveStake, c)) + ' <small>' + c.tokenSymbol + '</small>') +
      kpi("unbonding", fmtToken(tok(last.unbonding.totalValue, c)) + ' <small>' + c.tokenSymbol + '</small>',
        deltaChip(tok(last.unbonding.totalValue, c), prev ? tok(prev.unbonding.totalValue, c) : null)) +
      kpi("unbonding ledgers", fmtInt(last.unbonding.ledgerCount));

    // Inflation: staker rewards + validator incentive (per-era reward pots).
    var stakerR = tok(last.totalStakerReward, c), incentR = tok(last.validatorIncentiveBudget, c);
    var rewardTotal = stakerR + incentR;
    $("inflationHint").textContent = "per-era reward pots";
    $("inflationKpis").innerHTML =
      kpi("total / era", fmtToken(rewardTotal) + ' <small>' + c.tokenSymbol + '</small>') +
      kpi("staker rewards", fmtToken(stakerR) + ' <small>' + c.tokenSymbol + '</small>',
        deltaChip(stakerR, prev ? tok(prev.totalStakerReward, c) : null)) +
      kpi("validator incentive", fmtToken(incentR) + ' <small>' + c.tokenSymbol + '</small>');

    // Buffer: cumulative DAP buffer balance + this era's growth.
    var bufBal = tok(last.pots.buffer, c);
    var bufDelta = prev ? (bufBal - tok(prev.pots.buffer, c)) : 0;
    $("bufferKpis").innerHTML =
      kpi("balance — era " + last.era, fmtToken(bufBal) + ' <small>' + c.tokenSymbol + '</small>') +
      kpi("Δ this era", (bufDelta >= 0 ? "+" : "") + fmtToken(bufDelta) + ' <small>' + c.tokenSymbol + '</small>');
  }

  // ---- zoom overlay ----
  var CHART_FNS = {
    election: { fn: drawElection, title: "Election — min backing of elected set vs min-score floor",
      legend: '<span><i style="background:var(--accent)"></i>min backing of elected set</span><span><i style="background:var(--warn)"></i>min-score floor</span>' },
    staking1: { fn: drawStaking1, title: "Nominators / registered validators / unbonding (trend)",
      legend: '<span><i style="background:var(--accent)"></i>nominators</span><span><i style="background:var(--accent-2)"></i>registered validators</span><span><i style="background:var(--warn)"></i>unbonding (own scale)</span>' },
    inflation: { fn: drawInflation, title: "Per-era reward pots — staker rewards / validator incentive",
      legend: '<span><i style="background:var(--accent)"></i>staker rewards</span><span><i style="background:var(--accent-2)"></i>validator incentive</span>' },
    buffer: { fn: drawBuffer, title: "DAP buffer balance per era (cumulative)",
      legend: '<span><i style="background:var(--accent)"></i>prior balance</span><span><i style="background:var(--accent-2)"></i>this era\'s growth (Δ)</span>' }
  };

  function openZoom(card) {
    var meta = CHART_FNS[card];
    if (!meta) return; // staking2 (table) not zoomable
    $("overlayTitle").textContent = meta.title;
    $("overlayLegend").innerHTML = meta.legend;
    $("overlay").classList.add("open");
    meta.fn($("overlayChart"), Math.min(window.innerHeight * 0.62, 460));
  }
  function closeZoom() { $("overlay").classList.remove("open"); hideTip(); }

  // ---- render-all + wiring ----
  function renderCharts() {
    drawElection($("electionChart"));
    drawStaking1($("staking1Chart"));
    drawInflation($("inflationChart"));
    drawBuffer($("bufferChart"));
    renderDist();
  }
  function renderAll() { renderTitle(); renderKpis(); renderCharts(); renderFooter(); }

  function renderTitle() {
    var c = chain();
    var latest = c.eras.length ? c.eras[c.eras.length - 1].era : null;
    $("eraTag").textContent = latest != null ? "era " + latest : "";
  }

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

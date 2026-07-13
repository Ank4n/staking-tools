/* Balances app logic. DATA is injected as a global; `Live` (papi client bundle)
   is the live-chain overlay — the page renders fully from baked data first and
   upgrades in place when live reads resolve. */
(function () {
  "use strict";

  // ---- state ----
  var state = {
    chainIdx: 0,
    conn: "connecting", // connecting | connected | error | closed | offline
    handle: null,       // Live handle
    live: null,         // Live.readAll result
    potEra: null,       // era shown in the era-pots card
    potEraUserSet: false, // user typed an era; don't override with the live default
    potData: null,      // Live.potInfo result for potEra
  };

  // ---- helpers ----
  function $(id) { return document.getElementById(id); }
  function chain() { return DATA[state.chainIdx]; }
  function tok(planckStr, c) { return Number(planckStr) / Math.pow(10, c.tokenDecimals); }
  function usdUnits(s) { return Number(s) / 1e6; } // USDT/USDC are 6-decimals

  function fmtToken(n) {
    var abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return n.toFixed(abs < 10 ? 2 : 0);
  }
  function fmtUsd(n) { return "$" + fmtToken(n); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function shortAddr(a) { return a.slice(0, 6) + "…" + a.slice(-4); }

  // `sub` renders as a faint second line (used for the USD equivalent).
  function kpi(k, v, sub) {
    return '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v + "</div>" +
      (sub ? '<div class="u">' + sub + "</div>" : "") + "</div>";
  }

  function bakedEra(era) {
    var eras = chain().eras;
    for (var i = 0; i < eras.length; i++) if (eras[i].era === era) return eras[i];
    return null;
  }

  // USD line for a DOT amount, when the live DEX quote is available.
  function usdSub(dotAmount) {
    var px = state.live && state.live.dotUsd;
    return px ? "≈ " + fmtUsd(dotAmount * px) : null;
  }

  // ---- canvas plumbing (same toolkit as the era-health app) ----
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

  function xLabels(ctx, fr, labels, centered) {
    ctx.fillStyle = cssVar("--faint");
    ctx.font = '10px ' + cssVar("--mono");
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    var n = labels.length;
    for (var i = 0; i < n; i++) {
      var f = centered ? (i + 0.5) / n : (n === 1 ? 0.5 : i / (n - 1));
      var x = fr.x0 + (fr.x1 - fr.x0) * f;
      ctx.fillText(labels[i], x, fr.y0 + 6);
    }
  }

  function attachHover(canvas) {
    if (canvas._hoverBound) return;
    canvas._hoverBound = true;
    canvas.style.cursor = "crosshair";
    canvas.addEventListener("mousemove", function (ev) {
      var hits = canvas._hits;
      if (!hits || !hits.length) return;
      var rect = canvas.getBoundingClientRect();
      var scale = (canvas._cssW || rect.width) / rect.width;
      var mx = (ev.clientX - rect.left) * scale;
      var my = (ev.clientY - rect.top) * scale;
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
    var x = clientX + 12, y = clientY - 12;
    el.style.left = Math.min(x, window.innerWidth - el.offsetWidth - 8) + "px";
    el.style.top = Math.max(8, y - el.offsetHeight) + "px";
  }
  function hideTip() {
    var el = $("hoverTip");
    if (el) el.style.display = "none";
  }

  // Multi-series trend: each series auto-zoomed to its own range (values are
  // orders of magnitude apart); exact values on hover only.
  function trendLines(p, eras, series) {
    var padL = 12, padR = 12, padT = 14, padB = 26;
    var fr = { x0: padL, x1: p.w - padR, y0: p.h - padB, y1: padT };
    p.ctx.strokeStyle = cssVar("--line"); p.ctx.lineWidth = 1; p.ctx.globalAlpha = 0.5;
    p.ctx.beginPath(); p.ctx.moveTo(fr.x0, fr.y0); p.ctx.lineTo(fr.x1, fr.y0); p.ctx.stroke();
    p.ctx.globalAlpha = 1;
    var hits = [];
    series.forEach(function (s) {
      var arr = s.values;
      var lo = Math.min.apply(null, arr), hi = Math.max.apply(null, arr);
      var span = hi - lo || 1;
      var pad = span * 0.35;
      lo -= pad; hi += pad; span = hi - lo;
      var n = arr.length;
      function pt(i) {
        return [
          fr.x0 + (fr.x1 - fr.x0) * (n === 1 ? 0.5 : i / (n - 1)),
          fr.y0 - (fr.y0 - fr.y1) * ((arr[i] - lo) / span)
        ];
      }
      p.ctx.strokeStyle = s.color; p.ctx.lineWidth = 2; p.ctx.beginPath();
      for (var i = 0; i < n; i++) { var a = pt(i); if (i === 0) p.ctx.moveTo(a[0], a[1]); else p.ctx.lineTo(a[0], a[1]); }
      p.ctx.stroke();
      p.ctx.fillStyle = s.color;
      for (var j = 0; j < n; j++) {
        var b = pt(j);
        p.ctx.beginPath(); p.ctx.arc(b[0], b[1], 2.6, 0, 7); p.ctx.fill();
        hits.push({ x: b[0], y: b[1], color: s.color, label: s.label, era: eras[j], text: s.fmt(arr[j]) });
      }
    });
    return { fr: fr, hits: hits };
  }

  // ---- live wiring ----
  function liveAvailable() { return typeof Live !== "undefined"; }

  function setConn(s) {
    state.conn = s;
    var dot = $("connDot");
    dot.className = "sdot" + (s === "connecting" ? " connecting" : s === "connected" ? " connected" : s === "error" ? " error" : "");
    $("connLabel").textContent = s === "connected" ? "live" : s === "connecting" ? "connecting" : s === "offline" ? "offline" : "snapshot only";
    renderFooter();
  }

  function connectLive(endpoint) {
    if (!liveAvailable()) { setConn("offline"); return; }
    var hadLive = state.live != null || state.potData != null;
    if (state.handle) { try { Live.destroy(state.handle); } catch (e) {} }
    state.handle = null;
    state.live = null;
    state.potData = null;
    setConn("connecting");
    // On RE-connect, drop stale live values and show the baked view; on the
    // initial connect there is nothing stale and init just rendered.
    if (hadLive) renderAll();
    var handle = Live.connect(endpoint, function (s) {
      if (handle !== state.handle) return; // stale connection
      // The provider retries forever; surface the state but keep baked data.
      setConn(s);
    });
    state.handle = handle;
    var c = chain();
    Live.readAll(handle, {
      eras: c.eras.map(function (e) { return e.era; }),
      treasury: c.treasuryAccount,
      assetIds: c.assetIds,
    }).then(function (res) {
      if (handle !== state.handle) return;
      state.live = res;
      renderAll();
      // Live active era may be ahead of the baked one; refresh the default
      // unless the user picked an era themselves.
      loadPotEra(state.potEraUserSet ? state.potEra : defaultPotEra());
    }).catch(function () {
      if (handle !== state.handle) return;
      renderAll(); // keep baked view; footer shows the connection state
    });
  }

  // ---- era-pots card ----
  function defaultPotEra() {
    var act = state.live && state.live.activeEra != null ? state.live.activeEra : chain().activeEra;
    if (act != null) return act - 1; // last completed era
    var eras = chain().eras;
    return eras.length ? eras[eras.length - 1].era : 0;
  }

  function loadPotEra(era) {
    state.potEra = era;
    state.potData = null;
    $("eraInput").value = era;
    // The bulk live read already fetched this era's pots when it's in the
    // baked window — reuse it instead of re-asking the chain. (Budgets come
    // from the baked data in resolvePot.)
    var cached = null;
    if (state.live) {
      state.live.eraPots.forEach(function (ep) { if (ep.era === era) cached = ep; });
    }
    if (cached) {
      state.potData = {
        era: era,
        staker: cached.staker && { account: cached.staker.account, balance: cached.staker.balance, budget: null },
        validator: cached.validator && { account: cached.validator.account, balance: cached.validator.balance, budget: null },
      };
    }
    renderPotsCard();
    if (!cached && state.handle && liveAvailable()) {
      Live.potInfo(state.handle, era).then(function (info) {
        if (info.era !== state.potEra) return;
        state.potData = info;
        renderPotsCard();
      }).catch(function () { /* keep the baked-only rows */ });
    }
  }

  // One resolution of a pot's numbers, shared by the table, the donuts and
  // nothing else: budget prefers the baked (offline-safe) value, remaining
  // needs the live read.
  function resolvePot(kind) {
    var c = chain();
    var baked = bakedEra(state.potEra);
    var info = state.potData && state.potData[kind];
    var budgetStr = baked
      ? (kind === "staker" ? baked.totalStakerReward : baked.validatorIncentiveBudget)
      : (info && info.budget);
    var budget = budgetStr != null ? tok(budgetStr, c) : null;
    var remaining = info ? tok(info.balance, c) : null;
    return {
      account: info ? info.account : null,
      budget: budget,
      remaining: remaining,
      pct: budget && remaining != null ? Math.min(100, remaining / budget * 100) : null,
    };
  }

  function renderPotsCard() { renderPotsTable(); drawEraPots($("eraPotsChart")); }

  function renderPotsTable() {
    var c = chain();
    var live = state.conn === "connected";

    function col(kind) {
      var r = resolvePot(kind);
      var pending = live ? "…" : "—";
      return {
        account: r.account
          ? '<a href="' + c.subscanBase + "/account/" + r.account + '" target="_blank" rel="noopener" title="' + r.account + '">' + shortAddr(r.account) + " ↗</a>"
          : pending,
        budget: r.budget != null ? fmtToken(r.budget) + " " + c.tokenSymbol : pending,
        remaining: r.remaining != null ? fmtToken(r.remaining) + " " + c.tokenSymbol : pending,
      };
    }

    var s = col("staker"), v = col("validator");
    $("potsTable").innerHTML =
      "<tr><th>era " + state.potEra + "</th><th>staker rewards</th><th>validator incentive</th></tr>" +
      "<tr><td>account</td><td>" + s.account + "</td><td>" + v.account + "</td></tr>" +
      "<tr><td>budget</td><td>" + s.budget + "</td><td>" + v.budget + "</td></tr>" +
      "<tr><td>remaining</td><td>" + s.remaining + "</td><td>" + v.remaining + "</td></tr>";
  }

  // Two donut gauges filling the era-pots card: share of each pot's budget
  // still unclaimed. Live-dependent (needs the pot balances).
  function drawEraPots(canvas, cssH) {
    var c = chain(), era = state.potEra;
    var p = prep(canvas, cssH || 210);
    var pots = [
      { label: "staker rewards", color: cssVar("--accent"), v: resolvePot("staker") },
      { label: "validator incentive", color: cssVar("--accent-2"), v: resolvePot("validator") },
    ];

    if (pots[0].v.pct == null && pots[1].v.pct == null) {
      p.ctx.fillStyle = cssVar("--faint");
      p.ctx.font = '12px ' + cssVar("--mono");
      p.ctx.textAlign = "center";
      p.ctx.fillText(state.conn === "connected" ? "no pot data for this era" :
        state.conn === "connecting" ? "connecting…" : "live data unavailable", p.w / 2, p.h / 2);
      canvas._hits = [];
      return;
    }

    var r = Math.min(p.h * 0.30, p.w * 0.16);
    var cy = p.h * 0.44;
    var hits = [];
    for (var k = 0; k < 2; k++) {
      var g = pots[k], val = g.v;
      var cx = p.w * (k === 0 ? 0.28 : 0.72);
      // background ring (the claimed share)
      p.ctx.lineWidth = Math.max(10, r * 0.28);
      p.ctx.strokeStyle = cssVar("--panel-2");
      p.ctx.beginPath(); p.ctx.arc(cx, cy, r, 0, Math.PI * 2); p.ctx.stroke();
      p.ctx.font = '600 ' + Math.round(r * 0.42) + "px " + cssVar("--mono");
      p.ctx.textAlign = "center"; p.ctx.textBaseline = "middle";
      if (val.pct != null) {
        // unclaimed share, clockwise from 12 o'clock
        p.ctx.strokeStyle = g.color;
        p.ctx.beginPath();
        p.ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (val.pct / 100));
        p.ctx.stroke();
        p.ctx.fillStyle = cssVar("--text");
        p.ctx.fillText(val.pct.toFixed(1) + "%", cx, cy - r * 0.12);
        p.ctx.fillStyle = cssVar("--faint");
        p.ctx.font = '10px ' + cssVar("--mono");
        p.ctx.fillText("unclaimed", cx, cy + r * 0.30);
        hits.push({ rect: { x: cx - r - 10, y: cy - r - 10, w: 2 * (r + 10), h: 2 * (r + 10) },
          color: g.color, label: g.label, era: era,
          text: fmtToken(val.remaining) + " of " + fmtToken(val.budget) + " " + c.tokenSymbol + " left" });
      } else {
        p.ctx.fillStyle = cssVar("--faint");
        p.ctx.fillText("—", cx, cy);
      }
      p.ctx.fillStyle = cssVar("--muted");
      p.ctx.font = '11px ' + cssVar("--mono");
      p.ctx.textAlign = "center"; p.ctx.textBaseline = "top";
      p.ctx.fillText(g.label, cx, cy + r + 16);
    }
    canvas._hits = hits; canvas._cssW = p.w; attachHover(canvas);
  }

  // ---- charts ----
  // Per-era % of budget still unclaimed (live pot balance ÷ baked budget),
  // shared by the chart and the KPI row. Pairs live reads with baked eras by
  // era number.
  function unclaimedPts() {
    var c = chain();
    var pts = [];
    if (!state.live) return pts;
    state.live.eraPots.forEach(function (ep) {
      var baked = bakedEra(ep.era);
      if (!baked) return;
      var sBud = tok(baked.totalStakerReward, c), vBud = tok(baked.validatorIncentiveBudget, c);
      pts.push({
        era: ep.era,
        stakerLeft: ep.staker ? tok(ep.staker.balance, c) : null,
        staker: ep.staker && sBud > 0 ? Math.min(100, tok(ep.staker.balance, c) / sBud * 100) : null,
        validator: ep.validator && vBud > 0 ? Math.min(100, tok(ep.validator.balance, c) / vBud * 100) : null,
      });
    });
    return pts;
  }

  // % of each era's budget still sitting in its pots (live), grouped bars.
  function drawUnclaimed(canvas, cssH) {
    var c = chain();
    var p = prep(canvas, cssH || 150);
    var pts = unclaimedPts();
    if (!pts.length) {
      p.ctx.fillStyle = cssVar("--faint");
      p.ctx.font = '12px ' + cssVar("--mono");
      p.ctx.textAlign = "center";
      p.ctx.fillText(state.conn === "connecting" ? "connecting…" : "live data unavailable", p.w / 2, p.h / 2);
      canvas._hits = [];
      return;
    }
    var all = [];
    pts.forEach(function (d) { if (d.staker != null) all.push(d.staker); if (d.validator != null) all.push(d.validator); });
    var hi = Math.max(Math.max.apply(null, all) * 1.15, 5);
    var fr = axesRange(p.ctx, p.w, p.h, 0, hi, function (v) { return v.toFixed(0) + "%"; });
    function yOf(v) { return fr.y0 - (fr.y0 - fr.y1) * (v / hi); }
    var n = pts.length, bw = (fr.x1 - fr.x0) / n;
    var accent = cssVar("--accent"), accent2 = cssVar("--accent-2");
    var hits = [];
    for (var i = 0; i < n; i++) {
      var d = pts[i];
      var cx = fr.x0 + bw * (i + 0.5);
      var bars = [
        { v: d.staker, color: accent, label: "staker rewards", dx: -0.26 },
        { v: d.validator, color: accent2, label: "validator incentive", dx: 0.02 },
      ];
      for (var s = 0; s < bars.length; s++) {
        var b = bars[s];
        if (b.v == null) continue;
        var y = yOf(b.v);
        var rx = cx + bw * b.dx, rw = bw * 0.24;
        p.ctx.fillStyle = b.color;
        p.ctx.fillRect(rx, y, rw, fr.y0 - y);
        hits.push({ rect: { x: rx, y: Math.min(y, fr.y0 - 6), w: rw, h: Math.max(fr.y0 - y, 6) },
          color: b.color, label: b.label + " unclaimed", era: d.era, text: b.v.toFixed(1) + "%" });
      }
    }
    xLabels(p.ctx, fr, pts.map(function (d) { return d.era; }), true);
    canvas._hits = hits; canvas._cssW = p.w; attachHover(canvas);
  }

  // Treasury balances across the eras that captured them (accrues over time).
  function drawTreasury(canvas, cssH) {
    var c = chain();
    var p = prep(canvas, cssH || 150);
    var eras = c.eras.filter(function (e) { return e.treasury; });
    if (eras.length < 2) {
      p.ctx.fillStyle = cssVar("--faint");
      p.ctx.font = '12px ' + cssVar("--mono");
      p.ctx.textAlign = "center";
      p.ctx.fillText("history accrues as snapshots capture the treasury", p.w / 2, p.h / 2);
      canvas._hits = [];
      return;
    }
    var labels = eras.map(function (e) { return e.era; });
    var r = trendLines(p, labels, [
      { values: eras.map(function (e) { return tok(e.treasury.dot, c); }),
        color: cssVar("--accent"), label: "DOT",
        fmt: function (v) { return fmtToken(v) + " " + c.tokenSymbol; } },
      { values: eras.map(function (e) { return usdUnits(e.treasury.usdt); }),
        color: cssVar("--accent-2"), label: "USDT", fmt: fmtUsd },
      { values: eras.map(function (e) { return usdUnits(e.treasury.usdc); }),
        color: cssVar("--warn"), label: "USDC", fmt: fmtUsd },
    ]);
    xLabels(p.ctx, r.fr, labels);
    canvas._hits = r.hits; canvas._cssW = p.w; attachHover(canvas);
  }

  // ---- KPI panels ----
  function renderKpis() {
    var c = chain();
    var eras = c.eras, n = eras.length;
    var last = n ? eras[n - 1] : null;
    var live = state.live;

    // Unclaimed: newest era's live percentages.
    var pts = unclaimedPts();
    var uk = "";
    if (pts.length) {
      var ep = pts[pts.length - 1];
      uk = kpi("staker — era " + ep.era, ep.staker != null ? ep.staker.toFixed(1) + "%" : "—") +
        kpi("incentive — era " + ep.era, ep.validator != null ? ep.validator.toFixed(1) + "%" : "—") +
        kpi("staker unclaimed", ep.stakerLeft != null ? fmtToken(ep.stakerLeft) + ' <small>' + c.tokenSymbol + "</small>" : "—",
          ep.stakerLeft != null ? usdSub(ep.stakerLeft) : null);
      $("unclaimedHint").textContent = "";
    } else {
      $("unclaimedHint").textContent = "needs live connection";
    }
    $("unclaimedKpis").innerHTML = uk;

    // Treasury: live if available, else last boundary capture.
    var t = null, tsrc = "";
    if (live && live.treasuryFree != null && live.treasuryAssets) {
      t = { dot: tok(live.treasuryFree, c), usdt: usdUnits(live.treasuryAssets.usdt), usdc: usdUnits(live.treasuryAssets.usdc) };
      tsrc = "live";
    } else if (last && last.treasury) {
      t = { dot: tok(last.treasury.dot, c), usdt: usdUnits(last.treasury.usdt), usdc: usdUnits(last.treasury.usdc) };
      tsrc = "era " + last.era + " boundary";
    }
    if (t) {
      var px = live && live.dotUsd;
      var total = px ? t.dot * px + t.usdt + t.usdc : null;
      $("treasuryKpis").innerHTML =
        kpi("DOT", fmtToken(t.dot) + ' <small>' + c.tokenSymbol + "</small>", usdSub(t.dot)) +
        kpi("USDT", fmtUsd(t.usdt)) +
        kpi("USDC", fmtUsd(t.usdc)) +
        (total != null ? kpi("total", fmtUsd(total), "at 1 DOT = " + fmtUsd(px)) : "");
      $("treasuryHint").textContent = tsrc;
    } else {
      $("treasuryKpis").innerHTML = "";
      $("treasuryHint").textContent = "no treasury data yet";
    }
  }

  // ---- zoom overlay ----
  var CHART_FNS = {
    unclaimed: { fn: drawUnclaimed, title: "Unclaimed rewards — % of era budget still in the pots (live)",
      legend: '<span><i style="background:var(--accent)"></i>staker rewards</span><span><i style="background:var(--accent-2)"></i>validator incentive</span>' },
    treasury: { fn: drawTreasury, title: "Treasury — per-era boundary reads (own scale per series)",
      legend: '<span><i style="background:var(--accent)"></i>DOT</span><span><i style="background:var(--accent-2)"></i>USDT</span><span><i style="background:var(--warn)"></i>USDC</span>' }
  };

  function openZoom(card) {
    var meta = CHART_FNS[card];
    if (!meta) return;
    $("overlayTitle").textContent = meta.title;
    $("overlayLegend").innerHTML = meta.legend;
    $("overlay").classList.add("open");
    meta.fn($("overlayChart"), Math.min(window.innerHeight * 0.62, 460));
  }
  function closeZoom() { $("overlay").classList.remove("open"); hideTip(); }

  // ---- render-all + wiring ----
  function renderCharts() {
    drawUnclaimed($("unclaimedChart"));
    drawTreasury($("treasuryChart"));
    drawEraPots($("eraPotsChart"));
  }
  function renderAll() { renderTitle(); renderKpis(); renderCharts(); renderPotsTable(); renderFooter(); }
  // Coalesce resize bursts into one redraw per frame.
  var resizePending = false;
  function onResize() {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(function () { resizePending = false; renderCharts(); });
  }

  function renderTitle() {
    var act = state.live && state.live.activeEra != null ? state.live.activeEra : chain().activeEra;
    $("eraTag").textContent = act != null ? "era " + act : "";
  }

  function renderFooter() {
    var c = chain();
    var when = c.updatedAtMs ? new Date(Number(c.updatedAtMs)).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";
    var range = c.eras.length ? c.eras[0].era + "–" + c.eras[c.eras.length - 1].era : "—";
    var px = state.live && state.live.dotUsd;
    $("basis").innerHTML = "Polkadot · eras <code>" + range + "</code> · snapshot updated <code>" + when +
      "</code> · live <code>" + state.conn + "</code>" +
      (px ? " · 1 DOT = <code>" + fmtUsd(px) + "</code> (AssetConversion)" : "");
  }

  function init() {
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
      renderCharts();
    });

    // era picker
    function goEra() {
      var v = parseInt($("eraInput").value, 10);
      if (!isNaN(v) && v >= 0) { state.potEraUserSet = true; loadPotEra(v); }
    }
    function stepEra(d) {
      var next = (state.potEra || 0) + d;
      if (next < 0) return;
      state.potEraUserSet = true;
      loadPotEra(next);
    }
    $("eraPrev").addEventListener("click", function () { stepEra(-1); });
    $("eraNext").addEventListener("click", function () { stepEra(1); });
    $("eraInput").addEventListener("keydown", function (ev) { if (ev.key === "Enter") goEra(); });

    // endpoint: Enter reconnects
    var ep = $("endpoint");
    ep.value = chain().defaultEndpoint;
    ep.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ep.blur(); connectLive(ep.value.trim()); }
    });

    // zoom
    Array.prototype.forEach.call(document.querySelectorAll(".card.zoomable"), function (card) {
      card.addEventListener("click", function (ev) {
        if (ev.target.closest("a, input, button")) return;
        openZoom(card.getAttribute("data-card"));
      });
    });
    $("overlayClose").addEventListener("click", closeZoom);
    $("overlay").addEventListener("click", function (ev) { if (ev.target === $("overlay")) closeZoom(); });
    document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") closeZoom(); });

    window.addEventListener("resize", onResize);

    state.potEra = defaultPotEra();
    renderAll();
    connectLive(chain().defaultEndpoint);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

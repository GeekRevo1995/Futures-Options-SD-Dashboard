/* ═══════════════════════════════════════════════════════════════
   DEEP SETUP ENGINE v4 — Scenario Playbook (Arabic, Darija)
   Output: GEX context + conditional scenario chain
   S1 (primary) → S2 (only if S1 invalidated) → S3 (if S2 hits TP),
   each with exact entry, SL (risk pts), TP1/TP2 (+R), confirmation,
   and invalidation ("مات إلا").
   ─────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  var ASSET_LABELS = { GC: 'GOLD', ES: 'S&P 500', NQ: 'NASDAQ' };

  function fmt(n, d) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: d == null ? 2 : d });
  }
  function fmtC(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  // ══ Analysis (same data plumbing as v3) ══════════════════════
  function analyze(asset, data) {
    var out = {
      asset: asset, label: ASSET_LABELS[asset] || asset,
      price: null, iv: null, sd1: null, maxPain: null,
      gammaAtSpot: null, gammaFlipUp: null, gammaFlipDown: null,
      maxGexStrike: null, maxGexSign: null,
      walls: { res: null, support: null },
      ratioOI: null, cone1: { p10: null, p90: null, pct: null },
      ml: { regime: null, pBull: null, pBear: null, pRange: null },
      skew: { regime: null },
      levels: {},
      alerts: [], source: data && data.meta ? (data.meta.source || '') : ''
    };
    if (!data) return out;

    var b = data.bias || {};
    out.price = b.price != null ? +b.price : null;
    var ivRaw = b.iv;
    if (ivRaw != null) {
      out.iv = String(ivRaw).indexOf('%') >= 0 ? String(ivRaw) : (Number(ivRaw) * 100).toFixed(1) + '%';
    }
    var sd = data.sd_bands || {};
    out.sd1 = sd.sd1 != null ? +sd.sd1 : null;
    out.levels = sd.levels || {};

    var mp = data.max_pain || {};
    out.maxPain = mp.price != null ? +mp.price : null;

    var scen = (data.scenarios || {}).scenarios || [];
    var base = null;
    for (var i = 0; i < scen.length; i++) {
      if (Math.abs(+(scen[i].shift_pct || 0)) < 1e-9) base = scen[i];
    }
    if (base) {
      out.gammaAtSpot = String(base.gex_regime).split('(')[0].trim() || null;
      var stable = out.gammaAtSpot && out.gammaAtSpot.indexOf('STABLE') >= 0;
      for (var j = 0; j < scen.length; j++) {
        var pct = +(scen[j].shift_pct || 0);
        var vol = String(scen[j].gex_regime).indexOf('VOLATILE') >= 0;
        if (stable) {
          if (pct > 0 && vol && out.gammaFlipUp == null) out.gammaFlipUp = +scen[j].hypo_price;
          if (pct < 0 && vol && out.gammaFlipDown == null) out.gammaFlipDown = +scen[j].hypo_price;
        }
      }
    }

    var gp = data.gex_profile || {};
    var gSt = gp.strikes || [], gVal = gp.gex || [];
    var bestAbs = 0;
    for (var k = 0; k < gSt.length && k < gVal.length; k++) {
      if (Math.abs(gVal[k]) > Math.abs(bestAbs)) { bestAbs = gVal[k]; out.maxGexStrike = +gSt[k]; }
    }
    out.maxGexSign = bestAbs > 0 ? '+' : bestAbs < 0 ? '-' : null;

    var res = data.resistances || [], sup = data.supports || [];
    var sumCall = 0, sumPut = 0;
    for (var a0 = 0; a0 < res.length; a0++) { sumCall += +res[a0].oi || 0; }
    for (var a1 = 0; a1 < sup.length; a1++) { sumPut += +sup[a1].oi || 0; }
    out.ratioOI = sumPut > 0 ? sumCall / sumPut : null;
    if (out.price != null) {
      var rUp = res.filter(function (x) { return +x.strike > out.price * 1.001; });
      var sDw = sup.filter(function (x) { return +x.strike < out.price * 0.999; });
      var byOi = function (a, b) { return +b.oi - +a.oi; };
      if (rUp.length) out.walls.res = rUp.slice().sort(byOi)[0];
      if (sDw.length) out.walls.support = sDw.slice().sort(byOi)[0];
    }

    var mc = data.monte_carlo || {}, cones = mc.cones || [];
    for (var c = 0; c < cones.length; c++) {
      if (+cones[c].day === 1) {
        out.cone1.p10 = cones[c].p10 != null ? +cones[c].p10 : null;
        out.cone1.p90 = cones[c].p90 != null ? +cones[c].p90 : null;
        if (out.price && out.cone1.p10 != null && out.cone1.p90 != null) {
          out.cone1.pct = Math.max((out.cone1.p90 - out.price) / out.price, (out.price - out.cone1.p10) / out.price) * 100;
        }
      }
    }

    var ml = data.ml_regime || {};
    out.ml.regime = ml.regime || null;
    out.ml.pBull = ml.prob_bull != null ? Math.round(+ml.prob_bull * 100) : null;
    out.ml.pBear = ml.prob_bear != null ? Math.round(+ml.prob_bear * 100) : null;
    out.ml.pRange = ml.prob_range != null ? Math.round(+ml.prob_range * 100) : null;

    out.skew.regime = ((data.skew_dynamics || {}).skew_regime || '').split('(')[0].trim() || null;

    out.flow = { regime: null };
    var fdec = data.flow_decomposition || {};
    out.flow.regime = fdec.dominant_regime || null;

    out.barrier = { callStrike: null, putStrike: null, touchCallPct: null, touchPutPct: null };
    var bo = (data.monte_carlo || {}).barrier_odds || {};
    out.barrier.callStrike = bo.call_wall_strike != null ? +bo.call_wall_strike : null;
    out.barrier.putStrike = bo.put_wall_strike != null ? +bo.put_wall_strike : null;
    out.barrier.touchCallPct = bo.prob_touch_call_wall_pct != null ? +bo.prob_touch_call_wall_pct : null;
    out.barrier.touchPutPct = bo.prob_touch_put_wall_pct != null ? +bo.prob_touch_put_wall_pct : null;

    out.alerts = (data.alerts || []).slice(0, 4).map(function (a) {
      return { title: a.title || a.category, detail: a.detail || '' };
    });

    out.setups = buildPlaybook(out);
    return out;
  }

  // ══ Level map ════════════════════════════════════════════════
  function namedLevels(o) {
    var p = o.price, sd = o.sd1;
    var N = { gammaFlipUp: 'Gamma Flip', gammaFlipDown: 'Gamma Flip' };
    var above = [], below = [], seen = {};
    function add(list, price, name) {
      if (price == null || isNaN(price)) return;
      var key = String(Math.round(price / 10));
      if (seen[key]) return;
      seen[key] = 1;
      list.push({ price: price, name: name });
    }
    if (o.gammaFlipUp != null) add(above, o.gammaFlipUp, 'Gamma Flip');
    if (o.walls.res && o.walls.res.strike != null) add(above, +o.walls.res.strike, 'Call Wall');
    if (o.maxGexStrike != null && o.maxGexStrike > p) add(above, o.maxGexStrike, 'GEX 1');
    if (o.maxPain != null && o.maxPain > p) add(above, o.maxPain, 'MaxPain');
    if (o.levels['+1SD'] != null) add(above, +o.levels['+1SD'], '±1SD');
    add(above, p + 1.4 * sd, 'Vol Trigger');
    if (o.gammaFlipDown != null) add(below, o.gammaFlipDown, 'Gamma Flip');
    if (o.walls.support && o.walls.support.strike != null) add(below, +o.walls.support.strike, 'Put Wall');
    if (o.maxGexStrike != null && o.maxGexStrike < p) add(below, o.maxGexStrike, 'GEX 1');
    if (o.maxPain != null && o.maxPain < p) add(below, o.maxPain, 'MaxPain');
    if (o.levels['-1SD'] != null) add(below, +o.levels['-1SD'], '±1SD');
    add(below, p - 1.4 * sd, 'Vol Trigger');
    above.sort(function (a, b) { return a.price - b.price; });
    below.sort(function (a, b) { return b.price - a.price; });
    return { above: above.filter(function (x) { return x.price > p; }), below: below.filter(function (x) { return x.price < p; }) };
  }

  // ══ Scenario chain builder ═══════════════════════════════════
  function buildPlaybook(o) {
    if (!o.price || !o.sd1) return [];
    var p = o.price, sd = o.sd1;
    var lv = namedLevels(o);
    var above = lv.above, below = lv.below;
    if (!above.length && !below.length) return [];
    var pine = { price: null, risk: null }; // max pain & pin
    if (o.maxPain != null) pine.price = o.maxPain;

    // pick best anchor between nearest-above (SHORT) and nearest-below (LONG)
    var anchors = [];
    if (above.length) {
      anchors.push(buildAnchor(o, above[0], 'SHORT', below, lv));
    }
    if (below.length) {
      anchors.push(buildAnchor(o, below[0], 'LONG', above, lv));
    }
    anchors = anchors.filter(function (a) { return a; });
    if (!anchors.length) return [];
    anchors.sort(function (a, b) { return b.s1.score - a.s1.score; });
    var best = anchors[0];

    var chain = [best.s1];
    if (best.s2) chain.push(best.s2);
    if (best.s3) chain.push(best.s3);
    if (best.s4) chain.push(best.s4);
    chain[0].confidence = best.s1.prob >= 50 ? 'HIGH' : best.s1.prob >= 38 ? 'MEDIUM' : 'LOW';
    if (chain.length > 1) chain[1].confidence = 'MEDIUM';
    if (chain.length > 2) chain[2].confidence = chain[2].rr >= 1 ? 'MEDIUM' : 'LOW';
    if (chain.length > 3 && chain[3]) chain[3].confidence = 'LOW';
    return chain;
  }

  // Joint probability: P(win) = P(touch level) x P(reach target from level)
  function touchProb(o, price) {
    var cl = o.sd1 * 0.05;
    if (o.barrier && o.barrier.callStrike != null && Math.abs(price - o.barrier.callStrike) < cl && o.barrier.touchCallPct != null) return o.barrier.touchCallPct;
    if (o.barrier && o.barrier.putStrike != null && Math.abs(price - o.barrier.putStrike) < cl && o.barrier.touchPutPct != null) return o.barrier.touchPutPct;
    var ds = Math.abs(price - o.price) / o.sd1;
    return Math.max(30, Math.min(92, Math.round(100 - ds * 16)));
  }
  function contProb(o, from, to) {
    var reach;
    if (o.cone1.p10 != null && o.cone1.p90 != null) reach = to > o.price ? (o.cone1.p90 - o.price) : (o.price - o.cone1.p10);
    else reach = 1.8 * o.sd1;
    var ratio = Math.abs(to - from) / Math.max(reach, 0.01);
    return Math.max(20, Math.min(85, Math.round(100 - ratio * 30)));
  }
  function jointProb(o, level, target) {
    return Math.round((touchProb(o, level) / 100) * (contProb(o, level, target) / 100) * 100);
  }

  function pickTarget(o, oppLevels, entry, isShort) {
    if (o.maxPain != null && (isShort ? o.maxPain < entry : o.maxPain > entry)) {
      return { price: o.maxPain, name: 'MaxPain' };
    }
    // 2) decisive structural wall
    var dec = { 'Put Wall': 1, 'Call Wall': 1, 'Gamma Flip': 1 };
    for (var i = 0; i < oppLevels.length; i++) {
      var L = oppLevels[i];
      if (dec[L.name] && (isShort ? L.price < entry : L.price > entry)) return L;
    }
    // 3) nearest level in direction
    for (var j = 0; j < oppLevels.length; j++) {
      if (isShort ? oppLevels[j].price < entry : oppLevels[j].price > entry) return oppLevels[j];
    }
    return null;
  }

  function buildAnchor(o, anchor, dir, oppLevels, lv) {
    var p = o.price, sd = o.sd1;
    var isShort = dir === 'SHORT';
    var P = anchor.price;
    var reach = Math.abs(P - p) / sd;
    if (o.gammaAtSpot && o.gammaAtSpot.indexOf('STABLE') >= 0 && anchor.name === 'Vol Trigger') return null;

    var tgt = pickTarget(o, oppLevels, P, isShort);
    if (!tgt) return null;
    var target = tgt.price, targetName = tgt.name;

    // magnet alignment: +1 magnet pulls UP (maxPain above), -1 pulls DOWN
    var magnetDir = o.maxPain != null ? (o.maxPain > p ? 1 : o.maxPain < p ? -1 : 0) : 0;
    var atPin = o.maxPain != null && Math.abs(P - o.maxPain) < 0.3 * sd;
    var magnetAgree = isShort ? (magnetDir < 0 || atPin) : (magnetDir > 0 || atPin);
    var magnetContra = !magnetAgree;

    // noise-resilient stop: prefer 0.20σ, fall back to 0.12σ only if R < 2 would otherwise
    var reward = Math.abs(target - P);
    var w = 0.20 * sd;
    var rr2 = reward / Math.max(w, 0.01);
    var usedWideAir = true;
    if (rr2 < 2 && reward > 0) {
      w = 0.12 * sd; rr2 = reward / Math.max(w, 0.01); usedWideAir = false;
    }
    var entry = P;
    var stop = P + (isShort ? w : -w);
    if (isShort && o.gammaFlipUp != null && o.gammaFlipUp < P + w) { w = Math.abs(o.gammaFlipUp - P) + 0.08 * sd; stop = P + w; }
    if (!isShort && o.gammaFlipDown != null && o.gammaFlipDown > P - w) { w = Math.abs(P - o.gammaFlipDown) + 0.08 * sd; stop = P - w; }
    var risk = Math.abs(stop - entry);
    var rr = risk > 0 ? reward / risk : 0;

    // honest joint-win probability: touch x continue-to-target
    var prob = jointProb(o, P, target);
    var stable = !!(o.gammaAtSpot && o.gammaAtSpot.indexOf('STABLE') >= 0);
    if (magnetAgree) prob += 3; else if (magnetContra && !atPin) prob -= 4;
    if (o.ml.pBear != null && o.ml.pBull != null) {
      var mlAgree = isShort ? (o.ml.pBear > o.ml.pBull + 10) : (o.ml.pBull > o.ml.pBear + 10);
      if (mlAgree) prob += 3; else prob -= 3;
    }
    if (o.flow.regime) {
      var fAgree = (o.flow.regime.indexOf('ACCUMULATION') >= 0 && !isShort) || (o.flow.regime.indexOf('LIQUIDATION') >= 0 && isShort);
      if (fAgree) prob += 2; else prob -= 2;
    }
    if (o.maxGexStrike != null && Math.abs(o.maxGexStrike - P) < sd) prob += 3;
    prob = Math.max(18, Math.min(78, prob));
    if (magnetContra && !atPin && !(rr >= 2 && prob >= 30)) return null;

    var ok = isShort ? (target < entry && entry < stop) : (target > entry && entry > stop);
    if (!(ok && rr >= 1.3 && prob >= 30)) return null;

    var tp1 = findIntermediate(oppLevels, entry, target);
    var extraNote = atPin ? ' — لمسة ' + anchor.name + ' كتقابل يعني انبهار عند البين' : '';
    var s1 = scenario(o, dir, 'S1 · الأقرب', anchor, entry, stop, target, targetName, tp1,
      prob, rr,
      (isShort ? 'مقاومة قدام (مازال ما تلامستش) — ' : 'دعم قدام (مازال ما تلامستش) — ') + anchor.name + extraNote,
      (isShort
        ? (atPin ? 'رفض عند البين (MaxPain) — الأقرب احتمالاً، أول لمسة كتترفض'
                 : 'الأقرب احتمالاً (أول لمسة عادة كتترفض) — ' + anchor.name + ' أقوى مقاومة فوق السعر')
        : (atPin ? 'ارتداد عند البين (MaxPain) — الأقرب احتمالاً، أول لمسة كتترفض'
                 : 'الأقرب احتمالاً (أول لمسة عادة كتترفض) — ' + anchor.name + ' أقوى دعم تحت السعر')),
      entry, 'مات إلا: إغلاق 1m ' + (isShort ? 'فوق' : 'تحت') + ' ' + fmt(stop, 2) + ' بحجم قوي — السيناريو مات (تفعيل S2)',
      [P - 0.06 * sd, P + 0.06 * sd]);

    // S2 — acceptance (only if S1 invalidated): opposite direction from S1.stop
    var s2 = null;
    var side2 = (isShort ? lv.above : lv.below).filter(function (x) { return isShort ? x.price > stop : x.price < stop; });
    var next = null, nextName = null;
    for (var j = 0; j < side2.length; j++) {
      var L2 = side2[j];
      if (isShort ? L2.price > stop : L2.price < stop) { next = L2.price; nextName = L2.name; break; }
    }
    if (next == null && side2.length) { next = side2[side2.length - 1].price; nextName = 'المستوى التالي'; }
    if (next != null && nextName != null) {
      var e2 = stop, s2stop = entry;
      var r2 = Math.abs(next - e2), risk2 = Math.abs(e2 - s2stop);
      var rr2 = risk2 > 0 ? r2 / risk2 : 0;
      var prob2 = 40;
      s2 = scenario(o, isShort ? 'LONG' : 'SHORT', 'S2 · يفعل إلا مات S1 (اختراق وقبول)',
        { name: nextName, price: next }, e2, s2stop, next, nextName, null,
        prob2, rr2,
        (isShort ? 'LONG Continuation عبر ' : 'SHORT continuation عبر ') + nextName,
        isShort ? 'بديل — يفعل فقط إلا فشل الرفض فS1'
                : 'بديل — يفعل فقط إلا فشل الرفض فS1',
        e2, 'مات إلا: رجوع سريع داخل المستوى (إغلاق 1m ' + (isShort ? 'تحت' : 'فوق') + ' ' + fmt(entry, 2) + ') بلا acceptance',
        [e2 - 0.06 * sd, e2 + 0.06 * sd]);
    }

    // S3 — reversal at S2 target back toward S1 entry
    var s3 = null;
    if (s2) {
      var e3 = next;
      var s3dir = isShort;
      var s3stop2 = next + (s3dir ? w : -w);
      var tgt3 = entry;
      var rr3 = Math.abs(tgt3 - e3) / Math.max(0.01, Math.abs(e3 - s3stop2));
      s3 = scenario(o, isShort ? 'SHORT' : 'LONG', 'S3 · يفعل إلا وصل S2 لهدفو', { name: nextName, price: next },
        e3, s3stop2, tgt3, anchor.name, null,
        Math.max(30, Math.min(45, Math.round(prob * 0.7))), rr3,
        'Reversal عند ' + nextName + ' — رد الجميل نحو ' + anchor.name,
        'بعيد المدى — تابع لنجاح S2 بالكامل',
        e3, 'مات إلا: قبول (إغلاق 1m) ' + (s3dir ? 'فوق' : 'تحت') + ' ' + fmt(s3stop2, 2) + ' عوض الرفض',
        [e3 - 0.06 * sd, e3 + 0.06 * sd]);
    }

    return { s1: s1, s2: s2, s3: s3, s4: null };
  }

  function findIntermediate(oppLevels, entry, target) {
    for (var i = 0; i < oppLevels.length; i++) {
      var pr = oppLevels[i].price;
      if (entry < target && pr > entry && pr < target) return { price: pr, name: oppLevels[i].name };
      if (entry > target && pr < entry && pr > target) return { price: pr, name: oppLevels[i].name };
    }
    return null;
  }

  function scenario(o, dir, label, level, entry, stop, target, targetName, tp1, prob, rr,
                    title, note, trigger, invalidation, wide) {
    var risk = Math.abs(stop - entry);
    var reward = Math.abs(target - entry);
    var R = risk > 0 ? reward / risk : 0;
    var weak = R < 1;
    var s = {
      label: label,
      dir: dir === 'SHORT' ? 'SHORT' : 'LONG',
      levelName: level.name, levelPrice: level.price,
      title: title, note: note,
      entry: entry, stop: stop, target: target, targetName: targetName,
      tp1: tp1, risk: risk, reward: reward, rr: rr, R: R, weak: weak, prob: prob,
      trigger: trigger, invalidation: invalidation,
      wide: wide || [entry, entry],
      score: Math.round(30 + prob * 0.7 + Math.min(R, 6) * 2),
      id: 'x'
    };
    return s;
  }

  // ══ DOM wrapper ══════════════════════════════════════════════
  function injectStyles() {
    if (typeof document === 'undefined' || document.getElementById('deep-setup-styles')) return;
    var st = document.createElement('style');
    st.id = 'deep-setup-styles';
    st.textContent = [
      '#deep-setup-modal{position:fixed;inset:0;background:rgba(5,6,10,.9);backdrop-filter:blur(6px);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:22px 10px;font-family:Consolas,"Segoe UI",monospace}',
      '#deep-setup-modal .ds-panel{position:relative;background:#111317;border:1px solid #23262e;border-radius:14px;max-width:1000px;width:100%;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.6)}',
      '#deep-setup-modal .ds-close{position:absolute;top:10px;right:10px;width:30px;height:30px;border-radius:8px;border:1px solid #333;background:#171a21;color:#9A9AA5;font-size:16px;cursor:pointer;z-index:5}',
      '#deep-setup-modal .ds-close:hover{background:#2a2f3a;color:#fff;border-color:#4D9EFF}',
      '.ds-title{font-size:15px;font-weight:700;color:#ECECEE;margin:0 0 2px}',
      '.ds-sub{color:#6d737f;font-size:11px;margin:0 0 14px}',
      '.ds-rtl{direction:rtl;text-align:right}',
      '.ds-sec{font-size:11px;font-weight:800;color:#4D9EFF;letter-spacing:1px;margin:14px 0 8px;text-transform:uppercase}',
      '.ds-card{background:#15181e;border:1px solid #242831;border-radius:12px;padding:13px 15px;margin-bottom:10px}',
      '.ds-line{font-size:12px;color:#B8BDC7;line-height:1.7}',
      '.ds-line b{color:#ECECEE}',
      '.ds-star{color:#FEB019}',
      '.ds-up{color:#FF4560}.ds-dn{color:#00E396}',
      '.ds-muted{color:#6d737f;font-size:10px}',
      '.ds-scen{border:1px solid #242831;border-radius:12px;background:#15181e;padding:13px 15px;margin-bottom:10px}',
      '.ds-scen .h{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ds-badge{font-size:10px;font-weight:800;padding:3px 9px;border-radius:6px;white-space:nowrap}',
      '.ds-badge.high{background:rgba(0,227,150,.14);color:#00E396;border:1px solid rgba(0,227,150,.4)}',
      '.ds-badge.medium{background:rgba(254,176,25,.12);color:#FEB019;border:1px solid rgba(254,176,25,.35)}',
      '.ds-badge.low{background:rgba(99,102,113,.14);color:#7c828e;border:1px solid #333}',
      '.ds-scen .tt{font-size:13px;font-weight:800;color:#fff;margin-top:6px}',
      '.ds-scen .tt.short{color:#FF4560}.ds-scen .tt.long{color:#00E396}',
      '.ds-scen .nt{font-size:11px;color:#7c828e;margin:3px 0 8px}',
      '.ds-boxes{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px;direction:ltr}',
      '.ds-box{background:#101318;border:1px solid #262b36;border-radius:9px;padding:6px 9px}',
      '.ds-box .lbl{font-size:8.5px;color:#6d737f;letter-spacing:.2px}',
      '.ds-box .val{font-size:12px;font-weight:700;color:#ECECEE;margin-top:2px}',
      '.ds-r{color:#FEB019}.ds-big{color:#00E396}.ds-risk{color:#FF4560}',
      '.ds-weak{color:#FEB019;font-size:11px;text-align:right;direction:rtl;margin-top:6px}',
      '.ds-list{list-style:none;margin:8px 0 0;padding:0}',
      '.ds-list li{font-size:11.5px;color:#B8BDC7;line-height:1.7;direction:rtl;text-align:right;padding-right:12px;position:relative}',
      '.ds-list li::before{content:"✓";position:absolute;right:0;color:#4D9EFF}',
      '.ds-die{font-size:12px;color:#FF4560;direction:rtl;text-align:right;margin-top:8px;padding-top:6px;border-top:1px dashed #31291b}',
      '.ds-foot{font-size:10px;color:#5b616d;margin-top:12px;line-height:1.6;border-top:1px solid #1d212a;padding-top:8px;direction:rtl;text-align:right}',
      '.ds-nosetup{background:#15181e;border:1px dashed #3a3130;border-radius:12px;padding:13px 15px;margin-bottom:10px}',
      '.ds-nosetup .h{font-weight:800;color:#FF4560;font-size:13px;margin-bottom:4px;direction:rtl;text-align:right}',
      '.ds-nosetup .why{font-size:11px;color:#7c828e;line-height:1.6;direction:rtl;text-align:right}',
      '.ds-loading{color:#00E396;font-size:12px;text-align:center;padding:30px 0}',
      '.ds-err{color:#FF4560;font-size:12px;text-align:center;padding:24px 0}',
      '.setup-btn:hover{border-color:#4D9EFF;box-shadow:0 0 10px rgba(77,158,255,.35)}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function openModal(assetLabel) {
    var title = assetLabel
      ? 'DEEP SETUP — ' + assetLabel + ' (وردّة سيناريوهات للمؤشر المفتوح)'
      : 'DEEP SETUP — full market';
    var body = '<div class="ds-title">' + title + '</div><div class="ds-loading">…</div>';
    if (!document.getElementById('deep-setup-modal')) {
      var m = document.createElement('div');
      m.id = 'deep-setup-modal';
      m.innerHTML = '<div class="ds-panel"><button class="ds-close" title="Close">✕</button><div id="ds-body">' + body + '</div></div>';
      m.addEventListener('click', function (ev) { if (ev.target === m) closeModal(); });
      m.querySelector('.ds-close').addEventListener('click', closeModal);
      document.body.appendChild(m);
    } else {
      document.getElementById('ds-body').innerHTML = body;
    }
    document.getElementById('deep-setup-modal').style.display = 'flex';
  }

  function closeModal() {
    var m = document.getElementById('deep-setup-modal');
    if (m) m.style.display = 'none';
  }

  async function getData(asset) {
    var urls = ['data/live/' + asset + '_data.json?_=' + Date.now()];
    var ts = '';
    if (typeof state !== 'undefined' && state && state.manifest && state.manifest[state.currentIndex]) {
      ts = state.manifest[state.currentIndex];
      urls.push('data/' + ts + '/' + asset + '_data.json?_=' + Date.now());
    }
    for (var i = 0; i < urls.length; i++) {
      try {
        var r = await fetch(urls[i]);
        if (r.ok) {
          var raw = cleanJSON(await r.text());
          var meta = { source: i === 0 ? 'LIVE FEED' : 'SNAPSHOT ' + ts };
          try { meta.sync = raw.bias.live_sync_time || ts; } catch (e) { meta.sync = ts; }
          return { raw: raw, meta: meta };
        }
      } catch (e) { /* next */ }
    }
    throw new Error('No data for ' + asset);
  }

  function cleanJSON(text) {
    return JSON.parse(text.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")|(\bNaN\b)/g, function (m, p1) { return p1 ? m : 'null'; }));
  }

  // ══ Arabic playbook render ════════════════════════════════════
  function render(results) {
    var html = [];
    results.forEach(function (o) { html.push(contextBlock(o), chainBlock(o)); });
    html.push('<div class="ds-foot">⚠️ RISK: هذه سيناريوهات إحصائية شرطية مبنية على نماذج الداشبورد (أقماع مونت كارلو، سيناريوهات الغاما، الريجيم الآلي، جدران OI). الاحتمالية ≠ ضمانة. استعمل STOP دائمًا، احترم مستويات الإبطال، وقيّم المعنى للحالة الأسوأ. ماشي نصيحة استثمارية.</div>');
    document.getElementById('ds-body').innerHTML = html.join('');
  }

  function contextBlock(o) {
    var L = o.levels || {};
    var rtl = '<div class="ds-rtl">';

    var gammaTxt = o.gammaAtSpot || '—';
    var gammaDesc = '';
    if (o.gammaAtSpot && o.gammaAtSpot.indexOf('STABLE') >= 0) {
      gammaDesc = 'موجب (Positive Gamma). الدايلرز كيلعبو دور استقرار (بيع مع الطلوع، شرا مع النزول) → حركة أهدأ، احترام أكبر للمستويات، رفض أسرع عند الحدود.';
    } else if (o.gammaAtSpot && o.gammaAtSpot.indexOf('VOLATILE') >= 0) {
      gammaDesc = 'سلبي (Negative Gamma). الدايلرز كيتبعو الحركة → تقلبات أكبر، توسعات سريعة لما يكسر السعر مستوى، رفض ضعيف.';
    } else {
      gammaDesc = 'كيتم حساب ريجيم الغاما من سيناريوهات الدراتس (0DTE).';
    }

    var ratioTxt = '—';
    if (o.ratioOI != null && o.ratioOI > 0) {
      ratioTxt = o.ratioOI.toFixed(3) + ' — ' + (o.ratioOI > 1.05 ? 'تموقع صعودي واضح (كولز أكثر)' : o.ratioOI < 0.95 ? 'تموقع هبوطي واضح (بوتز أكثر)' : 'محايد');
    }

    var rangeTxt = '';
    if (o.cone1.p10 != null && o.cone1.p90 != null) {
      rangeTxt = 'النطاق المتوقع لليوم (±' + (o.cone1.pct ? o.cone1.pct.toFixed(1) : '—') + '%): بين <b>' + fmt(o.cone1.p10, 2) + '</b> و <b>' + fmt(o.cone1.p90, 2) + '</b>';
    } else {
      rangeTxt = 'النطاق المتوقع لليوم: غير متوفر';
    }

    var lv = namedLevels(o);
    var upLines = lv.above.slice(0, 5).map(function (x) {
      var d = Math.round(Math.abs(x.price - o.price));
      var star = (x.name === 'Gamma Flip' || x.name === 'Call Wall' || x.name === 'Vol Trigger') ? ' ★' : '';
      return '<li>سبق ' + x.name + '<span class="ds-star">' + star + '</span> عند <b>' + fmt(x.price, 2) + '</b> (' + d + ' نقطة)</li>';
    }).join('');
    var dwLines = lv.below.slice(0, 5).map(function (x) {
      var d = Math.round(Math.abs(o.price - x.price));
      var star = (x.name === 'Gamma Flip' || x.name === 'Put Wall' || x.name === 'Vol Trigger') ? ' ★' : '';
      return '<li>سبق ' + x.name + '<span class="ds-star">' + star + '</span> عند <b>' + fmt(x.price, 2) + '</b> (' + d + ' نقطة)</li>';
    }).join('');

    var decisiveUp = (lv.above.filter(function (x) { return x.name === 'Gamma Flip' || x.name === 'Call Wall'; })[0] || lv.above[0]);
    var decisiveDn = (lv.below.filter(function (x) { return x.name === 'Gamma Flip' || x.name === 'Put Wall'; })[0] || lv.below[0]);

    var gapTxt = '';
    var nearestAbove = lv.above[0], nearestBelow = lv.below[0];
    var gapDist = Math.min(
      nearestAbove ? Math.abs(nearestAbove.price - o.price) / o.sd1 : 99,
      nearestBelow ? Math.abs(o.price - nearestBelow.price) / o.sd1 : 99);
    if (gapDist >= 99) gapTxt = 'ماكاين حتى مستوى هيكلي قريب من السعر.';
    else if (gapDist < 0.5) gapTxt = 'السعر قريب من مستوى حاسم — الفجوة ضيّقة، راقب رد الفعل الأول فتلامس قبل أي قرار.';
    else if (gapDist < 1.5) gapTxt = 'الفجوة بين السعر والمستوى الأقرب معقولة — راقب رد الفعل الأول عند الاقتراب قبل أي قرار.';
    else gapTxt = 'السعر بعيد من المستويات (فجوة كبيرة) — ما صعّبش تلاقي أولف أول فلمسة.';

    var flips = [];
    if (o.gammaFlipUp != null) flips.push('فوق ' + fmt(o.gammaFlipUp, 2));
    if (o.gammaFlipDown != null) flips.push('تحت ' + fmt(o.gammaFlipDown, 2));

    return RTLCard(
      '<div class="ds-sec">GEX سياق عام</div>' +
      '<div class="ds-line"><b>نظام الغاما اليوم:</b> ' + gammaTxt + (flips.length ? ' <span class="ds-muted">(انعكاس ولت: ' + flips.join(' / ') + ')</span>' : '') + '<br>' + gammaDesc + '</div>' +
      '<div class="ds-line"><b>Put/Call Ratio:</b> ' + ratioTxt + '</div>' +
      '<div class="ds-line">' + rangeTxt + ' — قارن مع جدران Call/Put.</div>' +
      '<div class="ds-sec">المستويات من السعر</div>' +
      '<div class="ds-line"><b>فوق السعر:</b></div><ul class="ds-list ds-up">' + upLines + '</ul>' +
      '<div class="ds-line"><b>تحت السعر:</b></div><ul class="ds-list ds-dn">' + dwLines + '</ul>' +
      (decisiveUp ? '<div class="ds-line"><b>المستوى الحاسم فوق:</b> ' + decisiveUp.name + ' عند ' + fmt(decisiveUp.price, 2) + ' — عتبة حقيقية.</div>' : '') +
      (decisiveDn ? '<div class="ds-line"><b>المستوى الحاسم تحت:</b> ' + decisiveDn.name + ' عند ' + fmt(decisiveDn.price, 2) + ' — عتبة حقيقية.</div>' : '') +
      '<div class="ds-line">' + gapTxt + '</div>' +
      '<div class="ds-sec">أفضل السيناريوهات (Highest Probability Chain)</div>'
    );
  }

  function chainBlock(o) {
    if (!o.setups.length) {
      return '<div class="ds-nosetup"><div class="h">🚫 ماكاين حتى سيناريو عالي الاحتمال — ' + o.label + '</div>' +
        '<div class="why">الماكينة رفضات جميع السيناريوهات: لا مستوى هيكلي قريب (أقل من 2.3σ)، ولا هدف بمخاطرة R:R ≥ 1.3، ولا احتمال ربح ≥ 30%. حيود القوان اهناك هو القرار الذكي — السوق ماشي عند حافة هيكلية دابا.' +
        (o.alerts.length ? '<br>Alerts: ' + o.alerts.map(function (x) { return x.title; }).join(' · ') : '') + '</div></div>';
    }
    var cards = o.setups.map(function (s, i) {
      var dirC = s.dir === 'SHORT' ? 'ds-up' : 'ds-dn';
      var dirTxt = s.dir === 'SHORT' ? 'SELL' : 'BUY';
      var cTxt = 'الأقرب · ' + s.prob + '%';
      if (i === 1) cTxt = 'بديل (فاش S1) · ' + s.prob + '%';
      else if (i === 2) cTxt = 'بعيد المدى · ' + s.prob + '%';
      var tp1Txt = s.tp1 ? fmt(s.tp1.price, 2) + ' (' + s.tp1.name + ')' : 'ماكاين مستوى وسيط واضح، عدّي مباشرة لـTP2';
      var weak = s.weak ? '<div class="ds-weak">⚠️ R:R ضعيف (' + s.R.toFixed(2) + 'R) — صغّر الحجم ولا استنى موقع أحسن</div>' : '';
      var confirmLines = [
        (i === 0 ? 'إغلاق 1m داخل ' + (s.dir === 'SHORT' ? 'تحت' : 'فوق') + ' مستوى الدخول بفوليوم فوق المعدل' : 'إغلاق 1m ' + (s.dir === 'SHORT' ? 'تحت' : 'فوق') + ' + ' + fmt(s.entry, 2) + ' بحجم قوي'),
        'CVD كيبدا ' + (s.dir === 'SHORT' ? 'يهبط مع الاقتراب — بائعين مسيطرين' : 'يطلع مع الاقتراب — مشترين مسيطرين'),
        'Footprint كيبين imbalance عند شمعة الرفض/الارتداد',
        'إغلاق 5m كيأكد استمرار الحركة'
      ].map(function (x) { return '<li>' + x + '</li>'; }).join('');
      return '<div class="ds-scen">' +
        '<div class="h"><span class="ds-badge medium">' + s.label + ' · ' + cTxt + '</span><span class="ds-badge ' + s.confidence.toLowerCase() + '">' + (s.confidence) + ' · <b class="ds-r">' + s.R.toFixed(2) + 'R</b></span></div>' +
        '<div class="tt ' + (s.dir === 'SHORT' ? 'short' : 'long') + '">' + dirTxt + ' · ' + s.title + '</div>' +
        '<div class="nt">' + s.note + ' — احتمالية تقديرية: ' + s.prob + '%</div>' +
        '<div class="ds-boxes">' +
        '<div class="ds-box"><div class="lbl">ENTRY (دخول دقيق)</div><div class="val ds-big">' + fmt(s.entry, 2) + '</div></div>' +
        '<div class="ds-box"><div class="lbl">SL (وقف الخسارة)</div><div class="val ds-risk">' + fmt(s.stop, 2) + ' (مخاطرة ' + fmt(s.risk, 1) + ' نقطة)</div></div>' +
        '<div class="ds-box"><div class="lbl">TP1 (جزئي ~50%)</div><div class="val">' + tp1Txt + '</div></div>' +
        '<div class="ds-box"><div class="lbl">TP2 (نهائي)</div><div class="val ds-big">' + fmt(s.target, 2) + ' (' + s.targetName + ') — ' + s.R.toFixed(2) + 'R</div></div>' +
        '<div class="ds-box"><div class="lbl">نطاق دخول أوسع</div><div class="val" style="font-size:11px">' + fmt(s.wide[0], 2) + ' – ' + fmt(s.wide[1], 2) + '</div></div>' +
        '</div>' +
        '<ul class="ds-list">' + confirmLines + '</ul>' +
        '<div class="ds-die">💀 <b>مات إلا:</b> ' + s.invalidation + '</div>' +
        weak +
        '</div>';
    }).join('');
    return '<div class="ds-card" style="padding:4px 2px;border:none;background:transparent">' + cards + '</div>';
  }

  function RTLCard(inner) {
    return '<div class="ds-card ds-rtl">' + inner + '</div>';
  }

  function noSetupCard(o) {
    return '<div class="ds-nosetup"><div class="h">🚫 NO HIGH-PROBABILITY SETUPS — ' + o.label + '</div>' +
      '<div class="why">Nothing cleared win-prob ≥ 30% + RR ≥ 1.3 + geometry. Market is not at a structural edge right now.</div>' +
      (o.alerts.length ? '<div class="ds-warn">Alerts: ' + o.alerts.map(function (x) { return x.title; }).join(' · ') + '</div>' : '') + '</div>';
  }

  async function run() {
    if (typeof document === 'undefined') return;
    injectStyles();
    var current = (typeof state !== 'undefined' && state && state.currentAsset) ? state.currentAsset : 'GC';
    var assets = (current === 'GC' || current === 'ES' || current === 'NQ') ? [current] : ['GC', 'ES', 'NQ'];
    openModal(assets.length === 1 ? assets[0] : null);
    var results = [], failed = [];
    try {
      for (var i = 0; i < assets.length; i++) {
        var asset = assets[i];
        try {
          var got = await getData(asset);
          var o = analyze(asset, got.raw); o.meta = got.meta;
          results.push(o);
        } catch (e) { failed.push(asset); }
      }
      if (!results.length) { showErr('Could not load data. Is server + live loop running?'); return; }
      render(results);
      if (failed.length) {
        var fb = document.createElement('div'); fb.className = 'ds-err';
        fb.textContent = 'Missing: ' + failed.join(', ');
        document.getElementById('ds-body').appendChild(fb);
      }
    } catch (e) { showErr('Fatal: ' + e.message); }
  }

  function showErr(msg) {
    if (typeof document === 'undefined') return;
    document.getElementById('ds-body').innerHTML = '<div class="ds-err">' + msg + '</div>';
  }

  global.DeepSetup = { run: run, close: closeModal, analyze: analyze };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { analyze: analyze, fmt: fmt, fmtC: fmtC };
  }
})(typeof window !== 'undefined' ? window : this);
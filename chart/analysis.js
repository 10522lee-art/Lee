// 차트 분석 엔진 — 표준 교과서 정의(Wilder, Appel, Bollinger, Lane, Granville, Hosoda)를 그대로 구현
// 입력: candles = [{time, open, high, low, close, volume}] (시간 오름차순)
(function (root) {
  'use strict';

  // ---------- 기본 연산 ----------
  function sma(src, n) {
    const out = new Array(src.length).fill(null);
    let sum = 0, cnt = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v == null) { sum = 0; cnt = 0; continue; }
      sum += v; cnt++;
      if (cnt > n) { sum -= src[i - n]; cnt = n; }
      if (cnt === n) out[i] = sum / n;
    }
    return out;
  }

  // EMA: 첫 값은 SMA로 시드 (표준)
  function ema(src, n) {
    const out = new Array(src.length).fill(null);
    const k = 2 / (n + 1);
    let start = src.findIndex(v => v != null);
    if (start < 0 || src.length - start < n) return out;
    let s = 0;
    for (let i = start; i < start + n; i++) s += src[i];
    let prev = s / n;
    out[start + n - 1] = prev;
    for (let i = start + n; i < src.length; i++) {
      prev = src[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // Wilder 평활 (RMA) — RSI, ATR, ADX 원전 정의
  function rma(src, n) {
    const out = new Array(src.length).fill(null);
    let start = src.findIndex(v => v != null);
    if (start < 0 || src.length - start < n) return out;
    let s = 0;
    for (let i = start; i < start + n; i++) s += src[i];
    let prev = s / n;
    out[start + n - 1] = prev;
    for (let i = start + n; i < src.length; i++) {
      prev = (prev * (n - 1) + src[i]) / n;
      out[i] = prev;
    }
    return out;
  }

  function stdev(src, n) {
    const m = sma(src, n);
    return src.map((_, i) => {
      if (m[i] == null) return null;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (src[j] - m[i]) ** 2;
      return Math.sqrt(s / n); // 모집단 표준편차 (Bollinger 원전)
    });
  }

  const highest = (src, n, i) => { let m = -Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.max(m, src[j]); return m; };
  const lowest = (src, n, i) => { let m = Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, src[j]); return m; };

  // ---------- 지표 ----------
  function rsi(close, n = 14) {
    const up = [null], dn = [null];
    for (let i = 1; i < close.length; i++) {
      const d = close[i] - close[i - 1];
      up.push(Math.max(d, 0)); dn.push(Math.max(-d, 0));
    }
    const au = rma(up, n), ad = rma(dn, n);
    return close.map((_, i) => au[i] == null ? null : ad[i] === 0 ? 100 : 100 - 100 / (1 + au[i] / ad[i]));
  }

  function macd(close, f = 12, s = 26, sig = 9) {
    const ef = ema(close, f), es = ema(close, s);
    const line = close.map((_, i) => ef[i] != null && es[i] != null ? ef[i] - es[i] : null);
    const signal = ema(line, sig);
    const hist = line.map((v, i) => v != null && signal[i] != null ? v - signal[i] : null);
    return { line, signal, hist };
  }

  function bollinger(close, n = 20, k = 2) {
    const mid = sma(close, n), sd = stdev(close, n);
    return {
      mid,
      upper: mid.map((m, i) => m == null ? null : m + k * sd[i]),
      lower: mid.map((m, i) => m == null ? null : m - k * sd[i]),
    };
  }

  function stochastic(h, l, c, n = 14, kS = 3, dS = 3) {
    const raw = c.map((v, i) => {
      if (i < n - 1) return null;
      const hh = highest(h, n, i), ll = lowest(l, n, i);
      return hh === ll ? 50 : (v - ll) / (hh - ll) * 100;
    });
    const k = sma(raw, kS);
    return { k, d: sma(k, dS) };
  }

  function trueRange(h, l, c) {
    return h.map((_, i) => i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  }
  const atr = (h, l, c, n = 14) => rma(trueRange(h, l, c), n);

  function adx(h, l, c, n = 14) {
    const pdm = [0], mdm = [0];
    for (let i = 1; i < h.length; i++) {
      const u = h[i] - h[i - 1], d = l[i - 1] - l[i];
      pdm.push(u > d && u > 0 ? u : 0);
      mdm.push(d > u && d > 0 ? d : 0);
    }
    const tr = rma(trueRange(h, l, c), n), p = rma(pdm, n), m = rma(mdm, n);
    const pdi = tr.map((t, i) => t ? 100 * p[i] / t : null);
    const mdi = tr.map((t, i) => t ? 100 * m[i] / t : null);
    const dx = pdi.map((v, i) => v == null ? null : (v + mdi[i] === 0 ? 0 : 100 * Math.abs(v - mdi[i]) / (v + mdi[i])));
    return { adx: rma(dx, n), pdi, mdi };
  }

  function obv(c, v) {
    let s = 0;
    return c.map((x, i) => { if (i > 0) s += x > c[i - 1] ? v[i] : x < c[i - 1] ? -v[i] : 0; return s; });
  }

  function mfi(h, l, c, v, n = 14) {
    const tp = c.map((x, i) => (h[i] + l[i] + x) / 3);
    return tp.map((_, i) => {
      if (i < n) return null;
      let pos = 0, neg = 0;
      for (let j = i - n + 1; j <= i; j++) {
        const f = tp[j] * v[j];
        if (tp[j] > tp[j - 1]) pos += f; else if (tp[j] < tp[j - 1]) neg += f;
      }
      return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    });
  }

  function ichimoku(h, l, n1 = 9, n2 = 26, n3 = 52) {
    const mid = (n, i) => i < n - 1 ? null : (highest(h, n, i) + lowest(l, n, i)) / 2;
    const tenkan = h.map((_, i) => mid(n1, i));
    const kijun = h.map((_, i) => mid(n2, i));
    // 선행스팬은 26봉 앞으로 그려지므로, 현재 봉의 구름 = 26봉 전에 계산된 값
    const spanAraw = tenkan.map((t, i) => t == null || kijun[i] == null ? null : (t + kijun[i]) / 2);
    const spanBraw = h.map((_, i) => mid(n3, i));
    const shift = (a) => a.map((_, i) => i >= n2 ? a[i - n2] : null);
    return { tenkan, kijun, spanA: shift(spanAraw), spanB: shift(spanBraw), spanAraw, spanBraw };
  }

  // ---------- 패턴 인식 ----------
  function pivots(h, l, w = 5) {
    const highs = [], lows = [];
    for (let i = w; i < h.length - w; i++) {
      let isH = true, isL = true;
      for (let j = i - w; j <= i + w; j++) {
        if (j === i) continue;
        if (j < i ? h[j] >= h[i] : h[j] > h[i]) isH = false;
        if (j < i ? l[j] <= l[i] : l[j] < l[i]) isL = false;
      }
      if (isH) highs.push(i);
      if (isL) lows.push(i);
    }
    return { highs, lows };
  }

  // 지지/저항: 피벗 가격을 ATR 기준 허용오차로 군집화, 터치 횟수로 강도 산정
  function supportResistance(candles, piv, atrNow, maxLevels = 6) {
    const pts = [
      ...piv.highs.map(i => ({ p: candles[i].high, i })),
      ...piv.lows.map(i => ({ p: candles[i].low, i })),
    ].sort((a, b) => a.p - b.p);
    const tol = (atrNow || candles[candles.length - 1].close * 0.01) * 1.0;
    const clusters = [];
    for (const pt of pts) {
      const c = clusters[clusters.length - 1];
      if (c && pt.p - c.min <= tol) { c.pts.push(pt); c.max = pt.p; }
      else clusters.push({ pts: [pt], min: pt.p, max: pt.p });
    }
    const n = candles.length;
    const last = candles[n - 1].close;
    return clusters
      .map(c => {
        const price = c.pts.reduce((s, x) => s + x.p, 0) / c.pts.length;
        const recency = Math.max(...c.pts.map(x => x.i)) / n;
        return { price, touches: c.pts.length, strength: c.pts.length + recency, type: price >= last ? 'resistance' : 'support' };
      })
      .filter(c => c.touches >= 2)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, maxLevels)
      .sort((a, b) => b.price - a.price);
  }

  // 추세선: 최근 두 피벗 고점/저점 연결
  function trendlines(candles, piv) {
    const res = [];
    const mk = (idx, key, kind) => {
      if (idx.length < 2) return;
      const a = idx[idx.length - 2], b = idx[idx.length - 1];
      const pa = candles[a][key], pb = candles[b][key];
      const slope = (pb - pa) / (b - a);
      const n = candles.length - 1;
      res.push({ kind, a, b, pa, pb, slope, projected: pb + slope * (n - b) });
    };
    mk(piv.highs, 'high', 'resistance');
    mk(piv.lows, 'low', 'support');
    return res;
  }

  // 캔들 패턴 (Nison 정의 기반, 추세 문맥 = 직전 10봉 대비 위치)
  function candlePatterns(candles, atrArr) {
    const out = [];
    const body = c => Math.abs(c.close - c.open);
    const range = c => c.high - c.low || 1e-12;
    const upper = c => c.high - Math.max(c.open, c.close);
    const lower = c => Math.min(c.open, c.close) - c.low;
    const bull = c => c.close > c.open, bear = c => c.close < c.open;
    const trend = i => {
      if (i < 10) return 0;
      const ch = candles[i - 1].close - candles[i - 10].close;
      const a = atrArr[i - 1] || range(candles[i - 1]);
      return ch > a ? 1 : ch < -a ? -1 : 0;
    };
    for (let i = 2; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1], pp = candles[i - 2], t = trend(i);
      const a = atrArr[i] || range(c);
      const add = (name, dir) => out.push({ i, time: c.time, name, dir });
      if (body(c) <= range(c) * 0.1 && range(c) > a * 0.3) add('도지', 0);
      if (t < 0 && lower(c) >= body(c) * 2 && upper(c) <= body(c) * 0.5 && body(c) > 0) add('망치형', 1);
      if (t > 0 && lower(c) >= body(c) * 2 && upper(c) <= body(c) * 0.5 && body(c) > 0) add('교수형', -1);
      if (t < 0 && upper(c) >= body(c) * 2 && lower(c) <= body(c) * 0.5 && body(c) > 0) add('역망치형', 1);
      if (t > 0 && upper(c) >= body(c) * 2 && lower(c) <= body(c) * 0.5 && body(c) > 0) add('유성형', -1);
      if (t < 0 && bear(p) && bull(c) && c.open <= p.close && c.close >= p.open && body(c) > body(p)) add('상승장악형', 1);
      if (t > 0 && bull(p) && bear(c) && c.open >= p.close && c.close <= p.open && body(c) > body(p)) add('하락장악형', -1);
      if (t < 0 && bear(p) && bull(c) && c.open < p.low && c.close > (p.open + p.close) / 2 && c.close < p.open) add('관통형', 1);
      if (t > 0 && bull(p) && bear(c) && c.open > p.high && c.close < (p.open + p.close) / 2 && c.close > p.open) add('먹구름형', -1);
      if (t < 0 && bear(pp) && body(pp) > a * 0.6 && body(p) < body(pp) * 0.4 && bull(c) && c.close > (pp.open + pp.close) / 2) add('샛별형', 1);
      if (t > 0 && bull(pp) && body(pp) > a * 0.6 && body(p) < body(pp) * 0.4 && bear(c) && c.close < (pp.open + pp.close) / 2) add('석별형', -1);
      if ([pp, p, c].every(bull) && p.close > pp.close && c.close > p.close && [pp, p, c].every(x => body(x) > a * 0.5 && upper(x) < body(x) * 0.5)) add('적삼병', 1);
      if ([pp, p, c].every(bear) && p.close < pp.close && c.close < p.close && [pp, p, c].every(x => body(x) > a * 0.5 && lower(x) < body(x) * 0.5)) add('흑삼병', -1);
    }
    return out;
  }

  // 차트 패턴: 이중천장/이중바닥 (최근 두 피벗이 ATR 이내, 넥라인 돌파 여부)
  function chartPatterns(candles, piv, atrNow) {
    const out = [];
    const n = candles.length, last = candles[n - 1].close;
    const tol = atrNow * 0.8;
    const H = piv.highs, L = piv.lows;
    if (H.length >= 2) {
      const a = H[H.length - 2], b = H[H.length - 1];
      if (Math.abs(candles[a].high - candles[b].high) <= tol && b - a >= 5) {
        let neck = Infinity; for (let i = a; i <= b; i++) neck = Math.min(neck, candles[i].low);
        out.push({ name: '이중천장', dir: -1, confirmed: last < neck, neckline: neck, detail: `넥라인 ${fmt(neck)} ${last < neck ? '하향 이탈(확정)' : '미이탈(진행중)'}` });
      }
    }
    if (L.length >= 2) {
      const a = L[L.length - 2], b = L[L.length - 1];
      if (Math.abs(candles[a].low - candles[b].low) <= tol && b - a >= 5) {
        let neck = -Infinity; for (let i = a; i <= b; i++) neck = Math.max(neck, candles[i].high);
        out.push({ name: '이중바닥', dir: 1, confirmed: last > neck, neckline: neck, detail: `넥라인 ${fmt(neck)} ${last > neck ? '상향 돌파(확정)' : '미돌파(진행중)'}` });
      }
    }
    // 헤드앤숄더: 최근 세 피벗 고점, 가운데가 최고, 양 어깨 ATR*1.5 이내
    if (H.length >= 3) {
      const [a, b, c] = H.slice(-3).map(i => candles[i].high);
      if (b > a && b > c && Math.abs(a - c) <= atrNow * 1.5) {
        let neck = Infinity; for (let i = H[H.length - 3]; i <= H[H.length - 1]; i++) neck = Math.min(neck, candles[i].low);
        out.push({ name: '헤드앤숄더', dir: -1, confirmed: last < neck, neckline: neck, detail: `넥라인 ${fmt(neck)} ${last < neck ? '이탈(확정)' : '진행중'}` });
      }
    }
    if (L.length >= 3) {
      const [a, b, c] = L.slice(-3).map(i => candles[i].low);
      if (b < a && b < c && Math.abs(a - c) <= atrNow * 1.5) {
        let neck = -Infinity; for (let i = L[L.length - 3]; i <= L[L.length - 1]; i++) neck = Math.max(neck, candles[i].high);
        out.push({ name: '역헤드앤숄더', dir: 1, confirmed: last > neck, neckline: neck, detail: `넥라인 ${fmt(neck)} ${last > neck ? '돌파(확정)' : '진행중'}` });
      }
    }
    return out;
  }

  // RSI 다이버전스: 최근 두 피벗 비교
  function divergence(candles, piv, rsiArr) {
    const out = [];
    const L = piv.lows.slice(-2), H = piv.highs.slice(-2);
    const n = candles.length;
    if (L.length === 2 && n - L[1] <= 20 && rsiArr[L[0]] != null) {
      if (candles[L[1]].low < candles[L[0]].low && rsiArr[L[1]] > rsiArr[L[0]]) out.push({ name: '강세 다이버전스(RSI)', dir: 1 });
    }
    if (H.length === 2 && n - H[1] <= 20 && rsiArr[H[0]] != null) {
      if (candles[H[1]].high > candles[H[0]].high && rsiArr[H[1]] < rsiArr[H[0]]) out.push({ name: '약세 다이버전스(RSI)', dir: -1 });
    }
    return out;
  }

  function fmt(x) {
    if (x == null || !isFinite(x)) return '-';
    const a = Math.abs(x);
    const d = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 8;
    return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  // ---------- 종합 분석 ----------
  function analyze(candles) {
    const o = candles.map(c => c.open), h = candles.map(c => c.high), l = candles.map(c => c.low);
    const c = candles.map(x => x.close), v = candles.map(x => x.volume || 0);
    const n = c.length, i = n - 1;
    const ind = {
      sma5: sma(c, 5), sma20: sma(c, 20), sma60: sma(c, 60), sma120: sma(c, 120),
      ema12: ema(c, 12), ema26: ema(c, 26),
      bb: bollinger(c), rsi: rsi(c), macd: macd(c), stoch: stochastic(h, l, c),
      atr: atr(h, l, c), adx: adx(h, l, c), obv: obv(c, v), mfi: mfi(h, l, c, v),
      ichi: ichimoku(h, l), volSma20: sma(v, 20),
    };
    const piv = pivots(h, l, n > 300 ? 6 : 4);
    const atrNow = ind.atr[i] || (h[i] - l[i]);
    const levels = supportResistance(candles, piv, atrNow);
    const lines = trendlines(candles, piv);
    const cpat = candlePatterns(candles, ind.atr);
    const chpat = chartPatterns(candles, piv, atrNow);
    const div = divergence(candles, piv, ind.rsi);

    // 신호 채점: 각 항목 -2..+2, 카테고리 가중 평균 → -100..+100
    const sig = [];
    const S = (cat, name, score, note) => sig.push({ cat, name, score, note });
    const px = c[i];
    const has = (...xs) => xs.every(x => x != null && isFinite(x));

    // 추세
    if (has(ind.sma20[i], ind.sma60[i])) {
      const s = px > ind.sma20[i] && ind.sma20[i] > ind.sma60[i] ? 2 : px < ind.sma20[i] && ind.sma20[i] < ind.sma60[i] ? -2 : px > ind.sma20[i] ? 1 : -1;
      S('추세', '이동평균 배열', s, `종가 ${fmt(px)} / MA20 ${fmt(ind.sma20[i])} / MA60 ${fmt(ind.sma60[i])}`);
    }
    if (has(ind.sma120[i], ind.sma60[i])) {
      S('추세', '장기추세(MA60 vs MA120)', ind.sma60[i] > ind.sma120[i] ? 1 : -1, ind.sma60[i] > ind.sma120[i] ? '정배열 장기 상승' : '역배열 장기 하락');
    }
    // 최근 10봉 내 골든/데드크로스 (MA20×MA60)
    for (let k = Math.max(1, n - 10); k < n; k++) {
      const a0 = ind.sma20[k - 1], b0 = ind.sma60[k - 1], a1 = ind.sma20[k], b1 = ind.sma60[k];
      if (!has(a0, b0, a1, b1)) continue;
      if (a0 <= b0 && a1 > b1) S('추세', '골든크로스(20/60)', 2, `${n - 1 - k}봉 전 발생`);
      if (a0 >= b0 && a1 < b1) S('추세', '데드크로스(20/60)', -2, `${n - 1 - k}봉 전 발생`);
    }
    if (has(ind.adx.adx[i])) {
      const a = ind.adx.adx[i], up = ind.adx.pdi[i] > ind.adx.mdi[i];
      S('추세', 'ADX/DMI', a < 20 ? 0 : (up ? 1 : -1) * (a > 30 ? 2 : 1), `ADX ${a.toFixed(1)} (${a < 20 ? '추세 약함' : a > 30 ? '강한 추세' : '추세 형성'}), +DI ${ind.adx.pdi[i].toFixed(1)} / -DI ${ind.adx.mdi[i].toFixed(1)}`);
    }
    const ic = ind.ichi;
    if (has(ic.spanA[i], ic.spanB[i], ic.tenkan[i], ic.kijun[i])) {
      const top = Math.max(ic.spanA[i], ic.spanB[i]), bot = Math.min(ic.spanA[i], ic.spanB[i]);
      const s = px > top ? (ic.tenkan[i] > ic.kijun[i] ? 2 : 1) : px < bot ? (ic.tenkan[i] < ic.kijun[i] ? -2 : -1) : 0;
      S('추세', '일목균형표', s, px > top ? '구름 위' : px < bot ? '구름 아래' : '구름 안(중립)');
    }
    // 모멘텀
    if (has(ind.rsi[i])) {
      const r = ind.rsi[i];
      const s = r >= 70 ? -1 : r <= 30 ? 1 : r > 55 ? 1 : r < 45 ? -1 : 0;
      S('모멘텀', 'RSI(14)', s, `${r.toFixed(1)} ${r >= 70 ? '과매수' : r <= 30 ? '과매도' : r > 50 ? '강세 영역' : '약세 영역'}`);
    }
    const m = ind.macd;
    if (has(m.line[i], m.signal[i], m.hist[i - 1])) {
      const above = m.line[i] > m.signal[i], rising = m.hist[i] > m.hist[i - 1];
      S('모멘텀', 'MACD(12,26,9)', above ? (rising ? 2 : 1) : (rising ? -1 : -2), `MACD ${fmt(m.line[i])} / 시그널 ${fmt(m.signal[i])} / 히스토그램 ${rising ? '증가' : '감소'}`);
    }
    if (has(ind.stoch.k[i], ind.stoch.d[i])) {
      const k = ind.stoch.k[i], d = ind.stoch.d[i];
      const s = k < 20 && k > d ? 2 : k > 80 && k < d ? -2 : k < 20 ? 1 : k > 80 ? -1 : k > d ? 1 : -1;
      S('모멘텀', '스토캐스틱(14,3,3)', s, `%K ${k.toFixed(1)} / %D ${d.toFixed(1)}`);
    }
    if (has(ind.mfi[i])) {
      const f = ind.mfi[i];
      S('거래량', 'MFI(14)', f >= 80 ? -1 : f <= 20 ? 1 : 0, f.toFixed(1));
    }
    // 변동성
    const bb = ind.bb;
    if (has(bb.upper[i], bb.lower[i])) {
      const pb = (px - bb.lower[i]) / (bb.upper[i] - bb.lower[i]);
      const s = pb > 1 ? -1 : pb < 0 ? 1 : 0;
      const width = (bb.upper[i] - bb.lower[i]) / bb.mid[i] * 100;
      S('변동성', '볼린저밴드(20,2)', s, `%B ${(pb * 100).toFixed(0)}%, 밴드폭 ${width.toFixed(1)}%${pb > 1 ? ' 상단 이탈' : pb < 0 ? ' 하단 이탈' : ''}`);
    }
    // 거래량
    if (n > 21) {
      const obvSlope = ind.obv[i] - ind.obv[i - 20], pxSlope = px - c[i - 20];
      const s = obvSlope > 0 && pxSlope > 0 ? 1 : obvSlope < 0 && pxSlope < 0 ? -1 : obvSlope > 0 ? 1 : -1;
      S('거래량', 'OBV 20봉 추세', s, `${obvSlope > 0 ? '매집' : '분산'}${(obvSlope > 0) !== (pxSlope > 0) ? ' (가격과 괴리)' : ''}`);
    }
    if (has(ind.volSma20[i]) && ind.volSma20[i] > 0) {
      const ratio = v[i] / ind.volSma20[i];
      if (ratio > 1.5) S('거래량', '거래량 급증', c[i] > o[i] ? 1 : -1, `평균 대비 ${ratio.toFixed(1)}배, ${c[i] > o[i] ? '양봉' : '음봉'}`);
    }
    // 패턴
    cpat.filter(p => p.i >= n - 3 && p.dir !== 0).forEach(p => S('패턴', `캔들: ${p.name}`, p.dir, `${n - 1 - p.i}봉 전`));
    chpat.forEach(p => S('패턴', p.name, p.dir * (p.confirmed ? 2 : 1), p.detail));
    div.forEach(d => S('패턴', d.name, d.dir * 2, '최근 피벗 기준'));
    const nearR = levels.filter(x => x.type === 'resistance').sort((a, b) => a.price - b.price)[0];
    const nearS = levels.filter(x => x.type === 'support').sort((a, b) => b.price - a.price)[0];
    if (nearR && (nearR.price - px) < atrNow * 0.5) S('패턴', '저항선 근접', -1, `${fmt(nearR.price)} (터치 ${nearR.touches}회)`);
    if (nearS && (px - nearS.price) < atrNow * 0.5) S('패턴', '지지선 근접', 1, `${fmt(nearS.price)} (터치 ${nearS.touches}회)`);

    const weights = { 추세: 0.35, 모멘텀: 0.25, 거래량: 0.15, 변동성: 0.1, 패턴: 0.15 };
    const cats = {};
    for (const s of sig) (cats[s.cat] ||= []).push(s.score);
    let tot = 0, wsum = 0;
    const catScores = {};
    for (const [k, w] of Object.entries(weights)) {
      if (!cats[k]) continue;
      const avg = cats[k].reduce((a, b) => a + b, 0) / cats[k].length; // -2..2
      const sc = Math.max(-100, Math.min(100, avg / 2 * 100));
      catScores[k] = sc; tot += sc * w; wsum += w;
    }
    const score = wsum ? Math.round(tot / wsum) : 0;
    const verdict = score >= 50 ? '강력 매수' : score >= 15 ? '매수' : score > -15 ? '중립' : score > -50 ? '매도' : '강력 매도';

    // 리스크 관리 가이드 (ATR 기반)
    const risk = {
      atr: atrNow, atrPct: atrNow / px * 100,
      stopLong: px - 2 * atrNow, targetLong: px + 3 * atrNow,
      stopShort: px + 2 * atrNow, targetShort: px - 3 * atrNow,
      support: nearS ? nearS.price : null, resistance: nearR ? nearR.price : null,
    };
    return { ind, piv, levels, lines, candlePatterns: cpat, chartPatterns: chpat, divergence: div, signals: sig, catScores, score, verdict, risk };
  }


  // ---------- 백테스트 ----------
  // 봉별 점수: 미래 데이터를 쓰지 않는 지표만 사용 (피벗·패턴은 사후 확정이라 제외 → 과대평가 방지)
  function scoreSeries(candles) {
    const h = candles.map(c => c.high), l = candles.map(c => c.low), c = candles.map(x => x.close), v = candles.map(x => x.volume || 0);
    const s20 = sma(c, 20), s60 = sma(c, 60), s120 = sma(c, 120), r = rsi(c), m = macd(c), st = stochastic(h, l, c);
    const ad = adx(h, l, c), bb = bollinger(c), ob = obv(c, v), mf = mfi(h, l, c, v), ic = ichimoku(h, l);
    const W = { t: 0.35, m: 0.25, v: 0.15, x: 0.1 };
    return c.map((px, i) => {
      const cat = { t: [], m: [], v: [], x: [] };
      if (s20[i] != null && s60[i] != null) cat.t.push(px > s20[i] && s20[i] > s60[i] ? 2 : px < s20[i] && s20[i] < s60[i] ? -2 : px > s20[i] ? 1 : -1);
      if (s120[i] != null) cat.t.push(s60[i] > s120[i] ? 1 : -1);
      if (ad.adx[i] != null) { const a = ad.adx[i]; cat.t.push(a < 20 ? 0 : (ad.pdi[i] > ad.mdi[i] ? 1 : -1) * (a > 30 ? 2 : 1)); }
      if (ic.spanA[i] != null && ic.spanB[i] != null && ic.kijun[i] != null) {
        const top = Math.max(ic.spanA[i], ic.spanB[i]), bot = Math.min(ic.spanA[i], ic.spanB[i]);
        cat.t.push(px > top ? (ic.tenkan[i] > ic.kijun[i] ? 2 : 1) : px < bot ? (ic.tenkan[i] < ic.kijun[i] ? -2 : -1) : 0);
      }
      if (r[i] != null) cat.m.push(r[i] >= 70 ? -1 : r[i] <= 30 ? 1 : r[i] > 55 ? 1 : r[i] < 45 ? -1 : 0);
      if (m.hist[i] != null && m.hist[i - 1] != null) { const up = m.hist[i] > m.hist[i - 1]; cat.m.push(m.hist[i] > 0 ? (up ? 2 : 1) : (up ? -1 : -2)); }
      if (st.k[i] != null && st.d[i] != null) { const k = st.k[i], d = st.d[i]; cat.m.push(k < 20 && k > d ? 2 : k > 80 && k < d ? -2 : k < 20 ? 1 : k > 80 ? -1 : k > d ? 1 : -1); }
      if (mf[i] != null) cat.v.push(mf[i] >= 80 ? -1 : mf[i] <= 20 ? 1 : 0);
      if (i >= 20) cat.v.push(ob[i] - ob[i - 20] > 0 ? 1 : -1);
      if (bb.upper[i] != null) { const pb = (px - bb.lower[i]) / (bb.upper[i] - bb.lower[i]); cat.x.push(pb > 1 ? -1 : pb < 0 ? 1 : 0); }
      let tot = 0, ws = 0;
      for (const k in W) if (cat[k].length) { tot += cat[k].reduce((a, b) => a + b, 0) / cat[k].length / 2 * 100 * W[k]; ws += W[k]; }
      return ws && cat.t.length ? Math.round(tot / ws) : null;
    });
  }

  // 신호 봉 종가로 판단 → 다음 봉 시가에 체결 (룩어헤드 없음), 수수료+슬리피지 편도 적용
  function backtest(candles, opt = {}) {
    const { entry = 30, exit = 0, fee = 0.1, allowShort = false, stopAtr = 0 } = opt;
    const sc = scoreSeries(candles), at = atr(candles.map(c => c.high), candles.map(c => c.low), candles.map(c => c.close));
    const f = fee / 100, n = candles.length;
    let pos = 0, entryPx = 0, entryI = 0, stop = 0, eq = 1;
    const equity = [], trades = [], bh0 = candles[0].close;
    const close = (i, px, why) => {
      const g = pos > 0 ? px / entryPx : 2 - px / entryPx;
      const ret = g * (1 - f) / (1 + f) - 1;
      eq *= 1 + ret;
      trades.push({ side: pos > 0 ? 'L' : 'S', entryTime: candles[entryI].time, exitTime: candles[i].time, entryPx, exitPx: px, ret, bars: i - entryI, why });
      pos = 0;
    };
    for (let i = 1; i < n; i++) {
      const c = candles[i], s = sc[i - 1]; // 직전 봉 신호
      if (pos && stopAtr && (pos > 0 ? c.low <= stop : c.high >= stop)) {
        close(i, pos > 0 ? Math.min(c.open, stop) : Math.max(c.open, stop), '손절');
      } else if (s != null) {
        if (pos > 0 && s < exit) close(i, c.open, '신호');
        else if (pos < 0 && s > -exit) close(i, c.open, '신호');
        if (!pos && s >= entry) { pos = 1; entryPx = c.open; entryI = i; stop = c.open - stopAtr * (at[i - 1] || 0); }
        else if (!pos && allowShort && s <= -entry) { pos = -1; entryPx = c.open; entryI = i; stop = c.open + stopAtr * (at[i - 1] || 0); }
      }
      const mtm = pos > 0 ? eq * (c.close / entryPx) * (1 - f) / (1 + f) : pos < 0 ? eq * (2 - c.close / entryPx) * (1 - f) / (1 + f) : eq;
      equity.push({ time: c.time, value: mtm, bh: c.close / bh0 });
    }
    if (pos) close(n - 1, candles[n - 1].close, '기간종료');
    // 지표
    let peak = 0, mdd = 0;
    for (const e of equity) { peak = Math.max(peak, e.value); mdd = Math.min(mdd, e.value / peak - 1); }
    let bpk = 0, bmdd = 0;
    for (const e of equity) { bpk = Math.max(bpk, e.bh); bmdd = Math.min(bmdd, e.bh / bpk - 1); }
    const rets = equity.map((e, i) => i ? e.value / equity[i - 1].value - 1 : 0);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
    const barSec = n > 1 ? (candles[n - 1].time - candles[0].time) / (n - 1) : 86400;
    const perYear = 365.25 * 86400 / barSec, years = (candles[n - 1].time - candles[0].time) / 86400 / 365.25;
    const wins = trades.filter(t => t.ret > 0), loss = trades.filter(t => t.ret <= 0);
    const gp = wins.reduce((a, t) => a + t.ret, 0), gl = -loss.reduce((a, t) => a + t.ret, 0);
    const exposure = trades.reduce((a, t) => a + t.bars, 0) / n;
    return {
      scores: sc, equity, trades,
      stats: {
        totalReturn: eq - 1, buyHold: candles[n - 1].close / bh0 - 1,
        cagr: years > 0 ? eq ** (1 / years) - 1 : 0, mdd, bhMdd: bmdd,
        sharpe: sd ? mean / sd * Math.sqrt(perYear) : 0,
        trades: trades.length, winRate: trades.length ? wins.length / trades.length : 0,
        profitFactor: gl ? gp / gl : gp ? Infinity : 0,
        avgWin: wins.length ? gp / wins.length : 0, avgLoss: loss.length ? -gl / loss.length : 0,
        exposure, years,
      },
    };
  }

  // 파라미터 최적화 그리드 (과최적화 주의: 앞 70% 학습, 뒤 30% 검증 결과를 함께 보고)
  function optimize(candles, base = {}) {
    const cut = Math.floor(candles.length * 0.7);
    const train = candles.slice(0, cut), test = candles.slice(Math.max(0, cut - 150)); // 지표 워밍업 150봉
    const res = [];
    for (const entry of [15, 30, 45, 60]) for (const exit of [-30, -15, 0, 15]) {
      if (exit >= entry) continue;
      const tr = backtest(train, { ...base, entry, exit }).stats;
      const te = backtest(test, { ...base, entry, exit }).stats;
      res.push({ entry, exit, train: tr, test: te });
    }
    return res.sort((a, b) => b.train.sharpe - a.train.sharpe);
  }

  const api = { scoreSeries, backtest, optimize, sma, ema, rma, stdev, rsi, macd, bollinger, stochastic, atr, adx, obv, mfi, ichimoku, pivots, supportResistance, trendlines, candlePatterns, chartPatterns, divergence, analyze, fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TA = api;
})(typeof window !== 'undefined' ? window : globalThis);

// 봇 본체: 명령 처리 + 주기 작업 (가격 알림, 페이지 감시, 종목 분석, 브리핑, 여행 비서)
// 저장소·실행 환경과 무관 — Node(scan.js, GitHub Actions)와 Cloudflare Workers(worker/) 둘 다 이 파일을 씀
// cfg = watchlist.json 내용, state = state.json 내용, tripData = 여행 지출 (호출하는 쪽이 읽고 저장)
const TA = require('../analysis.js');
const BR = require('./brief.js'), WT = require('./watch.js'), createTrip = require('./trip.js');

const UA = { 'User-Agent': 'Mozilla/5.0 (chart-bot)' };
const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const emo = score => score >= 15 ? '🟢' : score <= -15 ? '🔴' : '⚪';
const BAR_SEC = { '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
const MENU = [['help', '도움말'], ['brief', '아침 브리핑 지금 받기'], ['alert', '가격 알림 추가 (종목 가격)'], ['alerts', '가격 알림 목록'], ['unalert', '가격 알림 삭제'],
  ['watch', '웹페이지 감시 추가 (URL [키워드])'], ['watches', '웹페이지 감시 목록'], ['unwatch', '웹페이지 감시 삭제'], ['weather', '날씨 (도시)'], ['city', '브리핑 도시 변경'],
  ['now', '종목 바로 분석'], ['summary', '관심종목 요약'], ['status', '봇 상태'], ['list', '관심종목 목록'], ['add', '관심종목 추가'], ['remove', '관심종목 삭제'], ['paper', '모의매매 성과'], ['tf', '봉 단위 변경'],
  ['dash', '📊 대시보드 (그래프)'], ['trip', '✈️ 여행 일정·D-day'], ['today', '✈️ 오늘 도시·날씨·지출'], ['spent', '✈️ 지출 정리 (오늘/전체/도시)'], ['undo', '✈️ 마지막 지출 취소'],
  ['check', '✈️ 출발 전 체크리스트'], ['done', '✈️ 체크리스트 완료'], ['won', '✈️ 환산 (50유로)'], ['budget', '✈️ 예산 설정'], ['export', '✈️ 지출 엑셀(CSV) 받기']];

// 한글/약칭 → 종목 (/now 엔비디아, /alert 비트코인 -5%, 그냥 '달러'라고 보내기)
const A = (src, symbol, name) => ({ src, symbol, name });
const ALIAS = {};
for (const [keys, v] of [
  ['비트코인 btc', A('binance', 'BTCUSDT', '비트코인')], ['이더리움 이더 eth', A('binance', 'ETHUSDT', '이더리움')], ['리플 xrp', A('upbit', 'KRW-XRP', '리플')],
  ['솔라나 sol', A('binance', 'SOLUSDT', '솔라나')], ['도지 도지코인 doge', A('binance', 'DOGEUSDT', '도지코인')],
  ['달러 환율 usd 원달러', A('fx', 'USDKRW', '달러')], ['유로 eur', A('fx', 'EURKRW', '유로')], ['엔 엔화 jpy', A('fx', 'JPYKRW', '엔화(1엔)')],
  ['위안 위안화 cny', A('fx', 'CNYKRW', '위안')], ['파운드 gbp', A('fx', 'GBPKRW', '파운드')], ['프랑 스위스프랑 chf', A('fx', 'CHFKRW', '스위스프랑')],
  ['코스피 kospi', A('us', '^KS11', '코스피')], ['코스닥 kosdaq', A('us', '^KQ11', '코스닥')], ['나스닥지수', A('us', '^IXIC', '나스닥')], ['s&p500 sp500 에스앤피', A('us', '^GSPC', 'S&P500')],
  ['삼성전자 삼전', A('kr', '005930', '삼성전자')], ['sk하이닉스 하이닉스', A('kr', '000660', 'SK하이닉스')], ['네이버 naver', A('kr', '035420', '네이버')],
  ['카카오', A('kr', '035720', '카카오')], ['현대차 현대자동차', A('kr', '005380', '현대차')], ['lg에너지솔루션 엘지엔솔', A('kr', '373220', 'LG에너지솔루션')], ['셀트리온', A('kr', '068270', '셀트리온')],
  ['엔비디아', A('us', 'NVDA', '엔비디아')], ['테슬라', A('us', 'TSLA', '테슬라')], ['애플', A('us', 'AAPL', '애플')], ['마이크로소프트 마소', A('us', 'MSFT', '마이크로소프트')],
  ['구글 알파벳', A('us', 'GOOGL', '구글')], ['아마존', A('us', 'AMZN', '아마존')], ['메타 페이스북', A('us', 'META', '메타')], ['나스닥 qqq', A('us', 'QQQ', 'QQQ')], ['spy', A('us', 'SPY', 'SPY')],
]) for (const k of keys.split(' ')) ALIAS[k] = v;
const alias = q => { const v = ALIAS[String(q).toLowerCase().replace(/\s+/g, '')]; return v && { ...v }; };
function guessSrc(sym) {
  const al = alias(sym); if (al) return al;
  const u = sym.toUpperCase();
  if (/^KRW-/.test(u)) return { src: 'upbit', symbol: u };
  if (/^(USD|EUR|JPY|GBP|CNY|CHF|AUD|CAD|HKD)(KRW|USD|EUR|JPY)$/.test(u)) return { src: 'fx', symbol: u };
  if (/(USDT|USDC|BTC)$/.test(u) && u.length > 5) return { src: 'binance', symbol: u };
  if (/^\d{6}$/.test(u)) return { src: 'kr', symbol: u };
  return { src: 'us', symbol: u };
}
const tvLink = s => {
  const sym = s.src === 'binance' ? `BINANCE:${s.symbol}` : s.src === 'upbit' ? `UPBIT:${s.symbol.split('-')[1]}${s.symbol.split('-')[0]}` : s.src === 'kr' ? `KRX:${s.symbol}` : s.src === 'fx' ? `FX_IDC:${s.symbol}` : s.symbol;
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}`;
};

/**
 * @param o.cfg, o.state, o.tripData   데이터 (직접 수정됨)
 * @param o.send(text), o.sendDoc(name, content, caption), o.tg(method, body)   텔레그램 (없으면 콘솔)
 * @param o.env  { mock, mockPrice, mockPage, tripNow, mode: 'cloud'|'realtime'|'scheduled', since, candles }
 */
module.exports = function createBot(o) {
  const CFG = o.cfg, state = o.state, env = o.env || {}, log = o.log || console.log;
  const now = env.tripNow ? () => Date.parse(env.tripNow) : () => Date.now();
  const send = o.send, sendDoc = o.sendDoc;
  const flags = { cfgChanged: false, tripChanged: false, forceSummary: false, wantPaper: false };

  async function getJSON(url) {
    for (let t = 0; t < 3; t++) {
      try { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(env.fetchTimeout || 15000) }); if (r.ok) return r.json(); if (r.status < 500 && r.status !== 429) throw new Error(`HTTP ${r.status}`); }
      catch (e) { if (t === 2) throw e; }
      await new Promise(r => setTimeout(r, 1500 * (t + 1)));
    }
    throw new Error('재시도 초과');
  }

  // ---------- 시세 ----------
  // GitHub 미국 서버는 api.binance.com이 차단(451)되므로 공식 시세 미러 사용
  const LIMIT = env.candles || 500;
  async function binance(sym, tf) {
    const d = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${LIMIT}`);
    return d.map(k => ({ time: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  }
  async function upbit(sym, tf) {
    const p = { '1h': 'minutes/60', '4h': 'minutes/240', '1d': 'days', '1w': 'weeks' }[tf];
    const d = await getJSON(`https://api.upbit.com/v1/candles/${p}?market=${sym}&count=200`);
    return d.reverse().map(k => ({ time: Date.parse(k.candle_date_time_utc + 'Z') / 1000, open: k.opening_price, high: k.high_price, low: k.low_price, close: k.trade_price, volume: k.candle_acc_trade_volume }));
  }
  async function yahoo(ticker, tf) {
    const [iv, rg] = { '1h': ['60m', '730d'], '4h': ['60m', '730d'], '1d': ['1d', '3y'], '1w': ['1wk', '10y'] }[tf];
    const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${iv}&range=${rg}`);
    const r = j.chart.result[0], q = r.indicators.quote[0];
    const out = r.timestamp.map((t, i) => ({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 })).filter(c => c.close != null && c.open != null).slice(-LIMIT);
    out.name = r.meta.shortName || r.meta.symbol;
    return out;
  }
  async function load(s, tf) {
    if (env.mock) {
      let p = 100, cs = []; for (let i = 0; i < 400; i++) { const o = p; p *= 1 + (Math.sin(i / 30 + s.symbol.length) * 0.005 + (Math.random() - .5) * 0.03); cs.push({ time: 1.7e9 + i * 86400, open: o, high: Math.max(o, p) * 1.01, low: Math.min(o, p) * 0.99, close: p, volume: 1000 }); }
      return cs;
    }
    if (s.src === 'binance') return binance(s.symbol, tf);
    if (s.src === 'upbit') return upbit(s.symbol, tf);
    if (s.src === 'us') return yahoo(s.symbol, tf);
    if (s.src === 'kr') { try { return await yahoo(s.symbol + '.KS', tf); } catch { return yahoo(s.symbol + '.KQ', tf); } }
    if (s.src === 'fx') return yahoo(s.symbol + '=X', tf);
    throw new Error('알 수 없는 src ' + s.src);
  }
  async function yahooPrice(ticker) {
    const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`);
    const m = j.chart.result[0].meta;
    return { price: m.regularMarketPrice, name: m.shortName || m.symbol };
  }
  async function quote(s) {
    if (env.mock) return { price: +(env.mockPrice || 100) };
    if (s.src === 'binance') return { price: +(await getJSON(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${s.symbol}`)).price };
    if (s.src === 'upbit') return { price: (await getJSON(`https://api.upbit.com/v1/ticker?markets=${s.symbol}`))[0].trade_price };
    if (s.src === 'us') return yahooPrice(s.symbol);
    if (s.src === 'kr') { try { return await yahooPrice(s.symbol + '.KS'); } catch { return yahooPrice(s.symbol + '.KQ'); } }
    if (s.src === 'fx') return yahooPrice(s.symbol + '=X');
    throw new Error('알 수 없는 src ' + s.src);
  }
  async function priceCard(s) {
    let q;
    if (env.mock) q = { price: +(env.mockPrice || 100), chg: 1.23 };
    else if (s.src === 'binance') q = await BR.binanceChange(getJSON, s.symbol);
    else if (s.src === 'upbit') { const t = (await getJSON(`https://api.upbit.com/v1/ticker?markets=${s.symbol}`))[0]; q = { price: t.trade_price, chg: t.signed_change_rate * 100 }; }
    else if (s.src === 'kr') { try { q = await BR.yahooChange(getJSON, s.symbol + '.KS'); } catch { q = await BR.yahooChange(getJSON, s.symbol + '.KQ'); } }
    else q = await BR.yahooChange(getJSON, s.symbol + (s.src === 'fx' ? '=X' : ''));
    const name = s.name || s.symbol, c = q.chg;
    const arrow = c == null ? '' : c > 0.05 ? `🔺${c.toFixed(2)}%` : c < -0.05 ? `🔻${Math.abs(c).toFixed(2)}%` : `– ${c.toFixed(2)}%`;
    const my = state._alerts.filter(a => a.src === s.src && a.symbol === s.symbol).map(a => `${a.op === '>=' ? '≥' : '≤'} ${TA.fmt(a.price)}`);
    return `💹 <b>${esc(name)}</b> ${TA.fmt(q.price)} ${arrow}` + (my.length ? `\n⏰ 알림: ${my.join(', ')}` : '') +
      `\n<i>/now ${esc(name)} 분석 · /alert ${esc(name)} 가격 알림</i>`;
  }

  // ---------- 여행 비서 ----------
  const TRIP = createTrip({ getJSON, BR, state, esc, sendDoc, now, tripData: o.tripData, mock: !!env.mock, onChange: () => { flags.tripChanged = true; } });

  // ---------- 모의매매 ----------
  const PAPER = { entry: 30, exit: 0, fee: 0.1, stopAtr: 2, ...(CFG.paper || {}) };
  state._paper ||= { trades: [], positions: {} };
  function paperStep(key, name, cs, tf, out) {
    const P = state._paper, t = Date.now() / 1000, px = cs.at(-1).close;
    // 마감된 봉까지만 신호 계산 (진행 중인 봉 제외 → 실전과 동일 조건)
    const done = cs.at(-1).time + BAR_SEC[tf] > t ? cs.slice(0, -1) : cs;
    const lastBar = done.at(-1).time;
    const pos = P.positions[key], f = PAPER.fee / 100;
    const closePos = why => {
      const ret = (px / pos.entry) * (1 - f) / (1 + f) - 1;
      P.trades.push({ key, name, entry: pos.entry, exit: px, ret, inAt: pos.at, outAt: Math.floor(t), why });
      if (P.trades.length > 500) P.trades.shift();
      delete P.positions[key];
      out.push(`${ret >= 0 ? '💰' : '🩸'} <b>모의 매도</b> ${esc(name)} ${TA.fmt(px)} · ${why} · 수익 <b>${(ret * 100).toFixed(2)}%</b>`);
    };
    if (pos && pos.stop && px <= pos.stop) return closePos('손절');
    if (pos?.bar === lastBar || P.lastBar?.[key] === lastBar) return; // 같은 봉에서는 한 번만 판단 (점수 계산도 생략 → CPU 절약)
    (P.lastBar ||= {})[key] = lastBar;
    const score = TA.scoreSeries(done).at(-1);
    if (score == null) return;
    if (pos && score < PAPER.exit) return closePos(`신호 약화 (점수 ${score})`);
    if (!pos && score >= PAPER.entry) {
      const atrNow = TA.atr(done.map(c => c.high), done.map(c => c.low), done.map(c => c.close)).at(-1);
      P.positions[key] = { name, entry: px, at: Math.floor(t), bar: lastBar, stop: PAPER.stopAtr ? px - PAPER.stopAtr * atrNow : 0 };
      out.push(`🛒 <b>모의 매수</b> ${esc(name)} ${TA.fmt(px)} · 점수 ${score} · 손절 ${TA.fmt(P.positions[key].stop)}`);
    }
  }
  const rowKey = s => `${s.src}:${s.symbol}:${CFG.interval}`;
  function paperReport() {
    const P = state._paper, t = P.trades;
    const wins = t.filter(x => x.ret > 0).length, sum = t.reduce((a, x) => a + x.ret, 0);
    const comp = t.reduce((a, x) => a * (1 + x.ret), 1) - 1;
    const open = Object.entries(P.positions).map(([k, p]) => {
      const cur = state._rows?.[k]?.px, r = cur ? (cur / p.entry - 1) * 100 : null;
      return `• ${esc(p.name)} ${TA.fmt(p.entry)} → ${cur ? TA.fmt(cur) : '?'} ${r == null ? '' : `(<b>${r >= 0 ? '+' : ''}${r.toFixed(2)}%</b>)`}`;
    });
    const recent = t.slice(-5).reverse().map(x => `• ${esc(x.name)} ${(x.ret * 100).toFixed(2)}% (${x.why})`);
    return `🧪 <b>모의매매 성과</b>\n완료 거래 ${t.length}회 · 승률 ${t.length ? Math.round(wins / t.length * 100) : 0}% · 평균 ${t.length ? (sum / t.length * 100).toFixed(2) : 0}% · 누적(복리) ${(comp * 100).toFixed(2)}%\n` +
      `\n<b>보유 중 (${open.length})</b>\n${open.join('\n') || '없음'}` + (recent.length ? `\n\n<b>최근 거래</b>\n${recent.join('\n')}` : '') +
      `\n\n<i>규칙: 점수 ≥${PAPER.entry} 매수, &lt;${PAPER.exit} 매도, ATR×${PAPER.stopAtr} 손절, 수수료 ${PAPER.fee}%</i>`;
  }
  // 관심종목 요약: 종목별 마지막 분석 결과(state._rows)로 만듦 → Workers처럼 나눠서 분석해도 같은 요약
  function summaryMsg(date) {
    const rows = CFG.symbols.map(s => { const r = state._rows?.[rowKey(s)]; return r ? (r.err ? `⚠ ${esc(s.name || s.symbol)} — ${esc(r.err)}` : r.line) : `⏳ ${esc(s.name || s.symbol)} — 분석 대기`; });
    return `📊 <b>관심종목 요약</b> ${date || BR.kstDateLabel()} (${CFG.interval})\n\n${rows.join('\n')}`;
  }

  // ---------- 아침 브리핑 ----------
  CFG.brief ||= { city: '서울' };
  async function cityOf(q) { return q ? BR.geocode(getJSON, q) : CFG.brief.lat ? { ...CFG.brief, name: CFG.brief.city } : BR.geocode(getJSON, CFG.brief.city || '서울'); }
  async function weatherMsg(q) {
    if (env.mock) return `☀️ <b>${esc(q || CFG.brief.city)}</b> 지금 20° (모의)`;
    const city = await cityOf(q);
    return BR.weatherText({ ...city, name: esc(city.name) }, await BR.weather(getJSON, city));
  }
  async function briefMsg() {
    const parts = [`☀️ <b>아침 브리핑</b> ${BR.kstDateLabel()}`];
    try { parts.push(await weatherMsg()); } catch (e) { parts.push(`날씨 ⚠ ${esc(e.message)}`); }
    if (!env.mock) {
      try { parts.push(BR.marketsText(await BR.markets(getJSON))); } catch (e) { parts.push(`시세 ⚠ ${esc(e.message)}`); }
    }
    const extra = [];
    if (state._alerts.length) extra.push(`⏰ 가격 알림 ${state._alerts.length}개 대기`);
    if (state._watches.length) extra.push(`👀 페이지 감시 ${state._watches.length}개`);
    if (extra.length) parts.push(extra.join(' · '));
    const trip = TRIP.briefSection();
    if (trip) parts.splice(1, 0, trip);
    return parts.join('\n\n');
  }

  // ---------- 웹페이지 감시 ----------
  state._watches ||= [];
  const watchName = w => esc(w.label || w.title || w.url.replace(/^https?:\/\//, '').slice(0, 50));
  const watchLine = (w, i) => `${i + 1}. ${watchName(w)}${w.keyword ? ` — 키워드 「${esc(w.keyword)}」 ${w.has == null ? '' : w.has ? '(있음)' : '(없음)'}` : ' — 내용 변경'}${w.fails ? ` ⚠실패 ${w.fails}회` : ''}\n   <a href="${esc(w.url)}">${esc(w.url.slice(0, 60))}</a>`;
  const watchFetcher = env.mockPage ? async () => ({ lines: env.mockPage.split('|'), title: '모의 페이지' }) : u => WT.fetchPage(u);
  async function addWatch(args) {
    const url = args[0];
    if (!url || !/^https?:\/\/[^\s/]+\.[^\s]+/i.test(url)) return '사용법: /watch URL [키워드]\n• 키워드 없이: 페이지 글자가 바뀌면 알림\n• 키워드 있으면: 그 단어가 나타나거나 사라질 때만 알림 (예: /watch https://... 품절)';
    if (state._watches.some(w => w.url === url && (w.keyword || '') === args.slice(1).join(' '))) return '이미 감시 중입니다.';
    if (state._watches.length >= 20) return '페이지 감시는 최대 20개까지입니다.';
    const w = { url, at: Math.floor(Date.now() / 1000), ...(args[1] ? { keyword: args.slice(1).join(' ') } : {}) };
    let page;
    try { page = await watchFetcher(url); } catch (e) { return `❌ 페이지를 못 읽었습니다: ${esc(e.message)}`; }
    if (!page.lines.length) return '❌ 페이지에서 글자를 찾지 못했습니다 (자바스크립트로만 그려지는 페이지는 감시가 어렵습니다).';
    await WT.check(w, async () => page); // 기준 상태 저장
    state._watches.push(w);
    return `👀 감시 시작: <b>${watchName(w)}</b>\n${w.keyword ? `키워드 「${esc(w.keyword)}」 현재 <b>${w.has ? '있음' : '없음'}</b> → 바뀌면 알림` : '내용이 바뀌면 알림'} (10분마다 확인)`;
  }
  // max: 이번에 확인할 최대 개수 (돌아가며), 없으면 전부
  async function checkWatches(max) {
    const out = [], ws = state._watches;
    if (!ws.length) return out;
    let list = ws;
    if (max && ws.length > max) { const st = (state._watchIdx || 0) % ws.length; list = [...ws, ...ws].slice(st, st + max); state._watchIdx = (st + max) % ws.length; }
    for (const w of list) {
      try {
        const r = await WT.check(w, watchFetcher);
        if (!r) continue;
        const head = `👀 <b>${watchName(w)}</b>`, link = `<a href="${esc(w.url)}">페이지 열기</a>`;
        if (r.kind === 'error') out.push(`${head}\n⚠ 여러 번 연속 접속 실패: ${esc(r.msg)}\n${link}`);
        else if (r.kind === 'appeared') out.push(`${head}\n🔔 키워드 「${esc(w.keyword)}」 <b>나타남</b>\n${r.ctx.map(l => `• ${esc(l)}`).join('\n')}\n${link}`);
        else if (r.kind === 'gone') out.push(`${head}\n🔔 키워드 「${esc(w.keyword)}」 <b>사라짐</b>\n${link}`);
        else {
          const show = (xs, sign) => xs.slice(0, 6).map(l => `${sign} ${esc(l)}`).join('\n') + (xs.length > 6 ? `\n… 외 ${xs.length - 6}줄` : '');
          out.push(`${head} <b>변경됨</b>\n${r.added.length ? show(r.added, '➕') : ''}${r.added.length && r.removed.length ? '\n' : ''}${r.removed.length ? show(r.removed, '➖') : ''}\n${link}`);
        }
      } catch (e) { log(`감시 실패 ${w.url}: ${e.message}`); }
    }
    return out;
  }

  // ---------- 가격 알림 ----------
  state._alerts ||= [];
  const parseNum = t => { const n = +String(t).replace(/,/g, ''); return Number.isFinite(n) && n > 0 ? n : null; };
  const alertLine = (x, i) => `${i + 1}. ${esc(x.name)} ${x.op === '>=' ? '≥' : '≤'} <b>${TA.fmt(x.price)}</b>${x.note ? ` — ${esc(x.note)}` : ''}`;
  async function addAlert(args, find) {
    // 형식: /alert 종목 [>|<]가격 [메모]  — 가격은 종목 뒤 첫 숫자
    const isSpec = a => /^[<>]=?[\d,.]+$/.test(a) || /^[\d,.]+$/.test(a) || /^[+-][\d.]+%$/.test(a);
    const pi = args.findIndex((a, i) => i > 0 && isSpec(a) && (a.endsWith('%') || parseNum(a.replace(/^[<>]=?/, ''))));
    if (pi < 1) return '사용법: /alert 종목 가격 [메모]\n예: /alert BTCUSDT 90000, /alert USDKRW &lt;1350 환전, /alert 삼성전자 &gt;70000, /alert NVDA -5%';
    const symQ = args.slice(0, pi).join(' '), spec = args[pi], note = args.slice(pi + 1).join(' ');
    const s = find(symQ) || alias(symQ) || guessSrc(args[0]);
    let q;
    try { q = await quote(s); if (!(q.price > 0)) throw new Error('가격 없음'); } catch (e) { return `❌ ${esc(symQ)} 현재가를 못 가져왔습니다 (${esc(e.message)})`; }
    const pct = spec.endsWith('%') ? +spec.slice(0, -1) : null;
    if (pct != null && (!pct || pct <= -100)) return '퍼센트는 예: +5% 또는 -3%';
    const price = pct != null ? q.price * (1 + pct / 100) : parseNum(spec.replace(/^[<>]=?/, ''));
    const op = pct != null ? (pct > 0 ? '>=' : '<=') : spec.startsWith('>') ? '>=' : spec.startsWith('<') ? '<=' : price >= q.price ? '>=' : '<=';
    if (op === '>=' ? q.price >= price : q.price <= price) return `⚠ 이미 조건을 만족합니다: 현재 ${TA.fmt(q.price)}`;
    if (state._alerts.length >= 50) return '알림은 최대 50개까지입니다. /unalert 로 정리해주세요.';
    const a = { src: s.src, symbol: s.symbol, name: s.name || q.name || s.symbol, op, price, at: Math.floor(Date.now() / 1000), ...(note ? { note } : {}) };
    state._alerts.push(a);
    const gap = (price / q.price - 1) * 100;
    return `⏰ 알림 등록: ${alertLine(a, state._alerts.length - 1).replace(/^\d+\. /, '')}\n현재 ${TA.fmt(q.price)} (${gap >= 0 ? '+' : ''}${gap.toFixed(2)}% 남음)`;
  }
  async function checkAlerts() {
    const out = [], cache = {}, keep = [];
    for (const a of state._alerts) {
      const k = `${a.src}:${a.symbol}`;
      try {
        cache[k] ??= (await quote(a)).price;
        const px = cache[k];
        if (a.op === '>=' ? px >= a.price : px <= a.price) {
          out.push(`🚨 <b>${esc(a.name)}</b> ${a.op === '>=' ? '목표가 돌파' : '목표가 하회'}\n현재 <b>${TA.fmt(px)}</b> (설정 ${a.op === '>=' ? '≥' : '≤'} ${TA.fmt(a.price)})${a.note ? `\n📝 ${esc(a.note)}` : ''}\n<a href="${tvLink(a)}">TradingView에서 보기</a>`);
          continue;
        }
      } catch (e) { log(`알림 시세 실패 ${k}: ${e.message}`); }
      keep.push(a);
    }
    state._alerts = keep;
    return out;
  }

  // ---------- 종목 분석 ----------
  async function analyzeOne(s, tf) {
    const cs = await load(s, tf);
    if (cs.length < 60) throw new Error(`데이터 부족 (${cs.length}봉)`);
    return { cs, a: TA.analyze(cs), tv: TA.tvRating(cs), name: s.name || cs.name || s.symbol };
  }
  // 한 종목 분석 → 신호 변화 알림 문구(있으면), 모의매매, 요약용 행 저장
  async function scanSymbol(s, alerts, trades) {
    const tf = CFG.interval, th = CFG.scoreThreshold, key = rowKey(s);
    try {
      const { cs, a, tv, name } = await analyzeOne(s, tf);
      const px = cs.at(-1).close, prevPx = cs.at(-2).close;
      const cur = { score: a.score, verdict: a.verdict, tv: tv.summary.label, bar: cs.at(-1).time, patterns: a.chartPatterns.filter(p => p.confirmed).map(p => p.name) };
      const prev = state[key], why = [];
      if (prev) {
        if (prev.tv !== cur.tv) why.push(`TV 등급 ${prev.tv} → <b>${cur.tv}</b>`);
        if (prev.score < th && cur.score >= th) why.push(`종합점수 매수 구간 진입 (${prev.score} → <b>${cur.score}</b>)`);
        if (prev.score > -th && cur.score <= -th) why.push(`종합점수 매도 구간 진입 (${prev.score} → <b>${cur.score}</b>)`);
        for (const p of cur.patterns) if (!prev.patterns?.includes(p)) why.push(`패턴 확정: <b>${p}</b>`);
      }
      const head = `${emo(a.score)} <b>${esc(name)}</b> ${TA.fmt(px)} (${((px / prevPx - 1) * 100).toFixed(2)}%)`;
      if (why.length) alerts.push(`${head}\n• ${why.join('\n• ')}\n종합 ${a.score} ${a.verdict} · TV ${tv.summary.label} (MA ${tv.ma.buy}/${tv.ma.neutral}/${tv.ma.sell} · 오실 ${tv.osc.buy}/${tv.osc.neutral}/${tv.osc.sell})\nRSI ${a.ind.rsi.at(-1)?.toFixed(0)} · 손절 ${TA.fmt(a.risk.stopLong)} · 목표 ${TA.fmt(a.risk.targetLong)}\n<a href="${tvLink(s)}">TradingView에서 보기</a>`);
      (state._rows ||= {})[key] = { line: `${emo(a.score)} <b>${esc(name)}</b> ${TA.fmt(px)}  ${a.score > 0 ? '+' : ''}${a.score} ${a.verdict} | TV ${tv.summary.label}`, px, at: Date.now() };
      state[key] = cur;
      paperStep(key, name, cs, tf, trades);
      return true;
    } catch (e) {
      (state._rows ||= {})[key] = { err: e.message.slice(0, 80), at: Date.now() };
      return e.message;
    }
  }

  // ---------- 명령어 ----------
  const find = q => CFG.symbols.find(s => s.symbol.toUpperCase() === q.toUpperCase() || (s.name && s.name === q));
  const modeLine = () => env.mode === 'cloud' ? '☁️ 클라우드 (항상 켜짐, 명령 즉시 응답)' : env.mode === 'realtime' ? `⚡ 실시간 (${ago(env.since)} 시작, 명령 즉시 응답)` : '⏳ 예약 실행 (응답이 늦을 수 있음)';
  const ago = t => { if (!t) return '없음'; const m = Math.round((Date.now() - t) / 60e3); return m < 60 ? `${m}분 전` : `${Math.floor(m / 60)}시간 ${m % 60}분 전`; };
  function helpMsg() {
    const fast = env.mode === 'cloud' || env.mode === 'realtime';
    return `🤖 <b>명령어</b>\n/list — 관심종목 보기\n/add 종목 [이름] — 추가 (예: /add TSLA, /add 035420 네이버, /add SOLUSDT, /add KRW-ETH)\n/remove 종목 — 삭제\n/now 종목 — 지금 바로 분석\n/summary — 전체 요약\n/paper — 모의매매 성과\n/status — 봇 상태\n` +
      `\n✈️ <b>여행 비서</b> (${TRIP.cfg.cities[0][0].slice(5).replace('-', '/')}~ ${esc(TRIP.cfg.name)})\n그냥 <b>점심 18유로</b>, <b>택시 12.5chf</b>, <b>커피 3.2</b>(여행 중) 보내면 지출 기록\n50유로 얼마 — 환산 · /undo — 방금 기록 취소\n/trip 일정 · /today 오늘 · /spent [오늘|어제|전체|도시]\n/check 체크리스트 · /done 번호 · /budget 300만원 · /export 엑셀 · /dash 그래프\n<i>여행 중엔 현지 ${TRIP.cfg.morningHour}시 아침 브리핑, ${TRIP.cfg.eveningHour}시 지출 정리가 자동으로 와요</i>\n` +
      `\n💬 <b>그냥 종목 이름만 보내도</b> 현재가를 알려줘요 (예: 비트코인, 달러, 엔비디아, 삼성전자)\n/tf 1h|4h|1d|1w — 봉 단위 변경\n` +
      `\n⏰ <b>가격 알림</b> (${fast ? '5분' : '30분'}마다 확인, 1회성)\n/alert 종목 가격 [메모] — 예: /alert BTCUSDT 90000, /alert USDKRW &lt;1350 환전\n/alerts — 알림 목록\n/unalert 번호 — 삭제 (/unalert all 전체)\n<i>환율: USDKRW, EURKRW, JPYKRW 등 · 퍼센트: /alert NVDA -5%</i>\n` +
      `\n☀️ <b>브리핑</b> (매일 ${CFG.dailySummaryHourKST}시)\n/brief — 지금 브리핑 받기\n/weather [도시] — 날씨\n/city 도시 — 브리핑 도시 변경 (현재 ${esc(CFG.brief.city)})\n` +
      `\n👀 <b>웹페이지 감시</b>\n/watch URL [키워드] — 변경 또는 키워드 등장/사라짐 알림\n/watches — 감시 목록\n/unwatch 번호 — 삭제\n` +
      `\n<i>${fast ? '⚡ 명령은 바로 처리됩니다.' : '명령은 다음 실행 때 처리됩니다.'}</i>`;
  }
  async function handle(cmd) {
    const [c0, ...args] = cmd.split(/\s+/), c = c0.toLowerCase().replace(/@.*/, '');
    if (TRIP.COMMANDS.includes(c)) { try { return await TRIP.command(c, args); } catch (e) { return `❌ ${esc(e.message)}`; } }
    switch (c) {
      case '/start': case '/help': case '도움말': return helpMsg();
      case '/list': return `📋 <b>관심종목</b> (${CFG.interval})\n` + CFG.symbols.map(s => `• ${esc(s.name || s.symbol)} <code>${s.symbol}</code> [${s.src}]`).join('\n');
      case '/add': {
        if (!args[0]) return '사용법: /add 종목 [이름]';
        if (find(args[0])) return `이미 있습니다: ${esc(args[0])}`;
        const s = { ...guessSrc(args[0]), ...(args[1] ? { name: args.slice(1).join(' ') } : {}) };
        try { await load(s, CFG.interval).then(cs => { if (cs.length < 60) throw new Error(`데이터 부족 (${cs.length}봉)`); }); } catch (e) { return `❌ ${esc(args[0])} 데이터를 못 찾았습니다 (${esc(e.message)})`; }
        CFG.symbols.push(s); flags.cfgChanged = true;
        return `✅ 추가: ${esc(s.name || s.symbol)} [${s.src}]`;
      }
      case '/remove': case '/del': {
        const s = args[0] && find(args.join(' '));
        if (!s) return `목록에 없습니다: ${esc(args.join(' '))}`;
        CFG.symbols = CFG.symbols.filter(x => x !== s); flags.cfgChanged = true;
        return `🗑 삭제: ${esc(s.name || s.symbol)}`;
      }
      case '/tf': {
        if (!BAR_SEC[args[0]]) return '사용법: /tf 1h | 4h | 1d | 1w';
        CFG.interval = args[0]; flags.cfgChanged = true;
        return `⏱ 봉 단위 변경: ${args[0]}`;
      }
      case '/now': {
        if (!args[0]) return '사용법: /now 종목';
        const s = find(args.join(' ')) || guessSrc(args[0]);
        try {
          const { cs, a, tv, name } = await analyzeOne(s, CFG.interval), px = cs.at(-1).close;
          const top = a.signals.slice().sort((x, y) => Math.abs(y.score) - Math.abs(x.score)).slice(0, 5).map(x => `• ${x.name} ${x.score > 0 ? '+' : ''}${x.score} — ${esc(x.note)}`);
          return `${emo(a.score)} <b>${esc(name)}</b> ${TA.fmt(px)}\n종합 <b>${a.score} ${a.verdict}</b> · TV <b>${tv.summary.label}</b>\n\n${top.join('\n')}\n\n지지 ${TA.fmt(a.risk.support)} · 저항 ${TA.fmt(a.risk.resistance)}\n손절 ${TA.fmt(a.risk.stopLong)} · 목표 ${TA.fmt(a.risk.targetLong)}\n<a href="${tvLink(s)}">TradingView에서 보기</a>`;
        } catch (e) { return `❌ ${esc(e.message)}`; }
      }
      case '/alert': return addAlert(args, find);
      case '/brief': return briefMsg();
      case '/weather': try { return await weatherMsg(args.join(' ')); } catch (e) { return `❌ ${esc(e.message)}`; }
      case '/city': {
        if (!args[0]) return `현재 브리핑 도시: ${esc(CFG.brief.city)}\n사용법: /city 파리`;
        try {
          const c = await (env.mock ? { name: args.join(' '), lat: 1, lon: 1, tz: 'auto' } : BR.geocode(getJSON, args.join(' ')));
          CFG.brief = { city: c.name, lat: c.lat, lon: c.lon, tz: c.tz }; flags.cfgChanged = true;
          return `📍 브리핑 도시 변경: <b>${esc(c.name)}</b>\n\n${await weatherMsg().catch(e => '날씨 ⚠ ' + esc(e.message))}`;
        } catch (e) { return `❌ ${esc(e.message)}`; }
      }
      case '/watch': return addWatch(args);
      case '/watches': return state._watches.length ? `👀 <b>페이지 감시</b> (${state._watches.length})\n` + state._watches.map(watchLine).join('\n') : '감시 중인 페이지가 없습니다. /watch URL [키워드]';
      case '/unwatch': {
        if (args[0] === 'all') { const n = state._watches.length; state._watches = []; return `🗑 감시 ${n}개 삭제`; }
        const i = +args[0] - 1;
        if (!state._watches[i]) return '사용법: /unwatch 번호 (번호는 /watches 에서 확인)';
        const [w] = state._watches.splice(i, 1);
        return `🗑 감시 중지: ${watchName(w)}`;
      }
      case '/alerts': return state._alerts.length ? `⏰ <b>가격 알림</b> (${state._alerts.length})\n` + state._alerts.map(alertLine).join('\n') : '등록된 알림이 없습니다. /alert 종목 가격';
      case '/unalert': {
        if (args[0] === 'all') { const n = state._alerts.length; state._alerts = []; return `🗑 알림 ${n}개 삭제`; }
        const i = +args[0] - 1;
        if (!state._alerts[i]) return '사용법: /unalert 번호 (번호는 /alerts 에서 확인)';
        const [a] = state._alerts.splice(i, 1);
        return `🗑 알림 삭제: ${alertLine(a, 0).replace(/^\d+\. /, '')}`;
      }
      case '/dash': case '/dashboard':
        return env.dashUrl ? `📊 <b>나만의 대시보드</b>\n여행 지출 그래프 · 예산 · 일정 · 체크리스트 · 알림 · 관심종목\n\n<a href="${env.dashUrl}">대시보드 열기</a>\n<i>비밀 링크라 다른 사람에게 보내지 마세요</i>` : '📊 대시보드는 Cloudflare 버전에서 쓸 수 있어요 (chart/bot/README.md의 "Cloudflare로 옮기는 법")';
      case '/summary': flags.forceSummary = true; return null;
      case '/paper': flags.wantPaper = true; return null;
      case '/status':
        return `🤖 <b>봇 상태</b>\n모드: ${modeLine()}\n` +
          `마지막 종목 분석: ${ago(state._fullAt)}\n` +
          `관심종목 ${CFG.symbols.length}개 (${CFG.interval}) · 가격 알림 ${state._alerts.length}개 · 페이지 감시 ${state._watches.length}개\n` +
          `아침 브리핑: 매일 ${CFG.dailySummaryHourKST}시 · ${esc(CFG.brief.city)}\n` +
          `모의매매 보유 ${Object.keys(state._paper.positions).length}개 · 완료 ${state._paper.trades.length}회`;
      default: {
        if (c.startsWith('/')) return '모르는 명령어입니다. /help 를 보내보세요.';
        const t = cmd.trim();
        // 여행 지출("점심 18유로") / 환산("50유로 얼마")이 먼저
        try { const tr = await TRIP.text(t); if (tr) return tr; } catch (e) { return `❌ ${esc(e.message)}`; }
        // 슬래시 없이 종목 이름만 보내면 시세 (관심종목, 별칭, 확실한 티커 형식만)
        const s = find(t) || alias(t) || (/^(KRW-[A-Z0-9]+|[A-Z0-9]{2,10}USDT|\d{6}|[A-Z]{1,5}|(USD|EUR|JPY|GBP|CNY|CHF)KRW)$/.test(t) ? guessSrc(t) : null);
        if (!s) return t.length <= 20 ? `🤔 「${esc(t)}」 종목을 모르겠어요. 예: 비트코인, 달러, 삼성전자, NVDA\n명령어는 /help` : null;
        try { return await priceCard(s); } catch (e) { return `❌ ${esc(t)} 시세를 못 가져왔습니다 (${esc(e.message)})`; }
      }
    }
  }

  // 명령 처리 후 요청된 요약/모의매매 (/summary, /paper) — 마지막 분석 결과 기준
  async function afterCommands() {
    if (flags.forceSummary) { await send(summaryMsg()); flags.forceSummary = false; }
    if (flags.wantPaper) { await send(paperReport()); flags.wantPaper = false; }
  }

  /**
   * 주기 작업 한 번
   * @param p.scan     'all' | 종목 인덱스 배열 | null
   * @param p.watches  true(전부) | 숫자(돌아가며 N개) | false
   * @param p.daily    하루 1회 브리핑/요약 판단 여부
   * @param p.forceSummary, p.wantPaper  이번에 요약/모의매매 보고 강제
   */
  async function cycle(p = {}) {
    const st = { hits: 0, pages: 0, analyzed: 0, signals: 0, trades: 0, errors: [] };
    const hits = state._alerts.length ? await checkAlerts() : [];
    st.hits = hits.length;
    if (hits.length) await send(hits.join('\n\n'));
    if (p.watches && state._watches.length) {
      const ph = await checkWatches(p.watches === true ? 0 : p.watches);
      st.pages = ph.length;
      for (const m of ph) await send(m);
    }
    const alerts = [], trades = [];
    const idx = p.scan === 'all' ? CFG.symbols.map((_, i) => i) : p.scan || [];
    for (const i of idx) {
      const s = CFG.symbols[i]; if (!s) continue;
      const r = await scanSymbol(s, alerts, trades);
      if (r === true) st.analyzed++; else st.errors.push(`${s.symbol}: ${r}`);
    }
    if (st.analyzed) state._fullAt = Date.now();
    st.signals = alerts.length; st.trades = trades.length;
    // 여행 중에는 현지 아침 기준 (한국 9시 = 유럽 새벽이므로)
    const tc = TRIP.dailyClock();
    const hour = tc ? tc.hour : (new Date().getUTCHours() + 9) % 24, today = tc ? tc.date : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const daily = p.daily && hour >= (tc ? tc.at : CFG.dailySummaryHourKST) && state._lastSummary !== today; // 건너뛰어져도 그날 첫 실행에서 보냄
    try { for (const m of await TRIP.tick()) await send(m); } catch (e) { log('여행 알림 실패', e.message); }
    if (alerts.length) await send(`🔔 <b>신호 변화</b> (${CFG.interval})\n\n${alerts.join('\n\n')}`);
    if (trades.length) await send(trades.join('\n'));
    if (daily && !tc) { try { await send(await briefMsg()); } catch (e) { log('브리핑 실패', e.message); } }
    if (daily || p.forceSummary) {
      await send(summaryMsg(today));
      if (daily) state._lastSummary = today;
    }
    if (daily || p.wantPaper) await send(paperReport());
    return st;
  }

  async function registerCommands(tg) {
    const ver = MENU.map(m => m[0]).join(',');
    if (!tg || state._menu === ver) return;
    try { await tg('setMyCommands', { commands: MENU.map(([command, description]) => ({ command, description })) }); state._menu = ver; }
    catch (e) { log('명령어 메뉴 등록 실패', e.message); }
  }

  return { handle, cycle, afterCommands, summaryMsg, paperReport, briefMsg, registerCommands, flags, TRIP, getJSON, sendReply: t => send(t), symbolCount: () => CFG.symbols.length };
};
module.exports.MENU = MENU;
module.exports.esc = esc;

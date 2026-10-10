// 관심종목 자동 분석 → 텔레그램 알림
// 환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, (선택) DRY_RUN=1 출력만, MOCK=1 가짜 데이터, FORCE_SUMMARY=1 요약 강제
//          BOT_STATE / BOT_WATCHLIST 파일 경로 변경 (테스트용)
const fs = require('fs'), path = require('path');
const TA = require('../analysis.js');
const BR = require('./brief.js'), WT = require('./watch.js');
const CFG_FILE = process.env.BOT_WATCHLIST || path.join(__dirname, 'watchlist.json');
const CFG = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const STATE_FILE = process.env.BOT_STATE || path.join(__dirname, 'state.json');
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const UA = { 'User-Agent': 'Mozilla/5.0 (chart-bot)' };

async function getJSON(url) {
  for (let t = 0; t < 3; t++) {
    try { const r = await fetch(url, { headers: UA }); if (r.ok) return r.json(); if (r.status < 500 && r.status !== 429) throw new Error(`HTTP ${r.status}`); }
    catch (e) { if (t === 2) throw e; }
    await new Promise(r => setTimeout(r, 2000 * (t + 1)));
  }
  throw new Error('재시도 초과');
}
// GitHub 미국 서버는 api.binance.com이 차단(451)되므로 공식 시세 미러 사용
async function binance(sym, tf) {
  const d = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${tf}&limit=500`);
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
  const out = r.timestamp.map((t, i) => ({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 })).filter(c => c.close != null && c.open != null);
  out.name = r.meta.shortName || r.meta.symbol;
  return out;
}
async function load(s, tf) {
  if (process.env.MOCK) {
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
// 현재가만 가볍게 조회 (가격 알림용, 30분마다)
async function yahooPrice(ticker) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`);
  const m = j.chart.result[0].meta;
  return { price: m.regularMarketPrice, name: m.shortName || m.symbol };
}
async function quote(s) {
  if (process.env.MOCK) return { price: +(process.env.MOCK_PRICE || 100) };
  if (s.src === 'binance') return { price: +(await getJSON(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${s.symbol}`)).price };
  if (s.src === 'upbit') return { price: (await getJSON(`https://api.upbit.com/v1/ticker?markets=${s.symbol}`))[0].trade_price };
  if (s.src === 'us') return yahooPrice(s.symbol);
  if (s.src === 'kr') { try { return await yahooPrice(s.symbol + '.KS'); } catch { return yahooPrice(s.symbol + '.KQ'); } }
  if (s.src === 'fx') return yahooPrice(s.symbol + '=X');
  throw new Error('알 수 없는 src ' + s.src);
}
const tvLink = s => {
  const sym = s.src === 'binance' ? `BINANCE:${s.symbol}` : s.src === 'upbit' ? `UPBIT:${s.symbol.split('-')[1]}${s.symbol.split('-')[0]}` : s.src === 'kr' ? `KRX:${s.symbol}` : s.src === 'fx' ? `FX_IDC:${s.symbol}` : s.symbol;
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}`;
};
const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const emo = score => score >= 15 ? '🟢' : score <= -15 ? '🔴' : '⚪';

// ---------- 텔레그램 ----------
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const live = TOKEN && !process.env.DRY_RUN;
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());
  if (!r.ok) throw new Error(`텔레그램 ${method} 실패: ${r.description}`);
  return r.result;
}
// 새 메시지 수신 (처음 메시지 보낸 사람을 주인으로 등록, 이후 주인 명령만 처리)
async function readUpdates() {
  if (!live) return (process.env.TEST_CMDS || '').split('|').filter(Boolean);
  const me = await tg('getMe');
  console.log(`봇 확인: @${me.username}`);
  const ups = await tg('getUpdates', { offset: state._offset || 0, timeout: 0 });
  console.log(`새 메시지 ${ups.length}개`);
  const cmds = [];
  for (const u of ups) {
    state._offset = u.update_id + 1;
    const m = u.message;
    if (!m?.chat) continue;
    if (process.env.TELEGRAM_CHAT_ID) state._chatId = +process.env.TELEGRAM_CHAT_ID;
    if (!state._chatId) state._chatId = m.chat.id;
    if (m.chat.id === state._chatId && m.text) cmds.push(m.text.trim());
  }
  return cmds;
}
// 텔레그램 입력창 '/' 메뉴에 명령어 목록 등록 (목록이 바뀔 때만)
const MENU = [['help', '도움말'], ['brief', '아침 브리핑 지금 받기'], ['alert', '가격 알림 추가 (종목 가격)'], ['alerts', '가격 알림 목록'], ['unalert', '가격 알림 삭제'],
  ['watch', '웹페이지 감시 추가 (URL [키워드])'], ['watches', '웹페이지 감시 목록'], ['unwatch', '웹페이지 감시 삭제'], ['weather', '날씨 (도시)'], ['city', '브리핑 도시 변경'],
  ['now', '종목 바로 분석'], ['summary', '관심종목 요약'], ['list', '관심종목 목록'], ['add', '관심종목 추가'], ['remove', '관심종목 삭제'], ['paper', '모의매매 성과'], ['tf', '봉 단위 변경']];
async function registerCommands() {
  const ver = MENU.map(m => m[0]).join(',');
  if (!live || state._menu === ver) return;
  try { await tg('setMyCommands', { commands: MENU.map(([command, description]) => ({ command, description })) }); state._menu = ver; }
  catch (e) { console.log('명령어 메뉴 등록 실패', e.message); }
}
async function send(text) {
  if (!live) { console.log('--- 텔레그램 (미전송) ---\n' + text + '\n'); return; }
  if (!state._chatId) throw new Error('채팅 ID 없음. 텔레그램에서 봇에게 아무 메시지나 보낸 뒤 다시 실행하세요.');
  // 텔레그램 메시지 길이 제한 4096자
  for (let i = 0; i < text.length; i += 3900) await tg('sendMessage', { chat_id: state._chatId, text: text.slice(i, i + 3900), parse_mode: 'HTML', disable_web_page_preview: true });
}

// ---------- 모의매매 ----------
const BAR_SEC = { '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
const PAPER = { entry: 30, exit: 0, fee: 0.1, stopAtr: 2, ...(CFG.paper || {}) };
state._paper ||= { trades: [], positions: {} };
function paperStep(key, name, cs, tf, out) {
  const P = state._paper, now = Date.now() / 1000, px = cs.at(-1).close;
  // 마감된 봉까지만 신호 계산 (진행 중인 봉 제외 → 실전과 동일 조건)
  const done = cs.at(-1).time + BAR_SEC[tf] > now ? cs.slice(0, -1) : cs;
  const lastBar = done.at(-1).time, score = TA.scoreSeries(done).at(-1);
  const atrNow = TA.atr(done.map(c => c.high), done.map(c => c.low), done.map(c => c.close)).at(-1);
  const pos = P.positions[key], f = PAPER.fee / 100;
  const closePos = why => {
    const ret = (px / pos.entry) * (1 - f) / (1 + f) - 1;
    P.trades.push({ key, name, entry: pos.entry, exit: px, ret, inAt: pos.at, outAt: Math.floor(now), why });
    if (P.trades.length > 500) P.trades.shift();
    delete P.positions[key];
    out.push(`${ret >= 0 ? '💰' : '🩸'} <b>모의 매도</b> ${esc(name)} ${TA.fmt(px)} · ${why} · 수익 <b>${(ret * 100).toFixed(2)}%</b>`);
  };
  if (pos && pos.stop && px <= pos.stop) return closePos('손절');
  if (pos?.bar === lastBar || P.lastBar?.[key] === lastBar) return; // 같은 봉에서는 한 번만 판단
  (P.lastBar ||= {})[key] = lastBar;
  if (score == null) return;
  if (pos && score < PAPER.exit) return closePos(`신호 약화 (점수 ${score})`);
  if (!pos && score >= PAPER.entry) {
    P.positions[key] = { name, entry: px, at: Math.floor(now), bar: lastBar, stop: PAPER.stopAtr ? px - PAPER.stopAtr * atrNow : 0 };
    out.push(`🛒 <b>모의 매수</b> ${esc(name)} ${TA.fmt(px)} · 점수 ${score} · 손절 ${TA.fmt(P.positions[key].stop)}`);
  }
}
function paperReport(prices) {
  const P = state._paper, t = P.trades;
  const wins = t.filter(x => x.ret > 0).length, sum = t.reduce((a, x) => a + x.ret, 0);
  const comp = t.reduce((a, x) => a * (1 + x.ret), 1) - 1;
  const open = Object.entries(P.positions).map(([k, p]) => {
    const now = prices[k], r = now ? (now / p.entry - 1) * 100 : null;
    return `• ${esc(p.name)} ${TA.fmt(p.entry)} → ${now ? TA.fmt(now) : '?'} ${r == null ? '' : `(<b>${r >= 0 ? '+' : ''}${r.toFixed(2)}%</b>)`}`;
  });
  const recent = t.slice(-5).reverse().map(x => `• ${esc(x.name)} ${(x.ret * 100).toFixed(2)}% (${x.why})`);
  return `🧪 <b>모의매매 성과</b>\n완료 거래 ${t.length}회 · 승률 ${t.length ? Math.round(wins / t.length * 100) : 0}% · 평균 ${t.length ? (sum / t.length * 100).toFixed(2) : 0}% · 누적(복리) ${(comp * 100).toFixed(2)}%\n` +
    `\n<b>보유 중 (${open.length})</b>\n${open.join('\n') || '없음'}` + (recent.length ? `\n\n<b>최근 거래</b>\n${recent.join('\n')}` : '') +
    `\n\n<i>규칙: 점수 ≥${PAPER.entry} 매수, &lt;${PAPER.exit} 매도, ATR×${PAPER.stopAtr} 손절, 수수료 ${PAPER.fee}%</i>`;
}

// ---------- 아침 브리핑 ----------
CFG.brief ||= { city: '서울' };
async function cityOf(q) { return q ? BR.geocode(getJSON, q) : CFG.brief.lat ? { ...CFG.brief, name: CFG.brief.city } : BR.geocode(getJSON, CFG.brief.city || '서울'); }
async function weatherMsg(q) {
  if (process.env.MOCK) return `☀️ <b>${esc(q || CFG.brief.city)}</b> 지금 20° (모의)`;
  const city = await cityOf(q);
  return BR.weatherText({ ...city, name: esc(city.name) }, await BR.weather(getJSON, city));
}
async function briefMsg() {
  const parts = [`☀️ <b>아침 브리핑</b> ${BR.kstDateLabel()}`];
  try { parts.push(await weatherMsg()); } catch (e) { parts.push(`날씨 ⚠ ${esc(e.message)}`); }
  if (!process.env.MOCK) {
    try { parts.push(BR.marketsText(await BR.markets(getJSON))); } catch (e) { parts.push(`시세 ⚠ ${esc(e.message)}`); }
  }
  const extra = [];
  if (state._alerts.length) extra.push(`⏰ 가격 알림 ${state._alerts.length}개 대기`);
  if (state._watches.length) extra.push(`👀 페이지 감시 ${state._watches.length}개`);
  if (extra.length) parts.push(extra.join(' · '));
  return parts.join('\n\n');
}

// ---------- 웹페이지 감시 ----------
state._watches ||= [];
const watchName = w => esc(w.label || w.title || w.url.replace(/^https?:\/\//, '').slice(0, 50));
const watchLine = (w, i) => `${i + 1}. ${watchName(w)}${w.keyword ? ` — 키워드 「${esc(w.keyword)}」 ${w.has == null ? '' : w.has ? '(있음)' : '(없음)'}` : ' — 내용 변경'}${w.fails ? ` ⚠실패 ${w.fails}회` : ''}\n   <a href="${esc(w.url)}">${esc(w.url.slice(0, 60))}</a>`;
const watchFetcher = process.env.MOCK_PAGE ? async () => ({ lines: process.env.MOCK_PAGE.split('|'), title: '모의 페이지' }) : u => WT.fetchPage(u);
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
  return `👀 감시 시작: <b>${watchName(w)}</b>\n${w.keyword ? `키워드 「${esc(w.keyword)}」 현재 <b>${w.has ? '있음' : '없음'}</b> → 바뀌면 알림` : '내용이 바뀌면 알림'} (30분마다 확인)`;
}
async function checkWatches() {
  const out = [];
  for (const w of state._watches) {
    try {
      const r = await WT.check(w, watchFetcher);
      if (!r) continue;
      const head = `👀 <b>${watchName(w)}</b>`, link = `<a href="${esc(w.url)}">페이지 열기</a>`;
      if (r.kind === 'error') out.push(`${head}\n⚠ 3시간째 접속 실패: ${esc(r.msg)}\n${link}`);
      else if (r.kind === 'appeared') out.push(`${head}\n🔔 키워드 「${esc(w.keyword)}」 <b>나타남</b>\n${r.ctx.map(l => `• ${esc(l)}`).join('\n')}\n${link}`);
      else if (r.kind === 'gone') out.push(`${head}\n🔔 키워드 「${esc(w.keyword)}」 <b>사라짐</b>\n${link}`);
      else {
        const show = (xs, sign) => xs.slice(0, 6).map(l => `${sign} ${esc(l)}`).join('\n') + (xs.length > 6 ? `\n… 외 ${xs.length - 6}줄` : '');
        out.push(`${head} <b>변경됨</b>\n${r.added.length ? show(r.added, '➕') : ''}${r.added.length && r.removed.length ? '\n' : ''}${r.removed.length ? show(r.removed, '➖') : ''}\n${link}`);
      }
    } catch (e) { console.log(`감시 실패 ${w.url}: ${e.message}`); }
  }
  return out;
}

// ---------- 명령어 ----------
function guessSrc(sym) {
  const u = sym.toUpperCase();
  if (/^KRW-/.test(u)) return { src: 'upbit', symbol: u };
  if (/^(USD|EUR|JPY|GBP|CNY|CHF|AUD|CAD|HKD)(KRW|USD|EUR|JPY)$/.test(u)) return { src: 'fx', symbol: u };
  if (/(USDT|USDC|BTC)$/.test(u) && u.length > 5) return { src: 'binance', symbol: u };
  if (/^\d{6}$/.test(u)) return { src: 'kr', symbol: u };
  return { src: 'us', symbol: u };
}
let cfgChanged = false;

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
  const s = find(symQ) || guessSrc(args[0]);
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
  const out = [], cache = {};
  const keep = [];
  for (const a of state._alerts) {
    const k = `${a.src}:${a.symbol}`;
    try {
      cache[k] ??= (await quote(a)).price;
      const px = cache[k];
      if (a.op === '>=' ? px >= a.price : px <= a.price) {
        out.push(`🚨 <b>${esc(a.name)}</b> ${a.op === '>=' ? '목표가 돌파' : '목표가 하회'}\n현재 <b>${TA.fmt(px)}</b> (설정 ${a.op === '>=' ? '≥' : '≤'} ${TA.fmt(a.price)})${a.note ? `\n📝 ${esc(a.note)}` : ''}\n<a href="${tvLink(a)}">TradingView에서 보기</a>`);
        continue;
      }
    } catch (e) { console.log(`알림 시세 실패 ${k}: ${e.message}`); }
    keep.push(a);
  }
  state._alerts = keep;
  return out;
}
async function analyzeOne(s, tf) {
  const cs = await load(s, tf);
  if (cs.length < 60) throw new Error(`데이터 부족 (${cs.length}봉)`);
  return { cs, a: TA.analyze(cs), tv: TA.tvRating(cs), name: s.name || cs.name || s.symbol };
}
async function handle(cmd) {
  const [c0, ...args] = cmd.split(/\s+/), c = c0.toLowerCase().replace(/@.*/, '');
  const find = q => CFG.symbols.find(s => s.symbol.toUpperCase() === q.toUpperCase() || (s.name && s.name === q));
  switch (c) {
    case '/start': case '/help': case '도움말':
      return `🤖 <b>명령어</b>\n/list — 관심종목 보기\n/add 종목 [이름] — 추가 (예: /add TSLA, /add 035420 네이버, /add SOLUSDT, /add KRW-ETH)\n/remove 종목 — 삭제\n/now 종목 — 지금 바로 분석\n/summary — 전체 요약\n/paper — 모의매매 성과\n/tf 1h|4h|1d|1w — 봉 단위 변경\n\n⏰ <b>가격 알림</b> (30분마다 확인, 1회성)\n/alert 종목 가격 [메모] — 예: /alert BTCUSDT 90000, /alert USDKRW &lt;1350 환전\n/alerts — 알림 목록\n/unalert 번호 — 삭제 (/unalert all 전체)\n<i>환율: USDKRW, EURKRW, JPYKRW 등 · 퍼센트: /alert NVDA -5%</i>\n\n☀️ <b>브리핑</b> (매일 ${CFG.dailySummaryHourKST}시)\n/brief — 지금 브리핑 받기\n/weather [도시] — 날씨\n/city 도시 — 브리핑 도시 변경 (현재 ${esc(CFG.brief.city)})\n\n👀 <b>웹페이지 감시</b>\n/watch URL [키워드] — 변경 또는 키워드 등장/사라짐 알림\n/watches — 감시 목록\n/unwatch 번호 — 삭제\n\n<i>명령은 최대 30분 안에 처리됩니다.</i>`;
    case '/list': return `📋 <b>관심종목</b> (${CFG.interval})\n` + CFG.symbols.map(s => `• ${esc(s.name || s.symbol)} <code>${s.symbol}</code> [${s.src}]`).join('\n');
    case '/add': {
      if (!args[0]) return '사용법: /add 종목 [이름]';
      if (find(args[0])) return `이미 있습니다: ${esc(args[0])}`;
      const s = { ...guessSrc(args[0]), ...(args[1] ? { name: args.slice(1).join(' ') } : {}) };
      try { await analyzeOne(s, CFG.interval); } catch (e) { return `❌ ${esc(args[0])} 데이터를 못 찾았습니다 (${esc(e.message)})`; }
      CFG.symbols.push(s); cfgChanged = true;
      return `✅ 추가: ${esc(s.name || s.symbol)} [${s.src}]`;
    }
    case '/remove': case '/del': {
      const s = args[0] && find(args.join(' '));
      if (!s) return `목록에 없습니다: ${esc(args.join(' '))}`;
      CFG.symbols = CFG.symbols.filter(x => x !== s); cfgChanged = true;
      return `🗑 삭제: ${esc(s.name || s.symbol)}`;
    }
    case '/tf': {
      if (!BAR_SEC[args[0]]) return '사용법: /tf 1h | 4h | 1d | 1w';
      CFG.interval = args[0]; cfgChanged = true;
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
        const c = await (process.env.MOCK ? { name: args.join(' '), lat: 1, lon: 1, tz: 'auto' } : BR.geocode(getJSON, args.join(' ')));
        CFG.brief = { city: c.name, lat: c.lat, lon: c.lon, tz: c.tz }; cfgChanged = true;
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
    case '/summary': forceSummary = true; return null;
    case '/paper': wantPaper = true; return null;
    default: return c.startsWith('/') ? '모르는 명령어입니다. /help 를 보내보세요.' : null;
  }
}
let forceSummary = !!process.env.FORCE_SUMMARY, wantPaper = false;

(async () => {
  const replies = [];
  for (const cmd of await readUpdates()) { const r = await handle(cmd); if (r) replies.push(r); }
  for (const r of replies) await send(r);
  const hits = state._alerts.length ? await checkAlerts() : [];
  if (hits.length) await send(hits.join('\n\n'));
  const pageHits = state._watches.length ? await checkWatches() : [];
  for (const m of pageHits) await send(m);
  await registerCommands();
  if (cfgChanged) fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2) + '\n');

  // 30분마다 실행되지만 전체 분석은 매시 첫 실행에서만 (명령 응답·요약 요청 시는 즉시)
  const fullScan = new Date().getUTCMinutes() < 30 || forceSummary || wantPaper || process.env.FORCE_SUMMARY || cfgChanged;
  const tf = CFG.interval, th = CFG.scoreThreshold;
  const rows = [], alerts = [], trades = [], errors = [], prices = {};
  if (fullScan) for (const s of CFG.symbols) {
    const key = `${s.src}:${s.symbol}:${tf}`;
    try {
      const { cs, a, tv, name } = await analyzeOne(s, tf);
      const px = cs.at(-1).close, prevPx = cs.at(-2).close;
      prices[key] = px;
      const cur = { score: a.score, verdict: a.verdict, tv: tv.summary.label, bar: cs.at(-1).time, patterns: a.chartPatterns.filter(p => p.confirmed).map(p => p.name) };
      const prev = state[key];
      const why = [];
      if (prev) {
        if (prev.tv !== cur.tv) why.push(`TV 등급 ${prev.tv} → <b>${cur.tv}</b>`);
        if (prev.score < th && cur.score >= th) why.push(`종합점수 매수 구간 진입 (${prev.score} → <b>${cur.score}</b>)`);
        if (prev.score > -th && cur.score <= -th) why.push(`종합점수 매도 구간 진입 (${prev.score} → <b>${cur.score}</b>)`);
        for (const p of cur.patterns) if (!prev.patterns?.includes(p)) why.push(`패턴 확정: <b>${p}</b>`);
      }
      const head = `${emo(a.score)} <b>${esc(name)}</b> ${TA.fmt(px)} (${((px / prevPx - 1) * 100).toFixed(2)}%)`;
      if (why.length) alerts.push(`${head}\n• ${why.join('\n• ')}\n종합 ${a.score} ${a.verdict} · TV ${tv.summary.label} (MA ${tv.ma.buy}/${tv.ma.neutral}/${tv.ma.sell} · 오실 ${tv.osc.buy}/${tv.osc.neutral}/${tv.osc.sell})\nRSI ${a.ind.rsi.at(-1)?.toFixed(0)} · 손절 ${TA.fmt(a.risk.stopLong)} · 목표 ${TA.fmt(a.risk.targetLong)}\n<a href="${tvLink(s)}">TradingView에서 보기</a>`);
      rows.push(`${emo(a.score)} <b>${esc(name)}</b> ${TA.fmt(px)}  ${a.score > 0 ? '+' : ''}${a.score} ${a.verdict} | TV ${tv.summary.label}`);
      state[key] = cur;
      paperStep(key, name, cs, tf, trades);
    } catch (e) { errors.push(`${s.symbol}: ${e.message}`); }
  }
  const kstHour = (new Date().getUTCHours() + 9) % 24, today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = kstHour >= CFG.dailySummaryHourKST && state._lastSummary !== today; // 예약 실행이 건너뛰어져도 그날 첫 실행에서 보냄
  if (alerts.length) await send(`🔔 <b>신호 변화</b> (${tf})\n\n${alerts.join('\n\n')}`);
  if (trades.length) await send(trades.join('\n'));
  if (fullScan && daily) { try { await send(await briefMsg()); } catch (e) { console.log('브리핑 실패', e.message); } }
  if (fullScan && (daily || forceSummary)) {
    await send(`📊 <b>관심종목 요약</b> ${today} (${tf})\n\n${rows.join('\n')}${errors.length ? `\n\n⚠ ${esc(errors.join(', '))}` : ''}`);
    if (daily) state._lastSummary = today;
  }
  if (fullScan && (daily || wantPaper)) await send(paperReport(prices));
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  console.log(`명령 ${replies.length}개, 가격알림 ${hits.length}개(남은 ${state._alerts.length}), 페이지 ${pageHits.length}개(감시 ${state._watches.length}), 분석 ${rows.length}개, 알림 ${alerts.length}개, 모의거래 ${trades.length}개, 오류 ${errors.length}개`, errors);
  if (fullScan && !rows.length && errors.length) process.exit(1);
})();

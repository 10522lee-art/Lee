// 관심종목 자동 분석 → 텔레그램 알림
// 환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, (선택) DRY_RUN=1 출력만, MOCK=1 가짜 데이터, FORCE_SUMMARY=1 요약 강제
const fs = require('fs'), path = require('path');
const TA = require('../analysis.js');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.json'), 'utf8'));
const STATE_FILE = path.join(__dirname, 'state.json');
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
  throw new Error('알 수 없는 src ' + s.src);
}
const tvLink = s => {
  const sym = s.src === 'binance' ? `BINANCE:${s.symbol}` : s.src === 'upbit' ? `UPBIT:${s.symbol.split('-')[1]}${s.symbol.split('-')[0]}` : s.src === 'kr' ? `KRX:${s.symbol}` : s.symbol;
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}`;
};
const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const emo = score => score >= 15 ? '🟢' : score <= -15 ? '🔴' : '⚪';

// 채팅 ID가 없으면 봇에게 마지막으로 메시지를 보낸 사람을 자동으로 찾아 저장
async function chatId() {
  if (process.env.TELEGRAM_CHAT_ID) return process.env.TELEGRAM_CHAT_ID;
  const T = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN.trim()}`;
  const me = await fetch(`${T}/getMe`).then(r => r.json());
  if (!me.ok) throw new Error(`토큰이 올바르지 않습니다 (${me.description}). BotFather에서 토큰을 다시 복사해 등록하세요.`);
  console.log(`봇 확인: @${me.result.username}`);
  const r = await fetch(`${T}/getUpdates`).then(r => r.json());
  console.log(`받은 메시지 ${r.result?.length ?? 0}개`, r.ok ? '' : r.description);
  const found = (r.result || []).map(u => (u.message || u.my_chat_member || u.channel_post)?.chat?.id).filter(Boolean).pop();
  if (found) state._chatId = found;
  if (!state._chatId) throw new Error(`채팅 ID를 찾지 못했습니다. 텔레그램에서 @${me.result.username} 에게 메시지를 보낸 뒤 다시 실행하세요.`);
  return state._chatId;
}
async function send(text) {
  if (process.env.DRY_RUN || !process.env.TELEGRAM_BOT_TOKEN) { console.log('--- 텔레그램 (미전송) ---\n' + text + '\n'); return; }
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN.trim()}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: await chatId(), text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error('텔레그램 전송 실패: ' + (await r.text()));
}

(async () => {
  const tf = CFG.interval, th = CFG.scoreThreshold;
  const rows = [], alerts = [], errors = [];
  for (const s of CFG.symbols) {
    const key = `${s.src}:${s.symbol}:${tf}`;
    try {
      const cs = await load(s, tf);
      if (cs.length < 60) throw new Error(`데이터 부족 (${cs.length}봉)`);
      const a = TA.analyze(cs), tv = TA.tvRating(cs), px = cs[cs.length - 1].close, prevPx = cs[cs.length - 2].close;
      const name = s.name || cs.name || s.symbol;
      const cur = { score: a.score, verdict: a.verdict, tv: tv.summary.label, bar: cs[cs.length - 1].time, patterns: a.chartPatterns.filter(p => p.confirmed).map(p => p.name) };
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
    } catch (e) { errors.push(`${s.symbol}: ${e.message}`); }
  }
  const kstHour = (new Date().getUTCHours() + 9) % 24, today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const doSummary = process.env.FORCE_SUMMARY || (kstHour === CFG.dailySummaryHourKST && state._lastSummary !== today);
  if (alerts.length) await send(`🔔 <b>신호 변화</b> (${tf})\n\n${alerts.join('\n\n')}`);
  if (doSummary) { await send(`📊 <b>관심종목 요약</b> ${today} (${tf})\n\n${rows.join('\n')}${errors.length ? `\n\n⚠ ${esc(errors.join(', '))}` : ''}`); state._lastSummary = today; }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  console.log(`분석 ${rows.length}개, 알림 ${alerts.length}개, 오류 ${errors.length}개`, errors);
  if (!rows.length && errors.length) process.exit(1);
})();

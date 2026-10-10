// Node 실행기 (GitHub Actions / 로컬): 파일에서 읽고 core.js로 처리한 뒤 파일에 저장
// Cloudflare Workers 버전은 worker/src/index.js — 같은 core.js를 씀
// 환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, (선택) DRY_RUN=1 출력만, MOCK=1 가짜 데이터, FORCE_SUMMARY=1 요약 강제
//          BOT_STATE / BOT_WATCHLIST / TRIP_DATA 파일 경로 변경 (테스트용)
//          SCAN_MODE=full|light  전체 분석 여부 강제 (daemon.js가 사용), 없으면 매시 첫 30분에 전체 분석
const fs = require('fs'), path = require('path');
const createBot = require('./core.js'), SEC = require('./secure.js');
const E = process.env;
const CFG_FILE = E.BOT_WATCHLIST || path.join(__dirname, 'watchlist.json');
const STATE_FILE = E.BOT_STATE || path.join(__dirname, 'state.json');
const TOKEN = (E.TELEGRAM_BOT_TOKEN || '').trim();
const TRIP_FILE = E.TRIP_DATA || (TOKEN ? path.join(__dirname, 'trip-data.enc') : null); // 토큰 없으면 메모리에만
const live = TOKEN && !E.DRY_RUN;
const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const tripData = SEC.loadTrip(TRIP_FILE, TOKEN);

// ---------- 텔레그램 ----------
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());
  if (!r.ok) throw new Error(`텔레그램 ${method} 실패: ${r.description}`);
  return r.result;
}
async function send(text) {
  if (!live) { console.log('--- 텔레그램 (미전송) ---\n' + text + '\n'); return; }
  if (!state._chatId) throw new Error('채팅 ID 없음. 텔레그램에서 봇에게 아무 메시지나 보낸 뒤 다시 실행하세요.');
  for (let i = 0; i < text.length; i += 3900) await tg('sendMessage', { chat_id: state._chatId, text: text.slice(i, i + 3900), parse_mode: 'HTML', disable_web_page_preview: true }); // 4096자 제한
}
async function sendDoc(name, content, caption) {
  if (!live) { console.log(`--- 텔레그램 파일 ${name} (미전송) ---\n${caption}\n${content.slice(0, 600)}\n`); return; }
  const fd = new FormData();
  fd.append('chat_id', String(state._chatId)); fd.append('caption', caption); fd.append('parse_mode', 'HTML');
  fd.append('document', new Blob(['﻿' + content], { type: 'text/csv' }), name); // BOM: 엑셀 한글 깨짐 방지
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: 'POST', body: fd }).then(r => r.json());
  if (!r.ok) throw new Error(`텔레그램 sendDocument 실패: ${r.description}`);
}
// 새 메시지 수신 (처음 메시지 보낸 사람을 주인으로 등록, 이후 주인 명령만 처리)
async function readUpdates() {
  if (!live) return (E.TEST_CMDS || '').split('|').filter(Boolean);
  const me = await tg('getMe');
  console.log(`봇 확인: @${me.username}`);
  const ups = await tg('getUpdates', { offset: state._offset || 0, timeout: 0 });
  console.log(`새 메시지 ${ups.length}개`);
  const cmds = [];
  for (const u of ups) {
    state._offset = u.update_id + 1;
    const m = u.message;
    if (!m?.chat) continue;
    if (E.TELEGRAM_CHAT_ID) state._chatId = +E.TELEGRAM_CHAT_ID;
    if (!state._chatId) state._chatId = m.chat.id;
    if (m.chat.id === state._chatId && m.text) cmds.push(m.text.trim());
  }
  return cmds;
}

const bot = createBot({
  cfg, state, tripData, send, sendDoc,
  env: { mock: !!E.MOCK, mockPrice: E.MOCK_PRICE, mockPage: E.MOCK_PAGE, tripNow: E.TRIP_NOW, mode: E.DAEMON_SINCE ? 'realtime' : 'scheduled', since: +E.DAEMON_SINCE || 0 },
});

(async () => {
  const replies = [];
  for (const cmd of await readUpdates()) { const r = await bot.handle(cmd); if (r) replies.push(r); }
  for (const r of replies) await send(r);
  const F = bot.flags;
  // 30분마다 실행되지만 전체 분석은 매시 첫 실행에서만 (명령 응답·요약 요청 시는 즉시)
  const mode = E.SCAN_MODE;
  const fullScan = mode === 'full' || (!mode && new Date().getUTCMinutes() < 30) || F.forceSummary || F.wantPaper || !!E.FORCE_SUMMARY || F.cfgChanged;
  // 실시간 모드에서는 daemon.js가 10분마다 RUN_WATCHES=1로 지정 (명령마다 페이지를 읽지 않도록)
  const watches = !mode || !!E.RUN_WATCHES || !!E.MOCK_PAGE;
  const st = await bot.cycle({ scan: fullScan ? 'all' : null, watches, daily: fullScan, forceSummary: F.forceSummary || !!E.FORCE_SUMMARY, wantPaper: F.wantPaper });
  if (live) await bot.registerCommands(tg);
  if (F.cfgChanged) fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  if (F.tripChanged) SEC.saveTrip(TRIP_FILE, TOKEN, tripData);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  console.log(`명령 ${replies.length}개, 가격알림 ${st.hits}개(남은 ${state._alerts.length}), 페이지 ${st.pages}개(감시 ${state._watches.length}), 분석 ${st.analyzed}개, 알림 ${st.signals}개, 모의거래 ${st.trades}개, 오류 ${st.errors.length}개`, st.errors);
  if (fullScan && !st.analyzed && st.errors.length) process.exit(1);
})();

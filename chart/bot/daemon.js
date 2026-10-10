// 실시간 모드: GitHub Actions 한 번 실행 안에서 약 6시간 동안 상주
// - 텔레그램 롱폴링으로 새 메시지가 오면 바로 scan.js 실행 (몇 초 안에 응답)
// - 5분마다 가격 알림, 10분마다 페이지 감시 (scan.js light), 매시 7분 전체 분석 (scan.js full)
// - 상태 파일은 바뀌었을 때 10분마다 커밋, 끝날 때 한 번 더
// 끝나면 워크플로의 다음 단계가 자기 자신을 다시 실행시켜 24시간 이어짐
// 환경변수: TELEGRAM_BOT_TOKEN, DAEMON_MINUTES(기본 340), NO_GIT=1(커밋 안 함), 그 외는 scan.js와 동일
const fs = require('fs'), path = require('path'), { spawnSync, execSync } = require('child_process');
const STATE_FILE = process.env.BOT_STATE || path.join(__dirname, 'state.json');
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const live = TOKEN && !process.env.DRY_RUN;
const START = Date.now(), END = START + (+process.env.DAEMON_MINUTES || 340) * 60e3;
const LIGHT_MS = 5 * 60e3, COMMIT_MS = 10 * 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };

let runs = 0, firstRun = true, nextWatch = 0;
function scan(mode, why) {
  const t = Date.now();
  const env = { ...process.env, SCAN_MODE: mode, DAEMON_SINCE: String(START) };
  if (t >= nextWatch) { env.RUN_WATCHES = '1'; nextWatch = t + 10 * 60e3 - 30e3; }
  if (!firstRun) delete env.FORCE_SUMMARY; // 수동 실행의 요약 요청은 첫 실행에만
  firstRun = false;
  const r = spawnSync(process.execPath, [path.join(__dirname, 'scan.js')], { env, encoding: 'utf8', timeout: 5 * 60e3 });
  runs++;
  const last = (r.stdout || '').trim().split('\n').filter(l => /^명령 /.test(l)).at(-1) || '';
  log(`[${mode}/${why}] ${((Date.now() - t) / 1000).toFixed(1)}초 종료코드 ${r.status} ${last}`);
  if (r.status !== 0) console.log((r.stderr || r.stdout || '').slice(-1500));
}

function commit(final) {
  if (process.env.NO_GIT || process.env.DRY_RUN) return;
  try {
    const files = ['chart/bot/state.json', 'chart/bot/watchlist.json', 'chart/bot/trip-data.enc'].filter(f => fs.existsSync(f));
    execSync(`git add ${files.join(' ')}`, { stdio: 'pipe' });
    try { execSync('git diff --cached --quiet', { stdio: 'pipe' }); return; } catch { } // 변경 있음
    execSync('git commit -q -m "chart-bot: update state [skip ci]"', { stdio: 'pipe' });
    for (let t = 0; t < 3; t++) {
      try { execSync('git pull --rebase -q && git push -q', { stdio: 'pipe' }); log(`상태 커밋${final ? ' (마지막)' : ''}`); return; }
      catch (e) { try { execSync('git rebase --abort', { stdio: 'pipe' }); } catch { } log('푸시 실패, 재시도', String(e.stderr || e.message).slice(0, 300)); }
    }
  } catch (e) { log('커밋 실패', String(e.stderr || e.message).slice(0, 300)); }
}

// 텔레그램: 새 메시지가 올 때까지 최대 25초 대기 (확인 처리는 scan.js가 offset 저장으로 함)
async function waitForMessages(maxSec) {
  if (!live) { await sleep(Math.min(maxSec, 5) * 1000); return []; }
  const offset = readState()._offset || 0;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset, timeout: Math.max(1, Math.floor(maxSec)), allowed_updates: ['message'] }),
      signal: AbortSignal.timeout((maxSec + 15) * 1000),
    }).then(r => r.json());
    if (!r.ok) { log('getUpdates 실패', r.description); await sleep(10000); return []; }
    return r.result;
  } catch (e) { log('롱폴링 오류', e.message); await sleep(5000); return []; }
}
async function typing() {
  const chat = readState()._chatId;
  if (!live || !chat) return;
  try { await fetch(`https://api.telegram.org/bot${TOKEN}/sendChatAction`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, action: 'typing' }) }); } catch { }
}

// 다음 전체 분석 시각: 매시 7분 (기존 예약 시간과 같게)
function nextFullAt(now) {
  const d = new Date(now); d.setUTCMinutes(7, 0, 0);
  if (d.getTime() <= now) d.setUTCHours(d.getUTCHours() + 1);
  return d.getTime();
}

(async () => {
  log(`실시간 모드 시작 — ${((END - START) / 60e3).toFixed(0)}분 동안 실행`);
  scan('full', '시작');
  commit();
  let nextLight = Date.now() + LIGHT_MS, nextFull = nextFullAt(Date.now()), nextCommit = Date.now() + COMMIT_MS;
  while (Date.now() < END - 20e3) {
    const now = Date.now();
    if (now >= nextFull) { scan('full', '매시'); nextFull = nextFullAt(Date.now()); nextLight = Date.now() + LIGHT_MS; }
    else if (now >= nextLight) { scan('light', '5분'); nextLight = Date.now() + LIGHT_MS; }
    if (Date.now() >= nextCommit) { commit(); nextCommit = Date.now() + COMMIT_MS; }
    const wait = Math.min(25, (Math.min(nextLight, nextFull, END - 20e3) - Date.now()) / 1000);
    if (wait <= 0) continue;
    const ups = await waitForMessages(wait);
    if (ups.length) {
      const hasText = ups.some(u => u.message?.text);
      if (hasText) await typing();
      scan('light', `메시지 ${ups.length}개`);
      // scan.js가 죽어서 offset을 못 넘겼으면 같은 메시지를 무한 반복하지 않도록 직접 넘김
      const maxId = Math.max(...ups.map(u => u.update_id));
      const st = readState();
      if ((st._offset || 0) <= maxId) { st._offset = maxId + 1; fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 1)); log('offset 강제 이동', maxId + 1); }
      if (hasText) commit(); // 명령으로 바뀐 설정은 바로 저장
    }
  }
  commit(true);
  log(`종료 — scan.js ${runs}회 실행`);
})().catch(e => { console.error(e); commit(true); process.exit(1); });

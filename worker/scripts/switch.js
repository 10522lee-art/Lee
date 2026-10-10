// 배포 직후 실행 (worker-deploy.yml): 옛 GitHub Actions 봇 → Cloudflare Workers 봇으로 갈아타기
// 1) 워커가 살아있는지 확인  2) 처음이면: 옛 봇 끄기 → 마지막 상태 받아서 이사  3) 텔레그램 웹훅 연결  4) 처음이면 안내 메시지
// 환경변수: WORKER_URL, TELEGRAM_BOT_TOKEN, GH_TOKEN(gh CLI), GITHUB_REPOSITORY
const { execSync } = require('child_process');
const fs = require('fs'), path = require('path');
const SEC = require('../../chart/bot/secure.js');

const URL = process.env.WORKER_URL.replace(/\/$/, ''), TOKEN = process.env.TELEGRAM_BOT_TOKEN.trim();
const ADMIN = SEC.derive(TOKEN, 'admin'), WH = SEC.derive(TOKEN, 'wh').slice(0, 48);
const ROOT = path.join(__dirname, '..', '..'), BOT = path.join(ROOT, 'chart', 'bot');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = cmd => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const api = async (p, opt = {}) => {
  const r = await fetch(URL + p, { ...opt, headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', ...(opt.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status} ${t.slice(0, 300)}`);
  return JSON.parse(t);
};
const tg = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  if (!r.ok) throw new Error(`텔레그램 ${method}: ${r.description}`);
  return r.result;
};

(async () => {
  // 1) 시크릿이 반영될 때까지 잠깐 걸릴 수 있음
  let ex;
  for (let t = 0; t < 12; t++) {
    try { ex = await api('/api/export'); break; } catch (e) { console.log('워커 대기 중…', e.message); await sleep(5000); }
  }
  if (!ex) throw new Error('워커 관리 API에 접속 실패');
  const first = !ex.state;
  console.log(first ? '처음 배포 → 이사 진행' : '이미 이사함 → 웹훅만 다시 확인');

  if (first) {
    // 2) 옛 봇 끄기: 예약 실행 중지 + 돌고 있는 실행 취소 (취소돼도 마지막 '상태 저장' 단계는 돌아서 커밋됨)
    try { console.log(sh('gh workflow disable chart-alert.yml')); } catch (e) { console.log('옛 워크플로 끄기 실패(이미 꺼짐?)', e.stderr || e.message); }
    for (let t = 0; t < 30; t++) {
      const runs = JSON.parse(sh('gh run list --workflow chart-alert.yml --limit 20 --json databaseId,status'));
      const active = runs.filter(r => r.status !== 'completed');
      if (!active.length) break;
      for (const r of active) { try { sh(`gh run cancel ${r.databaseId}`); } catch { } }
      console.log(`옛 봇 실행 ${active.length}개 종료 기다리는 중…`);
      await sleep(10000);
    }
    sh('git pull -q --ff-only || git pull -q --rebase');
    const cfg = JSON.parse(fs.readFileSync(path.join(BOT, 'watchlist.json'), 'utf8'));
    const state = fs.existsSync(path.join(BOT, 'state.json')) ? JSON.parse(fs.readFileSync(path.join(BOT, 'state.json'), 'utf8')) : {};
    const trip = SEC.loadTrip(path.join(BOT, 'trip-data.enc'), TOKEN);
    const r = await api('/api/import', { method: 'POST', body: JSON.stringify({ cfg, state, trip }) });
    console.log('이사 결과', r);
  }

  // 3) 웹훅 연결 (이후 getUpdates 방식은 동작하지 않음 — 옛 봇을 다시 쓰려면 deleteWebhook)
  await tg('setWebhook', { url: `${URL}/tg`, secret_token: WH, allowed_updates: ['message', 'edited_message'], max_connections: 5 });
  const info = await tg('getWebhookInfo', {});
  console.log('웹훅', { url: info.url, pending: info.pending_update_count, lastError: info.last_error_message || null });
  if (info.url !== `${URL}/tg`) throw new Error('웹훅 설정이 반영되지 않음');

  // 4) 처음이면 안내 + cron 한 번 돌려서 바로 확인
  const tick = await api('/api/tick');
  console.log('첫 tick', tick);
  const h = await api('/api/export');
  if (first && h.state?._chatId) {
    await tg('sendMessage', {
      chat_id: h.state._chatId, parse_mode: 'HTML',
      text: '☁️ <b>봇이 Cloudflare로 이사했어요</b>\n\n이제 항상 켜져 있고 메시지에 바로 답해요. 가격 알림·여행 기록·감시 페이지는 그대로 옮겨졌어요.\n\n/status 로 확인해보세요.',
    });
  }
  console.log('완료 ✅');
})().catch(e => { console.error('❌', e.message); process.exit(1); });

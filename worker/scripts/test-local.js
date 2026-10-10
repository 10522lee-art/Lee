// Workers 버전 통합 테스트: 실제 Cloudflare 런타임(workerd)을 로컬로 띄워 웹훅·cron·이사·인증을 확인
// 사용: cd worker && node scripts/test-local.js   (텔레그램 전송 없음: BOT_DRY, 가짜 시세: BOT_MOCK)
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const SEC = require('../../chart/bot/secure.js');
const PORT = 8790 + Math.floor(Math.random() * 100), W = `http://127.0.0.1:${PORT}`, TOK = 'test-token';
const WH = SEC.derive(TOK, 'wh').slice(0, 48), AD = SEC.derive(TOK, 'admin');
const dir = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? '✅' : '❌'} ${name}${!c && extra ? ' — ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.writeFileSync(path.join(dir, '.dev.vars'), `TELEGRAM_BOT_TOKEN=${TOK}\nBOT_DRY=1\nBOT_MOCK=1\n`);
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'wrangler-'));
const dev = spawn(process.execPath, [path.join(dir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'dev', '--test-scheduled', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist], { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
let logs = '';
dev.stdout.on('data', d => logs += d); dev.stderr.on('data', d => logs += d);

const msg = (text, chat = 42) => fetch(`${W}/tg`, { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': WH, 'content-type': 'application/json' }, body: JSON.stringify({ update_id: 1, message: { chat: { id: chat }, text } }) });
const adm = (p, body) => fetch(W + p, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${AD}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.json());
const outbox = async () => (await adm('/api/export')).state?._outbox || [];

(async () => {
  for (let i = 0; i < 90; i++) { try { if ((await fetch(W)).ok) break; } catch { } await sleep(1000); }
  ok((await fetch(W).then(r => r.text()).catch(() => '')).includes('lee-bot'), '워커 실행', logs.slice(-500));
  ok((await fetch(`${W}/tg`, { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'nope' }, body: '{}' })).status === 403, '웹훅 시크릿 검사');
  ok((await fetch(`${W}/api/export`)).status === 401, '관리 API 인증');

  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '../chart/bot/watchlist.json'), 'utf8'));
  const imp = await adm('/api/import', { cfg, state: { _chatId: 42, _offset: 99, _alerts: [{ src: 'binance', symbol: 'BTCUSDT', name: '비트코인', op: '<=', price: 50, at: 1 }], _watches: [] }, trip: { spends: [{ id: 'a', at: Date.now(), date: '2026-10-10', city: '출발 전', amount: 30000, cur: 'KRW', rate: 1, krw: 30000, cat: '교통', text: '공항버스', pay: '카드' }] } });
  ok(imp.imported && imp.alerts === 1 && imp.spends === 1, '데이터 이사', JSON.stringify(imp));
  ok(!(await adm('/api/import', { state: {} })).imported, '이사 중복 방지');
  ok((await adm('/api/export')).state._offset === undefined, '이사 시 getUpdates offset 제거');

  for (const t of ['/status', '달러', '/alert 비트코인 -5% 저점', '점심 18유로', '/spent', '/trip', '/alerts']) await msg(t);
  await msg('/alerts', 999); // 주인 아님
  await sleep(500);
  let ob = await outbox();
  ok(ob.length === 7, '웹훅 메시지 7개 처리 (주인 아닌 사람 무시)', `${ob.length}개`);
  ok(/☁️ 클라우드/.test(ob[0]) && /💹 <b>달러/.test(ob[1]) && /알림 등록: 비트코인 ≤ <b>95/.test(ob[2]) && /🍽️ <b>점심<\/b> €18.00/.test(ob[3]) && /공항버스/.test(ob[4]) && /D-\d+/.test(ob[5]) && /2\. 비트코인/.test(ob[6]), '명령 응답 내용');

  // 동시에 여러 메시지 → Durable Object가 순서대로 처리해서 하나도 안 잃어야 함
  await Promise.all(['택시 10유로', '커피 3유로', '젤라또 4유로', '기념품 20유로'].map(t => msg(t)));
  await sleep(500);
  const ex = await adm('/api/export');
  ok(ex.trip.spends.length === 6, '동시 메시지 4개 모두 저장', `${ex.trip.spends.length}건`);

  for (let i = 0; i < 4; i++) await fetch(`${W}/__scheduled?cron=*/5+*+*+*+*`);
  await sleep(1000);
  const s = (await adm('/api/export')).state;
  ok(s._tickNo === 4 && s._scanIdx === 1 && Object.keys(s._rows || {}).length === 2, 'cron: 종목 하나씩 돌아가며 분석', JSON.stringify({ tick: s._tickNo, idx: s._scanIdx, rows: Object.keys(s._rows || {}) }));
  const h = await fetch(`${W}/health`).then(r => r.json());
  ok(h.ok && h.owner && h.lastTick, '상태 확인 /health');
  await msg('/summary'); await sleep(300);
  ob = await outbox();
  ok(/관심종목 요약/.test(ob.at(-1)) && /분석 대기/.test(ob.at(-1)) && !/BTCUSDT — 분석 대기/.test(ob.at(-1)), '요약: 분석된 종목 + 대기 종목 표시');

  // 대시보드: /dash 로 비밀 링크 → 열면 HTML, 틀린 키는 404
  await msg('/dash'); await sleep(300);
  const link = ((await outbox()).at(-1).match(/href="([^"]+\/d\/[0-9a-f]{32})"/) || [])[1];
  ok(link && link.startsWith(W), '/dash 비밀 링크', String((await outbox()).at(-1)).slice(0, 200));
  const page = link ? await fetch(link).then(async r => ({ status: r.status, ct: r.headers.get('content-type'), text: await r.text() })) : {};
  ok(page.status === 200 && /text\/html/.test(page.ct) && /대시보드/.test(page.text) && /공항버스/.test(page.text) && /기념품/.test(page.text) && /비트코인/.test(page.text), '대시보드 페이지 내용');
  ok((await fetch(`${W}/d/${'0'.repeat(32)}`)).status === 404, '틀린 대시보드 키 404');

  console.log(`\n${pass} 통과, ${fail} 실패`);
  dev.kill('SIGINT'); await sleep(500); dev.kill('SIGKILL');
  fs.rmSync(path.join(dir, '.dev.vars'), { force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log(logs.slice(-2000)); dev.kill('SIGKILL'); process.exit(1); });

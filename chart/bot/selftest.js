// 봇 자체 테스트: node chart/bot/selftest.js        → 오프라인 테스트
//                LIVE=1 node chart/bot/selftest.js → 실제 시세/날씨/웹 API까지 확인
// 실제 state.json/watchlist.json은 건드리지 않음 (임시 파일 사용), 텔레그램 전송 없음
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const WT = require('./watch.js'), BR = require('./brief.js');
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botst-'));
const ST = path.join(tmp, 'state.json'), WL = path.join(tmp, 'watchlist.json');
fs.writeFileSync(WL, JSON.stringify({ interval: '1d', scoreThreshold: 30, dailySummaryHourKST: 9, symbols: [{ src: 'binance', symbol: 'BTCUSDT' }, { src: 'kr', symbol: '005930', name: '삼성전자' }] }));
fs.writeFileSync(ST, JSON.stringify({ _lastSummary: '2099-01-01' }));
function bot(cmds, env = {}) {
  return execFileSync(process.execPath, [path.join(__dirname, 'scan.js')], {
    env: { ...process.env, TELEGRAM_BOT_TOKEN: '', DRY_RUN: '1', MOCK: '1', BOT_STATE: ST, BOT_WATCHLIST: WL, TEST_CMDS: cmds.join('|'), ...env }, encoding: 'utf8',
  });
}
const state = () => JSON.parse(fs.readFileSync(ST, 'utf8'));

// ---------- watch.js 단위 ----------
const lines = WT.htmlToLines('<html><head><title>x</title><script>var a=1</script></head><body><h1>상품 &amp; 재고</h1><p>가격 <b>12,000</b>원</p><div>품절</div><div>품절</div><!-- c --><style>.a{}</style></body></html>');
ok(JSON.stringify(lines) === JSON.stringify(['상품 & 재고', '가격 12,000 원', '품절']), 'HTML → 텍스트 줄', JSON.stringify(lines));
ok(WT.decode('&#44032;&#xAC00;&nbsp;&lt;') === '가가 <', '엔티티 디코딩');
const d = WT.diff(['a', 'b', 'c'], ['a', 'c', 'd']);
ok(d.added.join() === 'd' && d.removed.join() === 'b', 'diff 추가/삭제');
(async () => {
  let page = { lines: ['가격 100', '재고 있음'], title: 't' };
  const f = async () => page;
  const w = { url: 'https://x.y' };
  ok(await WT.check(w, f) === null, '첫 확인은 기준만 저장');
  ok(await WT.check(w, f) === null, '변화 없으면 알림 없음');
  page = { lines: ['가격 90', '재고 있음'] };
  const r = await WT.check(w, f);
  ok(r?.kind === 'changed' && r.added[0] === '가격 90' && r.removed[0] === '가격 100', '내용 변경 감지');
  const k = { url: 'https://x.y', keyword: '품절' };
  page = { lines: ['상품', '품절'] }; ok(await WT.check(k, f) === null && k.has === true, '키워드 기준 저장');
  page = { lines: ['상품', '구매하기'] }; ok((await WT.check(k, f))?.kind === 'gone', '키워드 사라짐 감지');
  page = { lines: ['상품', '일시품절'] }; ok((await WT.check(k, f))?.kind === 'appeared', '키워드 나타남 감지');
  const e = { url: 'https://x.y', hash: 'h' }; let er;
  for (let i = 0; i < 6; i++) er = await WT.check(e, async () => { throw new Error('down'); });
  ok(er?.kind === 'error' && e.hash === 'h', '6회 연속 실패 시 1회 알림');

  // ---------- brief.js 단위 ----------
  const wt = BR.weatherText({ name: '파리' }, { now: { temp: 12.4, feels: 10, code: 61 }, today: { code: 63, min: 8, max: 19, rain: 70, uv: 3 }, tomorrow: { code: 0, min: 7, max: 16, rain: 0 } });
  ok(/파리/.test(wt) && /우산/.test(wt) && /일교차/.test(wt) && /12°/.test(wt), '날씨 문구', wt.replace(/\n/g, ' / '));
  const mt = BR.marketsText([{ group: '환율', label: '달러', unit: '원', price: 1385.2, chg: 0.31 }, { group: '코인', label: 'BTC', unit: '$', price: 98000, chg: -2 }, { group: '지수', label: '코스피', err: 'x' }]);
  ok(/달러 <b>1,385.20원<\/b> ▲0.31%/.test(mt) && /BTC <b>\$98,000<\/b> ▼2.00%/.test(mt) && /코스피 <b>\?<\/b>/.test(mt), '시세 문구', mt.replace(/\n/g, ' / '));
  ok((await BR.geocode(null, '파 리')).tz === 'Europe/Paris', '내장 도시 좌표');

  // ---------- scan.js 통합 (모의 데이터) ----------
  let out = bot(['/alert BTCUSDT 120 메모', '/alert 삼성전자 <80', '/alert BTCUSDT -10%', '/alert BTCUSDT +5%', '/alert BTCUSDT >50', '/alerts'], { MOCK_PRICE: '100' });
  let s = state();
  ok(s._alerts.length === 4, '알림 4개 등록', s._alerts.map(a => `${a.op}${a.price}`).join(' '));
  ok(s._alerts[0].op === '>=' && s._alerts[1].op === '<=' && Math.abs(s._alerts[2].price - 90) < 1e-9 && s._alerts[2].op === '<=' && Math.abs(s._alerts[3].price - 105) < 1e-9, '방향/퍼센트 계산');
  ok(/이미 조건을 만족/.test(out), '이미 만족하는 가격 거부');
  out = bot([], { MOCK_PRICE: '106' });
  s = state();
  ok((out.match(/🚨/g) || []).length === 1 && s._alerts.length === 3, '+5% 알림만 발동 후 삭제');
  out = bot([], { MOCK_PRICE: '79' });
  s = state();
  ok((out.match(/🚨/g) || []).length === 2 && s._alerts.length === 1, '하락 알림 2개 발동');
  bot(['/unalert 1']); ok(state()._alerts.length === 0, '/unalert');

  out = bot(['/watch https://example.com 품절', '/watch https://example.org', '/watch notaurl', '/watches'], { MOCK_PAGE: '상품|품절' });
  s = state();
  ok(s._watches.length === 2 && s._watches[0].has === true && s._watches[1].hash, '감시 2개 등록', s._watches.map(w => w.url).join(' '));
  ok(/사용법: \/watch/.test(out), '잘못된 URL 거부');
  out = bot([], { MOCK_PAGE: '상품|장바구니' });
  ok(/사라짐/.test(out) && /변경됨/.test(out) && /➕ 장바구니/.test(out) && /➖ 품절/.test(out), '감시 변경 알림', '');
  out = bot([], { MOCK_PAGE: '상품|장바구니' });
  ok(!/👀 <b>/.test(out), '변화 없으면 조용히');
  bot(['/unwatch all']); ok(state()._watches.length === 0, '/unwatch all');

  out = bot(['/brief', '/city 파리', '/help']);
  ok(/아침 브리핑/.test(out) && /브리핑 도시 변경: <b>파리/.test(out) && /\/watch URL/.test(out), '/brief /city /help');
  ok(JSON.parse(fs.readFileSync(WL, 'utf8')).brief.city === '파리', '도시 설정 저장');

  out = bot(['/status'], { DAEMON_SINCE: String(Date.now() - 125 * 60e3) });
  ok(/실시간 \(2시간 5분 전 시작/.test(out) && /가격 알림 0개/.test(out), '/status 실시간 표시');
  ok(/예약 실행/.test(bot(['/status'])), '/status 예약 표시');
  // 실시간 모드에서는 RUN_WATCHES 없으면 페이지를 읽지 않음
  bot(['/watch https://example.net'], { MOCK_PAGE: 'a' });
  out = execFileSync(process.execPath, [path.join(__dirname, 'scan.js')], { env: { ...process.env, TELEGRAM_BOT_TOKEN: '', DRY_RUN: '1', MOCK: '1', BOT_STATE: ST, BOT_WATCHLIST: WL, SCAN_MODE: 'light', WATCH_FETCH_FAIL: '' }, encoding: 'utf8' });
  ok(/페이지 0개\(감시 1\)/.test(out) && /분석 0개/.test(out), 'light 모드: 전체 분석·페이지 감시 생략');
  bot(['/unwatch all']);

  out = bot(['달러', '/alert 비트코인 -5%', '비트코인', '안녕', 'hello world'], { SCAN_MODE: 'light' });
  ok(/💹 <b>달러<\/b>/.test(out) && /💹 <b>비트코인<\/b>[^\n]*\n⏰ 알림: ≤ 95/.test(out) && /「안녕」 종목을 모르겠어요/.test(out) && state()._alerts[0].symbol === 'BTCUSDT', '별칭·이름만 보내기');
  bot(['/unalert all']);

  // ---------- 여행 비서 ----------
  const TD = path.join(tmp, 'trip.json');
  const trip = (now, cmds) => bot(cmds, { TRIP_NOW: now, TRIP_DATA: TD, SCAN_MODE: 'light' });
  out = trip('2026-10-10T03:00:00Z', ['/trip', '항공권 1,250,000원', '50유로', '/check', '/done 2']);
  ok(/D-38/.test(out) && /✅ 🚆 <b>항공권<\/b> ₩1,250,000/.test(out) && /💱 €50.00 = <b>₩80,000/.test(out) && /✅ 완료: 사그라다/.test(out), '여행 전: 일정·지출·환산·체크리스트');
  out = trip('2026-11-19T08:30:00Z', ['커피 3.2', '2인 점심 36유로', '박물관 15유로', '택시 12.5chf', 'NVDA', '/undo', '/budget 300만원']);
  ok(/☕ <b>커피<\/b> €3.20/.test(out) && /🍽️ <b>2인 점심<\/b> €36.00/.test(out) && /🎟️ <b>박물관/.test(out) && /12.50 CHF/.test(out) && /💹 <b>NVDA/.test(out) && /↩️ 삭제: 🚆 택시/.test(out), '여행 중: 단위 없는 금액·분류·CHF·주식 구분·undo');
  ok(/Day 3\/20<\/b> · 🍷 <b>포르투/.test(out) && /내일 💃 <b>세비야/.test(out), '현지 아침 브리핑 + 이동 예고');
  ok(!/Day 3\/20/.test(trip('2026-11-19T15:00:00Z', [])), '아침 브리핑 하루 한 번');
  out = trip('2026-11-19T21:10:00Z', ['/spent 포르투']);
  ok(/오늘 정리/.test(out) && /🍷 포르투 지출/.test(out) && /예산 ₩3,000,000/.test(out), '저녁 정리 + 도시별 지출');
  ok(/오늘 이동: 🍷 포르투 → 💃 <b>세비야/.test(trip('2026-11-20T08:10:00Z', [])), '이동일 아침');
  out = trip('2026-12-08T02:00:00Z', ['/export']);
  ok(/여행 끝/.test(out) && /날짜,시각\(한국\),도시/.test(out) && /포르투,커피,커피,3.2,EUR/.test(out), '귀국 후 정리 + CSV');
  // 암호화: 토큰이 있으면 파일에 평문이 남지 않아야 함 (Node 저장 계층 secure.js)
  {
    const SEC = require('./secure.js'), ef = path.join(tmp, 'enc.json');
    SEC.saveTrip(ef, 'secret-token', { spends: [{ text: '점심', amount: 18 }] });
    const raw = fs.readFileSync(ef, 'utf8');
    ok(!/점심/.test(raw) && JSON.parse(raw).iv && SEC.loadTrip(ef, 'secret-token').spends[0].text === '점심' && SEC.loadTrip(ef, 'wrong-token').spends.length === 0, '지출 데이터 암호화 저장');
  }

  // ---------- 대시보드 렌더링 ----------
  {
    const render = require('./dash.js');
    const html = render({ cfg: { interval: '1d', symbols: [{ src: 'us', symbol: 'NVDA' }] }, state: { _trip: { budget: 3000000 }, _alerts: [{ name: '달러<b>', op: '<=', price: 1350 }] }, trip: { spends: [{ date: '2026-11-18', city: '포르투', cat: '식사', text: '<script>x</script>점심', amount: 18, cur: 'EUR', krw: 28800, pay: '카드' }] }, now: Date.parse('2026-11-18T12:00:00Z') });
    ok(/Day 2/.test(html) && /₩28,800/.test(html) && /포르투/.test(html) && /₩2,971,200/.test(html) && !/<script>x/.test(html) && /&lt;script&gt;x/.test(html) && /달러&lt;b&gt;/.test(html), '대시보드: 숫자·도시·예산·HTML 이스케이프');
    ok(/Cloudflare 버전에서/.test(bot(['/dash'])), '/dash: Node 모드 안내');
  }

  // ---------- daemon.js (짧게 실행) ----------
  try {
    const t0 = Date.now();
    const d = execFileSync(process.execPath, [path.join(__dirname, 'daemon.js')], { env: { ...process.env, TELEGRAM_BOT_TOKEN: '', DRY_RUN: '1', MOCK: '1', NO_GIT: '1', BOT_STATE: ST, BOT_WATCHLIST: WL, DAEMON_MINUTES: '0.45' }, encoding: 'utf8', timeout: 90e3 });
    ok(/실시간 모드 시작/.test(d) && /\[full\/시작\] .*종료코드 0 명령 .*분석 2개/.test(d) && /종료 — scan.js 1회/.test(d) && Date.now() - t0 < 60e3, 'daemon 시작·전체분석·종료', d.replace(/\n/g, ' / ').slice(0, 300));
  } catch (e) { ok(false, 'daemon 실행', String(e.stdout || e.message).slice(-500)); }

  // ---------- 실제 API ----------
  if (process.env.LIVE) {
    const getJSON = async u => { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (chart-bot)' } }); if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`); return r.json(); };
    const tryIt = async (name, fn, check) => { try { const v = await fn(); ok(check(v), name, JSON.stringify(v).slice(0, 160)); } catch (e) { ok(false, name, e.message); } };
    // 가격 알림이 쓰는 엔드포인트와 같은 것
    await tryIt('LIVE 바이낸스 현재가', async () => +(await getJSON('https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT')).price, v => v > 1000);
    await tryIt('LIVE 업비트 현재가', async () => (await getJSON('https://api.upbit.com/v1/ticker?markets=KRW-XRP'))[0].trade_price, v => v > 0);
    for (const t of ['NVDA', '005930.KS', 'USDKRW=X', 'EURKRW=X'])
      await tryIt(`LIVE 야후 현재가 ${t}`, async () => (await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=5d`)).chart.result[0].meta.regularMarketPrice, v => v > 0);
    await tryIt('LIVE 시세 묶음', () => BR.markets(getJSON), rows => rows.every(r => !r.err && r.price > 0) && rows.some(r => r.t && Math.abs(r.chg) > 0.001));
    await tryIt('LIVE 지오코딩 Interlaken', () => BR.geocode(getJSON, 'Interlaken'), c => Math.abs(c.lat - 46.7) < 0.3);
    await tryIt('LIVE 날씨', async () => BR.weatherText({ name: '서울' }, await BR.weather(getJSON, await BR.geocode(getJSON, '서울'))), t => /오늘/.test(t) && !/NaN|undefined/.test(t));
    await tryIt('LIVE 웹페이지 읽기', async () => { const p = await WT.fetchPage('https://example.com'); console.log('   추출된 줄:', p.lines); return p; }, p => p.title === 'Example Domain' && p.lines.some(l => /documentation/.test(l)) && !p.lines.some(l => /[<>{}]/.test(l)));
    try {
      const o = bot(['달러', '비트코인', '리플', '삼성전자', '엔비디아', '코스피'], { MOCK: '', SCAN_MODE: 'light' });
      ok((o.match(/💹/g) || []).length === 6 && !/❌|NaN|undefined/.test(o), 'LIVE 이름만 보내기 6종', o.replace(/\n/g, ' / ').slice(0, 700));
    } catch (e) { ok(false, 'LIVE 이름만 보내기', e.message); }
    try {
      const o = bot(['/today', '50유로', '/trip'], { MOCK: '', SCAN_MODE: 'light', TRIP_NOW: '2026-11-25T10:00:00Z', TRIP_DATA: path.join(tmp, 'trip-live.json') });
      ok(/⛪ <b>바르셀로나<\/b>/.test(o) && /오늘 /.test(o) && /💱 €50.00 = <b>₩[\d,]+/.test(o) && !/⚠ fetch|NaN|undefined/.test(o), 'LIVE 여행 날씨·환율', o.replace(/\n/g, ' / ').slice(0, 600));
    } catch (e) { ok(false, 'LIVE 여행', e.message); }
    // 실제 데이터로 봇 명령 처리 (MOCK 끔)
    const wl = JSON.parse(fs.readFileSync(WL, 'utf8')); delete wl.brief; fs.writeFileSync(WL, JSON.stringify(wl));
    try {
      const o = bot(['/alert BTCUSDT +50%', '/alert USDKRW -20% 테스트', '/weather', '/brief', '/watch https://example.com Example'], { MOCK: '' });
      const s2 = state();
      ok(s2._alerts.length === 2 && s2._watches.length === 1 && s2._watches[0].has === true && /아침 브리핑/.test(o) && !/⚠/.test(o), 'LIVE 봇 명령 종합', o.replace(/\n/g, ' / ').slice(0, 900));
    } catch (e) { ok(false, 'LIVE 봇 명령 종합', e.message); }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} 통과, ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();

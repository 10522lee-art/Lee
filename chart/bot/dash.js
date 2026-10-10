// 개인 대시보드 HTML (Cloudflare 버전에서 /d/<키> 로 제공) — 여행 지출 + 알림/감시/관심종목
// 순수 함수: 상태 → HTML 문자열 (Node 테스트 가능). 차트는 단일 계열이라 한 가지 색, 마우스오버/탭 툴팁 + 표 보기
const TRIP_CFG = require('./trip.json');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const won = n => '₩' + Math.round(n).toLocaleString('ko-KR');
const wonShort = n => n >= 1e6 ? `₩${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `₩${Math.round(n / 1e3)}k` : won(n);
const CAT_ICON = { 식사: '🍽️', 커피: '☕', 교통: '🚆', 쇼핑: '🛍️', 입장: '🎟️', 숙소: '🛏️', 기타: '💳' };
const W = ['일', '월', '화', '수', '목', '금', '토'];
const zDate = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const diff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5);
const md = d => { const t = new Date(d + 'T00:00:00Z'); return `${t.getUTCMonth() + 1}/${t.getUTCDate()}`; };
const dow = d => W[new Date(d + 'T00:00:00Z').getUTCDay()];
const plain = h => String(h).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// 가로 막대 (분류별·도시별): 정렬된 단일 계열
function hbars(rows, total) {
  if (!rows.length) return '<p class="empty">아직 기록이 없어요</p>';
  const max = Math.max(...rows.map(r => r.v));
  return `<div class="hbars">${rows.map(r => `<div class="hb" tabindex="0" data-tip="${esc(r.label)} · ${won(r.v)} (${Math.round(r.v / total * 100)}%)"><span class="hb-l">${r.icon || ''} ${esc(r.label)}</span><span class="hb-t"><span class="hb-f" style="width:${Math.max(1.5, r.v / max * 100).toFixed(1)}%"></span></span><span class="hb-v">${wonShort(r.v)}</span></div>`).join('')}</div>`;
}
// 날짜별 세로 막대: HTML로 그려서 휴대폰에서도 글자 크기가 그대로 (SVG는 화면 폭 따라 글자까지 작아짐)
function dayBars(days, today) {
  const n = days.length, max = Math.max(1, ...days.map(d => d.v)), nice = niceMax(max), every = Math.ceil(n / 7);
  const grid = [1, 0.5].map(f => `<div class="db-g" style="bottom:${f * 100}%"><span>${wonShort(nice * f)}</span></div>`).join('');
  const cols = days.map((d, i) => `<div class="db-c${d.date === today ? ' today' : ''}" tabindex="0" data-tip="${md(d.date)}(${dow(d.date)}) ${esc(d.city || '')} · ${d.v ? won(d.v) : '지출 없음'}"><div class="db-b" style="height:${(d.v / nice * 100).toFixed(1)}%"></div></div>`).join('');
  const ti = days.findIndex(d => d.date === today); // 오늘 라벨 옆 칸은 비워서 겹치지 않게
  const labels = days.map((d, i) => `<span class="${i === ti ? 'now' : ''}">${i === ti || (i % every === 0 && (ti < 0 || Math.abs(i - ti) > 1)) ? md(d.date) : ''}</span>`).join('');
  return `<div class="db" role="img" aria-label="날짜별 지출 막대 그래프 (표로 보기 참고)"><div class="db-plot">${grid}<div class="db-cols" style="grid-template-columns:repeat(${n},1fr)">${cols}</div></div><div class="db-x" style="grid-template-columns:repeat(${n},1fr)">${labels}</div></div>`;
}
function niceMax(v) { const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

module.exports = function renderDashboard({ cfg, state, trip, now = Date.now(), tripCfg = TRIP_CFG }) {
  const C = tripCfg.cities.map(([from, to, name, cur, emoji, tz]) => ({ from, to, name, cur, emoji, tz }));
  const FIRST = C[0].from, LAST = C.at(-1).to, TOTAL = diff(LAST, FIRST) + 1;
  const td = zDate(now, 'Europe/Madrid'), kst = zDate(now, 'Asia/Seoul');
  const phase = td < FIRST ? 'before' : td > LAST ? 'after' : 'during';
  const cityOn = d => C.find(c => d >= c.from && d <= c.to);
  const sp = trip?.spends || [], sum = xs => xs.reduce((a, x) => a + x.krw, 0);
  const total = sum(sp), budget = state?._trip?.budget || tripCfg.budgetKRW || 0;
  const inTrip = sp.filter(x => x.date >= FIRST && x.date <= LAST);
  const tripDays = phase === 'during' ? diff(td, FIRST) + 1 : phase === 'after' ? TOTAL : 0;
  const daysLeft = phase === 'during' ? diff(LAST, td) + 1 : phase === 'before' ? TOTAL : 0;

  // 숫자 타일
  const tiles = [
    phase === 'before' ? { k: '출발까지', v: `D-${diff(FIRST, kst)}`, s: `${md(FIRST)} ${C[0].emoji} ${C[0].name}` } : phase === 'during' ? { k: '여행', v: `Day ${diff(td, FIRST) + 1}`, s: `/ ${TOTAL}일 · ${cityOn(td).emoji} ${cityOn(td).name}` } : { k: '여행', v: '완료', s: `${TOTAL}일` },
    { k: '총 지출', v: won(total), s: `${sp.length}건${sp.some(x => x.city === '출발 전') ? ` · 출발 전 ${wonShort(sum(sp.filter(x => x.city === '출발 전')))}` : ''}` },
    budget ? { k: '남은 예산', v: won(budget - total), s: `${Math.round(total / budget * 100)}% 사용${daysLeft && budget > total ? ` · 하루 ${wonShort((budget - total) / daysLeft)}` : ''}`, bad: total > budget } : { k: '예산', v: '미설정', s: '텔레그램에서 /budget 300만원' },
    { k: '하루 평균 (여행 중)', v: tripDays ? won(sum(inTrip) / tripDays) : '–', s: tripDays ? `${tripDays}일 기준` : '여행 시작 후 계산' },
  ];
  const days = []; for (let d = FIRST; d <= LAST; d = addDays(d, 1)) days.push({ date: d, city: cityOn(d)?.name, v: sum(sp.filter(x => x.date === d)) });
  const cats = Object.entries(sp.reduce((m, x) => (m[x.cat] = (m[x.cat] || 0) + x.krw, m), {})).map(([k, v]) => ({ label: k, icon: CAT_ICON[k], v })).sort((a, b) => b.v - a.v);
  const cities = [...C.map(c => ({ label: c.name, icon: c.emoji, v: sum(sp.filter(x => x.city === c.name)) })), { label: '출발 전', icon: '✈️', v: sum(sp.filter(x => x.city === '출발 전')) }].filter(r => r.v > 0).sort((a, b) => b.v - a.v);
  const recent = sp.slice(-15).reverse();
  const done = new Set(state?._trip?.done || []), dl = diff(FIRST, kst);
  const todo = tripCfg.checklist.map(([off, text], i) => ({ off, text, i, due: dl <= -off, done: done.has(i) }));
  const rows = (cfg?.symbols || []).map(s => ({ s, r: state?._rows?.[`${s.src}:${s.symbol}:${cfg.interval}`] }));

  const itin = C.map(c => {
    const here = td >= c.from && td <= c.to, past = td > c.to, n = diff(c.to, c.from) + 1;
    return `<li class="${here ? 'here' : past ? 'past' : ''}"><span class="it-e">${c.emoji}</span><span class="it-n">${esc(c.name)}${here ? ' <b class="pill">지금</b>' : ''}</span><span class="it-d">${md(c.from)}–${md(c.to)} · ${n}박${c.cur === 'CHF' ? ' · CHF' : ''}</span></li>`;
  }).join('');

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>여행 대시보드</title>
<style>
:root{color-scheme:light;--bg:#f6f5f2;--card:#fcfcfb;--ink:#0b0b0b;--sub:#52514e;--muted:#7a7974;--line:#e4e2dc;--grid:#ecebe6;--s1:#2a78d6;--s1soft:#cde2fb;--bad:#d03b3b;--good:#0ca30c}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#121211;--card:#1a1a19;--ink:#f0efec;--sub:#c3c2b7;--muted:#8f8e86;--line:#2e2e2b;--grid:#262624;--s1:#3987e5;--s1soft:#184f95}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#121211;--card:#1a1a19;--ink:#f0efec;--sub:#c3c2b7;--muted:#8f8e86;--line:#2e2e2b;--grid:#262624;--s1:#3987e5;--s1soft:#184f95}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
main{max-width:760px;margin:auto;padding:16px}h1{font-size:20px;margin:4px 0 2px}h2{font-size:15px;margin:0 0 10px;color:var(--sub);font-weight:600}
.meta{color:var(--muted);font-size:13px;margin-bottom:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px}
.tiles{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px}@media(min-width:620px){.tiles{grid-template-columns:repeat(4,1fr)}}
.tile{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px}.tile .k{font-size:12px;color:var(--sub)}.tile .v{font-size:21px;font-weight:700;margin:2px 0;font-variant-numeric:tabular-nums;word-break:keep-all}.tile .s{font-size:12px;color:var(--muted)}.tile.bad .v{color:var(--bad)}
.db{padding-left:44px}.db-plot{position:relative;height:160px;border-bottom:1px solid var(--line)}.db-g{position:absolute;left:0;right:0;border-top:1px solid var(--grid)}.db-g span{position:absolute;right:100%;margin-right:6px;top:-8px;font-size:11px;color:var(--muted);white-space:nowrap}
.db-cols{position:absolute;inset:0;display:grid;align-items:end;gap:2px}.db-c{height:100%;display:flex;align-items:flex-end;border-radius:4px 4px 0 0;outline:none}.db-c:hover,.db-c:focus{background:var(--grid)}.db-b{width:100%;background:var(--s1);border-radius:4px 4px 0 0;min-height:0}
.db-x{display:grid;gap:2px;margin-top:4px}.db-x span{font-size:11px;color:var(--muted);text-align:center;white-space:nowrap;overflow:visible}.db-x span.now{color:var(--ink);font-weight:700}
.hbars{display:grid;gap:8px}.hb{display:grid;grid-template-columns:7.5em 1fr 4.6em;align-items:center;gap:8px;font-size:14px;outline:none}.hb-l{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hb-t{height:12px;background:var(--grid);border-radius:4px;overflow:hidden}.hb-f{display:block;height:100%;background:var(--s1);border-radius:0 4px 4px 0}.hb-v{text-align:right;color:var(--sub);font-variant-numeric:tabular-nums}.hb:hover .hb-t,.hb:focus .hb-t{outline:2px solid var(--s1soft)}
.two{display:grid;gap:12px}@media(min-width:620px){.two{grid-template-columns:1fr 1fr}.two .card{margin:0}}
ul.it{list-style:none;margin:0;padding:0}ul.it li{display:grid;grid-template-columns:1.8em 1fr auto;gap:6px;padding:7px 0;border-bottom:1px solid var(--line)}ul.it li:last-child{border:0}ul.it li.past{color:var(--muted)}ul.it li.here{font-weight:700}.it-d{color:var(--muted);font-size:13px;font-weight:400}.pill{font-size:11px;background:var(--s1);color:#fff;border-radius:99px;padding:1px 7px;margin-left:4px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 4px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--sub);font-weight:600;font-size:12px}td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.empty{color:var(--muted);margin:4px 0}.check li{margin:4px 0}.check .done{color:var(--muted);text-decoration:line-through}.check .later{color:var(--muted)}
details summary{cursor:pointer;color:var(--sub);font-size:13px;margin-top:8px}
#tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--bg);font-size:13px;padding:6px 9px;border-radius:8px;opacity:0;transition:opacity .1s;z-index:9;max-width:80vw}
.foot{color:var(--muted);font-size:12px;text-align:center;margin:18px 0}
</style></head><body><main>
<h1>✈️ ${esc(tripCfg.name)} · 대시보드</h1>
<div class="meta">${md(FIRST)}–${md(LAST)} · ${C.length}개 도시 · 기준 ${esc(new Date(now).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))} (한국)</div>
<div class="tiles">${tiles.map(t => `<div class="tile${t.bad ? ' bad' : ''}"><div class="k">${esc(t.k)}</div><div class="v">${esc(t.v)}</div><div class="s">${esc(t.s)}</div></div>`).join('')}</div>
<section class="card"><h2>날짜별 지출 (원화 환산)</h2>${dayBars(days, td)}
<details><summary>표로 보기</summary><table><tr><th>날짜</th><th>도시</th><th class="n">지출</th></tr>${days.map(d => `<tr><td>${md(d.date)} (${dow(d.date)})</td><td>${esc(d.city || '')}</td><td class="n">${d.v ? won(d.v) : '–'}</td></tr>`).join('')}</table></details></section>
<div class="two"><section class="card"><h2>분류별</h2>${hbars(cats, total || 1)}</section><section class="card"><h2>도시별</h2>${hbars(cities, total || 1)}</section></div>
<div class="two" style="margin-top:12px"><section class="card"><h2>일정</h2><ul class="it">${itin}</ul></section>
<section class="card"><h2>${phase === 'before' ? '출발 전 체크리스트' : '체크리스트'}</h2><ul class="check" style="list-style:none;padding:0;margin:0">${todo.map(x => `<li class="${x.done ? 'done' : x.due ? '' : 'later'}">${x.done ? '✅' : x.due ? '☐' : '·'} ${esc(x.text)} <small>D${x.off}</small></li>`).join('')}</ul></section></div>
<section class="card" style="margin-top:12px"><h2>최근 지출</h2>${recent.length ? `<table><tr><th>날짜</th><th>내용</th><th class="n">금액</th><th class="n">원화</th></tr>${recent.map(x => `<tr><td>${md(x.date)}</td><td>${CAT_ICON[x.cat] || '💳'} ${esc(x.text)}${x.pay === '현금' ? ' 💵' : ''}<br><small style="color:var(--muted)">${esc(x.city)} · ${esc(x.cat)}</small></td><td class="n">${x.cur === 'KRW' ? '' : `${x.cur === 'EUR' ? '€' : ''}${(+x.amount).toFixed(2)}${x.cur === 'CHF' ? ' CHF' : x.cur === 'USD' ? ' $' : ''}`}</td><td class="n">${won(x.krw)}</td></tr>`).join('')}</table>` : '<p class="empty">텔레그램에 "점심 18유로"처럼 보내면 여기에 쌓여요</p>'}</section>
<div class="two" style="margin-top:12px"><section class="card"><h2>⏰ 가격 알림</h2>${(state?._alerts || []).length ? `<table>${state._alerts.map(a => `<tr><td>${esc(a.name)}</td><td class="n">${a.op === '>=' ? '≥' : '≤'} ${(+a.price).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td></tr>`).join('')}</table>` : '<p class="empty">없음 · /alert 종목 가격</p>'}</section>
<section class="card"><h2>👀 페이지 감시</h2>${(state?._watches || []).length ? `<table>${state._watches.map(w => `<tr><td>${esc(w.title || w.url.replace(/^https?:\/\//, '').slice(0, 40))}</td><td class="n">${w.keyword ? `「${esc(w.keyword)}」 ${w.has ? '있음' : '없음'}` : '변경'}</td></tr>`).join('')}</table>` : '<p class="empty">없음 · /watch URL [키워드]</p>'}</section></div>
<section class="card" style="margin-top:12px"><h2>📊 관심종목 (${esc(cfg?.interval || '')})</h2>${rows.length ? `<table>${rows.map(({ s, r }) => `<tr><td>${esc(s.name || s.symbol)}</td><td>${r ? (r.err ? `⚠ ${esc(r.err)}` : esc(plain(r.line).replace(/^\S+\s+\S+\s+/, ''))) : '분석 대기'}</td></tr>`).join('')}</table>` : '<p class="empty">없음</p>'}</section>
<div class="foot">이 주소는 나만 아는 비밀 링크예요 · 새 링크는 텔레그램 /dash</div>
</main><div id="tip" role="tooltip"></div>
<script>
const tip=document.getElementById('tip');
function show(e){const t=e.target.closest('[data-tip]');if(!t){tip.style.opacity=0;return}tip.textContent=t.dataset.tip;const r=t.getBoundingClientRect(),x=e.clientX??r.left+r.width/2,y=e.clientY??r.top;tip.style.opacity=1;const w=tip.offsetWidth;tip.style.left=Math.min(innerWidth-w-8,Math.max(8,x-w/2))+'px';tip.style.top=Math.max(8,y-tip.offsetHeight-12)+'px'}
addEventListener('pointermove',show);addEventListener('pointerdown',show);addEventListener('focusin',show);addEventListener('scroll',()=>tip.style.opacity=0,{passive:true});
</script></body></html>`;
};

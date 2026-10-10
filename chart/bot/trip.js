// 여행 비서: 지출 기록(텔레그램에 "점심 18유로"), 일정/D-day, 현지 시간 아침·저녁 알림, 체크리스트, CSV
// Node·Cloudflare Workers 공용 (파일 저장·암호화는 호출하는 쪽 담당: Node는 secure.js)
const TRIP_CFG = require('./trip.json');

const CATS = {
  식사: ['점심', '저녁', '아침', '식사', '브런치', '밥', '식당', '레스토랑', '타파스', '피자', '파스타', '맥주', '와인', '술', '음료', '물', '간식', '버거', '샌드위치', '빠에야'],
  커피: ['커피', '카페', '라떼', '디저트', '빵', '에그타르트', '나타', '츄러스', '케이크'],
  교통: ['택시', '우버', '볼트', '기차', '버스', '지하철', '메트로', '트램', '교통', '공항', '렌페', '이탈로', '케이블카', '푸니쿨라', '곤돌라', '페리', '항공', '비행기', '렌트', '주유'],
  쇼핑: ['쇼핑', '기념품', '선물', '옷', '마트', '슈퍼', '약국', '화장품'],
  입장: ['입장', '박물관', '투어', '성당', '미술관', '티켓', '알람브라', '바티칸', '플라멩코', '전망대', '융프라우'],
  숙소: ['숙소', '호텔', '숙박', '도시세', '에어비앤비'],
  기타: ['기타', '화장실', '세탁', '팁', '유심', '이심', '수수료', '보험'],
};
const CAT_ICON = { 식사: '🍽️', 커피: '☕', 교통: '🚆', 쇼핑: '🛍️', 입장: '🎟️', 숙소: '🛏️', 기타: '💳' };
const UNIT = { 유로: 'EUR', euro: 'EUR', eur: 'EUR', '€': 'EUR', 프랑: 'CHF', chf: 'CHF', 원: 'KRW', krw: 'KRW', 만원: 'KRW', 달러: 'USD', usd: 'USD', '$': 'USD' };
const W = ['일', '월', '화', '수', '목', '금', '토'];

function zoned(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, hm: `${p.hour}:${p.minute}` };
}
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const diffDays = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5);
const md = d => { const t = new Date(d + 'T00:00:00Z'); return `${t.getUTCMonth() + 1}/${t.getUTCDate()} (${W[t.getUTCDay()]})`; };
const won = n => '₩' + Math.round(n).toLocaleString('ko-KR');
const money = (a, cur) => cur === 'KRW' ? won(a) : cur === 'EUR' ? `€${a.toFixed(2)}` : cur === 'USD' ? `$${a.toFixed(2)}` : `${a.toFixed(2)} ${cur}`;
const num = s => +(/,\d{3}(\D|$)/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.'));

function parseMoney(text) {
  let m = text.match(/(€|\$|chf)\s*(\d+(?:[.,]\d{1,2})?)/i);
  if (m) return { amount: num(m[2]), unit: m[1].toLowerCase(), raw: m[0] };
  // 단위가 붙은 숫자를 우선 ("2인 점심 36유로" → 36유로)
  const all = [...text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+(?:[.,]\d{1,2})?)\s*(만원|유로|euro|eur|€|프랑|chf|원|krw|달러|usd|\$)?/gi)];
  m = all.find(x => x[2]) || all.at(-1);
  if (!m) return null;
  return { amount: num(m[1]), unit: (m[2] || '').toLowerCase(), raw: m[0] };
}
// 가장 길게 맞는 단어의 분류 ("박물관"이 "물"보다, "미술관"이 "술"보다 우선)
const catOf = text => { let best = null, len = 0; for (const [k, ws] of Object.entries(CATS)) for (const w of ws) if (w.length > len && text.includes(w)) { best = k; len = w.length; } return best; };

module.exports = function createTrip({ getJSON, BR, state, esc, sendDoc, now = () => Date.now(), cfg = TRIP_CFG, tripData, onChange, mock = false }) {
  const C = cfg.cities.map(([from, to, name, cur, emoji, tz]) => ({ from, to, name, cur, emoji, tz }));
  const FIRST = C[0].from, LAST = C.at(-1).to, TOTAL = diffDays(LAST, FIRST) + 1;
  state._trip ||= {};
  const T = state._trip;

  // ---------- 저장: 데이터는 호출하는 쪽이 넘겨주고, 바뀌면 onChange() (Node는 암호화 파일, Workers는 Durable Object) ----------
  const data = tripData || { spends: [] };
  data.spends ||= [];
  const save = () => onChange && onChange(data);

  // ---------- 날짜/도시 ----------
  const tripDate = () => zoned(now(), 'Europe/Madrid').date; // 여행 도시들은 모두 UTC+0~+1
  const kstDate = () => zoned(now(), 'Asia/Seoul').date;
  const cityOn = d => C.find(c => d >= c.from && d <= c.to);
  function phase() { const d = tripDate(); return d < FIRST ? 'before' : d > LAST ? 'after' : 'during'; }
  function today() {
    const d = tripDate(), c = cityOn(d);
    return { date: d, city: c, day: diffDays(d, FIRST) + 1, local: c ? zoned(now(), c.tz) : null };
  }
  const nextCity = d => cityOn(addDays(d, 1));
  const moveNote = d => {
    const c = cityOn(d), n = nextCity(d), p = cityOn(addDays(d, -1));
    if (c && p && c !== p) return `🚆 오늘 이동: ${p.emoji} ${p.name} → ${c.emoji} <b>${c.name}</b>`;
    if (c && n && c !== n) return `🚆 내일 ${n.emoji} <b>${n.name}</b>(으)로 이동 — 짐 싸고 이동편 시간 확인`;
    if (d === LAST) return '🏁 오늘이 마지막 날 — 공항 이동 시간 넉넉하게';
    if (addDays(d, 1) === LAST) return '🏁 내일이 마지막 날';
    return '';
  };

  // ---------- 환율 (3시간 캐시) ----------
  async function rates() {
    const fb = cfg.fallbackRates;
    if (mock) return { ...fb, KRW: 1 };
    const fx = state._fx;
    if (fx && now() - fx.at < 3 * 3600e3) return { ...fx, KRW: 1 };
    const out = { at: now() };
    for (const [cur, t] of [['EUR', 'EURKRW=X'], ['CHF', 'CHFKRW=X'], ['USD', 'USDKRW=X']]) {
      try { out[cur] = (await BR.yahooChange(getJSON, t)).price; } catch { out[cur] = fx?.[cur] || fb[cur]; }
    }
    state._fx = out;
    return { ...out, KRW: 1 };
  }

  // ---------- 지출 집계 ----------
  const sum = xs => xs.reduce((a, x) => a + x.krw, 0);
  const sumCur = (xs, cur) => xs.filter(x => x.cur === cur).reduce((a, x) => a + x.amount, 0);
  function byCat(xs) {
    const m = {}; for (const x of xs) m[x.cat] = (m[x.cat] || 0) + x.krw;
    const tot = sum(xs) || 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${CAT_ICON[k] || '💳'} ${k} ${won(v)} (${Math.round(v / tot * 100)}%)`);
  }
  function budgetLine(d = tripDate()) {
    const b = T.budget || cfg.budgetKRW;
    if (!b) return '';
    const used = sum(data.spends), left = b - used;
    const daysLeft = Math.max(1, phase() === 'during' ? diffDays(LAST, d) + 1 : phase() === 'before' ? TOTAL : 1);
    return `💰 예산 ${won(b)} 중 ${Math.round(used / b * 100)}% 사용 · 남은 ${won(left)}` + (phase() !== 'after' && left > 0 ? ` (하루 ${won(left / daysLeft)})` : left < 0 ? ' ⚠ 초과' : '');
  }
  function dayLine(d) {
    const xs = data.spends.filter(x => x.date === d);
    if (!xs.length) return null;
    const curs = [...new Set(xs.map(x => x.cur))].filter(c => c !== 'KRW').map(c => money(sumCur(xs, c), c));
    return `${won(sum(xs))}${curs.length ? ` (${curs.join(' + ')})` : ''}`;
  }

  // ---------- 지출 기록 ----------
  async function record(text) {
    const m = parseMoney(text);
    if (!m || !(m.amount > 0)) return null;
    const ph = phase(), cat = catOf(text);
    // 단위 없는 숫자는 여행 중 + 분류 단어가 있을 때만 (주식 코드·잡담 오인 방지)
    if (!m.unit && !(ph === 'during' && cat)) return null;
    const t = today();
    let cur = m.unit ? UNIT[m.unit] : t.city?.cur || 'EUR', amount = m.amount;
    if (m.unit === '만원') amount *= 1e4;
    const r = await rates(), rate = r[cur] || 1;
    const label = text.replace(m.raw, ' ').replace(/카드|현금/g, ' ').replace(/\s+/g, ' ').trim() || cat || '지출';
    const x = { id: now().toString(36), at: now(), date: ph === 'during' ? t.date : kstDate(), city: ph === 'during' ? t.city.name : ph === 'before' ? '출발 전' : '귀국 후', amount, cur, rate: +rate.toFixed(4), krw: Math.round(amount * rate), cat: cat || '기타', text: label, pay: /현금/.test(text) ? '현금' : '카드' };
    data.spends.push(x); save();
    const todayTot = dayLine(x.date);
    return `✅ ${CAT_ICON[x.cat]} <b>${esc(x.text)}</b> ${money(x.amount, x.cur)}${x.cur !== 'KRW' ? ` (${won(x.krw)})` : ''} · ${x.pay}\n` +
      `오늘 ${todayTot} · 누적 ${won(sum(data.spends))}` + (budgetLine() ? `\n${budgetLine()}` : '') +
      `\n<i>분류 ${x.cat}${cat ? '' : ' (자동 분류 못함)'} · 잘못 적었으면 /undo</i>`;
  }
  async function convert(text) {
    const m = parseMoney(text);
    if (!m || !m.unit || !(m.amount > 0)) return null;
    const cur = UNIT[m.unit], amount = m.unit === '만원' ? m.amount * 1e4 : m.amount, r = await rates();
    if (cur === 'KRW') return `💱 ${won(amount)} = <b>€${(amount / r.EUR).toFixed(2)}</b> · <b>${(amount / r.CHF).toFixed(2)} CHF</b> · $${(amount / r.USD).toFixed(2)}`;
    return `💱 ${money(amount, cur)} = <b>${won(amount * r[cur])}</b>\n<i>1${cur === 'EUR' ? '€' : ' ' + cur} = ${won(r[cur])}</i>`;
  }

  // ---------- 메시지 ----------
  async function weatherOf(c) {
    if (mock) return `☀️ <b>${c.emoji} ${c.name}</b> 지금 15° (모의)`;
    try { const city = await BR.geocode(getJSON, c.name); return BR.weatherText({ ...city, name: `${c.emoji} ${c.name}` }, await BR.weather(getJSON, city)); }
    catch (e) { return `날씨 ⚠ ${esc(e.message)}`; }
  }
  function itinerary() {
    const d = tripDate();
    return C.map(c => {
      const n = diffDays(c.to, c.from) + 1, here = d >= c.from && d <= c.to, past = d > c.to;
      return `${here ? '▶' : past ? '✓' : '·'} ${md(c.from).replace(/ \(.\)/, '')}–${md(c.to).replace(/ \(.\)/, '')} ${c.emoji} ${here ? `<b>${c.name}</b>` : c.name} ${n}박${c.cur === 'CHF' ? ' (CHF)' : ''}`;
    }).join('\n');
  }
  function dleft() { return diffDays(FIRST, kstDate()); }
  function checklistDue() {
    const done = new Set(T.done || []), dl = dleft();
    return cfg.checklist.map(([off, text], i) => ({ i, off, text, due: dl <= -off, done: done.has(i) }));
  }
  // 출발 전 아침 브리핑에 붙는 한 블록
  function briefSection() {
    const ph = phase();
    if (ph === 'after') return '';
    if (ph === 'during') return '';
    const dl = dleft(), todo = checklistDue().filter(x => x.due && !x.done);
    if (dl > 60) return '';
    return `✈️ <b>${esc(cfg.name)} D-${dl}</b> · ${md(FIRST)} ${C[0].emoji} ${C[0].name} 출발` +
      (todo.length ? `\n${todo.slice(0, 3).map(x => `☐ ${esc(x.text)} <code>/done ${x.i + 1}</code>`).join('\n')}${todo.length > 3 ? `\n… 외 ${todo.length - 3}개 /check` : ''}` : '\n✅ 지금까지 할 일 모두 완료');
  }
  async function morningMsg() {
    const t = today(), c = t.city, r = await rates();
    const y = dayLine(addDays(t.date, -1));
    return [
      `☀️ <b>Day ${t.day}/${TOTAL}</b> · ${c.emoji} <b>${c.name}</b> ${md(t.date)}${t.day === 1 ? '\n🎉 여행 시작! 즐거운 여행 되세요' : ''}`,
      await weatherOf(c),
      moveNote(t.date),
      cfg.safety[c.name] ? `⚠ ${esc(cfg.safety[c.name])}` : '',
      `💶 1€ = ${won(r.EUR)} · 1 CHF = ${won(r.CHF)}`,
      (y ? `어제 지출 ${y} · ` : '') + `누적 ${won(sum(data.spends))}` + (budgetLine() ? `\n${budgetLine()}` : ''),
      `<i>지출은 그냥 "점심 18유로"처럼 보내면 기록돼요 · /today /spent</i>`,
    ].filter(Boolean).join('\n\n');
  }
  function eveningMsg() {
    const t = today(), xs = data.spends.filter(x => x.date === t.date);
    return [
      `🌙 <b>오늘 정리</b> · Day ${t.day} ${t.city.emoji} ${t.city.name}`,
      xs.length ? `지출 <b>${dayLine(t.date)}</b>\n${byCat(xs).join(' · ')}` : '오늘 기록된 지출이 없어요 — 빠진 게 있으면 지금 적어두세요 (예: 저녁 32유로)',
      `누적 ${won(sum(data.spends))}` + (budgetLine() ? `\n${budgetLine()}` : ''),
      moveNote(t.date).startsWith('🚆 내일') || moveNote(t.date).startsWith('🏁 내일') ? moveNote(t.date) : '',
    ].filter(Boolean).join('\n\n');
  }
  function report(xs, title) {
    if (!xs.length) return `💸 <b>${title}</b>\n기록된 지출이 없어요. "점심 18유로"처럼 보내보세요.`;
    const days = [...new Set(xs.map(x => x.date))].length;
    const cities = C.map(c => [c, sum(xs.filter(x => x.city === c.name))]).filter(([, v]) => v > 0).map(([c, v]) => `${c.emoji} ${c.name} ${won(v)}`);
    const pre = sum(xs.filter(x => x.city === '출발 전'));
    return `💸 <b>${title}</b>\n합계 <b>${won(sum(xs))}</b> · ${xs.length}건${days > 1 ? ` · 하루 평균 ${won(sum(xs) / days)}` : ''}\n\n${byCat(xs).join('\n')}` +
      (cities.length > 1 || pre ? `\n\n<b>도시별</b>\n${cities.join(' · ')}${pre ? `${cities.length ? ' · ' : ''}✈️ 출발 전 ${won(pre)}` : ''}` : '') +
      (budgetLine() ? `\n\n${budgetLine()}` : '');
  }
  function listDay(d) {
    const xs = data.spends.filter(x => x.date === d);
    return xs.map(x => `${CAT_ICON[x.cat]} ${esc(x.text)} ${money(x.amount, x.cur)}${x.cur !== 'KRW' ? ` · ${won(x.krw)}` : ''}${x.pay === '현금' ? ' 💵' : ''}`).join('\n');
  }
  function csv() {
    const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
    const rows = [['날짜', '시각(한국)', '도시', '분류', '내용', '금액', '통화', '환율', '원화', '결제']];
    for (const x of data.spends) rows.push([x.date, zoned(x.at, 'Asia/Seoul').hm, x.city, x.cat, x.text, x.amount, x.cur, x.rate, x.krw, x.pay]);
    return rows.map(r => r.map(q).join(',')).join('\n');
  }

  // ---------- 명령어 ----------
  const COMMANDS = ['/trip', '/today', '/spent', '/undo', '/budget', '/export', '/won', '/check', '/done'];
  async function command(c, args) {
    switch (c) {
      case '/trip': {
        const ph = phase(), t = today();
        const head = ph === 'before' ? `✈️ <b>${esc(cfg.name)}</b> D-${dleft()} · ${TOTAL}일` : ph === 'during' ? `✈️ <b>${esc(cfg.name)}</b> Day ${t.day}/${TOTAL}` : `✈️ <b>${esc(cfg.name)}</b> 끝 (${TOTAL}일)`;
        return `${head}\n\n${itinerary()}\n\n누적 지출 ${won(sum(data.spends))}${budgetLine() ? `\n${budgetLine()}` : ''}`;
      }
      case '/today': {
        const ph = phase();
        if (ph !== 'during') {
          const n = data.spends.filter(x => x.date === kstDate());
          return (ph === 'before' ? `✈️ 출발까지 <b>D-${dleft()}</b> (${md(FIRST)} ${C[0].emoji} ${C[0].name})\n\n${await weatherOf(C[0])}` : '🏠 여행이 끝났어요. /spent all 로 전체 정리를 볼 수 있어요.') +
            (n.length ? `\n\n오늘 기록\n${listDay(kstDate())}` : '');
        }
        const t = today(), xs = listDay(t.date);
        return `📍 <b>Day ${t.day}/${TOTAL}</b> · ${t.city.emoji} <b>${t.city.name}</b> ${md(t.date)} · 현지 ${t.local.hm}\n\n${await weatherOf(t.city)}` +
          (moveNote(t.date) ? `\n\n${moveNote(t.date)}` : '') + (cfg.safety[t.city.name] ? `\n\n⚠ ${esc(cfg.safety[t.city.name])}` : '') +
          `\n\n<b>오늘 지출</b> ${dayLine(t.date) || '없음'}${xs ? `\n${xs}` : ''}`;
      }
      case '/spent': {
        const a = args.join(' ');
        if (!a || a === '오늘') { const d = phase() === 'during' ? tripDate() : kstDate(); const xs = data.spends.filter(x => x.date === d); return report(xs, `오늘 지출 ${md(d)}`) + (xs.length ? `\n\n${listDay(d)}` : ''); }
        if (a === '어제') { const d = addDays(phase() === 'during' ? tripDate() : kstDate(), -1); return report(data.spends.filter(x => x.date === d), `어제 지출 ${md(d)}`) + `\n\n${listDay(d)}`; }
        if (a === 'all' || a === '전체') return report(data.spends, '전체 지출');
        const c = C.find(x => x.name === a.replace(/\s+/g, ''));
        if (c) return report(data.spends.filter(x => x.city === c.name), `${c.emoji} ${c.name} 지출`);
        return '사용법: /spent [오늘|어제|전체|도시이름]';
      }
      case '/undo': {
        const x = data.spends.pop();
        if (!x) return '지울 기록이 없어요.';
        save();
        return `↩️ 삭제: ${CAT_ICON[x.cat]} ${esc(x.text)} ${money(x.amount, x.cur)} (${x.date})`;
      }
      case '/budget': {
        if (!args[0]) return budgetLine() || '예산이 없어요. 예: /budget 300만원';
        const m = parseMoney(args.join(' '));
        if (!m) return '예: /budget 300만원 또는 /budget 3000000';
        T.budget = m.unit === '만원' ? m.amount * 1e4 : m.unit && UNIT[m.unit] !== 'KRW' ? m.amount * (await rates())[UNIT[m.unit]] : m.amount;
        return `💰 예산 설정: <b>${won(T.budget)}</b>\n${budgetLine()}`;
      }
      case '/export': {
        if (!data.spends.length) return '내보낼 지출 기록이 없어요.';
        await sendDoc(`여행지출_${kstDate()}.csv`, csv(), `💾 지출 ${data.spends.length}건 · 합계 ${won(sum(data.spends))} (엑셀·구글시트에서 열 수 있어요)`);
        return null;
      }
      case '/won': return (await convert(args.join(' '))) || '예: /won 50유로, /won 30 chf, /won 10만원';
      case '/check': {
        const items = checklistDue();
        return `📝 <b>출발 전 체크리스트</b> (D-${Math.max(0, dleft())})\n` + items.map(x => `${x.done ? '✅' : x.due ? '☐' : '·'} ${x.done ? `<s>${esc(x.text)}</s>` : esc(x.text)} <i>D${x.off}</i>${!x.done ? ` <code>/done ${x.i + 1}</code>` : ''}`).join('\n') +
          `\n\n<i>☐ 지금 할 일 · 나중 할 일 · /done 번호 로 완료</i>`;
      }
      case '/done': {
        const i = +args[0] - 1;
        if (!cfg.checklist[i]) return '사용법: /done 번호 (/check 에서 확인)';
        T.done = [...new Set([...(T.done || []), i])];
        const left = checklistDue().filter(x => x.due && !x.done).length;
        return `✅ 완료: ${esc(cfg.checklist[i][1])}${left ? `\n남은 할 일 ${left}개 /check` : '\n🎉 지금 할 일은 다 했어요!'}`;
      }
    }
  }
  // 슬래시 없는 메시지: 환산("50유로 얼마") → 지출 기록 → 아니면 null
  async function text(t) {
    const m = parseMoney(t);
    // "50유로 얼마", "30 chf?", 또는 금액만 달랑 → 환산
    if (m?.unit && (/얼마|환산|\?$/.test(t) || !t.replace(m.raw, '').trim())) return convert(t);
    return record(t);
  }

  // ---------- 예약 메시지 (scan.js가 매번 호출) ----------
  async function tick() {
    const out = [], ph = phase();
    if (ph === 'during') {
      const t = today();
      if (t.local.hour >= cfg.morningHour && t.local.hour < 14 && T.morning !== t.date) { T.morning = t.date; out.push(await morningMsg()); }
      if (t.local.hour >= cfg.eveningHour && T.evening !== t.date) { T.evening = t.date; out.push(eveningMsg()); }
    }
    if (ph === 'after' && !T.final && zoned(now(), 'Asia/Seoul').hour >= 10) {
      T.final = true;
      out.push(`🏠 <b>여행 끝! 수고했어요</b>\n\n${report(data.spends, `${cfg.name} 전체 정리 (${TOTAL}일)`)}\n\n<i>/export 로 엑셀 파일을 받을 수 있어요</i>`);
    }
    return out;
  }
  // 여행 중에는 하루 요약 시각을 현지 아침으로
  function dailyClock() { if (phase() !== 'during') return null; const t = today(); return { hour: t.local.hour, date: t.date, at: cfg.morningHour }; }

  return { cfg, phase, today, command, text, tick, briefSection, dailyClock, COMMANDS, save, _data: () => data, parseMoney, csv };
};

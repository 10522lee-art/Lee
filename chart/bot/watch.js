// 웹페이지 변경 감지: HTML → 텍스트 줄 목록 → 이전과 비교
const crypto = require('crypto');
const MAX_BYTES = 2_000_000, MAX_LINES = 300, MAX_LINE = 160;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', won: '₩', euro: '€', yen: '¥', pound: '£' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1); try { return String.fromCodePoint(n); } catch { return m; } }
    return ENT[e.toLowerCase()] ?? m;
  });
}
function htmlToLines(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|nav|main|aside|dd|dt|dl|option|button|a|span|label|form|blockquote|pre|figure|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decode(s);
  const out = [], seen = new Set();
  for (let l of s.split(/\n/)) {
    l = l.replace(/\s+/g, ' ').trim();
    if (!l || l.length < 2) continue;
    if (l.length > MAX_LINE) l = l.slice(0, MAX_LINE) + '…';
    if (seen.has(l)) continue; // 같은 줄 반복은 하나로
    seen.add(l); out.push(l);
  }
  return out;
}
const hash = lines => crypto.createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16);

function diff(oldLines, newLines) {
  const a = new Set(oldLines), b = new Set(newLines);
  return { added: newLines.filter(l => !a.has(l)), removed: oldLines.filter(l => !b.has(l)) };
}

async function fetchPage(url, ua) {
  const r = await fetch(url, { headers: { 'User-Agent': ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept-Language': 'ko,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer()).subarray(0, MAX_BYTES);
  const ct = r.headers.get('content-type') || '';
  // charset 처리 (EUC-KR 사이트 대비)
  let cs = (ct.match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) cs = (buf.subarray(0, 4000).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  let text;
  try { text = new TextDecoder(cs || 'utf-8').decode(buf); } catch { text = buf.toString('utf8'); }
  const title = decode((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const lines = /json|text\/plain/.test(ct) ? text.split(/\n/).map(l => l.trim()).filter(Boolean) : htmlToLines(text);
  return { lines, title };
}

// 한 번 확인 → 알림 메시지(있으면) 반환. w 객체(state)는 직접 갱신
async function check(w, fetcher = fetchPage) {
  let page;
  try { page = await fetcher(w.url); }
  catch (e) {
    w.fails = (w.fails || 0) + 1;
    return w.fails === 6 ? { kind: 'error', msg: e.message } : null; // 3시간 연속 실패 시 한 번만 알림
  }
  w.fails = 0;
  if (page.title && !w.title) w.title = page.title;
  const lines = page.lines.slice(0, 5000);
  const h = hash(lines);
  w.checked = Math.floor(Date.now() / 1000);
  if (w.keyword) {
    const kw = w.keyword.toLowerCase();
    const has = lines.some(l => l.toLowerCase().includes(kw));
    const prev = w.has;
    w.has = has;
    if (prev == null || prev === has) return null;
    const ctx = has ? lines.filter(l => l.toLowerCase().includes(kw)).slice(0, 3) : [];
    return { kind: has ? 'appeared' : 'gone', ctx };
  }
  if (!w.hash) { w.hash = h; w.lines = lines.slice(0, MAX_LINES); return null; }
  if (w.hash === h) return null;
  const d = diff(w.lines || [], lines.slice(0, MAX_LINES));
  w.hash = h; w.lines = lines.slice(0, MAX_LINES);
  if (!d.added.length && !d.removed.length) return null; // 300줄 뒤쪽만 바뀐 경우 등
  w.changes = (w.changes || 0) + 1;
  return { kind: 'changed', ...d };
}

module.exports = { htmlToLines, diff, hash, fetchPage, check, decode };

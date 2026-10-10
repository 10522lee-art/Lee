// 아침 브리핑: 날씨(Open-Meteo, 키 불필요) + 환율 + 주요 지수
const WMO = {
  0: ['☀️', '맑음'], 1: ['🌤', '대체로 맑음'], 2: ['⛅', '구름 조금'], 3: ['☁️', '흐림'],
  45: ['🌫', '안개'], 48: ['🌫', '서리 안개'],
  51: ['🌦', '약한 이슬비'], 53: ['🌦', '이슬비'], 55: ['🌧', '강한 이슬비'], 56: ['🌧', '어는 이슬비'], 57: ['🌧', '어는 이슬비'],
  61: ['🌧', '약한 비'], 63: ['🌧', '비'], 65: ['🌧', '강한 비'], 66: ['🌧', '어는 비'], 67: ['🌧', '어는 비'],
  71: ['🌨', '약한 눈'], 73: ['🌨', '눈'], 75: ['❄️', '많은 눈'], 77: ['🌨', '싸락눈'],
  80: ['🌦', '소나기'], 81: ['🌧', '소나기'], 82: ['⛈', '강한 소나기'], 85: ['🌨', '눈 소나기'], 86: ['❄️', '강한 눈 소나기'],
  95: ['⛈', '뇌우'], 96: ['⛈', '우박 뇌우'], 99: ['⛈', '강한 우박 뇌우'],
};
const wmo = c => WMO[c] || ['🌡', `날씨코드 ${c}`];

// 자주 쓰는 도시는 지오코딩 없이 바로 (한글 이름 검색 실패 대비)
const CITIES = {
  서울: [37.5665, 126.978, 'Asia/Seoul'], 부산: [35.1796, 129.0756, 'Asia/Seoul'], 인천: [37.4563, 126.7052, 'Asia/Seoul'],
  대구: [35.8714, 128.6014, 'Asia/Seoul'], 대전: [36.3504, 127.3845, 'Asia/Seoul'], 광주: [35.1595, 126.8526, 'Asia/Seoul'],
  제주: [33.4996, 126.5312, 'Asia/Seoul'], 수원: [37.2636, 127.0286, 'Asia/Seoul'], 울산: [35.5384, 129.3114, 'Asia/Seoul'],
  도쿄: [35.6762, 139.6503, 'Asia/Tokyo'], 오사카: [34.6937, 135.5023, 'Asia/Tokyo'], 뉴욕: [40.7128, -74.006, 'America/New_York'],
  런던: [51.5072, -0.1276, 'Europe/London'], 파리: [48.8566, 2.3522, 'Europe/Paris'], 로마: [41.9028, 12.4964, 'Europe/Rome'],
  바르셀로나: [41.3874, 2.1686, 'Europe/Madrid'], 마드리드: [40.4168, -3.7038, 'Europe/Madrid'], 베를린: [52.52, 13.405, 'Europe/Berlin'],
  뮌헨: [48.1351, 11.582, 'Europe/Berlin'], 프라하: [50.0755, 14.4378, 'Europe/Prague'], 빈: [48.2082, 16.3738, 'Europe/Vienna'],
  부다페스트: [47.4979, 19.0402, 'Europe/Budapest'], 암스테르담: [52.3676, 4.9041, 'Europe/Amsterdam'], 취리히: [47.3769, 8.5417, 'Europe/Zurich'],
  인터라켄: [46.6863, 7.8632, 'Europe/Zurich'], 피렌체: [43.7696, 11.2558, 'Europe/Rome'], 베네치아: [45.4408, 12.3155, 'Europe/Rome'],
  밀라노: [45.4642, 9.19, 'Europe/Rome'], 리스본: [38.7223, -9.1393, 'Europe/Lisbon'], 니스: [43.7102, 7.262, 'Europe/Paris'],
};

async function geocode(getJSON, q) {
  const k = q.replace(/\s+/g, '');
  if (CITIES[k]) { const [lat, lon, tz] = CITIES[k]; return { name: k, lat, lon, tz }; }
  const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=ko&format=json`);
  const r = j.results?.[0];
  if (!r) throw new Error(`도시를 찾지 못했습니다: ${q}`);
  return { name: r.name + (r.country ? `, ${r.country}` : ''), lat: r.latitude, lon: r.longitude, tz: r.timezone || 'auto' };
}

async function weather(getJSON, city) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max` +
    `&timezone=${encodeURIComponent(city.tz || 'auto')}&forecast_days=2`;
  const j = await getJSON(u), c = j.current, d = j.daily;
  const day = i => ({ code: d.weather_code[i], max: d.temperature_2m_max[i], min: d.temperature_2m_min[i], rain: d.precipitation_probability_max?.[i], uv: d.uv_index_max?.[i] });
  return { now: { temp: c.temperature_2m, feels: c.apparent_temperature, code: c.weather_code, wind: c.wind_speed_10m }, today: day(0), tomorrow: day(1) };
}

const r0 = x => x == null ? '-' : Math.round(x);
function weatherText(city, w) {
  const [ne, nt] = wmo(w.now.code), [te, tt] = wmo(w.today.code), [me, mt] = wmo(w.tomorrow.code);
  const tips = [];
  if (w.today.rain >= 60) tips.push('☂️ 우산 챙기세요');
  else if (w.today.rain >= 30) tips.push('🌂 작은 우산 있으면 좋아요');
  if (w.today.max - w.today.min >= 10) tips.push('🧥 일교차 큼 — 겉옷');
  if (w.today.max >= 30) tips.push('🥵 더위 주의');
  if (w.today.min <= 0) tips.push('🧤 영하권');
  if (w.today.uv >= 7) tips.push('🧴 자외선 강함');
  return `${ne} <b>${city.name}</b> 지금 ${r0(w.now.temp)}° (체감 ${r0(w.now.feels)}°) ${nt}\n` +
    `오늘 ${te} ${tt} · ${r0(w.today.min)}° / ${r0(w.today.max)}° · 강수 ${r0(w.today.rain)}%\n` +
    `내일 ${me} ${mt} · ${r0(w.tomorrow.min)}° / ${r0(w.tomorrow.max)}° · 강수 ${r0(w.tomorrow.rain)}%` +
    (tips.length ? `\n${tips.join(' · ')}` : '');
}

// 전일 대비 등락 (Yahoo 일봉)
async function yahooChange(getJSON, ticker) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`);
  const r = j.chart.result[0], closes = r.indicators.quote[0].close.filter(x => x != null);
  const price = r.meta.regularMarketPrice ?? closes.at(-1);
  // 오늘 봉이 이미 있으면 그 전날 종가, 없으면 마지막 종가가 전일 종가
  const prev = closes.length >= 2 && Math.abs(closes.at(-1) - price) < 1e-9 ? closes.at(-2) : closes.at(-1);
  return { price, chg: prev ? (price / prev - 1) * 100 : null };
}
async function binanceChange(getJSON, sym) {
  const j = await getJSON(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${sym}`);
  return { price: +j.lastPrice, chg: +j.priceChangePercent };
}

const MARKETS = [
  { group: '환율', label: '달러', t: 'USDKRW=X', unit: '원' },
  { group: '환율', label: '유로', t: 'EURKRW=X', unit: '원' },
  { group: '환율', label: '엔(100)', t: 'JPYKRW=X', unit: '원', mul: 100 },
  { group: '지수', label: '코스피', t: '^KS11' },
  { group: '지수', label: '코스닥', t: '^KQ11' },
  { group: '지수', label: 'S&P500', t: '^GSPC' },
  { group: '지수', label: '나스닥', t: '^IXIC' },
  { group: '코인', label: 'BTC', bn: 'BTCUSDT', unit: '$' },
  { group: '코인', label: 'ETH', bn: 'ETHUSDT', unit: '$' },
];
const num = (x, d) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
async function markets(getJSON, list = MARKETS) {
  const res = await Promise.all(list.map(async m => {
    try {
      const q = m.bn ? await binanceChange(getJSON, m.bn) : await yahooChange(getJSON, m.t);
      return { ...m, price: q.price * (m.mul || 1), chg: q.chg };
    } catch (e) { return { ...m, err: e.message }; }
  }));
  return res;
}
function marketsText(rows) {
  const groups = {};
  for (const r of rows) {
    const arrow = r.chg == null ? '' : r.chg > 0.05 ? '▲' : r.chg < -0.05 ? '▼' : '–';
    const v = r.err ? '?' : (r.unit === '$' ? '$' : '') + num(r.price, r.price >= 10000 ? 0 : 2) + (r.unit === '원' ? '원' : '');
    (groups[r.group] ||= []).push(`${r.label} <b>${v}</b>${r.chg == null || r.err ? '' : ` ${arrow}${Math.abs(r.chg).toFixed(2)}%`}`);
  }
  return Object.entries(groups).map(([g, xs]) => `<b>${g}</b>  ${xs.join(' · ')}`).join('\n');
}

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
function kstDateLabel(ms = Date.now()) {
  const d = new Date(ms + 9 * 3600e3);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} (${DOW[d.getUTCDay()]})`;
}

module.exports = { geocode, weather, weatherText, markets, marketsText, kstDateLabel, wmo, CITIES, MARKETS };

// Node 전용: 여행 지출 데이터를 공개 저장소에 둘 때 쓰는 암호화 파일 (AES-256-GCM, 키 = 봇 토큰에서 파생)
// Cloudflare Workers 버전은 비공개 Durable Object 저장소를 쓰므로 필요 없음
const fs = require('fs'), crypto = require('crypto');
const keyOf = token => crypto.createHash('sha256').update('trip-data:' + token).digest();

function encrypt(obj, token) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keyOf(token), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: enc.toString('base64') };
}
function decrypt(raw, token) {
  if (!raw.iv) return raw; // 평문(테스트용)
  const d = crypto.createDecipheriv('aes-256-gcm', keyOf(token), Buffer.from(raw.iv, 'base64'));
  d.setAuthTag(Buffer.from(raw.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(raw.data, 'base64')), d.final()]).toString('utf8'));
}
// 토큰이 없으면 평문 (테스트), 파일 경로가 없으면 저장 안 함
function loadTrip(file, token) {
  if (!file || !fs.existsSync(file)) return { spends: [] };
  try { return decrypt(JSON.parse(fs.readFileSync(file, 'utf8')), token); }
  catch (e) {
    console.log('여행 데이터 복호화 실패 — 새로 시작 (기존 파일은 .bak으로 보관)', e.message);
    try { fs.copyFileSync(file, file + '.bak'); } catch { }
    return { spends: [] };
  }
}
function saveTrip(file, token, data) {
  if (!file) return;
  fs.writeFileSync(file, token ? JSON.stringify(encrypt(data, token)) + '\n' : JSON.stringify(data));
}
// Workers 이사용 비밀값 (토큰에서 파생 → 따로 시크릿을 만들 필요 없음)
const derive = (token, label) => crypto.createHash('sha256').update(label + ':' + token).digest('hex');

module.exports = { encrypt, decrypt, loadTrip, saveTrip, derive };

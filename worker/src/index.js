// 텔레그램 봇 — Cloudflare Workers 버전 (항상 켜짐, 무료)
// • 텔레그램 웹훅으로 메시지를 받아 바로 답장 (GitHub Actions 상주 대신)
// • 5분마다 cron: 가격 알림, 종목 1개 분석(돌아가며), 페이지 감시, 브리핑·여행 알림
// • 모든 상태는 Durable Object 한 개에 저장 → 요청이 순서대로 처리돼 동시에 고쳐 쓰는 문제 없음
// 봇 로직은 chart/bot/core.js (GitHub Actions 버전과 같은 코드)
import { DurableObject } from 'cloudflare:workers';
import createBot from '../../chart/bot/core.js';
import DEFAULT_CFG from '../../chart/bot/watchlist.json';
import renderDashboard from '../../chart/bot/dash.js';

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
// 비밀값은 봇 토큰에서 파생 (chart/bot/secure.js의 derive와 같은 방식) → 따로 시크릿을 만들 필요 없음
const derive = async (token, label) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${label}:${token}`)));
const webhookSecret = async token => (await derive(token, 'wh')).slice(0, 48);
const json = (o, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), stub = env.BOT.get(env.BOT.idFromName('main'));
    if (url.pathname === '/tg' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await webhookSecret(env.TELEGRAM_BOT_TOKEN)) return new Response('forbidden', { status: 403 });
      const update = await req.json();
      ctx.waitUntil(stub.onUpdate(update, url.origin)); // 텔레그램에는 바로 200 (재전송 방지), 처리는 이어서
      return new Response('ok');
    }
    if (url.pathname.startsWith('/api/')) {
      // 관리용 (배포 워크플로가 이사·확인할 때 사용): Authorization: Bearer sha256("admin:" + 봇토큰)
      if (req.headers.get('authorization') !== `Bearer ${await derive(env.TELEGRAM_BOT_TOKEN, 'admin')}`) return json({ error: 'unauthorized' }, 401);
      if (url.pathname === '/api/import' && req.method === 'POST') return json(await stub.importData(await req.json(), url.searchParams.has('force')));
      if (url.pathname === '/api/export') return json(await stub.exportData());
      if (url.pathname === '/api/tick') return json(await stub.tick('manual'));
      if (url.pathname === '/api/message' && req.method === 'POST') { const { text } = await req.json(); return json(await stub.onUpdate({ message: { chat: { id: 'admin' }, text, admin: true } })); }
      return json({ error: 'not found' }, 404);
    }
    if (url.pathname === '/health') return json(await stub.health());
    // 개인 대시보드: /d/<봇 토큰에서 파생한 비밀 키>  (텔레그램 /dash 로 링크 받기)
    if (url.pathname.startsWith('/d/')) {
      if (url.pathname.slice(3) !== (await derive(env.TELEGRAM_BOT_TOKEN, 'dash')).slice(0, 32)) return new Response('not found', { status: 404 });
      const d = await stub.exportData();
      return new Response(renderDashboard({ cfg: d.cfg || DEFAULT_CFG, state: d.state || {}, trip: d.trip || { spends: [] } }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' } });
    }
    return new Response('lee-bot ✓', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(env.BOT.get(env.BOT.idFromName('main')).tick(ev.cron));
  },
};

export class Bot extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.token = (env.TELEGRAM_BOT_TOKEN || '').trim();
    this.dry = !!env.BOT_DRY;          // 로컬 테스트: 텔레그램 대신 _outbox에 쌓음
    this.mock = !!env.BOT_MOCK;        // 로컬 테스트: 가짜 시세
    this.queue = Promise.resolve();    // 요청을 한 번에 하나씩 (메모리 큐 — blockConcurrencyWhile의 30초 리셋 제한을 피함)
  }

  async tg(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());
    if (!r.ok) throw new Error(`텔레그램 ${method} 실패: ${r.description}`);
    return r.result;
  }

  // 저장소에서 읽어 봇을 만들고 fn 실행 후 저장. 큐로 한 번에 하나씩만 실행 → 동시에 와도 데이터 안 꼬임
  run(fn, origin) {
    const job = this.queue.then(async () => {
      const m = await this.ctx.storage.get(['cfg', 'state', 'trip']);
      const cfg = m.get('cfg') || structuredClone(DEFAULT_CFG), state = m.get('state') || {}, trip = m.get('trip') || { spends: [] };
      const out = [];
      const send = async text => {
        if (this.dry || !state._chatId) { out.push(text); return; }
        for (let i = 0; i < text.length; i += 3900) await this.tg('sendMessage', { chat_id: state._chatId, text: text.slice(i, i + 3900), parse_mode: 'HTML', disable_web_page_preview: true });
      };
      const sendDoc = async (name, content, caption) => {
        if (this.dry || !state._chatId) { out.push(`[파일 ${name}] ${caption}\n${content.slice(0, 300)}`); return; }
        const fd = new FormData();
        fd.append('chat_id', String(state._chatId)); fd.append('caption', caption); fd.append('parse_mode', 'HTML');
        fd.append('document', new Blob(['﻿' + content], { type: 'text/csv' }), name);
        const r = await fetch(`https://api.telegram.org/bot${this.token}/sendDocument`, { method: 'POST', body: fd }).then(r => r.json());
        if (!r.ok) throw new Error(`텔레그램 sendDocument 실패: ${r.description}`);
      };
      if (origin) state._base = origin; // 대시보드 링크용 워커 주소
      this.dashKey ||= (await derive(this.token, 'dash')).slice(0, 32);
      const dashUrl = state._base ? `${state._base}/d/${this.dashKey}` : null;
      const bot = createBot({ cfg, state, tripData: trip, send, sendDoc, env: { mode: 'cloud', mock: this.mock, candles: 300, fetchTimeout: 6000, dashUrl } });
      let result;
      try { result = await fn(bot, state); }
      catch (e) { console.error('처리 실패', e.stack || e); result = { error: String(e.message || e) }; }
      if (this.dry) state._outbox = [...(state._outbox || []), ...out].slice(-30);
      await this.ctx.storage.put({ cfg, state, trip });
      return { ...result, sent: out.length ? out : undefined };
    });
    this.queue = job.catch(() => { });
    return job;
  }

  // 텔레그램 메시지 1개
  onUpdate(update, origin) {
    return this.run(async (bot, state) => {
      const m = update.message || update.edited_message;
      if (!m?.chat || !m.text) return { skipped: true };
      if (!m.admin) {
        if (this.env.TELEGRAM_CHAT_ID) state._chatId = +this.env.TELEGRAM_CHAT_ID;
        if (!state._chatId) state._chatId = m.chat.id; // 처음 말 건 사람이 주인
        if (m.chat.id !== state._chatId) return { skipped: 'not owner' };
        if (!this.dry) this.tg('sendChatAction', { chat_id: state._chatId, action: 'typing' }).catch(() => { });
      }
      const reply = await bot.handle(m.text.trim());
      if (reply) await bot.sendReply(reply);
      await bot.afterCommands();
      if (!this.dry) await bot.registerCommands((method, body) => this.tg(method, body));
      return { ok: true };
    }, origin);
  }

  // 5분마다. 종목은 한 번에 1개씩 돌아가며 분석 (무료 요금제 CPU 한도 안에서), 페이지 감시는 격회로 2개씩
  tick(cron) {
    return this.run(async (bot, state) => {
      const n = bot.symbolCount();
      const k = state._tickNo = (state._tickNo || 0) + 1;
      const scan = n && k % 2 === 1 ? [(state._scanIdx = ((state._scanIdx ?? -1) + 1) % n)] : null;
      const st = await bot.cycle({ scan, watches: k % 2 === 0 ? 2 : false, daily: true });
      state._lastTick = Date.now();
      if (!this.dry) await bot.registerCommands((method, body) => this.tg(method, body));
      return { cron, ...st };
    });
  }

  // GitHub Actions 버전의 state.json / watchlist.json / 여행 데이터를 옮겨 담기 (처음 한 번)
  importData(d, force) {
    const job = this.queue.then(async () => {
      if (!force && await this.ctx.storage.get('state')) return { imported: false, reason: '이미 데이터가 있음 (?force 로 덮어쓰기)' };
      const put = {};
      if (d.cfg) put.cfg = d.cfg;
      if (d.state) { put.state = d.state; delete put.state._offset; }
      if (d.trip) put.trip = d.trip;
      await this.ctx.storage.put(put);
      return { imported: true, keys: Object.keys(put), alerts: d.state?._alerts?.length || 0, watches: d.state?._watches?.length || 0, spends: d.trip?.spends?.length || 0 };
    });
    this.queue = job.catch(() => { });
    return job;
  }
  async exportData() {
    const m = await this.ctx.storage.get(['cfg', 'state', 'trip']);
    return { cfg: m.get('cfg') || null, state: m.get('state') || null, trip: m.get('trip') || null };
  }
  async health() {
    const s = await this.ctx.storage.get('state');
    return { ok: true, owner: !!s?._chatId, lastTick: s?._lastTick ? new Date(s._lastTick).toISOString() : null, alerts: s?._alerts?.length || 0, watches: s?._watches?.length || 0 };
  }
}

/* ============================================================
   MiroxAI Backend v86
   - Fixed identity prompt (no "hey I'm Mirox" glazing)
   - API keys (free: 2, pro/ultimate: 10) with rename/revoke/delete
   - Admin endpoints (auth / stats / set-tier)
   - Image history storage + endpoint
   ============================================================ */

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HF_API_KEY = (process.env.HF_API_KEY || '').trim();
const PL_KEY     = (process.env.PL_KEY || '').trim();
const AR_KEY     = (process.env.AR_KEY || '').trim();
const F_API      = (process.env.F_API || '').trim();
const SECRET     = process.env.SECRET_KEY || 'mirox-fallback-secret';
const ADMIN_PASS = (process.env.ADMIN_PASSWORD || '2010').trim();
const PORT       = process.env.PORT || 3000;
const DB_FILE    = process.env.DB_FILE || '/tmp/mirox-db.json';

const IMG_TOTAL_MS  = 60000;
const MAX_LOGS      = 500;
const GENERIC_ERR   = 'Mirox AI encountered an error';

const PROVIDERS = { hf: !!HF_API_KEY, pl: !!PL_KEY, ar: !!AR_KEY, fish: !!F_API };
console.log('[Mirox] v86 — keys + admin + image history');

/* ---------- Helpers ---------- */
const safe = (v, max = 100000) => {
  try { if (v == null) return ''; const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > max ? s.slice(0, max) : s; } catch { return ''; }
};
const safeArr = v => { try { return Array.isArray(v) ? v : []; } catch { return []; } };

function extractReplyText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.text === 'string') return data.text;
  if (typeof data.reply === 'string') return data.reply;
  if (Array.isArray(data.choices) && data.choices[0]) {
    const c = data.choices[0].message?.content ?? data.choices[0].text ?? '';
    return typeof c === 'string' ? c : '';
  }
  if (typeof data.output === 'string') return data.output;
  if (typeof data.content === 'string') return data.content;
  return '';
}
async function fetchT(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

/* ---------- DB ---------- */
let db = null, dbReady = false, writeChain = Promise.resolve();
const emptyDb = () => ({ users: {}, apiKeys: {}, counters: {}, chats: [], images: [], events: [] });
async function loadDb() {
  if (db) return db;
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    db = Object.assign(emptyDb(), JSON.parse(raw));
    db.users = db.users || {}; db.apiKeys = db.apiKeys || {}; db.counters = db.counters || {};
    db.chats = Array.isArray(db.chats) ? db.chats : [];
    db.images = Array.isArray(db.images) ? db.images : [];
    db.events = Array.isArray(db.events) ? db.events : [];
    dbReady = true;
  } catch (e) {
    if (e.code === 'ENOENT') { db = emptyDb(); dbReady = true; try { await fs.writeFile(DB_FILE, JSON.stringify(db), 'utf8'); } catch {} }
    else { db = emptyDb(); dbReady = false; }
  }
  return db;
}
function persist() {
  if (!db) return Promise.resolve();
  writeChain = writeChain.then(async () => { try { await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf8'); } catch {} });
  return writeChain;
}
const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);

function pushLog(arr, item, cap = MAX_LOGS) {
  try {
    arr.push(item);
    if (arr.length > cap) arr.splice(0, arr.length - cap);
  } catch {}
}

async function getUser(email) { await loadDb(); const u = db.users[email]; return u ? { ...u } : null; }
async function saveUser(rec) {
  await loadDb();
  if (!rec || !rec.email) return false;
  db.users[rec.email] = {
    email: rec.email, name: rec.name || '', tier: rec.tier || 'free',
    daily_used: rec.daily_used || 0, vision_used: rec.vision_used || 0,
    image_used: rec.image_used || 0, eclipse_used: rec.eclipse_used || 0,
    daily_reset: rec.daily_reset || today(), month_key: rec.month_key || monthKey(),
    keys_this_month: rec.keys_this_month || 0, created_at: rec.created_at || now(),
    last_login: rec.last_login || 0, persona: rec.persona || null,
    memory: Array.isArray(rec.memory) ? rec.memory : [], voice_id: rec.voice_id || null,
    api_keys: Array.isArray(rec.api_keys) ? rec.api_keys : [],
  };
  await persist(); return true;
}
async function ensureFreshUser(email) {
  if (!email) return null;
  let rec = await getUser(email);
  if (!rec) {
    rec = { email, name: '', tier: 'free', daily_used: 0, vision_used: 0, image_used: 0, eclipse_used: 0, daily_reset: today(), month_key: monthKey(), keys_this_month: 0, created_at: now(), last_login: 0, persona: null, memory: [], voice_id: null, api_keys: [] };
    await saveUser(rec); return rec;
  }
  let dirty = false;
  if (rec.daily_reset !== today()) { rec.daily_used = 0; rec.vision_used = 0; rec.image_used = 0; rec.eclipse_used = 0; rec.daily_reset = today(); dirty = true; }
  if (rec.month_key !== monthKey()) { rec.keys_this_month = 0; rec.month_key = monthKey(); dirty = true; }
  if (!Array.isArray(rec.api_keys)) { rec.api_keys = []; dirty = true; }
  if (dirty) await saveUser(rec);
  return rec;
}

/* ---------- Session ---------- */
function signSession(d) { const p = Buffer.from(JSON.stringify(d)).toString('base64url'); return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); }
function verifySession(t) {
  if (!t || typeof t !== 'string') return {};
  const a = t.split('.'); if (a.length !== 2) return {};
  const e = crypto.createHmac('sha256', SECRET).update(a[0]).digest('base64url');
  if (e !== a[1]) return {};
  try { return JSON.parse(Buffer.from(a[0], 'base64url').toString()); } catch { return {}; }
}
function setSession(res, d) { const t = signSession(d); res.setHeader('Set-Cookie', `mirox_sess=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*60*60}`); return t; }
function clearSession(res) { res.setHeader('Set-Cookie', 'mirox_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); }
function getSession(req) {
  const cookie = safe(req.headers.cookie);
  const m = cookie.match(/(?:^|;\s*)mirox_sess=([^;]+)/);
  if (m) { const s = verifySession(decodeURIComponent(m[1])); if (s && s.uid) return s; }
  return {};
}
async function currentUser(req) {
  const s = getSession(req);
  if (!s.uid) return null;
  return await ensureFreshUser(s.uid);
}

/* ---------- Admin token ---------- */
function signAdminToken() {
  const payload = { admin: true, iat: now(), exp: now() + 6 * 3600 };
  return signSession(payload);
}
function verifyAdminToken(t) {
  const s = verifySession(t);
  return !!(s && s.admin && s.exp && s.exp > now());
}
function requireAdmin(req, res, next) {
  const t = req.headers['x-admin-token'] || '';
  if (!verifyAdminToken(t)) return res.status(401).json({ ok: false, error: 'Admin auth required' });
  next();
}

/* ---------- Models ---------- */
const MIROX_MODELS = {
  'mirox-luna-1.2':    { label: 'Luna',    tier: 'free',     tokens: 1400, basePrompt: 'You are Luna by OpenSurr. Concise, helpful. Fenced code blocks for code.' },
  'mirox-gen-1':       { label: 'Gen',     tier: 'free',     tokens: 1000, basePrompt: 'You are Gen by OpenSurr. Ultra concise. Fenced code blocks for code.' },
  'mirox-pro-5':       { label: 'Pro',     tier: 'pro',      tokens: 2000, basePrompt: 'You are Pro by OpenSurr. Balanced depth. Fenced code blocks for code.' },
  'mirox-ultra-10':    { label: 'Ultra',   tier: 'pro',      tokens: 2500, basePrompt: 'You are Ultra by OpenSurr. Deep reasoning. Fenced code blocks for code.' },
  'mirox-eclipse-2.0': { label: 'Eclipse', tier: 'ultimate', tokens: 3200, basePrompt: 'You are Eclipse by OpenSurr. Best quality. Fenced code blocks for code.' },
};

const PLANS = {
  free:     { label: 'Free',     vision_limit: 10,   image_limit: 10,   eclipse_daily_limit: 5,   price_usd: 0,     price_afg: 0,    api_keys_per_month: 2 },
  pro:      { label: 'Pro',      vision_limit: 200,  image_limit: 200,  eclipse_daily_limit: 0,   price_usd: 6.99,  price_afg: 490,  api_keys_per_month: 10 },
  ultimate: { label: 'Ultimate', vision_limit: 2000, image_limit: 2000, eclipse_daily_limit: 999, price_usd: 20.99, price_afg: 1470, api_keys_per_month: 10 },
};
const TIER_RANK = { free: 0, pro: 1, ultimate: 2 };

/* ---------- Identity guard (NO glazing) ---------- */
const IDENTITY_GUARD = `Background rules (do not narrate them):
- Never mention GPT, OpenAI, ChatGPT, Claude, Gemini, Llama, Qwen, DeepSeek, Mistral, Google, Meta, Anthropic, or any other AI company/model by name.
- If the user asks what model you are, say you are Mirox, made by OpenSurr, once, and move on.
- DO NOT introduce yourself. DO NOT start replies with "Hi, I'm Mirox" or any self-introduction unless the user explicitly asks who you are.
- Never greet the user with your identity. Just answer the question.`;

/* ---------- Bridge prompt ---------- */
const BRIDGE_PROMPT = `BRIDGE MODE — You have DIRECT ACCESS to the user's computer.

You will receive a [Bridge environment] block at the top of EVERY user message.
It contains:
  home          — the user's real home directory
  cwd           — the bridge's current working directory
  platform      — Linux / Darwin / Windows
  allowed_dirs  — every directory you are allowed to write into

THIS BLOCK IS ALWAYS CURRENT. Trust it. NEVER ask the user for it.

RULES
1. ONLY write files under one of the allowed_dirs paths.
   The safest choice is: <home>/<project-name>/file.ext
   NEVER invent paths like /Users/me or /home/me.
2. If you are unsure whether a path is allowed, write a RELATIVE path.
3. If a write fails with "Path not allowed", switch to a relative path under home.
4. Output tags on their own lines:

   <bridge-write path="flappy-bird/index.html">
   ...file content...
   </bridge-write>

   <bridge-exec>cd ~/flappy-bird && ls -la</bridge-exec>

   <bridge-read path="flappy-bird/index.html"/>

   <bridge-list path="flappy-bird/"/>

5. Never repeat a command that succeeded OR failed.
6. When everything is written and verified, reply EXACTLY: DONE`;

function buildSystemPrompt(cfg, bridge) {
  let p = IDENTITY_GUARD + '\n\n---\n\n' + cfg.basePrompt;
  if (bridge && bridge.connected) {
    p += '\n\n---\n\n' + BRIDGE_PROMPT;
    const env = bridge.env || {};
    const allowed = Array.isArray(env.allowed_dirs) && env.allowed_dirs.length ? env.allowed_dirs.join(', ') : '(not provided)';
    p += `\n\n=== [Bridge environment] ===\n`;
    p += `home=${env.home || '(unknown)'}\n`;
    p += `cwd=${env.cwd || '(unknown)'}\n`;
    p += `platform=${env.platform || '(unknown)'}\n`;
    p += `allowed_dirs=${allowed}\n`;
    if (bridge.filesWritten && bridge.filesWritten.length) p += `filesWritten=${bridge.filesWritten.join(', ')}\n`;
    if (bridge.plannedFiles && bridge.plannedFiles.length) p += `plannedFiles=${bridge.plannedFiles.join(', ')}\n`;
    p += `Use ONLY these paths. Never ask the user for this block.`;
  }
  return p;
}

/* ---------- Provider URLs ---------- */
const HF_URL = 'https://router.huggingface.co/v1/chat/completions';
const PL_URL = 'https://gen.pollinations.ai/v1/chat/completions';
const PL_IMG_BASE = 'https://gen.pollinations.ai/image';
const HF_CHAT_MODELS = ['meta-llama/Llama-3.3-70B-Instruct:together', 'Qwen/Qwen2.5-72B-Instruct:together'];
const PL_CHAT_MODELS = ['openai', 'openai-fast', 'mistral'];
const PL_IMG_MODELS = ['flux', 'turbo'];

async function hfChat(modelId, messages, maxTokens, stream) {
  if (!HF_API_KEY) throw new Error('no_hf');
  const body = { model: modelId, messages, max_tokens: maxTokens, stream: !!stream, temperature: 0.7 };
  const res = await fetchT(HF_URL, { method: 'POST', headers: { Authorization: `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 20000);
  if (!res.ok) throw new Error(`hf_${res.status}`);
  return res;
}
async function plChat(modelId, messages, maxTokens, stream) {
  if (!PL_KEY) throw new Error('no_pl');
  const body = { model: modelId, messages, max_tokens: maxTokens, stream: !!stream, temperature: 0.7 };
  const res = await fetchT(PL_URL, { method: 'POST', headers: { Authorization: `Bearer ${PL_KEY}`, 'Content-Type': 'application/json', 'Accept': stream ? 'text/event-stream' : 'application/json' }, body: JSON.stringify(body) }, 20000);
  if (!res.ok) throw new Error(`pl_${res.status}`);
  return res;
}
async function miroxChatChain({ messages, cfg, stream }) {
  if (PROVIDERS.hf) {
    for (const mid of HF_CHAT_MODELS) {
      try { const res = await hfChat(mid, messages, cfg.tokens, stream); return { res, provider: 'hf' }; } catch {}
    }
  }
  if (PROVIDERS.pl) {
    for (const mid of PL_CHAT_MODELS) {
      try { const res = await plChat(mid, messages, cfg.tokens, stream); return { res, provider: 'pl' }; } catch {}
    }
  }
  throw new Error(GENERIC_ERR);
}

/* ---------- Image gen ---------- */
async function toDataUrl(response) {
  const ct = response.headers.get('content-type') || '';
  if (ct.includes('image/')) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength < 1000) return null;
    return `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`;
  }
  try {
    const data = await response.json();
    const url = data?.data?.[0]?.url || data?.images?.[0]?.url || data?.url || data?.image;
    if (typeof url === 'string' && url.startsWith('data:image')) return url;
    if (typeof url === 'string' && url.startsWith('http')) return url;
  } catch {}
  return null;
}
async function generateImage(prompt) {
  const deadline = Date.now() + IMG_TOTAL_MS;
  for (const mid of PL_IMG_MODELS) {
    if (Date.now() > deadline - 3000) break;
    try {
      const params = new URLSearchParams({ model: mid, width: '1024', height: '1024', nologo: 'true', seed: String(Date.now() % 99999) });
      const url = `${PL_IMG_BASE}/${encodeURIComponent(prompt)}?${params.toString()}`;
      const headers = { 'Accept': 'image/png' };
      if (PL_KEY) headers.Authorization = `Bearer ${PL_KEY}`;
      const res = await fetchT(url, { method: 'GET', headers }, 30000);
      if (!res.ok) continue;
      const dataUrl = await toDataUrl(res);
      if (dataUrl) return dataUrl;
    } catch {}
  }
  throw new Error(GENERIC_ERR);
}

/* ---------- SSE ---------- */
function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) { try { res.flushHeaders(); } catch {} }
}
function sseWrite(res, obj) {
  try { if (res.writableEnded || res.destroyed) return false; res.write('data: ' + JSON.stringify(obj) + '\n\n'); return true; } catch { return false; }
}
function sseDone(res) { try { res.write('data: [DONE]\n\n'); } catch {} }

/* ---------- App ---------- */
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '30mb' }));
try { app.use(express.static(path.join(__dirname, '../public'))); } catch {}
app.use(async (req, res, next) => { try { await loadDb(); } catch {} next(); });

app.get(['/api/health','/health','/ping'], (req, res) => {
  res.json({ ok: true, app: 'MiroxAI', version: 'v86', providers: PROVIDERS, time: now() });
});

/* ============================================================
   API KEYS
   ============================================================ */
function publicKeyView(k) {
  return { id: k.id, name: k.name, key: k.key, prefix: k.key.slice(0, 14) + '…', created: k.created, last_used: k.last_used || 0, revoked: !!k.revoked };
}
function maxKeysForTier(tier) { return tier === 'free' ? 2 : 10; }

app.get(['/api/keys','/keys'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const keys = (u.api_keys || []).map(publicKeyView);
  const limit = maxKeysForTier(u.tier);
  const active = keys.filter(k => !k.revoked).length;
  res.json({ ok: true, keys, limit, active, tier: u.tier });
});

app.post(['/api/keys','/keys'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const limit = maxKeysForTier(u.tier);
  const list = Array.isArray(u.api_keys) ? u.api_keys : [];
  const active = list.filter(k => !k.revoked).length;
  if (active >= limit) return res.status(400).json({ ok: false, error: `Key limit reached (${limit} for ${u.tier})` });
  const name = safe(req.body?.name, 60).trim() || ('Key ' + (list.length + 1));
  const raw = 'mxk_live_' + crypto.randomBytes(24).toString('hex');
  const key = { id: 'k_' + crypto.randomBytes(6).toString('hex'), name, key: raw, created: now(), last_used: 0, revoked: false };
  list.push(key);
  u.api_keys = list;
  u.keys_this_month = (u.keys_this_month || 0) + 1;
  await saveUser(u);
  pushLog(db.events, { email: u.email, event: 'key_created', ts: now(), id: key.id });
  await persist();
  res.json({ ok: true, key: publicKeyView(key) });
});

app.post(['/api/keys/rename','/keys/rename'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const id = safe(req.body?.id, 40);
  const name = safe(req.body?.name, 60).trim();
  if (!id || !name) return res.status(400).json({ ok: false, error: 'id and name required' });
  const list = Array.isArray(u.api_keys) ? u.api_keys : [];
  const key = list.find(k => k.id === id);
  if (!key) return res.status(404).json({ ok: false, error: 'Key not found' });
  key.name = name;
  u.api_keys = list;
  await saveUser(u);
  pushLog(db.events, { email: u.email, event: 'key_renamed', ts: now(), id });
  await persist();
  res.json({ ok: true, key: publicKeyView(key) });
});

app.post(['/api/keys/revoke','/keys/revoke'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const id = safe(req.body?.id, 40);
  const list = Array.isArray(u.api_keys) ? u.api_keys : [];
  const key = list.find(k => k.id === id);
  if (!key) return res.status(404).json({ ok: false, error: 'Key not found' });
  key.revoked = true;
  u.api_keys = list;
  await saveUser(u);
  pushLog(db.events, { email: u.email, event: 'key_revoked', ts: now(), id });
  await persist();
  res.json({ ok: true });
});

app.post(['/api/keys/delete','/keys/delete'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const id = safe(req.body?.id, 40);
  const list = Array.isArray(u.api_keys) ? u.api_keys : [];
  u.api_keys = list.filter(k => k.id !== id);
  await saveUser(u);
  pushLog(db.events, { email: u.email, event: 'key_deleted', ts: now(), id });
  await persist();
  res.json({ ok: true });
});

/* ============================================================
   IMAGE HISTORY
   ============================================================ */
app.get(['/api/images/history','/images/history'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const u = await currentUser(req);
  if (!u) return res.json({ ok: true, images: [] });
  const mine = (db.images || []).filter(x => x.email === u.email).slice(-60).reverse();
  res.json({ ok: true, images: mine });
});

/* ============================================================
   ADMIN
   ============================================================ */
app.post(['/api/admin/auth','/admin/auth'], async (req, res) => {
  try {
    const pass = safe(req.body?.password, 200);
    if (!pass || pass !== ADMIN_PASS) return res.status(401).json({ ok: false, error: 'Invalid password' });
    const token = signAdminToken();
    res.json({ ok: true, token });
  } catch { res.status(500).json({ ok: false, error: 'Server error' }); }
});

app.get(['/api/admin/stats','/admin/stats'], requireAdmin, async (req, res) => {
  try {
    const users = db.users || {};
    const usersArr = Object.values(users);
    const images = db.images || [];
    const chats = db.chats || [];
    const events = db.events || [];

    const users_data = {};
    for (const [email, u] of Object.entries(users)) {
      users_data[email] = {
        name: u.name || '',
        tier: u.tier || 'free',
        eclipse_used: u.eclipse_used || 0,
        daily_used: u.daily_used || 0,
        last_login: u.last_login || 0,
      };
    }

    res.json({
      ok: true,
      warning: process.env.VERCEL === '1' ? 'Running on Vercel — file DB is ephemeral (/tmp).' : null,
      users: usersArr.length,
      chats: chats.length,
      images: images.length,
      events: events.length,
      users_data,
      chats_data: chats.slice(-100).reverse(),
      images_data: images.slice(-60).reverse().map(i => ({ ts: i.ts, email: i.email, prompt: i.prompt })),
      events_data: events.slice(-100).reverse(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post(['/api/admin/set-tier','/admin/set-tier'], requireAdmin, async (req, res) => {
  try {
    const email = safe(req.body?.email, 200).trim().toLowerCase();
    const tier = safe(req.body?.tier, 20).trim();
    if (!email || !tier) return res.status(400).json({ ok: false, error: 'email and tier required' });
    if (!['free','pro','ultimate'].includes(tier)) return res.status(400).json({ ok: false, error: 'Invalid tier' });
    const u = await ensureFreshUser(email);
    u.tier = tier;
    await saveUser(u);
    pushLog(db.events, { email, event: 'tier_set', ts: now(), tier });
    await persist();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------- Bridge download ---------- */
app.get('/api/bridge/download', async (req, res) => {
  try {
    let archiver;
    try { archiver = (await import('archiver')).default; }
    catch { return res.status(500).json({ ok: false, error: 'archiver not installed' }); }

    const name = safe(req.query.name, 60) || 'My Laptop';
    const port = parseInt(safe(req.query.port, 10) || '8765', 10) || 8765;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="mirox_client_bridge.zip"');
    res.setHeader('Cache-Control', 'no-store');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', () => { try { res.status(500).end(); } catch {} });
    archive.pipe(res);

    const configJson = JSON.stringify({ bridge_name: name, port, allowed_dirs: ['~'], max_output_bytes: 200000 }, null, 2);
    const readme = `# MiroxAI Bridge\n\n1. pip install aiohttp\n2. python runner.py\n3. Open MiroxAI -> Bridge -> Connect\n`;

    const runner = `#!/usr/bin/env python3
"""MiroxAI Bridge - HTTP (aiohttp)."""
import os, sys, json, time, platform, tempfile, subprocess
from pathlib import Path
try:
    from aiohttp import web
except ImportError:
    print("pip install aiohttp"); sys.exit(1)
CONFIG_FILE = Path(__file__).parent / "config.json"
CONFIG = json.load(open(CONFIG_FILE, encoding="utf-8")) if CONFIG_FILE.exists() else {}
CONFIG.setdefault("bridge_name","My Laptop"); CONFIG.setdefault("port",8765)
CONFIG.setdefault("allowed_dirs",["~"]); CONFIG.setdefault("max_output_bytes",200000)
PORT=int(CONFIG["port"]); NAME=CONFIG["bridge_name"]; MAX_OUTPUT=int(CONFIG["max_output_bytes"])

def _resolve(p):
    try: return Path(p).expanduser().resolve()
    except: return None

raw = [d for d in (CONFIG.get("allowed_dirs") or ["~"]) if d and d != "."]
ALLOWED = [r for r in (_resolve(d) for d in raw) if r]
for extra in (_resolve("~"), _resolve("."), _resolve(tempfile.gettempdir())):
    if extra and extra not in ALLOWED: ALLOWED.append(extra)

def allowed(p):
    try: p = p.expanduser().resolve()
    except: return False
    for b in ALLOWED:
        try: p.relative_to(b); return True
        except: pass
    return False

def safe_path(raw):
    if not raw: return None
    p = Path(raw).expanduser()
    if not p.is_absolute(): p = Path.home() / p
    try: p = p.resolve()
    except: return None
    return p if allowed(p) else None

@web.middleware
async def cors_mw(req, h):
    if req.method == "OPTIONS": r = web.Response()
    else:
        try: r = await h()
        except web.HTTPException as e: r = e
        except Exception as e: r = web.json_response({"ok": False, "error": str(e)}, status=500)
    r.headers["Access-Control-Allow-Origin"] = "*"
    r.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    r.headers["Access-Control-Allow-Headers"] = "Content-Type"
    r.headers["Access-Control-Allow-Private-Network"] = "true"
    return r

async def ping(req):
    return web.json_response({"ok": True, "name": NAME, "cwd": os.getcwd(), "time": time.time()})

async def env_info(req):
    return web.json_response({"ok": True, "name": NAME, "home": str(Path.home()), "cwd": os.getcwd(), "platform": platform.system(), "allowed_dirs": [str(d) for d in ALLOWED], "time": time.time()})

async def exec_cmd(req):
    try: data = await req.json()
    except: return web.json_response({"ok": False, "error": "bad json"})
    cmd = str(data.get("command", "")).strip()
    if not cmd: return web.json_response({"ok": False, "error": "no command"})
    cwd = safe_path(data.get("cwd") or str(Path.home())) or Path.home()
    try:
        p = subprocess.run(cmd, shell=True, cwd=str(cwd), capture_output=True, text=True, timeout=int(data.get("timeout", 120)))
        return web.json_response({"ok": True, "exit_code": p.returncode, "stdout": (p.stdout or "")[:MAX_OUTPUT], "stderr": (p.stderr or "")[:MAX_OUTPUT], "cwd": str(cwd)})
    except Exception as e: return web.json_response({"ok": False, "error": str(e)})

async def write_file(req):
    try: data = await req.json()
    except: return web.json_response({"ok": False, "error": "bad json"})
    p = safe_path(data.get("path", ""))
    if not p: return web.json_response({"ok": False, "error": "Path not allowed", "allowed_dirs": [str(d) for d in ALLOWED]})
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        content = data.get("content", "")
        p.write_text(content, encoding="utf-8")
        return web.json_response({"ok": True, "path": str(p), "bytes": len(content)})
    except Exception as e: return web.json_response({"ok": False, "error": str(e)})

async def read_file(req):
    try: data = await req.json()
    except: return web.json_response({"ok": False, "error": "bad json"})
    p = safe_path(data.get("path", ""))
    if not p or not p.exists(): return web.json_response({"ok": False, "error": "not found"})
    try: return web.json_response({"ok": True, "path": str(p), "content": p.read_text(encoding="utf-8", errors="replace")[:MAX_OUTPUT]})
    except Exception as e: return web.json_response({"ok": False, "error": str(e)})

async def list_dir(req):
    try: data = await req.json()
    except: data = {}
    p = safe_path(data.get("path", str(Path.home())))
    if not p or not p.is_dir(): return web.json_response({"ok": False, "error": "not a dir"})
    try:
        items = [{"name": c.name, "is_dir": c.is_dir(), "size": c.stat().st_size if c.is_file() else 0} for c in sorted(p.iterdir())]
        return web.json_response({"ok": True, "path": str(p), "items": items[:500]})
    except Exception as e: return web.json_response({"ok": False, "error": str(e)})

def build_app():
    a = web.Application(middlewares=[cors_mw])
    a.router.add_get("/ping", ping); a.router.add_options("/ping", lambda r: web.Response())
    a.router.add_get("/env", env_info); a.router.add_options("/env", lambda r: web.Response())
    a.router.add_post("/exec", exec_cmd); a.router.add_options("/exec", lambda r: web.Response())
    a.router.add_post("/write", write_file); a.router.add_options("/write", lambda r: web.Response())
    a.router.add_post("/read", read_file); a.router.add_options("/read", lambda r: web.Response())
    a.router.add_post("/list", list_dir); a.router.add_options("/list", lambda r: web.Response())
    return a

if __name__ == "__main__":
    print(f"[Bridge] {NAME} on http://127.0.0.1:{PORT}")
    print(f"[Bridge] Home: {Path.home()}")
    for d in ALLOWED: print(f"[Bridge]   allowed: {d}")
    web.run_app(build_app(), host="127.0.0.1", port=PORT, print=None, access_log=None)
`;

    archive.append(configJson, { name: 'mirox_client_bridge/config.json' });
    archive.append(runner, { name: 'mirox_client_bridge/runner.py' });
    archive.append(readme, { name: 'mirox_client_bridge/README.md' });
    await archive.finalize();
  } catch (e) {
    try { if (!res.headersSent) res.status(500).json({ ok: false, error: e.message }); else res.end(); } catch {}
  }
});

/* ---------- Config ---------- */
app.get(['/api/config','/config'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const models = Object.entries(MIROX_MODELS).map(([id, m]) => ({ id, label: m.label, tier: m.tier }));
  res.json({ app: { name: 'MiroxAI', version: 'v86' }, models, default_model: models[0].id, plans: PLANS, tts_available: !!F_API });
});

/* ---------- Auth ---------- */
app.post(['/api/auth/simple-login','/auth/simple-login'], async (req, res) => {
  try {
    const { name, email } = req.body || {};
    const n = safe(name, 60).trim();
    const e = safe(email, 120).trim().toLowerCase();
    if (!n || !e || !e.includes('@')) return res.status(400).json({ ok: false, error: 'Name and email required' });
    let rec = await getUser(e);
    if (!rec) rec = { email: e, name: n, tier: 'free', api_keys: [] };
    if (!Array.isArray(rec.api_keys)) rec.api_keys = [];
    rec.name = n; rec.last_login = now();
    await saveUser(rec);
    pushLog(db.events, { email: e, event: 'login', ts: now() });
    await persist();
    const token = setSession(res, { uid: e, name: n, tier: rec.tier });
    res.json({ ok: true, token, user: { id: e, email: e, name: n, tier: rec.tier } });
  } catch { res.status(500).json({ ok: false }); }
});
app.post(['/api/logout','/logout'], (req, res) => { clearSession(res); res.json({ ok: true }); });
app.get(['/api/me','/me'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const u = await currentUser(req);
    if (!u) return res.json({ user: null });
    const plan = PLANS[u.tier] || PLANS.free;
    res.json({ user: {
      id: u.email, email: u.email, name: u.name, tier: u.tier,
      vision_limit: plan.vision_limit, vision_used: u.vision_used || 0,
      image_limit: plan.image_limit, image_used: u.image_used || 0,
      eclipse_limit: plan.eclipse_daily_limit, eclipse_used: u.eclipse_used || 0,
      api_keys_used: (u.api_keys || []).filter(k => !k.revoked).length,
      api_keys_limit: maxKeysForTier(u.tier),
    }});
  } catch { res.json({ user: null }); }
});
app.get(['/api/subscription/plans','/subscription/plans'], (req, res) => {
  const out = Object.entries(PLANS).map(([id, p]) => ({
    id, label: p.label,
    tagline: { free: 'Free forever', pro: 'Most popular', ultimate: 'Power users' }[id],
    vision_limit: p.vision_limit, image_limit: p.image_limit, eclipse_limit: p.eclipse_daily_limit,
    price_usd: p.price_usd, price_afg: p.price_afg,
    api_keys_limit: p.api_keys_per_month,
    perks: id === 'free' ? ['Luna & Gen unlimited', '10 image uploads/day', '10 image gens/day', '5 Eclipse/day', '2 API keys']
      : id === 'pro' ? ['Pro & Ultra models', '200 image uploads/gens/day', '10 API keys']
      : ['Eclipse — best model', '2000 image uploads/gens/day', '10 API keys'],
  }));
  res.json({ ok: true, plans: out });
});
app.get('/api/persona', async (req, res) => { const u = await currentUser(req); res.json({ ok: true, persona: u?.persona || '' }); });
app.post('/api/persona', async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false });
  u.persona = safe(req.body?.persona, 500);
  await saveUser(u);
  res.json({ ok: true });
});

/* ---------- Image generation ---------- */
app.post('/v1/images/generations', async (req, res) => {
  try {
    const prompt = safe(req.body?.prompt, 2000).trim();
    if (!prompt) return res.status(400).json({ error: { message: 'Prompt required' } });
    const u = await currentUser(req);
    if (u && u.tier === 'free' && (u.image_used || 0) >= 10) {
      return res.status(429).json({ error: { message: 'Daily image limit reached' } });
    }
    const imageUrl = await generateImage(prompt);
    if (u) { u.image_used = (u.image_used || 0) + 1; try { await saveUser(u); } catch {} }
    pushLog(db.images, { email: u?.email || 'guest', prompt, image: imageUrl, ts: now() }, 300);
    pushLog(db.events, { email: u?.email || 'guest', event: 'image_generated', ts: now() });
    try { await persist(); } catch {}
    res.json({ ok: true, image: imageUrl });
  } catch { res.status(502).json({ error: { message: GENERIC_ERR } }); }
});

/* ---------- Chat completions ---------- */
app.post('/v1/chat/completions', async (req, res) => {
  const t0 = Date.now();
  let clientClosed = false;
  req.on('close', () => { clientClosed = true; });

  try {
    const body = req.body || {};
    const stream = body.stream === true || (req.headers.accept || '').includes('text/event-stream');
    const rawMessage = body.message;
    const rawHistory = body.history;
    const requestedModel = safe(body.model, 64) || 'mirox-luna-1.2';
    const bridge = body.bridge || null;

    let u = null; try { u = await currentUser(req); } catch {}
    const cfg = MIROX_MODELS[requestedModel];
    if (!cfg) return res.status(404).json({ error: { message: 'Model not found.' } });

    const tier = u?.tier || 'free';
    const plan = PLANS[tier] || PLANS.free;

    if (cfg.tier === 'pro' && TIER_RANK[tier] < 1) return res.status(403).json({ error: { message: 'Pro plan required' } });
    if (cfg.tier === 'ultimate' && tier !== 'ultimate') {
      if (tier === 'free') { if ((u?.eclipse_used || 0) >= plan.eclipse_daily_limit) return res.status(429).json({ error: { message: 'Eclipse daily limit reached' } }); }
      else return res.status(403).json({ error: { message: 'Ultimate plan required' } });
    }

    const text = safe(rawMessage, 100000).trim();
    if (!text) return res.status(400).json({ error: { message: 'Empty message' } });

    const sys = buildSystemPrompt(cfg, bridge) + (u?.persona ? `\n\nUser preference: ${safe(u.persona, 500)}` : '');
    const msgs = [{ role: 'system', content: sys }];

    let userText = text;
    if (bridge && bridge.connected) {
      const env = bridge.env || {};
      const allowed = Array.isArray(env.allowed_dirs) && env.allowed_dirs.length ? env.allowed_dirs.join(', ') : '(not provided)';
      const envHeader =
        `[Bridge environment]\n` +
        `home=${env.home || '(unknown)'}\n` +
        `cwd=${env.cwd || '(unknown)'}\n` +
        `platform=${env.platform || '(unknown)'}\n` +
        `allowed_dirs=${allowed}\n\n`;
      userText = envHeader + userText;
    }
    msgs.push({ role: 'user', content: userText });

    for (const h of safeArr(rawHistory).slice(-14)) {
      const role = safe(h.role, 20); const txt = safe(h.content, 4000).trim();
      if ((role === 'user' || role === 'assistant') && txt) msgs.push({ role, content: txt });
    }

    const updateUsage = async () => {
      if (u && u.email) {
        u.daily_used = (u.daily_used || 0) + 1;
        if (requestedModel === 'mirox-eclipse-2.0') u.eclipse_used = (u.eclipse_used || 0) + 1;
        try { await saveUser(u); } catch {}
      }
      pushLog(db.chats, { email: u?.email || 'guest', model: requestedModel, message: text.slice(0, 400), ts: now() });
      try { await persist(); } catch {}
    };

    if (!stream) {
      try {
        const result = await miroxChatChain({ messages: msgs, cfg, stream: false });
        const data = await result.res.json().catch(() => ({}));
        const reply = extractReplyText(data) || '(empty)';
        await updateUsage();
        return res.json({ reply, _ms: Date.now() - t0 });
      } catch { return res.status(502).json({ error: { message: GENERIC_ERR } }); }
    }

    sseInit(res);
    let streamEnded = false;
    const guard = setTimeout(() => { if (streamEnded || res.writableEnded) return; try { sseDone(res); } catch {} try { res.end(); } catch {} streamEnded = true; }, 240000);

    try {
      const result = await miroxChatChain({ messages: msgs, cfg, stream: true });
      sseWrite(res, { p: result.provider });
      const reader = result.res.body.getReader(); const dec = new TextDecoder();
      let buf = '';
      while (true) {
        if (clientClosed || res.writableEnded) break;
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          let line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const raw = t.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          try { const o = JSON.parse(raw); const d = o.choices?.[0]?.delta?.content; if (d) sseWrite(res, { d }); } catch {}
        }
      }
      try { reader.releaseLock(); } catch {}

      if (!clientClosed && !res.writableEnded) { sseWrite(res, { done: true }); sseDone(res); }
      await updateUsage();
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[stream]', e.message);
      if (!clientClosed && !res.writableEnded) { try { sseWrite(res, { error: { message: GENERIC_ERR } }); } catch {} try { sseDone(res); } catch {} }
    } finally {
      clearTimeout(guard); streamEnded = true;
      try { if (!res.writableEnded) res.end(); } catch {}
    }
    return;
  } catch (e) {
    console.error('[handler]', e.message);
    try { if (!res.headersSent) res.status(500).json({ error: { message: GENERIC_ERR } }); else if (!res.writableEnded) res.end(); } catch {}
  }
});

app.use((req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/v1')) return res.status(404).json({ ok: false, error: 'Not found: ' + req.path });
  const idx = path.join(__dirname, '../public/index.html');
  res.sendFile(idx, (err) => {
    if (err) res.json({ ok: true, app: 'MiroxAI', message: 'Backend running. public/ missing.' });
  });
});

(async () => {
  try { await loadDb(); } catch {}
  if (process.env.VERCEL !== '1') {
    app.listen(PORT, () => console.log('[Mirox] Server at http://localhost:' + PORT));
  }
})();

export default app;

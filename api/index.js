/* ============================================================
   MiroxAI Backend v115 — VPS storage fix
   · All original env names unchanged
   · NEW: persistent storage via SSH using VPS_IP + VPS_KEY
   · Everything else identical to v114
   ============================================================ */
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  Client, GatewayIntentBits, Events, EmbedBuilder,
  ActivityType, PermissionFlagsBits, ChannelType,
} from 'discord.js';
import { createThinkSplitter, reasoningFromDelta, contentFromDelta } from './thinking.js';
import { getSettings, sanitizeSettings, userContextPrompt } from './settings.js';
import { runAgent, saveAttachments } from './tools.js';
import { fileURLToPath } from 'url';

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const env = (k, d = '') => String(process.env[k] ?? d).trim();

const PORT = env('PORT', '3000');
const PUBLIC_ORIGIN = env('PUBLIC_ORIGIN', 'https://miroxai.org').replace(/\/+$/, '');
const ADMIN_PASS = env('ADMIN_PASSWORD');
const ALLOW_EMAIL_LOGIN = env('ALLOW_EMAIL_LOGIN') === '1';

/* ---------- KenSearch ---------- */
const KS_KEY = env('KS_KEY');
const KS_BASE = env('KS_BASE', 'https://kensearch.lovable.app').replace(/\/+$/, '');

/* ---------- Discord (only M_KEY needed) ---------- */
const DISCORD_BOT_TOKEN = env('M_KEY');
const DISCORD_CHAT_CHANNEL   = '1560697976500781126';
const DISCORD_IMAGE_CHANNEL  = '1560697947945963681';
const DISCORD_STATUS_CHANNEL = '1560697723387387945';
const DISCORD_ROLE_OWNER  = { name: 'Mirox Owner',  color: 0xffc542, emoji: '👑' };
const DISCORD_ROLE_BOT    = { name: 'Mirox Bot',    color: 0x4d6bfe, emoji: '🤖' };
const DISCORD_ROLE_MEMBER = { name: 'Mirox Member', color: 0x16a34a, emoji: '🌱' };
const DISCORD_CMD_PREFIX  = '?';

/* ============================================================
   VPS STORAGE (SSH) — only needs VPS_IP + VPS_KEY
   ============================================================ */
const VPS_IP        = env('VPS_IP');
const VPS_KEY       = env('VPS_KEY', 'root');
const VPS_USER      = 'root';
const VPS_PORT      = 22;
const VPS_DB_PATH   = '/var/lib/mirox/mirox-db.json';
let   VPS_ON        = !!(VPS_IP && VPS_KEY);

let _ssh2Mod = null;
let _sshClient = null;
let _sshReady = null;
let _vpsBreakerUntil = 0;
const VPS_BREAKER_MS = 30_000;

async function getSSH2() {
  if (_ssh2Mod) return _ssh2Mod;
  _ssh2Mod = await import('ssh2');
  return _ssh2Mod;
}

async function getSSHClient() {
  if (Date.now() < _vpsBreakerUntil) throw new Error('vps_breaker_open');
  if (_sshClient && _sshClient._ready) return _sshClient;
  if (_sshReady) return _sshReady;
  _sshReady = (async () => {
    const { Client: SSHClient } = await getSSH2();
    return await new Promise((resolve, reject) => {
      const conn = new SSHClient();
      const t = setTimeout(() => { try { conn.end(); } catch {} reject(new Error('ssh_timeout')); }, 20_000);
      conn.on('ready', () => {
        clearTimeout(t);
        conn._ready = true;
        _sshClient = conn;
        conn.on('close', () => { _sshClient = null; _sshReady = null; });
        conn.on('error', () => { _sshClient = null; _sshReady = null; });
        resolve(conn);
      });
      conn.on('error', (e) => {
        clearTimeout(t);
        _sshReady = null;
        _vpsBreakerUntil = Date.now() + VPS_BREAKER_MS;
        reject(e);
      });
      conn.connect({ host: VPS_IP, port: VPS_PORT, username: VPS_USER, password: VPS_KEY, readyTimeout: 20_000 });
    });
  })();
  try { return await _sshReady; } catch (e) { _sshReady = null; throw e; }
}

async function vpsExec(cmd, timeoutMs = 20_000) {
  const conn = await getSSHClient();
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('exec_timeout')), timeoutMs);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(t); return reject(err); }
      let stdout = '', stderr = '';
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
      stream.on('error', (e) => { clearTimeout(t); reject(e); });
    });
  });
}

async function vpsReadFile() {
  const conn = await getSSHClient();
  return await new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const chunks = [];
      const stream = sftp.createReadStream(VPS_DB_PATH);
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  });
}

async function vpsWriteFile(content) {
  const conn = await getSSHClient();
  return await new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(VPS_DB_PATH);
      stream.on('close', () => resolve(true));
      stream.on('error', reject);
      stream.end(Buffer.from(content, 'utf8'));
    });
  });
}

async function vpsEnsure() {
  if (!VPS_ON) return false;
  try {
    const { code, stderr } = await vpsExec(
      `mkdir -p /var/lib/mirox && chmod 700 /var/lib/mirox && touch ${VPS_DB_PATH} && chmod 600 ${VPS_DB_PATH}`
    );
    if (code !== 0) throw new Error(stderr || 'mkdir_failed');
    return true;
  } catch (e) {
    console.error('[vps] ensure failed:', e.message);
    return false;
  }
}

if (VPS_ON) {
  try { await import('ssh2'); }
  catch {
    console.error('[vps] ssh2 not installed — run: npm install ssh2');
    console.error('[vps] VPS storage disabled, falling back to filesystem.');
    VPS_ON = false;
  }
  if (VPS_ON) console.log(`[vps] enabled → ${VPS_USER}@${VPS_IP}:${VPS_DB_PATH}`);
}

/* ---------- Data file resolution (fallback) ---------- */
function resolveDataFile() {
  const candidates = [];
  const explicit = env('DB_FILE');
  if (explicit) candidates.push(explicit);
  candidates.push('/var/data/mirox-db.json');
  candidates.push('/data/mirox-db.json');
  try { candidates.push(path.join(process.cwd(), 'mirox-db.json')); } catch {}
  candidates.push('/tmp/mirox-db.json');
  return candidates;
}
const DATA_FILES = resolveDataFile();
const DATA_FILE = DATA_FILES[0];
const IMG_DIR = env('IMG_DIR', '/tmp/mirox-img');

const OP_KEY = env('OP_KEY');
const OP_BASE = env('OP_BASE', 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const OP_REFERER = env('OP_REFERER', PUBLIC_ORIGIN || 'https://miroxai.org');
const OP_TITLE = env('OP_TITLE', 'MiroxAI');
const HF_API_KEY = env('HF_API_KEY');
const PL_KEY = env('PL_KEY');
const F_API = env('F_API');
const AIROUTE_KEY = env('AR_KEY') || env('AIROUTE_KEY');
const AIROUTE_BASE = env('AR_BASE', 'https://route-ai-playground.lovable.app').replace(/\/+$/, '');
const LM_CLIENT_ID = env('LOGINMENT_CLIENT_ID');
const LM_API_KEY = env('LOGINMENT_API_KEY');
const LM_DOMAIN = env('LOGINMENT_DOMAIN', 'https://logint.lovable.app').replace(/\/+$/, '');
const KV_URL = env('UPSTASH_REDIS_REST_URL').replace(/\/+$/, '');
const KV_TOKEN = env('UPSTASH_REDIS_REST_TOKEN');
const KV_ON = !!(KV_URL && KV_TOKEN);
const KV_DB_KEY = 'mirox:db:v1';
const SECRET = env('SECRET_KEY') || crypto.randomBytes(32).toString('hex');
if (!env('SECRET_KEY')) console.warn('[Mirox] SECRET_KEY not set — sessions will not survive a restart.');
const GENERIC_ERR = 'Mirox AI encountered an error';
const DAY = 24 * 3600;

/* ---------- Model catalogue ---------- */
const MIROX_MODELS = {
  'mirox-tail-r1':     { label: 'Tail r1', tier: 'free', tokens: 32768, chain: 'flagship', flagship: true, tagline: 'Flagship · 350k context · best reasoning',
    basePrompt: 'You are Tail r1 by OpenSurr — the flagship model with a 350,000+ token context window and state-of-the-art reasoning benchmark performance. Approach every task with maximum rigor. Fenced code blocks for code.' },
  'mirox-luna-1.2':    { label: 'Luna',    tier: 'free', tokens: 4096,  chain: 'fast', basePrompt: 'You are Luna by OpenSurr. Fast, friendly, concise. Fenced code blocks for code.' },
  'mirox-gen-1':       { label: 'Gen',     tier: 'free', tokens: 4096,  chain: 'fast', basePrompt: 'You are Gen by OpenSurr. Ultra concise. Direct answers. Fenced code blocks for code.' },
  'mirox-pro-5':       { label: 'Pro',     tier: 'pro',  tokens: 8192,  chain: 'balanced', basePrompt: 'You are Pro by OpenSurr. Balanced depth. Fenced code blocks for code.' },
  'mirox-ultra-10':    { label: 'Ultra',   tier: 'pro',  tokens: 8192,  chain: 'balanced', basePrompt: 'You are Ultra by OpenSurr. Deep reasoning. Fenced code blocks for code.' },
  'mirox-eclipse-2.0': { label: 'Eclipse', tier: 'ultimate', tokens: 16384, chain: 'deep', basePrompt: 'You are Eclipse by OpenSurr. Best quality. Fenced code blocks for code.' },
};

const CHAINS = {
  flagship: ['anthropic/claude-3.5-sonnet','openai/gpt-4o','deepseek/deepseek-r1','meta-llama/llama-3.3-70b-instruct','openai/gpt-4o-mini'],
  deep: ['anthropic/claude-3.5-sonnet','openai/gpt-4o-mini','meta-llama/llama-3.3-70b-instruct'],
  balanced: ['openai/gpt-4o-mini','anthropic/claude-3.5-haiku','meta-llama/llama-3.3-70b-instruct'],
  fast: ['meta-llama/llama-3.3-70b-instruct','openai/gpt-4o-mini','google/gemini-flash-1.5'],
};

const PLANS = {
  free:     { label: 'Free',     vision_limit: 10,   image_limit: 30,   eclipse_daily_limit: 5,   price_usd: 0,     api_keys: 2 },
  pro:      { label: 'Pro',      vision_limit: 200,  image_limit: 200,  eclipse_daily_limit: 0,   price_usd: 6.99,  api_keys: 10 },
  ultimate: { label: 'Ultimate', vision_limit: 2000, image_limit: 2000, eclipse_daily_limit: 999, price_usd: 20.99, api_keys: 10 },
};
const TIER_RANK = { free: 0, pro: 1, ultimate: 2 };
const API_MODELS = ['mirox-luna-1.2', 'mirox-gen-1', 'mirox-tail-r1'];
const maxKeys = (tier) => (tier === 'free' ? 2 : 10);

const OP_CHAT_URL = `${OP_BASE}/chat/completions`;
const OP_CHAT = ['meta-llama/llama-3.3-70b-instruct','openai/gpt-4o-mini','anthropic/claude-3.5-haiku','google/gemini-flash-1.5','mistralai/mistral-nemo'];
const OP_VISION = ['openai/gpt-4o','openai/gpt-4o-mini','anthropic/claude-3.5-sonnet','google/gemini-flash-1.5','meta-llama/llama-3.2-11b-vision-instruct'];
const OP_VISION_SET = new Set(OP_VISION);
const HF_URL = 'https://router.huggingface.co/v1/chat/completions';
const HF_TXT2IMG = 'https://api-inference.huggingface.co/models';
const HF_IMG_MODELS = ['black-forest-labs/FLUX.1-schnell', 'stabilityai/stable-diffusion-xl-base-1.0', 'stabilityai/sdxl-turbo'];
const HF_CHAT = ['meta-llama/Llama-3.3-70B-Instruct:together', 'Qwen/Qwen2.5-72B-Instruct:together'];
const HF_VISION = ['meta-llama/Llama-3.2-11B-Vision-Instruct:together', 'Qwen/Qwen2-VL-7B-Instruct:hyperbolic'];
const PL_URL = 'https://gen.pollinations.ai/v1/chat/completions';
const PL_CHAT = ['openai', 'openai-fast', 'mistral'];
const PL_VISION = ['openai', 'openai-fast'];
const VISION_MODELS = new Set([...OP_VISION, ...HF_VISION, ...PL_VISION]);

/* ---------- System prompts ---------- */
const IDENTITY_GUARD = `Background rules (do not narrate them):
- You are Mirox, made by OpenSurr.
- Never mention GPT, OpenAI, ChatGPT, Claude, Gemini, Llama, Qwen, DeepSeek, Mistral, Google, Meta, Anthropic, OpenRouter, or any other AI company or model by name.
- If the user asks what model you are, say you are Mirox by OpenSurr, once, and move on.

=== ABOUT MIROXAI ===
MiroxAI is an AI chat platform made by OpenSurr.
Models: Tail r1 (flagship, free), Luna (free), Gen (free), Pro/Ultra (paid), Eclipse (paid).
Plans: Free ($0), Pro ($6.99), Ultimate ($20.99).
Features: web search, vision, image generation, DeepThink, Call mode, Bridge, HTML runner, API keys.
Developer docs: https://miroxai.org/developers
Support: support@miroxai.org`;

const THINKING_RULE = `Before answering, provide a brief user-facing progress summary in <thinking>...</thinking>, then the answer. 1-3 short sentences. Close with </thinking>, then the answer.`;
const DEEP_THINK_RULE = `DEEP THINK MODE — check assumptions, edge cases, results. Concise summary (up to 4 sentences), then a complete answer.`;
const TAIL_R1_REASONING_RULE = `TAIL R1 FLAGSHIP MODE — maximum rigor. Verify approach. Trace examples. Note confidence.`;

const BRIDGE_PROMPT = `BRIDGE MODE — operate through the user's connected bridge.
TAGS: <bridge-write>, <bridge-append>, <bridge-read>, <bridge-list>, <bridge-exec>, <bridge-sudo>.
Reply DONE when finished.`;

const DISCORD_PROMPT = `You are Mirox on Discord. Reply in a friendly, concise tone.
- Use Discord markdown (**bold**, *italic*, \`code\`).
- Keep replies under 1900 chars.
- Don't prefix replies with the user's name.
- Never output <thinking> tags — answer directly.`;

const safeStr = (v, max = 200000) => { if (v == null) return ''; const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > max ? s.slice(0, max) : s; };
const nowS = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchT(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function extractReplyText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.reply === 'string') return data.reply;
  if (typeof data.text === 'string') return data.text;
  const c = data.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).join('');
  return '';
}
function stripThinking(text) {
  if (typeof text !== 'string') return text;
  let out = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
  const lastOpen = out.lastIndexOf('<thinking>');
  if (lastOpen >= 0 && out.indexOf('</thinking>', lastOpen) === -1) out = out.slice(0, lastOpen);
  out = out.replace(/<\/?thinking>/g, '');
  return out.replace(/^\s+/, '');
}

/* ---------- Watermark ---------- */
const WM_MARKER = Buffer.from('\n\x00MIROXAI-WATERMARK-v1-LOGO\x00\n', 'binary');
const _CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let crc = 0xffffffff; for (let i = 0; i < buf.length; i++) crc = _CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function watermarkPng(buffer) {
  const SIG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  if (buffer.length < 8 || !buffer.slice(0, 8).equals(SIG)) return null;
  const data = Buffer.concat([Buffer.from('MiroxAI', 'latin1'), Buffer.from([0]), Buffer.from('mirox-ai-watermark-v1-logo', 'latin1')]);
  const type = Buffer.from('tEXt', 'latin1');
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
  const chunk = Buffer.concat([lenBuf, type, data, crcBuf]);
  const iend = buffer.indexOf(Buffer.from('IEND', 'latin1'));
  if (iend < 4) return null;
  return Buffer.concat([buffer.slice(0, iend - 4), chunk, buffer.slice(iend - 4)]);
}
function watermarkJpeg(buffer) {
  if (buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const payload = Buffer.from('MiroxAI:mirox-ai-watermark-v1-logo', 'latin1');
  const len = payload.length + 2;
  if (len > 0xffff) return null;
  const head = Buffer.alloc(4); head[0] = 0xff; head[1] = 0xfe; head.writeUInt16BE(len, 2);
  return Buffer.concat([buffer.slice(0, 2), head, payload, buffer.slice(2)]);
}
function applyWatermark(buffer, mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) { const r = watermarkPng(buffer); return Buffer.concat([r || buffer, WM_MARKER]); }
  if (m.includes('jpeg') || m.includes('jpg')) { const r = watermarkJpeg(buffer); return Buffer.concat([r || buffer, WM_MARKER]); }
  return Buffer.concat([buffer, WM_MARKER]);
}

/* ---------- DB ---------- */
let db = null, dbOk = false, dbLoading = null, writeChain = Promise.resolve();
let lastWrittenHash = '';
const emptyDb = () => ({ users: {}, keys: {}, chats: [], events: [], tickets: [], payment_requests: [] });

function normalize(raw) {
  const d = Object.assign(emptyDb(), raw && typeof raw === 'object' ? raw : {});
  delete d.images; delete d.apiKeys; delete d.counters;
  if (!d.users || typeof d.users !== 'object') d.users = {};
  d.chats = Array.isArray(d.chats) ? d.chats.slice(-300) : [];
  d.events = Array.isArray(d.events) ? d.events.slice(-300) : [];
  d.tickets = Array.isArray(d.tickets) ? d.tickets.slice(-200) : [];
  d.payment_requests = Array.isArray(d.payment_requests) ? d.payment_requests.slice(-500) : [];
  for (const t of d.tickets) if (!Array.isArray(t.messages)) t.messages = [];
  for (const u of Object.values(d.users)) {
    if (!Array.isArray(u.keys)) u.keys = Array.isArray(u.api_keys) ? u.api_keys : [];
    delete u.api_keys;
    if (!Array.isArray(u.images)) u.images = [];
    for (const k of u.keys) {
      if (!k || typeof k !== 'object') continue;
      if (typeof k.revoked !== 'boolean') k.revoked = false;
      if (typeof k.created !== 'number') k.created = nowS();
      if (typeof k.last_used !== 'number') k.last_used = 0;
    }
    u.keys = u.keys.filter((k) => k && typeof k === 'object' && typeof k.key === 'string' && k.key.startsWith('mxk_live_'));
  }
  d.keys = {};
  for (const u of Object.values(d.users)) for (const k of u.keys) if (k && k.key) d.keys[k.key] = u.email;
  return d;
}

async function kv(cmd) {
  const r = await fetchT(KV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) }, 8000);
  if (!r.ok) throw new Error('kv_' + r.status);
  const d = await r.json();
  if (d.error) throw new Error('kv: ' + d.error);
  return d.result;
}

async function readMain() {
  if (KV_ON) {
    try {
      const v = await kv(['GET', KV_DB_KEY]);
      if (v && v.length > 2) return v;
    } catch (e) { console.warn('[db] KV read failed:', e.message); }
  }
  if (VPS_ON) {
    try {
      if (await vpsEnsure()) {
        const content = await vpsReadFile();
        if (content && content.trim().length > 2) {
          console.log('[db] loaded from VPS');
          return content;
        }
      }
    } catch (e) { console.warn('[db] VPS read failed:', e.message); }
  }
  for (const f of DATA_FILES) {
    try {
      const raw = await fs.readFile(f, 'utf8');
      if (raw && raw.length > 2) {
        if (f !== DATA_FILE) console.log(`[db] loaded from fallback path: ${f}`);
        return raw;
      }
    } catch (e) { if (e.code !== 'ENOENT') console.warn(`[db] read ${f} failed:`, e.message); }
  }
  return null;
}

async function loadDb() {
  if (db && dbOk && !KV_ON && !VPS_ON) return db;
  if (dbLoading) return dbLoading;
  dbLoading = (async () => {
    try {
      const raw = await readMain();
      db = normalize(raw ? JSON.parse(raw) : null);
      dbOk = true;
      const userCount = Object.keys(db.users || {}).length;
      const keyCount = Object.values(db.users || {}).reduce((s, u) => s + ((u.keys || []).length), 0);
      const src = VPS_ON ? 'VPS' : (KV_ON ? 'KV' : DATA_FILE);
      console.log(`[db] loaded — users=${userCount} keys=${keyCount} source=${src}`);
    } catch (e) {
      console.error('[db] load failed:', e.message);
      if (!db) db = normalize(null);
      dbOk = false;
    } finally { dbLoading = null; }
    return db;
  })();
  return dbLoading;
}

async function writeAllBackends(snap) {
  let ok = false;
  if (KV_ON) {
    try { await kv(['SET', KV_DB_KEY, snap]); ok = true; }
    catch (e) { console.error('[db] KV write failed:', e.message); }
  }
  if (VPS_ON) {
    try {
      if (await vpsEnsure()) { await vpsWriteFile(snap); ok = true; }
    } catch (e) { console.error('[db] VPS write failed:', e.message); }
  }
  for (const f of DATA_FILES) {
    try {
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, snap, 'utf8');
      ok = true;
    } catch {}
  }
  return ok;
}

function persist() {
  if (!db || !dbOk) return Promise.resolve(false);
  const snap = JSON.stringify(db);
  const hash = crypto.createHash('sha1').update(snap).digest('hex');
  if (hash === lastWrittenHash) return Promise.resolve(true);
  const job = writeChain.then(async () => {
    const ok = await writeAllBackends(snap);
    if (ok) lastWrittenHash = hash;
    return ok;
  });
  writeChain = job.then(() => undefined, () => undefined);
  return job;
}

function userFor(email) {
  let u = db.users[email];
  if (!u) u = db.users[email] = { email, name: email.split('@')[0], tier: 'free', provider: 'email', created_at: nowS(), last_login: 0 };
  if (!u.name) u.name = email.split('@')[0];
  if (!['free', 'pro', 'ultimate'].includes(u.tier)) u.tier = 'free';
  if (!Array.isArray(u.keys)) u.keys = [];
  if (!Array.isArray(u.images)) u.images = [];
  if (u.daily_day !== today()) { u.daily_day = today(); u.daily_used = 0; u.vision_used = 0; u.image_used = 0; u.eclipse_used = 0; }
  for (const f of ['daily_used', 'vision_used', 'image_used', 'eclipse_used']) if (typeof u[f] !== 'number') u[f] = 0;
  return u;
}
function logEvent(ev) { db.events.push({ ts: nowS(), ...ev }); if (db.events.length > 300) db.events.splice(0, db.events.length - 300); }
function logChat(entry) { db.chats.push({ ts: nowS(), ...entry }); if (db.chats.length > 300) db.chats.splice(0, db.chats.length - 300); }

/* ---------- Blob ---------- */
const BLOB_ID = /^[a-f0-9]{32}$/;
async function blobPut(id, value) { if (KV_ON) return kv(['SET', 'mirox:img:' + id, value, 'EX', String(60 * DAY)]); await fs.mkdir(IMG_DIR, { recursive: true }); await fs.writeFile(path.join(IMG_DIR, id + '.txt'), value, 'utf8'); }
async function blobGet(id) { if (!BLOB_ID.test(id)) return null; try { if (KV_ON) return await kv(['GET', 'mirox:img:' + id]); return await fs.readFile(path.join(IMG_DIR, id + '.txt'), 'utf8'); } catch { return null; } }
async function blobDel(id) { if (!BLOB_ID.test(id)) return; try { if (KV_ON) await kv(['DEL', 'mirox:img:' + id]); else await fs.unlink(path.join(IMG_DIR, id + '.txt')); } catch {} }
async function saveImage(u, prompt, dataUrl) {
  const id = crypto.randomBytes(16).toString('hex');
  const isRemote = dataUrl.startsWith('http');
  if (!isRemote) { try { await blobPut(id, dataUrl); } catch (e) { console.warn('[blob] save failed:', e.message); return false; } }
  u.images.unshift({ id: isRemote ? null : id, remote: isRemote ? dataUrl : null, prompt: prompt.slice(0, 300), ts: nowS(), watermarked: true });
  while (u.images.length > 30) { const old = u.images.pop(); if (old && old.id) blobDel(old.id); }
  return true;
}

/* ---------- Sessions ---------- */
function signSession(data) { const p = Buffer.from(JSON.stringify(data)).toString('base64url'); const s = crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); return p + '.' + s; }
function readSession(token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const p = token.slice(0, i), s = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (!safeEq(expect, s)) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url').toString()); if (d.exp && d.exp < nowS()) return null; return d; } catch { return null; }
}
function getCookie(req, name) { for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > -1 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } } } return ''; }
function cookieAttrs(req, maxAge) { const secure = req.secure || PUBLIC_ORIGIN.startsWith('https://'); return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`; }
function setSessionCookie(req, res, uid) { const token = signSession({ uid, exp: nowS() + 30 * DAY }); res.append('Set-Cookie', `mirox_sess=${token}; ${cookieAttrs(req, 30 * DAY)}`); return token; }
function clearSessionCookie(req, res) { res.append('Set-Cookie', `mirox_sess=; ${cookieAttrs(req, 0)}`); }
async function ensureDb(req) { if (req && req.__dbReady) return; await loadDb(); if (req) req.__dbReady = true; }
async function currentUser(req) { await ensureDb(req); if (!dbOk) return null; const s = readSession(getCookie(req, 'mirox_sess')); if (!s || !s.uid) return null; return userFor(s.uid); }

/* ---------- Model resolver ---------- */
function resolveModelId(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (MIROX_MODELS[s]) return s;
  const miroxTokens = s.match(/mirox-[a-z0-9][a-z0-9._-]*/gi);
  if (miroxTokens) {
    for (const tok of miroxTokens) {
      const low = tok.toLowerCase();
      if (MIROX_MODELS[low]) return low;
      const norm = low.replace(/_/g, '-');
      if (MIROX_MODELS[norm]) return norm;
      for (const id of Object.keys(MIROX_MODELS)) {
        if (id.toLowerCase() === norm) return id;
        if (id.toLowerCase().startsWith(norm + '.')) return id;
      }
    }
  }
  const low = s.toLowerCase();
  for (const id of Object.keys(MIROX_MODELS)) if (id.toLowerCase() === low) return id;
  const lastSlash = s.lastIndexOf('/');
  if (lastSlash >= 0) {
    const tail = s.slice(lastSlash + 1).trim().toLowerCase();
    if (MIROX_MODELS[tail]) return tail;
    for (const id of Object.keys(MIROX_MODELS)) if (id.toLowerCase() === tail) return id;
  }
  return null;
}
function fallbackModelId(raw) {
  const s = String(raw || '').toLowerCase();
  if (!/mirox/.test(s)) return null;
  if (/tail/.test(s)) return 'mirox-tail-r1';
  if (/luna/.test(s)) return 'mirox-luna-1.2';
  if (/\bgen\b/.test(s) || /-gen-/.test(s)) return 'mirox-gen-1';
  if (/pro/.test(s)) return 'mirox-pro-5';
  if (/ultra/.test(s)) return 'mirox-ultra-10';
  if (/eclipse/.test(s)) return 'mirox-eclipse-2.0';
  return 'mirox-tail-r1';
}

async function authFromRequest(req) {
  const h = String(req.headers.authorization || '');
  if (!h) return { user: await currentUser(req), viaKey: false };
  const m = h.match(/^Bearer\s+(mxk_live_[A-Za-z0-9]{24,})$/);
  if (!m) return { error: 'invalid' };
  await ensureDb(req);
  if (!dbOk) return { error: 'invalid' };
  const owner = db.keys[m[1]];
  const u = owner ? db.users[owner] : null;
  const k = u ? u.keys.find((x) => x.key === m[1]) : null;
  if (!u || !k || k.revoked) return { error: 'invalid' };
  k.last_used = nowS(); persist();
  return { user: userFor(owner), viaKey: true };
}

/* ---------- KenSearch ---------- */
async function kensearchSearch(query, limit = 5) {
  if (!KS_KEY) return null;
  try {
    const r = await fetchT(`${KS_BASE}/api/public/v1/search`, {
      method: 'POST',
      headers: { 'x-api-key': KS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    }, 15000);
    if (!r.ok) return null;
    const d = await r.json();
    return d?.data || null;
  } catch (e) { console.warn('[kensearch]', e.message); return null; }
}
async function kensearchRead(url, format = 'markdown') {
  if (!KS_KEY) return null;
  try {
    const r = await fetchT(`${KS_BASE}/api/public/v1/read`, {
      method: 'POST',
      headers: { 'x-api-key': KS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format }),
    }, 15000);
    if (!r.ok) return null;
    const d = await r.json();
    return d?.data || null;
  } catch (e) { console.warn('[kensearch]', e.message); return null; }
}
async function kensearchWebinfo(url) {
  if (!KS_KEY) return null;
  try {
    const r = await fetchT(`${KS_BASE}/api/public/v1/webinfo`, {
      method: 'POST',
      headers: { 'x-api-key': KS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }, 15000);
    if (!r.ok) return null;
    const d = await r.json();
    return d?.data || null;
  } catch (e) { console.warn('[kensearch]', e.message); return null; }
}

/* ---------- Web search fallback ---------- */
const SEARCH_TIMEOUT_MS = 14000;
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
async function duckSearch(query, max = 5) {
  try {
    const r = await fetchT(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' } }, SEARCH_TIMEOUT_MS);
    if (!r.ok) return [];
    const html = await r.text();
    const out = [];
    const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,3000}?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/g;
    let m;
    while ((m = re.exec(html)) !== null && out.length < max) {
      let href = m[1];
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch {} }
      if (href.startsWith('//')) href = 'https:' + href;
      const title = stripHtml(m[2]);
      if (!title || !href || href.includes('duckduckgo.com/y.js')) continue;
      let domain = ''; try { domain = new URL(href).hostname.replace(/^www\./, ''); } catch {}
      out.push({ title, url: href, snippet: stripHtml(m[3]), domain });
    }
    return out;
  } catch { return []; }
}
async function ddgInstantAnswer(query) { try { const r = await fetchT(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {}, 8000); if (!r.ok) return null; const d = await r.json(); if (!(d.Abstract || d.Answer || d.Definition)) return null; return { heading: d.Heading || '', text: d.Abstract || d.Answer || d.Definition || '', source: d.AbstractSource || 'DuckDuckGo', url: d.AbstractURL || '' }; } catch { return null; } }
async function wikiSearch(query) { try { const r = await fetchT(`https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&origin=*`, {}, 8000); if (!r.ok) return []; const d = await r.json(); return (d?.query?.search || []).map((h) => ({ title: h.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`, snippet: stripHtml(h.snippet), domain: 'en.wikipedia.org' })); } catch { return []; } }
async function wikiSummary(title) { try { const r = await fetchT(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {}, 7000); if (!r.ok) return null; const d = await r.json(); if (!d.extract) return null; return { source: 'Wikipedia', heading: d.title || title, text: d.extract, url: d.content_urls?.desktop?.page || '' }; } catch { return null; } }

async function webSearch(query, max = 5) {
  const rawQuery = String(query || '').trim();
  if (KS_KEY) {
    const ks = await kensearchSearch(rawQuery, max);
    if (ks && Array.isArray(ks) && ks.length) {
      const results = ks.map((r) => ({ title: r.title || '', url: r.url || '', snippet: r.description || '', domain: (() => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch { return ''; } })() }));
      let overview = null;
      const firstUrl = results[0]?.url;
      if (firstUrl) {
        const wi = await kensearchWebinfo(firstUrl);
        if (wi && wi.summary) overview = { source: 'KenSearch', heading: wi.title || '', text: wi.summary, url: firstUrl };
      }
      if (!overview) { const ws = await wikiSummary(results[0]?.title || rawQuery); if (ws) overview = { ...ws, kind: 'wiki' }; }
      return { results, overview, query: rawQuery };
    }
  }
  const domainMatch = rawQuery.match(/^(?:site:)?([a-z0-9.-]+\.[a-z]{2,})(?:\s+(.+))?$/i);
  const siteMatch = rawQuery.match(/^site:([a-z0-9.-]+)(?:\s+(.+))?$/i);
  const searchQuery = siteMatch ? `site:${siteMatch[1]} ${siteMatch[2] || ''}`.trim() : (domainMatch ? `site:${domainMatch[1]} ${domainMatch[2] || ''}`.trim() : rawQuery);
  const [organic, instant] = await Promise.all([duckSearch(searchQuery, max), ddgInstantAnswer(searchQuery)]);
  let results = organic.length ? organic : await wikiSearch(searchQuery);
  const seen = new Set();
  results = results.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true))).slice(0, max);
  let overview = instant && instant.text ? { ...instant, kind: 'instant' } : null;
  if (!overview) { const ws = await wikiSummary(results[0]?.title || searchQuery); if (ws) overview = { ...ws, kind: 'wiki' }; }
  return { results, overview, query: searchQuery };
}
function formatSearchContext(query, data) {
  const parts = [];
  if (data.overview?.text) parts.push(`[OVERVIEW — ${data.overview.source}${data.overview.url ? ' (' + data.overview.url + ')' : ''}]\n${data.overview.text}`);
  if (data.results.length) { parts.push(`[${data.results.length} ORGANIC RESULTS]`); parts.push(data.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet || '(no snippet)'}`).join('\n\n')); }
  return parts.length ? `Web search results for "${query}":\n\n` + parts.join('\n\n') : `Web search for "${query}" returned no usable results.`;
}
function detectSearchIntent(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let m = t.match(/(?:^|\b)(?:search(?:\s+(?:the\s+)?(?:web|internet|online))?|google|look\s+up|find\s+(?:info|information|details))\s+(?:for\s+|about\s+|on\s+)?(.+?)[\s.?!,;:]*$/i);
  if (m && m[1]) return m[1].trim();
  m = t.match(/(?:latest|recent|current)\s+(?:news|info|information)\s+(?:on|about)\s+(.+?)[\s.?!,;:]*$/i);
  if (m && m[1]) return m[1].trim();
  return null;
}
function detectImageIntent(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let m = t.match(/^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:generate|create|make|draw|render|paint|show\s+me|give\s+me)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:image|picture|photo|illustration|drawing|painting)\s+(?:of\s+|with\s+|showing\s+)?(.+?)[\s.?!,;:]*$/i);
  if (m && m[1]) return m[1].trim();
  m = t.match(/^(?:an?\s+)?(?:image|picture|photo|illustration)\s+of\s+(.+?)[\s.?!,;:]*$/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

/* ---------- Providers ---------- */
function stripImages(messages) {
  return messages.map((m) => ({ role: m.role, content: Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : String(m.content || '') }));
}
async function callOpenRouter(modelId, messages, maxTokens, stream) {
  if (!OP_KEY) throw new Error('no_op_key');
  const headers = { Authorization: `Bearer ${OP_KEY}`, 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json', 'HTTP-Referer': OP_REFERER, 'X-Title': OP_TITLE };
  const res = await fetchT(OP_CHAT_URL, { method: 'POST', headers, body: JSON.stringify({ model: modelId, messages, max_tokens: maxTokens, stream: !!stream, temperature: 0.7 }) }, 90000);
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`op_${res.status}:${t.slice(0, 200)}`); }
  return res;
}
async function callProvider(kind, modelId, messages, maxTokens, stream) {
  const url = kind === 'hf' ? HF_URL : PL_URL;
  const key = kind === 'hf' ? HF_API_KEY : PL_KEY;
  if (!key) throw new Error('no_key');
  const res = await fetchT(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' }, body: JSON.stringify({ model: modelId, messages, max_tokens: maxTokens, stream: !!stream, temperature: 0.7 }) }, 90000);
  if (!res.ok) throw new Error(`${kind}_${res.status}`);
  return res;
}
async function airouteText(messages, { fast = true, model } = {}) {
  const flat = stripImages(messages);
  let idx = -1;
  for (let i = flat.length - 1; i >= 0; i--) if (flat[i].role === 'user') { idx = i; break; }
  const prompt = idx >= 0 ? flat[idx].content : '';
  const before = idx >= 0 ? flat.slice(0, idx) : flat;
  const systems = before.filter((m) => m.role === 'system').map((m) => m.content);
  const history = before.filter((m) => m.role !== 'system').slice(-40);
  const body = { prompt: [...systems, prompt].filter(Boolean).join('\n\n'), history, ...(fast ? { fast: true } : {}), ...(model ? { model } : {}) };
  const r = await fetchT(`${AIROUTE_BASE}/api/public/v1/chat`, { method: 'POST', headers: { Authorization: `Bearer ${AIROUTE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 90000);
  if (!r.ok) throw new Error('airoute_' + r.status);
  return extractReplyText(await r.json().catch(() => ({})));
}
function textToSSEStream(text) {
  const enc = new TextEncoder();
  const words = String(text || '').split(/(\s+)/);
  const chunks = [];
  let cur = '';
  for (const w of words) { cur += w; if (cur.length >= 24) { chunks.push(cur); cur = ''; } }
  if (cur) chunks.push(cur);
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}
async function miroxChatChain({ messages, cfg, stream, vision, deepThink }) {
  const maxTokens = deepThink ? Math.min(cfg.tokens * 2, 64000) : Math.min(cfg.tokens, 32000);
  if (OP_KEY) {
    const baseChain = (cfg.chain && CHAINS[cfg.chain]) ? CHAINS[cfg.chain] : OP_CHAT;
    const chain = vision ? [...new Set([...OP_VISION, ...baseChain])] : baseChain;
    for (const modelId of chain) {
      try {
        const msgs = OP_VISION_SET.has(modelId) ? messages : stripImages(messages);
        const res = await callOpenRouter(modelId, msgs, maxTokens, stream);
        return { res, provider: 'MiroxAI (SurrRoute)', model: modelId };
      } catch (e) { console.warn('[openrouter]', modelId, e.message); }
    }
  }
  if (HF_API_KEY) {
    const tries = [];
    if (vision) HF_VISION.forEach((m) => tries.push(['hf', m]));
    HF_CHAT.forEach((m) => tries.push(['hf', m]));
    for (const [kind, modelId] of tries) {
      try { const msgs = VISION_MODELS.has(modelId) ? messages : stripImages(messages); const res = await callProvider(kind, modelId, msgs, maxTokens, stream); return { res, provider: 'MiroxAI (SurrRoute)', model: modelId }; }
      catch (e) { console.warn('[provider]', kind, modelId, e.message); }
    }
  }
  if (PL_KEY) {
    const tries = [];
    if (vision) PL_VISION.forEach((m) => tries.push(['pl', m]));
    PL_CHAT.forEach((m) => tries.push(['pl', m]));
    for (const [kind, modelId] of tries) {
      try { const msgs = VISION_MODELS.has(modelId) ? messages : stripImages(messages); const res = await callProvider(kind, modelId, msgs, maxTokens, stream); return { res, provider: 'MiroxAI (SurrRoute)', model: modelId }; }
      catch (e) { console.warn('[provider]', kind, modelId, e.message); }
    }
  }
  if (AIROUTE_KEY) {
    for (const opts of [{ fast: true }, { fast: false, model: 'meta-llama/Llama-3.3-70B-Instruct' }]) {
      try { const text = await airouteText(messages, opts); if (!text) throw new Error('empty reply'); return { res: { body: textToSSEStream(text), json: async () => ({ reply: text }) }, provider: 'MiroxAI (SurrRoute)', model: 'tail-r1' }; }
      catch (e) { console.warn('[airoute]', e.message); }
    }
  }
  throw new Error(GENERIC_ERR);
}
async function pipeProviderStream(body, onEvent, isClosed, onLimit = () => {}) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const split = createThinkSplitter();
  const emitText = (kind, t) => { if (t) onEvent(kind, t); };
  let buf = '';
  try {
    while (true) {
      if (isClosed()) break;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const item = JSON.parse(raw);
          const choice = item.choices?.[0] || {};
          const delta = choice.delta || {};
          const reasoning = reasoningFromDelta(delta);
          if (reasoning) emitText('thinking', reasoning);
          const content = contentFromDelta(delta);
          if (content) split.push(content, emitText);
          if (choice.finish_reason === 'length') onLimit();
        } catch {}
      }
    }
    split.flush(emitText);
  } finally { try { reader.releaseLock(); } catch {} }
}

/* ---------- Image generation ---------- */
async function generateImageHF(prompt) {
  if (!HF_API_KEY) return null;
  for (const model of HF_IMG_MODELS) {
    try {
      const r = await fetchT(`${HF_TXT2IMG}/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json', Accept: 'image/png' },
        body: JSON.stringify({ inputs: prompt.slice(0, 1000), options: { wait_for_model: true } }),
      }, 60000);
      if (!r.ok) continue;
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!ct.startsWith('image/')) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 800) continue;
      const mime = ct.split(';')[0] || 'image/png';
      const wm = applyWatermark(buf, mime);
      return `data:${mime};base64,${wm.toString('base64')}`;
    } catch (e) { console.warn('[hf-img]', model, e.message); }
  }
  return null;
}
async function generateImageAiroute(prompt) {
  if (!AIROUTE_KEY) return null;
  try {
    const r = await fetchT(`${AIROUTE_BASE}/api/public/v1/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AIROUTE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'black-forest-labs/FLUX.1-schnell', prompt: prompt.slice(0, 2000) }),
    }, 60000);
    const d = await r.json().catch(() => ({}));
    if (typeof d.image === 'string') {
      if (d.image.startsWith('http')) return d.image;
      if (d.image.startsWith('data:image')) {
        const [meta, b64] = d.image.split(',');
        const mime = (meta.match(/data:([^;]+)/) || [, 'image/png'])[1];
        const raw = Buffer.from(b64, 'base64');
        const wm = applyWatermark(raw, mime);
        return `data:${mime};base64,${wm.toString('base64')}`;
      }
    }
  } catch (e) { console.warn('[airoute-img]', e.message); }
  return null;
}
async function generateImage(prompt) {
  const fromHF = await generateImageHF(prompt);
  if (fromHF) return fromHF;
  const fromAiroute = await generateImageAiroute(prompt);
  if (fromAiroute) return fromAiroute;
  throw new Error(GENERIC_ERR);
}

function sseInit(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}
function sseWrite(res, obj) { if (res.writableEnded || res.destroyed) return; try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} }
function sseDone(res) { if (res.writableEnded || res.destroyed) return; try { res.write('data: [DONE]\n\n'); } catch {} }

function buildSystemPrompt(cfg, bridge, searchUsed, persona, deepThink, modelId, systemExtra, apiMode, discordMode = false) {
  let p;
  if (apiMode) {
    p = IDENTITY_GUARD + '\n\n' + cfg.basePrompt;
    p += '\n\nNever use <thinking> tags. Give the user the direct final answer only.';
  } else {
    p = IDENTITY_GUARD + '\n\n' + THINKING_RULE + '\n\n' + cfg.basePrompt;
    if (deepThink) p += '\n\n' + DEEP_THINK_RULE;
  }
  if (modelId === 'mirox-tail-r1') p += '\n\n' + TAIL_R1_REASONING_RULE;
  if (searchUsed) p += '\n\nWEB SEARCH MODE: cite sources as [1], [2] when relevant.';
  if (persona) p += `\n\nUser preference: ${persona}`;
  if (systemExtra) p += '\n\n' + safeStr(systemExtra, 8000);
  if (discordMode) p += '\n\n' + DISCORD_PROMPT;
  if (bridge) {
    const e2 = bridge.env || {};
    p += '\n\n' + BRIDGE_PROMPT;
    p += `\n\n=== [Bridge environment] ===\nuser=${e2.user || '(unknown)'}\nhome=~\ncwd=.\nplatform=${e2.platform || '(unknown)'}`;
  }
  return p;
}
function buildEnvBlock(env) {
  return ['[Bridge environment]', `user=${env.user || '?'}`, 'home=~', 'cwd=.', `platform=${env.platform || '?'}`].join('\n');
}

/* ---------- Express app ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  if (req.path.startsWith('/v1') || req.path.startsWith('/openai') || /chat\/completions/.test(req.path)) {
    const hasKey = !!req.headers.authorization;
    const m = req.body?.model ? String(req.body.model).slice(0, 80) : '';
    console.log(`[api] ${req.method} ${req.path} key=${hasKey ? 'yes' : 'no'}${m ? ' model="' + m + '"' : ''}`);
  }
  next();
});

app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
app.use(async (req, res, next) => { await ensureDb(req).catch(() => {}); next(); });

const publicUser = (u) => {
  const plan = PLANS[u.tier] || PLANS.free;
  return { id: u.email, email: u.email, name: u.name, tier: u.tier, provider: u.provider || 'email',
    vision_limit: plan.vision_limit, vision_used: u.vision_used,
    image_limit: plan.image_limit, image_used: u.image_used,
    eclipse_limit: plan.eclipse_daily_limit, eclipse_used: u.eclipse_used,
    api_keys_used: u.keys.filter((k) => !k.revoked).length, api_keys_limit: maxKeys(u.tier) };
};
const publicKey = (k) => ({ id: k.id, name: k.name, key: k.key, created: k.created, last_used: k.last_used || 0, revoked: !!k.revoked });

app.get(['/api/health', '/health', '/ping'], (req, res) => {
  res.json({ ok: true, app: 'MiroxAI', version: 'v115',
    providers: { openrouter: !!OP_KEY, hf: !!HF_API_KEY, airoute: !!AIROUTE_KEY, kensearch: !!KS_KEY, discord: !!DISCORD_BOT_TOKEN },
    primary_provider: 'MiroxAI (SurrRoute)',
    watermark: 'MIROXAI-WATERMARK-v1-LOGO', thinking: true, deep_think: true, api_thinking: false,
    flagship: 'mirox-tail-r1', flagship_free: true,
    image_provider: HF_API_KEY ? 'huggingface' : (AIROUTE_KEY ? 'airoute' : null),
    search_provider: KS_KEY ? 'kensearch' : 'duckduckgo',
    models_endpoint: '/v1/models',
    bot_endpoint: '/v1/bot/chat',
    bot_thinking: false,
    discord_channels: { chat: DISCORD_CHAT_CHANNEL, image: DISCORD_IMAGE_CHANNEL, status: DISCORD_STATUS_CHANNEL },
    storage: {
      durable: KV_ON || VPS_ON,
      kv_enabled: KV_ON,
      vps_enabled: VPS_ON,
      vps_db_path: VPS_ON ? `${VPS_USER}@${VPS_IP}:${VPS_DB_PATH}` : null,
      primary_path: VPS_ON ? VPS_DB_PATH : DATA_FILE,
      fallback_paths: DATA_FILES,
      writable: dbOk,
    },
    legal: { tos: '/tos', privacy: '/privacy-policy' },
    time: nowS() });
});

app.get('/api/web/status', async (req, res) => {
  const t0 = Date.now();
  const [ddg, wiki] = await Promise.all([duckSearch('test', 1).then((r) => r.length > 0).catch(() => false), wikiSearch('Python').then((r) => r.length > 0).catch(() => false)]);
  res.json({ ok: true, duckduckgo: ddg, wikipedia: wiki, kensearch: !!KS_KEY, ms: Date.now() - t0 });
});

function openaiModelList() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: API_MODELS.map((id) => ({
      id, object: 'model', created, owned_by: 'miroxai',
      label: MIROX_MODELS[id]?.label || id,
      tier: MIROX_MODELS[id]?.tier || 'free',
      flagship: !!MIROX_MODELS[id]?.flagship,
      free: MIROX_MODELS[id]?.tier === 'free',
      context_window: MIROX_MODELS[id]?.tokens || 4096,
      tagline: MIROX_MODELS[id]?.tagline || '',
    })),
  };
}
const MODEL_LIST_PATHS = ['/v1/models','/v1/models/','/models','/models/','/api/models','/api/models/','/openai/v1/models','/openai/v1/models/','/api/v1/models','/api/v1/models/'];
app.get(MODEL_LIST_PATHS, (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(openaiModelList()); });
app.head(MODEL_LIST_PATHS, (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.status(200).end(); });
app.get(['/v1/models/*', '/openai/v1/models/*', '/api/v1/models/*'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const wildcard = req.params[0] || '';
  const resolved = resolveModelId(wildcard);
  if (resolved) {
    const created = Math.floor(Date.now() / 1000);
    return res.json({ id: wildcard || resolved, object: 'model', created, owned_by: 'miroxai',
      label: MIROX_MODELS[resolved].label, tier: MIROX_MODELS[resolved].tier,
      flagship: !!MIROX_MODELS[resolved].flagship, free: MIROX_MODELS[resolved].tier === 'free',
      context_window: MIROX_MODELS[resolved].tokens, tagline: MIROX_MODELS[resolved].tagline || '' });
  }
  res.status(404).json({ error: { message: `Model "${wildcard}" not found. GET /v1/models for the list.`, type: 'invalid_request_error', code: 'model_not_found' } });
});

app.get(['/api/config', '/config'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const models = Object.entries(MIROX_MODELS).map(([id, m]) => ({ id, label: m.label, tier: m.tier, tagline: m.tagline || '', flagship: !!m.flagship, icon: m.flagship ? 'ri-star-smile-line' : undefined }));
  res.json({ app: { name: 'MiroxAI', version: 'v115' }, models, default_model: 'mirox-tail-r1', plans: PLANS,
    tts_available: !!F_API, search_available: true, vision_available: true, image_intent: true, image_edit: false,
    image_requires_signin: false, watermark: true, thinking: true, deep_think: true, html_runner: true, api_thinking: false,
    bot_endpoint: '/v1/bot/chat', bot_thinking: false,
    loginment_available: !!LM_CLIENT_ID, email_login_available: ALLOW_EMAIL_LOGIN,
    airoute_available: !!AIROUTE_KEY, openrouter_available: !!OP_KEY, hf_available: !!HF_API_KEY,
    kensearch_available: !!KS_KEY,
    image_provider: HF_API_KEY ? 'huggingface' : (AIROUTE_KEY ? 'airoute' : null),
    search_provider: KS_KEY ? 'kensearch' : 'duckduckgo',
    kde_connect_available: true, support_chat_available: true, developers_url: '/developers',
    flagship: 'mirox-tail-r1', storage_durable: KV_ON || VPS_ON, discord_enabled: !!DISCORD_BOT_TOKEN,
    payments_available: true,
    legal: { tos: '/tos', privacy: '/privacy-policy' } });
});

app.get(['/api/subscription/plans', '/subscription/plans'], (req, res) => {
  const perks = {
    free: ['Tail r1 — free flagship','Luna & Gen unlimited','350k+ context · best reasoning','30 image gens/day','5 Eclipse/day','2 API keys','Web search','Vision','DeepThink','HTML runner'],
    pro: ['Everything in Free','Pro & Ultra models','200 image gens/day','10 API keys'],
    ultimate: ['Everything in Pro','Eclipse — high quality','2000 image gens/day','Priority everything'],
  };
  const tagline = { free: 'Flagship for everyone', pro: 'Most popular', ultimate: 'Power users' };
  res.json({ ok: true, plans: Object.entries(PLANS).map(([id, p]) => ({ id, label: p.label, tagline: tagline[id], vision_limit: p.vision_limit, image_limit: p.image_limit, eclipse_limit: p.eclipse_daily_limit, price_usd: p.price_usd, api_keys_limit: p.api_keys, perks: perks[id] })) });
});

/* AUTH */
app.get('/api/auth/loginment/start', (req, res) => {
  if (!LM_CLIENT_ID) return res.status(503).send('Loginment is not configured.');
  const state = crypto.randomBytes(16).toString('hex');
  res.append('Set-Cookie', `mirox_lm_state=${state}; ${cookieAttrs(req, 600)}`);
  const redirect = encodeURIComponent(PUBLIC_ORIGIN + '/callback');
  res.redirect(`${LM_DOMAIN}/authorize?client_id=${encodeURIComponent(LM_CLIENT_ID)}&redirect_uri=${redirect}&state=${state}`);
});
app.get('/api/auth/loginment/url', (req, res) => {
  if (!LM_CLIENT_ID) return res.status(503).json({ ok: false, error: 'Loginment is not configured.' });
  const state = crypto.randomBytes(16).toString('hex');
  res.append('Set-Cookie', `mirox_lm_state=${state}; ${cookieAttrs(req, 600)}`);
  const redirect = encodeURIComponent(PUBLIC_ORIGIN + '/callback');
  res.json({ ok: true, url: `${LM_DOMAIN}/authorize?client_id=${encodeURIComponent(LM_CLIENT_ID)}&redirect_uri=${redirect}&state=${state}` });
});
app.get(['/callback', '/api/auth/loginment/callback'], async (req, res) => {
  try {
    const code = safeStr(req.query.code, 300), state = safeStr(req.query.state, 100);
    const saved = getCookie(req, 'mirox_lm_state');
    res.append('Set-Cookie', `mirox_lm_state=; ${cookieAttrs(req, 0)}`);
    if (!code || !state || !saved || !safeEq(state, saved)) return res.status(400).send('Login state invalid.');
    if (!LM_CLIENT_ID || !LM_API_KEY) return res.status(503).send('Loginment is not configured.');
    const r = await fetchT(`${LM_DOMAIN}/api/public/v1/token`, { method: 'POST', headers: { Authorization: `Bearer ${LM_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }, 15000);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.success || !data.user?.email) return res.status(401).send('Login failed.');
    await ensureDb(req);
    if (!dbOk) return res.status(503).send('Storage is unavailable.');
    const email = String(data.user.email).toLowerCase();
    const u = userFor(email);
    u.name = data.user.name || u.name;
    u.provider = data.user.provider || 'email';
    u.lm_user_id = data.user.id || null;
    u.last_login = nowS();
    logEvent({ email, event: 'login', provider: u.provider });
    if (!(await persist())) return res.status(503).send('Could not save your account.');
    setSessionCookie(req, res, email);
    res.redirect('/');
  } catch (e) { console.error('[callback]', e.message); res.status(500).send('Server error'); }
});
app.post(['/api/auth/simple-login', '/auth/simple-login'], async (req, res) => {
  if (!ALLOW_EMAIL_LOGIN) return res.status(403).json({ ok: false, error: 'Email login is disabled.' });
  const name = safeStr(req.body?.name, 60).trim();
  const email = safeStr(req.body?.email, 120).trim().toLowerCase();
  if (!name || !email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'Name and email required' });
  await ensureDb(req);
  if (!dbOk) return res.status(503).json({ ok: false, error: 'Storage is unavailable.' });
  const u = userFor(email);
  u.name = name; u.last_login = nowS();
  logEvent({ email, event: 'login' });
  if (!(await persist())) return res.status(503).json({ ok: false, error: 'Could not save your account.' });
  const token = setSessionCookie(req, res, email);
  res.json({ ok: true, token, user: { id: email, email, name, tier: u.tier } });
});
app.post(['/api/logout', '/logout'], (req, res) => { clearSessionCookie(req, res); res.json({ ok: true }); });
app.get(['/api/me', '/me'], async (req, res) => { res.setHeader('Cache-Control', 'no-store'); try { const u = await currentUser(req); res.json({ user: u ? publicUser(u) : null }); } catch { res.json({ user: null }); } });
app.get('/api/persona', async (req, res) => { const u = await currentUser(req); res.json({ ok: true, persona: u?.persona || '' }); });
app.post('/api/persona', async (req, res) => { const u = await currentUser(req); if (!u) return res.status(401).json({ ok: false, error: 'Login required' }); u.persona = safeStr(req.body?.persona, 500); await persist(); res.json({ ok: true }); });
app.get('/api/settings', async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  res.json({ ok: true, settings: getSettings(u) });
});
app.post('/api/settings', async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  u.settings = sanitizeSettings({ ...getSettings(u), ...(req.body || {}) });
  u.persona = u.settings.persona;
  await persist();
  res.json({ ok: true, settings: getSettings(u) });
});

/* PAYMENT REQUESTS (manual admin approval) */
app.post(['/api/payment/request-upgrade', '/payment/request-upgrade'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Sign in to upgrade.' });
  const requested = safeStr(req.body?.tier, 20).trim().toLowerCase();
  const note = safeStr(req.body?.note, 500).trim();
  if (!['pro', 'ultimate'].includes(requested)) return res.status(400).json({ ok: false, error: 'Invalid tier. Choose pro or ultimate.' });
  if (TIER_RANK[requested] <= TIER_RANK[u.tier]) return res.status(400).json({ ok: false, error: `You are already on ${u.tier}. Choose a higher tier.` });
  const existing = db.payment_requests.find((r) => r.email === u.email && r.status === 'pending');
  if (existing) return res.json({ ok: true, request: existing, message: 'You already have a pending upgrade request. Admin will review it.' });
  const request = {
    id: 'pr_' + crypto.randomBytes(6).toString('hex'),
    email: u.email, name: u.name || u.email,
    current_tier: u.tier, requested_tier: requested, note,
    status: 'pending', created: nowS(), updated: nowS(),
  };
  db.payment_requests.push(request);
  if (db.payment_requests.length > 500) db.payment_requests.splice(0, db.payment_requests.length - 500);
  logEvent({ email: u.email, event: 'payment_requested', tier: requested });
  await persist();
  res.json({ ok: true, request, message: 'Request received. Admin will review and activate your plan.' });
});

app.get(['/api/payment/my-requests', '/payment/my-requests'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const requests = (db.payment_requests || []).filter((r) => r.email === u.email).slice(-20).reverse();
  res.json({ ok: true, requests });
});

/* SUPPORT */
app.get('/api/support/conversation', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { const u = await currentUser(req); if (!u) return res.json({ ok: true, conversation: null, signedIn: false }); const conv = (db.tickets || []).find((t) => t.email === u.email && t.status === 'open'); res.json({ ok: true, conversation: conv || null, signedIn: true }); }
  catch { res.json({ ok: true, conversation: null, signedIn: false }); }
});
app.post('/api/support/message', async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Sign in to chat with support.' });
  const content = safeStr(req.body?.content, 4000).trim();
  if (!content) return res.status(400).json({ ok: false, error: 'Message required' });
  const category = safeStr(req.body?.category, 40).trim() || 'other';
  let conv = (db.tickets || []).find((t) => t.email === u.email && t.status === 'open');
  if (!conv) {
    conv = { id: 'tk_' + crypto.randomBytes(6).toString('hex'), email: u.email, name: u.name || u.email, subject: content.slice(0, 80), category, status: 'open', unread_for_agent: 0, unread_for_user: 0, created: nowS(), updated: nowS(), messages: [] };
    db.tickets.push(conv);
  }
  conv.messages.push({ role: 'user', content, ts: nowS() });
  conv.updated = nowS();
  conv.unread_for_agent = (conv.unread_for_agent || 0) + 1;
  logEvent({ email: u.email, event: 'support_message', ticket: conv.id });
  await persist();
  res.json({ ok: true, conversation: conv });
});
app.post('/api/support/close', async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Sign in required' });
  const conv = (db.tickets || []).find((t) => t.email === u.email && t.status === 'open');
  if (conv) { conv.status = 'closed'; conv.updated = nowS(); conv.messages.push({ role: 'system', content: 'Conversation resolved by the user.', ts: nowS() }); await persist(); }
  res.json({ ok: true });
});

/* API KEYS */
app.get(['/api/keys', '/keys'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const keys = u.keys.map(publicKey);
  res.json({ ok: true, keys, limit: maxKeys(u.tier), active: keys.filter((k) => !k.revoked).length, tier: u.tier });
});
app.post(['/api/keys', '/keys'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const limit = maxKeys(u.tier);
  const active = u.keys.filter((k) => !k.revoked).length;
  if (active >= limit) return res.status(400).json({ ok: false, error: `Key limit reached (${limit} for ${u.tier})` });
  const name = safeStr(req.body?.name, 60).trim() || `Key ${u.keys.length + 1}`;
  const raw = 'mxk_live_' + crypto.randomBytes(24).toString('hex');
  const key = { id: 'k_' + crypto.randomBytes(6).toString('hex'), name, key: raw, created: nowS(), last_used: 0, revoked: false };
  u.keys.push(key);
  db.keys[raw] = u.email;
  logEvent({ email: u.email, event: 'key_created', id: key.id, name });
  const saved = await persist();
  if (!saved) return res.status(503).json({ ok: false, error: 'Could not save the key. Storage may be temporarily unavailable.' });
  res.json({ ok: true, key: publicKey(key), keys: u.keys.map(publicKey), limit, active: u.keys.filter((k) => !k.revoked).length });
});
app.post(['/api/keys/restore', '/keys/restore'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const incoming = Array.isArray(req.body?.keys) ? req.body.keys.slice(0, 50) : [];
  if (!incoming.length) return res.json({ ok: true, restored: 0, keys: u.keys.map(publicKey) });
  let restored = 0;
  const existingIds = new Set(u.keys.map((k) => k.id));
  const existingKeys = new Set(u.keys.map((k) => k.key));
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    const k = raw.key;
    if (typeof k !== 'string' || !k.startsWith('mxk_live_')) continue;
    if (existingKeys.has(k)) continue;
    if (existingIds.has(raw.id)) continue;
    const owner = db.keys[k];
    if (owner && owner !== u.email) continue;
    const limit = maxKeys(u.tier);
    if (u.keys.filter((x) => !x.revoked).length >= limit) break;
    const newKey = { id: typeof raw.id === 'string' && raw.id.startsWith('k_') ? raw.id : ('k_' + crypto.randomBytes(6).toString('hex')), name: safeStr(raw.name, 60).trim() || `Restored key ${u.keys.length + 1}`, key: k, created: typeof raw.created === 'number' && raw.created > 0 ? raw.created : nowS(), last_used: typeof raw.last_used === 'number' && raw.last_used > 0 ? raw.last_used : 0, revoked: !!raw.revoked };
    u.keys.push(newKey);
    db.keys[k] = u.email;
    existingIds.add(newKey.id);
    existingKeys.add(newKey.key);
    restored++;
  }
  if (restored > 0) {
    logEvent({ email: u.email, event: 'key_restored', count: restored });
    const saved = await persist();
    if (!saved) return res.status(503).json({ ok: false, error: 'Could not persist restored keys.' });
  }
  res.json({ ok: true, restored, keys: u.keys.map(publicKey), limit: maxKeys(u.tier), active: u.keys.filter((k) => !k.revoked).length });
});
app.post(['/api/keys/rename', '/keys/rename'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const id = safeStr(req.body?.id, 40), name = safeStr(req.body?.name, 60).trim();
  if (!id || !name) return res.status(400).json({ ok: false, error: 'id and name required' });
  const key = u.keys.find((k) => k.id === id);
  if (!key) return res.status(404).json({ ok: false, error: 'Key not found' });
  key.name = name;
  await persist();
  res.json({ ok: true, key: publicKey(key), keys: u.keys.map(publicKey) });
});
app.post(['/api/keys/revoke', '/keys/revoke'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const key = u.keys.find((k) => k.id === safeStr(req.body?.id, 40));
  if (!key) return res.status(404).json({ ok: false, error: 'Key not found' });
  key.revoked = true;
  logEvent({ email: u.email, event: 'key_revoked', id: key.id });
  await persist();
  res.json({ ok: true, keys: u.keys.map(publicKey) });
});
app.post(['/api/keys/delete', '/keys/delete'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const id = safeStr(req.body?.id, 40);
  const key = u.keys.find((k) => k.id === id);
  if (key) delete db.keys[key.key];
  u.keys = u.keys.filter((k) => k.id !== id);
  logEvent({ email: u.email, event: 'key_deleted', id });
  await persist();
  res.json({ ok: true, keys: u.keys.map(publicKey) });
});

/* HISTORY */
app.get(['/api/images/history', '/images/history'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const u = await currentUser(req);
  if (!u) return res.json({ ok: true, images: [] });
  const items = await Promise.all(u.images.slice(0, 30).map(async (it, i) => ({ id: it.id || ('img-' + String(it.ts || 'x') + '-' + i), ts: it.ts, prompt: it.prompt, image: it.remote || (await blobGet(it.id)), watermarked: it.watermarked === true })));
  res.json({ ok: true, images: items.filter((x) => x.image) });
});
app.post(['/api/images/delete', '/images/delete'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const id = safeStr(req.body?.id, 60);
  const prompt = safeStr(req.body?.prompt, 400);
  const ts = Number(req.body?.ts) || 0;
  const removed = [];
  u.images = u.images.filter((it) => {
    let match = false;
    if (id && it.id && it.id === id) match = true;
    else if (!id && prompt && it.prompt === prompt && (!ts || it.ts === ts)) match = true;
    if (match) { removed.push(it); return false; }
    return true;
  });
  for (const it of removed) if (it.id) blobDel(it.id).catch(() => {});
  if (removed.length) await persist();
  res.json({ ok: true, removed: removed.length });
});
app.post(['/api/images/clear', '/images/clear'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const ids = u.images.map((it) => it.id).filter(Boolean);
  u.images = [];
  for (const id of ids) blobDel(id).catch(() => {});
  await persist();
  res.json({ ok: true });
});

/* SEARCH */
app.get(['/api/search', '/search'], async (req, res) => {
  const q = safeStr(req.query.q, 400).trim();
  if (!q) return res.status(400).json({ ok: false, error: 'Query required' });
  try { const data = await webSearch(q, 8); res.json({ ok: true, query: q, results: data.results, overview: data.overview }); }
  catch { res.status(500).json({ ok: false, error: 'Search failed' }); }
});

/* IMAGE GEN API */
app.post(['/v1/images/generations', '/openai/v1/images/generations', '/api/v1/images/generations'], async (req, res) => {
  try {
    const prompt = safeStr(req.body?.prompt, 2000).trim();
    if (!prompt) return res.status(400).json({ error: { message: 'Prompt required' } });
    const auth = await authFromRequest(req);
    if (auth.error) return res.status(401).json({ error: { message: 'Invalid API key' } });
    const u = auth.user;
    if (!u) return res.status(401).json({ error: { message: 'Sign in to generate images' } });
    const plan = PLANS[u.tier] || PLANS.free;
    if (u.image_used >= plan.image_limit) return res.status(429).json({ error: { message: 'Daily image limit reached' } });
    const dataUrl = await generateImage(prompt);
    u.image_used += 1;
    await saveImage(u, prompt, dataUrl);
    logEvent({ email: u.email, event: 'image_generated', prompt: prompt.slice(0, 300) });
    await persist();
    res.json({ ok: true, image: dataUrl, watermarked: true });
  } catch { res.status(502).json({ error: { message: GENERIC_ERR } }); }
});

/* CHAT COMPLETIONS */
const CHAT_PATHS = ['/v1/chat/completions','/chat/completions','/openai/v1/chat/completions','/api/v1/chat/completions','/api/chat/completions','/v1/bot/chat'];

app.post(CHAT_PATHS, async (req, res) => {
  const t0 = Date.now();
  let closed = false;
  req.on('close', () => { closed = true; });
  const isClosed = () => closed;

  const isBotEndpoint = req.path === '/v1/bot/chat';

  const body = req.body || {};
  const wantStream = body.stream === true || String(req.headers.accept || '').includes('text/event-stream');
  const rawModel = safeStr(body.model, 200) || 'mirox-tail-r1';

  let model = resolveModelId(rawModel);
  if (!model) {
    model = fallbackModelId(rawModel);
    if (model) console.log(`[chat] fallback: raw="${rawModel}" → "${model}"`);
  }

  const text = safeStr(body.message, 200000).trim();
  const incomingFiles = Array.isArray(body.files) ? body.files : [];
  const files = incomingFiles.slice(0, 10);
  const uploadedImages = incomingFiles.filter((f) => f && (f.type === 'image' || /^image\//i.test(String(f.mimeType || f.mime_type || '')))).length;
  const history = Array.isArray(body.history) ? body.history.slice(-14) : [];
  const bridge = body.bridge && body.bridge.connected ? body.bridge : null;
  const forceSearch = body.search === true;
  const sourceImage = safeStr(body.source_image, 12 * 1024 * 1024);
  const deepThink = isBotEndpoint ? false : (body.deep_think === true);
  const systemExtra = safeStr(body.system_extra, 8000);

  const fail = (code, message) => res.status(code).json({ error: { message, type: 'invalid_request_error', code } });
  const signinReply = (message) => {
    if (!wantStream) return res.json({ reply: message, signin_required: true, _ms: Date.now() - t0, provider: 'MiroxAI (SurrRoute)' });
    sseInit(res); sseWrite(res, { signin_required: true, message }); sseWrite(res, { d: message }); sseWrite(res, { done: true }); sseDone(res); res.end();
  };
  const fixedReply = (message) => {
    if (!wantStream) return res.json({ reply: message, _ms: Date.now() - t0, provider: 'MiroxAI (SurrRoute)' });
    sseInit(res); sseWrite(res, { p: 'MiroxAI (SurrRoute)' }); sseWrite(res, { d: message }); sseWrite(res, { done: true }); sseDone(res); res.end();
  };

  try {
    const auth = isBotEndpoint
      ? { user: null, viaKey: false }
      : await authFromRequest(req);
    if (auth.error) return fail(401, 'Invalid API key');
    const u = auth.user || null;
    const viaKey = !!auth.viaKey;

    if (!model) {
      const list = API_MODELS.map((m) => `"${m}"`).join(', ');
      return res.status(404).json({ error: { message: `Model "${rawModel}" not found. Available: ${list}. See GET /v1/models.`, type: 'invalid_request_error', code: 'model_not_found' } });
    }
    const effectiveModel = model;

    if (viaKey && !API_MODELS.includes(effectiveModel)) {
      const list = API_MODELS.map((m) => `"${m}"`).join(', ');
      return res.status(403).json({ error: { message: `Model "${effectiveModel}" is not available through the API. Available: ${list}.`, type: 'invalid_request_error', code: 'model_not_available' } });
    }

    const cfg = MIROX_MODELS[effectiveModel];
    if (!cfg) return res.status(404).json({ error: { message: `Model "${rawModel}" not found. See GET /v1/models.`, type: 'invalid_request_error', code: 'model_not_found' } });

    const tier = u ? u.tier : 'free';
    const plan = PLANS[tier] || PLANS.free;
    if (tier === 'free' && uploadedImages > 10) return fail(413, 'Free users can upload up to 10 images per message.');
    if (cfg.tier === 'pro' && TIER_RANK[tier] < 1) return fail(403, 'Pro plan required');
    if (cfg.tier === 'ultimate' && tier !== 'ultimate') return fail(403, 'Ultimate plan required');
    if (!text && !files.length) return fail(400, 'Empty message');

    const imagePrompt = isBotEndpoint ? null : ((files.length || deepThink) ? null : detectImageIntent(text));
    if (imagePrompt) {
      if (!u) return signinReply('Sign in to generate images with Mirox.');
      if (u.image_used >= plan.image_limit) return fixedReply(`Daily image limit reached for the ${plan.label} plan.`);
      try {
        const dataUrl = await generateImage(imagePrompt);
        u.image_used += 1;
        await saveImage(u, imagePrompt, dataUrl);
        logEvent({ email: u.email, event: 'image_generated_chat', prompt: imagePrompt.slice(0, 300) });
        await persist();
        if (!wantStream) return res.json({ reply: '', image: dataUrl, watermarked: true, _ms: Date.now() - t0 });
        sseInit(res); sseWrite(res, { img: dataUrl, watermarked: true }); sseWrite(res, { done: true }); sseDone(res); return res.end();
      } catch { return fixedReply('Image generation failed. Please try again in a moment.'); }
    }

    const searchQuery = forceSearch ? text : detectSearchIntent(text);
    if (wantStream) sseInit(res);

    const apiMode = viaKey || isBotEndpoint;
    const msgs = [{ role: 'system', content: buildSystemPrompt(cfg, bridge, !!searchQuery, u?.persona || '', deepThink, effectiveModel, apiMode ? systemExtra : [userContextPrompt(u), systemExtra].filter(Boolean).join('\n\n'), apiMode) }];
    for (const h of history) {
      const role = h && h.role;
      const content = safeStr(h && h.content, 6000).trim();
      if ((role === 'user' || role === 'assistant') && content) msgs.push({ role, content });
    }

    let userText = text || '(no text)';
    if (bridge && !userText.startsWith('[Bridge environment]')) userText = buildEnvBlock(bridge.env || {}) + '\n\n' + userText;
    const visionParts = [];
    let visionUsed = false;
    for (const f of files) {
      if (f && f.type === 'image' && typeof f.dataUrl === 'string' && f.dataUrl.startsWith('data:image/')) {
        visionParts.push({ type: 'image_url', image_url: { url: f.dataUrl } });
        visionUsed = true;
      } else if (f && f.type === 'text' && typeof f.content === 'string') {
        userText += `\n\n[Attached file: ${safeStr(f.name, 120) || 'file'}]\n${f.content.slice(0, 60000)}`;
      }
    }
    msgs.push({ role: 'user', content: visionParts.length ? [{ type: 'text', text: userText }, ...visionParts] : userText });

    let searchData = null;
    if (searchQuery) {
      if (wantStream) sseWrite(res, { search: { query: searchQuery } });
      searchData = await webSearch(searchQuery, 5).catch(() => ({ results: [], overview: null }));
      if (wantStream) {
        if (searchData.overview?.text) sseWrite(res, { overview: { source: searchData.overview.source, heading: searchData.overview.heading || '', text: searchData.overview.text, url: searchData.overview.url || '' } });
        for (const r of searchData.results) { if (closed) break; sseWrite(res, { source: { title: r.title, url: r.url, domain: r.domain || '' } }); await sleep(60); }
        sseWrite(res, { search_done: true, count: searchData.results.length });
      }
      const hasData = searchData.results.length || searchData.overview;
      msgs.push({ role: 'system', content: hasData ? formatSearchContext(searchQuery, searchData) : `Web search for "${searchQuery}" returned no results. Answer from your own knowledge and say you could not verify.` });
    }

    const finishUsage = async () => {
      logChat({ email: u ? u.email : 'guest', model: effectiveModel, message: (text || '(vision)').slice(0, 200) });
      if (u) { u.daily_used += 1; if (visionUsed) u.vision_used += 1; if (effectiveModel === 'mirox-eclipse-2.0') u.eclipse_used += 1; }
      await persist();
    };

    const hasBinaryFile = files.some((f) => f && f.type !== 'image' && (f.base64 || (typeof f.dataUrl === 'string' && f.dataUrl.includes(','))));
    const toolsOn = !apiMode && !!u && (hasBinaryFile || (typeof body.tools === 'boolean' ? body.tools : u.settings?.tools === true));
    if (toolsOn) {
      const saved = await saveAttachments(files, u);
      const last = msgs[msgs.length - 1];
      if (saved.length && last && typeof last.content === 'string') {
        last.content += `\n\n[Attached files saved to the workspace: ${saved.join(', ')}]`;
      }
      const out = await runAgent({
        messages: msgs,
        user: u,
        chain: (m) => miroxChatChain({ messages: m, cfg, stream: false, vision: visionUsed, deepThink }).then((r) => r.res),
        emit: (o) => { if (wantStream) sseWrite(res, o); },
        isClosed: () => closed,
        maxSteps: tier === 'free' ? 20 : 60,
        beforeTool: async () => {
          if (tier !== 'free') return true;
          const now = Date.now();
          const windowMs = 3 * 60 * 60 * 1000;
          if (!Array.isArray(u.tool_step_timestamps)) u.tool_step_timestamps = [];
          u.tool_step_timestamps = u.tool_step_timestamps.filter((ts) => Number.isFinite(ts) && now - ts < windowMs);
          if (u.tool_step_timestamps.length >= 20) { await persist(); return false; }
          u.tool_step_timestamps.push(now);
          await persist();
          return true;
        },
      });
      await finishUsage();
      if (!wantStream) {
        return res.json({ reply: out.text, tools_used: out.toolCalls, provider: 'MiroxAI (SurrRoute)', model: effectiveModel, _ms: Date.now() - t0 });
      }
      sseWrite(res, { p: 'MiroxAI (SurrRoute)', model: effectiveModel, deep_think: deepThink });
      for (let i = 0; i < out.text.length && !closed; i += 28) sseWrite(res, { d: out.text.slice(i, i + 28) });
      if (!closed) sseWrite(res, { done: true });
      sseDone(res);
      return res.end();
    }

    const result = await miroxChatChain({ messages: msgs, cfg, stream: wantStream, vision: visionUsed, deepThink });

    if (!wantStream) {
      const data = await result.res.json().catch(() => ({}));
      let reply = extractReplyText(data) || '(empty)';
      if (apiMode) reply = stripThinking(reply);
      await finishUsage();
      return res.json({ reply, _ms: Date.now() - t0, provider: 'MiroxAI (SurrRoute)', model: effectiveModel, search: searchQuery ? { query: searchQuery, results: searchData.results, overview: searchData.overview } : null });
    }

    sseWrite(res, { p: 'MiroxAI (SurrRoute)', model: effectiveModel, deep_think: deepThink });
    if (apiMode) {
      let buf = '';
      await pipeProviderStream(result.res.body, (kind, t) => { if (kind === 'answer') buf += t; }, isClosed, () => sseWrite(res, { limit: true }));
      const clean = stripThinking(buf);
      const CH = 28;
      for (let i = 0; i < clean.length; i += CH) {
        if (closed) break;
        sseWrite(res, { d: clean.slice(i, i + CH) });
      }
    } else {
      await pipeProviderStream(result.res.body, (kind, t) => sseWrite(res, kind === 'thinking' ? { t } : { d: t }), isClosed, () => sseWrite(res, { limit: true }));
    }
    if (!closed) sseWrite(res, { done: true });
    sseDone(res);
    await finishUsage();
    res.end();
  } catch (e) {
    console.warn('[chat]', e.message);
    if (res.headersSent) { if (wantStream) { sseWrite(res, { error: { message: GENERIC_ERR } }); sseDone(res); } try { res.end(); } catch {} }
    else res.status(502).json({ error: { message: GENERIC_ERR } });
  }
});

/* ADMIN */
function signAdmin() { return signSession({ admin: true, exp: nowS() + 6 * 3600 }); }
function requireAdmin(req, res, next) {
  if (!ADMIN_PASS) return res.status(503).json({ ok: false, error: 'ADMIN_PASSWORD is not set' });
  const d = readSession(String(req.headers['x-admin-token'] || ''));
  if (!d || !d.admin) return res.status(401).json({ ok: false, error: 'Admin auth required' });
  next();
}
app.post(['/api/admin/auth', '/admin/auth'], (req, res) => {
  if (!ADMIN_PASS) return res.status(503).json({ ok: false, error: 'ADMIN_PASSWORD is not set' });
  const pass = safeStr(req.body?.password, 200);
  if (!pass || !safeEq(pass, ADMIN_PASS)) return res.status(401).json({ ok: false, error: 'Invalid password' });
  res.json({ ok: true, token: signAdmin() });
});
app.get(['/api/admin/stats', '/admin/stats'], requireAdmin, async (req, res) => {
  await ensureDb(req);
  const users = Object.values(db.users);
  const imgEvents = db.events.filter((e) => /image_(generated|edited)/.test(e.event || '')).slice(-60).reverse().map((e) => ({ ts: e.ts, email: e.email || '—', prompt: e.prompt || '' }));
  const openTickets = (db.tickets || []).filter((t) => t.status === 'open').length;
  const unreadSupport = (db.tickets || []).reduce((s, t) => s + (t.unread_for_agent || 0), 0);
  const pendingPayments = (db.payment_requests || []).filter((r) => r.status === 'pending').length;
  res.json({ ok: true, durable: KV_ON || VPS_ON, kv: KV_ON, vps: VPS_ON, db_writable: dbOk,
    storage: VPS_ON ? `vps:${VPS_USER}@${VPS_IP}:${VPS_DB_PATH}` : (KV_ON ? 'upstash-kv' : DATA_FILE),
    warning: (!KV_ON && !VPS_ON) ? 'No durable store configured. Set VPS_IP+VPS_KEY (or Upstash) for persistent data.' : null,
    storage_paths: DATA_FILES, users: users.length, chats: db.chats.length, events: db.events.length, images: imgEvents.length,
    open_tickets: openTickets, unread_support: unreadSupport, pending_payments: pendingPayments,
    users_data: Object.fromEntries(users.map((u) => [u.email, { name: u.name, tier: u.tier, daily_used: u.daily_used, image_used: u.image_used, eclipse_used: u.eclipse_used, last_login: u.last_login, keys: (u.keys || []).length }])),
    chats_data: db.chats.slice(-100).reverse(), events_data: db.events.slice(-100).reverse(), images_data: imgEvents });
});
app.post(['/api/admin/set-tier', '/admin/set-tier'], requireAdmin, async (req, res) => {
  await ensureDb(req);
  if (!dbOk) return res.status(503).json({ ok: false, error: 'Storage is not readable.' });
  const email = safeStr(req.body?.email, 200).trim().toLowerCase();
  const tier = safeStr(req.body?.tier, 20).trim();
  if (!email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'Valid email required' });
  if (!['free', 'pro', 'ultimate'].includes(tier)) return res.status(400).json({ ok: false, error: 'Invalid tier' });
  const u = userFor(email);
  u.tier = tier;
  logEvent({ email, event: 'tier_set', tier });
  if (!(await persist())) return res.status(500).json({ ok: false, error: 'Save failed.' });
  res.json({ ok: true, email, tier });
});
app.get(['/api/admin/vps-test', '/admin/vps-test'], requireAdmin, async (req, res) => {
  if (!VPS_ON) return res.json({ ok: false, error: 'VPS not configured (set VPS_IP + VPS_KEY).' });
  try {
    const probe = await vpsExec(`ls -la /var/lib/mirox && echo '---' && wc -c ${VPS_DB_PATH} 2>/dev/null || true`);
    res.json({ ok: true, vps_ip: VPS_IP, user: VPS_USER, db_path: VPS_DB_PATH, output: probe.stdout });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* Payment management */
app.get(['/api/admin/payment-requests', '/admin/payment-requests'], requireAdmin, async (req, res) => {
  await ensureDb(req);
  const list = (db.payment_requests || []).slice().sort((a, b) => b.created - a.created);
  res.json({ ok: true, requests: list });
});
app.post(['/api/admin/payment-approve', '/admin/payment-approve'], requireAdmin, async (req, res) => {
  await ensureDb(req);
  const id = safeStr(req.body?.id, 60);
  const request = (db.payment_requests || []).find((r) => r.id === id);
  if (!request) return res.status(404).json({ ok: false, error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ ok: false, error: 'Already processed' });
  const u = userFor(request.email);
  u.tier = request.requested_tier;
  request.status = 'approved';
  request.updated = nowS();
  request.processed_by = 'admin';
  logEvent({ email: request.email, event: 'payment_approved', tier: request.requested_tier });
  if (!(await persist())) return res.status(500).json({ ok: false, error: 'Save failed.' });
  res.json({ ok: true, request, user: { email: u.email, tier: u.tier } });
});
app.post(['/api/admin/payment-reject', '/admin/payment-reject'], requireAdmin, async (req, res) => {
  await ensureDb(req);
  const id = safeStr(req.body?.id, 60);
  const request = (db.payment_requests || []).find((r) => r.id === id);
  if (!request) return res.status(404).json({ ok: false, error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ ok: false, error: 'Already processed' });
  request.status = 'rejected';
  request.updated = nowS();
  request.reason = safeStr(req.body?.reason, 300).trim() || null;
  logEvent({ email: request.email, event: 'payment_rejected' });
  if (!(await persist())) return res.status(500).json({ ok: false, error: 'Save failed.' });
  res.json({ ok: true, request });
});

app.get(['/api/admin/support/conversations', '/admin/support/conversations'], requireAdmin, async (req, res) => { await ensureDb(req); res.json({ ok: true, conversations: (db.tickets || []).slice().sort((a, b) => (b.updated || 0) - (a.updated || 0)) }); });
app.post(['/api/admin/support/reply', '/admin/support/reply'], requireAdmin, async (req, res) => {
  await ensureDb(req);
  const id = safeStr(req.body?.id, 60), content = safeStr(req.body?.content, 4000).trim();
  if (!id || !content) return res.status(400).json({ ok: false, error: 'id and content required' });
  const conv = (db.tickets || []).find((t) => t.id === id);
  if (!conv) return res.status(404).json({ ok: false, error: 'Not found' });
  conv.messages.push({ role: 'agent', content, ts: nowS() });
  conv.updated = nowS();
  conv.unread_for_user = (conv.unread_for_user || 0) + 1;
  conv.unread_for_agent = 0;
  logEvent({ email: conv.email, event: 'support_reply', ticket: conv.id });
  await persist();
  res.json({ ok: true, conversation: conv });
});
app.post(['/api/admin/support/close', '/admin/support/close'], requireAdmin, async (req, res) => {
  await ensureDb(req);
  const id = safeStr(req.body?.id, 60);
  const conv = (db.tickets || []).find((t) => t.id === id);
  if (!conv) return res.status(404).json({ ok: false, error: 'Not found' });
  conv.status = 'closed'; conv.updated = nowS(); conv.unread_for_agent = 0;
  conv.messages.push({ role: 'system', content: 'Conversation closed by support.', ts: nowS() });
  await persist();
  res.json({ ok: true });
});
app.post(['/api/admin/support/reopen', '/admin/support/reopen'], requireAdmin, async (req, res) => {
  await ensureDb(req);
  const id = safeStr(req.body?.id, 60);
  const conv = (db.tickets || []).find((t) => t.id === id);
  if (!conv) return res.status(404).json({ ok: false, error: 'Not found' });
  conv.status = 'open'; conv.updated = nowS();
  conv.messages.push({ role: 'system', content: 'Conversation reopened.', ts: nowS() });
  await persist();
  res.json({ ok: true });
});

/* BRIDGE DOWNLOAD */
app.get('/api/bridge/download', async (req, res) => {
  let archiver;
  try { archiver = (await import('archiver')).default; } catch { return res.status(500).json({ ok: false, error: 'archiver is not installed.' }); }
  let runner;
  try { runner = await fs.readFile(path.join(__dirname, 'mirox_client_bridge', 'runner.py'), 'utf8'); } catch { return res.status(500).json({ ok: false, error: 'runner.py is missing.' }); }
  const name = safeStr(req.query.name, 60).trim() || 'My Laptop';
  const port = Number(req.query.port) || 8765;
  const readme = '# MiroxAI Bridge\n\n1. pip install aiohttp\n2. (optional) pip install pillow pyperclip\n3. (optional) sudo apt install kdeconnect\n4. python runner.py\n';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="mirox_client_bridge.zip"');
  res.setHeader('Cache-Control', 'no-store');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', () => { try { res.end(); } catch {} });
  archive.pipe(res);
  archive.append(JSON.stringify({ bridge_name: name, port, allowed_dirs: ['~'], max_output_bytes: 200000 }, null, 2), { name: 'mirox_client_bridge/config.json' });
  archive.append(runner, { name: 'mirox_client_bridge/runner.py' });
  archive.append(readme, { name: 'mirox_client_bridge/README.md' });
  await archive.finalize();
});

/* LEGAL PAGES */
const LEGAL_STYLE = `
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    line-height:1.65;color:#1f2937;background:#f8fafc;padding:2rem 1rem;font-size:15px}
  .wrap{max-width:820px;margin:0 auto;background:#fff;border-radius:14px;
    padding:2.5rem 2.25rem;box-shadow:0 4px 18px rgba(15,23,42,.06);border:1px solid #e5e7eb}
  .back{display:inline-block;margin-bottom:1.25rem;color:#4d6bfe;text-decoration:none;font-size:.9rem;font-weight:500}
  .back:hover{text-decoration:underline}
  h1{font-size:1.85rem;margin:0 0 .25rem;color:#0f172a;letter-spacing:-.01em}
  .updated{color:#6b7280;font-size:.88rem;margin:0 0 2rem;padding-bottom:1rem;border-bottom:1px solid #f1f5f9}
  h2{font-size:1.15rem;margin:2.25rem 0 .6rem;color:#0f172a}
  h2:first-of-type{margin-top:0}
  p,li{color:#374151}
  p{margin:0 0 .9rem}
  ul{margin:0 0 1rem;padding-left:1.25rem}
  li{margin:.25rem 0}
  strong{color:#111827}
  a{color:#4d6bfe;text-decoration:none}
  a:hover{text-decoration:underline}
  footer{margin-top:2.5rem;padding-top:1.5rem;border-top:1px solid #e5e7eb;color:#6b7280;font-size:.85rem;text-align:center}
  code{background:#f1f5f9;padding:.1rem .35rem;border-radius:4px;font-size:.9em}
`;
function legalPage(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="index,follow">
<title>${title} — MiroxAI</title>
<style>${LEGAL_STYLE}</style>
</head><body><div class="wrap">
<a class="back" href="/">← Back to MiroxAI</a>
<h1>${title}</h1>
${bodyHtml}
<footer>MiroxAI is operated by OpenSurr · <a href="mailto:support@miroxai.org">support@miroxai.org</a></footer>
</div></body></html>`;
}

const TOS_BODY = `
<p class="updated">Last updated: January 2025</p>
<p>Welcome to MiroxAI. These Terms of Service (“Terms”) govern your access to and use of the MiroxAI website, applications, API, and Discord bot (collectively, the “Service”), operated by OpenSurr (“we”, “us”, or “our”). By accessing or using the Service, you agree to be bound by these Terms. If you do not agree, please do not use the Service.</p>
<h2>1. Acceptance of Terms</h2>
<p>By creating an account, signing in, using an API key, or accessing the Service in any way, you confirm that you are at least 13 years old (or the minimum age required in your jurisdiction) and that you agree to these Terms.</p>
<h2>2. Description of Service</h2>
<p>MiroxAI provides AI-powered chat, web search, vision analysis, image generation, API access, and related tools. We may add, change, or remove features at any time without notice.</p>
<h2>3. Accounts</h2>
<p>You are responsible for maintaining the confidentiality of your account credentials and any API keys. You agree to provide accurate information and to notify us promptly of any unauthorized use of your account.</p>
<h2>4. Acceptable Use</h2>
<p>You agree not to use the Service to violate laws, infringe rights, generate harmful content, bypass limits, reverse-engineer, spam, or abuse the service.</p>
<h2>5. API Keys</h2>
<p>API keys are personal credentials. You are responsible for all activity with your keys. Revoke compromised keys immediately.</p>
<h2>6. Plans and Payments</h2>
<p>Some features require a paid plan (Pro or Ultimate). Payments are non-refundable except where required by law. Admin-approved upgrades take effect immediately.</p>
<h2>7. Your Content</h2>
<p>You retain ownership of prompts, files, and other content. You grant us a limited license to process your content to provide the Service.</p>
<h2>8. AI Output Disclaimer</h2>
<p>AI output may be incorrect, incomplete, or offensive. Do not rely on it for legal, medical, financial, or other professional advice.</p>
<h2>9. Availability and Changes</h2>
<p>We aim to keep the Service available but do not guarantee uninterrupted access.</p>
<h2>10. Termination</h2>
<p>We may suspend or terminate your access if you violate these Terms or if required by law.</p>
<h2>11. Limitation of Liability</h2>
<p>To the maximum extent permitted by law, the Service is provided “as is” without warranties. OpenSurr is not liable for indirect or consequential damages.</p>
<h2>12. Changes to These Terms</h2>
<p>We may update these Terms. Continued use after changes constitutes acceptance.</p>
<h2>13. Contact</h2>
<p>Questions? Email <a href="mailto:support@miroxai.org">support@miroxai.org</a>.</p>
`;

const PRIVACY_BODY = `
<p class="updated">Last updated: January 2025</p>
<p>This Privacy Policy explains how OpenSurr collects, uses, and protects your information when you use MiroxAI.</p>
<h2>1. Information We Collect</h2>
<ul>
<li><strong>Account information:</strong> name, email, login provider.</li>
<li><strong>Usage data:</strong> messages, prompts, model selections, feature usage.</li>
<li><strong>API data:</strong> API keys and request metadata.</li>
<li><strong>Technical data:</strong> IP address, browser type, device info.</li>
</ul>
<h2>2. How We Use Your Information</h2>
<ul>
<li>To provide and improve the Service;</li>
<li>To process your requests, prompts, and searches;</li>
<li>To manage accounts, API keys, and subscription plans;</li>
<li>To detect abuse and maintain security;</li>
<li>To respond to support requests.</li>
</ul>
<h2>3. Cookies and Sessions</h2>
<p>We use a small number of cookies to keep you signed in and protect against CSRF. We do not use advertising cookies.</p>
<h2>4. Third-Party Services</h2>
<p>We may send your prompts to third-party AI model providers and search services. We do not sell your personal information.</p>
<h2>5. Data Retention</h2>
<p>We retain account data and chat history for as long as your account is active or as needed to provide the Service.</p>
<h2>6. Your Rights</h2>
<p>You may request access, correction, export, or deletion of your data by emailing <a href="mailto:support@miroxai.org">support@miroxai.org</a>.</p>
<h2>7. Children’s Privacy</h2>
<p>The Service is not directed to children under 13.</p>
<h2>8. Security</h2>
<p>We use reasonable technical measures including encrypted connections and signed session tokens. Keep your API keys private.</p>
<h2>9. International Transfers</h2>
<p>Your information may be processed in countries other than your own. We ensure appropriate safeguards when transferring internationally.</p>
<h2>10. Changes to This Policy</h2>
<p>We may update this Privacy Policy from time to time. Material changes will be reflected by an updated date.</p>
<h2>11. Contact</h2>
<p>Questions? Email <a href="mailto:support@miroxai.org">support@miroxai.org</a>.</p>
`;

app.get(['/tos', '/terms', '/terms-of-service'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type('html').send(legalPage('Terms of Service', TOS_BODY));
});
app.get(['/privacy-policy', '/privacy', '/privacyPolicy'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type('html').send(legalPage('Privacy Policy', PRIVACY_BODY));
});

/* FALLBACKS */
app.use((req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/v1') || req.path.startsWith('/openai')) {
    return res.status(404).json({ ok: false, error: 'Not found', path: req.path, hint: 'See GET /v1/models' });
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => { if (err) res.status(404).send('Not found'); });
});
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'Request too large' });
  console.error('[express]', err?.message || err);
  if (!res.headersSent) res.status(500).json({ ok: false, error: GENERIC_ERR });
});

console.log('[Mirox] v115 · flagship: Tail r1 (FREE) · api_thinking: OFF');
console.log('[Mirox] storage:', VPS_ON ? `VPS (${VPS_USER}@${VPS_IP}:${VPS_DB_PATH})` : KV_ON ? 'Upstash KV' : DATA_FILE);
console.log('[Mirox] bot endpoint: /v1/bot/chat · thinking: OFF (forced)');
console.log('[Mirox] search provider:', KS_KEY ? 'kensearch' : 'duckduckgo');
console.log('[Mirox] discord bot:', DISCORD_BOT_TOKEN ? 'enabled' : 'disabled');
console.log('[Mirox] legal pages: /tos · /privacy-policy');

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log('[Mirox] Server at http://localhost:' + PORT));
}

/* DISCORD BOT */
if (DISCORD_BOT_TOKEN) {
  startDiscordBot().catch((e) => console.error('[discord]', e?.message || e));
}

async function startDiscordBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] logged in as ${c.user.tag}`);
    c.user.setPresence({
      activities: [{ name: '?help · MiroxAI', type: ActivityType.Watching }],
      status: 'online',
    });
  });

  const isChatChannel   = (id) => id === DISCORD_CHAT_CHANNEL;
  const isImageChannel  = (id) => id === DISCORD_IMAGE_CHANNEL;
  const isStatusChannel = (id) => id === DISCORD_STATUS_CHANNEL;

  function bubble(content) { return `▎${content}▕`; }

  async function safeReply(msg, text, opts = {}) {
    try { return await msg.reply({ content: text, ...opts }); }
    catch (e) { console.warn('[discord] reply failed:', e.message); return null; }
  }

  async function safeSend(channel, payload) {
    try { return await channel.send(payload); }
    catch (e) { console.warn('[discord] send failed:', e.message); return null; }
  }

  function truncate(text, n = 1900) {
    const s = String(text || '');
    if (s.length <= n) return s;
    return s.slice(0, n - 20) + '\n…*(truncated)*';
  }

  async function animateBubble(channel, frames, interval = 900) {
    let msg = null;
    try {
      msg = await channel.send({ content: bubble(frames[0]) });
      let idx = 0;
      const iv = setInterval(async () => {
        idx++;
        if (idx >= frames.length) return;
        try { await msg.edit({ content: bubble(frames[idx]) }); } catch {}
      }, interval);
      return {
        message: msg,
        stop: async (finalText, embed = null) => {
          clearInterval(iv);
          const payload = embed ? { content: finalText || '', embeds: [embed] } : { content: finalText || '' };
          try { await msg.edit(payload); } catch {}
        },
      };
    } catch (e) {
      console.warn('[discord] animate failed:', e.message);
      return { message: null, stop: async (finalText, embed = null) => {
        const payload = embed ? { content: finalText || '', embeds: [embed] } : { content: finalText || '' };
        return safeSend(channel, payload);
      } };
    }
  }

  async function runAiChat(userText, username, { deepThink = false, search = false } = {}) {
    const cfg = MIROX_MODELS['mirox-tail-r1'];
    const msgs = [
      { role: 'system', content: buildSystemPrompt(cfg, null, false, '', deepThink, 'mirox-tail-r1', '', false, true) },
      { role: 'user', content: `Discord user "${username}" says: ${userText}` },
    ];

    if (search) {
      try {
        const s = await webSearch(userText, 5);
        const hasData = s.results.length || s.overview;
        if (hasData) msgs.push({ role: 'system', content: formatSearchContext(userText, s) });
      } catch {}
    }

    const result = await miroxChatChain({
      messages: msgs,
      cfg,
      stream: false,
      vision: false,
      deepThink,
    });
    const data = await result.res.json().catch(() => ({}));
    let reply = extractReplyText(data) || '(no reply)';
    reply = stripThinking(reply);
    return reply;
  }

  const commands = {
    help: {
      desc: 'Show available commands',
      run: async (msg) => {
        const embed = new EmbedBuilder()
          .setColor(0x4d6bfe)
          .setTitle('🤖 Mirox Bot — Commands')
          .setDescription(`Prefix: \`${DISCORD_CMD_PREFIX}\``)
          .addFields(
            { name: '💬 Chat', value: '`?ask <msg>` — ask the AI\n`?think <msg>` — deep think\n`?search <q>` — web search + answer', inline: false },
            { name: '🎨 Images', value: '`?image <prompt>` — generate image', inline: false },
            { name: '📊 Info', value: '`?status` — bot & API status\n`?models` — list models\n`?ping` — latency', inline: false },
            { name: '📄 Legal', value: `[Terms](${PUBLIC_ORIGIN}/tos) · [Privacy](${PUBLIC_ORIGIN}/privacy-policy)`, inline: false },
          )
          .setFooter({ text: 'MiroxAI · by OpenSurr' });
        return safeSend(msg.channel, { embeds: [embed] });
      },
    },
    ping: {
      desc: 'Latency',
      run: async (msg) => {
        const t = Date.now();
        const m = await safeSend(msg.channel, { content: bubble('🏓 Pinging…') });
        if (!m) return;
        const latency = Date.now() - t;
        return m.edit({ content: bubble(`🏓 Pong · gateway ${client.ws.ping}ms · roundtrip ${latency}ms`) });
      },
    },
    status: {
      desc: 'Bot + API status',
      run: async (msg) => {
        const embed = new EmbedBuilder()
          .setColor(0x16a34a)
          .setTitle('📡 MiroxAI Status')
          .addFields(
            { name: '🟢 Discord', value: `Online · ${client.ws.ping}ms`, inline: true },
            { name: '🌐 Web app', value: `[miroxai.org](${PUBLIC_ORIGIN})`, inline: true },
            { name: '🗄 Storage', value: VPS_ON ? 'VPS (durable)' : KV_ON ? 'Upstash KV' : 'Filesystem', inline: true },
          )
          .setFooter({ text: 'MiroxAI · ' + new Date().toISOString() });
        return safeSend(msg.channel, { embeds: [embed] });
      },
    },
    models: {
      desc: 'List models',
      run: async (msg) => {
        const lines = Object.entries(MIROX_MODELS).map(([id, m]) =>
          `${m.flagship ? '👑' : m.tier === 'free' ? '🆓' : '💎'} **${m.label}** \`${id}\``);
        const embed = new EmbedBuilder()
          .setColor(0x4d6bfe)
          .setTitle('🧠 Available models')
          .setDescription(lines.join('\n'));
        return safeSend(msg.channel, { embeds: [embed] });
      },
    },
    ask: {
      desc: 'Ask the AI',
      run: async (msg, args) => {
        const text = args.join(' ').trim();
        if (!text) return safeReply(msg, '❓ Usage: `?ask <your question>`');
        const anim = await animateBubble(msg.channel, ['💭 Thinking…', '🧠 Reasoning…', '✍️ Writing…'], 800);
        try { const reply = await runAiChat(text, msg.author.username, { deepThink: false, search: false }); await anim.stop(truncate(reply)); }
        catch (e) { await anim.stop(`❌ ${e.message}`); }
      },
    },
    think: {
      desc: 'Deep think',
      run: async (msg, args) => {
        const text = args.join(' ').trim();
        if (!text) return safeReply(msg, '❓ Usage: `?think <your question>`');
        const anim = await animateBubble(msg.channel, ['🧠 Deep thinking…', '🔬 Verifying…', '✍️ Writing…'], 900);
        try { const reply = await runAiChat(text, msg.author.username, { deepThink: true, search: false }); await anim.stop(truncate(reply)); }
        catch (e) { await anim.stop(`❌ ${e.message}`); }
      },
    },
    search: {
      desc: 'Web search + answer',
      run: async (msg, args) => {
        const q = args.join(' ').trim();
        if (!q) return safeReply(msg, '❓ Usage: `?search <query>`');
        const anim = await animateBubble(msg.channel, ['🔍 Searching…', '📖 Reading sources…', '✍️ Writing…'], 900);
        try { const reply = await runAiChat(q, msg.author.username, { deepThink: false, search: true }); await anim.stop(truncate(reply)); }
        catch (e) { await anim.stop(`❌ ${e.message}`); }
      },
    },
    image: {
      desc: 'Generate an image',
      run: async (msg, args) => {
        const prompt = args.join(' ').trim();
        if (!prompt) return safeReply(msg, '❓ Usage: `?image <prompt>`');
        const anim = await animateBubble(msg.channel, ['🎨 Preparing canvas…', '🖌️ Painting…', '✨ Refining details…'], 1000);
        try {
          const dataUrl = await generateImage(prompt);
          const [meta, b64] = dataUrl.split(',');
          const mime = (meta.match(/data:([^;]+)/) || [, 'image/png'])[1];
          const buf = Buffer.from(b64, 'base64');
          const ext = mime.includes('png') ? 'png' : 'jpg';
          const { AttachmentBuilder } = await import('discord.js');
          const file = new AttachmentBuilder(buf, { name: `mirox-${Date.now()}.${ext}` });
          const embed = new EmbedBuilder()
            .setColor(0xd97757)
            .setTitle('🎨 Lumenal 1.0')
            .setDescription(`*${truncate(prompt, 300)}*`)
            .setImage(`attachment://${file.name}`)
            .setFooter({ text: `Requested by ${msg.author.username}` });
          await anim.stop('', embed);
          await safeSend(msg.channel, { files: [file] });
        } catch (e) { await anim.stop(`❌ Image generation failed: ${e.message}`); }
      },
    },
  };

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    if (!msg.guild) return;
    const content = (msg.content || '').trim();
    const chId = msg.channel.id;

    if (isStatusChannel(chId)) {
      if (!content.startsWith(DISCORD_CMD_PREFIX)) return;
      const [cmdName, ...args] = content.slice(DISCORD_CMD_PREFIX.length).trim().split(/\s+/);
      const cmd = commands[cmdName.toLowerCase()];
      if (cmd) { try { await cmd.run(msg, args); } catch (e) { console.warn('[discord] cmd error:', e.message); } }
      return;
    }

    if (isImageChannel(chId)) {
      if (content.startsWith(DISCORD_CMD_PREFIX)) {
        const [cmdName, ...args] = content.slice(DISCORD_CMD_PREFIX.length).trim().split(/\s+/);
        const cmd = commands[cmdName.toLowerCase()];
        if (cmd) { try { await cmd.run(msg, args); } catch (e) { console.warn('[discord] cmd error:', e.message); } return; }
      }
      if (content) { try { await commands.image.run(msg, content.split(/\s+/)); } catch (e) { console.warn('[discord] image shortcut error:', e.message); } }
      return;
    }

    if (isChatChannel(chId)) {
      if (content.startsWith(DISCORD_CMD_PREFIX)) {
        const [cmdName, ...args] = content.slice(DISCORD_CMD_PREFIX.length).trim().split(/\s+/);
        const cmd = commands[cmdName.toLowerCase()];
        if (cmd) { try { await cmd.run(msg, args); } catch (e) { console.warn('[discord] cmd error:', e.message); } return; }
      }
      if (!content) return;
      const anim = await animateBubble(msg.channel, ['💭 Thinking…', '🧠 Reasoning…', '✍️ Writing…'], 800);
      try { const reply = await runAiChat(content, msg.author.username, { deepThink: false, search: false }); await anim.stop(truncate(reply)); }
      catch (e) { await anim.stop(`❌ ${e.message}`); }
      return;
    }
  });

  client.on(Events.Error, (e) => console.error('[discord] error:', e?.message || e));
  client.on(Events.Warn, (e) => console.warn('[discord] warn:', e?.message || e));

  await client.login(DISCORD_BOT_TOKEN);
}

export default app;

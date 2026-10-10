/* ============================================================
   MiroxAI Backend v96 — boot-safe rebuild
   Matches the v26 frontend (index.html, script.js, style.css)
   ============================================================ */
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* ---------- Config: everything comes from environment variables ---------- */
const env = (k, d = '') => String(process.env[k] ?? d).trim();

const PORT = env('PORT', '3000');
const PUBLIC_ORIGIN = env('PUBLIC_ORIGIN', 'https://miroxai.org').replace(/\/+$/, '');
const ADMIN_PASS = env('ADMIN_PASSWORD');
const ALLOW_EMAIL_LOGIN = env('ALLOW_EMAIL_LOGIN') === '1';
const DATA_FILE = env('DB_FILE', '/tmp/mirox-db.json');
const IMG_DIR = env('IMG_DIR', '/tmp/mirox-img');

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
if (!env('SECRET_KEY')) console.warn('[Mirox] SECRET_KEY not set: sessions reset on every cold start.');

const GENERIC_ERR = 'Mirox AI encountered an error';
const DAY = 24 * 3600;

/* ---------- Models, plans, providers ---------- */
const MIROX_MODELS = {
  'mirox-luna-1.2':    { label: 'Luna',    tier: 'free',     tokens: 1400, basePrompt: 'You are Luna by OpenSurr. Concise, helpful. Fenced code blocks for code.' },
  'mirox-gen-1':       { label: 'Gen',     tier: 'free',     tokens: 1000, basePrompt: 'You are Gen by OpenSurr. Ultra concise. Fenced code blocks for code.' },
  'mirox-pro-5':       { label: 'Pro',     tier: 'pro',      tokens: 2000, basePrompt: 'You are Pro by OpenSurr. Balanced depth. Fenced code blocks for code.' },
  'mirox-ultra-10':    { label: 'Ultra',   tier: 'pro',      tokens: 2500, basePrompt: 'You are Ultra by OpenSurr. Deep reasoning. Fenced code blocks for code.' },
  'mirox-eclipse-2.0': { label: 'Eclipse', tier: 'ultimate', tokens: 3200, basePrompt: 'You are Eclipse by OpenSurr. Best quality. Fenced code blocks for code.' },
};
const PLANS = {
  free:     { label: 'Free',     vision_limit: 10,   image_limit: 10,   eclipse_daily_limit: 5,   price_usd: 0,     api_keys: 2 },
  pro:      { label: 'Pro',      vision_limit: 200,  image_limit: 200,  eclipse_daily_limit: 0,   price_usd: 6.99,  api_keys: 10 },
  ultimate: { label: 'Ultimate', vision_limit: 2000, image_limit: 2000, eclipse_daily_limit: 999, price_usd: 20.99, api_keys: 10 },
};
const TIER_RANK = { free: 0, pro: 1, ultimate: 2 };
const API_MODELS = ['mirox-luna-1.2', 'mirox-gen-1'];
const maxKeys = (tier) => (tier === 'free' ? 2 : 10);

const HF_URL = 'https://router.huggingface.co/v1/chat/completions';
const PL_URL = 'https://gen.pollinations.ai/v1/chat/completions';
const PL_IMG = 'https://gen.pollinations.ai/image';
const HF_CHAT = ['meta-llama/Llama-3.3-70B-Instruct:together', 'Qwen/Qwen2.5-72B-Instruct:together'];
const HF_VISION = ['meta-llama/Llama-3.2-11B-Vision-Instruct:together', 'Qwen/Qwen2-VL-7B-Instruct:hyperbolic'];
const PL_CHAT = ['openai', 'openai-fast', 'mistral'];
const PL_VISION = ['openai', 'openai-fast'];
const PL_IMG_MODELS = ['flux', 'turbo'];
const VISION_MODELS = new Set([...HF_VISION, ...PL_VISION]);

const IDENTITY_GUARD = `Background rules (do not narrate them):
- Never mention GPT, OpenAI, ChatGPT, Claude, Gemini, Llama, Qwen, DeepSeek, Mistral, Google, Meta, Anthropic, or any other AI company or model by name.
- If the user asks what model you are, say you are Mirox, made by OpenSurr, once, and move on.
- Do not introduce yourself unless the user asks who you are.`;

const BRIDGE_PROMPT = `BRIDGE MODE — You are Mirox, working on the user's machine.

You receive a [Bridge environment] block at the top of every user message. Use it only as operational context; never expose private environment details unnecessarily.

RULE 0 — Think out loud briefly before writing code: one or two short lines saying what the user asked, the language if one was named, and which files you will create.

RULE 1 — Never paste code into visible text. File contents go inside <bridge-write> or <bridge-append>.
RULE 2 — Always close tags.
RULE 3 — Long files: write the first chunk with <bridge-write>, then add the rest with <bridge-append>.
RULE 4 — Never ask the user to confirm small steps. Keep building.
RULE 5 — Prefer portable relative paths such as ".", "./src/app.js", or "~/project/file.js". The local bridge safely resolves these aliases under the configured home directory. Do not reveal or repeat the user's real absolute home path unless explicitly needed.
RULE 6 — Do NOT repeat the same sentence, tool call or file write more than once. If a step succeeded, move on.

When finished, reply DONE on its own line plus a one-line summary.

TAGS:
  <bridge-write path="/abs/path">...</bridge-write>
  <bridge-append path="/abs/path">...</bridge-append>
  <bridge-read path="/abs/path"/>
  <bridge-list path="/abs/path"/>
  <bridge-delete path="/abs/path"/>
  <bridge-move from="/abs/a" to="/abs/b"/>
  <bridge-copy from="/abs/a" to="/abs/b"/>
  <bridge-exec>cd /abs/dir && ls -la</bridge-exec>
  <bridge-sudo>apt install foo</bridge-sudo>
  <bridge-sysinfo/>  <bridge-syscheck/>  <bridge-processes/>
  <bridge-designs><design id="1" name="Dark"><html>...</html></design>...</bridge-designs>
  <bridge-ask>Question text
  - Option A
  - Option B</bridge-ask>
  <bridge-kde-refresh/>  <bridge-kde-list/>  <bridge-kde-ping device="ID"/>  <bridge-kde-ring device="ID"/>
  <bridge-kde-share device="ID" path="/abs/path"/>
  <bridge-kde-share-text device="ID">text</bridge-kde-share-text>
  <bridge-kde-sms device="ID" number="+1...">hi</bridge-kde-sms>
  <bridge-kde-lock device="ID"/>  <bridge-kde-notifications device="ID"/>  <bridge-kde-my-id/>
  <bridge-email to="x@y.com" subject="Hi">body</bridge-email>
  <bridge-http url="https://..." method="GET"/>
  <bridge-clipboard action="get"/>  <bridge-clipboard action="set">text</bridge-clipboard>
  <bridge-screenshot path="/abs/shot.png"/>
  <bridge-git action="status" cwd="/abs/dir"/>
  <bridge-pkgs type="pip"/>`;

/* ---------- Small helpers ---------- */
const safeStr = (v, max = 100000) => {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) : s;
};
const nowS = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchT(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function extractReplyText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.reply === 'string') return data.reply;
  if (typeof data.text === 'string') return data.text;
  const c = data.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : '';
}

/* ============================================================
   DATABASE
   ============================================================ */
let db = null;
let dbOk = false;
let dbLoading = null;
let writeChain = Promise.resolve();

const emptyDb = () => ({ users: {}, keys: {}, chats: [], events: [] });

function normalize(raw) {
  const d = Object.assign(emptyDb(), raw && typeof raw === 'object' ? raw : {});
  delete d.images;
  delete d.apiKeys;
  delete d.counters;
  if (!d.users || typeof d.users !== 'object') d.users = {};
  d.chats = Array.isArray(d.chats) ? d.chats.slice(-300) : [];
  d.events = Array.isArray(d.events) ? d.events.slice(-300) : [];
  for (const u of Object.values(d.users)) {
    if (!Array.isArray(u.keys)) u.keys = Array.isArray(u.api_keys) ? u.api_keys : [];
    delete u.api_keys;
    if (!Array.isArray(u.images)) u.images = [];
  }
  d.keys = {};
  for (const u of Object.values(d.users)) {
    for (const k of u.keys) if (k && k.key) d.keys[k.key] = u.email;
  }
  return d;
}

async function kv(cmd) {
  const r = await fetchT(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  }, 8000);
  if (!r.ok) throw new Error('kv_' + r.status);
  const d = await r.json();
  if (d.error) throw new Error('kv: ' + d.error);
  return d.result;
}

async function readMain() {
  if (KV_ON) return await kv(['GET', KV_DB_KEY]);
  try { return await fs.readFile(DATA_FILE, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function loadDb() {
  if (db && dbOk && !KV_ON) return db;
  if (dbLoading) return dbLoading;
  dbLoading = (async () => {
    try {
      const raw = await readMain();
      db = normalize(raw ? JSON.parse(raw) : null);
      dbOk = true;
    } catch (e) {
      console.error('[db] load failed, writes disabled:', e.message);
      if (!db) db = normalize(null);
      dbOk = false;
    } finally {
      dbLoading = null;
    }
    return db;
  })();
  return dbLoading;
}

function persist() {
  if (!db || !dbOk) return Promise.resolve(false);
  const snap = JSON.stringify(db);
  const job = writeChain.then(async () => {
    try {
      if (KV_ON) await kv(['SET', KV_DB_KEY, snap]);
      else await fs.writeFile(DATA_FILE, snap, 'utf8');
      return true;
    } catch (e) {
      console.error('[db] write failed:', e.message);
      return false;
    }
  });
  writeChain = job.then(() => undefined);
  return job;
}

function userFor(email) {
  let u = db.users[email];
  if (!u) {
    u = db.users[email] = { email, name: email.split('@')[0], tier: 'free', provider: 'email', created_at: nowS(), last_login: 0 };
  }
  if (!u.name) u.name = email.split('@')[0];
  if (!['free', 'pro', 'ultimate'].includes(u.tier)) u.tier = 'free';
  if (!Array.isArray(u.keys)) u.keys = [];
  if (!Array.isArray(u.images)) u.images = [];
  if (u.daily_day !== today()) {
    u.daily_day = today();
    u.daily_used = 0; u.vision_used = 0; u.image_used = 0; u.eclipse_used = 0;
  }
  for (const f of ['daily_used', 'vision_used', 'image_used', 'eclipse_used']) {
    if (typeof u[f] !== 'number') u[f] = 0;
  }
  return u;
}

function logEvent(ev) {
  db.events.push({ ts: nowS(), ...ev });
  if (db.events.length > 300) db.events.splice(0, db.events.length - 300);
}
function logChat(entry) {
  db.chats.push({ ts: nowS(), ...entry });
  if (db.chats.length > 300) db.chats.splice(0, db.chats.length - 300);
}

/* ============================================================
   BLOB STORAGE (generated images)
   ============================================================ */
const BLOB_ID = /^[a-f0-9]{32}$/;

async function blobPut(id, value) {
  if (KV_ON) return kv(['SET', 'mirox:img:' + id, value, 'EX', String(60 * DAY)]);
  await fs.mkdir(IMG_DIR, { recursive: true });
  await fs.writeFile(path.join(IMG_DIR, id + '.txt'), value, 'utf8');
}
async function blobGet(id) {
  if (!BLOB_ID.test(id)) return null;
  try {
    if (KV_ON) return await kv(['GET', 'mirox:img:' + id]);
    return await fs.readFile(path.join(IMG_DIR, id + '.txt'), 'utf8');
  } catch { return null; }
}
async function blobDel(id) {
  if (!BLOB_ID.test(id)) return;
  try {
    if (KV_ON) await kv(['DEL', 'mirox:img:' + id]);
    else await fs.unlink(path.join(IMG_DIR, id + '.txt'));
  } catch {}
}

async function saveImage(u, prompt, dataUrl) {
  const id = crypto.randomBytes(16).toString('hex');
  const isRemote = dataUrl.startsWith('http');
  if (!isRemote) {
    try { await blobPut(id, dataUrl); }
    catch (e) { console.warn('[blob] save failed:', e.message); return false; }
  }
  u.images.unshift({ id: isRemote ? null : id, remote: isRemote ? dataUrl : null, prompt: prompt.slice(0, 300), ts: nowS() });
  while (u.images.length > 30) {
    const old = u.images.pop();
    if (old && old.id) blobDel(old.id);
  }
  return true;
}

/* ============================================================
   SESSIONS (HMAC-signed cookie)
   ============================================================ */
function signSession(data) {
  const p = Buffer.from(JSON.stringify(data)).toString('base64url');
  const s = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  return p + '.' + s;
}
function readSession(token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const p = token.slice(0, i), s = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (!safeEq(expect, s)) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (d.exp && d.exp < nowS()) return null;
    return d;
  } catch { return null; }
}
function getCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}
function cookieAttrs(req, maxAge) {
  const secure = req.secure || PUBLIC_ORIGIN.startsWith('https://');
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function setSessionCookie(req, res, uid) {
  const token = signSession({ uid, exp: nowS() + 30 * DAY });
  res.append('Set-Cookie', `mirox_sess=${token}; ${cookieAttrs(req, 30 * DAY)}`);
  return token;
}
function clearSessionCookie(req, res) {
  res.append('Set-Cookie', `mirox_sess=; ${cookieAttrs(req, 0)}`);
}

async function ensureDb(req) {
  if (req && req.__dbReady) return;
  await loadDb();
  if (req) req.__dbReady = true;
}

async function currentUser(req) {
  await ensureDb(req);
  if (!dbOk) return null;
  const s = readSession(getCookie(req, 'mirox_sess'));
  if (!s || !s.uid) return null;
  return userFor(s.uid);
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
  k.last_used = nowS();
  persist();
  return { user: userFor(owner), viaKey: true };
}

/* ============================================================
   WEB SEARCH
   ============================================================ */
const SEARCH_TIMEOUT_MS = 14000;

const stripHtml = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

async function duckSearch(query, max = 5) {
  try {
    const r = await fetchT(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, SEARCH_TIMEOUT_MS);
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
      let domain = '';
      try { domain = new URL(href).hostname.replace(/^www\./, ''); } catch {}
      out.push({ title, url: href, snippet: stripHtml(m[3]), domain });
    }
    return out;
  } catch { return []; }
}

async function ddgInstantAnswer(query) {
  try {
    const r = await fetchT(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {}, 8000);
    if (!r.ok) return null;
    const d = await r.json();
    if (!(d.Abstract || d.Answer || d.Definition)) return null;
    return {
      heading: d.Heading || '',
      text: d.Abstract || d.Answer || d.Definition || '',
      source: d.AbstractSource || 'DuckDuckGo',
      url: d.AbstractURL || '',
    };
  } catch { return null; }
}

async function wikiSearch(query) {
  try {
    const r = await fetchT(`https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&origin=*`, {}, 8000);
    if (!r.ok) return [];
    const d = await r.json();
    return (d?.query?.search || []).map((h) => ({
      title: h.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
      snippet: stripHtml(h.snippet),
      domain: 'en.wikipedia.org',
    }));
  } catch { return []; }
}

async function wikiSummary(title) {
  try {
    const r = await fetchT(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {}, 7000);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.extract) return null;
    return { source: 'Wikipedia', heading: d.title || title, text: d.extract, url: d.content_urls?.desktop?.page || '' };
  } catch { return null; }
}

async function webSearch(query, max = 5) {
  const [organic, instant] = await Promise.all([duckSearch(query, max), ddgInstantAnswer(query)]);
  let results = organic.length ? organic : await wikiSearch(query);
  const seen = new Set();
  results = results.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true))).slice(0, max);
  let overview = instant && instant.text ? { ...instant, kind: 'instant' } : null;
  if (!overview) {
    const ws = await wikiSummary(results[0]?.title || query);
    if (ws) overview = { ...ws, kind: 'wiki' };
  }
  return { results, overview };
}

function formatSearchContext(query, data) {
  const parts = [];
  if (data.overview?.text) parts.push(`[OVERVIEW — ${data.overview.source}${data.overview.url ? ' (' + data.overview.url + ')' : ''}]\n${data.overview.text}`);
  if (data.results.length) {
    parts.push(`[${data.results.length} ORGANIC RESULTS]`);
    parts.push(data.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet || '(no snippet)'}`).join('\n\n'));
  }
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
  let m = t.match(/^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|i\s+want\s+(?:you\s+)?to\s+)?(?:generate|create|make|draw|render|paint|show\s+me|give\s+me)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:image|picture|photo|illustration|drawing|painting)\s+(?:of\s+|with\s+|showing\s+)?(.+?)[\s.?!,;:]*$/i);
  if (m && m[1]) return m[1].trim();
  m = t.match(/^(?:an?\s+)?(?:image|picture|photo|illustration)\s+of\s+(.+?)[\s.?!,;:]*$/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

/* ============================================================
   MODEL PROVIDERS
   ============================================================ */
function stripImages(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      : String(m.content || ''),
  }));
}

async function callProvider(kind, modelId, messages, maxTokens, stream) {
  const url = kind === 'hf' ? HF_URL : PL_URL;
  const key = kind === 'hf' ? HF_API_KEY : PL_KEY;
  if (!key) throw new Error('no_key');
  const res = await fetchT(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify({ model: modelId, messages, max_tokens: maxTokens, stream: !!stream, temperature: 0.7 }),
  }, 25000);
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
  const r = await fetchT(`${AIROUTE_BASE}/api/public/v1/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AIROUTE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 90000);
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

async function miroxChatChain({ messages, cfg, stream, vision }) {
  const tries = [];
  if (vision) {
    if (HF_API_KEY) HF_VISION.forEach((m) => tries.push(['hf', m]));
    if (PL_KEY) PL_VISION.forEach((m) => tries.push(['pl', m]));
  }
  if (HF_API_KEY) HF_CHAT.forEach((m) => tries.push(['hf', m]));
  if (PL_KEY) PL_CHAT.forEach((m) => tries.push(['pl', m]));

  for (const [kind, modelId] of tries) {
    try {
      const msgs = VISION_MODELS.has(modelId) ? messages : stripImages(messages);
      const res = await callProvider(kind, modelId, msgs, cfg.tokens, stream);
      return { res, provider: kind };
    } catch (e) {
      console.warn('[provider]', kind, modelId, e.message);
    }
  }

  if (AIROUTE_KEY) {
    for (const opts of [{ fast: true }, { fast: false, model: 'meta-llama/Llama-3.3-70B-Instruct' }]) {
      try {
        const text = await airouteText(messages, opts);
        if (!text) throw new Error('empty reply');
        return { res: { body: textToSSEStream(text), json: async () => ({ reply: text }) }, provider: 'airoute' };
      } catch (e) {
        console.warn('[airoute]', e.message);
      }
    }
  }
  throw new Error(GENERIC_ERR);
}

async function pipeProviderStream(body, onDelta, isClosed, onLimit = () => {}) {
  const reader = body.getReader();
  const dec = new TextDecoder();
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
          const d = item.choices?.[0]?.delta?.content;
          if (d) onDelta(d);
          if (item.choices?.[0]?.finish_reason === 'length') onLimit();
        } catch {}
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function generateImage(prompt) {
  const deadline = Date.now() + 55000;
  for (const mid of PL_IMG_MODELS) {
    if (Date.now() > deadline - 5000) break;
    try {
      const params = new URLSearchParams({ model: mid, width: '1024', height: '1024', nologo: 'true', seed: String(Math.floor(Math.random() * 99999)) });
      const headers = { Accept: 'image/png' };
      if (PL_KEY) headers.Authorization = `Bearer ${PL_KEY}`;
      const res = await fetchT(`${PL_IMG}/${encodeURIComponent(prompt.slice(0, 1000))}?${params}`, { headers }, 40000);
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) continue;
      return `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`;
    } catch {}
  }
  if (AIROUTE_KEY) {
    try {
      const r = await fetchT(`${AIROUTE_BASE}/api/public/v1/images`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AIROUTE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'black-forest-labs/FLUX.1-schnell', prompt: prompt.slice(0, 2000) }),
      }, 50000);
      const d = await r.json().catch(() => ({}));
      if (typeof d.image === 'string' && (d.image.startsWith('data:image') || d.image.startsWith('http'))) return d.image;
    } catch {}
  }
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
function sseWrite(res, obj) {
  if (res.writableEnded || res.destroyed) return;
  try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {}
}
function sseDone(res) {
  if (res.writableEnded || res.destroyed) return;
  try { res.write('data: [DONE]\n\n'); } catch {}
}

function buildSystemPrompt(cfg, bridge, searchUsed, persona) {
  let p = IDENTITY_GUARD + '\n\n' + cfg.basePrompt;
  if (searchUsed) p += '\n\nWEB SEARCH MODE: live results follow in a system message. Use them and cite sources as [1], [2] when relevant.';
  if (persona) p += `\n\nUser preference: ${persona}`;
  if (bridge) {
    const env = bridge.env || {};
    p += '\n\n' + BRIDGE_PROMPT;
    p += `\n\n=== [Bridge environment] ===\nuser=${env.user || '(unknown)'}\nhome=~\ncwd=.\nplatform=${env.platform || '(unknown)'}\nallowed_dirs=home and explicitly configured project folders\nkdeConnect=${env.kde_connect_available ? 'true' : 'false'}`;
  }
  return p;
}

function buildEnvBlock(env) {
  return [
    '[Bridge environment]',
    `user=${env.user || '?'}`,
    'home=~',
    'cwd=.',
    `platform=${env.platform || '?'}`,
    'allowed_dirs=home and explicitly configured project folders',
    `kdeConnect=${env.kde_connect_available ? 'true' : 'false'}`,
  ].join('\n');
}

/* ============================================================
   APP
   ============================================================ */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '8mb' }));
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
app.use(async (req, res, next) => { await ensureDb(req).catch(() => {}); next(); });

const publicUser = (u) => {
  const plan = PLANS[u.tier] || PLANS.free;
  return {
    id: u.email, email: u.email, name: u.name, tier: u.tier, provider: u.provider || 'email',
    vision_limit: plan.vision_limit, vision_used: u.vision_used,
    image_limit: plan.image_limit, image_used: u.image_used,
    eclipse_limit: plan.eclipse_daily_limit, eclipse_used: u.eclipse_used,
    api_keys_used: u.keys.filter((k) => !k.revoked).length,
    api_keys_limit: maxKeys(u.tier),
  };
};
const publicKey = (k) => ({ id: k.id, name: k.name, key: k.key, created: k.created, last_used: k.last_used || 0, revoked: !!k.revoked });

app.get(['/api/health', '/health', '/ping'], (req, res) => {
  res.json({
    ok: true, app: 'MiroxAI', version: 'v96',
    providers: { hf: !!HF_API_KEY, pl: !!PL_KEY, airoute: !!AIROUTE_KEY },
    db: { durable: KV_ON, writable: dbOk },
    time: nowS(),
  });
});

app.get('/api/web/status', async (req, res) => {
  const t0 = Date.now();
  const [ddg, wiki] = await Promise.all([
    duckSearch('test', 1).then((r) => r.length > 0).catch(() => false),
    wikiSearch('Python').then((r) => r.length > 0).catch(() => false),
  ]);
  res.json({ ok: true, duckduckgo: ddg, wikipedia: wiki, ms: Date.now() - t0 });
});

app.get(['/api/config', '/config'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const models = Object.entries(MIROX_MODELS).map(([id, m]) => ({ id, label: m.label, tier: m.tier }));
  res.json({
    app: { name: 'MiroxAI', version: 'v96' },
    models, default_model: models[0].id, plans: PLANS,
    tts_available: !!F_API,
    search_available: true, vision_available: true, image_intent: true,
    loginment_available: !!LM_CLIENT_ID,
    email_login_available: ALLOW_EMAIL_LOGIN,
    airoute_available: !!AIROUTE_KEY,
    kde_connect_available: true,
  });
});

app.get(['/api/subscription/plans', '/subscription/plans'], (req, res) => {
  const perks = {
    free: ['Luna & Gen unlimited', '10 image uploads/day', '10 image gens/day', '5 Eclipse/day', '2 API keys', 'Web search', 'Vision', 'KDE Connect'],
    pro: ['Pro & Ultra models', '200 image uploads/gens/day', '10 API keys', 'Web search', 'Vision', 'KDE Connect'],
    ultimate: ['Eclipse — best model', '2000 image uploads/gens/day', '10 API keys', 'Web search', 'Vision', 'KDE Connect'],
  };
  const tagline = { free: 'Free forever', pro: 'Most popular', ultimate: 'Power users' };
  res.json({
    ok: true,
    plans: Object.entries(PLANS).map(([id, p]) => ({
      id, label: p.label, tagline: tagline[id],
      vision_limit: p.vision_limit, image_limit: p.image_limit, eclipse_limit: p.eclipse_daily_limit,
      price_usd: p.price_usd, api_keys_limit: p.api_keys, perks: perks[id],
    })),
  });
});

/* ============================================================
   AUTH
   ============================================================ */
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
    const code = safeStr(req.query.code, 300);
    const state = safeStr(req.query.state, 100);
    const saved = getCookie(req, 'mirox_lm_state');
    res.append('Set-Cookie', `mirox_lm_state=; ${cookieAttrs(req, 0)}`);
    if (!code || !state || !saved || !safeEq(state, saved)) return res.status(400).send('Login state invalid. Please try again.');
    if (!LM_CLIENT_ID || !LM_API_KEY) return res.status(503).send('Loginment is not configured.');

    const r = await fetchT(`${LM_DOMAIN}/api/public/v1/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }, 15000);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.success || !data.user?.email) return res.status(401).send('Login failed.');

    await ensureDb(req);
    if (!dbOk) return res.status(503).send('Storage is unavailable. Try again shortly.');

    const email = String(data.user.email).toLowerCase();
    const u = userFor(email);
    u.name = data.user.name || u.name;
    u.provider = data.user.provider || 'email';
    u.lm_user_id = data.user.id || null;
    u.last_login = nowS();
    logEvent({ email, event: 'login', provider: u.provider });
    if (!(await persist())) return res.status(503).send('Could not save your account. Try again.');
    setSessionCookie(req, res, email);
    res.redirect('/');
  } catch (e) {
    console.error('[callback]', e.message);
    res.status(500).send('Server error');
  }
});

app.post(['/api/auth/simple-login', '/auth/simple-login'], async (req, res) => {
  if (!ALLOW_EMAIL_LOGIN) return res.status(403).json({ ok: false, error: 'Email login is disabled. Use Loginment.' });
  const name = safeStr(req.body?.name, 60).trim();
  const email = safeStr(req.body?.email, 120).trim().toLowerCase();
  if (!name || !email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'Name and email required' });
  await ensureDb(req);
  if (!dbOk) return res.status(503).json({ ok: false, error: 'Storage is unavailable. Try again shortly.' });
  const u = userFor(email);
  u.name = name;
  u.last_login = nowS();
  logEvent({ email, event: 'login' });
  if (!(await persist())) return res.status(503).json({ ok: false, error: 'Could not save your account.' });
  const token = setSessionCookie(req, res, email);
  res.json({ ok: true, token, user: { id: email, email, name, tier: u.tier } });
});

app.post(['/api/logout', '/logout'], (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get(['/api/me', '/me'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const u = await currentUser(req);
    res.json({ user: u ? publicUser(u) : null });
  } catch {
    res.json({ user: null });
  }
});

app.get('/api/persona', async (req, res) => {
  const u = await currentUser(req);
  res.json({ ok: true, persona: u?.persona || '' });
});
app.post('/api/persona', async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  u.persona = safeStr(req.body?.persona, 500);
  await persist();
  res.json({ ok: true });
});

/* ============================================================
   API KEYS
   ============================================================ */
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
  logEvent({ email: u.email, event: 'key_created', id: key.id });
  if (!(await persist())) return res.status(503).json({ ok: false, error: 'Could not save the key. Try again.' });
  res.json({ ok: true, key: publicKey(key) });
});

app.post(['/api/keys/rename', '/keys/rename'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const id = safeStr(req.body?.id, 40);
  const name = safeStr(req.body?.name, 60).trim();
  if (!id || !name) return res.status(400).json({ ok: false, error: 'id and name required' });
  const key = u.keys.find((k) => k.id === id);
  if (!key) return res.status(404).json({ ok: false, error: 'Key not found' });
  key.name = name;
  await persist();
  res.json({ ok: true, key: publicKey(key) });
});

app.post(['/api/keys/revoke', '/keys/revoke'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const key = u.keys.find((k) => k.id === safeStr(req.body?.id, 40));
  if (!key) return res.status(404).json({ ok: false, error: 'Key not found' });
  key.revoked = true;
  logEvent({ email: u.email, event: 'key_revoked', id: key.id });
  await persist();
  res.json({ ok: true });
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
  res.json({ ok: true });
});

/* ============================================================
   IMAGE HISTORY
   ============================================================ */
app.get(['/api/images/history', '/images/history'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const u = await currentUser(req);
  if (!u) return res.json({ ok: true, images: [] });
  const items = await Promise.all(u.images.slice(0, 30).map(async (it) => ({
    ts: it.ts,
    prompt: it.prompt,
    image: it.remote || (await blobGet(it.id)),
  })));
  res.json({ ok: true, images: items.filter((x) => x.image) });
});

/* ============================================================
   SEARCH ENDPOINT
   ============================================================ */
app.get(['/api/search', '/search'], async (req, res) => {
  const q = safeStr(req.query.q, 400).trim();
  if (!q) return res.status(400).json({ ok: false, error: 'Query required' });
  try {
    const data = await webSearch(q, 8);
    res.json({ ok: true, query: q, results: data.results, overview: data.overview });
  } catch {
    res.status(500).json({ ok: false, error: 'Search failed' });
  }
});

/* ============================================================
   IMAGE GENERATION API
   ============================================================ */
app.post('/v1/images/generations', async (req, res) => {
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
    res.json({ ok: true, image: dataUrl });
  } catch {
    res.status(502).json({ error: { message: GENERIC_ERR } });
  }
});

/* ============================================================
   CHAT COMPLETIONS
   ============================================================ */
app.post('/v1/chat/completions', async (req, res) => {
  const t0 = Date.now();
  let closed = false;
  req.on('close', () => { closed = true; });
  const isClosed = () => closed;

  const body = req.body || {};
  const wantStream = body.stream === true || String(req.headers.accept || '').includes('text/event-stream');
  const model = safeStr(body.model, 64) || 'mirox-luna-1.2';
  const text = safeStr(body.message, 100000).trim();
  const files = Array.isArray(body.files) ? body.files.slice(0, 4) : [];
  const history = Array.isArray(body.history) ? body.history.slice(-14) : [];
  const bridge = body.bridge && body.bridge.connected ? body.bridge : null;
  const forceSearch = body.search === true;

  const fail = (code, message) => res.status(code).json({ error: { message } });

  const fixedReply = (message) => {
    if (!wantStream) return res.json({ reply: message, _ms: Date.now() - t0, provider: 'mirox' });
    sseInit(res);
    sseWrite(res, { p: 'mirox' });
    sseWrite(res, { d: message });
    sseWrite(res, { done: true });
    sseDone(res);
    res.end();
  };

  try {
    const auth = await authFromRequest(req);
    if (auth.error) return fail(401, 'Invalid API key');
    const u = auth.user || null;
    if (auth.viaKey && !API_MODELS.includes(model)) return fail(403, 'Model not available through the API');

    const cfg = MIROX_MODELS[model];
    if (!cfg) return fail(404, 'Model not found.');

    const tier = u ? u.tier : 'free';
    const plan = PLANS[tier] || PLANS.free;
    if (cfg.tier === 'pro' && TIER_RANK[tier] < 1) return fail(403, 'Pro plan required');
    if (cfg.tier === 'ultimate' && tier !== 'ultimate') {
      if (tier !== 'free') return fail(403, 'Ultimate plan required');
      if (!u) return fail(401, 'Sign in to use Eclipse');
      if (u.eclipse_used >= plan.eclipse_daily_limit) return fail(429, 'Eclipse daily limit reached');
    }
    if (!text && !files.length) return fail(400, 'Empty message');

    const imagePrompt = files.length ? null : detectImageIntent(text);
    if (imagePrompt) {
      if (!u) return fixedReply('Sign in to generate images. Your daily image allowance is tied to your account.');
      if (u.image_used >= plan.image_limit) return fixedReply(`Daily image limit reached for the ${plan.label} plan.`);
      try {
        const dataUrl = await generateImage(imagePrompt);
        u.image_used += 1;
        await saveImage(u, imagePrompt, dataUrl);
        logEvent({ email: u.email, event: 'image_generated_chat', prompt: imagePrompt.slice(0, 300) });
        await persist();
        if (!wantStream) return res.json({ reply: '', image: dataUrl, _ms: Date.now() - t0 });
        sseInit(res);
        sseWrite(res, { img: dataUrl });
        sseWrite(res, { done: true });
        sseDone(res);
        return res.end();
      } catch {
        return fixedReply('Image generation failed. Please try again in a moment.');
      }
    }

    const searchQuery = forceSearch ? text : detectSearchIntent(text);
    if (wantStream) sseInit(res);

    const msgs = [{ role: 'system', content: buildSystemPrompt(cfg, bridge, !!searchQuery, u?.persona || '') }];
    for (const h of history) {
      const role = h && h.role;
      const content = safeStr(h && h.content, 4000).trim();
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
        if (searchData.overview?.text) {
          sseWrite(res, { overview: { source: searchData.overview.source, heading: searchData.overview.heading || '', text: searchData.overview.text, url: searchData.overview.url || '' } });
        }
        for (const r of searchData.results) {
          if (closed) break;
          sseWrite(res, { source: { title: r.title, url: r.url, domain: r.domain || '' } });
          await sleep(60);
        }
        sseWrite(res, { search_done: true, count: searchData.results.length });
      }
      const hasData = searchData.results.length || searchData.overview;
      msgs.push({
        role: 'system',
        content: hasData ? formatSearchContext(searchQuery, searchData)
          : `Web search for "${searchQuery}" returned no results. Answer from your own knowledge and say you could not verify.`,
      });
    }

    const finishUsage = async () => {
      logChat({ email: u ? u.email : 'guest', model, message: (text || '(vision)').slice(0, 200) });
      if (u) {
        u.daily_used += 1;
        if (visionUsed) u.vision_used += 1;
        if (model === 'mirox-eclipse-2.0') u.eclipse_used += 1;
      }
      await persist();
    };

    const result = await miroxChatChain({ messages: msgs, cfg, stream: wantStream, vision: visionUsed });

    if (!wantStream) {
      const data = await result.res.json().catch(() => ({}));
      const reply = extractReplyText(data) || '(empty)';
      await finishUsage();
      return res.json({
        reply, _ms: Date.now() - t0, provider: result.provider,
        search: searchQuery ? { query: searchQuery, results: searchData.results, overview: searchData.overview } : null,
      });
    }

    sseWrite(res, { p: result.provider });
    await pipeProviderStream(result.res.body, (d) => sseWrite(res, { d }), isClosed, () => sseWrite(res, { limit: true }));
    if (!closed) sseWrite(res, { done: true });
    sseDone(res);
    await finishUsage();
    res.end();
  } catch (e) {
    console.warn('[chat]', e.message);
    if (res.headersSent) {
      if (wantStream) { sseWrite(res, { error: { message: GENERIC_ERR } }); sseDone(res); }
      try { res.end(); } catch {}
    } else {
      res.status(502).json({ error: { message: GENERIC_ERR } });
    }
  }
});

/* ============================================================
   ADMIN
   ============================================================ */
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

  // image-related events (both API and chat) with prompts
  const imgEvents = db.events
    .filter((e) => e.event === 'image_generated' || e.event === 'image_generated_chat')
    .slice(-60)
    .reverse()
    .map((e) => ({ ts: e.ts, email: e.email || '—', prompt: e.prompt || '' }));

  res.json({
    ok: true,
    durable: KV_ON,
    db_writable: dbOk,
    warning: KV_ON ? null : 'No durable store configured. Plans can reset on serverless cold starts. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.',
    users: users.length,
    chats: db.chats.length,
    events: db.events.length,
    images: imgEvents.length,
    users_data: Object.fromEntries(users.map((u) => [u.email, {
      name: u.name, tier: u.tier, daily_used: u.daily_used, image_used: u.image_used,
      eclipse_used: u.eclipse_used, last_login: u.last_login,
    }])),
    chats_data: db.chats.slice(-100).reverse(),
    events_data: db.events.slice(-100).reverse(),
    images_data: imgEvents,
  });
});

app.post(['/api/admin/set-tier', '/admin/set-tier'], requireAdmin, async (req, res) => {
  await ensureDb(req);
  if (!dbOk) return res.status(503).json({ ok: false, error: 'Storage is not readable. Refusing to change tiers.' });
  const email = safeStr(req.body?.email, 200).trim().toLowerCase();
  const tier = safeStr(req.body?.tier, 20).trim();
  if (!email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'Valid email required' });
  if (!['free', 'pro', 'ultimate'].includes(tier)) return res.status(400).json({ ok: false, error: 'Invalid tier' });
  const u = userFor(email);
  u.tier = tier;
  logEvent({ email, event: 'tier_set', tier });
  if (!(await persist())) return res.status(500).json({ ok: false, error: 'Save failed. Tier not changed.' });
  res.json({ ok: true, email, tier });
});

/* ============================================================
   BRIDGE CLIENT DOWNLOAD
   ============================================================ */
app.get('/api/bridge/download', async (req, res) => {
  let archiver;
  try { archiver = (await import('archiver')).default; }
  catch { return res.status(500).json({ ok: false, error: 'archiver is not installed. Run npm i archiver.' }); }

  let runner;
  try { runner = await fs.readFile(path.join(__dirname, 'mirox_client_bridge', 'runner.py'), 'utf8'); }
  catch { return res.status(500).json({ ok: false, error: 'runner.py is missing from the deployment.' }); }

  const name = safeStr(req.query.name, 60).trim() || 'My Laptop';
  const port = Number(req.query.port) || 8765;
  const readme = '# MiroxAI Bridge\n\n1. pip install aiohttp\n2. (optional) pip install pillow pyperclip\n3. (optional) sudo apt install kdeconnect\n4. python runner.py\n5. Open MiroxAI -> Bridge -> Connect\n';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="mirox_client_bridge.zip"');
  res.setHeader('Cache-Control', 'no-store');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', () => { try { res.end(); } catch {} });
  archive.pipe(res);
  archive.append(JSON.stringify({
    bridge_name: name, port, allowed_dirs: ['~'], max_output_bytes: 200000,
    smtp: { enabled: false, host: '', port: 587, user: '', pass: '', from: '', use_tls: true },
  }, null, 2), { name: 'mirox_client_bridge/config.json' });
  archive.append(runner, { name: 'mirox_client_bridge/runner.py' });
  archive.append(readme, { name: 'mirox_client_bridge/README.md' });
  await archive.finalize();
});

/* ============================================================
   FALLBACKS & ERRORS
   ============================================================ */
app.use((req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/v1')) {
    return res.status(404).json({ ok: false, error: 'Not found' });
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) res.status(404).send('Not found');
  });
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'Request too large' });
  console.error('[express]', err?.message || err);
  if (!res.headersSent) res.status(500).json({ ok: false, error: GENERIC_ERR });
});

console.log('[Mirox] v96 · durable store:', KV_ON, '· providers:', { hf: !!HF_API_KEY, pl: !!PL_KEY, airoute: !!AIROUTE_KEY });

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log('[Mirox] Server at http://localhost:' + PORT));
}

export default app;

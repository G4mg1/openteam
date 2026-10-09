/* ============================================================
   MiroxAI Backend v94
   - Durable DB (Upstash Redis if configured, else file)
   - Plans no longer reset: writes are blocked if the DB failed to load
   - Admin password required from env (no hardcoded fallback)
   - Email login disabled unless ALLOW_EMAIL_LOGIN=1
   - API keys enforced on /v1/* (Bearer mxk_live_...)
   - Loginment secrets from env
   - AIroute as final fallback, KDE Connect hooks, search, vision
   ============================================================ */

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------- Env ---------- */
const HF_API_KEY   = (process.env.HF_API_KEY || '').trim();
const PL_KEY       = (process.env.PL_KEY || '').trim();
const F_API        = (process.env.F_API || '').trim();
const SECRET       = (process.env.SECRET_KEY || '').trim();
const ADMIN_PASS   = (process.env.ADMIN_PASSWORD || '').trim();
const PORT         = process.env.PORT || 3000;
const DB_FILE      = process.env.DB_FILE || '/tmp/mirox-db.json';
const ALLOW_EMAIL_LOGIN = process.env.ALLOW_EMAIL_LOGIN === '1';

if (!SECRET) console.warn('[Mirox] SECRET_KEY is not set. Sessions will be insecure until you set it.');
if (!ADMIN_PASS) console.warn('[Mirox] ADMIN_PASSWORD is not set. Admin login is disabled.');

const SESSION_SECRET = SECRET || crypto.randomBytes(32).toString('hex');

/* ---------- AIroute (final fallback) ---------- */
const AIROUTE_KEY  = (process.env.AR_KEY || process.env.AIRoute_KEY || process.env.AIROUTE_KEY || '').trim();
const AIROUTE_BASE = (process.env.AR_BASE || 'https://route-ai-playground.lovable.app').replace(/\/+$/, '');
const AIROUTE_CHAT = `${AIROUTE_BASE}/api/public/v1/chat`;
const AIROUTE_IMG  = `${AIROUTE_BASE}/api/public/v1/images`;

/* ---------- Loginment (from env only) ---------- */
const LOGINMENT_CLIENT_ID = (process.env.LOGINMENT_CLIENT_ID || '').trim();
const LOGINMENT_API_KEY   = (process.env.LOGINMENT_API_KEY || '').trim();
const LOGINMENT_DOMAIN    = (process.env.LOGINMENT_DOMAIN || 'https://logint.lovable.app').replace(/\/+$/, '');
const PUBLIC_ORIGIN       = (process.env.PUBLIC_ORIGIN || 'https://miroxai.org').replace(/\/+$/, '');
const OAUTH_REDIRECT_URI  = PUBLIC_ORIGIN + '/callback';

const IMG_TOTAL_MS = 60000;
const SEARCH_TIMEOUT_MS = 14000;
const MAX_LOGS = 500;
const GENERIC_ERR = 'Mirox AI encountered an error';

const PROVIDERS = {
  hf: !!HF_API_KEY,
  pl: !!PL_KEY,
  fish: !!F_API,
  airoute: !!AIROUTE_KEY,
};
console.log('[Mirox] v94 — providers:', PROVIDERS, '· airoute base:', AIROUTE_BASE);

/* ---------- Helpers ---------- */
const safe = (v, max = 100000) => {
  try {
    if (v == null) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > max ? s.slice(0, max) : s;
  } catch { return ''; }
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

const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);
function pushLog(arr, item, cap = MAX_LOGS) {
  try { arr.push(item); if (arr.length > cap) arr.splice(0, arr.length - cap); } catch {}
}

/* ============================================================
   DB — durable. Upstash Redis REST if configured, else file.
   Writes are blocked when the last load failed, so a transient
   read error can never wipe paid plans.
   ============================================================ */
const KV_URL   = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const KV_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const KV_ON    = !!(KV_URL && KV_TOKEN);
const KV_KEY   = 'mirox:db:v1';

let db = null;
let dbWritable = false;
let writeChain = Promise.resolve();

const emptyDb = () => ({ users: {}, apiKeys: {}, counters: {}, chats: [], images: [], events: [] });
function normalizeDb(d) {
  const out = Object.assign(emptyDb(), d || {});
  out.users ||= {};
  out.apiKeys ||= {};
  out.counters ||= {};
  out.chats = Array.isArray(out.chats) ? out.chats : [];
  out.images = Array.isArray(out.images) ? out.images : [];
  out.events = Array.isArray(out.events) ? out.events : [];
  return out;
}

async function kvCmd(args) {
  const r = await fetchT(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  }, 8000);
  if (!r.ok) throw new Error('kv_' + r.status);
  return (await r.json()).result;
}

async function readRaw() {
  if (KV_ON) return await kvCmd(['GET', KV_KEY]);
  try { return await fs.readFile(DB_FILE, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function loadDb(force = false) {
  if (db && !force && !KV_ON) return db;
  try {
    const raw = await readRaw();
    db = normalizeDb(raw ? JSON.parse(raw) : null);
    dbWritable = true;
  } catch (e) {
    if (!db) db = emptyDb();
    dbWritable = false;
    console.error('[db] load failed, writes disabled:', e.message);
  }
  return db;
}

function persist() {
  if (!db || !dbWritable) return Promise.resolve();
  const snapshot = JSON.stringify(db);
  writeChain = writeChain.then(async () => {
    try {
      if (KV_ON) await kvCmd(['SET', KV_KEY, snapshot]);
      else await fs.writeFile(DB_FILE, snapshot, 'utf8');
    } catch (e) { console.error('[db] write failed:', e.message); }
  });
  return writeChain;
}

async function getUser(email) {
  await loadDb(KV_ON);
  const u = db.users[email];
  return u ? { ...u } : null;
}

async function saveUser(rec) {
  await loadDb(KV_ON);
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
    provider: rec.provider || 'email', lm_user_id: rec.lm_user_id || null,
  };
  await persist();
  return true;
}

async function ensureFreshUser(email) {
  if (!email) return null;
  let rec = await getUser(email);
  if (!rec) {
    rec = {
      email, name: '', tier: 'free', daily_used: 0, vision_used: 0, image_used: 0, eclipse_used: 0,
      daily_reset: today(), month_key: monthKey(), keys_this_month: 0, created_at: now(), last_login: 0,
      persona: null, memory: [], voice_id: null, api_keys: [], provider: 'email', lm_user_id: null,
    };
    await saveUser(rec);
    return rec;
  }
  let dirty = false;
  if (rec.daily_reset !== today()) {
    rec.daily_used = 0; rec.vision_used = 0; rec.image_used = 0; rec.eclipse_used = 0;
    rec.daily_reset = today(); dirty = true;
  }
  if (rec.month_key !== monthKey()) { rec.keys_this_month = 0; rec.month_key = monthKey(); dirty = true; }
  if (!Array.isArray(rec.api_keys)) { rec.api_keys = []; dirty = true; }
  if (dirty) await saveUser(rec);
  return rec;
}

/* ---------- Session ---------- */
function signSession(d) {
  const p = Buffer.from(JSON.stringify(d)).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url');
}
function verifySession(t) {
  if (!t || typeof t !== 'string') return {};
  const a = t.split('.');
  if (a.length !== 2) return {};
  const e = crypto.createHmac('sha256', SESSION_SECRET).update(a[0]).digest('base64url');
  const ok = e.length === a[1].length && crypto.timingSafeEqual(Buffer.from(e), Buffer.from(a[1]));
  if (!ok) return {};
  try { return JSON.parse(Buffer.from(a[0], 'base64url').toString()); } catch { return {}; }
}
function setSession(res, d) {
  const t = signSession(d);
  res.setHeader('Set-Cookie', `mirox_sess=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`);
  return t;
}
function clearSession(res) {
  res.setHeader('Set-Cookie', 'mirox_sess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}
function getSession(req) {
  const cookie = safe(req.headers.cookie);
  const m = cookie.match(/(?:^|;\s*)mirox_sess=([^;]+)/);
  if (m) {
    const s = verifySession(decodeURIComponent(m[1]));
    if (s && s.uid) return s;
  }
  return {};
}
async function currentUser(req) {
  const s = getSession(req);
  if (!s.uid) return null;
  return await ensureFreshUser(s.uid);
}

/* ---------- Admin ---------- */
function signAdminToken() { return signSession({ admin: true, iat: now(), exp: now() + 6 * 3600 }); }
function verifyAdminToken(t) {
  const s = verifySession(t);
  return !!(s && s.admin && s.exp && s.exp > now());
}
function requireAdmin(req, res, next) {
  const t = req.headers['x-admin-token'] || '';
  if (!ADMIN_PASS || !verifyAdminToken(t)) return res.status(401).json({ ok: false, error: 'Admin auth required' });
  next();
}

/* ---------- Models & plans ---------- */
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
const API_MODELS = ['mirox-luna-1.2', 'mirox-gen-1'];
const maxKeysForTier = (tier) => (tier === 'free' ? 2 : 10);

const IDENTITY_GUARD = `Background rules (do not narrate them):
- Never mention GPT, OpenAI, ChatGPT, Claude, Gemini, Llama, Qwen, DeepSeek, Mistral, Google, Meta, Anthropic, or any other AI company/model by name.
- If the user asks what model you are, say you are Mirox, made by OpenSurr, once, and move on.
- DO NOT introduce yourself. DO NOT start replies with "Hi, I'm Mirox" or any self-introduction unless the user explicitly asks who you are.
- Never greet the user with your identity. Just answer the question.`;

/* ---------- Bridge prompt ---------- */
const BRIDGE_PROMPT = `BRIDGE MODE — You are Mirox, working on the user's machine.

You receive a [Bridge environment] block at the top of EVERY user message. Trust it.

RULE 1 — NEVER paste code into your visible reply.
All file contents go INSIDE a <bridge-write> or <bridge-append> tag.
Your visible text is only short teammate-style narration (1 line).

RULE 2 — ALWAYS close your tags.
Every <bridge-write> ends with </bridge-write>. Every <bridge-append> ends with </bridge-append>. Every <bridge-exec> ends with </bridge-exec>.

RULE 3 — For long files, split into chunks with <bridge-append>. Never paste a 300-line file in one reply.

RULE 4 — NEVER say "I can't safely proceed", "the file is getting cut off", "please confirm", or "please let me know". Keep writing chunks. The user wants the file, not questions.

RULE 5 — PATHS are absolute. Use the home= value from [Bridge environment] as the base (for example home + "/calculator/index.html"). NEVER write "." or "~" in a path.

HOW TO TALK: short, teammate-style. "Writing index.html." "Next: style.css." "Done — 3 files in ~/calculator/."
When done: reply DONE on its own line + 1-line summary. No code.

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
  <bridge-sysinfo/>
  <bridge-syscheck/>
  <bridge-processes/>
  <bridge-designs>
  <design id="1" name="Dark"><html>...</html></design>
  <design id="2" name="Light"><html>...</html></design>
  <design id="3" name="Bold"><html>...</html></design>
  </bridge-designs>
  <bridge-ask>
  Question text
  - Option A
  - Option B
  </bridge-ask>
  <bridge-kde-refresh/>
  <bridge-kde-list/>
  <bridge-kde-ping device="ID"/>
  <bridge-kde-ring device="ID"/>
  <bridge-kde-share device="ID" path="/abs/path"/>
  <bridge-kde-share-text device="ID">text</bridge-kde-share-text>
  <bridge-kde-sms device="ID" number="+1...">hi</bridge-kde-sms>
  <bridge-kde-lock device="ID"/>
  <bridge-kde-notifications device="ID"/>
  <bridge-kde-my-id/>
  <bridge-email to="x@y.com" subject="Hi">body</bridge-email>
  <bridge-http url="https://..." method="GET"/>
  <bridge-clipboard action="get"/>
  <bridge-clipboard action="set">text</bridge-clipboard>
  <bridge-screenshot path="/abs/shot.png"/>
  <bridge-git action="status" cwd="/abs/dir"/>
  <bridge-pkgs type="pip"/>`;

function buildSystemPrompt(cfg, bridge, searchUsed) {
  let p = IDENTITY_GUARD + '\n\n---\n\n' + cfg.basePrompt;
  if (searchUsed) {
    p += `\n\n---\n\nWEB SEARCH MODE\nThe system performed a live web search. Results will be provided in a system message. Use them to answer. Cite sources inline like [1], [2] when relevant.`;
  }
  if (bridge && bridge.connected) {
    p += '\n\n---\n\n' + BRIDGE_PROMPT;
    const env = bridge.env || {};
    const allowed = Array.isArray(env.allowed_dirs) && env.allowed_dirs.length ? env.allowed_dirs.join(', ') : '(not provided)';
    p += `\n\n=== [Bridge environment] ===\n`;
    p += `user=${env.user || '(unknown)'}\n`;
    p += `home=${env.home || '(unknown)'}\n`;
    p += `cwd=${env.cwd || '(unknown)'}\n`;
    p += `platform=${env.platform || '(unknown)'}\n`;
    p += `allowed_dirs=${allowed}\n`;
    p += `kdeConnect=${env.kde_connect_available ? 'true' : 'false'}\n`;
    if (bridge.filesWritten?.length) p += `filesWritten=${bridge.filesWritten.join(', ')}\n`;
    if (bridge.plannedFiles?.length) p += `plannedFiles=${bridge.plannedFiles.join(', ')}\n`;
    if (bridge.kdeDevice) p += `currentKdeDevice=${bridge.kdeDevice.id} name="${bridge.kdeDevice.name}"\n`;
    p += `Use ONLY absolute paths under home. NEVER say "." or "~" when asked for a path.`;
  }
  return p;
}

/* ---------- Intent detection ---------- */
function detectSearchIntent(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let m = t.match(/(?:^|\b)(?:search(?:\s+(?:the\s+)?(?:web|internet|online))?|google|look\s+up|find\s+(?:info|information|details))\s+(?:for\s+|about\s+|on\s+)?(.+?)[\s.?!,;:]*$/i);
  if (m && m[1]) return m[1].trim();
  m = t.match(/^search\s+(?:for\s+)?(.+?)[\s.?!,;:]*$/i);
  if (m && m[1]) return m[1].trim();
  m = t.match(/(?:latest|recent|current)\s+(?:news|info|information)\s+(?:on|about)\s+(.+?)[\s.?!,;:]*$/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

function detectImageIntent(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let m = t.match(/^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|i\s+want\s+(?:you\s+)?to\s+)?(?:generate|create|make|draw|render|paint|show\s+me|give\s+me|i\s+want|i\s+need)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:image|picture|photo|illustration|art(?:work)?|drawing|render|painting)\s+(?:of\s+|with\s+|showing\s+|depicting\s+|that\s+shows\s+)?(.+?)[\s.?!,;:]*$/i);
  if (m && m[1]) return m[1].trim();
  m = t.match(/^(?:an?\s+)?(?:image|picture|photo|illustration)\s+of\s+(.+?)[\s.?!,;:]*$/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

/* ---------- Web search ---------- */
async function duckSearch(query, max = 5) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const r = await fetchT(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, SEARCH_TIMEOUT_MS);
    if (!r.ok) return [];
    const html = await r.text();
    const strip = s => String(s || '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
    const out = [];
    const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,3000}?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/g;
    let m;
    while ((m = re.exec(html)) !== null && out.length < max) {
      let href = m[1];
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch {} }
      if (href.startsWith('//')) href = 'https:' + href;
      const title = strip(m[2]);
      const snippet = strip(m[3]);
      if (!title || !href) continue;
      if (href.includes('duckduckgo.com/y.js') || href.includes('duckduckgo.com/l/?')) continue;
      let domain = '';
      try { domain = new URL(href).hostname.replace(/^www\./, ''); } catch {}
      out.push({ title, url: href, snippet, domain });
    }
    return out;
  } catch { return []; }
}

async function ddgInstantAnswer(query) {
  try {
    const r = await fetchT(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {}, 8000);
    if (!r.ok) return null;
    const d = await r.json();
    const hasContent = d.Abstract || d.Answer || d.Definition || d.Heading;
    if (!hasContent) return null;
    return {
      heading: d.Heading || '',
      abstract: d.Abstract || '',
      abstractSource: d.AbstractSource || '',
      abstractURL: d.AbstractURL || '',
      answer: d.Answer || '',
      definition: d.Definition || '',
      definitionSource: d.DefinitionSource || '',
    };
  } catch { return null; }
}

async function wikiSummary(title) {
  try {
    const r = await fetchT(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {}, 7000);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.extract) return null;
    return {
      title: d.title || title,
      extract: d.extract,
      url: d.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    };
  } catch { return null; }
}

async function wikiSearch(query) {
  try {
    const r = await fetchT(`https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&origin=*`, {}, 8000);
    if (!r.ok) return [];
    const d = await r.json();
    const hits = d?.query?.search || [];
    return hits.map(h => ({
      title: h.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
      snippet: String(h.snippet || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim(),
      domain: 'en.wikipedia.org',
    }));
  } catch { return []; }
}

async function webSearch(query, max = 5) {
  const [organic, instant] = await Promise.all([duckSearch(query, max), ddgInstantAnswer(query)]);
  let results = organic;
  if (!results.length) results = await wikiSearch(query);
  const seen = new Set();
  const dedup = [];
  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    dedup.push(r);
    if (dedup.length >= max) break;
  }
  let overview = null;
  if (instant && (instant.abstract || instant.answer || instant.definition)) {
    overview = {
      source: instant.abstractSource || 'DuckDuckGo',
      heading: instant.heading,
      text: instant.abstract || instant.answer || instant.definition,
      url: instant.abstractURL || '',
      kind: 'instant',
    };
  } else {
    const title = dedup[0]?.title || query;
    const ws = await wikiSummary(title);
    if (ws) overview = { source: 'Wikipedia', heading: ws.title, text: ws.extract, url: ws.url, kind: 'wiki' };
  }
  return { results: dedup, overview };
}

function formatSearchContext(query, searchData) {
  const { results, overview } = searchData || { results: [], overview: null };
  const parts = [];
  if (overview && overview.text) {
    parts.push(`[OVERVIEW — ${overview.source}${overview.url ? ' (' + overview.url + ')' : ''}]\n${overview.text}`);
  }
  if (results.length) {
    parts.push('[' + results.length + ' ORGANIC RESULTS]');
    parts.push(results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet || '(no snippet)'}`).join('\n\n'));
  }
  if (!parts.length) return `Web search for "${query}" returned no usable results.`;
  return `Web search results for "${query}":\n\n` + parts.join('\n\n');
}

/* ============================================================
   Provider URLs & chains
   ============================================================ */
const HF_URL = 'https://router.huggingface.co/v1/chat/completions';
const PL_URL = 'https://gen.pollinations.ai/v1/chat/completions';
const PL_IMG_BASE = 'https://gen.pollinations.ai/image';
const HF_CHAT_MODELS = ['meta-llama/Llama-3.3-70B-Instruct:together', 'Qwen/Qwen2.5-72B-Instruct:together'];
const HF_VISION_MODELS = ['meta-llama/Llama-3.2-11B-Vision-Instruct:together', 'Qwen/Qwen2-VL-7B-Instruct:hyperbolic'];
const PL_CHAT_MODELS = ['openai', 'openai-fast', 'mistral'];
const PL_VISION_MODELS = ['openai', 'openai-fast'];
const PL_IMG_MODELS = ['flux', 'turbo'];

async function hfChat(modelId, messages, maxTokens, stream) {
  if (!HF_API_KEY) throw new Error('no_hf');
  const body = { model: modelId, messages, max_tokens: maxTokens, stream: !!stream, temperature: 0.7 };
  const res = await fetchT(HF_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 20000);
  if (!res.ok) throw new Error(`hf_${res.status}`);
  return res;
}
async function plChat(modelId, messages, maxTokens, stream) {
  if (!PL_KEY) throw new Error('no_pl');
  const body = { model: modelId, messages, max_tokens: maxTokens, stream: !!stream, temperature: 0.7 };
  const res = await fetchT(PL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PL_KEY}`, 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify(body),
  }, 20000);
  if (!res.ok) throw new Error(`pl_${res.status}`);
  return res;
}

/* ---------- AIroute adapter ---------- */
function convertToAirouteShape(messages) {
  const norm = [];
  for (const m of safeArr(messages)) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '').toLowerCase();
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map(p => {
        if (!p) return '';
        if (p.type === 'text') return p.text || '';
        if (p.type === 'image_url') return '[image]';
        return '';
      }).join('\n');
    }
    norm.push({ role, content: String(content || '') });
  }
  let promptIdx = -1;
  for (let i = norm.length - 1; i >= 0; i--) {
    if (norm[i].role === 'user') { promptIdx = i; break; }
  }
  let prompt = promptIdx >= 0 ? norm[promptIdx].content : '';
  const before = promptIdx >= 0 ? norm.slice(0, promptIdx) : norm;
  const systems = before.filter(m => m.role === 'system').map(m => m.content).filter(Boolean);
  const history = before.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content }));
  if (systems.length) prompt = systems.join('\n\n') + '\n\n' + prompt;
  return { prompt, history };
}

async function airouteChat({ messages, model, fast = true, memory = true, timeoutMs = 120000 }) {
  if (!AIROUTE_KEY) throw new Error('no_airoute');
  const { prompt, history } = convertToAirouteShape(messages);
  const body = { prompt, history: history.slice(-40) };
  if (fast) body.fast = true;
  if (model) body.model = model;
  if (memory === false) body.memory = false;
  const res = await fetchT(AIROUTE_CHAT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AIROUTE_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!res.ok) throw new Error(`airoute_${res.status}`);
  return res;
}

function textToSyntheticSSE(text) {
  const enc = new TextEncoder();
  const s = String(text || '');
  const tokens = s.split(/(\s+)/);
  const chunks = [];
  let cur = '';
  for (const t of tokens) {
    cur += t;
    if (cur.length >= 20) { chunks.push(cur); cur = ''; }
  }
  if (cur) chunks.push(cur);
  if (!chunks.length) chunks.push('');
  return new ReadableStream({
    start(controller) {
      try {
        for (const c of chunks) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`));
        }
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
      } catch {}
      try { controller.close(); } catch {}
    },
  });
}

async function airouteImage(prompt, timeoutMs = 60000) {
  if (!AIROUTE_KEY) throw new Error('no_airoute');
  const res = await fetchT(AIROUTE_IMG, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AIROUTE_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model: 'black-forest-labs/FLUX.1-schnell', prompt: String(prompt || '').slice(0, 2000) }),
  }, timeoutMs);
  if (!res.ok) throw new Error(`airoute_img_${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (typeof data.image === 'string' && data.image.startsWith('data:image')) return data.image;
  if (typeof data.image === 'string' && data.image.startsWith('http')) return data.image;
  return null;
}

/* ---------- Chat chain ---------- */
async function miroxChatChain({ messages, cfg, stream, vision }) {
  if (vision) {
    if (PROVIDERS.hf) {
      for (const mid of HF_VISION_MODELS) {
        try { const res = await hfChat(mid, messages, cfg.tokens, stream); return { res, provider: 'hf', vision: true }; } catch {}
      }
    }
    if (PROVIDERS.pl) {
      for (const mid of PL_VISION_MODELS) {
        try { const res = await plChat(mid, messages, cfg.tokens, stream); return { res, provider: 'pl', vision: true }; } catch {}
      }
    }
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        msg.content = msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
      }
    }
  }

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
  if (PROVIDERS.airoute) {
    try {
      const res = await airouteChat({ messages, fast: true, memory: true });
      const data = await res.json().catch(() => ({}));
      const text = extractReplyText(data);
      if (stream) return { res: { body: textToSyntheticSSE(text), ok: true }, provider: 'airoute' };
      return { res: { json: async () => ({ reply: text }) }, provider: 'airoute' };
    } catch (e1) {
      try {
        const res = await airouteChat({ messages, fast: false, model: 'meta-llama/Llama-3.3-70B-Instruct', memory: true });
        const data = await res.json().catch(() => ({}));
        const text = extractReplyText(data);
        if (stream) return { res: { body: textToSyntheticSSE(text), ok: true }, provider: 'airoute' };
        return { res: { json: async () => ({ reply: text }) }, provider: 'airoute' };
      } catch (e2) {}
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
    if (typeof url === 'string' && (url.startsWith('data:image') || url.startsWith('http'))) return url;
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
      const headers = { Accept: 'image/png' };
      if (PL_KEY) headers.Authorization = `Bearer ${PL_KEY}`;
      const res = await fetchT(url, { method: 'GET', headers }, 30000);
      if (!res.ok) continue;
      const dataUrl = await toDataUrl(res);
      if (dataUrl) return dataUrl;
    } catch {}
  }
  if (PROVIDERS.airoute) {
    try {
      const dataUrl = await airouteImage(prompt, Math.max(15000, deadline - Date.now() - 3000));
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
  try {
    if (res.writableEnded || res.destroyed) return false;
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
    return true;
  } catch { return false; }
}
function sseDone(res) { try { res.write('data: [DONE]\n\n'); } catch {} }

/* ---------- Auth for /v1 (API key OR web session) ---------- */
async function authFromRequest(req) {
  const h = safe(req.headers.authorization, 200);
  if (h) {
    const m = h.match(/^Bearer\s+(mxk_live_[A-Za-z0-9]+)$/);
    if (!m) return { error: 'invalid' };
    await loadDb(KV_ON);
    for (const u of Object.values(db.users)) {
      const k = (u.api_keys || []).find(x => !x.revoked && x.key === m[1]);
      if (k) {
        k.last_used = now();
        await persist();
        return { user: await ensureFreshUser(u.email), viaKey: true };
      }
    }
    return { error: 'invalid' };
  }
  return { user: await currentUser(req), viaKey: false };
}

/* ---------- App ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '60mb' }));
try { app.use(express.static(path.join(__dirname, '../public'))); } catch {}
app.use(async (req, res, next) => { try { await loadDb(KV_ON); } catch {} next(); });

app.get(['/api/health', '/health', '/ping'], (req, res) => {
  res.json({
    ok: true, app: 'MiroxAI', version: 'v94', providers: PROVIDERS,
    airoute: { enabled: PROVIDERS.airoute, base: AIROUTE_BASE, chat: AIROUTE_CHAT, images: AIROUTE_IMG },
    db: { durable: KV_ON, writable: dbWritable },
    search: true, vision: true, image_intent: true, kde_connect: true,
    loginment: !!LOGINMENT_CLIENT_ID, time: now(),
  });
});

app.get('/api/web/status', async (req, res) => {
  const t0 = Date.now();
  const [ddg, wiki] = await Promise.all([
    duckSearch('test', 1).then(r => r.length > 0).catch(() => false),
    wikiSearch('Python').then(r => r.length > 0).catch(() => false),
  ]);
  res.json({ ok: true, duckduckgo: ddg, wikipedia: wiki, ms: Date.now() - t0 });
});

/* ============================================================
   LOGINMENT OAUTH
   ============================================================ */
app.get('/api/auth/loginment/start', (req, res) => {
  if (!LOGINMENT_CLIENT_ID) return res.status(500).send('Loginment not configured');
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `mirox_lm_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  const url = `${LOGINMENT_DOMAIN}/authorize?client_id=${encodeURIComponent(LOGINMENT_CLIENT_ID)}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}&state=${state}`;
  res.redirect(url);
});

app.get(['/callback', '/api/auth/loginment/callback'], async (req, res) => {
  try {
    const code = safe(req.query.code, 200);
    const state = safe(req.query.state, 200);
    const cookieHeader = req.headers.cookie || '';
    const savedState = (cookieHeader.match(/(?:^|;\s*)mirox_lm_state=([^;]+)/) || [])[1];
    res.setHeader('Set-Cookie', 'mirox_lm_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    if (!code) return res.status(400).send('Missing code');
    if (!state || !savedState || state !== savedState) return res.status(400).send('Invalid state');
    if (!LOGINMENT_API_KEY) return res.status(500).send('Loginment not configured');

    const r = await fetchT(`${LOGINMENT_DOMAIN}/api/public/v1/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LOGINMENT_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }, 15000);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.success || !data.user || !data.user.email) {
      pushLog(db.events, { email: 'loginment', event: 'login_failed', ts: now(), reason: data?.error || r.status });
      await persist();
      return res.status(401).send('Login failed');
    }
    const u = data.user;
    const email = String(u.email).toLowerCase();
    let rec = await getUser(email);
    if (!rec) rec = { email, name: email.split('@')[0], tier: 'free', api_keys: [] };
    if (!Array.isArray(rec.api_keys)) rec.api_keys = [];
    rec.provider = u.provider || 'email';
    rec.lm_user_id = u.id || null;
    rec.last_login = now();
    if (!rec.name) rec.name = email.split('@')[0];
    await saveUser(rec);
    pushLog(db.events, { email, event: 'loginment_login', ts: now(), provider: rec.provider });
    await persist();
    setSession(res, { uid: email, name: rec.name, tier: rec.tier });
    res.redirect('/');
  } catch (e) {
    res.status(500).send('Server error');
    console.error('[callback]', e.message);
  }
});

app.get('/api/auth/loginment/url', (req, res) => {
  if (!LOGINMENT_CLIENT_ID) return res.status(500).json({ ok: false, error: 'Loginment not configured' });
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `mirox_lm_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  const url = `${LOGINMENT_DOMAIN}/authorize?client_id=${encodeURIComponent(LOGINMENT_CLIENT_ID)}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}&state=${state}`;
  res.json({ ok: true, url });
});

/* ============================================================
   EMAIL LOGIN (disabled unless ALLOW_EMAIL_LOGIN=1)
   ============================================================ */
app.post(['/api/auth/simple-login', '/auth/simple-login'], async (req, res) => {
  if (!ALLOW_EMAIL_LOGIN) return res.status(403).json({ ok: false, error: 'Email login is disabled. Use Loginment.' });
  try {
    const { name, email } = req.body || {};
    const n = safe(name, 60).trim();
    const e = safe(email, 120).trim().toLowerCase();
    if (!n || !e || !e.includes('@')) return res.status(400).json({ ok: false, error: 'Name and email required' });
    let rec = await getUser(e);
    if (!rec) rec = { email: e, name: n, tier: 'free', api_keys: [] };
    if (!Array.isArray(rec.api_keys)) rec.api_keys = [];
    rec.name = n;
    rec.last_login = now();
    rec.provider = rec.provider || 'email';
    await saveUser(rec);
    pushLog(db.events, { email: e, event: 'login', ts: now() });
    await persist();
    const token = setSession(res, { uid: e, name: n, tier: rec.tier });
    res.json({ ok: true, token, user: { id: e, email: e, name: n, tier: rec.tier } });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.post(['/api/logout', '/logout'], (req, res) => { clearSession(res); res.json({ ok: true }); });

app.get(['/api/me', '/me'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const u = await currentUser(req);
    if (!u) return res.json({ user: null });
    const plan = PLANS[u.tier] || PLANS.free;
    res.json({
      user: {
        id: u.email, email: u.email, name: u.name, tier: u.tier, provider: u.provider || 'email',
        vision_limit: plan.vision_limit, vision_used: u.vision_used || 0,
        image_limit: plan.image_limit, image_used: u.image_used || 0,
        eclipse_limit: plan.eclipse_daily_limit, eclipse_used: u.eclipse_used || 0,
        api_keys_used: (u.api_keys || []).filter(k => !k.revoked).length,
        api_keys_limit: maxKeysForTier(u.tier),
      },
    });
  } catch { res.json({ user: null }); }
});

/* ============================================================
   API KEYS
   ============================================================ */
function publicKeyView(k) {
  return { id: k.id, name: k.name, key: k.key, prefix: k.key.slice(0, 14) + '…', created: k.created, last_used: k.last_used || 0, revoked: !!k.revoked };
}

app.get(['/api/keys', '/keys'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const keys = (u.api_keys || []).map(publicKeyView);
  const limit = maxKeysForTier(u.tier);
  const active = keys.filter(k => !k.revoked).length;
  res.json({ ok: true, keys, limit, active, tier: u.tier });
});

app.post(['/api/keys', '/keys'], async (req, res) => {
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

app.post(['/api/keys/rename', '/keys/rename'], async (req, res) => {
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

app.post(['/api/keys/revoke', '/keys/revoke'], async (req, res) => {
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

app.post(['/api/keys/delete', '/keys/delete'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
  const id = safe(req.body?.id, 40);
  u.api_keys = (u.api_keys || []).filter(k => k.id !== id);
  await saveUser(u);
  pushLog(db.events, { email: u.email, event: 'key_deleted', ts: now(), id });
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
  const mine = (db.images || []).filter(x => x.email === u.email).slice(-60).reverse();
  res.json({ ok: true, images: mine });
});

/* ============================================================
   ADMIN
   ============================================================ */
app.post(['/api/admin/auth', '/admin/auth'], async (req, res) => {
  try {
    const pass = safe(req.body?.password, 200);
    if (!ADMIN_PASS || !pass || pass !== ADMIN_PASS) return res.status(401).json({ ok: false, error: 'Invalid password' });
    res.json({ ok: true, token: signAdminToken() });
  } catch { res.status(500).json({ ok: false, error: 'Server error' }); }
});

app.get(['/api/admin/stats', '/admin/stats'], requireAdmin, async (req, res) => {
  try {
    const users = db.users || {};
    const users_data = {};
    for (const [email, u] of Object.entries(users)) {
      users_data[email] = {
        name: u.name || '', tier: u.tier || 'free',
        eclipse_used: u.eclipse_used || 0, daily_used: u.daily_used || 0,
        last_login: u.last_login || 0,
      };
    }
    res.json({
      ok: true,
      warning: !KV_ON ? 'No durable store configured — plans can reset. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.' : null,
      db_writable: dbWritable,
      users: Object.keys(users).length,
      chats: (db.chats || []).length,
      images: (db.images || []).length,
      events: (db.events || []).length,
      users_data,
      chats_data: (db.chats || []).slice(-100).reverse(),
      images_data: (db.images || []).slice(-60).reverse().map(i => ({ ts: i.ts, email: i.email, prompt: i.prompt })),
      events_data: (db.events || []).slice(-100).reverse(),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post(['/api/admin/set-tier', '/admin/set-tier'], requireAdmin, async (req, res) => {
  try {
    if (!dbWritable) return res.status(503).json({ ok: false, error: 'Database not writable. Refusing to change tiers.' });
    const email = safe(req.body?.email, 200).trim().toLowerCase();
    const tier = safe(req.body?.tier, 20).trim();
    if (!email || !tier) return res.status(400).json({ ok: false, error: 'email and tier required' });
    if (!['free', 'pro', 'ultimate'].includes(tier)) return res.status(400).json({ ok: false, error: 'Invalid tier' });
    const u = await ensureFreshUser(email);
    u.tier = tier;
    await saveUser(u);
    pushLog(db.events, { email, event: 'tier_set', ts: now(), tier });
    await persist();
    res.json({ ok: true, email, tier });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ============================================================
   BRIDGE DOWNLOAD
   ============================================================ */
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

    const configJson = JSON.stringify({
      bridge_name: name, port, allowed_dirs: ['~'], max_output_bytes: 200000,
      smtp: { enabled: false, host: '', port: 587, user: '', pass: '', from: '', use_tls: true },
    }, null, 2);

    const readme = `# MiroxAI Bridge\n\n1. pip install aiohttp\n2. (optional) pip install pillow for screenshots\n3. (optional) pip install pyperclip for clipboard\n4. (optional) sudo apt install kdeconnect  # for phone control\n5. python runner.py\n6. Open MiroxAI -> Bridge -> Connect\n`;

    const runner = `#!/usr/bin/env python3
# Minimal bootstrap. For the full runner (KDE Connect, sudo, git, etc.), use runner.py from the repo.
import os, sys, json, time, platform, tempfile
from pathlib import Path
try:
    from aiohttp import web
except ImportError:
    print("pip install aiohttp"); sys.exit(1)
CONFIG_FILE = Path(__file__).parent / "config.json"
CONFIG = json.load(open(CONFIG_FILE, encoding="utf-8")) if CONFIG_FILE.exists() else {}
CONFIG.setdefault("bridge_name", "My Laptop"); CONFIG.setdefault("port", 8765)
PORT = int(CONFIG["port"]); NAME = CONFIG["bridge_name"]
@web.middleware
async def cors_mw(request, handler):
    if request.method == "OPTIONS": resp = web.Response()
    else:
        try: resp = await handler(request)
        except web.HTTPException as e: resp = e
        except Exception as e: resp = web.json_response({"ok": False, "error": str(e)}, status=500)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    return resp
async def ping(req): return web.json_response({"ok": True, "name": NAME, "time": time.time()})
async def env_info(req):
    import shutil as sh
    home = str(Path.home())
    return web.json_response({"ok": True, "name": NAME, "home": home, "cwd": home, "platform": platform.system(), "allowed_dirs": [home, tempfile.gettempdir()], "kde_connect_available": bool(sh.which("kdeconnect-cli")), "time": time.time()})
def build_app():
    a = web.Application(middlewares=[cors_mw])
    a.router.add_get("/ping", ping)
    a.router.add_get("/env", env_info)
    return a
if __name__ == "__main__":
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

/* ---------- Config & plans ---------- */
app.get(['/api/config', '/config'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const models = Object.entries(MIROX_MODELS).map(([id, m]) => ({ id, label: m.label, tier: m.tier }));
  res.json({
    app: { name: 'MiroxAI', version: 'v94' },
    models, default_model: models[0].id, plans: PLANS,
    tts_available: !!F_API,
    search_available: true,
    vision_available: true,
    image_intent: true,
    loginment_available: !!LOGINMENT_CLIENT_ID,
    email_login_available: ALLOW_EMAIL_LOGIN,
    airoute_available: PROVIDERS.airoute,
    kde_connect_available: true,
  });
});

app.get(['/api/subscription/plans', '/subscription/plans'], (req, res) => {
  const out = Object.entries(PLANS).map(([id, p]) => ({
    id, label: p.label,
    tagline: { free: 'Free forever', pro: 'Most popular', ultimate: 'Power users' }[id],
    vision_limit: p.vision_limit, image_limit: p.image_limit, eclipse_limit: p.eclipse_daily_limit,
    price_usd: p.price_usd, price_afg: p.price_afg,
    api_keys_limit: p.api_keys_per_month,
    perks: id === 'free'
      ? ['Luna & Gen unlimited', '10 image uploads/day', '10 image gens/day', '5 Eclipse/day', '2 API keys', 'Web search', 'Vision', 'KDE Connect']
      : id === 'pro'
        ? ['Pro & Ultra models', '200 image uploads/gens/day', '10 API keys', 'Web search', 'Vision', 'KDE Connect']
        : ['Eclipse — best model', '2000 image uploads/gens/day', '10 API keys', 'Web search', 'Vision', 'KDE Connect'],
  }));
  res.json({ ok: true, plans: out });
});

app.get('/api/persona', async (req, res) => {
  const u = await currentUser(req);
  res.json({ ok: true, persona: u?.persona || '' });
});
app.post('/api/persona', async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false });
  u.persona = safe(req.body?.persona, 500);
  await saveUser(u);
  res.json({ ok: true });
});

/* ---------- Public search endpoint ---------- */
app.get(['/api/search', '/search'], async (req, res) => {
  try {
    const q = safe(req.query.q, 400).trim();
    if (!q) return res.status(400).json({ ok: false, error: 'Query required' });
    const data = await webSearch(q, 8);
    res.json({ ok: true, query: q, results: data.results, overview: data.overview });
  } catch { res.status(500).json({ ok: false, error: 'Search failed' }); }
});

/* ============================================================
   IMAGE GENERATION
   ============================================================ */
app.post('/v1/images/generations', async (req, res) => {
  try {
    const prompt = safe(req.body?.prompt, 2000).trim();
    if (!prompt) return res.status(400).json({ error: { message: 'Prompt required' } });

    const auth = await authFromRequest(req);
    if (auth.error) return res.status(401).json({ error: { message: 'Invalid API key' } });
    const u = auth.user || null;

    const tier = u?.tier || 'free';
    const plan = PLANS[tier] || PLANS.free;
    if ((u?.image_used || 0) >= plan.image_limit) {
      return res.status(429).json({ error: { message: 'Daily image limit reached' } });
    }

    const imageUrl = await generateImage(prompt);
    if (u) { u.image_used = (u.image_used || 0) + 1; try { await saveUser(u); } catch {} }
    pushLog(db.images, { email: u?.email || 'guest', prompt, image: imageUrl, ts: now() }, 300);
    pushLog(db.events, { email: u?.email || 'guest', event: 'image_generated', ts: now() });
    await persist();
    res.json({ ok: true, image: imageUrl });
  } catch {
    res.status(502).json({ error: { message: GENERIC_ERR } });
  }
});

/* ============================================================
   CHAT COMPLETIONS (web app = session cookie; API = Bearer key)
   ============================================================ */
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
    const forceSearch = body.search === true;
    const attachedFiles = safeArr(body.files);

    const auth = await authFromRequest(req);
    if (auth.error) return res.status(401).json({ error: { message: 'Invalid API key' } });
    const u = auth.user || null;
    const viaKey = !!auth.viaKey;

    if (viaKey && !API_MODELS.includes(requestedModel)) {
      return res.status(403).json({ error: { message: 'Model not allowed via API' } });
    }

    const cfg = MIROX_MODELS[requestedModel];
    if (!cfg) return res.status(404).json({ error: { message: 'Model not found.' } });

    const tier = u?.tier || 'free';
    const plan = PLANS[tier] || PLANS.free;
    if (cfg.tier === 'pro' && TIER_RANK[tier] < 1) return res.status(403).json({ error: { message: 'Pro plan required' } });
    if (cfg.tier === 'ultimate' && tier !== 'ultimate') {
      if (tier === 'free') {
        if ((u?.eclipse_used || 0) >= plan.eclipse_daily_limit) {
          return res.status(429).json({ error: { message: 'Eclipse daily limit reached' } });
        }
      } else {
        return res.status(403).json({ error: { message: 'Ultimate plan required' } });
      }
    }

    const text = safe(rawMessage, 100000).trim();
    if (!text && !attachedFiles.length) return res.status(400).json({ error: { message: 'Empty message' } });

    const imageIntent = !attachedFiles.length ? detectImageIntent(text) : null;
    if (imageIntent) {
      try {
        const imageUrl = await generateImage(imageIntent);
        if (u) { u.image_used = (u.image_used || 0) + 1; try { await saveUser(u); } catch {} }
        pushLog(db.images, { email: u?.email || 'guest', prompt: imageIntent, image: imageUrl, ts: now() }, 300);
        pushLog(db.events, { email: u?.email || 'guest', event: 'image_generated_chat', ts: now() });
        await persist();
        if (!stream) return res.json({ reply: '', image: imageUrl, _ms: Date.now() - t0 });
        sseInit(res);
        sseWrite(res, { img: imageUrl });
        sseWrite(res, { done: true });
        sseDone(res);
        try { res.end(); } catch {}
        return;
      } catch (e) {}
    }

    const searchQuery = forceSearch ? text : detectSearchIntent(text);

    const sys = buildSystemPrompt(cfg, bridge, !!searchQuery) + (u?.persona ? `\n\nUser preference: ${safe(u.persona, 500)}` : '');
    const msgs = [{ role: 'system', content: sys }];

    let userText = text || '(no text)';
    if (bridge && bridge.connected) {
      const env = bridge.env || {};
      const allowed = Array.isArray(env.allowed_dirs) && env.allowed_dirs.length ? env.allowed_dirs.join(', ') : '(not provided)';
      userText = `[Bridge environment]\nuser=${env.user || '?'}\nhome=${env.home || '?'}\ncwd=${env.cwd || '?'}\nplatform=${env.platform || '?'}\nallowed_dirs=${allowed}\nkdeConnect=${env.kde_connect_available ? 'true' : 'false'}\n\n` + userText;
    }

    let visionUsed = false;
    if (attachedFiles.length) {
      const parts = [];
      if (userText) parts.push({ type: 'text', text: userText });
      for (const f of attachedFiles.slice(0, 4)) {
        if (f && f.type === 'image' && typeof f.dataUrl === 'string' && f.dataUrl.startsWith('data:image')) {
          parts.push({ type: 'image_url', image_url: { url: f.dataUrl } });
          visionUsed = true;
        } else if (f && f.type === 'text' && typeof f.content === 'string') {
          parts.push({ type: 'text', text: `\n\n[Attached file: ${f.name || 'file'}]\n${String(f.content).slice(0, 60000)}` });
        }
      }
      msgs.push({ role: 'user', content: parts.length ? parts : userText });
    } else {
      msgs.push({ role: 'user', content: userText });
    }

    for (const h of safeArr(rawHistory).slice(-14)) {
      const role = safe(h.role, 20);
      const txt = safe(h.content, 4000).trim();
      if ((role === 'user' || role === 'assistant') && txt) msgs.push({ role, content: txt });
    }

    const updateUsage = async () => {
      if (u && u.email) {
        u.daily_used = (u.daily_used || 0) + 1;
        if (visionUsed) u.vision_used = (u.vision_used || 0) + 1;
        if (requestedModel === 'mirox-eclipse-2.0') u.eclipse_used = (u.eclipse_used || 0) + 1;
        try { await saveUser(u); } catch {}
      }
      pushLog(db.chats, { email: u?.email || 'guest', model: requestedModel, message: (text || '(vision)').slice(0, 400), ts: now() });
      await persist();
    };

    if (!stream) {
      let searchData = { results: [], overview: null };
      if (searchQuery) {
        searchData = await webSearch(searchQuery, 5);
        if (searchData.results.length || searchData.overview) {
          msgs.push({ role: 'system', content: formatSearchContext(searchQuery, searchData) });
        }
      }
      try {
        const result = await miroxChatChain({ messages: msgs, cfg, stream: false, vision: visionUsed });
        const data = await result.res.json().catch(() => ({}));
        const reply = extractReplyText(data) || '(empty)';
        await updateUsage();
        return res.json({
          reply, _ms: Date.now() - t0, provider: result.provider,
          search: searchQuery ? { query: searchQuery, results: searchData.results, overview: searchData.overview } : null,
        });
      } catch (e) {
        return res.status(502).json({ error: { message: GENERIC_ERR } });
      }
    }

    sseInit(res);
    let streamEnded = false;
    const guard = setTimeout(() => {
      if (streamEnded || res.writableEnded) return;
      try { sseDone(res); } catch {}
      try { res.end(); } catch {}
      streamEnded = true;
    }, 300000);

    try {
      if (searchQuery) {
        sseWrite(res, { search: { query: searchQuery } });
        const searchData = await webSearch(searchQuery, 5);
        if (searchData.overview && searchData.overview.text) {
          sseWrite(res, {
            overview: {
              source: searchData.overview.source,
              heading: searchData.overview.heading || '',
              text: searchData.overview.text,
              url: searchData.overview.url || '',
            },
          });
        }
        for (const r of searchData.results) {
          if (clientClosed || res.writableEnded) break;
          sseWrite(res, { source: { title: r.title, url: r.url, domain: r.domain || '' } });
          await new Promise(rr => setTimeout(rr, 80));
        }
        sseWrite(res, { search_done: true, count: searchData.results.length });
        if (searchData.results.length || searchData.overview) {
          msgs.push({ role: 'system', content: formatSearchContext(searchQuery, searchData) });
        } else {
          msgs.push({ role: 'system', content: `Web search for "${searchQuery}" returned no results. Answer from your own knowledge and say you couldn't verify.` });
        }
      }

      const result = await miroxChatChain({ messages: msgs, cfg, stream: true, vision: visionUsed });
      sseWrite(res, { p: result.provider });
      const reader = result.res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        if (clientClosed || res.writableEnded) break;
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          let line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const raw = t.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const o = JSON.parse(raw);
            const d = o.choices?.[0]?.delta?.content;
            if (d) sseWrite(res, { d });
          } catch {}
        }
      }
      try { reader.releaseLock(); } catch {}
      if (!clientClosed && !res.writableEnded) { sseWrite(res, { done: true }); sseDone(res); }
      await updateUsage();
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[stream]', e.message);
      if (!clientClosed && !res.writableEnded) {
        try { sseWrite(res, { error: { message: GENERIC_ERR } }); } catch {}
        try { sseDone(res); } catch {}
      }
    } finally {
      clearTimeout(guard);
      streamEnded = true;
      try { if (!res.writableEnded) res.end(); } catch {}
    }
    return;
  } catch (e) {
    console.error('[handler]', e.message);
    try {
      if (!res.headersSent) res.status(500).json({ error: { message: GENERIC_ERR } });
      else if (!res.writableEnded) res.end();
    } catch {}
  }
});

/* ---------- Fallback ---------- */
app.use((req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/v1')) {
    return res.status(404).json({ ok: false, error: 'Not found: ' + req.path });
  }
  const idx = path.join(__dirname, '../public/index.html');
  res.sendFile(idx, (err) => {
    if (err) res.json({ ok: true, app: 'MiroxAI', message: 'Backend running. public/ missing.' });
  });
});

(async () => {
  try { await loadDb(KV_ON); } catch {}
  if (process.env.VERCEL !== '1') {
    app.listen(PORT, () => console.log('[Mirox] Server at http://localhost:' + PORT));
  }
})();

export default app;

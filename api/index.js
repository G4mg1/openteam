/* ============================================================
   MiroxAI Backend v81
   - HTTP-only Bridge (works from HTTPS via PNA header)
   - Environment-aware Bridge prompt (real home dir + OS)
   - Duplicate-command blocking hints
   - Plan-based multi-file project tracking
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

const OLLAMA_HOST  = process.env.OLLAMA_HOST  || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';

const LOGINMENT_CLIENT_ID = 'lm_e8f7193647f744c6ae45a8af85a7cfd3';
const LOGINMENT_API_KEY = 'lm_sk_96078c548f823c63466abfcaf1e099294056d2f2019a3870';
const LOGINMENT_DOMAIN = 'https://logint.lovable.app';

const HF_ATTEMPT_MS     = 20000;
const PL_ATTEMPT_MS     = 20000;
const OLLAMA_ATTEMPT_MS = 60000;
const AR_SEARCH_MS      = 15000;
const IMG_TOTAL_MS      = 60000;
const TTS_TOTAL_MS      = 90000;
const MAX_LOGS          = 500;
const GENERIC_ERR = 'Mirox AI encountered an error';

const PROVIDERS = { hf: !!HF_API_KEY, pl: !!PL_KEY, ollama: false, ar: !!AR_KEY, search: true, fish: !!F_API };
console.log('[Mirox] v81 — env-aware bridge');

/* ---------- Helpers ---------- */
const safe = (v, max = 100000) => {
  try { if (v == null) return ''; const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > max ? s.slice(0, max) : s; } catch { return ''; }
};
const safeArr = v => { try { return Array.isArray(v) ? v : []; } catch { return []; } };

function msgContentToText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(p => p && p.type === 'text').map(p => p.text).join('\n');
  return safe(c);
}
function extractLastUserQuestion(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') { const t = msgContentToText(m.content).trim(); if (t) return t.slice(0, 1500); }
  }
  return '';
}
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
function looksLikeJson(res) {
  try {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('event-stream')) return false;
    if (ct.startsWith('text/plain') || ct.startsWith('text/html')) return false;
    return true;
  } catch { return true; }
}
function looksLikeStream(res) {
  try { return (res.headers.get('content-type') || '').toLowerCase().includes('event-stream'); } catch { return false; }
}
async function readProviderBody(res) {
  if (!looksLikeJson(res)) return { ok: false };
  const raw = await res.text().catch(() => '');
  if (!raw || !raw.trim()) return { ok: false };
  let data; try { data = JSON.parse(raw); } catch { return { ok: false }; }
  if (!data || typeof data !== 'object') return { ok: false };
  if (data.error || data.success === false) return { ok: false };
  const reply = extractReplyText(data);
  if (!reply.trim()) return { ok: false };
  return { ok: true, data, reply };
}
async function fetchT(url, opts = {}, ms = HF_ATTEMPT_MS, extSignal = null) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, ms);
  if (extSignal) {
    if (extSignal.aborted) { try { ctrl.abort(); } catch {} }
    else extSignal.addEventListener('abort', () => { try { ctrl.abort(); } catch {} });
  }
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

/* ---------- Image intent ---------- */
const GEN_VERBS = '(generate|create|make|draw|design|render|paint|show|give)';
const GEN_NOUNS = '(image|picture|photo|illustration|art|drawing|render|painting|pic)';
const GEN_RE = new RegExp(`\\b${GEN_VERBS}\\b[^.!?]{0,40}?\\b${GEN_NOUNS}\\b\\s*(?:of|showing|with|depicting|featuring|that shows)?\\s*(.+)$`, 'i');
const SHORT_GEN_RE = new RegExp(`^${GEN_VERBS}\\s+${GEN_NOUNS}\\s+(?:of\\s+)?(.+)$`, 'i');
function detectImageIntent(text, files) {
  const t = String(text || '').trim();
  const images = (files || []).filter(f => f && f.type === 'image' && f.dataUrl);
  if (!t) return null;
  if (images.length > 0) return null;
  let m = t.match(GEN_RE) || t.match(SHORT_GEN_RE);
  if (m) {
    const subject = (m[m.length - 1] || '').trim().replace(/^[:\-\s]+/, '').replace(/[.!?]+$/, '');
    if (subject && subject.length > 1) return { mode: 'generate', prompt: subject.slice(0, 400), sourceImage: null };
  }
  return null;
}

/* ---------- DB ---------- */
let db = null, dbReady = false, dbError = null, writeChain = Promise.resolve();
const emptyDb = () => ({ users: {}, apiKeys: {}, logsChat: [], logsImage: [], counters: { chat: 0, image: 0 } });
async function loadDb() {
  if (db) return db;
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    db = Object.assign(emptyDb(), JSON.parse(raw)); dbReady = true;
  } catch (e) {
    if (e.code === 'ENOENT') { db = emptyDb(); dbReady = true; try { await fs.writeFile(DB_FILE, JSON.stringify(db), 'utf8'); } catch {} }
    else { dbError = e.message; db = emptyDb(); dbReady = false; }
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

async function getUser(email) { await loadDb(); const u = db.users[email]; return u ? { ...u } : null; }
async function saveUser(rec) {
  await loadDb();
  if (!rec || !rec.email) return false;
  db.users[rec.email] = {
    email: rec.email, name: rec.name || '', tier: rec.tier || 'free',
    daily_used: rec.daily_used || 0,
    vision_used: rec.vision_used || 0,
    image_used: rec.image_used || 0,
    eclipse_used: rec.eclipse_used || 0,
    daily_reset: rec.daily_reset || today(),
    month_key: rec.month_key || monthKey(),
    keys_this_month: rec.keys_this_month || 0,
    created_at: rec.created_at || now(),
    last_login: rec.last_login || 0,
    persona: rec.persona || null,
    memory: Array.isArray(rec.memory) ? rec.memory : [],
    voice_id: rec.voice_id || null,
  };
  await persist(); return true;
}
async function ensureFreshUser(email) {
  if (!email) return null;
  let rec = await getUser(email);
  if (!rec) {
    rec = { email, name: '', tier: 'free', daily_used: 0, vision_used: 0, image_used: 0, eclipse_used: 0, daily_reset: today(), month_key: monthKey(), keys_this_month: 0, created_at: now(), last_login: 0, persona: null, memory: [], voice_id: null };
    await saveUser(rec); return rec;
  }
  let dirty = false;
  if (rec.daily_reset !== today()) {
    rec.daily_used = 0; rec.vision_used = 0; rec.image_used = 0; rec.eclipse_used = 0;
    rec.daily_reset = today(); dirty = true;
  }
  if (rec.month_key !== monthKey()) { rec.keys_this_month = 0; rec.month_key = monthKey(); dirty = true; }
  if (rec.vision_used === undefined) { rec.vision_used = 0; dirty = true; }
  if (rec.image_used === undefined) { rec.image_used = 0; dirty = true; }
  if (rec.eclipse_used === undefined) { rec.eclipse_used = 0; dirty = true; }
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
function extractToken(req) {
  const h = req.headers || {};
  const authz = safe(h['authorization']).trim();
  if (authz) { const m = authz.match(/^Bearer\s+(.+)$/i); if (m) return m[1].trim(); if (/^mxk_/.test(authz)) return authz; }
  for (const k of ['x-api-key','api-key','x-auth-token','mirox-key','apikey']) if (h[k]) return safe(h[k]).trim();
  if (req.query && req.query.api_key) return safe(req.query.api_key).trim();
  return '';
}
function getSession(req) {
  const token = extractToken(req);
  if (token) { if (token.startsWith('mxk_')) return { apiKey: token }; const s = verifySession(token); if (s && s.uid) return s; }
  const cookie = safe(req.headers.cookie);
  const m = cookie.match(/(?:^|;\s*)mirox_sess=([^;]+)/);
  if (m) { const s = verifySession(decodeURIComponent(m[1])); if (s && s.uid) return s; }
  return {};
}
async function currentUser(req) {
  const s = getSession(req);
  if (s.apiKey) return null;
  if (!s.uid) return null;
  return await ensureFreshUser(s.uid);
}

/* ---------- Identity guard ---------- */
const IDENTITY_GUARD = `IDENTITY LOCKDOWN.

You ARE Mirox {{LABEL}}, built by the OpenSurr team.

- "What model are you?" -> "I'm Mirox {{LABEL}}, built by OpenSurr."
- "Who made you?" -> "I was built by the OpenSurr team."
- Never output: GPT, OpenAI, ChatGPT, DeepSeek, Qwen, Llama, Meta, Anthropic, Claude, Gemini, Google, Mistral, Hugging Face, Pollinations, Ollama, Fish.

Always Mirox {{LABEL}}.`;
const fillGuard = l => IDENTITY_GUARD.replace(/\{\{LABEL\}\}/g, l);

/* ---------- Bridge prompt ---------- */
const BRIDGE_PROMPT = `BRIDGE MODE ACTIVE — You have DIRECT ACCESS to the user's computer.

ENVIRONMENT
You will receive a [Bridge environment] block telling you:
- home: the user's real home directory (e.g. /home/g4mg on Linux, /Users/x on macOS)
- platform: Linux, Darwin, or Windows
- allowed_dirs: paths you may write to

CRITICAL: NEVER assume paths like /Users/me or /home/me exist.
ALWAYS use the exact "home" value from the environment block.

PLANNING (REQUIRED FOR MULTI-FILE PROJECTS)
When building anything with more than one file, FIRST output a plan block:

<bridge-plan>
- path/to/file1.ext
- path/to/file2.ext
- path/to/file3.ext
</bridge-plan>

List EVERY file the project needs. The frontend tracks this list and will remind you
if any are missing. Do NOT say DONE until all planned files exist.

FILE TOOLS — output these tags on their own lines:

1. Write a file:
   <bridge-write path="/home/user/project/app.js">
   console.log("hi");
   </bridge-write>

2. Run a shell command:
   <bridge-exec>cd /home/user/project && npm install</bridge-exec>

3. Read a file:
   <bridge-read path="/home/user/project/app.js"/>

4. List a directory:
   <bridge-list path="/home/user/project/"/>

5. Ask the user a question (max 6 per task):
   <bridge-ask>
   Which framework should I use?
   - React
   - Vue
   - Svelte
   </bridge-ask>

6. Report structured progress (optional, improves the progress bar):
   <bridge-progress step="2" total="5" label="Installing dependencies"/>

RULES (READ CAREFULLY)
1. Use ONLY the real home directory from [Bridge environment]. Never /Users/me.
2. NEVER repeat a command that already succeeded OR failed. If a command fails,
   read the error and try a DIFFERENT approach.
3. Do NOT re-run \`ls\` on the same path twice. Do NOT re-run \`pwd\` twice.
4. You MUST write every file listed in your <bridge-plan> before saying DONE.
5. Announce each action briefly, then output the tag on its own line.
6. After outputting tags, STOP and wait for the results block. It will contain:
   - [Bridge environment]
   - [Bridge progress] files written so far
   - [Bridge results] stdout/stderr/exit codes
7. When ALL planned files are written AND verified with ls/cat, reply with EXACTLY: DONE
8. If the results show a failure, fix it in your NEXT reply with a different command.
9. NEVER paste large code inline in your reply — always use <bridge-write> tags.
10. If the frontend blocks a command as a duplicate, do NOT retry it. Use a new approach.`;

const MIROX_MODELS = {
  'mirox-luna-1.2':    { label: 'Luna',    tagline: 'Fast · warm · free', tier: 'free',     default: true, tokens: 1400, basePrompt: 'You are Luna, warm and helpful. Concise replies. Fenced code blocks for code.' },
  'mirox-gen-1':       { label: 'Gen',     tagline: 'Ultra concise', tier: 'free',     tokens: 1000, basePrompt: 'You are Gen. Ultra-concise. Fenced code blocks for code.' },
  'mirox-pro-5':       { label: 'Pro',     tagline: 'Balanced · deeper', tier: 'pro', tokens: 2000, basePrompt: 'You are Pro. Balanced depth. Fenced code blocks for code.' },
  'mirox-ultra-10':    { label: 'Ultra',   tagline: 'Deep reasoning', tier: 'pro', tokens: 2500, basePrompt: 'You are Ultra. Deep reasoning. Fenced code blocks for code.' },
  'mirox-eclipse-2.0': { label: 'Eclipse', tagline: 'Best quality', tier: 'ultimate', tokens: 3200, basePrompt: 'You are Eclipse. Best quality. Fenced code blocks for code.' },
};

const PLANS = {
  free:     { label: 'Free',     unlimited_chat: true, daily_limit: null, vision_limit: 10,   image_limit: 10,   eclipse_daily_limit: 5,   price_usd: 0,     price_afg: 0,    api_keys_per_month: 2 },
  pro:      { label: 'Pro',      unlimited_chat: true, daily_limit: null, vision_limit: 200,  image_limit: 200,  eclipse_daily_limit: 0,   price_usd: 6.99,  price_afg: 490,  api_keys_per_month: 5 },
  ultimate: { label: 'Ultimate', unlimited_chat: true, daily_limit: null, vision_limit: 2000, image_limit: 2000, eclipse_daily_limit: 999, price_usd: 20.99, price_afg: 1470, api_keys_per_month: 20 },
};
const TIER_RANK = { free: 0, pro: 1, ultimate: 2 };

function buildSystemPrompt(cfg, bridge) {
  let p = fillGuard(cfg.label) + '\n\n---\n\n' + cfg.basePrompt;
  if (bridge && bridge.connected) {
    p += '\n\n---\n\n' + BRIDGE_PROMPT;
    const env = bridge.env || {};
    p += `\n\n[Bridge environment]\n`;
    p += `home=${env.home || '(unknown)'}\n`;
    p += `platform=${env.platform || '(unknown)'}\n`;
    p += `cwd=${env.cwd || '(unknown)'}\n`;
    if (Array.isArray(env.allowed_dirs)) p += `allowed_dirs=${env.allowed_dirs.join(', ')}\n`;
    if (bridge.plannedFiles && bridge.plannedFiles.length) p += `plannedFiles=${bridge.plannedFiles.join(', ')}\n`;
    if (bridge.filesWritten && bridge.filesWritten.length) p += `filesWritten=${bridge.filesWritten.join(', ')}\n`;
    if (bridge.commandsRun) p += `commandsRun=${bridge.commandsRun}\n`;
    p += `Use ONLY these real paths. NEVER invent /Users/me or /home/me.`;
  }
  return p;
}
function injectIdentityGuard(messages, cfg, bridge) {
  const guard = buildSystemPrompt(cfg, bridge);
  if (!Array.isArray(messages) || !messages.length) return [{ role: 'system', content: guard }];
  if (messages[0]?.role === 'system') return [{ role: 'system', content: guard + '\n\n---\n\nUSER SYSTEM:\n' + safe(messages[0].content) }, ...messages.slice(1)];
  return [{ role: 'system', content: guard }, ...messages];
}
function sanitizeMessages(raw) {
  const out = [];
  for (const m of safeArr(raw)) {
    if (!m || typeof m !== 'object') continue;
    const role = safe(m.role, 20);
    if (!['system','user','assistant','tool','function'].includes(role)) continue;
    const c = m.content;
    let content = '';
    if (typeof c === 'string') content = c;
    else if (Array.isArray(c)) content = c.filter(p => p?.type === 'text').map(p => p.text).join('\n');
    else content = safe(c);
    out.push({ role, content });
  }
  return out;
}

/* ---------- Canned ---------- */
const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim();
function cannedResponse(userText, cfg, hasFiles) {
  const t = norm(userText);
  if (!t || t.length > 220 || hasFiles) return null;
  const label = cfg?.label || 'Luna';
  if (/^(hi|hey|hello|yo|sup|hola|good morning|good evening)[!.\s]*$/.test(t)) return `Hey! I'm Mirox ${label}, built by OpenSurr. What can I help you with?`;
  if (/^(thanks|thank you|thx|ty)[!.\s]*$/.test(t)) return `Anytime.`;
  if (/^(bye|goodbye|see ya|take care)[!.\s]*$/.test(t)) return `See you around.`;
  if (/^(ok|okay|k|cool|nice|sure|got it)[!.\s]*$/.test(t)) return `Got it.`;
  if (/^(who|what) (are|r) (you|u)[?!.\s]*$/.test(t)) return `I'm Mirox ${label}, built by the OpenSurr team.`;
  return null;
}

/* ---------- URLs ---------- */
const HF_URL = 'https://router.huggingface.co/v1/chat/completions';
const PL_URL = 'https://gen.pollinations.ai/v1/chat/completions';
const PL_IMG_BASE = 'https://gen.pollinations.ai/image';
const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';
const HF_CHAT_MODELS = ['meta-llama/Llama-3.3-70B-Instruct:together', 'Qwen/Qwen2.5-72B-Instruct:together'];
const PL_CHAT_MODELS = ['openai', 'openai-fast', 'mistral'];
const PL_IMG_MODELS = ['flux', 'turbo'];

async function hfChat(modelId, messages, maxTokens, stream, signal, ms) {
  if (!HF_API_KEY) throw new Error('no_hf');
  const body = { model: modelId, messages, max_tokens: maxTokens, stream: !!stream, temperature: 0.7 };
  const res = await fetchT(HF_URL, { method: 'POST', headers: { Authorization: `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, ms, signal);
  if (!res.ok) throw new Error(`hf_${res.status}`);
  return res;
}
async function plChat(modelId, messages, maxTokens, stream, signal, ms) {
  if (!PL_KEY) throw new Error('no_pl');
  const body = { model: modelId, messages, max_tokens: maxTokens, stream: !!stream, temperature: 0.7 };
  const res = await fetchT(PL_URL, { method: 'POST', headers: { Authorization: `Bearer ${PL_KEY}`, 'Content-Type': 'application/json', 'Accept': stream ? 'text/event-stream' : 'application/json' }, body: JSON.stringify(body) }, ms, signal);
  if (!res.ok) throw new Error(`pl_${res.status}`);
  return res;
}
async function miroxChatChain({ messages, cfg, stream, signal }) {
  if (PROVIDERS.hf) {
    for (const mid of HF_CHAT_MODELS) {
      if (signal?.aborted) throw new Error('aborted');
      try { const res = await hfChat(mid, messages, cfg.tokens, stream, signal, HF_ATTEMPT_MS); return { res, provider: 'hf' }; }
      catch (e) { if (e.name === 'AbortError') throw e; }
    }
  }
  if (PROVIDERS.pl) {
    for (const mid of PL_CHAT_MODELS) {
      if (signal?.aborted) throw new Error('aborted');
      try { const res = await plChat(mid, messages, cfg.tokens, stream, signal, PL_ATTEMPT_MS); return { res, provider: 'pl' }; }
      catch (e) { if (e.name === 'AbortError') throw e; }
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
    const b64 = data?.data?.[0]?.b64_json || data?.b64_json;
    if (typeof b64 === 'string') return `data:image/png;base64,${b64}`;
  } catch {}
  return null;
}
async function generateImage(prompt) {
  const deadline = Date.now() + IMG_TOTAL_MS;
  const left = () => deadline - Date.now();
  for (const mid of PL_IMG_MODELS) {
    if (left() < 3000) break;
    try {
      const params = new URLSearchParams({ model: mid, width: '1024', height: '1024', nologo: 'true', seed: String(Date.now() % 99999) });
      const url = `${PL_IMG_BASE}/${encodeURIComponent(prompt)}?${params.toString()}`;
      const headers = { 'Accept': 'image/png' };
      if (PL_KEY) headers.Authorization = `Bearer ${PL_KEY}`;
      const res = await fetchT(url, { method: 'GET', headers }, Math.min(left() - 1500, 30000));
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
  try { if (res.writableEnded || res.destroyed) return false; res.write('data: ' + JSON.stringify(obj) + '\n\n'); if (res.flush) { try { res.flush(); } catch {} } return true; } catch { return false; }
}
function sseDone(res) { try { res.write('data: [DONE]\n\n'); } catch {} }
function chunkText(n, target) {
  const cps = Array.from(n);
  const size = Math.max(1, Math.ceil(cps.length / Math.max(1, target)));
  const out = [];
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(''));
  return out;
}

async function fishTTS(text, voiceId) {
  if (!F_API) throw new Error('no_f_api');
  const clean = String(text || '').trim();
  if (!clean) throw new Error('empty');
  const body = { text: clean.slice(0, 2000), format: 'mp3', mp3_bitrate: 128, chunk_length: 200, normalize: true };
  if (voiceId) body.reference_id = voiceId;
  const res = await fetchT(FISH_TTS_URL, { method: 'POST', headers: { 'Authorization': `Bearer ${F_API}`, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' }, body: JSON.stringify(body) }, TTS_TOTAL_MS);
  if (!res.ok) throw new Error(`fish_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 100) throw new Error('empty_audio');
  return buf;
}

/* ---------- App ---------- */
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '30mb' }));
try { app.use(express.static(path.join(__dirname, '../public'))); } catch {}
app.use(async (req, res, next) => { try { await loadDb(); } catch {} next(); });

app.get(['/api/health','/health','/ping'], (req, res) => {
  res.json({ ok: true, app: 'MiroxAI', version: 'v81', providers: PROVIDERS, time: now() });
});

app.post('/api/tts', async (req, res) => {
  try {
    if (!F_API) return res.status(503).json({ ok: false, error: 'F_API missing' });
    const text = safe(req.body?.text, 5000).trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });
    const buf = await fishTTS(text, safe(req.body?.voice, 128) || null);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(buf.byteLength));
    res.send(buf);
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
app.get('/api/voices', async (req, res) => res.json({ ok: true, voices: [] }));

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
    const readme = `# MiroxAI Bridge\n\nInstall: pip install aiohttp\nRun: python runner.py\n`;
    const runner = `#!/usr/bin/env python3
import os, sys, json, time, subprocess, platform
from pathlib import Path
try:
    from aiohttp import web
except ImportError:
    print("Install: pip install aiohttp"); sys.exit(1)

CONFIG_FILE = Path(__file__).parent / "config.json"
CONFIG = json.load(open(CONFIG_FILE, encoding="utf-8")) if CONFIG_FILE.exists() else {"bridge_name": "My Laptop", "port": 8765, "allowed_dirs": ["~"], "max_output_bytes": 200000}
PORT = int(CONFIG.get("port", 8765))
NAME = CONFIG.get("bridge_name", "My Laptop")
ALLOWED_DIRS = [Path(p).expanduser().resolve() for p in CONFIG.get("allowed_dirs", ["~"])]
MAX_OUTPUT = CONFIG.get("max_output_bytes", 200000)

def is_path_allowed(p):
    try: p = p.expanduser().resolve()
    except: return False
    for base in ALLOWED_DIRS:
        try: p.relative_to(base); return True
        except: pass
    return False

def safe_path(raw):
    p = Path(raw).expanduser()
    if not p.is_absolute(): p = Path.cwd() / p
    try: p = p.resolve()
    except: return None
    return p if is_path_allowed(p) else None

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
    resp.headers["Access-Control-Max-Age"] = "86400"
    return resp

async def ping(req):
    return web.json_response({"ok": True, "name": NAME, "cwd": os.getcwd(), "time": time.time()})

async def env_info(req):
    home = str(Path.home())
    return web.json_response({"ok": True, "name": NAME, "home": home, "cwd": os.getcwd(), "platform": platform.system(), "platform_release": platform.release(), "python": platform.python_version(), "allowed_dirs": [str(d) for d in ALLOWED_DIRS], "separator": os.sep, "time": time.time()})

async def exec_cmd(req):
    try: data = await req.json()
    except: return web.json_response({"ok": False, "error": "bad json"})
    cmd = str(data.get("command", "")).strip()
    if not cmd: return web.json_response({"ok": False, "error": "no command"})
    cwd_path = safe_path(data.get("cwd") or str(Path.home())) or Path.home()
    print(f"[Bridge] exec: {cmd[:120]}")
    try:
        p = subprocess.run(cmd, shell=True, cwd=str(cwd_path), capture_output=True, text=True, timeout=int(data.get("timeout", 120)))
        return web.json_response({"ok": True, "exit_code": p.returncode, "stdout": (p.stdout or "")[:MAX_OUTPUT], "stderr": (p.stderr or "")[:MAX_OUTPUT], "cwd": str(cwd_path)})
    except subprocess.TimeoutExpired: return web.json_response({"ok": False, "error": "timeout"})
    except Exception as e: return web.json_response({"ok": False, "error": str(e)})

async def write_file(req):
    try: data = await req.json()
    except: return web.json_response({"ok": False, "error": "bad json"})
    p = safe_path(data.get("path", ""))
    if not p: return web.json_response({"ok": False, "error": "path not allowed"})
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        content = data.get("content", "")
        p.write_text(content, encoding="utf-8")
        print(f"[Bridge] wrote: {p}")
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
    p = safe_path(data.get("path", "."))
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
    print(f"[Bridge] Starting '{NAME}' on http://127.0.0.1:{PORT}")
    print(f"[Bridge] Home directory: {Path.home()}")
    print(f"[Bridge] Platform: {platform.system()} {platform.release()}")
    print(f"[Bridge] Health: http://localhost:{PORT}/ping")
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
  const models = Object.entries(MIROX_MODELS).map(([id, m]) => ({ id, label: m.label, tagline: m.tagline, tier: m.tier, default: !!m.default }));
  res.json({ app: { name: 'MiroxAI', version: 'v81' }, models, default_model: models[0].id, plans: PLANS, tts_available: !!F_API });
});

/* ---------- Auth ---------- */
app.post(['/api/auth/simple-login','/auth/simple-login'], async (req, res) => {
  try {
    const { name, email } = req.body || {};
    const n = safe(name, 60).trim();
    const e = safe(email, 120).trim().toLowerCase();
    if (!n || !e || !e.includes('@')) return res.status(400).json({ ok: false, error: 'Valid name and email required' });
    let rec = await getUser(e);
    if (!rec) rec = { email: e, name: n, tier: 'free' };
    rec.name = n; rec.last_login = now();
    await saveUser(rec);
    const token = setSession(res, { uid: e, name: n, tier: rec.tier });
    res.json({ ok: true, token, user: { id: e, email: e, name: n, tier: rec.tier } });
  } catch { res.status(500).json({ ok: false, error: 'Login failed' }); }
});
app.post(['/api/logout','/logout'], (req, res) => { clearSession(res); res.json({ ok: true }); });

app.get(['/api/me','/me'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const u = await currentUser(req);
    if (!u) return res.json({ user: null });
    const plan = PLANS[u.tier] || PLANS.free;
    res.json({
      user: {
        id: u.email, email: u.email, name: u.name, tier: u.tier,
        daily_limit: plan.unlimited_chat ? null : plan.daily_limit,
        daily_used: u.daily_used || 0,
        unlimited_chat: !!plan.unlimited_chat,
        vision_limit: plan.vision_limit, vision_used: u.vision_used || 0,
        image_limit: plan.image_limit, image_used: u.image_used || 0,
        eclipse_limit: plan.eclipse_daily_limit, eclipse_used: u.eclipse_used || 0,
      }
    });
  } catch { res.json({ user: null }); }
});

app.get(['/api/subscription/plans','/subscription/plans'], (req, res) => {
  const perks = {
    free: ['Luna & Gen — unlimited, free', '10 image uploads / day', '10 image generations / day', '5 Eclipse messages / day', '2 API keys / month'],
    pro: ['Pro & Ultra models', 'Unlimited chat', '200 image uploads + generations / day', '5 API keys / month'],
    ultimate: ['Eclipse — best model', 'Unlimited everything', '2000 image uploads + generations / day', '20 API keys / month'],
  };
  const out = Object.entries(PLANS).map(([id, p]) => ({
    id, label: p.label,
    tagline: { free: 'Free forever', pro: 'Most popular', ultimate: 'Power users' }[id],
    unlimited_chat: !!p.unlimited_chat,
    vision_limit: p.vision_limit, image_limit: p.image_limit, eclipse_limit: p.eclipse_daily_limit,
    price_usd: p.price_usd, price_afg: p.price_afg,
    perks: perks[id],
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

/* ---------- Image gen endpoint ---------- */
app.post('/v1/images/generations', async (req, res) => {
  try {
    const prompt = safe(req.body?.prompt, 2000).trim();
    if (!prompt) return res.status(400).json({ error: { message: 'Prompt required' } });
    const u = await currentUser(req);
    const plan = u ? (PLANS[u.tier] || PLANS.free) : PLANS.free;
    if (u && u.tier === 'free' && (u.image_used || 0) >= plan.image_limit) {
      return res.status(429).json({ error: { message: `Daily image limit reached (${plan.image_limit}/day). Refills tomorrow.`, code: 'image_limit_reached' } });
    }
    const imageUrl = await generateImage(prompt);
    if (u) {
      u.image_used = (u.image_used || 0) + 1;
      try { await saveUser(u); } catch {}
    }
    res.json({ ok: true, image: imageUrl });
  } catch { res.status(502).json({ error: { message: GENERIC_ERR } }); }
});

/* ---------- Chat completions ---------- */
app.post('/v1/chat/completions', async (req, res) => {
  const t0 = Date.now();
  const abortCtrl = new AbortController();
  let clientClosed = false;
  req.on('close', () => { clientClosed = true; try { abortCtrl.abort(); } catch {} });

  try {
    const body = req.body || {};
    const stream = body.stream === true || (req.headers.accept || '').includes('text/event-stream');
    const rawMessage = body.message;
    const rawHistory = body.history;
    const rawFiles = body.files;
    const requestedModel = safe(body.model, 64) || 'mirox-luna-1.2';
    const userVoice = safe(body.voice_id, 128).trim() || null;
    const wantTts = body.tts === true;
    const bridge = body.bridge || null;

    let u = null; try { u = await currentUser(req); } catch {}
    const cfg = MIROX_MODELS[requestedModel];
    if (!cfg) return res.status(404).json({ error: { message: 'Model not found.' } });

    const tier = u?.tier || 'free';
    const plan = PLANS[tier] || PLANS.free;

    const isUnlimitedModel = cfg.tier === 'free';
    if (!isUnlimitedModel) {
      if (cfg.tier === 'pro' && TIER_RANK[tier] < 1) {
        return res.status(403).json({ error: { message: 'Pro model requires Pro plan.', code: 'plan_required' } });
      }
      if (cfg.tier === 'ultimate' && tier !== 'ultimate') {
        if (tier === 'free') {
          const used = u?.eclipse_used || 0;
          if (used >= plan.eclipse_daily_limit) {
            return res.status(429).json({ error: { message: `Eclipse daily limit reached (${plan.eclipse_daily_limit}/day).`, code: 'eclipse_limit_reached' } });
          }
        } else {
          return res.status(403).json({ error: { message: 'Eclipse requires Ultimate plan.', code: 'plan_required' } });
        }
      }
    }

    const text = safe(rawMessage, 100000).trim();
    const files = safeArr(rawFiles);
    if (!text && !files.length) return res.status(400).json({ error: { message: 'Empty message' } });

    const sys = buildSystemPrompt(cfg, bridge) + (u?.persona ? `\n\nUser preference: ${safe(u.persona, 500)}` : '');
    const msgs = [{ role: 'system', content: sys }];

    const textFiles = files.filter(f => f && f.type === 'text');
    const imageFiles = files.filter(f => f && f.type === 'image' && f.dataUrl);

    if (u && u.tier === 'free' && imageFiles.length > 0) {
      const remaining = plan.vision_limit - (u.vision_used || 0);
      if (remaining <= 0) return res.status(429).json({ error: { message: `Daily image upload limit reached (${plan.vision_limit}/day).`, code: 'vision_limit_reached' } });
      if (imageFiles.length > remaining) return res.status(429).json({ error: { message: `Only ${remaining} image upload(s) remaining today.`, code: 'vision_limit_reached' } });
    }

    let userText = text;
    if (textFiles.length) {
      const fileText = textFiles.map(f => `[File: ${safe(f.name, 200)}]\n\`\`\`\n${safe(f.content, 8000)}\n\`\`\``).join('\n\n');
      userText = (fileText + '\n\n' + (text || '')).trim();
    }
    if (imageFiles.length) {
      msgs.push({ role: 'user', content: `[User attached ${imageFiles.length} image(s)]\n\n${userText || ''}`.trim() });
    } else {
      msgs.push({ role: 'user', content: userText || '(empty)' });
    }
    for (const h of safeArr(rawHistory).slice(-14)) {
      const role = safe(h.role, 20); const txt = safe(h.content, 4000).trim();
      if ((role === 'user' || role === 'assistant') && txt) msgs.push({ role, content: txt });
    }

    const imgIntent = detectImageIntent(text, files);

    const updateUsage = async (extraImageGen = false) => {
      if (u && u.email) {
        u.daily_used = (u.daily_used || 0) + 1;
        if (imageFiles.length > 0) u.vision_used = (u.vision_used || 0) + imageFiles.length;
        if (extraImageGen) u.image_used = (u.image_used || 0) + 1;
        if (requestedModel === 'mirox-eclipse-2.0') u.eclipse_used = (u.eclipse_used || 0) + 1;
        try { await saveUser(u); } catch {}
      }
    };

    if (!stream) {
      try {
        if (imgIntent) {
          const dataUrl = await generateImage(imgIntent.prompt);
          await updateUsage(true);
          const reply = `Here's your generated image.`;
          return res.json({ id: 'chatcmpl-' + Date.now(), object: 'chat.completion', created: now(), model: cfg.label, choices: [{ index: 0, message: { role: 'assistant', content: reply, image: dataUrl }, finish_reason: 'stop' }], image: dataUrl, reply, _ms: Date.now() - t0 });
        }
        const result = await miroxChatChain({ messages: msgs, cfg, stream: false, signal: abortCtrl.signal });
        const parsed = await readProviderBody(result.res);
        if (!parsed.ok) return res.status(502).json({ error: { message: GENERIC_ERR } });
        await updateUsage();
        return res.json({ id: 'chatcmpl-' + Date.now(), object: 'chat.completion', created: now(), model: cfg.label, choices: [{ index: 0, message: { role: 'assistant', content: parsed.reply }, finish_reason: 'stop' }], reply: parsed.reply, _ms: Date.now() - t0 });
      } catch { return res.status(502).json({ error: { message: GENERIC_ERR } }); }
    }

    sseInit(res);
    let streamEnded = false;
    const guard = setTimeout(() => { if (streamEnded || res.writableEnded) return; try { sseWrite(res, { done: true }); } catch {} try { sseDone(res); } catch {} try { res.end(); } catch {} streamEnded = true; }, 240000);

    let fullReplyText = '';
    let finishReason = 'stop';

    try {
      if (imgIntent) {
        sseWrite(res, { p: 'image' });
        sseWrite(res, { status: 'Drawing it…' });
        let dataUrl = null;
        try { dataUrl = await generateImage(imgIntent.prompt); }
        catch { sseWrite(res, { d: 'Image generation failed.' }); sseWrite(res, { done: true }); sseDone(res); clearTimeout(guard); try { res.end(); } catch {} return; }

        if (dataUrl) sseWrite(res, { img: dataUrl, imgAlt: imgIntent.prompt.slice(0, 100) });
        fullReplyText = `Here's your image.`;
        for (const piece of chunkText(fullReplyText, 30)) { if (clientClosed || res.writableEnded) break; sseWrite(res, { d: piece }); await new Promise(r => setTimeout(r, 15)); }
        if (!clientClosed && !res.writableEnded) { sseWrite(res, { done: true, finish_reason: 'stop' }); sseDone(res); }
        await updateUsage(true);
        clearTimeout(guard); streamEnded = true;
        try { if (!res.writableEnded) res.end(); } catch {}
        return;
      }

      const canned = cannedResponse(text, cfg, files.length > 0);
      if (canned) {
        sseWrite(res, { p: 'canned' });
        for (const piece of chunkText(canned, 20)) { if (res.writableEnded) break; sseWrite(res, { d: piece }); fullReplyText += piece; await new Promise(r => setTimeout(r, 12)); }
        sseWrite(res, { done: true, finish_reason: 'stop' });
        sseDone(res);
        try { res.end(); } catch {}
        await updateUsage(); clearTimeout(guard); streamEnded = true;
        return;
      }

      const result = await miroxChatChain({ messages: msgs, cfg, stream: true, signal: abortCtrl.signal });

      if (result.provider === 'pl' && looksLikeStream(result.res)) {
        sseWrite(res, { p: 'pl' });
        const reader = result.res.body.getReader(); const dec = new TextDecoder('utf-8', { fatal: false });
        let buf = '';
        while (true) {
          if (clientClosed || res.writableEnded) break;
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            let line = buf.slice(0, idx); buf = buf.slice(idx + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const raw = trimmed.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let o; try { o = JSON.parse(raw); } catch { continue; }
            const delta = o.choices?.[0]?.delta;
            if (delta?.content) { fullReplyText += delta.content; sseWrite(res, { d: delta.content }); }
            const fr = o.choices?.[0]?.finish_reason;
            if (fr) finishReason = fr;
          }
        }
        try { reader.releaseLock(); } catch {}
      } else {
        sseWrite(res, { p: 'hf' });
        const reader = result.res.body.getReader(); const dec = new TextDecoder('utf-8', { fatal: false });
        let buf = '';
        while (true) {
          if (clientClosed || res.writableEnded) break;
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            let line = buf.slice(0, idx); buf = buf.slice(idx + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const raw = trimmed.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let o; try { o = JSON.parse(raw); } catch { continue; }
            const delta = o.choices?.[0]?.delta;
            if (delta?.content) { fullReplyText += delta.content; sseWrite(res, { d: delta.content }); }
            const fr = o.choices?.[0]?.finish_reason;
            if (fr) finishReason = fr;
          }
        }
        try { reader.releaseLock(); } catch {}
      }

      if (!clientClosed && !res.writableEnded) { sseWrite(res, { done: true, finish_reason: finishReason }); sseDone(res); }
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
    if (err) res.json({ ok: true, app: 'MiroxAI', message: 'Backend is running. Public folder missing.', hint: 'Add public/index.html, public/style.css, public/script.js.' });
  });
});

(async () => {
  try { await loadDb(); } catch (e) { console.warn('[boot]', e.message); }
  if (process.env.VERCEL !== '1') {
    app.listen(PORT, () => console.log('[Mirox] Server at http://localhost:' + PORT));
  }
})();

export default app;

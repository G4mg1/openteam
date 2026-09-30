/* ============================================================
   MiroxAI Backend v23 — Bulletproof
   Never crashes on cold start. Always returns JSON.
   ============================================================ */

/* ---------- Safe module loading ---------- */
let express, crypto, firebaseAdmin;
const loadErrors = [];

try { express = require('express'); } catch (e) { loadErrors.push('express: ' + e.message); }
try { crypto = require('crypto'); } catch (e) { loadErrors.push('crypto: ' + e.message); }
try { firebaseAdmin = require('firebase-admin'); } catch (e) { firebaseAdmin = null; }

if (!express || !crypto) {
  module.exports = (req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: false,
      error: 'Backend missing required modules',
      details: loadErrors,
      fix: 'Add express and firebase-admin to package.json dependencies, then redeploy.',
    }));
  };
  return;
}

/* ---------- Config ---------- */
const HF_API_KEY = (process.env.HF_API_KEY || '').trim();
const SECRET = process.env.SECRET_KEY || 'mirox-fallback-secret-change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '2010';
const FIREBASE_URL = 'https://miroxdata-default-rtdb.europe-west1.firebasedatabase.app/';

/* ---------- Firebase (fully optional, never blocks boot) ---------- */
let fdb = null;
let firebaseErr = null;
try {
  if (firebaseAdmin && !firebaseAdmin.apps.length) {
    let credential = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString());
        credential = firebaseAdmin.credential.cert(sa);
      } catch (e) { firebaseErr = 'Service account parse failed: ' + e.message; }
    } else {
      try { credential = firebaseAdmin.credential.applicationDefault(); } catch { firebaseErr = 'No credentials in env'; }
    }
    if (credential) {
      firebaseAdmin.initializeApp({ databaseURL: FIREBASE_URL, credential });
      fdb = firebaseAdmin.database();
    }
  } else if (firebaseAdmin && firebaseAdmin.apps.length) {
    fdb = firebaseAdmin.database();
  }
} catch (e) {
  firebaseErr = e.message;
  fdb = null;
}

/* ---------- App ---------- */
const app = express();
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

/* ---------- Helpers ---------- */
const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);

function signSession(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
function verifySession(token) {
  if (!token) return {};
  const parts = String(token).split('.');
  if (parts.length !== 2) return {};
  const sig = crypto.createHmac('sha256', SECRET).update(parts[0]).digest('base64url');
  if (sig !== parts[1]) return {};
  try { return JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { return {}; }
}
function getSession(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const s = verifySession(auth.slice(7).trim());
    if (s?.uid) return s;
  }
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)mirox_sess=([^;]+)/);
  if (!m) return {};
  return verifySession(decodeURIComponent(m[1]));
}
function setSession(res, data) {
  const token = signSession(data);
  const secure = process.env.VERCEL === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `mirox_sess=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${secure}`);
  return token;
}
function clearSession(res) {
  res.setHeader('Set-Cookie', 'mirox_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

async function safeFdbGet(path) {
  if (!fdb) return null;
  try { const s = await fdb.ref(path).once('value'); return s.exists() ? s.val() : null; } catch { return null; }
}
async function safeFdbUpdate(path, data) {
  if (!fdb) return false;
  try { await fdb.ref(path).update(data); return true; } catch { return false; }
}
async function safeFdbSet(path, data) {
  if (!fdb) return false;
  try { await fdb.ref(path).set(data); return true; } catch { return false; }
}
async function safeFdbPush(path, data) {
  if (!fdb) return null;
  try { const r = fdb.ref(path).push(); await r.set({ ...data, _ts: now() }); return r.key; } catch { return null; }
}

/* ---------- Models — Luna first, 7B for speed ---------- */
const MODELS = {
  'mirox-luna-1.2': {
    label: 'Luna', tagline: 'Fast · warm · free', tier: 'free', default: true, tokens: 700,
    prompt: 'You are Luna, a warm assistant by OpenSurr. Keep replies concise. Use fenced code blocks with the language name.',
  },
  'mirox-gen-1': {
    label: 'Gen', tagline: 'Ultra concise', tier: 'free', tokens: 500,
    prompt: 'You are Gen from OpenSurr. Ultra-concise. Code only inside fenced blocks with the language name.',
  },
  'mirox-pro-5': { label: 'Pro', tagline: 'Balanced', tier: 'pro', tokens: 900, prompt: 'You are Pro from OpenSurr. Balanced depth.' },
  'mirox-ultra-10': { label: 'Ultra', tagline: 'Deep reasoning', tier: 'pro', tokens: 1100, prompt: 'You are Ultra from OpenSurr. Deep reasoning.' },
  'mirox-eclipse-2.0': { label: 'Eclipse', tagline: 'Best quality', tier: 'ultimate', tokens: 1300, prompt: 'You are Eclipse from OpenSurr. Best quality.' },
};
const API_ALLOWED_MODELS = ['mirox-luna-1.2', 'mirox-gen-1'];

const PLANS = {
  free: { label: 'Free', daily_limit: 50, ultimate_trial_limit: 10, price_robux: 0 },
  pro: { label: 'Pro', daily_limit: 500, ultimate_trial_limit: 0, price_robux: 250 },
  ultimate: { label: 'Ultimate', daily_limit: 5000, ultimate_trial_limit: 0, price_robux: 1200 },
};
const TIER_RANK = { free: 0, pro: 1, ultimate: 2 };

/* ---------- User helpers ---------- */
async function getUserRecord(email) { return await safeFdbGet(`users/${email}`); }
async function saveUserRecord(rec) { if (!rec?.email) return false; return await safeFdbUpdate(`users/${rec.email}`, rec); }
async function ensureFreshUser(email) {
  if (!email) return null;
  let rec = await getUserRecord(email);
  if (!rec) {
    rec = { email, name: '', tier: 'free', daily_used: 0, trial_used: 0, daily_reset: today(), eclipse_credits: 10, eclipse_reset: null, created_at: now() };
    await saveUserRecord(rec);
    return rec;
  }
  let dirty = false;
  if (rec.daily_reset !== today()) { rec.daily_used = 0; rec.trial_used = 0; rec.daily_reset = today(); dirty = true; }
  if (rec.eclipse_reset && rec.eclipse_reset < Date.now()) { rec.eclipse_credits = 10; rec.eclipse_reset = null; dirty = true; }
  if (dirty) await saveUserRecord(rec);
  return rec;
}
async function currentUser(req) {
  const s = getSession(req);
  if (!s.uid) return null;
  return await ensureFreshUser(s.uid);
}

/* ---------- Hugging Face — 7B for fast, reliable responses ---------- */
const HF_CHAT = 'https://router.huggingface.co/v1/chat/completions';
const HF_IMAGE = 'https://router.huggingface.co/fal-ai/fal-ai/flux/schnell';
const HF_MODEL = 'Qwen/Qwen2.5-7B-Instruct';

async function hfChat(messages, maxTokens, stream = false, signal) {
  const res = await fetch(HF_CHAT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: HF_MODEL, messages, max_tokens: maxTokens, stream, temperature: 0.7 }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let errMsg = `HF ${res.status}`;
    try {
      const j = JSON.parse(text);
      errMsg = j.error?.message || j.error || j.message || errMsg;
    } catch { if (text) errMsg = text.slice(0, 200); }
    throw new Error(errMsg);
  }
  return res;
}

async function hfImage(prompt, aspectRatio = '1:1') {
  const sizeMap = { '1:1': '1024x1024', '16:9': '1344x768', '9:16': '768x1344', '4:3': '1152x864' };
  const res = await fetch(HF_IMAGE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image_size: sizeMap[aspectRatio] || '1024x1024', num_inference_steps: 4 }),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`HF image ${res.status}: ${t.slice(0, 150)}`); }
  const data = await res.json();
  return data.images?.[0]?.url || data.url || null;
}

/* ---------- Message builder ---------- */
function buildMessages(systemPrompt, history, userText, persona, mem, files) {
  let sys = systemPrompt || '';
  if (persona) sys += `\n\nUser preference: ${persona}`;
  if (mem?.length) sys += `\n\nRemember: ${mem.slice(-8).map(m => m.text).join(' | ')}`;
  const msgs = [{ role: 'system', content: sys }];

  const textFiles = (files || []).filter(f => f.type !== 'image');
  const imageFiles = (files || []).filter(f => f.type === 'image' && f.dataUrl);

  let textPart = userText || '';
  if (textFiles.length) {
    const fileText = textFiles.map(f => `[Attached: ${f.name}]\n\`\`\`\n${String(f.content || '').slice(0, 6000)}\n\`\`\``).join('\n\n');
    textPart = (fileText + '\n\n' + (userText || '')).trim();
  }

  if (imageFiles.length) {
    const content = [{ type: 'text', text: textPart || 'Look at the image(s).' }];
    for (const img of imageFiles) content.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    msgs.push({ role: 'user', content });
  } else {
    msgs.push({ role: 'user', content: textPart || '(empty)' });
  }

  for (const h of (history || []).slice(-14)) {
    const role = h.role, txt = String(h.content || '').trim().slice(0, 4000);
    if ((role === 'user' || role === 'assistant') && txt) msgs.push({ role, content: txt });
  }
  return msgs;
}

/* ============ ROUTES ============ */

app.get(['/api/health', '/health', '/ping'], (req, res) => {
  res.json({
    ok: true,
    app: 'MiroxAI',
    version: 'v23',
    hf_key: !!HF_API_KEY,
    hf_key_length: HF_API_KEY.length,
    firebase: !!fdb,
    firebase_error: firebaseErr,
    admin_password_set: ADMIN_PASSWORD !== '2010',
    node: process.version,
    env: process.env.VERCEL ? 'vercel' : 'local',
    time: now(),
  });
});

app.get(['/api/debug', '/debug'], async (req, res) => {
  const checks = {
    env_hf_key: !!HF_API_KEY,
    env_secret: !!process.env.SECRET_KEY,
    env_admin_password: !!process.env.ADMIN_PASSWORD,
    env_firebase: !!process.env.FIREBASE_SERVICE_ACCOUNT,
    firebase_connected: !!fdb,
    firebase_error: firebaseErr,
    load_errors: loadErrors,
  };
  let testWrite = null;
  if (fdb) {
    try { await fdb.ref('_debug/ping').set({ ts: now() }); testWrite = 'ok'; }
    catch (e) { testWrite = 'failed: ' + e.message; }
  }
  res.json({ ok: true, checks, firebase_write: testWrite });
});

app.get(['/api/config', '/config'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  let u = null;
  try { u = await currentUser(req); } catch {}
  const modelsArr = Object.entries(MODELS).map(([id, m]) => ({
    id, label: m.label, tagline: m.tagline, tier: m.tier, default: !!m.default,
  }));
  res.json({
    app: { name: 'MiroxAI', made_by: 'OpenSurr', version: 'v23' },
    models: modelsArr,
    default_model: modelsArr[0].id,
    plans: PLANS,
    user_tier: u ? u.tier : 'free',
    guest: !u,
    hf_ready: !!HF_API_KEY,
  });
});

/* ---------- Auth ---------- */
app.post(['/api/auth/simple-login', '/auth/simple-login'], async (req, res) => {
  try {
    const { name, email } = req.body || {};
    const n = String(name || '').trim().slice(0, 60);
    const e = String(email || '').trim().toLowerCase().slice(0, 120);
    if (!n || !e || !e.includes('@') || !e.split('@')[1].includes('.')) {
      return res.status(400).json({ ok: false, error: 'Valid name and email required' });
    }
    let rec = await getUserRecord(e);
    const existing = !!rec;
    if (!rec) {
      rec = { email: e, name: n, tier: 'free', daily_used: 0, trial_used: 0, daily_reset: today(), eclipse_credits: 10, eclipse_reset: null, created_at: now() };
    } else {
      rec.name = n;
    }
    rec.last_login = now();
    await saveUserRecord(rec);
    const token = setSession(res, { uid: e, name: n, tier: rec.tier });
    if (fdb) safeFdbPush(`logs/user/${e}`, { event: existing ? 'signin' : 'signup', name: n, ts: now() });
    res.json({ ok: true, token, user: { id: e, email: e, name: n, tier: rec.tier } });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Login failed: ' + e.message });
  }
});

app.post(['/api/logout', '/logout'], (req, res) => { clearSession(res); res.json({ ok: true }); });

app.get(['/api/me', '/me'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const u = await currentUser(req);
    if (!u) return res.json({ user: null });
    res.json({ user: { id: u.email, email: u.email, name: u.name, tier: u.tier } });
  } catch { res.json({ user: null }); }
});

/* ---------- Plans ---------- */
app.get(['/api/subscription/plans', '/subscription/plans'], (req, res) => {
  const perks = {
    free: ['Luna & Gen — free', 'Vision + web search', '10 Eclipse chats/day', 'Memory & persona'],
    pro: ['Pro & Ultra models', '500 msgs/day', 'FLUX image gen', 'Priority speed'],
    ultimate: ['Eclipse — best', '5000 msgs/day', 'Everything in Pro', 'Ultimate badge'],
  };
  const out = Object.entries(PLANS).map(([id, p]) => ({
    id, label: p.label,
    tagline: { free: 'Free forever', pro: 'Most popular', ultimate: 'Power users' }[id],
    daily_limit: p.daily_limit, price_robux: p.price_robux, perks: perks[id],
  }));
  res.json({ ok: true, plans: out });
});

/* ============ CHAT COMPLETIONS ============ */
app.post('/v1/chat/completions', async (req, res) => {
  try {
    if (!HF_API_KEY) {
      return res.status(503).json({ ok: false, error: 'HF_API_KEY not set. Add it in Vercel → Settings → Environment Variables, then redeploy.' });
    }

    const { model, messages, stream = false, temperature, message, history, files } = req.body || {};
    let u = null;
    try { u = await currentUser(req); } catch {}

    const apiKey = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const isApiCall = apiKey && apiKey.startsWith('mxk_');

    let msgs;
    if (messages && Array.isArray(messages)) {
      msgs = messages;
    } else {
      const msg = String(message || '').trim();
      if (!msg && !files?.length) return res.status(400).json({ ok: false, error: 'Empty message' });
      const systemMsg = MODELS[model]?.prompt || MODELS['mirox-luna-1.2'].prompt;
      msgs = buildMessages(systemMsg, history, msg, u?.persona, u?.memory, files || []);
    }

    const requestedModel = model || 'mirox-luna-1.2';
    if (isApiCall && !API_ALLOWED_MODELS.includes(requestedModel)) {
      return res.status(403).json({ ok: false, error: `Model "${requestedModel}" not available via API. Use mirox-luna-1.2 or mirox-gen-1.` });
    }

    const cfg = MODELS[requestedModel] || MODELS['mirox-luna-1.2'];
    const userTier = u ? u.tier : 'free';
    let effectiveCfg = cfg, switched = false, usingTrial = false;

    if (TIER_RANK[cfg.tier] > TIER_RANK[userTier]) {
      if (userTier === 'free' && cfg.tier === 'ultimate') {
        const tl = PLANS.free.ultimate_trial_limit || 0;
        const tu = u ? (u.trial_used || 0) : 0;
        if (tu >= tl) { effectiveCfg = MODELS['mirox-luna-1.2']; switched = true; }
        else usingTrial = true;
      } else { effectiveCfg = MODELS['mirox-luna-1.2']; switched = true; }
    }
    if (requestedModel === 'mirox-eclipse-2.0' && u) {
      if ((u.eclipse_credits ?? 10) <= 0) { effectiveCfg = MODELS['mirox-luna-1.2']; switched = true; }
    }
    if (u) {
      const plan = PLANS[u.tier];
      if ((u.daily_used || 0) >= plan.daily_limit) {
        return res.status(429).json({ ok: false, error: `Daily limit reached (${plan.daily_limit}/day).`, limit_reached: true });
      }
    }
    if (fdb && u) {
      safeFdbPush(`logs/chat/${u.email}`, { model: effectiveCfg.label, message: String(message || msgs[msgs.length - 1]?.content || '').slice(0, 1000), ts: now() });
    }

    if (!stream) {
      try {
        const hfRes = await hfChat(msgs, effectiveCfg.tokens, false);
        const data = await hfRes.json();
        const reply = data.choices?.[0]?.message?.content || '';

        if (u && !isApiCall) {
          u.daily_used = (u.daily_used || 0) + 1;
          if (usingTrial) u.trial_used = (u.trial_used || 0) + 1;
          if (requestedModel === 'mirox-eclipse-2.0') {
            u.eclipse_credits = (u.eclipse_credits ?? 10) - 1;
            if (u.eclipse_credits <= 0) u.eclipse_reset = Date.now() + 24 * 60 * 60 * 1000;
          }
          await saveUserRecord(u);
        }
        return res.json({
          ok: true, reply, model: effectiveCfg.label, switched,
          switched_from: switched ? cfg.label : null, using_trial: usingTrial,
          daily_used: u ? (u.daily_used || 0) : 0,
          daily_remaining: u ? Math.max(0, PLANS[u.tier].daily_limit - (u.daily_used || 0)) : 0,
          eclipse_credits: u ? (u.eclipse_credits ?? 10) : 10,
        });
      } catch (e) {
        return res.status(502).json({ ok: false, error: 'AI error: ' + String(e.message).slice(0, 200) });
      }
    }

    /* Streaming */
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();

    const abortCtrl = new AbortController();
    req.on('close', () => { try { abortCtrl.abort(); } catch {} });

    try {
      const hfRes = await hfChat(msgs, effectiveCfg.tokens, true, abortCtrl.signal);
      const reader = hfRes.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const pl = line.slice(5).trim();
          if (!pl || pl === '[DONE]') continue;
          try {
            const o = JSON.parse(pl);
            const d = o.choices?.[0]?.delta?.content;
            if (d) res.write(`data: ${JSON.stringify({ d })}\n\n`);
          } catch {}
        }
      }

      if (u && !isApiCall) {
        u.daily_used = (u.daily_used || 0) + 1;
        if (usingTrial) u.trial_used = (u.trial_used || 0) + 1;
        if (requestedModel === 'mirox-eclipse-2.0') {
          u.eclipse_credits = (u.eclipse_credits ?? 10) - 1;
          if (u.eclipse_credits <= 0) u.eclipse_reset = Date.now() + 24 * 60 * 60 * 1000;
        }
        await saveUserRecord(u);
      }

      res.write(`data: ${JSON.stringify({
        done: true, model: effectiveCfg.label, switched,
        switched_from: switched ? cfg.label : null, using_trial: usingTrial,
        daily_used: u ? (u.daily_used || 0) : 0,
        daily_remaining: u ? Math.max(0, PLANS[u.tier].daily_limit - (u.daily_used || 0)) : 0,
        eclipse_credits: u ? (u.eclipse_credits ?? 10) : 10,
      })}\n\n`);
      res.end();
    } catch (e) {
      if (e.name !== 'AbortError') res.write(`data: ${JSON.stringify({ error: String(e.message).slice(0, 240) })}\n\n`);
      res.end();
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Server error: ' + e.message });
    else { try { res.end(); } catch {} }
  }
});

/* ============ IMAGES ============ */
app.post('/v1/images/generations', async (req, res) => {
  try {
    if (!HF_API_KEY) return res.status(503).json({ ok: false, error: 'HF_API_KEY not set on server.' });
    const { prompt, aspect_ratio = '1:1' } = req.body || {};
    if (!prompt) return res.status(400).json({ ok: false, error: 'Prompt required' });
    const u = await currentUser(req);
    const imageUrl = await hfImage(prompt, aspect_ratio);
    if (fdb && u) safeFdbPush(`logs/image/${u.email}`, { prompt: prompt.slice(0, 300), model: 'FLUX.1-schnell', ts: now() });
    res.json({ ok: true, image: imageUrl });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'Image error: ' + String(e.message).slice(0, 200) });
  }
});

/* ============ API KEYS ============ */
app.post(['/api/keys/generate', '/keys/generate'], async (req, res) => {
  try {
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ ok: false, error: 'Sign in first to generate an API key.' });

    const key = 'mxk_' + crypto.randomBytes(24).toString('hex');
    const prefix = key.slice(0, 12);
    const hash = crypto.createHash('sha256').update(key).digest('hex');

    let stored = false;
    if (fdb) {
      try {
        const existing = (await safeFdbGet(`api_keys/${u.email}`)) || {};
        const maxKeys = u.tier === 'free' ? 2 : u.tier === 'pro' ? 5 : 20;
        if (Object.keys(existing).length >= maxKeys) {
          return res.status(429).json({ ok: false, error: `Key limit reached (${maxKeys} for ${u.tier} plan).` });
        }
        const keyId = crypto.randomBytes(8).toString('hex');
        stored = await safeFdbSet(`api_keys/${u.email}/${keyId}`, { hash, prefix, created: now(), active: true });
      } catch {}
    }

    res.json({ ok: true, key, prefix, stored });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Key generation failed: ' + e.message });
  }
});

app.get(['/api/keys/list', '/keys/list'], async (req, res) => {
  try {
    const u = await currentUser(req);
    if (!u || !fdb) return res.json({ ok: true, keys: [] });
    const data = (await safeFdbGet(`api_keys/${u.email}`)) || {};
    const keys = Object.entries(data).map(([id, k]) => ({ id, prefix: k.prefix, created: k.created, active: k.active }));
    res.json({ ok: true, keys });
  } catch { res.json({ ok: true, keys: [] }); }
});

/* ============ ADMIN ============ */
function adminSession(req) {
  const token = (req.headers['x-admin-token'] || '').trim();
  if (!token) return null;
  const s = verifySession(token);
  if (!s || !s.admin) return null;
  if (s.exp < Date.now()) return null;
  return s;
}

app.post('/api/admin/auth', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: 'Invalid password' });
  const token = signSession({ admin: true, exp: Date.now() + 12 * 60 * 60 * 1000 });
  res.json({ ok: true, token });
});

app.post('/api/admin/set-tier', async (req, res) => {
  try {
    if (!adminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const { email, tier } = req.body || {};
    if (!email || !PLANS[tier]) return res.status(400).json({ ok: false, error: 'Invalid email or tier' });
    if (!fdb) return res.status(503).json({ ok: false, error: 'Database not available' });
    await safeFdbUpdate(`users/${email}`, { tier });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    if (!adminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!fdb) return res.json({ ok: true, users: 0, chats: 0, images: 0, events: 0, users_data: {} });
    const [usersSnap, chatsSnap, imgSnap, evSnap] = await Promise.all([
      fdb.ref('users').once('value'),
      fdb.ref('logs/chat').once('value'),
      fdb.ref('logs/image').once('value'),
      fdb.ref('logs/user').once('value'),
    ]);
    const countLogs = (obj) => {
      if (!obj) return 0;
      let n = 0;
      Object.values(obj).forEach(v => {
        if (Array.isArray(v)) n += v.length;
        else if (v && typeof v === 'object') n += Object.keys(v).length;
      });
      return n;
    };
    res.json({
      ok: true,
      users: Object.keys(usersSnap.val() || {}).length,
      chats: countLogs(chatsSnap.val()),
      images: countLogs(imgSnap.val()),
      events: countLogs(evSnap.val()),
      users_data: usersSnap.val() || {},
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------- 404 ---------- */
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found', path: req.path, method: req.method });
});

/* ---------- Error handler ---------- */
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) res.status(500).json({ ok: false, error: err.message || 'Internal error' });
});

module.exports = app;

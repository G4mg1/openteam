const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.options('*', (req, res) => res.status(200).end());

const HF_API_KEY = (process.env.HF_API_KEY || '').trim();
const SECRET = process.env.SECRET_KEY || 'mirox-dev-fallback-change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '2010';

/* ---------- Firebase Admin (OPTIONAL — never blocks boot) ---------- */
let fdb = null;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString());
      credential = admin.credential.cert(sa);
    } else {
      try { credential = admin.credential.applicationDefault(); } catch { credential = null; }
    }
    if (credential) {
      admin.initializeApp({
        databaseURL: 'https://miroxdata-default-rtdb.europe-west1.firebasedatabase.app/',
        credential,
      });
      fdb = admin.database();
    }
  } else {
    fdb = admin.database();
  }
} catch (e) {
  console.warn('[Firebase] Init skipped:', e.message);
  fdb = null;
}

const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);

/* ---------- Session helpers ---------- */
function signSession(d) {
  const p = Buffer.from(JSON.stringify(d)).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
}
function verifySession(t) {
  if (!t) return {};
  const a = t.split('.');
  if (a.length !== 2) return {};
  const e = crypto.createHmac('sha256', SECRET).update(a[0]).digest('base64url');
  if (e !== a[1]) return {};
  try { return JSON.parse(Buffer.from(a[0], 'base64url').toString()); } catch { return {}; }
}
function getSession(req) {
  const a = req.headers.authorization || '';
  if (a.startsWith('Bearer ')) { const s = verifySession(a.slice(7).trim()); if (s?.uid) return s; }
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)mirox_sess=([^;]+)/);
  if (!m) return {};
  return verifySession(decodeURIComponent(m[1]));
}
function setSession(res, d) {
  const t = signSession(d);
  const sc = process.env.VERCEL === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `mirox_sess=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${sc}`);
  return t;
}
function clearSession(res) { res.setHeader('Set-Cookie', 'mirox_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); }

/* ---------- Models ---------- */
const MODELS = {
  'mirox-luna-1.2': { label: 'Luna', tagline: 'Fast · warm', tier: 'free', default: true, tokens: 900,
    prompt: 'You are Luna, a warm assistant by OpenSurr. Use fenced code blocks with the language name. Never mention other companies.' },
  'mirox-gen-1': { label: 'Gen', tagline: 'Ultra concise', tier: 'free', fallback: true, tokens: 600,
    prompt: 'You are Gen from OpenSurr. Ultra-concise. Code only inside fenced blocks with the language name.' },
  'mirox-pro-5': { label: 'Pro', tagline: 'Balanced', tier: 'pro', tokens: 1400, prompt: 'You are Pro from OpenSurr.' },
  'mirox-ultra-10': { label: 'Ultra', tagline: 'Deep', tier: 'pro', tokens: 1800, prompt: 'You are Ultra from OpenSurr.' },
  'mirox-eclipse-2.0': { label: 'Eclipse', tagline: 'Best', tier: 'ultimate', tokens: 2400, prompt: 'You are Eclipse from OpenSurr.' },
};
const API_ALLOWED_MODELS = ['mirox-luna-1.2', 'mirox-gen-1'];

const PLANS = {
  free: { label: 'Free', daily_limit: 50, ultimate_trial_limit: 10, price_robux: 0 },
  pro: { label: 'Pro', daily_limit: 500, ultimate_trial_limit: 0, price_robux: 250 },
  ultimate: { label: 'Ultimate', daily_limit: 5000, ultimate_trial_limit: 0, price_robux: 1200 },
};
const TIER_RANK = { free: 0, pro: 1, ultimate: 2 };

/* ---------- User helpers (Firebase optional) ---------- */
async function getUserRecord(email) {
  if (!fdb || !email) return null;
  try { const s = await fdb.ref(`users/${email}`).once('value'); return s.exists() ? s.val() : null; } catch { return null; }
}
async function saveUserRecord(rec) {
  if (!fdb || !rec?.email) return;
  try { await fdb.ref(`users/${rec.email}`).update(rec); } catch {}
}
async function ensureFreshUser(email) {
  if (!email) return null;
  let rec = await getUserRecord(email);
  if (!rec) {
    rec = { email, name: '', tier: 'free', daily_used: 0, trial_used: 0, daily_reset: today(),
      eclipse_credits: 10, eclipse_reset: null, created_at: now() };
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
  return ensureFreshUser(s.uid);
}

/* ---------- HF ---------- */
const HF_CHAT = 'https://router.huggingface.co/v1/chat/completions';
const HF_IMAGE = 'https://router.huggingface.co/fal-ai/fal-ai/flux/schnell';

async function hfChatStream(messages, maxTokens, signal) {
  const res = await fetch(HF_CHAT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'Qwen/Qwen2.5-7B-Instruct', messages, max_tokens: maxTokens, stream: true }),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HF ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.body;
}
async function hfImageGenerate(prompt, aspectRatio = '1:1') {
  const sizeMap = { '1:1': '1024x1024', '16:9': '1344x768', '9:16': '768x1344', '4:3': '1152x864' };
  const res = await fetch(HF_IMAGE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image_size: sizeMap[aspectRatio] || '1024x1024', num_inference_steps: 4 }),
  });
  if (!res.ok) throw new Error(`HF image ${res.status}`);
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

/* ---------- SSE pipe ---------- */
async function pipeSSE(stream, res, onDone) {
  const reader = stream.getReader(), dec = new TextDecoder();
  let buf = '', full = '';
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
        if (d) { full += d; res.write(`data: ${JSON.stringify({ d })}\n\n`); }
      } catch {}
    }
  }
  if (onDone) onDone(full);
  return full;
}

/* ============================================================
   ROUTES
   ============================================================ */

/* Health check with diagnostics */
app.get(['/api/health', '/health', '/ping'], (req, res) => {
  res.json({
    ok: true,
    app: 'MiroxAI',
    hf_key: !!HF_API_KEY,
    firebase: !!fdb,
    admin_password_set: ADMIN_PASSWORD !== '2010',
    t: now(),
  });
});

app.get(['/api/config', '/config'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  let u = null;
  try { u = await currentUser(req); } catch {}
  res.json({
    app: { name: 'MiroxAI', made_by: 'OpenSurr', version: 'v16' },
    models: Object.entries(MODELS).map(([id, m]) => ({
      id, label: m.label, tagline: m.tagline, tier: m.tier,
      default: !!m.default, fallback: !!m.fallback,
    })),
    plans: PLANS,
    user_tier: u ? u.tier : 'free',
    guest: !u,
    hf_ready: !!HF_API_KEY,
  });
});

/* ---------- Auth ---------- */
app.post(['/api/auth/simple-login', '/auth/simple-login'], async (req, res) => {
  const { name, email } = req.body || {};
  const n = String(name || '').trim().slice(0, 60);
  const e = String(email || '').trim().toLowerCase().slice(0, 120);
  if (!n || !e || !e.includes('@') || !e.split('@')[1].includes('.')) {
    return res.status(400).json({ ok: false, error: 'Valid name and email required' });
  }

  let rec = await getUserRecord(e);
  const existing = !!rec;
  if (!rec) {
    rec = { email: e, name: n, tier: 'free', daily_used: 0, trial_used: 0, daily_reset: today(),
      eclipse_credits: 10, eclipse_reset: null, created_at: now() };
  } else {
    rec.name = n;
  }
  rec.last_login = now();
  await saveUserRecord(rec);

  const token = setSession(res, { uid: e, name: n, tier: rec.tier });
  if (fdb) try { await fdb.ref(`logs/user/${e}`).push({ event: existing ? 'signin' : 'signup', name: n, ts: now() }); } catch {}

  res.json({ ok: true, token,
    user: { id: e, email: e, name: n, tier: rec.tier, tier_label: PLANS[rec.tier].label } });
});

app.post(['/api/logout', '/logout'], (req, res) => { clearSession(res); res.json({ ok: true }); });

app.get(['/api/me', '/me'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const u = await currentUser(req);
  if (!u) return res.json({ user: null });
  res.json({ user: { id: u.email, email: u.email, name: u.name, tier: u.tier } });
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

/* ============================================================
   CHAT COMPLETIONS
   ============================================================ */
app.post('/v1/chat/completions', async (req, res) => {
  if (!HF_API_KEY) {
    return res.status(503).json({ ok: false, error: 'HF_API_KEY not configured on server.' });
  }

  const { model, messages, stream = false, temperature, message, history, files } = req.body || {};
  let u = null;
  try { u = await currentUser(req); } catch {}

  const apiKey = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const isApiCall = apiKey && apiKey.startsWith('mxk_');

  let msgs;
  if (messages && Array.isArray(messages)) msgs = messages;
  else {
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
      return res.status(429).json({ ok: false, error: `Daily limit reached (${plan.daily_limit}/day). Refills in 24h.`, limit_reached: true });
    }
  }
  if (fdb && u) {
    try {
      fdb.ref(`logs/chat/${u.email}`).push({
        model: effectiveCfg.label,
        message: String(message || msgs[msgs.length - 1]?.content || '').slice(0, 1000),
        ts: now(),
      });
    } catch {}
  }

  /* --- Non-stream --- */
  if (!stream) {
    try {
      const hfRes = await fetch(HF_CHAT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'Qwen/Qwen2.5-7B-Instruct', messages: msgs, max_tokens: effectiveCfg.tokens, temperature: temperature ?? 0.7 }),
      });
      if (!hfRes.ok) {
        const t = await hfRes.text().catch(() => '');
        throw new Error(`HF ${hfRes.status}: ${t.slice(0, 160)}`);
      }
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
      return res.json({ ok: true, reply, model: effectiveCfg.label, switched,
        switched_from: switched ? cfg.label : null, using_trial: usingTrial,
        daily_used: u ? (u.daily_used || 0) : 0,
        daily_remaining: u ? Math.max(0, PLANS[u.tier].daily_limit - (u.daily_used || 0)) : 0,
        eclipse_credits: u ? (u.eclipse_credits ?? 10) : 10 });
    } catch (e) {
      return res.status(502).json({ ok: false, error: String(e.message).slice(0, 200) });
    }
  }

  /* --- Stream --- */
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  const abortCtrl = new AbortController();
  req.on('close', () => { try { abortCtrl.abort(); } catch {} });

  try {
    const streamBody = await hfChatStream(msgs, effectiveCfg.tokens, abortCtrl.signal);
    await pipeSSE(streamBody, res);

    if (u && !isApiCall) {
      u.daily_used = (u.daily_used || 0) + 1;
      if (usingTrial) u.trial_used = (u.trial_used || 0) + 1;
      if (requestedModel === 'mirox-eclipse-2.0') {
        u.eclipse_credits = (u.eclipse_credits ?? 10) - 1;
        if (u.eclipse_credits <= 0) u.eclipse_reset = Date.now() + 24 * 60 * 60 * 1000;
      }
      await saveUserRecord(u);
    }

    res.write(`data: ${JSON.stringify({ done: true, model: effectiveCfg.label, switched,
      switched_from: switched ? cfg.label : null, using_trial: usingTrial,
      daily_used: u ? (u.daily_used || 0) : 0,
      daily_remaining: u ? Math.max(0, PLANS[u.tier].daily_limit - (u.daily_used || 0)) : 0,
      eclipse_credits: u ? (u.eclipse_credits ?? 10) : 10 })}\n\n`);
    res.end();
  } catch (e) {
    if (e.name !== 'AbortError') res.write(`data: ${JSON.stringify({ error: String(e.message).slice(0, 240) })}\n\n`);
    res.end();
  }
});

/* ---------- Images ---------- */
app.post('/v1/images/generations', async (req, res) => {
  if (!HF_API_KEY) return res.status(503).json({ ok: false, error: 'HF_API_KEY not configured.' });
  const { prompt, aspect_ratio = '1:1' } = req.body || {};
  if (!prompt) return res.status(400).json({ ok: false, error: 'Prompt required' });
  const u = await currentUser(req);
  try {
    const imageUrl = await hfImageGenerate(prompt, aspect_ratio);
    if (fdb && u) try { fdb.ref(`logs/image/${u.email}`).push({ prompt: prompt.slice(0, 300), model: 'FLUX.1-schnell', ts: now() }); } catch {}
    res.json({ ok: true, image: imageUrl });
  } catch (e) { res.status(502).json({ ok: false, error: String(e.message).slice(0, 200) }); }
});

/* ---------- API keys ---------- */
app.post(['/api/keys/generate', '/keys/generate'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Sign in first' });
  const key = 'mxk_' + crypto.randomBytes(24).toString('hex');
  const prefix = key.slice(0, 12);
  if (fdb) {
    const snap = await fdb.ref(`api_keys/${u.email}`).once('value');
    const existing = snap.val() || {};
    const maxKeys = u.tier === 'free' ? 2 : u.tier === 'pro' ? 5 : 20;
    if (Object.keys(existing).length >= maxKeys) return res.status(429).json({ ok: false, error: `Key limit reached (${maxKeys}).` });
    const keyId = crypto.randomBytes(8).toString('hex');
    await fdb.ref(`api_keys/${u.email}/${keyId}`).set({
      hash: crypto.createHash('sha256').update(key).digest('hex'),
      prefix, created: now(), active: true,
    });
  }
  res.json({ ok: true, key, prefix });
});

app.get(['/api/keys/list', '/keys/list'], async (req, res) => {
  const u = await currentUser(req);
  if (!u || !fdb) return res.json({ ok: true, keys: [] });
  const snap = await fdb.ref(`api_keys/${u.email}`).once('value');
  const data = snap.val() || {};
  const keys = Object.entries(data).map(([id, k]) => ({ id, prefix: k.prefix, created: k.created, active: k.active }));
  res.json({ ok: true, keys });
});

/* ============================================================
   ADMIN — password gated
   ============================================================ */
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
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Invalid password' });
  }
  const token = signSession({ admin: true, exp: Date.now() + 12 * 60 * 60 * 1000 });
  res.json({ ok: true, token });
});

app.post('/api/admin/set-tier', async (req, res) => {
  if (!adminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const { email, tier } = req.body || {};
  if (!email || !PLANS[tier]) return res.status(400).json({ ok: false, error: 'Invalid email or tier' });
  if (!fdb) return res.status(503).json({ ok: false, error: 'Database not available' });
  await fdb.ref(`users/${email}`).update({ tier });
  res.json({ ok: true });
});

app.get('/api/admin/stats', async (req, res) => {
  if (!adminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!fdb) return res.json({ ok: true, users: 0, chats: 0, images: 0, events: 0, users_data: [] });
  try {
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
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = app;

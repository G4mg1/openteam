const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.use(express.json({ limit: '15mb' }));

/* ---------- Config ---------- */
const HF_API_KEY = (process.env.HF_API_KEY || '').trim();
const DISCORD_WEBHOOK = (process.env.DISCORD_WEBHOOK || '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '2010';
const SECRET = process.env.SECRET_KEY || 'mirox-dev-fallback-change-me';

/* ---------- Firebase Admin ---------- */
if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: 'https://miroxdata-default-rtdb.europe-west1.firebasedatabase.app/',
    credential: admin.credential.applicationDefault(),
  });
}
const fdb = admin.database();

/* ---------- Helpers ---------- */
const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);

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
  if (a.startsWith('Bearer ')) {
    const s = verifySession(a.slice(7).trim());
    if (s && s.uid) return s;
  }
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

function clearSession(res) {
  res.setHeader('Set-Cookie', 'mirox_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

/* ---------- Models (API-restricted to Luna & Gen) ---------- */
const MODELS = {
  'mirox-luna-1.2': {
    label: 'Luna',
    tagline: 'Fast · warm',
    tier: 'free',
    default: true,
    tokens: 900,
    prompt: 'You are Luna, a warm and friendly assistant created by the OpenSurr team. Speak naturally. When writing code, ALWAYS use fenced code blocks with the language name on the opening fence line. Never mention any other company or AI model. If asked who made you, answer: OpenSurr. If asked your model name, answer: Luna.',
  },
  'mirox-gen-1': {
    label: 'Gen',
    tagline: 'Ultra concise',
    tier: 'free',
    fallback: true,
    tokens: 600,
    prompt: 'You are Gen, an ultra-concise assistant from the OpenSurr team. For code, output ONLY the code block with the language name on the opening fence. Never mention any other company or AI model. If asked who made you, answer: OpenSurr.',
  },
  'mirox-pro-5': { label: 'Pro', tier: 'pro', tokens: 1400, prompt: 'You are Pro...' },
  'mirox-ultra-10': { label: 'Ultra', tier: 'pro', tokens: 1800, prompt: 'You are Ultra...' },
  'mirox-eclipse-2.0': { label: 'Eclipse', tier: 'ultimate', tokens: 2400, prompt: 'You are Eclipse...' },
};

const API_ALLOWED_MODELS = ['mirox-luna-1.2', 'mirox-gen-1'];

/* ---------- Plans ---------- */
const PLANS = {
  free: { label: 'Free', daily_limit: 50, ultimate_trial_limit: 10, price_robux: 0 },
  pro: { label: 'Pro', daily_limit: 500, ultimate_trial_limit: 0, price_robux: 250 },
  ultimate: { label: 'Ultimate', daily_limit: 5000, ultimate_trial_limit: 0, price_robux: 1200 },
};

const TIER_RANK = { free: 0, pro: 1, ultimate: 2 };

/* ---------- User helpers (Firebase-backed) ---------- */
async function getUserRecord(email) {
  if (!email) return null;
  const snap = await fdb.ref(`users/${email}`).once('value');
  return snap.exists() ? snap.val() : null;
}

async function saveUserRecord(rec) {
  if (!rec || !rec.email) return;
  await fdb.ref(`users/${rec.email}`).update(rec);
}

async function ensureFreshUser(email) {
  if (!email) return null;
  let rec = await getUserRecord(email);
  if (!rec) {
    rec = {
      email, name: '', tier: 'free', tier_expires: 0,
      daily_used: 0, trial_used: 0, daily_reset: today(),
      eclipse_credits: 10, eclipse_reset: null, created_at: now(),
    };
    await saveUserRecord(rec);
    return rec;
  }
  let dirty = false;
  if (rec.daily_reset !== today()) {
    rec.daily_used = 0; rec.trial_used = 0; rec.daily_reset = today(); dirty = true;
  }
  if (rec.eclipse_reset && rec.eclipse_reset < Date.now()) {
    rec.eclipse_credits = 10; rec.eclipse_reset = null; dirty = true;
  }
  if (dirty) await saveUserRecord(rec);
  return rec;
}

async function currentUser(req) {
  const s = getSession(req);
  if (!s.uid) return null;
  return ensureFreshUser(s.uid);
}

/* ---------- HF Helpers ---------- */
const HF_CHAT = 'https://router.huggingface.co/v1/chat/completions';
const HF_IMAGE = 'https://router.huggingface.co/fal-ai/fal-ai/flux/schnell';

async function hfChatStream(messages, maxTokens, signal) {
  const res = await fetch(HF_CHAT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'Qwen/Qwen2.5-7B-Instruct',
      messages,
      max_tokens: maxTokens,
      stream: true,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`HF error ${res.status}`);
  return res.body;
}

async function hfImageGenerate(prompt, aspectRatio = '1:1') {
  const sizeMap = { '1:1': '1024x1024', '16:9': '1344x768', '9:16': '768x1344', '4:3': '1152x864' };
  const res = await fetch(HF_IMAGE, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      image_size: sizeMap[aspectRatio] || '1024x1024',
      num_inference_steps: 4,
    }),
  });
  if (!res.ok) throw new Error(`HF image error ${res.status}`);
  const data = await res.json();
  return data.images?.[0]?.url || data.url || null;
}

/* ---------- Message builder ---------- */
function buildMessages(systemPrompt, history, userText, persona, mem, searchCtx, files) {
  let sys = systemPrompt || '';
  if (persona) sys += `\n\nUser preference: ${persona}`;
  if (mem && mem.length) sys += `\n\nRemember: ${mem.slice(-8).map(m => m.text).join(' | ')}`;
  if (searchCtx) sys += `\n\nWEB SEARCH RESULTS:\n${searchCtx}`;

  const msgs = [{ role: 'system', content: sys }];

  const textFiles = (files || []).filter(f => f.type !== 'image');
  const imageFiles = (files || []).filter(f => f.type === 'image' && f.dataUrl);

  let textPart = userText || '';
  if (textFiles.length) {
    const fileText = textFiles.map(f => `[Attached file: ${f.name}]\n\`\`\`\n${String(f.content || '').slice(0, 6000)}\n\`\`\``).join('\n\n');
    textPart = (fileText + '\n\n' + (userText || '')).trim();
  }

  if (imageFiles.length) {
    const content = [{ type: 'text', text: textPart || 'Please look at the attached image(s).' }];
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

/* ---------- Config / Health ---------- */
app.get(['/api/config', '/config'], async (req, res) => {
  const u = await currentUser(req);
  res.json({
    app: { name: 'MiroxAI', made_by: 'OpenSurr', version: 'v14' },
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

app.get(['/api/health', '/health', '/ping'], (req, res) => {
  res.json({ ok: true, app: 'MiroxAI', hf: !!HF_API_KEY, t: now() });
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
    rec = {
      email: e, name: n, tier: 'free', tier_expires: 0,
      daily_used: 0, trial_used: 0, daily_reset: today(),
      eclipse_credits: 10, eclipse_reset: null, created_at: now(),
    };
  } else {
    // FIX: use update() merge to preserve all fields
    rec.name = n;
  }
  rec.last_login = now();
  await saveUserRecord(rec);

  const token = setSession(res, { uid: e, name: n, tier: rec.tier });

  // Log to Firebase
  await fdb.ref(`logs/user/${e}`).push({ event: existing ? 'signin' : 'signup', name: n, ts: now() });

  res.json({
    ok: true, token,
    user: { id: e, email: e, name: n, tier: rec.tier, tier_label: PLANS[rec.tier].label },
  });
});

app.post(['/api/logout', '/logout'], (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get(['/api/me', '/me'], async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const u = await currentUser(req);
  if (!u) return res.json({ user: null });
  res.json({
    user: { id: u.email, email: u.email, name: u.name, tier: u.tier, tier_label: PLANS[u.tier].label },
  });
});

/* ---------- Subscription ---------- */
app.get(['/api/subscription/me', '/subscription/me'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.json({ ok: false, error: 'Sign in first' });
  const p = PLANS[u.tier];
  const trialLimit = p.ultimate_trial_limit || 0;
  const trialUsed = u.trial_used || 0;
  const dailyRemaining = Math.max(0, p.daily_limit - (u.daily_used || 0));
  res.json({
    ok: true, tier: u.tier, tier_label: p.label,
    daily_limit: p.daily_limit, daily_remaining: dailyRemaining,
    trial_limit: trialLimit, trial_remaining: Math.max(0, trialLimit - trialUsed),
    trial_used: trialUsed, daily_used: u.daily_used || 0,
    eclipse_credits: u.eclipse_credits ?? 10,
    eclipse_reset: u.eclipse_reset || null,
    lite_mode: dailyRemaining <= 0,
  });
});

app.get(['/api/subscription/plans', '/subscription/plans'], (req, res) => {
  const perks = {
    free: ['Luna & Gen — free models', 'Vision + web search', '10 Eclipse chats/day', 'Memory & persona'],
    pro: ['Pro & Ultra models', '500 msgs/day', 'FLUX image generation', 'Priority speed'],
    ultimate: ['Eclipse — best model', '5000 msgs/day', 'Everything in Pro', 'Ultimate badge'],
  };
  const out = Object.entries(PLANS).map(([id, p]) => ({
    id, label: p.label,
    tagline: { free: 'Free forever', pro: 'Most popular', ultimate: 'For power users' }[id],
    daily_limit: p.daily_limit, price_robux: p.price_robux,
    perks: perks[id],
  }));
  res.json({ ok: true, plans: out });
});

/* ============================================================
   V1 CHAT COMPLETIONS (OpenAI-compatible)
   ============================================================ */
app.post('/v1/chat/completions', async (req, res) => {
  const { model, messages, stream = false, temperature, message, history, files, web_search, voice } = req.body || {};

  const u = await currentUser(req);

  // API key check (for external API calls)
  const apiKey = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const isApiCall = apiKey && apiKey.startsWith('mxk_');

  // Build messages from either OpenAI format or legacy format
  let msgs;
  if (messages && Array.isArray(messages)) {
    msgs = messages;
  } else {
    const msg = String(message || '').trim();
    if (!msg && !files?.length) return res.status(400).json({ ok: false, error: 'Empty message' });
    const systemMsg = msgs?.[0]?.role === 'system' ? msgs[0].content : (MODELS[model]?.prompt || MODELS['mirox-luna-1.2'].prompt);
    msgs = buildMessages(systemMsg, history, msg, u?.persona, u?.memory, null, files || []);
  }

  // Restrict API calls to Luna & Gen only
  const requestedModel = model || 'mirox-luna-1.2';
  if (isApiCall && !API_ALLOWED_MODELS.includes(requestedModel)) {
    return res.status(403).json({ ok: false, error: `Model "${requestedModel}" is not available via API. Use mirox-luna-1.2 or mirox-gen-1.` });
  }

  const cfg = MODELS[requestedModel] || MODELS['mirox-luna-1.2'];

  // Tier check
  const userTier = u ? u.tier : 'free';
  let effectiveCfg = cfg;
  let switched = false, usingTrial = false;

  if (TIER_RANK[cfg.tier] > TIER_RANK[userTier]) {
    if (userTier === 'free' && cfg.tier === 'ultimate') {
      const tl = PLANS.free.ultimate_trial_limit || 0;
      const tu = u ? (u.trial_used || 0) : 0;
      if (tu >= tl) {
        effectiveCfg = MODELS['mirox-luna-1.2'];
        switched = true;
      } else {
        usingTrial = true;
      }
    } else {
      effectiveCfg = MODELS['mirox-luna-1.2'];
      switched = true;
    }
  }

  // Eclipse credit check
  if (requestedModel === 'mirox-eclipse-2.0' && u) {
    const credits = u.eclipse_credits ?? 10;
    if (credits <= 0) {
      effectiveCfg = MODELS['mirox-luna-1.2'];
      switched = true;
    }
  }

  // Daily limit check
  if (u) {
    const plan = PLANS[u.tier];
    if ((u.daily_used || 0) >= plan.daily_limit) {
      return res.status(429).json({
        ok: false, error: `Daily message limit reached (${plan.daily_limit}/day). Refills in 24 hours.`,
        limit_reached: true, daily_remaining: 0,
      });
    }
  }

  const mem = u?.memory || [];
  const persona = u?.persona || '';
  const searchCtx = null; // web search optional

  // Save chat log to Firebase
  if (u) {
    fdb.ref(`logs/chat/${u.email}`).push({
      model: effectiveCfg.label, message: String(message || msgs[msgs.length - 1]?.content || '').slice(0, 1000),
      ts: now(),
    });
  }

  /* --- Non-stream --- */
  if (!stream) {
    try {
      const hfRes = await fetch(HF_CHAT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'Qwen/Qwen2.5-7B-Instruct',
          messages: msgs,
          max_tokens: effectiveCfg.tokens,
          temperature: temperature ?? 0.7,
        }),
      });
      if (!hfRes.ok) throw new Error(`HF error ${hfRes.status}`);
      const data = await hfRes.json();
      const reply = data.choices?.[0]?.message?.content || '';

      // Update usage
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
        ok: true, reply,
        model: effectiveCfg.label,
        switched, switched_from: switched ? cfg.label : null,
        using_trial: usingTrial,
        daily_used: u ? (u.daily_used || 0) : 0,
        daily_remaining: u ? Math.max(0, PLANS[u.tier].daily_limit - (u.daily_used || 0)) : 0,
        eclipse_credits: u ? (u.eclipse_credits ?? 10) : 10,
      });
    } catch (e) {
      return res.status(502).json({ ok: false, error: String(e.message).slice(0, 200) });
    }
  }

  /* --- Stream --- */
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  const t0 = Date.now();
  const abortCtrl = new AbortController();
  req.on('close', () => { try { abortCtrl.abort(); } catch {} });

  try {
    const streamBody = await hfChatStream(msgs, effectiveCfg.tokens, abortCtrl.signal);
    let full = '';
    await pipeSSE(streamBody, res, (f) => { full = f; });

    // Update usage
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
      done: true, model: effectiveCfg.label,
      switched, switched_from: switched ? cfg.label : null,
      using_trial: usingTrial,
      daily_used: u ? (u.daily_used || 0) : 0,
      daily_remaining: u ? Math.max(0, PLANS[u.tier].daily_limit - (u.daily_used || 0)) : 0,
      eclipse_credits: u ? (u.eclipse_credits ?? 10) : 10,
      ms: Date.now() - t0,
    })}\n\n`);
    res.end();
  } catch (e) {
    if (e.name !== 'AbortError') {
      res.write(`data: ${JSON.stringify({ error: String(e.message).slice(0, 240) })}\n\n`);
    }
    res.end();
  }
});

/* ============================================================
   V1 IMAGE GENERATION (Hugging Face FLUX)
   ============================================================ */
app.post('/v1/images/generations', async (req, res) => {
  const { prompt, aspect_ratio = '1:1' } = req.body || {};
  if (!prompt) return res.status(400).json({ ok: false, error: 'Prompt required' });

  const u = await currentUser(req);

  try {
    const imageUrl = await hfImageGenerate(prompt, aspect_ratio);

    // Log to Firebase
    if (u) {
      fdb.ref(`logs/image/${u.email}`).push({
        prompt: prompt.slice(0, 300), model: 'FLUX.1-schnell', ts: now(),
      });
    }

    res.json({ ok: true, image: imageUrl });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message).slice(0, 200) });
  }
});

/* ============================================================
   API KEYS
   ============================================================ */
app.post(['/api/keys/generate', '/keys/generate'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Sign in first' });

  const key = 'mxk_' + crypto.randomBytes(24).toString('hex');
  const prefix = key.slice(0, 12);

  const keysSnap = await fdb.ref(`api_keys/${u.email}`).once('value');
  const existing = keysSnap.val() || {};
  const keyCount = Object.keys(existing).length;

  const plan = PLANS[u.tier];
  const maxKeys = u.tier === 'free' ? 2 : u.tier === 'pro' ? 5 : 20;
  if (keyCount >= maxKeys) {
    return res.status(429).json({ ok: false, error: `Key limit reached (${maxKeys} for ${plan.label} plan).` });
  }

  const keyId = crypto.randomBytes(8).toString('hex');
  await fdb.ref(`api_keys/${u.email}/${keyId}`).set({
    hash: crypto.createHash('sha256').update(key).digest('hex'),
    prefix, created: now(), active: true,
  });

  res.json({ ok: true, key, prefix });
});

app.get(['/api/keys/list', '/keys/list'], async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.json({ ok: true, keys: [] });
  const snap = await fdb.ref(`api_keys/${u.email}`).once('value');
  const data = snap.val() || {};
  const keys = Object.entries(data).map(([id, k]) => ({
    id, prefix: k.prefix, created: k.created, active: k.active,
  }));
  res.json({ ok: true, keys });
});

/* ============================================================
   ADMIN
   ============================================================ */
app.post('/api/admin/set-tier', async (req, res) => {
  const { password, email, tier } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ ok: false, error: 'Unauthorized' });
  if (!email || !PLANS[tier]) return res.status(400).json({ ok: false, error: 'Invalid email or tier' });
  await fdb.ref(`users/${email}`).update({ tier });
  res.json({ ok: true });
});

app.get('/api/admin/stats', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ ok: false, error: 'Unauthorized' });
  const usersSnap = await fdb.ref('users').once('value');
  const users = usersSnap.val() || {};
  const chatsSnap = await fdb.ref('logs/chat').once('value');
  const chats = chatsSnap.val() || {};
  const imgSnap = await fdb.ref('logs/image').once('value');
  const imgs = imgSnap.val() || {};
  res.json({
    ok: true,
    users: Object.keys(users).length,
    chats: Object.values(chats).reduce((a, v) => a + (Array.isArray(v) ? v.length : Object.keys(v).length), 0),
    images: Object.values(imgs).reduce((a, v) => a + (Array.isArray(v) ? v.length : Object.keys(v).length), 0),
  });
});

/* ---------- Export ---------- */
module.exports = app;

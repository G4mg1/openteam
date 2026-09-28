const express = require('express');
const cookieSession = require('cookie-session');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use(cookieSession({
  name: 'mirox_sess',
  keys: [process.env.SECRET_KEY || 'mirox-dev-secret-please-change-me-1234567890'],
  maxAge: 30 * 24 * 60 * 60 * 1000,
  secure: process.env.VERCEL === '1' || process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  httpOnly: true,
}));

/* ------------------------- CONFIG ------------------------- */
const HF_API_KEY = (process.env.HF_API_KEY || '').trim();
const DISCORD_WEBHOOK = (process.env.DISCORD_WEBHOOK ||
  'https://discord.com/api/webhooks/1554014348794667078/1KhZnYj62iJQyRIg7CMIeRiaophKYppiXegaJ54vgbVARlYu1nx1OCSVU-N4PuN69mgI'
).trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '2010';

const HF_CHAT   = 'https://router.huggingface.co/v1/chat/completions';
const HF_IMAGES = 'https://router.huggingface.co/v1/images/generations';

/* ------------------------- IN-MEMORY STORES ------------------------- */
const USERS    = Object.create(null);   // email -> user record
const CHATS    = Object.create(null);   // email -> { chatId -> chat }
const MEMORY   = Object.create(null);   // email -> [ {id,text} ]
const PERSONAS = Object.create(null);   // email -> string
const KEYS     = Object.create(null);   // email -> [ keys ]
const TICKETS  = Object.create(null);   // email -> [ tickets ]

/* ------------------------- DISCORD LOGGING ------------------------- */
const COLORS = {
  signin:       0x16a34a,
  chat:         0x3b82f6,
  image:        0x8b5cf6,
  video:        0xdc2626,
  subscription: 0xd97706,
  error:        0xef4444,
};

async function logDiscord(kind, title, description = '', fields = []) {
  if (!DISCORD_WEBHOOK) return;
  const embed = {
    title,
    description: (description || '').slice(0, 2000),
    color: COLORS[kind] || 0x6366f1,
    footer: { text: 'MiroxAI' },
    timestamp: new Date().toISOString(),
  };
  if (fields && fields.length) {
    embed.fields = fields.map(([k, v]) => ({
      name: String(k).slice(0, 200),
      value: String(v).slice(0, 1000),
      inline: false,
    }));
  }
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'MiroxAI', embeds: [embed] }),
    });
  } catch (e) {
    console.error('discord log failed:', e.message);
  }
}

/* ------------------------- MODELS ------------------------- */
const MODELS = {
  'mirox-luna-1.2':    { label: 'Luna',    tagline: 'Smart and fast',       tier: 'free',     hf: 'meta-llama/Llama-3.2-3B-Instruct',  tokens: 700,  default: true },
  'mirox-gen-1':       { label: 'Gen',     tagline: 'Quick and light',      tier: 'free',     hf: 'meta-llama/Llama-3.2-1B-Instruct',  tokens: 512,  fallback: true },
  'mirox-pro-5':       { label: 'Pro',     tagline: 'Balanced intelligence',tier: 'pro',      hf: 'Qwen/Qwen2.5-7B-Instruct',          tokens: 900 },
  'mirox-ultra-10':    { label: 'Ultra',   tagline: 'Maximum power',        tier: 'pro',      hf: 'meta-llama/Llama-3.1-8B-Instruct',  tokens: 1200 },
  'mirox-eclipse-2.0': { label: 'Eclipse', tagline: 'Advanced reasoning',   tier: 'ultimate', hf: 'Qwen/Qwen2.5-14B-Instruct',         tokens: 1400 },
};
const TIER_RANK = { free: 0, pro: 1, ultimate: 2 };

const PLANS = {
  free:     { label: 'Free',     daily_limit: 50,   ultimate_trial_limit: 10, trial_model: 'mirox-eclipse-2.0', fallback_model: 'mirox-gen-1',     price_robux: 0,    price_afg: 0,   price_hesab: 0,   gamepass_id: '' },
  pro:      { label: 'Pro',      daily_limit: 500,  ultimate_trial_limit: 0,  trial_model: '',                  fallback_model: 'mirox-pro-5',     price_robux: 250,  price_afg: 120, price_hesab: 150, gamepass_id: '' },
  ultimate: { label: 'Ultimate', daily_limit: 5000, ultimate_trial_limit: 0,  trial_model: '',                  fallback_model: 'mirox-ultra-10',  price_robux: 1200, price_afg: 450, price_hesab: 550, gamepass_id: '' },
};

const SYSTEM_PROMPT = 'You are Mirox, an AI assistant created by the OpenSurr team. Your name is Mirox. Never mention any other company or model. If asked who made you, answer: OpenSurr. Be warm, clear, and concise.';

const ANNOUNCEMENT = {
  enabled: true,
  version: 'v1-luna',
  title: 'Meet Luna',
  image: 'luna.png',
  body: 'Luna is now the default — smart, fast, and free.',
  highlights: ['Luna — new default', 'Pro & Ultra on Pro plan', 'Eclipse on Ultimate', 'Image generation ready'],
};

/* ------------------------- HELPERS ------------------------- */
const now = () => Math.floor(Date.now() / 1000);

function currentUser(req) {
  const uid = req.session && req.session.uid;
  if (!uid) return null;
  if (!USERS[uid]) {
    USERS[uid] = {
      email: uid,
      name: (req.session && req.session.name) || '',
      tier: (req.session && req.session.tier) || 'free',
      created_at: now(),
      gmail: '',
    };
  }
  return { ...USERS[uid] };
}

function requireUser(fn) {
  return async (req, res, next) => {
    if (!req.session || !req.session.uid) {
      return res.status(401).json({ ok: false, error: 'Sign in first' });
    }
    try { await fn(req, res, next); }
    catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ ok: false, error: e.message }); }
  };
}

function requireAdmin(fn) {
  return async (req, res, next) => {
    if (!req.session || !req.session.is_admin) {
      return res.status(403).json({ ok: false, error: 'Admin only' });
    }
    try { await fn(req, res, next); }
    catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ ok: false, error: e.message }); }
  };
}

function chatBox(email)     { if (!CHATS[email])    CHATS[email]    = Object.create(null); return CHATS[email]; }
function memBox(email)      { if (!MEMORY[email])   MEMORY[email]   = []; return MEMORY[email]; }
function keysBox(email)     { if (!KEYS[email])     KEYS[email]     = []; return KEYS[email]; }
function ticketsBox(email)  { if (!TICKETS[email])  TICKETS[email]  = []; return TICKETS[email]; }

/* ------------------------- CONFIG / HEALTH ------------------------- */
app.get(['/config.json', '/api/config'], (req, res) => {
  const u = currentUser(req);
  res.json({
    app: { name: 'MiroxAI', made_by: 'OpenSurr', version: 'v1' },
    models: Object.entries(MODELS).map(([id, m]) => ({
      id, label: m.label, tagline: m.tagline, tier: m.tier,
      default: !!m.default, fallback: !!m.fallback,
    })),
    plans: PLANS,
    payments: { hesabpay: { enabled: false }, robux: { enabled: true }, afg_cash: { enabled: true } },
    email: { enabled: true, free_daily_limit: 5, paid_daily_limit: 100, signature: 'made by mirox ai', from_name: 'MiroxAI' },
    announcement: ANNOUNCEMENT,
    user_tier: u ? u.tier : 'free',
    hf_ready: !!HF_API_KEY,
  });
});

app.get(['/api/health', '/api/ping'], (req, res) => {
  res.json({ ok: true, app: 'MiroxAI', hf: !!HF_API_KEY, t: now() });
});

/* ------------------------- AUTH ------------------------- */
app.post('/api/auth/simple-login', async (req, res) => {
  const { name, email } = req.body || {};
  const n = String(name || '').trim().slice(0, 60);
  const e = String(email || '').trim().toLowerCase().slice(0, 120);

  if (!n || !e || !e.includes('@') || !e.split('@')[1].includes('.')) {
    return res.status(400).json({ ok: false, error: 'Valid name and email required' });
  }

  const existing = !!USERS[e];
  if (!existing) {
    USERS[e] = { email: e, name: n, tier: 'free', created_at: now(), gmail: '' };
  } else {
    USERS[e].name = n;
  }

  req.session.uid   = e;
  req.session.name  = n;
  req.session.tier  = USERS[e].tier;

  logDiscord('signin', existing ? '👤 Sign in' : '👤 New user', '', [
    ['Name', n],
    ['Email', e],
    ['Tier', USERS[e].tier],
    ['Time', new Date().toISOString()],
  ]);

  res.json({
    ok: true,
    user: {
      id: e, email: e, name: n,
      tier: USERS[e].tier,
      tier_label: PLANS[USERS[e].tier].label,
    },
  });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.json({ user: null });
  res.json({
    user: {
      id: u.email, email: u.email, name: u.name,
      tier: u.tier, tier_label: PLANS[u.tier].label,
    },
  });
});

/* ------------------------- SUBSCRIPTION ------------------------- */
app.get('/api/subscription/me', requireUser(async (req, res) => {
  const u = currentUser(req);
  const p = PLANS[u.tier];
  const ks = keysBox(u.email);
  res.json({
    ok: true,
    tier: u.tier,
    tier_label: p.label,
    daily_limit: p.daily_limit,
    daily_remaining: p.daily_limit,
    trial_limit: p.ultimate_trial_limit,
    trial_remaining: p.ultimate_trial_limit,
    images_allowed: true,
    video_allowed: false,
    email_connected: !!u.gmail,
    keys_remaining: Math.max(0, 3 - ks.length),
    keys_per_period: 3,
    refill_days: 30,
    daily_reset_seconds: 86400,
    lite_mode: false,
  });
}));

app.get('/api/subscription/plans', (req, res) => {
  const perks = {
    free: ['Luna & Gen — free models', '10 Eclipse chats/day', 'Image generation', 'Memory & persona'],
    pro: ['Pro & Ultra models', '500 msgs/day', 'Image generation', 'Priority speed'],
    ultimate: ['Eclipse — best model', '5000 msgs/day', 'Everything in Pro', 'Ultimate badge'],
  };
  const out = Object.entries(PLANS).map(([id, p]) => ({
    id,
    label: p.label,
    tagline: { free: 'Free forever', pro: 'Most popular', ultimate: 'For power users' }[id],
    daily_limit: p.daily_limit,
    price_robux: p.price_robux,
    price_afg: p.price_afg,
    price_hesab: p.price_hesab,
    gamepass_id: p.gamepass_id,
    perks: perks[id],
  }));
  res.json({ ok: true, plans: out, admin_email: 'admin@example.com', admin_phone: '' });
});

/* ------------------------- HF CHAT STREAM ------------------------- */
async function hfStream(modelId, messages, maxTokens) {
  if (!HF_API_KEY) throw new Error('HF_API_KEY not configured');
  const r = await fetch(HF_CHAT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
      top_p: 0.95,
      stream: true,
    }),
  });
  if (!r.ok) {
    let body = '';
    try { body = (await r.text()).slice(0, 200); } catch {}
    throw new Error(`HTTP ${r.status} ${body}`);
  }
  return r.body;
}

function buildMessages(history, userText, persona = '', mem = []) {
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (persona) msgs.push({ role: 'system', content: `User preference: ${String(persona).slice(0, 1500)}` });
  if (mem.length) {
    msgs.push({ role: 'system', content: 'Remember: ' + mem.slice(-8).map(m => m.text).join(' | ') });
  }
  for (const h of (history || []).slice(-12)) {
    const role = h.role, txt = String(h.content || '').trim().slice(0, 3000);
    if ((role === 'user' || role === 'assistant') && txt) msgs.push({ role, content: txt });
  }
  msgs.push({ role: 'user', content: String(userText || '').slice(0, 8000) });
  return msgs;
}

app.post('/api/chat/stream', requireUser(async (req, res) => {
  const { message, history, model: modelKey } = req.body || {};
  const msg = String(message || '').trim();
  if (!msg) return res.status(400).json({ ok: false, error: 'Empty message' });

  const u = currentUser(req);
  let cfg = MODELS[modelKey] || MODELS['mirox-luna-1.2'];
  if (TIER_RANK[cfg.tier] > TIER_RANK[u.tier]) {
    if (!(u.tier === 'free' && cfg.tier === 'ultimate')) {
      cfg = MODELS['mirox-luna-1.2'];
    }
  }

  const mem = memBox(u.email);
  const persona = PERSONAS[u.email] || '';
  const msgs = buildMessages(history, msg, persona, mem);

  logDiscord('chat', '💬 Chat message', '', [
    ['User', u.email],
    ['Model', cfg.label],
    ['Message', msg.slice(0, 500)],
    ['Length', `${msg.length} chars`],
  ]);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  const t0 = Date.now();
  try {
    const stream = await hfStream(cfg.hf, msgs, cfg.tokens);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          const ch = obj.choices || [];
          const delta = ch[0] && ch[0].delta && ch[0].delta.content;
          if (delta) {
            res.write(`data: ${JSON.stringify({ d: delta })}\n\n`);
          }
        } catch {}
      }
    }
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: String(e.message).slice(0, 220) })}\n\n`);
    logDiscord('error', '❌ Chat failed', String(e.message).slice(0, 400),
      [['User', u.email], ['Model', cfg.label]]);
  }
  res.write(`data: ${JSON.stringify({ done: true, model: cfg.label, ms: Date.now() - t0 })}\n\n`);
  res.end();
}));

app.post('/api/chat', requireUser(async (req, res) => {
  const { message, history, model: modelKey } = req.body || {};
  const msg = String(message || '').trim();
  if (!msg) return res.status(400).json({ ok: false, error: 'Empty message' });

  const u = currentUser(req);
  let cfg = MODELS[modelKey] || MODELS['mirox-luna-1.2'];
  const mem = memBox(u.email);
  const persona = PERSONAS[u.email] || '';
  const msgs = buildMessages(history, msg, persona, mem);

  try {
    const stream = await hfStream(cfg.hf, msgs, cfg.tokens);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let out = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          const ch = obj.choices || [];
          const delta = ch[0] && ch[0].delta && ch[0].delta.content;
          if (delta) out += delta;
        } catch {}
      }
    }
    res.json({ ok: true, reply: out, model: cfg.label });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message).slice(0, 200) });
  }
}));

/* ------------------------- MEMORY ------------------------- */
app.get('/api/memory', requireUser(async (req, res) => {
  res.json({ ok: true, facts: memBox(currentUser(req).email) });
}));

app.post('/api/memory', requireUser(async (req, res) => {
  const fact = String((req.body && req.body.fact) || '').trim().slice(0, 500);
  if (!fact) return res.status(400).json({ ok: false, error: 'Fact required' });
  const item = { id: Math.random().toString(36).slice(2, 10), text: fact };
  memBox(currentUser(req).email).push(item);
  res.json({ ok: true, fact: item });
}));

app.delete('/api/memory/:id', requireUser(async (req, res) => {
  const list = memBox(currentUser(req).email);
  const idx = list.findIndex(m => m.id === req.params.id);
  if (idx >= 0) list.splice(idx, 1);
  res.json({ ok: true });
}));

/* ------------------------- PERSONA ------------------------- */
app.get('/api/settings/persona', requireUser(async (req, res) => {
  res.json({ ok: true, persona: PERSONAS[currentUser(req).email] || '' });
}));

app.post('/api/settings/persona', requireUser(async (req, res) => {
  PERSONAS[currentUser(req).email] = String((req.body && req.body.persona) || '').slice(0, 2000);
  res.json({ ok: true });
}));

/* ------------------------- SUPPORT ------------------------- */
app.post('/api/report', requireUser(async (req, res) => {
  const { subject, category, message } = req.body || {};
  const tid = 't_' + Math.random().toString(36).slice(2, 12);
  const tk = {
    id: tid,
    subject: String(subject || '(no subject)').slice(0, 120),
    category: String(category || 'general').slice(0, 40),
    status: 'open',
    unread_user: 0,
    created_at: now(),
    messages: [{ from: 'user', text: String(message || '').slice(0, 4000), ts: now() }],
  };
  ticketsBox(currentUser(req).email).unshift(tk);
  res.json({ ok: true, ticket_id: tid });
}));

app.get('/api/report/mine', requireUser(async (req, res) => {
  res.json({ ok: true, reports: ticketsBox(currentUser(req).email) });
}));

app.post('/api/report/:id/reply', requireUser(async (req, res) => {
  const tid = req.params.id;
  const text = String((req.body && req.body.text) || '').slice(0, 4000);
  for (const t of ticketsBox(currentUser(req).email)) {
    if (t.id === tid) {
      t.messages.push({ from: 'user', text, ts: now() });
      t.status = 'open';
    }
  }
  res.json({ ok: true });
}));

/* ------------------------- API KEYS ------------------------- */
app.get('/api/keys', requireUser(async (req, res) => {
  res.json({ ok: true, keys: keysBox(currentUser(req).email) });
}));

app.post('/api/keys/generate', requireUser(async (req, res) => {
  const name = String((req.body && req.body.name) || 'My key').slice(0, 60);
  const crypto = require('crypto');
  const raw = 'mx_' + crypto.randomBytes(24).toString('base64url');
  const k = {
    id: 'k_' + Math.random().toString(36).slice(2, 10),
    name,
    key: raw,
    preview: raw.slice(0, 8) + '…' + raw.slice(-4),
    revoked: false,
    created_at: now(),
    tier: currentUser(req).tier,
  };
  keysBox(currentUser(req).email).push(k);
  res.json({ ok: true, id: k.id, key: raw });
}));

app.delete('/api/keys/:id', requireUser(async (req, res) => {
  for (const k of keysBox(currentUser(req).email)) {
    if (k.id === req.params.id) k.revoked = true;
  }
  res.json({ ok: true });
}));

/* ------------------------- EMAIL (stubs) ------------------------- */
app.get('/api/email/status', requireUser(async (req, res) => {
  const u = currentUser(req);
  res.json({ ok: true, connected: !!u.gmail, address: u.gmail || '', used_today: 0, daily_limit: 5 });
}));
app.post('/api/email/connect',    requireUser(async (req, res) => res.json({ ok: true })));
app.post('/api/email/disconnect', requireUser(async (req, res) => res.json({ ok: true })));
app.post('/api/email/test',       requireUser(async (req, res) => res.status(501).json({ ok: false, error: 'Email not enabled' })));
app.post('/api/email/send',       requireUser(async (req, res) => res.status(501).json({ ok: false, error: 'Email not enabled' })));

/* ------------------------- IMAGE ------------------------- */
app.post('/api/image/generate', requireUser(async (req, res) => {
  const prompt = String((req.body && req.body.prompt) || '').trim().slice(0, 1000);
  if (!prompt) return res.status(400).json({ ok: false, error: 'Prompt required' });
  if (!HF_API_KEY) return res.status(500).json({ ok: false, error: 'HF_API_KEY missing' });

  const u = currentUser(req);
  logDiscord('image', '🎨 Image request', '', [['User', u.email], ['Prompt', prompt.slice(0, 500)]]);

  try {
    const r = await fetch(HF_IMAGES, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'black-forest-labs/FLUX.1-schnell',
        prompt,
        n: 1,
        size: '1024x1024',
        response_format: 'url',
      }),
    });
    if (!r.ok) {
      logDiscord('error', '❌ Image failed', `HTTP ${r.status}`, [['User', u.email], ['Prompt', prompt.slice(0, 300)]]);
      return res.status(502).json({ ok: false, error: `HTTP ${r.status}` });
    }
    const j = await r.json();
    const item = (j.data || [{}])[0];
    const url = item.url || (item.b64_json ? ('data:image/png;base64,' + item.b64_json) : null);
    if (!url) return res.status(502).json({ ok: false, error: 'No image returned' });
    logDiscord('image', '✅ Image generated', '', [['User', u.email], ['Model', 'FLUX.1-schnell']]);
    res.json({ ok: true, image: url, url, model: 'FLUX.1-schnell', provider: 'Hugging Face' });
  } catch (e) {
    logDiscord('error', '❌ Image error', String(e.message).slice(0, 300), [['User', u.email]]);
    res.status(502).json({ ok: false, error: String(e.message).slice(0, 200) });
  }
}));

/* ------------------------- VIDEO ------------------------- */
app.post('/api/video/generate', requireUser(async (req, res) => {
  const u = currentUser(req);
  logDiscord('video', '🎬 Video request', 'Not enabled', [
    ['User', u.email],
    ['Prompt', String((req.body && req.body.prompt) || '').slice(0, 300)],
  ]);
  res.status(501).json({ ok: false, error: "Video generation isn't available on this deployment." });
}));

/* ------------------------- PAYMENTS ------------------------- */
app.post('/api/payment/hesabpay/create', requireUser(async (req, res) => {
  res.status(400).json({ ok: false, error: "HesabPay isn't configured." });
}));

/* ------------------------- ADMIN ------------------------- */
app.get('/api/admin/status', (req, res) => {
  res.json({ ok: true, is_admin: !!(req.session && req.session.is_admin) });
});

app.post('/api/admin/login', async (req, res) => {
  const pw = String((req.body && req.body.password) || '').trim();
  if (pw && pw === ADMIN_PASSWORD) {
    req.session.is_admin = true;
    logDiscord('signin', '🔐 Admin login', '', [['Time', new Date().toISOString()]]);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'Wrong password' });
});

app.post('/api/admin/logout', (req, res) => {
  if (req.session) req.session.is_admin = false;
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin(async (req, res) => {
  const arr = Object.values(USERS).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  res.json({ ok: true, users: arr });
}));

app.post('/api/admin/set-tier', requireAdmin(async (req, res) => {
  const { email, tier } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  const t = String(tier || 'free').trim().toLowerCase();
  if (!PLANS[t]) return res.status(400).json({ ok: false, error: 'Invalid tier' });
  if (!e) return res.status(400).json({ ok: false, error: 'Email required' });

  if (!USERS[e]) USERS[e] = { email: e, name: '', tier: t, created_at: now(), gmail: '' };
  else USERS[e].tier = t;

  logDiscord('subscription', '👑 Subscription changed', '', [['User', e], ['New tier', t]]);
  res.json({ ok: true, user: USERS[e] });
}));

app.get('/api/admin/stats', requireAdmin(async (req, res) => {
  const arr = Object.values(USERS);
  res.json({
    ok: true,
    total: arr.length,
    free: arr.filter(x => x.tier === 'free').length,
    pro: arr.filter(x => x.tier === 'pro').length,
    ultimate: arr.filter(x => x.tier === 'ultimate').length,
  });
}));

/* ------------------------- EXPORT ------------------------- */
module.exports = app;

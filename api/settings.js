import { isSafeUrl } from './mcp-client.js';

const TONES = ['default', 'friendly', 'concise', 'formal', 'playful'];
const clip = (v, n) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, n);

export const DEFAULT_SETTINGS = {
  persona: '',
  personalization: { name: '', nickname: '', about: '', tone: 'default' },
  memory: [],
  memory_enabled: true,
  tools: false,
  mcp_servers: [],
};

export function getSettings(u) {
  const s = u?.settings || {};
  return {
    persona: clip(u?.persona || s.persona, 1000),
    personalization: { ...DEFAULT_SETTINGS.personalization, ...(s.personalization || {}) },
    memory: Array.isArray(s.memory) ? s.memory : [],
    memory_enabled: s.memory_enabled !== false,
    tools: s.tools === true,
    mcp_servers: Array.isArray(s.mcp_servers) ? s.mcp_servers : [],
  };
}

function cleanHeaders(h) {
  if (!h || typeof h !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(h).slice(0, 10)) {
    const key = clip(k, 60);
    if (key) out[key] = clip(v, 500);
  }
  return out;
}

function cleanServer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = clip(raw.id, 40).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!id) return null;
  const base = { id, name: clip(raw.name, 60) || id, enabled: raw.enabled !== false };
  if (raw.transport === 'stdio') {
    // Spawning local processes is only allowed on a machine you control (npm start locally).
    if (process.env.MIROX_ALLOW_STDIO !== '1') return null;
    const command = clip(raw.command, 300);
    if (!command) return null;
    return { ...base, transport: 'stdio', command, args: (Array.isArray(raw.args) ? raw.args : []).slice(0, 20).map((a) => clip(a, 300)) };
  }
  const url = clip(raw.url, 500);
  if (!isSafeUrl(url)) return null;
  return { ...base, transport: 'http', url, headers: cleanHeaders(raw.headers) };
}

export function sanitizeSettings(raw) {
  const r = raw || {};
  const p = r.personalization || {};
  return {
    persona: clip(r.persona, 1000),
    personalization: {
      name: clip(p.name, 60),
      nickname: clip(p.nickname, 60),
      about: clip(p.about, 1500),
      tone: TONES.includes(p.tone) ? p.tone : 'default',
    },
    memory: (Array.isArray(r.memory) ? r.memory : []).map((m) => clip(m, 300)).filter(Boolean).slice(0, 80),
    memory_enabled: r.memory_enabled !== false,
    tools: r.tools === true,
    mcp_servers: (Array.isArray(r.mcp_servers) ? r.mcp_servers : []).map(cleanServer).filter(Boolean).slice(0, 10),
  };
}

// Used by the remember tool. Mutates the user's settings; the caller persists.
export function addMemory(user, fact) {
  const f = clip(fact, 300);
  if (!user) return { ok: false, error: 'Login required' };
  if (!f) return { ok: false, error: 'Empty fact' };
  const s = getSettings(user);
  if (!s.memory_enabled) return { ok: false, error: 'Memory is turned off in settings' };
  if (!s.memory.includes(f)) s.memory.push(f);
  user.settings = { ...s, memory: s.memory.slice(-80) };
  return { ok: true, saved: f };
}

// Text injected into the system prompt for logged-in chats.
export function userContextPrompt(u) {
  const s = getSettings(u);
  const p = s.personalization;
  const lines = [];
  if (p.name) lines.push(`The user's name is ${p.name}.`);
  if (p.nickname) lines.push(`Call them ${p.nickname}.`);
  if (p.about) lines.push(`About the user: ${p.about}`);
  if (p.tone && p.tone !== 'default') lines.push(`Preferred tone: ${p.tone}.`);
  if (s.memory_enabled && s.memory.length) {
    lines.push('Things to remember about the user:\n' + s.memory.map((m) => `- ${m}`).join('\n'));
  }
  return lines.length ? 'USER CONTEXT (use naturally, never recite it back):\n' + lines.join('\n') : '';
}

import { spawn } from 'child_process';

const TIMEOUT_MS = 20000;
const TOOL_CACHE_MS = 5 * 60 * 1000;
const INIT_PARAMS = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mirox', version: '1.0.0' } };
const toolCache = new Map();
let nextId = 1;

// Blocks localhost and private networks so users can't point the server at internal services.
export function isSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (process.env.MIROX_ALLOW_PRIVATE_URLS === '1') return true;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.startsWith('[')) return false;
  return !/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}

async function httpRpc(server, session, method, params, notify = false) {
  const body = notify
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextId++, method, params };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(server.headers || {}) };
  if (session.sid) headers['Mcp-Session-Id'] = session.sid;
  const r = await fetch(server.url, {
    method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
  });
  const sid = r.headers.get('mcp-session-id');
  if (sid) session.sid = sid;
  if (!r.ok) throw new Error(`MCP server returned HTTP ${r.status}`);
  if (notify) return null;

  const text = await r.text();
  let msg = null;
  if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { const m = JSON.parse(line.slice(5).trim()); if (m.id === body.id) msg = m; } catch {}
    }
  } else {
    try { msg = JSON.parse(text); } catch {}
  }
  if (!msg) throw new Error('No valid response from MCP server');
  if (msg.error) throw new Error(msg.error.message || 'MCP error');
  return msg.result;
}

function stdioSession(server, fn) {
  return new Promise((resolve, reject) => {
    const proc = spawn(server.command, server.args || [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = new Map();
    let buf = '';
    let id = 1;
    let settled = false;
    let timer = null;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      if (err) reject(err); else resolve(val);
    };
    timer = setTimeout(() => finish(new Error('MCP stdio server timed out')), TIMEOUT_MS * 2);

    proc.on('error', (e) => finish(e));
    proc.stdin.on('error', () => {});
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        const p = pending.get(m.id);
        if (!p) continue;
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || 'MCP error'));
        else p.resolve(m.result);
      }
    });

    const rpc = (method, params) => new Promise((res, rej) => {
      const myId = id++;
      pending.set(myId, { resolve: res, reject: rej });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });
    const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

    (async () => {
      await rpc('initialize', INIT_PARAMS);
      notify('notifications/initialized', {});
      return fn(rpc);
    })().then((v) => finish(null, v), (e) => finish(e));
  });
}

// Opens a session, runs fn(rpc), then closes. Stateless per call, which keeps it simple.
function withSession(server, fn) {
  if (server.transport === 'stdio') return stdioSession(server, fn);
  if (!isSafeUrl(server.url)) return Promise.reject(new Error('MCP URL not allowed'));
  const session = { sid: null };
  return (async () => {
    await httpRpc(server, session, 'initialize', INIT_PARAMS);
    await httpRpc(server, session, 'notifications/initialized', {}, true);
    return fn((m, p) => httpRpc(server, session, m, p));
  })();
}

export async function listMcpTools(server) {
  const key = `${server.id}:${server.url || server.command}`;
  const hit = toolCache.get(key);
  if (hit && Date.now() - hit.at < TOOL_CACHE_MS) return hit.tools;
  const tools = await withSession(server, async (rpc) => (await rpc('tools/list', {})).tools || []);
  toolCache.set(key, { at: Date.now(), tools });
  return tools;
}

export function callMcpTool(server, name, args) {
  return withSession(server, (rpc) => rpc('tools/call', { name, arguments: args || {} }));
}

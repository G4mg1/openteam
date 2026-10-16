import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import tls from 'tls';
import net from 'net';
import { execFile } from 'child_process';
import { promisify } from 'util';
import AdmZip from 'adm-zip';
import { listMcpTools, callMcpTool, isSafeUrl } from './mcp-client.js';
import { splitFull } from './thinking.js';
import { addMemory } from './settings.js';

const execFileAsync = promisify(execFile);
const ROOT = path.join(os.tmpdir(), 'mirox-workspace');
const SHELL_ON = process.env.MIROX_ALLOW_SHELL === '1';
const MAX_READ = 60000;
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const TOOL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/;
const THINK_RE = /<thinking>[\s\S]*?<\/thinking>/g;

async function ensureWs(user) {
  const id = String(user?.id || user?.email || 'guest').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const dir = path.join(ROOT, id);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Resolves a relative path inside the workspace; anything escaping it throws.
function inside(ws, rel) {
  const target = path.resolve(ws, String(rel || '.'));
  if (target !== ws && !target.startsWith(ws + path.sep)) throw new Error('Path is outside the workspace');
  return target;
}
const relOf = (ws, p) => path.relative(ws, p) || '.';

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LOCAL = {
  inspect_tls: {
    desc: 'Inspect the public TLS certificate for a hostname using a normal TLS connection on port 443. No arbitrary packet crafting. args: {"host":"example.com"}',
    run: async (a) => {
      const host = String(a.host || '').trim().replace(/^https?:\/\//i, '').split(/[\/:?#]/)[0].toLowerCase();
      if (!host || host.length > 253 || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) || net.isIP(host)) throw new Error('Provide a public DNS hostname such as example.com');
      if (/^(localhost|.*\.localhost|.*\.local|metadata\.google\.internal)$/i.test(host)) throw new Error('Private/local hostnames are not allowed');
      return await new Promise((resolve, reject) => {
        const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 7000 }, () => {
          const cert = socket.getPeerCertificate();
          const result = { host, port: 443, authorized: socket.authorized, authorizationError: socket.authorizationError || null, protocol: socket.getProtocol(), cipher: socket.getCipher()?.name || null, subject: cert?.subject || null, issuer: cert?.issuer || null, valid_from: cert?.valid_from || null, valid_to: cert?.valid_to || null, fingerprint256: cert?.fingerprint256 || null };
          socket.end(); resolve(result);
        });
        socket.once('timeout', () => { socket.destroy(); reject(new Error('TLS connection timed out')); });
        socket.once('error', (e) => reject(new Error(`TLS connection failed: ${e.message}`)));
      });
    },
  },
  list_files: {
    desc: 'List files in a workspace folder. args: {"path": "."}',
    run: async (a, ws) => {
      const dir = inside(ws, a.path || '.');
      const items = await fs.readdir(dir, { withFileTypes: true });
      return { path: relOf(ws, dir), items: items.slice(0, 300).map((d) => ({ name: d.name, dir: d.isDirectory() })) };
    },
  },
  read_file: {
    desc: 'Read a text file in the workspace. args: {"path": "file.txt"}',
    run: async (a, ws) => {
      const file = inside(ws, a.path);
      const text = await fs.readFile(file, 'utf8');
      return { path: relOf(ws, file), content: text.slice(0, MAX_READ), truncated: text.length > MAX_READ };
    },
  },
  write_file: {
    desc: 'Create or overwrite a text file in the workspace. args: {"path": "notes.md", "content": "..."}',
    run: async (a, ws) => {
      const file = inside(ws, a.path);
      const content = String(a.content ?? '');
      if (content.length > 2_000_000) throw new Error('File too large');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, 'utf8');
      return { path: relOf(ws, file), bytes: Buffer.byteLength(content) };
    },
  },
  extract_zip: {
    desc: 'Extract a .zip file in the workspace. args: {"path": "project.zip", "dest": "optional/folder"}',
    run: async (a, ws) => {
      const src = inside(ws, a.path);
      const dest = inside(ws, a.dest || path.join('extracted', path.basename(src, '.zip')));
      const zip = new AdmZip(src);
      const entries = zip.getEntries();
      if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`Zip has too many files (max ${MAX_ZIP_ENTRIES})`);
      let total = 0;
      for (const e of entries) {
        total += e.header.size;
        if (total > MAX_ZIP_BYTES) throw new Error('Zip is too large once extracted');
        const target = path.resolve(dest, e.entryName);
        if (target !== dest && !target.startsWith(dest + path.sep)) throw new Error(`Unsafe path in zip: ${e.entryName}`);
      }
      await fs.mkdir(dest, { recursive: true });
      zip.extractAllTo(dest, true);
      return {
        dest: relOf(ws, dest),
        files: entries.filter((e) => !e.isDirectory).length,
        sample: entries.slice(0, 60).map((e) => e.entryName),
      };
    },
  },
  make_zip: {
    desc: 'Zip a file or folder in the workspace. args: {"path": "folder", "dest": "folder.zip"}',
    run: async (a, ws) => {
      const src = inside(ws, a.path);
      const out = inside(ws, a.dest || `${path.basename(src)}.zip`);
      const st = await fs.stat(src);
      const zip = new AdmZip();
      if (st.isDirectory()) zip.addLocalFolder(src, path.basename(src));
      else zip.addLocalFile(src);
      zip.writeZip(out);
      return { dest: relOf(ws, out), bytes: (await fs.stat(out)).size };
    },
  },
  create_directory: {
    desc: 'Create a folder in the workspace. args: {"path": "src/components"}',
    run: async (a, ws) => {
      const dir = inside(ws, a.path);
      await fs.mkdir(dir, { recursive: true });
      return { path: relOf(ws, dir), created: true };
    },
  },
  append_file: {
    desc: 'Append text to a file in the workspace. args: {"path": "notes.md", "content": "..."}',
    run: async (a, ws) => {
      const file = inside(ws, a.path);
      const content = String(a.content ?? '');
      if (content.length > 500000) throw new Error('Append too large');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, content, 'utf8');
      return { path: relOf(ws, file), appendedBytes: Buffer.byteLength(content) };
    },
  },
  search_files: {
    desc: 'Search text files in a workspace folder. args: {"query": "TODO", "path": "."}',
    run: async (a, ws) => {
      const root = inside(ws, a.path || '.');
      const query = String(a.query || '').slice(0, 200);
      if (!query) throw new Error('query is required');
      const matches = [];
      const walk = async (dir, depth = 0) => {
        if (depth > 8 || matches.length >= 100) return;
        let entries = [];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (matches.length >= 100) break;
          if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.next') continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) { await walk(full, depth + 1); continue; }
          try {
            const st = await fs.stat(full);
            if (st.size > 1_000_000) continue;
            const data = await fs.readFile(full, 'utf8');
            const lines = data.split(/\r?\n/);
            lines.forEach((line, i) => { if (line.includes(query) && matches.length < 100) matches.push({ path: relOf(ws, full), line: i + 1, text: line.slice(0, 300) }); });
          } catch {}
        }
      };
      await walk(root);
      return { query, matches };
    },
  },
  workspace_info: {
    desc: 'Show workspace path and top-level files. args: {}',
    run: async (_a, ws) => ({ path: ws, items: (await fs.readdir(ws, { withFileTypes: true })).slice(0, 100).map((e) => ({ name: e.name, dir: e.isDirectory() })) }),
  },
  fetch_url: {
    desc: 'Fetch a web page and return its text. args: {"url": "https://..."}',
    run: async (a) => {
      if (!isSafeUrl(a.url)) throw new Error('URL not allowed');
      const r = await fetch(a.url, {
        headers: { 'User-Agent': 'MiroxAI/1.0' },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      const raw = (await r.text()).slice(0, 200000);
      const text = /html/i.test(r.headers.get('content-type') || '') ? stripHtml(raw) : raw;
      return { ok: r.ok, status: r.status, text: text.slice(0, 12000) };
    },
  },
  remember: {
    desc: 'Save a durable fact the user asked you to remember. args: {"fact": "..."}',
    run: async (a, _ws, ctx) => addMemory(ctx.user, a.fact),
  },
  ...(SHELL_ON ? {
    run_command: {
      desc: 'Run a shell command inside the workspace. args: {"command": "ls -la"}',
      run: async (a, ws) => {
        const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', String(a.command || '')], {
          cwd: ws, timeout: 30000, maxBuffer: 1024 * 1024,
        }).catch((e) => ({ stdout: e.stdout || '', stderr: e.stderr || e.message }));
        return { stdout: String(stdout).slice(0, 8000), stderr: String(stderr).slice(0, 4000) };
      },
    },
  } : {}),
};

export async function toolCatalog(user) {
  const lines = Object.entries(LOCAL).map(([name, t]) => `- ${name}: ${t.desc}`);
  for (const s of (user?.settings?.mcp_servers || []).filter((x) => x.enabled)) {
    try {
      for (const t of await listMcpTools(s)) {
        lines.push(`- ${s.id}.${t.name}: [MCP ${s.name}] ${t.description || ''} Input schema: ${JSON.stringify(t.inputSchema || {}).slice(0, 400)}`);
      }
    } catch (e) {
      console.warn('[mcp]', s.id, e.message);
    }
  }
  return lines.join('\n');
}

export async function executeTool(name, args, ctx) {
  try {
    const ws = await ensureWs(ctx.user);
    if (LOCAL[name]) {
      const r = await LOCAL[name].run(args || {}, ws, ctx);
      return { ok: r?.ok !== false, ...r };
    }
    const dot = name.indexOf('.');
    if (dot > 0) {
      const server = (ctx.user?.settings?.mcp_servers || []).find((s) => s.id === name.slice(0, dot) && s.enabled);
      if (!server) throw new Error('Unknown MCP server');
      const result = await callMcpTool(server, name.slice(dot + 1), args || {});
      const text = (result?.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
      return { ok: !result?.isError, text: text.slice(0, 12000) };
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Copies base64 attachments (zips, PDFs, etc.) into the user's workspace so tools can open them.
// Images are skipped because they go to the vision model instead.
export async function saveAttachments(files, user) {
  const saved = [];
  const list = (Array.isArray(files) ? files : []).slice(0, 10);
  if (!list.length) return saved;
  const ws = await ensureWs(user);
  const dir = path.join(ws, 'uploads');
  for (const f of list) {
    if (!f || !f.name || f.type === 'image') continue;
    const b64 = f.base64 || (typeof f.dataUrl === 'string' && f.dataUrl.includes(',') ? f.dataUrl.split(',')[1] : '');
    if (!b64) continue;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 25 * 1024 * 1024) continue;
    const safe = path.basename(String(f.name)).replace(/[^\w.\- ]/g, '_').slice(0, 120);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, safe), buf);
    saved.push(`uploads/${safe}`);
  }
  return saved;
}

const TOOL_PROTOCOL = `TOOLS ARE EXECUTABLE, NOT NARRATION. If a tool is needed, your entire assistant response must be exactly one <tool_call>{\"name\":\"tool_name\",\"arguments\":{...}}</tool_call> block with valid JSON. Do not describe an imagined extraction, browsing, or tool call in prose. Wait for the actual <tool_result>, then continue. Use the exact attachment paths explicitly listed in the latest user message; do not guess a filename from previous chats. Files are in this user's private workspace. Use relative paths. Use remember only when the user explicitly asks you to remember something. When done, answer normally and never print tool protocol tags to the user.
Available tools:`;

function messageParts(data) {
  if (typeof data?.reply === 'string') return { content: data.reply, reasoning: '' };
  const msg = data?.choices?.[0]?.message || {};
  let content = msg.content;
  if (Array.isArray(content)) content = content.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).join('');
  return { content: String(content || ''), reasoning: String(msg.reasoning_content || msg.reasoning || '') };
}

const summarize = (r) => (r.ok
  ? (r.dest || r.path || r.saved || (r.files != null ? `${r.files} files` : 'done'))
  : (r.error || 'failed'));

// Runs the tool loop. chain(messages) must return a non-streamed response object.
export async function runAgent({ messages, chain, emit, user, isClosed = () => false, maxSteps = 8, beforeTool = async () => true }) {
  const catalog = await toolCatalog(user);
  const convo = messages.map((m) => ({ ...m }));
  convo[0] = { ...convo[0], content: `${convo[0].content}\n\n${TOOL_PROTOCOL}\n${catalog}` };
  const calls = [];

  for (let step = 0; step < maxSteps && !isClosed(); step++) {
    const res = await chain(convo);
    const data = await res.json().catch(() => ({}));
    const { content, reasoning } = messageParts(data);
    const parts = splitFull(content);
    const thought = [reasoning, parts.thinking].filter(Boolean).join('\n\n');
    if (thought) emit({ t: thought });

    const m = TOOL_RE.exec(content);
    if (!m) {
      return { text: parts.answer || content.replace(THINK_RE, '').trim(), toolCalls: calls };
    }

    convo.push({ role: 'assistant', content: content.replace(THINK_RE, '').trim() });
    let call = null;
    try { call = JSON.parse(m[1].trim()); } catch {}
    if (!call || typeof call.name !== 'string') {
      convo.push({ role: 'user', content: '<tool_result>{"ok":false,"error":"Invalid tool_call. Reply with one valid JSON object inside the tags."}</tool_result>' });
      continue;
    }

    const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
    const allowed = await beforeTool();
    if (!allowed) {
      emit({ limit: { code: 'tool_steps', message: 'Free plan tool limit reached. Your 20 tool steps refresh after 3 hours.' } });
      return { text: 'You have used all 20 free tool steps. Your allowance refreshes 3 hours after the first step in this window. You can continue without tools or try again after it refreshes.', toolCalls: calls, limitReached: true };
    }
    emit({ tool: { name: call.name, status: 'running', args: Object.keys(args).slice(0, 3).map((k) => `${k}: ${String(args[k]).slice(0, 50)}`).join(', ') } });
    const result = await executeTool(call.name, args, { user });
    calls.push({ name: call.name, ok: result.ok });
    emit({ tool: { name: call.name, status: result.ok ? 'done' : 'error', summary: summarize(result) } });
    convo.push({ role: 'user', content: `<tool_result name="${call.name}">${JSON.stringify(result).slice(0, 12000)}</tool_result>` });
  }

  return { text: 'I hit the tool-step limit before finishing. Tell me what to focus on and I will continue.', toolCalls: calls };
}

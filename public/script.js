/* ---------- Bridge (HTTP-only + PNA fix) ---------- */
function bridgeBase(useAlt = false) {
  const host = useAlt ? '127.0.0.1' : 'localhost';
  return `http://${host}:${__bridge.port}`;
}

async function testBridgeConnection(port) {
  const endpoints = [`http://localhost:${port}/ping`, `http://127.0.0.1:${port}/ping`];
  for (const url of endpoints) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(url, { method: 'GET', mode: 'cors', signal: ctrl.signal });
      clearTimeout(timeout);
      if (r.ok) {
        const data = await r.json();
        if (data && data.ok) return { ok: true, data, url };
      }
    } catch (e) {
      // try next endpoint
    }
  }
  return { ok: false };
}

async function startBridge() {
  const name = ($('#bwNameInput')?.value || $('#bridgeNameInput')?.value || __bridge.name).trim();
  const model = $('#bwModelSelect')?.value || $('#bridgeModelSelect')?.value || __bridge.model;
  const port = parseInt($('#bwPortInput')?.value || $('#bridgePortInput')?.value || __bridge.port, 10);
  __bridge.name = name; __bridge.model = model; __bridge.port = port;
  saveBridgeLS();
  renderBridgeStatus();
  bridgeLog(`Connecting to http://localhost:${port}…`, 'info');

  const result = await testBridgeConnection(port);
  if (result.ok) {
    __bridge.connected = true;
    __bridge.baseUrl = result.url.replace('/ping', '');
    renderBridgeStatus();
    bridgeLog(`✓ Connected to "${result.data.name}" (cwd: ${result.data.cwd || '?'})`, 'ok');
    hideBridgeEmpty();
    return true;
  }

  __bridge.connected = false;
  renderBridgeStatus();
  bridgeLog(`✗ Connection failed on port ${port}`, 'err');
  setBwHint(
    'Could not reach the bridge. Make sure:\n' +
    '1. You ran "python runner.py" in the extracted folder.\n' +
    '2. Port ' + port + ' is not blocked by a firewall.\n' +
    '3. You see "[Bridge] Ready" in the terminal.\n\n' +
    'Quick test: open http://localhost:' + port + '/ping in your browser.',
    'err'
  );
  return false;
}

function stopBridge() {
  __bridge.connected = false;
  __bridge.baseUrl = null;
  renderBridgeStatus();
  bridgeLog('Bridge disconnected', 'info');
}

async function bridgeCall(endpoint, payload) {
  if (!__bridge.connected) throw new Error('Bridge not connected');
  const base = __bridge.baseUrl || bridgeBase();
  const r = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

function downloadBridgeClient() {
  const params = new URLSearchParams({ name: __bridge.name, port: String(__bridge.port), model: __bridge.model });
  const url = '/api/bridge/download?' + params.toString();
  const a = document.createElement('a');
  a.href = url; a.download = 'mirox_client_bridge.zip';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  bridgeLog('Downloading client package…', 'info');
}

function setBwHint(text, cls = '') {
  const el = $('#bwConnectHint'); if (!el) return;
  el.textContent = text;
  el.className = 'bw-hint' + (cls ? ' ' + cls : '');
}

/* ---------- Bridge workspace chat ---------- */
function openBridgeWorkspace() {
  $('#bridgeWorkspace')?.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('#bridgeInput')?.focus(), 200);
}
function closeBridgeWorkspace() {
  $('#bridgeWorkspace')?.classList.remove('open');
  document.body.style.overflow = '';
}
function hideBridgeEmpty() { $('#bridgeEmpty')?.remove(); }
function clearBridgeChat() {
  $('#bridgeMessages').innerHTML = '';
  bridgeConversation = [];
  bridgeLog('Chat cleared', 'info');
}

let bridgeConversation = [];
let bridgeRunning = false;

function addBridgeMsg(role, text) {
  hideBridgeEmpty();
  const container = $('#bridgeMessages'); if (!container) return;
  const el = document.createElement('div');
  el.className = `bridge-msg ${role}`;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const body = role === 'ai' ? renderMarkdown(text) : escapeHtml(text).replace(/\n/g, '<br>');
  el.innerHTML = `<div class="bridge-bubble">${body}</div><div class="bridge-meta">${role === 'ai' ? 'Mirox' : role === 'user' ? 'You' : 'System'} · ${time}</div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  if (role === 'ai') wireCodeButtons(el);
  return el;
}

function addBridgeCmdResult(cmd, result) {
  const container = $('#bridgeMessages'); if (!container) return;
  const ok = result && result.ok;
  const label = {
    exec: `$ ${cmd.command}`,
    write: `→ write ${cmd.path}`,
    read: `← read ${cmd.path}`,
    list: `≡ list ${cmd.path}`,
  }[cmd.type] || cmd.type;
  let body = '';
  if (ok) {
    if (cmd.type === 'exec') body = (result.stdout || '') + (result.stderr ? '\n[stderr]\n' + result.stderr : '') + `\n[exit ${result.exit_code}]`;
    else if (cmd.type === 'write') body = `Wrote ${result.bytes ?? 0} bytes → ${result.path}`;
    else if (cmd.type === 'read') body = result.content || '(empty)';
    else if (cmd.type === 'list') body = (result.items || []).map(i => (i.is_dir ? '📁 ' : '📄 ') + i.name).join('\n');
  } else {
    body = (result && result.error) || 'Unknown error';
  }
  const el = document.createElement('div');
  el.className = 'bridge-cmd-result' + (ok ? '' : ' err');
  el.innerHTML = `<div class="bridge-cmd-label"><i class="ri-terminal-box-line"></i> ${escapeHtml(label)}</div><pre>${escapeHtml(body.slice(0, 5000))}</pre>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function extractBridgeCommands(text) {
  const cmds = [];
  let m;
  const execRe = /<bridge-exec>([\s\S]*?)<\/bridge-exec>/g;
  while ((m = execRe.exec(text)) !== null) cmds.push({ type: 'exec', command: m[1].trim(), index: m.index });
  const writeRe = /<bridge-write\s+path="([^"]+)">([\s\S]*?)<\/bridge-write>/g;
  while ((m = writeRe.exec(text)) !== null) cmds.push({ type: 'write', path: m[1], content: m[2], index: m.index });
  const readRe = /<bridge-read\s+path="([^"]+)"\s*\/>/g;
  while ((m = readRe.exec(text)) !== null) cmds.push({ type: 'read', path: m[1], index: m.index });
  const listRe = /<bridge-list\s+path="([^"]+)"\s*\/>/g;
  while ((m = listRe.exec(text)) !== null) cmds.push({ type: 'list', path: m[1], index: m.index });
  return cmds;
}

async function executeBridgeCommand(cmd) {
  const endpoint = '/' + cmd.type;
  if (cmd.type === 'exec') return bridgeCall(endpoint, { command: cmd.command });
  if (cmd.type === 'write') return bridgeCall(endpoint, { path: cmd.path, content: cmd.content });
  if (cmd.type === 'read') return bridgeCall(endpoint, { path: cmd.path });
  if (cmd.type === 'list') return bridgeCall(endpoint, { path: cmd.path });
  return { ok: false, error: 'Unknown command' };
}

function formatResultForAI(cmd, result) {
  const ok = result && result.ok;
  if (!ok) return `[${cmd.type}] ERROR: ${(result && result.error) || 'unknown'}`;
  if (cmd.type === 'exec') return `[exec] exit=${result.exit_code}\nSTDOUT:\n${(result.stdout || '').slice(0, 4000)}\nSTDERR:\n${(result.stderr || '').slice(0, 2000)}`;
  if (cmd.type === 'write') return `[write] ok path=${result.path} bytes=${result.bytes}`;
  if (cmd.type === 'read') return `[read] path=${result.path}\n${(result.content || '').slice(0, 4000)}`;
  if (cmd.type === 'list') return `[list] path=${result.path}\n` + (result.items || []).map(i => (i.is_dir ? 'D ' : 'F ') + i.name).join('\n');
  return '[unknown]';
}

async function fetchBridgeReply(history) {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: history[history.length - 1].content,
      history: history.slice(0, -1).map(h => ({ role: h.role, content: h.content })),
      model: __bridge.model,
      stream: false,
      bridge: { connected: true, name: __bridge.name, model: __bridge.model, mode: 'developer' },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data.reply || data.choices?.[0]?.message?.content || '';
}

async function runBridgeTurn(userText) {
  if (!__bridge.connected) {
    setBwHint('Bridge is not connected. Click "Connect" first.', 'err');
    return;
  }
  if (bridgeRunning) { bridgeLog('Already running a turn…', 'err'); return; }
  bridgeRunning = true;
  updateBridgeSendBtn();

  addBridgeMsg('user', userText);
  bridgeConversation.push({ role: 'user', content: userText });

  const MAX_ITER = 8;
  let iter = 0;

  while (iter++ < MAX_ITER) {
    setBridgeStatus('Thinking…', 'think');
    let reply = '';
    try {
      reply = await fetchBridgeReply(bridgeConversation);
    } catch (e) {
      addBridgeMsg('system', 'AI error: ' + e.message);
      bridgeLog('AI error: ' + e.message, 'err');
      break;
    }
    if (!reply.trim()) { addBridgeMsg('system', 'Empty reply from AI'); break; }

    addBridgeMsg('ai', reply);
    bridgeConversation.push({ role: 'assistant', content: reply });

    // Trim history to prevent overflow
    if (bridgeConversation.length > 30) bridgeConversation = bridgeConversation.slice(-30);

    const cmds = extractBridgeCommands(reply);
    if (cmds.length === 0) break;

    setBridgeStatus('Executing ' + cmds.length + ' command(s)…', 'exec');
    const resultLines = [];
    for (const cmd of cmds) {
      bridgeLog(`→ ${cmd.type}: ${(cmd.command || cmd.path || '').slice(0, 80)}`, 'info');
      let result;
      try {
        result = await executeBridgeCommand(cmd);
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      addBridgeCmdResult(cmd, result);
      resultLines.push(formatResultForAI(cmd, result));
      bridgeLog(`${result.ok ? '✓' : '✗'} ${cmd.type}`, result.ok ? 'ok' : 'err');
    }

    const resultsBlock = resultLines.join('\n\n');
    const nextUser = `[Bridge results]\n${resultsBlock}\n\nContinue with the next step. If the task is completely done, reply with exactly "DONE" and nothing else.`;
    bridgeConversation.push({ role: 'user', content: nextUser });

    // loop continues — AI will get these results and may reply with more commands
  }

  if (iter >= MAX_ITER) {
    addBridgeMsg('system', 'Reached iteration limit — say "continue" to keep going.');
  }
  setBridgeStatus('Ready', 'idle');
  bridgeRunning = false;
  updateBridgeSendBtn();
}

function setBridgeStatus(text, mode = 'idle') {
  const pill = $('#bwStatusPill');
  const box = $('#bwStatusBox');
  const dotClass = __bridge.connected ? 'online' : 'offline';
  const label = __bridge.connected ? text : 'Disconnected';
  [pill, box].forEach(el => {
    if (!el) return;
    const dot = el.querySelector('.bridge-status-dot');
    const txt = el.querySelector('span:not(.bridge-status-dot)') || el.querySelector('span');
    if (dot) { dot.className = 'bridge-status-dot ' + dotClass; }
    if (txt) txt.textContent = label;
  });
  const bwConnect = $('#bwConnectBtn'), bwDisconnect = $('#bwDisconnectBtn');
  if (bwConnect) bwConnect.style.display = __bridge.connected ? 'none' : 'flex';
  if (bwDisconnect) bwDisconnect.style.display = __bridge.connected ? 'flex' : 'none';
  const sendBtn = $('#bridgeSendBtn');
  if (sendBtn) {
    const disabled = !__bridge.connected || bridgeRunning;
    sendBtn.classList.toggle('is-disabled', disabled);
    sendBtn.setAttribute('aria-disabled', String(disabled));
  }
}

function updateBridgeSendBtn() {
  const sendBtn = $('#bridgeSendBtn'), inp = $('#bridgeInput');
  if (!sendBtn || !inp) return;
  const hasText = inp.value.trim().length > 0;
  const disabled = !__bridge.connected || bridgeRunning || !hasText;
  sendBtn.classList.toggle('is-disabled', disabled);
  sendBtn.setAttribute('aria-disabled', String(disabled));
}

function handleBridgeSend() {
  const inp = $('#bridgeInput');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text || bridgeRunning || !__bridge.connected) return;
  inp.value = '';
  inp.style.height = 'auto';
  updateBridgeSendBtn();
  runBridgeTurn(text);
}

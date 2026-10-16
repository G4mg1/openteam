(function () {
  'use strict';
  if (window.MiroxExt) return;

  const S = { settings: null, tools: false };
  const TABS = { persona: 'Persona', personal: 'Personalization', memory: 'Memory', tools: 'Tools', mcp: 'MCP servers' };
  let tab = 'persona';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (id) => document.getElementById(id);

  async function api(path, body) {
    const r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  async function load() {
    try {
      S.settings = (await api('/api/settings')).settings;
      S.tools = !!S.settings.tools;
    } catch {
      S.settings = null;
    }
  }

  async function save(patch) {
    const j = await api('/api/settings', { ...S.settings, ...patch });
    S.settings = j.settings;
    S.tools = !!S.settings.tools;
  }

  function build() {
    if (el('mxExtOverlay')) return;
    const gear = document.createElement('button');
    gear.id = 'mxExtGear';
    gear.className = 'mx-gear';
    gear.setAttribute('aria-label', 'Settings');
    gear.textContent = '⚙';
    gear.onclick = openSettings;
    document.body.appendChild(gear);

    const ov = document.createElement('div');
    ov.id = 'mxExtOverlay';
    ov.className = 'mx-ov';
    ov.hidden = true;
    ov.innerHTML = `<div class="mx-modal" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="mx-head"><strong>Settings</strong><button class="mx-x" aria-label="Close">✕</button></div>
      <div class="mx-tabs">${Object.entries(TABS).map(([k, v]) => `<button data-tab="${k}">${v}</button>`).join('')}</div>
      <div class="mx-body"></div>
      <div class="mx-msg" aria-live="polite"></div>
    </div>`;
    document.body.appendChild(ov);

    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('.mx-x')) close(); });
    ov.querySelector('.mx-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) { tab = b.dataset.tab; render(); }
    });
    ov.querySelector('.mx-body').addEventListener('click', onBodyClick);
  }

  function render() {
    const ov = el('mxExtOverlay');
    const body = ov.querySelector('.mx-body');
    ov.querySelector('.mx-msg').textContent = '';
    ov.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    const s = S.settings;
    if (!s) { body.innerHTML = '<p class="mx-note">Log in to save your settings.</p>'; return; }
    const p = s.personalization || {};

    if (tab === 'persona') {
      body.innerHTML = `
        <label>Persona<textarea id="mxPersona" rows="6" maxlength="1000" placeholder="e.g. Be a blunt senior engineer. Keep answers short.">${esc(s.persona)}</textarea></label>
        <p class="mx-note">Describes how Mirox should act and speak in every chat.</p>
        <button class="mx-btn" data-save="persona">Save</button>`;
    } else if (tab === 'personal') {
      body.innerHTML = `
        <label>Your name<input type="text" id="mxName" maxlength="60" value="${esc(p.name)}"></label>
        <label>What to call you<input type="text" id="mxNick" maxlength="60" value="${esc(p.nickname)}"></label>
        <label>About you<textarea id="mxAbout" rows="4" maxlength="1500" placeholder="Your job, interests, goals…">${esc(p.about)}</textarea></label>
        <label>Tone<select id="mxTone">
          ${['default', 'friendly', 'concise', 'formal', 'playful'].map((t) => `<option value="${t}" ${p.tone === t ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}
        </select></label>
        <button class="mx-btn" data-save="personal">Save</button>`;
    } else if (tab === 'memory') {
      body.innerHTML = `
        <label class="mx-row"><input type="checkbox" id="mxMemOn" ${s.memory_enabled ? 'checked' : ''}> Let Mirox remember things about me</label>
        <button class="mx-btn ghost" data-save="memory">Save</button>
        <div class="mx-row"><input type="text" id="mxNewMem" maxlength="300" placeholder="Add a memory, e.g. I'm allergic to peanuts"><button class="mx-btn" data-add-mem="1">Add</button></div>
        <ul class="mx-list">${s.memory.length ? s.memory.map((m, i) => `<li><span>${esc(m)}</span><button class="mx-btn ghost" data-del-mem="${i}">Delete</button></li>`).join('') : '<li>No memories yet.</li>'}</ul>`;
    } else if (tab === 'tools') {
      body.innerHTML = `
        <label class="mx-row"><input type="checkbox" id="mxToolsOn" ${s.tools ? 'checked' : ''}> Let Mirox use tools</label>
        <ul class="mx-note" style="padding-left:18px;margin:0">
          <li>Extract and create zip files</li>
          <li>Read, write and list files in your private workspace</li>
          <li>Fetch web pages</li>
          <li>Save memories you ask it to keep</li>
          <li>Any MCP server you connect</li>
        </ul>
        <button class="mx-btn" data-save="tools">Save</button>`;
    } else if (tab === 'mcp') {
      body.innerHTML = `
        <ul class="mx-list">${s.mcp_servers.length ? s.mcp_servers.map((srv, i) => `<li><span><strong>${esc(srv.name)}</strong> <small>${esc(srv.url || '')}</small></span><button class="mx-btn ghost" data-del-srv="${i}">Remove</button></li>`).join('') : '<li>No MCP servers connected.</li>'}</ul>
        <div class="mx-row"><input type="text" id="mxSrvName" maxlength="60" placeholder="Name"></div>
        <div class="mx-row"><input type="text" id="mxSrvUrl" maxlength="500" placeholder="https://your-mcp-server/mcp"><button class="mx-btn" data-add-srv="1">Add</button></div>
        <p class="mx-note">Servers must be reachable over HTTPS. Turn on Tools in the Tools tab to let Mirox call them.</p>`;
    }
  }

  async function onBodyClick(e) {
    const t = e.target.closest('button');
    if (!t) return;
    const msg = el('mxExtOverlay').querySelector('.mx-msg');
    try {
      if (t.dataset.save === 'persona') await save({ persona: el('mxPersona').value });
      else if (t.dataset.save === 'personal') await save({ personalization: { name: el('mxName').value, nickname: el('mxNick').value, about: el('mxAbout').value, tone: el('mxTone').value } });
      else if (t.dataset.save === 'memory') await save({ memory_enabled: el('mxMemOn').checked });
      else if (t.dataset.save === 'tools') await save({ tools: el('mxToolsOn').checked });
      else if (t.dataset.addMem) {
        const v = el('mxNewMem').value.trim();
        if (v) await save({ memory: [...S.settings.memory, v] });
      } else if (t.dataset.delMem !== undefined) {
        await save({ memory: S.settings.memory.filter((_, i) => i !== Number(t.dataset.delMem)) });
      } else if (t.dataset.addSrv) {
        const url = el('mxSrvUrl').value.trim();
        const name = el('mxSrvName').value.trim() || 'MCP server';
        if (!url) throw new Error('Enter a server URL');
        const id = 'srv' + Date.now().toString(36);
        await save({ mcp_servers: [...S.settings.mcp_servers, { id, name, transport: 'http', url, enabled: true }] });
      } else if (t.dataset.delSrv !== undefined) {
        await save({ mcp_servers: S.settings.mcp_servers.filter((_, i) => i !== Number(t.dataset.delSrv)) });
      }
      render();
      if (t.dataset.save) el('mxExtOverlay').querySelector('.mx-msg').textContent = 'Saved';
    } catch (err) {
      msg.textContent = err.message;
    }
  }

  function close() { const ov = el('mxExtOverlay'); if (ov) ov.hidden = true; }

  function openSettings() {
    build();
    load().then(() => {
      el('mxExtOverlay').hidden = false;
      render();
    });
  }

  // Shows a tool call as a chip above the answer. Called from script.js for each {tool} event.
  function onTool(evt, msgEl) {
    if (!msgEl) return;
    const body = msgEl.querySelector('.message-body') || msgEl;
    let box = body.querySelector('.mx-tools');
    if (!box) {
      box = document.createElement('div');
      box.className = 'mx-tools';
      body.insertBefore(box, body.firstChild);
    }
    if (evt.status === 'running') {
      const chip = document.createElement('div');
      chip.className = 'mx-chip';
      chip.dataset.name = evt.name;
      chip.dataset.state = 'running';
      chip.innerHTML = `<i class="mx-spin"></i><span>${esc(evt.name)}</span><small>${esc(evt.args || '')}</small>`;
      box.appendChild(chip);
      return;
    }
    const chip = [...box.querySelectorAll('.mx-chip')].reverse().find((c) => c.dataset.name === evt.name && c.dataset.state === 'running');
    if (!chip) return;
    chip.dataset.state = evt.status;
    chip.querySelector('small').textContent = evt.summary || '';
  }

  window.MiroxExt = {
    toolsOn: () => S.tools,
    openSettings,
    onTool,
  };

  build();
  load();
})();

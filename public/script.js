/* MiroxAI — Frontend v35 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getDatabase, ref, set, get, update, push, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

const FIREBASE_CONFIG = { databaseURL:'https://miroxdata-default-rtdb.europe-west1.firebasedatabase.app/' };
const firebaseApp = initializeApp(FIREBASE_CONFIG);
const db = getDatabase(firebaseApp);
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const FALLBACK_MODELS = [
  { id:'mirox-luna-1.2', label:'Luna', tagline:'Fast · warm · free', default:true },
  { id:'mirox-gen-1', label:'Gen', tagline:'Ultra concise' },
  { id:'mirox-pro-5', label:'Pro', tagline:'Balanced · deeper' },
  { id:'mirox-ultra-10', label:'Ultra', tagline:'Deep reasoning' },
  { id:'mirox-eclipse-2.0', label:'Eclipse', tagline:'Best quality' },
];

let __config = null, __user = null, __tier = 'free', __model = 'mirox-luna-1.2';
let currentConversationId = null, isReplying = false, __conversations = [], pendingFiles = [];
let bgState = { url:null, dim:45 };
let recognition = null, callRecognition = null, synth = window.speechSynthesis;
let callActive = false, callMuted = false, activeStreamController = null;

const LS_KEY='miroxai_conversations_v17', TOKEN_KEY='mirox_token';
const USER_SETTINGS_KEY='miroxai_user_settings_v17', DEVICE_ID_KEY='mirox_device_id';
const APPEARANCE_KEY='miroxai_appearance_v17', BG_KEY='miroxai_bg_v17';
const MCP_KEY='miroxai_mcp_v17', FEEDBACK_KEY='miroxai_feedback_v17';

function killLoader(){ const l=document.getElementById('loadingScreen'); if(l){l.classList.add('hidden'); setTimeout(()=>l.style.display='none',400);} }
killLoader(); setTimeout(killLoader,500); setTimeout(killLoader,1800);

const uid = () => 'c_'+Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);
const escapeHtml = s => { const d=document.createElement('div'); d.textContent = s==null?'':String(s); return d.innerHTML; };
function getDeviceId(){ let id=localStorage.getItem(DEVICE_ID_KEY); if(!id){id='dev_'+uid(); localStorage.setItem(DEVICE_ID_KEY,id);} return id; }
function getToken(){ try{return localStorage.getItem(TOKEN_KEY)||'';}catch{return '';} }
function setToken(t){ try{t?localStorage.setItem(TOKEN_KEY,t):localStorage.removeItem(TOKEN_KEY);}catch{} }

async function authJson(url, opts={}, fallback=null){
  try {
    const headers = { 'Content-Type':'application/json', ...(opts.headers||{}) };
    const t = getToken(); if(t) headers.Authorization = 'Bearer '+t;
    const r = await fetch(url, { ...opts, headers, credentials:'same-origin', cache:'no-store' });
    const ct = (r.headers.get('content-type')||'').toLowerCase();
    if(!ct.includes('application/json')) return fallback;
    return await r.json();
  } catch { return fallback; }
}
async function saveToFirebase(path,data){ try{await set(ref(db,path),data);}catch{} }
async function updateFirebase(path,data){ try{await update(ref(db,path),data);}catch{} }
async function readFromFirebase(path){ try{const s=await get(ref(db,path)); return s.exists()?s.val():null;}catch{return null;} }
async function pushToFirebase(path,data){ try{const r=push(ref(db,path)); await set(r,{...data,_ts:serverTimestamp()});}catch{} }

function openModal(id){ document.getElementById(id)?.classList.add('open'); }
function closeModal(id){ document.getElementById(id)?.classList.remove('open'); }
function openSidebar(){ $('#sidebar')?.classList.add('open'); $('#sidebarScrim')?.classList.add('open'); }
function closeSidebar(){ $('#sidebar')?.classList.remove('open'); $('#sidebarScrim')?.classList.remove('open'); }

let userSettings = { soundOn:true, notifOn:true, highlightOn:true, lineNumbers:false, language:'en-US', voiceRate:1 };
function loadUserSettings(){ try{userSettings={...userSettings,...JSON.parse(localStorage.getItem(USER_SETTINGS_KEY)||'{}')};}catch{} }
function saveUserSettings(){ try{localStorage.setItem(USER_SETTINGS_KEY,JSON.stringify(userSettings));}catch{} }
function loadFeedback(){ try{return JSON.parse(localStorage.getItem(FEEDBACK_KEY)||'{}');}catch{return {};} }
function saveFeedback(fb){ try{localStorage.setItem(FEEDBACK_KEY,JSON.stringify(fb));}catch{} }

function loadAppearance(){
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(APPEARANCE_KEY)||'{}'); } catch {}
  if(!prefs.mode && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) prefs.mode='dark';
  applyAppearance(prefs);
}
function applyAppearance(prefs){
  const root = document.documentElement;
  const mode = prefs.mode || root.getAttribute('data-mode') || 'light';
  const theme = prefs.theme || root.getAttribute('data-theme') || 'default';
  const corner = prefs.corner || root.getAttribute('data-corner') || 'soft';
  root.setAttribute('data-mode',mode); root.setAttribute('data-theme',theme); root.setAttribute('data-corner',corner);
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify({mode,theme,corner})); } catch {}
  $$('[data-mode]').forEach(b=>b.classList.toggle('active', b.dataset.mode===mode));
  $$('.swatch').forEach(b=>b.classList.toggle('active', b.dataset.theme===theme));
  $$('[data-corner]').forEach(b=>b.classList.toggle('active', b.dataset.corner===corner));
}

/* FIXED: Background with subtle gradient fallback (no ugly sector) */
function loadBgPrefs(){ try{bgState={...bgState,...JSON.parse(localStorage.getItem(BG_KEY)||'{}')};}catch{}; applyBackground(); }
function applyBackground(){
  if(bgState.url){
    document.body.style.backgroundImage = `linear-gradient(rgba(20,15,10,${bgState.dim/100}), rgba(20,15,10,${bgState.dim/100})), url("${bgState.url}")`;
    document.body.style.backgroundSize='cover';
    document.body.style.backgroundPosition='center';
    document.body.style.backgroundAttachment='fixed';
  } else {
    /* Subtle warm gradient — never looks "exposed" when no image */
    document.body.style.backgroundImage = 'radial-gradient(circle at 20% 0%, rgba(201,100,66,0.05), transparent 45%), radial-gradient(circle at 80% 100%, rgba(201,100,66,0.04), transparent 45%)';
    document.body.style.backgroundSize='cover, cover';
    document.body.style.backgroundPosition='center';
    document.body.style.backgroundAttachment='fixed';
  }
}
function saveBgPrefs(){ try{localStorage.setItem(BG_KEY, JSON.stringify(bgState));}catch{} }

function loadMcp(){ let servers=[]; try{servers=JSON.parse(localStorage.getItem(MCP_KEY)||'[]');}catch{}; renderMcp(servers); }
function saveMcp(servers){ try{localStorage.setItem(MCP_KEY, JSON.stringify(servers));}catch{}; renderMcp(servers); }
function renderMcp(servers){
  const list = $('#mcpList'); if(!list) return;
  if(!servers.length){ list.innerHTML = '<div style="font-size:12.5px;color:var(--text-faint);padding:4px 0;">No MCP servers configured.</div>'; return; }
  list.innerHTML = servers.map((s,i)=>`
    <div class="mcp-item">
      <div class="mcp-item-status ${s.enabled?'on':''}"></div>
      <div class="mcp-item-info">
        <div class="mcp-item-name">${escapeHtml(s.name||'Unnamed')}</div>
        <div class="mcp-item-url">${escapeHtml(s.url||'')}</div>
      </div>
      <button class="icon-btn mcp-toggle" data-idx="${i}"><i class="ri-${s.enabled?'pause-circle-line':'play-circle-line'}"></i></button>
      <button class="icon-btn mcp-remove" data-idx="${i}"><i class="ri-delete-bin-line"></i></button>
    </div>`).join('');
}

/* Markdown renderer (with tables) */
function renderMarkdown(text){
  if(!text) return '';
  let src = String(text);
  const entireWrap = src.match(/^\s*```([a-zA-Z0-9+#._-]*)\s*\n([\s\S]*?)\n?```\s*$/);
  if(entireWrap && ['','markdown','md','text'].includes((entireWrap[1]||'').toLowerCase())) src = entireWrap[2];
  const parts = [];
  const fenceRe = /```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)```/g;
  let last = 0, m;
  while((m = fenceRe.exec(src)) !== null){
    if(m.index > last) parts.push({ type:'text', content: src.slice(last, m.index) });
    parts.push({ type:'code', lang:(m[1]||'').trim(), content:m[2] });
    last = fenceRe.lastIndex;
  }
  if(last < src.length) parts.push({ type:'text', content:src.slice(last) });
  return parts.map(p => p.type==='code' ? renderCodeBlock(p.lang,p.content) : renderTextBlock(p.content)).join('');
}
function renderCodeBlock(lang, code){
  const label = (lang||'Code').toUpperCase();
  const cls = 'language-'+(lang||'').toLowerCase();
  const raw = String(code||'').replace(/\n$/,'');
  const lines = raw.split('\n');
  const codeHtml = lines.map(l=>escapeHtml(l)).join('\n');
  let gutter = '';
  if(userSettings.lineNumbers){ let g=''; for(let i=1;i<=lines.length;i++) g+=i+'\n'; gutter = `<div class="code-gutter">${g}</div>`; }
  return `<div class="code-block">
    <div class="code-block-header"><span>${escapeHtml(label)}</span>
      <button class="code-action-btn" data-copy><i class="ri-file-copy-line"></i> Copy</button>
    </div>
    <div class="code-block-body">${gutter}<pre><code class="${cls}">${codeHtml}</code></pre></div>
  </div>`;
}
function isTableSeparator(line){ const t=line.trim(); if(!t.startsWith('|')) return false; return /^\|[\s:|-]+\|?\s*$/.test(t) && /-/.test(t); }
function parseTableRow(line){ let s=line.trim(); if(s.startsWith('|')) s=s.slice(1); if(s.endsWith('|')) s=s.slice(0,-1); return s.split('|').map(c=>c.trim()); }

function renderTextBlock(text){
  const lines = String(text).split('\n');
  let out='', buf=[], listMode=null;
  const flush = () => { if(buf.length){ out += `<p>${inlineFmt(buf.join(' ').trim())}</p>`; buf=[]; } };
  const closeList = () => { if(listMode){ out += listMode==='ul'?'</ul>':'</ol>'; listMode=null; } };
  let i=0;
  while(i < lines.length){
    const raw = lines[i]; const t = raw.trim();
    if(t.startsWith('|') && i+1 < lines.length && isTableSeparator(lines[i+1])){
      flush(); closeList();
      const headers = parseTableRow(t);
      const aligns = parseTableRow(lines[i+1]).map(c=>{
        const left=c.startsWith(':'), right=c.endsWith(':');
        if(left&&right) return 'center';
        if(right) return 'right';
        return 'left';
      });
      const rows=[];
      let j=i+2;
      while(j < lines.length){
        const rt = lines[j].trim();
        if(!rt.startsWith('|')) break;
        if(isTableSeparator(rt)) break;
        rows.push(parseTableRow(rt));
        j++;
      }
      let tbl = '<div class="table-wrap"><table class="md-table"><thead><tr>';
      headers.forEach((h,k)=>{ tbl += `<th style="text-align:${aligns[k]||'left'}">${inlineFmt(h)}</th>`; });
      tbl += '</tr></thead><tbody>';
      rows.forEach(row=>{
        tbl += '<tr>';
        for(let k=0;k<headers.length;k++) tbl += `<td style="text-align:${aligns[k]||'left'}">${inlineFmt(row[k]||'')}</td>`;
        tbl += '</tr>';
      });
      tbl += '</tbody></table></div>';
      out += tbl;
      i = j; continue;
    }
    if(!t){ flush(); closeList(); i++; continue; }
    const hm = t.match(/^(#{1,4})\s+(.+)$/);
    if(hm){ flush(); closeList(); const lvl=Math.min(4,hm[1].length); out += `<h${lvl}>${inlineFmt(hm[2])}</h${lvl}>`; i++; continue; }
    const hr = t.match(/^(-{3,}|\*{3,}|_{3,})$/);
    if(hr){ flush(); closeList(); out += '<hr>'; i++; continue; }
    const um = t.match(/^[-*+]\s+(.+)$/);
    if(um){ flush(); if(listMode!=='ul'){ closeList(); out+='<ul>'; listMode='ul'; } out += `<li>${inlineFmt(um[1])}</li>`; i++; continue; }
    const om = t.match(/^(\d+)\.\s+(.+)$/);
    if(om){ flush(); if(listMode!=='ol'){ closeList(); out+='<ol>'; listMode='ol'; } out += `<li>${inlineFmt(om[2])}</li>`; i++; continue; }
    const qm = t.match(/^>\s*(.+)$/);
    if(qm){ flush(); closeList(); out += `<blockquote>${inlineFmt(qm[1])}</blockquote>`; i++; continue; }
    closeList();
    buf.push(t);
    i++;
  }
  flush(); closeList();
  return out;
}
function inlineFmt(t){
  const codes = [];
  t = String(t).replace(/`([^`]+)`/g, (_,c)=>{ codes.push(c); return `\u0001${codes.length-1}\u0001`; });
  t = escapeHtml(t);
  t = t.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/\u0001(\d+)\u0001/g, (_,i)=>`<code>${escapeHtml(codes[+i])}</code>`);
  return t;
}
function renderBubble(bubble, text){
  if(!bubble) return;
  bubble.classList.remove('thinking');
  if(!userSettings.highlightOn){ bubble.textContent = text||''; return; }
  bubble.innerHTML = renderMarkdown(text||'');
  highlightCode(bubble); wireCodeButtons(bubble);
}
function highlightCode(scope){
  if(!window.hljs) return;
  (scope||document).querySelectorAll('.code-block pre code').forEach(el=>{
    if(el.dataset.hl) return;
    const raw = el.textContent||'';
    try {
      const m = (el.className||'').match(/language-([a-z0-9+#-]+)/i);
      const r = (m && window.hljs.getLanguage(m[1])) ? window.hljs.highlight(raw,{language:m[1],ignoreIllegals:true}) : window.hljs.highlightAuto(raw);
      el.innerHTML = r.value; el.classList.add('hljs');
    } catch {}
    el.dataset.hl = '1';
  });
}
function wireCodeButtons(scope){
  (scope||document).querySelectorAll('.code-block .code-action-btn[data-copy]').forEach(btn=>{
    if(btn.__wired) return;
    btn.__wired = true;
    btn.addEventListener('click', async e=>{
      e.preventDefault(); e.stopPropagation();
      const text = btn.closest('.code-block')?.querySelector('pre code')?.textContent||'';
      try {
        if(navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
        else { const ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.top='-1000px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
        btn.innerHTML = '<i class="ri-check-line"></i> Copied';
        btn.classList.add('copied');
        setTimeout(()=>{ btn.innerHTML = '<i class="ri-file-copy-line"></i> Copy'; btn.classList.remove('copied'); }, 1400);
      } catch {}
    });
  });
}

/* Conversations */
function currentConvo(){ return __conversations.find(c=>c.id===currentConversationId)||null; }
function saveChatsToLS(){ try{localStorage.setItem(LS_KEY, JSON.stringify(__conversations));}catch{}; if(__user) saveToFirebase(`chats/${__user.email}/conversations`, __conversations); }
function loadChatsFromLS(){ try{__conversations = JSON.parse(localStorage.getItem(LS_KEY)||'[]');}catch{__conversations=[];} }
async function loadChatsFromFirebase(){ if(!__user) return; const data = await readFromFirebase(`chats/${__user.email}/conversations`); if(Array.isArray(data)&&data.length){ __conversations=data; saveChatsToLS(); renderHistory(); } }
function getWelcomeHTML(){
  return `<div class="welcome-screen">
    <img src="/logo.png" alt="MiroxAI" class="welcome-logo theme-aware-logo" onerror="this.style.display='none'; this.nextElementSibling.style.display='grid';">
    <div class="logo-fallback logo-fallback-lg" style="display:none;">M</div>
    <h1 class="welcome-title">Hi, I'm Mirox</h1>
    <p class="welcome-sub">Built by the OpenSurr team. Ask anything, attach images or files, or start a voice call.</p>
    <div class="suggestion-grid">
      <button class="suggestion-card" type="button" data-prompt="What would you like to talk about?"><i class="ri-chat-3-line"></i><span>What would you like to talk about?</span></button>
      <button class="suggestion-card" type="button" data-prompt="Help me write code"><i class="ri-code-line"></i><span>Help me write code</span></button>
      <button class="suggestion-card" type="button" data-prompt="Explain a concept simply"><i class="ri-lightbulb-line"></i><span>Explain a concept simply</span></button>
      <button class="suggestion-card" type="button" data-prompt="Generate an image"><i class="ri-image-line"></i><span>Generate an image</span></button>
    </div>
  </div>`;
}
function startNewChat(){ currentConversationId=null; $('#chatTitle').textContent='New chat'; $('#chatMessages').innerHTML=getWelcomeHTML(); bindSuggestionClicks(); renderHistory(); }
function bindSuggestionClicks(){
  $$('.suggestion-card').forEach(card=>{
    if(card.__wired) return;
    card.__wired = true;
    card.onclick = () => {
      const prompt = card.dataset.prompt;
      if(prompt && $('#messageInput')){ $('#messageInput').value = prompt; updateSendButtonState(); handleSend(); }
    };
  });
}
function openConversationLS(id){
  const c = __conversations.find(x=>x.id===id); if(!c) return;
  currentConversationId = id;
  $('#chatTitle').textContent = c.title||'Chat';
  const container = $('#chatMessages');
  container.innerHTML = '';
  for(const msg of c.messages||[]) addMessageToDOM(msg.role, msg.content, msg.ts, false, msg.id);
  renderHistory(); scrollToBottom();
}
function renderHistory(){
  const list = $('#historyList'); if(!list) return;
  if(!__conversations.length){ list.innerHTML = '<li class="history-empty">No conversations yet</li>'; return; }
  list.innerHTML = __conversations.map(c=>`
    <li class="history-item${c.id===currentConversationId?' active':''}" data-id="${c.id}">
      <i class="ri-chat-3-line"></i>
      <span class="history-title">${escapeHtml(c.title||'Chat')}</span>
      <button class="history-delete icon-btn"><i class="ri-delete-bin-line"></i></button>
    </li>`).join('');
}
function scrollToBottom(){ const c = $('#chatMessages'); if(c) c.scrollTop = c.scrollHeight; }

function buildActions(role, msgId){
  if(role === 'ai') return `
    <div class="message-actions" data-msg-id="${msgId}">
      <button class="action-btn" data-action="copy" title="Copy"><i class="ri-file-copy-line"></i></button>
      <button class="action-btn" data-action="retry" title="Regenerate"><i class="ri-refresh-line"></i></button>
      <button class="action-btn" data-action="good" title="Good"><i class="ri-thumb-up-line"></i></button>
      <button class="action-btn" data-action="bad" title="Bad"><i class="ri-thumb-down-line"></i></button>
    </div>`;
  return `
    <div class="message-actions" data-msg-id="${msgId}">
      <button class="action-btn" data-action="copy" title="Copy"><i class="ri-file-copy-line"></i></button>
      <button class="action-btn" data-action="edit" title="Edit"><i class="ri-edit-line"></i></button>
    </div>`;
}
function addMessageToDOM(role, content, ts, animate=true, msgId=null){
  const container = $('#chatMessages'); if(!container) return null;
  const welcome = container.querySelector('.welcome-screen'); if(welcome) welcome.remove();
  const id = msgId || uid();
  const msgEl = document.createElement('div');
  msgEl.className = `message ${role==='user'?'user':'ai'}`;
  msgEl.dataset.msgId = id; msgEl.dataset.role = role;
  msgEl.innerHTML = `
    <div class="message-content">
      <div class="bubble"></div>
      ${buildActions(role, id)}
      <div class="message-time">${ts?new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):''}</div>
    </div>`;
  container.appendChild(msgEl);
  const bubble = msgEl.querySelector('.bubble');
  if(role === 'user') bubble.textContent = content;
  else renderBubble(bubble, content);
  wireMessageActions(msgEl); applyStoredFeedback(msgEl);
  if(animate) scrollToBottom();
  return msgEl;
}
function addThinkingBubble(){
  const container = $('#chatMessages'); if(!container) return null;
  const welcome = container.querySelector('.welcome-screen'); if(welcome) welcome.remove();
  const id = uid();
  const msgEl = document.createElement('div');
  msgEl.className = 'message ai'; msgEl.dataset.msgId = id; msgEl.dataset.role = 'ai'; msgEl.dataset.thinking='1';
  msgEl.innerHTML = `
    <div class="message-content">
      <div class="bubble thinking">
        <span class="thinking-text">Thinking</span>
        <span class="thinking-dots"><span></span><span></span><span></span></span>
      </div>
      <div class="message-actions" data-msg-id="${id}" style="opacity:0;pointer-events:none;">
        <button class="action-btn" data-action="copy" title="Copy"><i class="ri-file-copy-line"></i></button>
        <button class="action-btn" data-action="retry" title="Regenerate"><i class="ri-refresh-line"></i></button>
        <button class="action-btn" data-action="good" title="Good"><i class="ri-thumb-up-line"></i></button>
        <button class="action-btn" data-action="bad" title="Bad"><i class="ri-thumb-down-line"></i></button>
      </div>
      <div class="message-time"></div>
    </div>`;
  container.appendChild(msgEl); scrollToBottom();
  return msgEl;
}
function wireMessageActions(msgEl){
  const id = msgEl.dataset.msgId, role = msgEl.dataset.role;
  msgEl.querySelectorAll('.message-actions .action-btn').forEach(btn=>{
    if(btn.__wired) return; btn.__wired = true;
    btn.addEventListener('click', async e=>{
      e.preventDefault(); e.stopPropagation();
      const action = btn.dataset.action;
      const bubble = msgEl.querySelector('.bubble');
      const text = bubble?.innerText||'';
      if(action === 'copy'){
        try {
          if(navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
          else { const ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.top='-1000px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
          btn.classList.add('active'); btn.innerHTML = '<i class="ri-check-line"></i>';
          setTimeout(()=>{ btn.classList.remove('active'); btn.innerHTML = '<i class="ri-file-copy-line"></i>'; }, 1200);
        } catch {}
        return;
      }
      if(action === 'retry'){ if(role!=='ai') return; handleRetry(msgEl); return; }
      if(action === 'edit'){
        if(role !== 'user') return;
        const current = bubble?.textContent||'';
        const next = prompt('Edit message', current);
        if(next === null || !next.trim()) return;
        bubble.textContent = next.trim();
        const c = currentConvo();
        if(c){ const m = (c.messages||[]).find(x=>x.id===id); if(m){ m.content = next.trim(); saveChatsToLS(); } }
        return;
      }
      if(action === 'good' || action === 'bad'){
        const fb = loadFeedback();
        const currentlyGood = btn.classList.contains('active-good');
        const currentlyBad = btn.classList.contains('active-bad');
        msgEl.querySelectorAll('.action-btn[data-action="good"], .action-btn[data-action="bad"]').forEach(b=>b.classList.remove('active-good','active-bad'));
        if(action === 'good'){
          if(currentlyGood){ delete fb[id]; saveFeedback(fb); }
          else { fb[id]='good'; btn.classList.add('active-good'); saveFeedback(fb); recordFeedback(id,'good'); }
        } else {
          if(currentlyBad){ delete fb[id]; saveFeedback(fb); }
          else { fb[id]='bad'; btn.classList.add('active-bad'); saveFeedback(fb); recordFeedback(id,'bad'); }
        }
      }
    });
  });
}
function applyStoredFeedback(msgEl){
  const id = msgEl.dataset.msgId; const fb = loadFeedback();
  if(fb[id] === 'good') msgEl.querySelector('.action-btn[data-action="good"]')?.classList.add('active-good');
  else if(fb[id] === 'bad') msgEl.querySelector('.action-btn[data-action="bad"]')?.classList.add('active-bad');
}
function recordFeedback(id, kind){
  if(__user) pushToFirebase(`logs/feedback/${__user.email}`, { msg_id:id, kind, ts:Date.now(), device:getDeviceId() });
}
async function handleRetry(msgEl){
  if(isReplying) return;
  const id = msgEl.dataset.msgId;
  const convo = currentConvo(); if(!convo) return;
  const idx = (convo.messages||[]).findIndex(m=>m.id===id);
  if(idx < 0) return;
  let userMsg = null;
  for(let i=idx-1;i>=0;i--){ if(convo.messages[i].role==='user'){ userMsg = convo.messages[i]; break; } }
  if(!userMsg) return;
  convo.messages = convo.messages.slice(0, idx);
  saveChatsToLS();
  let el = msgEl.nextElementSibling;
  while(el){ const n = el.nextElementSibling; el.remove(); el = n; }
  msgEl.remove();
  sendToAPI(userMsg.content, { skipUserAppend:true });
}

function updateSendButtonState(){
  const btn = $('#sendBtn'), inp = $('#messageInput');
  if(!btn || !inp) return;
  const hasContent = inp.value.trim().length > 0 || pendingFiles.length > 0;
  const shouldEnable = hasContent && !isReplying;
  btn.classList.toggle('is-disabled', !shouldEnable);
  btn.setAttribute('aria-disabled', String(!shouldEnable));
}

function handleSend(){
  if(isReplying) return;
  const inp = $('#messageInput'); if(!inp) return;
  const text = inp.value.trim();
  if(!text && !pendingFiles.length) return;
  if(!currentConversationId){
    currentConversationId = uid();
    __conversations.unshift({ id:currentConversationId, title:text.slice(0,60)||'New chat', messages:[], created:Date.now() });
  }
  const msgId = uid();
  const convo = currentConvo();
  if(convo){ convo.messages.push({ id:msgId, role:'user', content:text, ts:Date.now() }); convo.updated = Date.now(); }
  addMessageToDOM('user', text, Date.now(), true, msgId);
  inp.value = ''; inp.style.height = 'auto';
  updateSendButtonState();
  saveChatsToLS(); renderHistory();
  sendToAPI(text);
}

async function sendToAPI(text, opts={}){
  isReplying = true; updateSendButtonState();
  const stopBtn = $('#stopBtn'); if(stopBtn) stopBtn.style.display = 'grid';
  const convo = currentConvo();
  const history = convo ? convo.messages.slice(-14).map(m=>({ role:m.role, content:m.content })) : [];
  const model = __model || 'mirox-luna-1.2';
  const msgEl = addThinkingBubble();
  const bubble = msgEl.querySelector('.bubble');
  const timeEl = msgEl.querySelector('.message-time');
  const aiMsgId = msgEl.dataset.msgId;
  activeStreamController = new AbortController();

  try {
    const res = await fetch('/v1/chat/completions', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ message:text, history, model, stream:true, files:pendingFiles }),
      signal: activeStreamController.signal,
    });
    if(!res.ok){
      const ct = (res.headers.get('content-type')||'').toLowerCase();
      let errMsg = `HTTP ${res.status}`;
      if(ct.includes('application/json')){ const err = await res.json().catch(()=>({})); errMsg = err.error||errMsg; }
      else { const txt = await res.text().catch(()=> ''); if(txt) errMsg = txt.slice(0,200); }
      throw new Error(errMsg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf='', full='', firstChunk=true;
    while(true){
      const { value, done } = await reader.read();
      if(done) break;
      buf += dec.decode(value, { stream:true });
      let idx;
      while((idx = buf.indexOf('\n')) !== -1){
        const line = buf.slice(0,idx).trim(); buf = buf.slice(idx+1);
        if(!line.startsWith('data:')) continue;
        const pl = line.slice(5).trim();
        if(!pl || pl === '[DONE]') continue;
        try {
          const o = JSON.parse(pl);
          if(o.d){
            full += o.d;
            if(firstChunk){
              bubble.classList.remove('thinking'); bubble.classList.add('streaming'); bubble.innerHTML='';
              firstChunk = false;
              const act = msgEl.querySelector('.message-actions');
              if(act){ act.style.opacity = ''; act.style.pointerEvents = ''; }
            }
            renderBubble(bubble, full);
            if(!bubble.classList.contains('streaming')) bubble.classList.add('streaming');
            scrollToBottom();
          }
          if(o.error) throw new Error(o.error);
          if(o.done){
            bubble.classList.remove('streaming');
            if(__user){
              __user.daily_used = o.daily_used;
              if(model === 'mirox-eclipse-2.0'){
                __user.eclipse_credits = (__user.eclipse_credits ?? 10) - 1;
                updateFirebase(`users/${__user.email}`, { eclipse_credits: __user.eclipse_credits });
              }
            }
          }
        } catch {}
      }
    }
    bubble.classList.remove('streaming');
    delete msgEl.dataset.thinking;
    const c = currentConvo();
    if(c){ c.messages.push({ id:aiMsgId, role:'assistant', content:full, ts:Date.now() }); c.updated = Date.now(); }
    saveChatsToLS();
    wireMessageActions(msgEl);
    if(__user) pushToFirebase(`logs/chat/${__user.email}`, { model, message:text.slice(0,500), reply:full.slice(0,1000), ts:Date.now(), device:getDeviceId() });
    if(timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  } catch (e) {
    bubble.classList.remove('streaming');
    if(e.name !== 'AbortError'){
      bubble.classList.remove('thinking');
      bubble.textContent = `Sorry, something went wrong: ${e.message}`;
      if(timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    } else {
      bubble.classList.remove('thinking');
      if(!bubble.textContent) bubble.textContent = '(stopped)';
    }
    delete msgEl.dataset.thinking;
    const act = msgEl.querySelector('.message-actions');
    if(act){ act.style.opacity = ''; act.style.pointerEvents = ''; }
    wireMessageActions(msgEl);
  } finally {
    isReplying = false;
    activeStreamController = null;
    const st = $('#stopBtn'); if(st) st.style.display = 'none';
    pendingFiles = []; updatePreview(); updateSendButtonState();
  }
}
function stopStreaming(){
  if(activeStreamController){ try{activeStreamController.abort();}catch{} activeStreamController = null; }
  isReplying = false;
  const st = $('#stopBtn'); if(st) st.style.display='none';
  updateSendButtonState();
}

function handleFiles(files){
  if(!files?.length) return;
  const arr = Array.from(files);
  let done = 0;
  const newFiles = [];
  arr.forEach((f, idx)=>{
    const isImg = (f.type||'').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(f.name);
    const r = new FileReader();
    if(isImg){
      r.onload = () => { newFiles.push({ name:f.name, size:f.size, type:'image', dataUrl:r.result, order:idx }); done++; if(done === arr.length) finish(); };
      r.onerror = () => { done++; if(done === arr.length) finish(); };
      r.readAsDataURL(f);
    } else {
      r.onload = () => { newFiles.push({ name:f.name, size:f.size, type:'text', content:String(r.result).slice(0,60000), order:idx }); done++; if(done === arr.length) finish(); };
      r.onerror = () => { done++; if(done === arr.length) finish(); };
      r.readAsText(f);
    }
  });
  function finish(){ newFiles.sort((a,b)=>(a.order||0)-(b.order||0)); pendingFiles = pendingFiles.concat(newFiles); updatePreview(); updateSendButtonState(); }
}
function updatePreview(){
  const p = $('#attachmentPreview'), list = $('#attachmentList'); if(!p||!list) return;
  if(!pendingFiles.length){ p.style.display='none'; list.innerHTML=''; return; }
  p.style.display = 'flex';
  list.innerHTML = pendingFiles.map(f => f.type==='image' && f.dataUrl
    ? `<div class="attach-chip"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name)}</div>`
    : `<div class="attach-chip"><i class="ri-file-line"></i>${escapeHtml(f.name)}</div>`).join('');
}

function getModelsList(){ if(__config?.models?.length) return __config.models; return FALLBACK_MODELS; }
function renderModelPicker(){
  const menu = $('#modelPickerMenu'); if(!menu) return;
  const models = getModelsList();
  const currentId = __model || models[0].id;
  menu.innerHTML = models.map(m=>`
    <div class="model-option${m.id===currentId?' active':''}" data-model-id="${m.id}">
      <span class="model-option-label"><span class="dot"></span>${escapeHtml(m.label)}</span>
      <span class="model-option-tag">${escapeHtml(m.tagline||'')}</span>
    </div>`).join('');
  menu.querySelectorAll('.model-option').forEach(opt=>{
    opt.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); selectModel(opt.dataset.modelId); };
  });
  const current = models.find(m=>m.id===currentId)||models[0];
  if(current && $('#currentModelLabel')) $('#currentModelLabel').textContent = current.label;
}
function selectModel(id){
  if(!id) return;
  __model = id;
  const models = getModelsList();
  const m = models.find(x=>x.id===id);
  if(m && $('#currentModelLabel')) $('#currentModelLabel').textContent = m.label;
  renderModelPicker(); closeModelPicker();
}
function openModelPicker(){ $('#modelPicker')?.classList.add('open'); $('#modelPickerMenu')?.classList.add('open'); }
function closeModelPicker(){ $('#modelPicker')?.classList.remove('open'); $('#modelPickerMenu')?.classList.remove('open'); }
function wireModelPicker(){
  const btn = $('#modelPickerBtn'); if(!btn) return;
  btn.addEventListener('pointerdown', (e)=>{
    e.preventDefault(); e.stopPropagation();
    const isOpen = $('#modelPickerMenu')?.classList.contains('open');
    if(isOpen) closeModelPicker(); else openModelPicker();
  });
  document.addEventListener('pointerdown', (e)=>{ if(!e.target.closest('#modelPicker')) closeModelPicker(); }, true);
  document.addEventListener('keydown', (e)=>{ if(e.key === 'Escape') closeModelPicker(); });
}

function wireSendButton(){
  const btn = $('#sendBtn'), inp = $('#messageInput'); if(!btn||!inp) return;
  btn.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); handleSend(); });
  inp.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); e.stopPropagation(); handleSend(); return false; }
  });
  inp.addEventListener('input', ()=>{
    updateSendButtonState();
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 180) + 'px';
  });
  inp.addEventListener('paste', ()=>setTimeout(updateSendButtonState, 10));
  updateSendButtonState();
}

async function doLogin(){
  const name = $('#loginName')?.value.trim();
  const email = $('#loginEmail')?.value.trim().toLowerCase();
  if(!name || !email) return;
  const res = await authJson('/api/auth/simple-login', { method:'POST', body:JSON.stringify({ name, email }) }, null);
  if(res?.ok && res.token){
    setToken(res.token); __user = res.user;
    closeModal('loginModal'); updateUserUI();
    updateFirebase(`users/${email}`, { email, name, tier:res.user.tier||'free', last_login:Date.now() });
    pushToFirebase(`logs/user/${email}`, { event:'signin', name, ts:Date.now(), device:getDeviceId() });
    loadChatsFromFirebase();
  } else { alert(res?.error||'Login failed'); }
}
async function doLogout(){
  const email = __user?.email;
  await authJson('/api/logout', { method:'POST' }, null);
  setToken(''); __user = null; __tier = 'free';
  if(email) pushToFirebase(`logs/user/${email}`, { event:'signout', ts:Date.now(), device:getDeviceId() });
  updateUserUI(); closeModal('settingsModal');
}
function updateUserUI(){
  const chip = $('#userChip'); if(!chip) return;
  if(__user){
    chip.querySelector('.user-name').textContent = __user.name||__user.email;
    chip.querySelector('.user-sub').textContent = `${(__tier||'free').charAt(0).toUpperCase() + (__tier||'free').slice(1)} plan`;
  } else {
    chip.querySelector('.user-name').textContent = 'Guest mode';
    chip.querySelector('.user-sub').textContent = 'Sign in to save chats';
  }
}
async function loadUser(){
  const res = await authJson('/api/me', {}, null);
  if(res?.user){
    __user = res.user;
    __tier = res.user.tier || 'free';
    const fbUser = await readFromFirebase(`users/${res.user.email}`);
    if(fbUser){ __user = { ...__user, ...fbUser }; __tier = fbUser.tier || 'free'; }
    updateUserUI(); loadChatsFromFirebase();
  } else {
    __tier = 'free'; updateUserUI(); loadChatsFromLS();
  }
}

async function loadConfig(){
  try {
    const res = await fetch('/api/config', { cache:'no-store' });
    const data = await res.json();
    if(data?.models?.length) __config = data; else __config = { models:FALLBACK_MODELS };
  } catch { __config = { models:FALLBACK_MODELS }; }
  const models = getModelsList();
  __model = models[0].id;
  renderModelPicker();
  if($('#currentModelLabel')) $('#currentModelLabel').textContent = models[0].label;
}

async function loadPlans(){
  const grid = $('#plansGrid'); if(!grid) return;
  const res = await authJson('/api/subscription/plans', {}, null);
  if(!res?.plans) return;
  grid.innerHTML = res.plans.map(p=>`
    <div class="plan-card${p.id === __tier ? ' current' : ''}">
      <div class="plan-name">${escapeHtml(p.label)}</div>
      <div class="plan-price">${p.price_robux ? p.price_robux+' Robux' : 'Free'}</div>
      <ul class="plan-perks">${(p.perks||[]).map(x=>`<li><i class="ri-check-line"></i> ${escapeHtml(x)}</li>`).join('')}</ul>
    </div>`).join('');
}

/* FIXED: keys shown inline, no alert popup */
async function loadUserKeys(){
  const list = $('#apiKeysList'), counter = $('#apiKeyCounter');
  if(!list) return;
  if(!__user){ list.innerHTML = '<div style="font-size:13px;color:var(--text-faint);">Sign in to see your API keys.</div>'; if(counter) counter.textContent = '(0/2 this month)'; return; }
  list.innerHTML = '<div style="font-size:12.5px;color:var(--text-faint);">Loading…</div>';
  const res = await authJson('/api/keys/list', {}, null);
  const used = res?.used ?? 0;
  const limit = res?.limit ?? 2;
  if(counter) counter.textContent = `(${used}/${limit} this month)`;
  if(!res?.keys?.length){ list.innerHTML = '<div style="font-size:13px;color:var(--text-faint);">No API keys yet.</div>'; return; }
  list.innerHTML = res.keys.map(k=>`<div class="api-key-item"><i class="ri-key-line"></i><span class="key-prefix">${escapeHtml(k.prefix)}…</span><span style="color:var(--text-faint);font-size:11px;margin-left:auto;">${k.created ? new Date(k.created*1000).toLocaleDateString() : ''}</span></div>`).join('');
}

async function genKey(){
  if(!__user){ alert('Sign in first to generate an API key.'); openModal('loginModal'); return; }
  const btn = $('#generateKeyBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Generating…'; }
  try {
    const res = await authJson('/api/keys/generate', { method:'POST' }, null);
    if(res?.ok && res.key){
      const newKeyDisplay = $('#newKeyDisplay'), newKeyValue = $('#newKeyValue');
      if(newKeyDisplay && newKeyValue){ newKeyDisplay.style.display = 'block'; newKeyValue.textContent = res.key; }
      loadUserKeys();
      if(__user){
        __user.keys_this_month = res.used;
        pushToFirebase(`logs/account/${__user.email}`, { event:'apikey_created', prefix:res.prefix, ts:Date.now() });
      }
    } else {
      alert(res?.error||'Failed to generate key.');
    }
  } catch (e) { alert('Network error: '+e.message); }
  finally { if(btn){ btn.disabled = false; btn.textContent = 'Generate key'; } }
}

async function genImage(){
  const prompt = $('#imagePrompt')?.value.trim();
  if(!prompt) return alert('Please describe the image.');
  const btn = $('#generateImageBtn'), result = $('#imageResult');
  if(btn){ btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line"></i> Generating…'; }
  if(result) result.innerHTML = `<div style="text-align:center;padding:20px;"><div class="bubble thinking" style="display:inline-flex;background:var(--panel);border:1px solid var(--border);padding:12px 16px;border-radius:16px;"><span class="thinking-text">Generating</span><span class="thinking-dots"><span></span><span></span><span></span></span></div></div>`;
  try {
    const res = await fetch('/v1/images/generations', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ prompt, aspect_ratio:$('#imageAspect')?.value || '1:1' }),
    });
    const data = await res.json().catch(()=>({}));
    if(res.ok && data.ok && data.image){
      if(result) result.innerHTML = `<img src="${data.image}" alt="${escapeHtml(prompt)}" loading="lazy">`;
      if(__user) pushToFirebase(`logs/image/${__user.email}`, { prompt:prompt.slice(0,300), model:'Lumenal 1.0', ts:Date.now() });
    } else {
      const errMsg = data.error || `HTTP ${res.status}`;
      if(result) result.innerHTML = `<div style="padding:16px;border-radius:12px;background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.2);"><p style="color:#dc2626;font-size:13px;margin:0;"><strong>Failed:</strong> ${escapeHtml(errMsg)}</p></div>`;
    }
  } catch (e) {
    if(result) result.innerHTML = `<div style="padding:16px;border-radius:12px;background:rgba(220,38,38,0.08);"><p style="color:#dc2626;font-size:13px;margin:0;"><strong>Network error:</strong> ${escapeHtml(e.message)}</p></div>`;
  } finally { if(btn){ btn.disabled = false; btn.innerHTML = '<i class="ri-image-add-line"></i> Generate'; } }
}

function startMic(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR) return alert('Speech recognition not supported.');
  recognition = new SR();
  recognition.lang = userSettings.language || 'en-US';
  recognition.interimResults = false; recognition.continuous = false;
  const micBtn = $('#micBtn'); micBtn?.classList.add('active');
  recognition.onresult = e=>{
    const text = e.results[0][0].transcript;
    if($('#messageInput')){ $('#messageInput').value = text; updateSendButtonState(); }
    micBtn?.classList.remove('active');
    handleSend();
  };
  recognition.onerror = ()=>micBtn?.classList.remove('active');
  recognition.onend = ()=>micBtn?.classList.remove('active');
  recognition.start();
}
function startCall(){
  if(!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) return alert('Not supported.');
  callActive = true; $('#callOverlay')?.classList.add('open');
  startCallRecognition();
}
function startCallRecognition(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  callRecognition = new SR();
  callRecognition.lang = userSettings.language || 'en-US';
  callRecognition.continuous = true;
  callRecognition.onresult = e=>{
    if(callMuted) return;
    const text = e.results[e.results.length-1][0].transcript;
    if($('#callTranscript')) $('#callTranscript').textContent = 'You: '+text;
  };
  callRecognition.onend = ()=>{ if(callActive) setTimeout(startCallRecognition, 500); };
  try{ callRecognition.start(); }catch{}
}
function endCall(){ callActive = false; try{callRecognition?.stop();}catch{} callRecognition = null; $('#callOverlay')?.classList.remove('open'); }
function toggleMute(){ callMuted = !callMuted; const b = $('#callMuteBtn'); if(b) b.innerHTML = callMuted ? '<i class="ri-mic-off-line"></i>' : '<i class="ri-mic-line"></i>'; }
async function requestMic(){ try{ await navigator.mediaDevices.getUserMedia({ audio:true }); alert('Mic granted.'); }catch{ alert('Denied.'); } }

async function loadMemory(){
  const list = $('#memoryList'); if(!list || !__user) return;
  const res = await authJson('/api/memory', {}, null);
  if(res?.facts?.length) list.innerHTML = res.facts.map(f=>`<div class="memory-item"><span>${escapeHtml(f.text)}</span></div>`).join('');
  else list.innerHTML = '<p style="font-size:13px;color:var(--text-faint);">No memories yet.</p>';
}
async function addMemory(){
  const input = $('#memoryInput'); if(!input?.value.trim()) return;
  await authJson('/api/memory', { method:'POST', body:JSON.stringify({ fact:input.value.trim() }) });
  input.value = ''; loadMemory();
}
async function loadPersona(){ if(!__user) return; const res = await authJson('/api/persona', {}, null); if(res?.persona && $('#personaInput')) $('#personaInput').value = res.persona; }
async function savePersona(){ await authJson('/api/persona', { method:'POST', body:JSON.stringify({ persona:$('#personaInput')?.value.trim() || '' }) }); }
async function submitReport(){
  const category = $('#supportCategory')?.value;
  const subject = $('#supportSubject')?.value.trim();
  const message = $('#supportMessage')?.value.trim();
  if(!subject || !message) return alert('Please fill subject and message.');
  const res = await authJson('/api/support/ticket', { method:'POST', body:JSON.stringify({ category, subject, message }) }, null);
  if(res?.ok){ alert('Ticket submitted!'); closeModal('supportModal'); } else alert(res?.error||'Failed.');
}

function wireToolButtons(){
  $('#talkModeBtn')?.addEventListener('click', startCall);
  $('#imageModeBtn')?.addEventListener('click', ()=>openModal('imageModal'));
  $('#backgroundModeBtn')?.addEventListener('click', ()=>openModal('backgroundModal'));
  $('#plansModeBtn')?.addEventListener('click', ()=>{ openModal('plansModal'); loadPlans(); loadUserKeys(); });
  $('#supportModeBtn')?.addEventListener('click', ()=>openModal('supportModal'));
  $('#supportModeBtn2')?.addEventListener('click', ()=>openModal('supportModal'));
  $('#settingsBtn')?.addEventListener('click', ()=>{ openModal('settingsModal'); loadPersona(); loadMemory(); loadMcp(); });
  $('#upgradeBtn')?.addEventListener('click', (e)=>{
    e.stopPropagation();
    if(!__user) openModal('loginModal');
    else { openModal('plansModal'); loadPlans(); loadUserKeys(); }
  });
  $('#logoutBtn')?.addEventListener('click', doLogout);
  $('#generateKeyBtn')?.addEventListener('click', genKey);
  $('#generateImageBtn')?.addEventListener('click', genImage);
  $('#copyNewKeyBtn')?.addEventListener('click', async ()=>{
    const v = $('#newKeyValue')?.textContent || '';
    try {
      if(navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(v);
      else { const ta=document.createElement('textarea'); ta.value=v; ta.style.position='fixed'; ta.style.top='-1000px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
      const b = $('#copyNewKeyBtn'); if(b){ b.innerHTML = '<i class="ri-check-line"></i>'; setTimeout(()=>b.innerHTML = '<i class="ri-file-copy-line"></i>', 1200); }
    } catch {}
  });
  $('#addMcpBtn')?.addEventListener('click', ()=>{
    const name = $('#mcpNameInput')?.value.trim();
    const url = $('#mcpUrlInput')?.value.trim();
    if(!name || !url) return alert('Name and URL required.');
    let servers = []; try{ servers = JSON.parse(localStorage.getItem(MCP_KEY)||'[]'); }catch{}
    servers.push({ name, url, enabled:true, created:Date.now() });
    saveMcp(servers);
    if($('#mcpNameInput')) $('#mcpNameInput').value = '';
    if($('#mcpUrlInput')) $('#mcpUrlInput').value = '';
  });
  $('#savePersonaBtn')?.addEventListener('click', savePersona);
  $('#addMemoryBtn')?.addEventListener('click', addMemory);
  $('#submitReportBtn')?.addEventListener('click', submitReport);
  $('#requestMicBtn')?.addEventListener('click', requestMic);
  $('#attachBtn')?.addEventListener('click', ()=>$('#fileInput')?.click());
  $('#removeAttachmentBtn')?.addEventListener('click', ()=>{ pendingFiles=[]; updatePreview(); updateSendButtonState(); });
  $('#micBtn')?.addEventListener('click', startMic);
  $('#stopBtn')?.addEventListener('click', stopStreaming);
  $('#callEndBtn')?.addEventListener('click', endCall);
  $('#callMuteBtn')?.addEventListener('click', toggleMute);
  $('#bgUploadZone')?.addEventListener('click', ()=>$('#bgFileInput')?.click());
  $('#bgUrlApplyBtn')?.addEventListener('click', ()=>{
    const u = $('#bgUrlInput')?.value.trim();
    if(u){ bgState.url = u; saveBgPrefs(); applyBackground(); }
  });
  $('#bgRemoveBtn')?.addEventListener('click', ()=>{
    bgState.url = null; saveBgPrefs(); applyBackground();
    if($('#bgUrlInput')) $('#bgUrlInput').value = '';
  });
  $('#searchToggleBtn')?.addEventListener('click', ()=>$('#searchToggleBtn')?.classList.toggle('active'));
  $('#editTitleBtn')?.addEventListener('click', ()=>{
    const cur = $('#chatTitle')?.textContent||'';
    const nxt = prompt('Rename chat', cur);
    if(nxt === null) return;
    const tr = nxt.trim(); if(!tr) return;
    $('#chatTitle').textContent = tr;
    const c = currentConvo();
    if(c){ c.title = tr; saveChatsToLS(); renderHistory(); }
  });
  $('#hamburgerBtn')?.addEventListener('click', openSidebar);
  $('#sidebarCloseBtn')?.addEventListener('click', closeSidebar);
  $('#sidebarScrim')?.addEventListener('click', closeSidebar);
  $('#brandLogo')?.addEventListener('click', (e)=>{ e.preventDefault(); startNewChat(); if(window.innerWidth <= 860) closeSidebar(); });
  $('#newChatBtn')?.addEventListener('click', ()=>{ startNewChat(); if(window.innerWidth <= 860) closeSidebar(); });
  $('#userChip')?.addEventListener('click', ()=>{ if(!__user) openModal('loginModal'); });
}

document.addEventListener('click', function(e){
  const t = e.target;
  const closest = s => t.closest(s);
  const closer = closest('[data-close]');
  if(closer){ closeModal(closer.dataset.close); return; }
  if(t.classList.contains('modal-overlay')){ t.classList.remove('open'); return; }
  if(t.classList.contains('lightbox')){ t.classList.remove('open'); return; }
  const tab = closest('.settings-tab');
  if(tab){
    document.querySelectorAll('.settings-tab').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.settings-pane').forEach(x=>x.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`.settings-pane[data-pane="${tab.dataset.tab}"]`)?.classList.add('active');
    if(tab.dataset.tab === 'mcp') loadMcp();
    return;
  }
  const mb = closest('[data-mode]'); if(mb && mb.closest('#modeOptions')){ applyAppearance({ mode:mb.dataset.mode }); return; }
  const sw = closest('.swatch'); if(sw?.dataset.theme){ applyAppearance({ theme:sw.dataset.theme }); return; }
  const cb = closest('[data-corner]'); if(cb && cb.closest('#cornerOptions')){ applyAppearance({ corner:cb.dataset.corner }); return; }
  const tg = closest('[data-toggle]');
  if(tg){
    const k = tg.dataset.toggle;
    userSettings[k] = !userSettings[k];
    tg.textContent = userSettings[k] ? 'ON' : 'OFF';
    tg.classList.toggle('active', userSettings[k]);
    saveUserSettings();
    return;
  }
  const mt = closest('.mcp-toggle');
  if(mt){
    let servers = []; try{ servers = JSON.parse(localStorage.getItem(MCP_KEY)||'[]'); }catch{}
    const i = +mt.dataset.idx;
    if(servers[i]){ servers[i].enabled = !servers[i].enabled; saveMcp(servers); }
    return;
  }
  const mr = closest('.mcp-remove');
  if(mr){
    let servers = []; try{ servers = JSON.parse(localStorage.getItem(MCP_KEY)||'[]'); }catch{}
    servers.splice(+mr.dataset.idx, 1);
    saveMcp(servers);
    return;
  }
  const hist = closest('.history-item');
  if(hist){
    if(t.closest('.history-delete')){
      const id = hist.dataset.id;
      __conversations = __conversations.filter(x=>x.id!==id);
      if(currentConversationId === id) startNewChat();
      saveChatsToLS(); renderHistory();
      e.stopPropagation();
      return;
    }
    const id = hist.dataset.id;
    if(id){ stopStreaming(); openConversationLS(id); if(window.innerWidth <= 860) closeSidebar(); }
    return;
  }
});

document.addEventListener('submit', function(e){
  e.preventDefault();
  if(e.target?.id === 'simpleLoginForm') doLogin();
}, true);
document.addEventListener('input', function(e){
  if(e.target?.id === 'bgDimInput'){ bgState.dim = parseInt(e.target.value); const l = $('#bgDimLabel'); if(l) l.textContent = bgState.dim+'%'; applyBackground(); saveBgPrefs(); }
});
document.addEventListener('change', function(e){
  if(e.target?.id === 'fileInput'){ handleFiles(e.target.files); e.target.value = ''; }
  if(e.target?.id === 'bgFileInput'){
    const f = e.target.files[0]; if(!f) return;
    const r = new FileReader();
    r.onload = ()=>{ bgState.url = r.result; saveBgPrefs(); applyBackground(); };
    r.readAsDataURL(f); e.target.value = '';
  }
  if(e.target?.id === 'langSelect'){ userSettings.language = e.target.value; saveUserSettings(); }
});

async function init(){
  loadUserSettings(); loadAppearance(); loadBgPrefs();
  wireModelPicker(); wireSendButton(); wireToolButtons(); renderModelPicker();
  await loadConfig();
  await loadUser();
  loadChatsFromLS(); renderHistory(); bindSuggestionClicks(); updateUserUI(); loadMcp();
  document.addEventListener('keydown', e=>{
    if((e.ctrlKey || e.metaKey) && e.key === 'k'){ e.preventDefault(); $('#messageInput')?.focus(); }
  });
}
init();

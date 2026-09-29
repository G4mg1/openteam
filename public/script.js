const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);
let __config=null,__user=null,__tier="free",__model=null;
let currentConversationId=null,isReplying=false,__conversations=[],pendingFiles=[];
let bgState={url:null,dim:45,blur:0},recognition=null,callRecognition=null;
let synth=window.speechSynthesis,callActive=false,callMuted=false,micStream=null;
let callRestartTimer=null,callSpeakEndTimer=null;
const LS_KEY="miroxai_conversations_v1",TOKEN_KEY="mirox_token",USER_SETTINGS_KEY="miroxai_user_settings";

/* ---------- SAFE JSON ---------- */
async function readJson(r,fallback=null){
  if(!r)return fallback;
  const ct=(r.headers.get("content-type")||"").toLowerCase();
  if(!ct.includes("application/json")){try{await r.text();}catch{}return fallback;}
  try{return await r.json();}catch{return fallback;}
}
async function safeFetch(url,opts={}){
  try{const r=await fetch(url,opts);const data=await readJson(r,null);return {ok:r.ok,status:r.status,data};}
  catch{return {ok:false,status:0,data:null};}
}
function getToken(){try{return localStorage.getItem(TOKEN_KEY)||"";}catch{return"";}}
function setToken(t){try{t?localStorage.setItem(TOKEN_KEY,t):localStorage.removeItem(TOKEN_KEY);}catch{}}
function authFetch(u,o={}){const h={"Content-Type":"application/json",...(o.headers||{})};const t=getToken();if(t)h.Authorization="Bearer "+t;return fetch(u,{...o,headers:h,credentials:"same-origin",cache:"no-store"});}
async function authJson(u,o={},fallback=null){try{const r=await authFetch(u,o);return await readJson(r,fallback);}catch{return fallback;}}

function killLoader(){const l=document.getElementById("loadingScreen");if(l){l.classList.add("hidden","force-hidden");l.style.display="none";}}
killLoader();setTimeout(killLoader,400);setTimeout(killLoader,1500);

function escapeHtml(s){const d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}
const getDefaultModel=()=>(__config?.models||[]).find(m=>m.default)?.id||"mirox-luna-1.2";
function uid(){return "c_"+Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);}
function fmtSize(b){if(!b)return"";if(b<1024)return b+" B";if(b<1024*1024)return (b/1024).toFixed(1)+" KB";return (b/1024/1024).toFixed(1)+" MB";}

function openModal(id){const el=document.getElementById(id);if(el)el.classList.add("open");}
function closeModal(id){const el=document.getElementById(id);if(el)el.classList.remove("open");}
function openSidebar(){$("#sidebar")?.classList.add("open");$("#sidebarScrim")?.classList.add("open");}
function closeSidebar(){$("#sidebar")?.classList.remove("open");$("#sidebarScrim")?.classList.remove("open");}
function showLightbox(src){const lb=$("#lightbox");if(!lb)return;lb.querySelector("img").src=src;lb.classList.add("open");}

let userSettings={temperature:0.7,length:"medium",language:"en-US",autoscroll:true,soundOn:true,notifOn:true,voiceRate:1,voiceName:"",highlightOn:true,lineNumbers:false};
function loadUserSettings(){try{const s=JSON.parse(localStorage.getItem(USER_SETTINGS_KEY)||"{}");userSettings={...userSettings,...s};}catch{}}
function saveUserSettings(){try{localStorage.setItem(USER_SETTINGS_KEY,JSON.stringify(userSettings));}catch{}if(__user){authJson("/api/settings/user",{method:"POST",body:JSON.stringify({settings:userSettings})}).catch(()=>{});}}

/* ============================================================
   MARKDOWN + SYNTAX HIGHLIGHT RENDERER
   No external marked/dompurify — everything inline so it works
   offline and doesn't rely on extra CDNs.
   ============================================================ */

/* Language map: prettifies the label shown in the code header */
const LANG_META={
  js:{label:"JavaScript",cls:"language-javascript"},
  javascript:{label:"JavaScript",cls:"language-javascript"},
  jsx:{label:"JSX",cls:"language-javascript"},
  ts:{label:"TypeScript",cls:"language-typescript"},
  typescript:{label:"TypeScript",cls:"language-typescript"},
  tsx:{label:"TSX",cls:"language-typescript"},
  py:{label:"Python",cls:"language-python"},
  python:{label:"Python",cls:"language-python"},
  c:{label:"C",cls:"language-c"},
  h:{label:"C Header",cls:"language-c"},
  cpp:{label:"C++",cls:"language-cpp"},
  "c++":{label:"C++",cls:"language-cpp"},
  cc:{label:"C++",cls:"language-cpp"},
  cxx:{label:"C++",cls:"language-cpp"},
  hpp:{label:"C++ Header",cls:"language-cpp"},
  cs:{label:"C#",cls:"language-csharp"},
  csharp:{label:"C#",cls:"language-csharp"},
  java:{label:"Java",cls:"language-java"},
  lua:{label:"Lua",cls:"language-lua"},
  css:{label:"CSS",cls:"language-css"},
  scss:{label:"SCSS",cls:"language-scss"},
  html:{label:"HTML",cls:"language-xml"},
  xml:{label:"XML",cls:"language-xml"},
  svg:{label:"SVG",cls:"language-xml"},
  json:{label:"JSON",cls:"language-json"},
  yaml:{label:"YAML",cls:"language-yaml"},
  yml:{label:"YAML",cls:"language-yaml"},
  sh:{label:"Shell",cls:"language-bash"},
  bash:{label:"Bash",cls:"language-bash"},
  zsh:{label:"Shell",cls:"language-bash"},
  shell:{label:"Shell",cls:"language-bash"},
  sql:{label:"SQL",cls:"language-sql"},
  go:{label:"Go",cls:"language-go"},
  rust:{label:"Rust",cls:"language-rust"},
  rs:{label:"Rust",cls:"language-rust"},
  php:{label:"PHP",cls:"language-php"},
  rb:{label:"Ruby",cls:"language-ruby"},
  ruby:{label:"Ruby",cls:"language-ruby"},
  md:{label:"Markdown",cls:"language-markdown"},
  markdown:{label:"Markdown",cls:"language-markdown"},
  txt:{label:"Text",cls:""},
  plain:{label:"Text",cls:""},
};
function langInfo(l){
  if(!l)return{label:"Code",cls:""};
  const key=l.toLowerCase().trim();
  return LANG_META[key]||{label:l.toUpperCase(),cls:"language-"+key};
}

/* Escape HTML entities */
function escHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

/* Convert markdown-ish text → sanitized HTML with code blocks */
function renderMarkdown(text){
  if(!text)return "";
  const src=String(text);

  // Split on triple-backtick fences, preserving order
  const parts=[];
  const fenceRe=/```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)```/g;
  let last=0,m;
  while((m=fenceRe.exec(src))!==null){
    if(m.index>last)parts.push({type:"text",content:src.slice(last,m.index)});
    parts.push({type:"code",lang:(m[1]||"").trim(),content:m[2]});
    last=fenceRe.lastIndex;
  }
  if(last<src.length)parts.push({type:"text",content:src.slice(last)});

  // Handle unclosed code fence (streaming)
  if(parts.length&&parts[parts.length-1].type==="text"){
    const tail=parts[parts.length-1].content;
    const openIdx=tail.lastIndexOf("```");
    if(openIdx!==-1){
      const before=tail.slice(0,openIdx);
      const after=tail.slice(openIdx+3);
      const lines=after.split("\n");
      const lang=lines[0].trim();
      const body=lines.slice(1).join("\n");
      parts[parts.length-1]={type:"text",content:before};
      parts.push({type:"code",lang,content:body,streaming:true});
    }
  }

  let html="";
  for(const p of parts){
    if(p.type==="text")html+=renderTextBlock(p.content);
    else html+=renderCodeBlock(p.lang,p.content,p.streaming);
  }
  return html;
}

/* Inline text → HTML (headings, lists, bold, italic, inline code, links) */
function renderTextBlock(text){
  if(!text.trim())return "";
  const lines=text.split("\n");
  let out="",listOpen=false,listType=null,paraBuf=[];

  const flushPara=()=>{
    if(paraBuf.length){
      let t=paraBuf.join(" ").trim();
      if(t){
        // inline code → placeholder
        const codes=[];
        t=t.replace(/`([^`]+)`/g,(_,c)=>{codes.push(c);return `\u0001${codes.length-1}\u0001`;});
        // bold, italic, links
        t=escHtml(t);
        t=t.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>");
        t=t.replace(/(^|[^*])\*([^*]+)\*/g,"$1<em>$2</em>");
        t=t.replace(/\[([^\]]+)\]\((https?:[^\)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        t=t.replace(/\u0001(\d+)\u0001/g,(_,i)=>`<code>${escHtml(codes[+i])}</code>`);
        out+=`<p>${t}</p>`;
      }
      paraBuf=[];
    }
  };
  const closeList=()=>{
    if(listOpen){out+=listType==="ol"?"</ol>":"</ul>";listOpen=false;listType=null;}
  };

  for(const raw of lines){
    const line=raw.replace(/\s+$/,"");
    const trimmed=line.trim();
    if(!trimmed){flushPara();closeList();continue;}

    // Headings
    let hm=trimmed.match(/^(#{1,4})\s+(.+)$/);
    if(hm){flushPara();closeList();const lvl=Math.min(4,hm[1].length);out+=`<h${lvl}>${inlineFmt(hm[2])}</h${lvl}>`;continue;}

    // Blockquote
    if(trimmed.startsWith("> ")){flushPara();closeList();out+=`<blockquote>${inlineFmt(trimmed.slice(2))}</blockquote>`;continue;}

    // HR
    if(/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)){flushPara();closeList();out+="<hr>";continue;}

    // Unordered list
    let um=trimmed.match(/^[-*+]\s+(.+)$/);
    if(um){
      flushPara();
      if(!listOpen||listType!=="ul"){closeList();out+="<ul>";listOpen=true;listType="ul";}
      out+=`<li>${inlineFmt(um[1])}</li>`;
      continue;
    }

    // Ordered list
    let om=trimmed.match(/^(\d+)\.\s+(.+)$/);
    if(om){
      flushPara();
      if(!listOpen||listType!=="ol"){closeList();out+="<ol>";listOpen=true;listType="ol";}
      out+=`<li>${inlineFmt(om[2])}</li>`;
      continue;
    }

    // Regular text
    closeList();
    paraBuf.push(trimmed);
  }
  flushPara();closeList();
  return out;
}

function inlineFmt(t){
  const codes=[];
  t=String(t).replace(/`([^`]+)`/g,(_,c)=>{codes.push(c);return `\u0001${codes.length-1}\u0001`;});
  t=escHtml(t);
  t=t.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>");
  t=t.replace(/(^|[^*])\*([^*]+)\*/g,"$1<em>$2</em>");
  t=t.replace(/\[([^\]]+)\]\((https?:[^\)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  t=t.replace(/\u0001(\d+)\u0001/g,(_,i)=>`<code>${escHtml(codes[+i])}</code>`);
  return t;
}

/* Render a fenced code block with header + copy button + optional line numbers */
function renderCodeBlock(langRaw,code,streaming){
  const info=langInfo(langRaw);
  const raw=String(code||"").replace(/\n$/,"");
  const lines=raw.split("\n");
  const linesHtml=lines.map(l=>escHtml(l)).join("\n");
  const numberSpans=lines.map((_,i)=>`<span class="line-num">${i+1}</span>`).join("");

  const cls=`code-block${userSettings.lineNumbers?" has-line-numbers":""}`;
  const codeClass=info.cls||"";

  return `<div class="${cls}">
    <div class="code-header">
      <span class="lang-name"><span class="lang-dot"></span>${escHtml(info.label)}${streaming?' · typing…':""}</span>
      <span class="code-actions">
        <button type="button" class="code-action-btn" data-copy>${copyIconSvg()} Copy</button>
      </span>
    </div>
    <pre><code class="${codeClass}">${numberSpans}${linesHtml}</code></pre>
  </div>`;
}

function copyIconSvg(){return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';}

/* Apply highlight.js to every <code> that hasn't been highlighted yet */
function highlightCode(scope){
  if(!window.hljs)return;
  const target=scope||document;
  target.querySelectorAll(".code-block pre code").forEach(el=>{
    if(el.dataset.hl){return;}
    const cls=el.className||"";
    // Get raw text (including line-num spans, we need to strip them)
    let raw=el.textContent||"";
    el.textContent=raw;
    el.removeAttribute("data-highlighted");
    el.classList.remove("hljs");
    try{
      let result;
      const m=cls.match(/language-([a-z0-9+#-]+)/i);
      if(m&&window.hljs.getLanguage(m[1])){
        result=window.hljs.highlight(raw,{language:m[1],ignoreIllegals:true});
      }else{
        result=window.hljs.highlightAuto(raw);
      }
      el.innerHTML=result.value;
      el.classList.add("hljs");
    }catch(e){
      // Leave the escaped HTML as-is
    }
    el.dataset.hl="1";
  });
  // Re-inject line numbers after highlight
  if(userSettings.lineNumbers){
    target.querySelectorAll(".code-block.has-line-numbers pre code").forEach(el=>{
      if(el.querySelector(".line-num"))return;
      const lines=(el.textContent||"").split("\n");
      const nums=lines.map((_,i)=>`<span class="line-num">${i+1}</span>`).join("");
      el.insertAdjacentHTML("afterbegin",nums);
    });
  }
}

/* Wire copy buttons inside a rendered bubble */
function wireCodeButtons(scope){
  (scope||document).querySelectorAll(".code-block .code-action-btn[data-copy]").forEach(btn=>{
    if(btn.__wired)return;
    btn.__wired=true;
    btn.addEventListener("click",async e=>{
      e.preventDefault();e.stopPropagation();
      const block=btn.closest(".code-block");
      const codeEl=block?.querySelector("pre code");
      let text=codeEl?.textContent||"";
      // Strip line numbers from copied text
      text=text.split("\n").map(l=>l.replace(/^\s*\d+/,"")).join("\n").replace(/^\n+/,"");
      const ok=await copyText(text);
      btn.innerHTML=ok?"✓ Copied":"Failed";
      btn.classList.toggle("copied",ok);
      setTimeout(()=>{btn.innerHTML=`${copyIconSvg()} Copy`;btn.classList.remove("copied");},1400);
    });
  });
}

async function copyText(t){
  try{
    if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(t);return true;}
  }catch{}
  try{
    const ta=document.createElement("textarea");
    ta.value=t;ta.style.position="fixed";ta.style.top="-1000px";
    document.body.appendChild(ta);ta.focus();ta.select();
    const ok=document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }catch{return false;}
}

/* Public: render a bubble from any text (streaming or final) */
function renderBubble(bubble,text){
  if(!bubble)return;
  if(!userSettings.highlightOn){
    bubble.textContent=text||"";
    return;
  }
  const html=renderMarkdown(text||"");
  bubble.innerHTML=html;
  highlightCode(bubble);
  wireCodeButtons(bubble);
}

/* ---------- GLOBAL CLICK ---------- */
document.addEventListener("click",function(e){
  const t=e.target,closest=s=>t.closest(s);
  const closer=closest("[data-close]");if(closer){closeModal(closer.dataset.close);return;}
  if(t.classList.contains("modal-overlay")){t.classList.remove("open");return;}
  if(t.classList.contains("lightbox")){t.classList.remove("open");return;}
  if(closest(".chat-file-img")){showLightbox(closest(".chat-file-img").src);return;}
  if(closest(".gallery-card img")){showLightbox(closest(".gallery-card img").src);return;}
  if(closest("#hamburgerBtn")){openSidebar();return;}
  if(closest("#sidebarCloseBtn")){closeSidebar();return;}
  if(t.id==="sidebarScrim"){closeSidebar();return;}
  if(closest("#brandLogo")){startNewChat();if(window.innerWidth<=860)closeSidebar();return;}
  if(closest("#newChatBtn")){startNewChat();if(window.innerWidth<=860)closeSidebar();return;}
  if(closest("#userChip")){if(!__user)openModal("loginModal");return;}
  if(closest("#upgradeBtn")){if(!__user)openModal("loginModal");else{openModal("plansModal");loadPlans();loadUserKeys();}return;}
  if(closest("#settingsBtn")){openModal("settingsModal");loadPersona();loadMemory();renderSettings();return;}
  if(closest("#imageModeBtn")){openModal("imageModal");return;}
  if(closest("#backgroundModeBtn")){openModal("backgroundModal");populateBackgroundUI();return;}
  if(closest("#plansModeBtn")){openModal("plansModal");loadPlans();loadUserKeys();return;}
  if(closest("#supportModeBtn")){openModal("supportModal");loadMyReports();return;}
  if(closest("#talkModeBtn")){startCall();return;}
  if(closest("#callEndBtn")){endCall();return;}
  if(closest("#callMuteBtn")){toggleMute();return;}
  if(closest("#modelPickerBtn")){e.stopPropagation();$("#modelPickerMenu")?.classList.toggle("open");return;}
  const mo=closest(".model-option");if(mo){selectModel(mo.dataset.modelId);return;}
  if(!closest("#modelPicker"))$("#modelPickerMenu")?.classList.remove("open");
  const tab=closest(".settings-tab");
  if(tab){document.querySelectorAll(".settings-tab").forEach(x=>x.classList.remove("active"));document.querySelectorAll(".settings-pane").forEach(x=>x.classList.remove("active"));tab.classList.add("active");document.querySelector(`.settings-pane[data-pane="${tab.dataset.tab}"]`)?.classList.add("active");return;}
  const modeBtn=closest("[data-mode]");if(modeBtn&&modeBtn.closest("#modeOptions")){saveAppearance({mode:modeBtn.dataset.mode});return;}
  const swatch=closest(".swatch");if(swatch&&swatch.dataset.theme){saveAppearance({theme:swatch.dataset.theme});return;}
  const cornerBtn=closest("[data-corner]");if(cornerBtn&&cornerBtn.closest("#cornerOptions")){saveAppearance({corner:cornerBtn.dataset.corner});return;}
  const fontBtn=closest("[data-font]");if(fontBtn&&fontBtn.closest("#fontOptions")){saveAppearance({font:fontBtn.dataset.font});return;}
  const lenBtn=closest("[data-length]");
  if(lenBtn){document.querySelectorAll("#lengthOptions .option-btn").forEach(x=>x.classList.remove("active"));lenBtn.classList.add("active");userSettings.length=lenBtn.dataset.length;saveUserSettings();return;}
  const tg=closest("[data-toggle]");
  if(tg){
    const k=tg.dataset.toggle;
    userSettings[k]=!userSettings[k];
    tg.textContent=tg.textContent.replace(/ON|OFF/,userSettings[k]?"ON":"OFF");
    tg.classList.toggle("active",userSettings[k]);
    saveUserSettings();
    if(k==="lineNumbers"){document.querySelectorAll(".code-block").forEach(b=>b.classList.toggle("has-line-numbers",userSettings.lineNumbers));highlightCode();}
    if(k==="highlightOn"){document.querySelectorAll(".message.ai .bubble").forEach(b=>{const t=b.textContent;renderBubble(b,t);});}
    return;
  }
  if(closest("#railToggleBtn")){document.body.classList.toggle("rail-collapsed");try{localStorage.setItem("miroxai_rail_collapsed",document.body.classList.contains("rail-collapsed")?"1":"0");}catch{}updateRailToggleIcon();return;}
  if(closest("#attachBtn")){$("#fileInput")?.click();return;}
  if(closest("#removeAttachmentBtn")){pendingFiles=[];updatePreview();return;}
  if(closest("#searchToggleBtn")){$("#searchToggleBtn").classList.toggle("active");return;}
  if(closest("#micBtn")){startMic();return;}
  if(closest("#editTitleBtn")){const cur=$("#chatTitle")?.textContent||"";const nxt=prompt("Rename this chat",cur);if(nxt===null)return;const tr=nxt.trim();if(!tr)return;if($("#chatTitle"))$("#chatTitle").textContent=tr;const c=currentConvo();if(c){c.title=tr;saveChatsToLS();renderHistory();}return;}
  if(closest("#logoutBtn")){doLogout();return;}
  if(closest("#savePersonaBtn")){savePersona();return;}
  if(closest("#addMemoryBtn")){addMemory();return;}
  if(closest("#submitReportBtn")){submitReport();return;}
  if(closest("#generateKeyBtn")){genKey();return;}
  if(closest("#generateImageBtn")){genImage();return;}
  if(closest("#bgUploadZone")){$("#bgFileInput")?.click();return;}
  if(closest("#bgUrlApplyBtn")){const u=$("#bgUrlInput")?.value.trim();if(!u)return;bgState.url=u;saveBgPrefs();applyBackground();return;}
  if(closest("#bgRemoveBtn")){bgState.url=null;saveBgPrefs();applyBackground();if($("#bgUrlInput"))$("#bgUrlInput").value="";return;}
  if(closest("#requestMicBtn")){requestMic();return;}
  if(closest("#testVoiceBtn")){speakText("Hi, this is Mirox, made by the OpenSurr team.");return;}
  const hist=closest(".history-item");
  if(hist){if(t.closest(".history-delete")){const id=hist.dataset.id;__conversations=__conversations.filter(x=>x.id!==id);if(currentConversationId===id)startNewChat();saveChatsToLS();renderHistory();e.stopPropagation();return;}const id=hist.dataset.id;if(id){openConversationLS(id);if(window.innerWidth<=860)closeSidebar();}return;}
});

document.addEventListener("keydown",function(e){
  if(e.key==="Escape"){document.querySelectorAll(".modal-overlay.open").forEach(o=>o.classList.remove("open"));$("#modelPickerMenu")?.classList.remove("open");$("#lightbox")?.classList.remove("open");return;}
  if(e.key==="Enter"&&e.target?.id==="messageInput"&&!e.shiftKey){e.preventDefault();handleSend();}
});
document.addEventListener("submit",function(e){e.preventDefault();if(e.target?.id==="composerForm")handleSend();if(e.target?.id==="simpleLoginForm")doLogin();},true);
document.addEventListener("click",function(e){if(e.target?.closest&&e.target.closest("#sendBtn")){e.preventDefault();handleSend();}});
document.addEventListener("input",function(e){
  if(e.target?.id==="messageInput"){const sb=$("#sendBtn");if(sb)sb.disabled=isReplying||!e.target.value.trim();}
  if(e.target?.id==="bgDimInput"){bgState.dim=parseInt(e.target.value);if($("#bgDimLabel"))$("#bgDimLabel").textContent=bgState.dim+"%";applyBackground();saveBgPrefs();}
  if(e.target?.id==="bgBlurInput"){bgState.blur=parseInt(e.target.value);if($("#bgBlurLabel"))$("#bgBlurLabel").textContent=bgState.blur+"px";applyBackground();saveBgPrefs();}
  if(e.target?.id==="tempInput"){userSettings.temperature=parseInt(e.target.value)/10;if($("#tempLabel"))$("#tempLabel").textContent=userSettings.temperature.toFixed(1);saveUserSettings();}
  if(e.target?.id==="voiceRateInput"){userSettings.voiceRate=parseFloat(e.target.value);if($("#voiceRateLabel"))$("#voiceRateLabel").textContent=userSettings.voiceRate.toFixed(1)+"×";saveUserSettings();}
});
document.addEventListener("change",function(e){
  if(e.target?.id==="fileInput"){handleFiles(e.target.files);e.target.value="";}
  if(e.target?.id==="bgFileInput"){const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{bgState.url=r.result;saveBgPrefs();applyBackground();populateBackgroundUI();};r.readAsDataURL(f);e.target.value="";}
  if(e.target?.id==="langSelect"){userSettings.language=e.target.value;saveUserSettings();}
  if(e.target?.id==="voiceSelect"){userSettings.voiceName=e.target.value;saveUserSettings();}
});

function handleFiles(files){
  if(!files?.length)return;
  const newFiles=[];
  const fileArr=Array.from(files);
  let done=0;
  fileArr.forEach((f,idx)=>{
    const isImg=(f.type||"").startsWith("image/")||/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(f.name);
    if(isImg){
      if(f.size>6*1024*1024){done++;if(done===fileArr.length)finish();return;}
      const r=new FileReader();
      r.onload=()=>{newFiles.push({name:f.name,size:f.size,type:"image",content:"[Image] "+f.name,dataUrl:String(r.result),order:idx});done++;if(done===fileArr.length)finish();};
      r.onerror=()=>{done++;if(done===fileArr.length)finish();};
      r.readAsDataURL(f);
    }else{
      if(f.size>2*1024*1024){done++;if(done===fileArr.length)finish();return;}
      const r=new FileReader();
      r.onload=()=>{newFiles.push({name:f.name,size:f.size,type:"text",content:String(r.result).slice(0,50000),order:idx});done++;if(done===fileArr.length)finish();};
      r.onerror=()=>{done++;if(done===fileArr.length)finish();};
      r.readAsText(f);
    }
  });
  function finish(){
    newFiles.sort((a,b)=>(a.order||0)-(b.order||0));
    pendingFiles=pendingFiles.concat(newFiles);
    updatePreview();
  }
}

function updatePreview(){
  const p=$("#attachmentPreview"),list=$("#attachmentList");
  if(!p||!list)return;
  if(!pendingFiles.length){p.style.display="none";list.innerHTML="";return;}
  p.style.display="flex";
  list.innerHTML=pendingFiles.map(f=>{
    if(f.type==="image"&&f.dataUrl){
      return `<span class="att-chip"><img src="${f.dataUrl}" alt=""><span>${escapeHtml(f.name)}</span><span class="size">${fmtSize(f.size)}</span></span>`;
    }
    return `<span class="att-chip"><i class="ri-file-text-line"></i><span>${escapeHtml(f.name)}</span><span class="size">${fmtSize(f.size)}</span></span>`;
  }).join("");
}

function handleSend(){
  if(isReplying)return;
  const inp=$("#messageInput");if(!inp)return;
  const text=(inp.value||"").trim();
  if(!text&&!pendingFiles.length)return;
  inp.value="";
  const sb=$("#sendBtn");if(sb)sb.disabled=true;
  sendMessage(text);
}
async function sendMessage(userText){
  if(isReplying)return;
  userText=(userText||"").trim();
  if(!userText&&!pendingFiles.length)return;
  $("#mainEl")?.classList.remove("new-chat");
  let convo;
  if(__user){
    convo=currentConvo();
    if(!convo){convo={id:uid(),title:(userText||"New chat").slice(0,48),messages:[],updatedAt:Date.now()};__conversations.unshift(convo);currentConversationId=convo.id;const t=$("#chatTitle");if(t)t.textContent=convo.title;renderHistory();}
  }else{convo={id:"guest",title:(userText||"New chat").slice(0,48),messages:[],updatedAt:Date.now()};}
  const filesForSend=pendingFiles.slice();
  pendingFiles=[];updatePreview();
  convo.messages.push({role:"user",text:userText,files:filesForSend.map(f=>({name:f.name,type:f.type,size:f.size,dataUrl:f.dataUrl}))});
  convo.updatedAt=Date.now();
  if(__user)saveChatsToLS();
  addUserMessage(userText,filesForSend);
  const bubble=addThinking();
  isReplying=true;
  const sb=$("#sendBtn");if(sb)sb.disabled=true;
  const useSearch=$("#searchToggleBtn")?.classList.contains("active");
  try{
    const history=convo.messages.slice(0,-1).map(m=>({role:m.role==="ai"?"assistant":"user",content:m.text||m.content}));
    const sendFiles=filesForSend.map(f=>({name:f.name,type:f.type,content:f.content||""}));
    const r=await authFetch("/api/chat/stream",{method:"POST",body:JSON.stringify({message:userText,history,model:__model||getDefaultModel(),web_search:!!useSearch,files:sendFiles})});
    const ct=(r.headers.get("content-type")||"").toLowerCase();
    if(!r.ok||!ct.includes("text/event-stream")||!r.body){
      let m="Request failed";
      try{const e=await r.json();m=e.error||m;}catch{}
      throw new Error(m);
    }
    const reader=r.body.getReader(),dec=new TextDecoder();
    let buf="",full="",first=true,lastRender=0;
    bubble.classList.add("md");
    while(true){
      const {value,done}=await reader.read();if(done)break;
      buf+=dec.decode(value,{stream:true});
      let idx;
      while((idx=buf.indexOf("\n\n"))!==-1){
        const chunk=buf.slice(0,idx);buf=buf.slice(idx+2);
        for(const line of chunk.split("\n")){
          if(!line.startsWith("data:"))continue;
          const pl=line.slice(5).trim();if(!pl)continue;
          let evt;try{evt=JSON.parse(pl);}catch{continue;}
          if(evt.d){
            if(first){bubble.innerHTML="";first=false;}
            full+=evt.d;
            // Throttle rendering to ~60fps
            const now=performance.now();
            if(now-lastRender>16){
              lastRender=now;
              renderBubble(bubble,full);
              const chat=$("#chat");
              if(userSettings.autoscroll&&chat.scrollHeight-chat.scrollTop-chat.clientHeight<200)chat.scrollTop=chat.scrollHeight;
            }
          }else if(evt.done){
            renderBubble(bubble,full||"(empty reply)");
            const sub=$("#chatSubtitle");if(sub)sub.textContent=(evt.model||"")+(evt.ms?` · ${evt.ms}ms`:"");
          }else if(evt.error){
            throw new Error(evt.error);
          }
        }
      }
    }
    renderBubble(bubble,full||"(empty reply)");
    convo.messages.push({role:"ai",text:full});
    convo.updatedAt=Date.now();
    if(__user)saveChatsToLS();
  }catch(err){
    bubble.classList.remove("md");
    bubble.textContent=err.message||"Something went wrong.";
  }
  finally{isReplying=false;if(sb)sb.disabled=!($("#messageInput")?.value.trim());}
}

function addUserMessage(text,files){
  const chat=$("#chat");if(!chat)return null;
  const m=document.createElement("div");m.className="message user";
  m.innerHTML=`<div class="avatar"><i class="ri-user-3-line"></i></div><div class="bubble-wrap"><div class="bubble has-files"></div></div>`;
  const bubble=m.querySelector(".bubble");
  if(text){const p=document.createElement("div");p.textContent=text;bubble.appendChild(p);}
  if(files&&files.length){
    const wrap=document.createElement("div");wrap.className="chat-files";
    files.forEach(f=>{
      if(f.type==="image"&&f.dataUrl){
        const img=document.createElement("img");img.className="chat-file-img";img.src=f.dataUrl;img.alt=f.name;img.loading="lazy";
        wrap.appendChild(img);
      }else{
        const chip=document.createElement("div");chip.className="chat-file-chip";
        chip.innerHTML=`<i class="ri-file-text-line"></i><span>${escapeHtml(f.name)}</span><span class="size">${fmtSize(f.size)}</span>`;
        wrap.appendChild(chip);
      }
    });
    bubble.appendChild(wrap);
  }
  chat.appendChild(m);chat.scrollTop=chat.scrollHeight;
  return {message:m,bubble};
}

function addMessage(text,sender){
  const chat=$("#chat");if(!chat)return null;
  const m=document.createElement("div");m.className=`message ${sender}`;
  const avatarHtml=sender==="ai"?`<div class="avatar ai-avatar"><img src="/logo.png" alt=""></div>`:`<div class="avatar"><i class="ri-user-3-line"></i></div>`;
  m.innerHTML=`${avatarHtml}<div class="bubble-wrap"><div class="bubble"></div></div>`;
  const bubble=m.querySelector(".bubble");
  if(sender==="ai"){bubble.classList.add("md");renderBubble(bubble,text||"");}
  else bubble.textContent=text||"";
  chat.appendChild(m);chat.scrollTop=chat.scrollHeight;
  return {message:m,bubble};
}

function addThinking(){
  const chat=$("#chat");if(!chat)return null;
  const m=document.createElement("div");m.className="message ai";
  m.innerHTML=`<div class="avatar ai-avatar"><img src="/logo.png" alt=""></div><div class="bubble-wrap"><div class="bubble"><div class="thinking"><span class="thinking-dots"><span></span><span></span><span></span></span></div></div></div>`;
  chat.appendChild(m);chat.scrollTop=chat.scrollHeight;
  return m.querySelector(".bubble");
}

function loadChatsFromLS(){if(!__user){__conversations=[];return;}try{__conversations=JSON.parse(localStorage.getItem(LS_KEY))||[];}catch{__conversations=[];}}
function saveChatsToLS(){if(!__user)return;try{localStorage.setItem(LS_KEY,JSON.stringify(__conversations.slice(0,100)));}catch{}}
function currentConvo(){return __conversations.find(c=>c.id===currentConversationId)||null;}
function renderHistory(){
  const list=$("#historyList");if(!list)return;list.innerHTML="";
  if(!__user){list.innerHTML='<li class="history-empty">Guest mode — chats aren\'t saved. Sign in to keep them.</li>';return;}
  const sorted=__conversations.slice().sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  if(!sorted.length){list.innerHTML='<li class="history-empty">No conversations yet</li>';return;}
  sorted.forEach(c=>{
    const li=document.createElement("li");
    li.className="history-item"+(c.id===currentConversationId?" active":"");
    li.dataset.id=c.id;
    li.innerHTML=`<i class="ri-chat-3-line"></i><div><span>${escapeHtml(c.title||"New chat")}</span></div><button class="history-delete"><i class="ri-delete-bin-line"></i></button>`;
    list.appendChild(li);
  });
}
function openConversationLS(id){
  const c=__conversations.find(x=>x.id===id);if(!c)return;
  currentConversationId=id;
  const t=$("#chatTitle");if(t)t.textContent=c.title||"Chat";
  $("#mainEl")?.classList.remove("new-chat");
  const chat=$("#chat");if(chat)chat.innerHTML="";
  (c.messages||[]).forEach(m=>{
    if(m.role==="ai")addMessage(m.text||m.content||"","ai");
    else addUserMessage(m.text||m.content||"",m.files||[]);
  });
  renderHistory();
}
function startNewChat(){
  currentConversationId=null;
  const chat=$("#chat");if(chat)chat.innerHTML="";
  const t=$("#chatTitle");if(t)t.textContent="New chat";
  const s=$("#chatSubtitle");if(s)s.textContent="";
  pendingFiles=[];updatePreview();
  $("#mainEl")?.classList.add("new-chat");
  renderHistory();
}

async function doLogin(){
  const s=$("#loginStatus");
  const name=$("#simpleLoginName")?.value.trim()||"";
  const email=$("#simpleLoginEmail")?.value.trim()||"";
  if(!name||!email){if(s)s.textContent="Name and email required.";return;}
  if(s)s.textContent="Signing in…";
  try{
    const d=await authJson("/api/auth/simple-login",{method:"POST",body:JSON.stringify({name,email})},null);
    if(!d||!d.ok)throw new Error((d&&d.error)||"Failed to sign in");
    if(d.token)setToken(d.token);
    if(s)s.textContent="Signed in ✅";
    closeModal("loginModal");
    await loadMe();loadChatsFromLS();renderHistory();
  }catch(err){if(s)s.textContent=err.message;}
}
async function doLogout(){
  await authJson("/api/logout",{method:"POST"});
  setToken(null);
  __user=null;__tier="free";__conversations=[];
  const cl=$("#userChipLabel");if(cl)cl.textContent="Sign in";
  const n=$("#simpleLoginName");if(n)n.value="";
  const e=$("#simpleLoginEmail");if(e)e.value="";
  const tl=$("#tierLabel");if(tl)tl.textContent="Guest mode";
  const tm=$("#tierMeta");if(tm)tm.textContent="Sign in to save chats";
  const ub=$("#upgradeBtn");if(ub)ub.textContent="Sign in";
  startNewChat();
}

async function loadConfig(){
  const {data}=await safeFetch("/api/config",{cache:"no-store"});
  if(data&&data.models)__config=data;
  else __config={app:{name:"MiroxAI",made_by:"OpenSurr"},models:[{id:"mirox-luna-1.2",label:"Luna",tagline:"Warm & friendly",tier:"free",default:true}],announcement:{enabled:false}};
  window.__config=__config;buildModelPickerMenu();
}
async function loadMe(){
  const d=await authJson("/api/me",{},null);
  __user=(d&&d.user)||null;
  if(!__user)setToken(null);
  const cl=$("#userChipLabel");if(cl)cl.textContent=__user?__user.name:"Sign in";
  const lt=$("#loginTitle");if(lt)lt.textContent=__user?"Update profile":"Sign in";
  if(__user){
    if($("#simpleLoginName"))$("#simpleLoginName").value=__user.name||"";
    if($("#simpleLoginEmail"))$("#simpleLoginEmail").value=__user.email||"";
    __tier=__user.tier||"free";
    const tl=$("#tierLabel");if(tl)tl.textContent=(__user.tier_label||"Free")+" plan";
    const ub=$("#upgradeBtn");if(ub)ub.textContent=__tier==="free"?"Upgrade":"Manage";
    const sd=await authJson("/api/settings/user",{},null);
    if(sd&&sd.ok&&sd.settings){userSettings={...userSettings,...sd.settings};saveUserSettings();}
  }else{
    __tier="free";
    const tl=$("#tierLabel");if(tl)tl.textContent="Guest mode";
    const tm=$("#tierMeta");if(tm)tm.textContent="Sign in to save chats";
    const ub=$("#upgradeBtn");if(ub)ub.textContent="Sign in";
  }
  refreshModelLocks();
}
function renderSettings(){
  if($("#tempInput"))$("#tempInput").value=Math.round(userSettings.temperature*10);
  if($("#tempLabel"))$("#tempLabel").textContent=userSettings.temperature.toFixed(1);
  document.querySelectorAll("#lengthOptions .option-btn").forEach(b=>b.classList.toggle("active",b.dataset.length===userSettings.length));
  if($("#langSelect"))$("#langSelect").value=userSettings.language;
  if($("#toggleSound"))$("#toggleSound").textContent="Sound: "+(userSettings.soundOn?"ON":"OFF");
  if($("#toggleNotif"))$("#toggleNotif").textContent="Notifications: "+(userSettings.notifOn?"ON":"OFF");
  if($("#toggleScroll"))$("#toggleScroll").textContent="Auto-scroll: "+(userSettings.autoscroll?"ON":"OFF");
  if($("#toggleHighlight"))$("#toggleHighlight").textContent="Syntax highlight: "+(userSettings.highlightOn?"ON":"OFF");
  if($("#toggleLineNumbers"))$("#toggleLineNumbers").textContent="Line numbers: "+(userSettings.lineNumbers?"ON":"OFF");
  if($("#voiceRateInput"))$("#voiceRateInput").value=userSettings.voiceRate;
  if($("#voiceRateLabel"))$("#voiceRateLabel").textContent=userSettings.voiceRate.toFixed(1)+"×";
  loadVoices();
}
async function loadPersona(){if(!__user){if($("#personaInput"))$("#personaInput").value="";return;}const d=await authJson("/api/settings/persona",{},null);if($("#personaInput"))$("#personaInput").value=(d&&d.persona)||"";}
async function savePersona(){if(!__user){$("#personaStatus").textContent="Sign in first.";return;}const p=$("#personaInput")?.value||"";const s=$("#personaStatus");if(s)s.textContent="Saving…";const d=await authJson("/api/settings/persona",{method:"POST",body:JSON.stringify({persona:p})},null);if(s)s.textContent=(d&&d.ok)?"Saved.":"Failed.";}
async function loadMemory(){
  const list=$("#memoryList");if(!list)return;list.innerHTML="";
  if(!__user){list.innerHTML='<li class="memory-empty">Sign in to use memory.</li>';return;}
  const d=await authJson("/api/memory",{},null);
  const facts=(d&&d.facts)||[];
  if(!facts.length){list.innerHTML='<li class="memory-empty">Nothing remembered yet.</li>';return;}
  facts.forEach(f=>{
    const li=document.createElement("li");
    li.innerHTML=`<span>${escapeHtml(f.text)}</span><button class="memory-delete" data-id="${f.id}"><i class="ri-delete-bin-line"></i></button>`;
    li.querySelector(".memory-delete").addEventListener("click",async()=>{await authJson("/api/memory/"+f.id,{method:"DELETE"});loadMemory();});
    list.appendChild(li);
  });
}
async function addMemory(){if(!__user)return;const v=$("#memoryInput")?.value.trim();if(!v)return;await authJson("/api/memory",{method:"POST",body:JSON.stringify({fact:v})});$("#memoryInput").value="";loadMemory();}
async function loadPlans(){
  const {data}=await safeFetch("/api/subscription/plans",{cache:"no-store"});
  const plans=(data&&data.plans)||[];
  const grid=$("#plansGrid");if(!grid)return;
  grid.innerHTML=plans.map(p=>{
    const isCur=__user&&__tier===p.id,feat=p.id==="pro";
    let price='<span style="color:var(--text-muted);font-weight:700">Free</span>';
    if(p.price_robux>0)price=`R$ ${p.price_robux}<span style="font-size:11px;color:var(--text-muted);display:block">or ${p.price_afg} AFG</span>`;
    let buyBtn;
    if(p.id==="free")buyBtn=`<div class="plan-buy disabled">Free forever</div>`;
    else if(isCur)buyBtn=`<div class="plan-buy disabled">Current plan</div>`;
    else buyBtn=`<div class="plan-buy">Contact admin</div>`;
    return `<div class="plan-card${feat?" featured":""}${isCur?" current":""}">${isCur?'<span class="plan-badge current">Current</span>':(feat?'<span class="plan-badge">Popular</span>':"")}<div class="plan-name">${escapeHtml(p.label)}</div><div class="plan-tagline">${escapeHtml(p.tagline)}</div><div class="plan-price">${price}</div><ul class="plan-perks">${p.perks.map(x=>`<li><i class="ri-check-line"></i><span>${escapeHtml(x)}</span></li>`).join("")}</ul>${buyBtn}</div>`;
  }).join("");
}
async function loadUserKeys(){
  const list=$("#keysList");if(!list)return;
  if(!__user){list.innerHTML='<li class="key-empty">Sign in to manage API keys.</li>';return;}
  const d=await authJson("/api/keys",{},null);
  const keys=(d&&d.keys)||[];
  if(!keys.length){list.innerHTML='<li class="key-empty">No keys yet.</li>';return;}
  list.innerHTML=keys.map(k=>`<li class="key-item"><div class="key-info"><div class="key-name">${escapeHtml(k.name)}</div><div class="key-value">${escapeHtml(k.preview||"")}</div></div></li>`).join("");
}
async function genKey(){
  if(!__user){$("#keyGenStatus").textContent="Sign in first.";return;}
  const n=$("#newKeyNameInput")?.value.trim()||"My key";
  const s=$("#keyGenStatus");if(s)s.textContent="Generating…";
  const d=await authJson("/api/keys/generate",{method:"POST",body:JSON.stringify({name:n})},null);
  if(d&&d.ok){if(s)s.innerHTML=`Created ✅ — <code>${escapeHtml(d.key)}</code>`;if($("#newKeyNameInput"))$("#newKeyNameInput").value="";loadUserKeys();}
  else if(s)s.textContent=(d&&d.error)||"Failed.";
}
async function submitReport(){
  const s=$("#reportStatus");
  if(!__user){if(s)s.textContent="Sign in to send a ticket.";return;}
  const sub=$("#reportSubject")?.value.trim()||"";
  const msg=$("#reportMessage")?.value.trim()||"";
  if(!msg){if(s)s.textContent="Please describe your issue.";return;}
  if(s)s.textContent="Sending…";
  const d=await authJson("/api/report",{method:"POST",body:JSON.stringify({subject:sub,message:msg,category:"general"})},null);
  if(d&&d.ok){if(s)s.textContent="Ticket sent ✅";if($("#reportSubject"))$("#reportSubject").value="";if($("#reportMessage"))$("#reportMessage").value="";loadMyReports();}
  else if(s)s.textContent=(d&&d.error)||"Failed.";
}
async function loadMyReports(){
  const box=$("#supportMine");if(!box)return;
  if(!__user){box.innerHTML="";return;}
  const d=await authJson("/api/report/mine",{},null);
  const reports=(d&&d.reports)||[];
  if(!reports.length){box.innerHTML="";return;}
  box.innerHTML=`<h4 style="font-size:12px;color:var(--text-muted);margin-bottom:10px">YOUR TICKETS</h4>`+reports.map(t=>`<div style="background:var(--panel-2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px;font-size:13px"><b>${escapeHtml(t.subject)}</b><span style="color:var(--text-muted);font-size:11.5px"> · ${escapeHtml(t.status)}</span><div style="color:var(--text-muted);font-size:12px;margin-top:4px">${escapeHtml((t.messages[0]||{}).text||"")}</div></div>`).join("");
}

function buildModelPickerMenu(){
  const menu=$("#modelPickerMenu");if(!menu)return;
  const models=__config?.models||[];
  menu.innerHTML=models.map(m=>{const tier=m.tier||"free";const badge=tier!=="free"?`<span class="model-tier-badge ${tier}">${tier}</span>`:"";return `<button type="button" class="model-option" data-model-id="${m.id}" data-tier="${tier}"><span class="model-option-icon">${(m.label||"?")[0]}</span><span class="model-option-body"><span class="model-option-name">${escapeHtml(m.label)} ${badge}</span><span class="model-option-tag">${escapeHtml(m.tagline||"")}</span></span></button>`;}).join("");
  const def=getDefaultModel();__model=def;updateModelPickerLabel(def);
}
function updateModelPickerLabel(id){
  const m=(__config?.models||[]).find(x=>x.id===id);
  if(m&&$("#modelPickerLabel"))$("#modelPickerLabel").textContent=m.label;
  const menu=$("#modelPickerMenu");
  if(menu)menu.querySelectorAll(".model-option").forEach(o=>o.classList.toggle("active",o.dataset.modelId===id));
  __model=id;
}
function selectModel(id){
  const m=(__config?.models||[]).find(x=>x.id===id);if(!m)return;
  const rank={free:0,pro:1,ultimate:2};
  if((rank[m.tier]||0)>(rank[__tier]||0)&&m.tier!=="ultimate"){$("#modelPickerMenu")?.classList.remove("open");openModal("plansModal");loadPlans();return;}
  updateModelPickerLabel(id);$("#modelPickerMenu")?.classList.remove("open");
}
function refreshModelLocks(){
  const menu=$("#modelPickerMenu");if(!menu)return;
  const rank={free:0,pro:1,ultimate:2},u=rank[__tier]||0;
  menu.querySelectorAll(".model-option").forEach(o=>{const t=o.dataset.tier;let locked;if(!__user)locked=(rank[t]||0)>0&&t!=="ultimate";else if(__tier==="free"&&t==="ultimate")locked=false;else locked=(rank[t]||0)>u;o.classList.toggle("locked",locked);});
}

const root=document.documentElement;
function applyAppearance({mode,theme,corner,font}){
  if(mode)root.setAttribute("data-mode",mode);
  if(theme)root.setAttribute("data-theme",theme);
  if(corner)root.setAttribute("data-corner",corner);
  if(font)root.setAttribute("data-font",font);
  const hlLight=document.getElementById("hljs-light"),hlDark=document.getElementById("hljs-dark");
  if(hlLight&&hlDark){hlLight.disabled=mode==="dark";hlDark.disabled=mode!=="dark";}
  $$("#modeOptions .option-btn").forEach(b=>b.classList.toggle("active",b.dataset.mode===(mode||root.getAttribute("data-mode"))));
  $$("#themeSwatches .swatch").forEach(s=>s.classList.toggle("active",s.dataset.theme===(theme||root.getAttribute("data-theme"))));
  $$("#cornerOptions .option-btn").forEach(b=>b.classList.toggle("active",b.dataset.corner===(corner||root.getAttribute("data-corner"))));
  $$("#fontOptions .option-btn").forEach(b=>b.classList.toggle("active",b.dataset.font===(font||root.getAttribute("data-font"))));
}
function loadAppearance(){
  let s={};try{s=JSON.parse(localStorage.getItem("miroxai_appearance")||"{}");}catch{}
  applyAppearance({mode:s.mode||"light",theme:s.theme||"warm",corner:s.corner||"soft",font:s.font||"system"});
}
function saveAppearance(patch){let c={};try{c=JSON.parse(localStorage.getItem("miroxai_appearance")||"{}");}catch{}const m={...c,...patch};try{localStorage.setItem("miroxai_appearance",JSON.stringify(m));}catch{}applyAppearance(m);}

function loadBackground(){
  try{const s=JSON.parse(localStorage.getItem("miroxai_bg")||"{}");bgState={url:s.url||null,dim:s.dim??45,blur:s.blur??0};}catch{}
  applyBackground();populateBackgroundUI();
}
function applyBackground(){
  const el=$("#userBackground");if(!el)return;
  if(!bgState.url){el.classList.remove("active");el.style.backgroundImage="";root.style.setProperty("--bg-dim","0");root.style.setProperty("--bg-blur","0px");return;}
  el.classList.remove("active");
  requestAnimationFrame(()=>{
    el.style.backgroundImage=`url("${bgState.url}")`;
    root.style.setProperty("--bg-dim",(bgState.dim/100).toFixed(2));
    root.style.setProperty("--bg-blur",bgState.blur+"px");
    el.classList.add("active");
  });
}
function saveBgPrefs(){try{localStorage.setItem("miroxai_bg",JSON.stringify(bgState));}catch{}}
function populateBackgroundUI(){
  if($("#bgDimInput"))$("#bgDimInput").value=bgState.dim;
  if($("#bgBlurInput"))$("#bgBlurInput").value=bgState.blur;
  if($("#bgDimLabel"))$("#bgDimLabel").textContent=bgState.dim+"%";
  if($("#bgBlurLabel"))$("#bgBlurLabel").textContent=bgState.blur+"px";
  const u=$("#bgUrlInput");if(u)u.value=bgState.url&&!bgState.url.startsWith("data:")?bgState.url:"";
}

async function genImage(){
  const prompt=$("#imagePromptInput")?.value.trim();if(!prompt)return;
  const btn=$("#generateImageBtn"),status=$("#imageStudioStatus"),gallery=$("#imageGallery");
  if(btn)btn.disabled=true;
  if(status)status.textContent="Generating… this can take 10–30 seconds.";
  const card=document.createElement("div");card.className="gallery-card";
  card.innerHTML=`<div class="gallery-skeleton">Generating…</div>`;
  gallery?.prepend(card);
  const d=await authJson("/api/image/generate",{method:"POST",body:JSON.stringify({prompt})},null);
  if(d&&d.ok&&d.image){
    card.innerHTML=`<img src="${d.image}" alt="${escapeHtml(prompt)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=gallery-error><i class=ri-error-warning-line></i><span>Image failed to load</span></div>'">`;
    if(status)status.textContent="";
  }else{
    const msg=(d&&d.error)||"Image generation failed. Check that your HuggingFace token has inference permissions.";
    card.innerHTML=`<div class="gallery-error"><i class="ri-error-warning-line"></i><span>${escapeHtml(msg)}</span></div>`;
    if(status)status.textContent=msg;
  }
  if(btn)btn.disabled=false;
}

/* ---------- VOICE / TTS ---------- */
async function requestMic(){
  try{
    micStream=await navigator.mediaDevices.getUserMedia({audio:true});
    if($("#micStatus"))$("#micStatus").textContent="Microphone granted ✅";
    return true;
  }catch(e){
    if($("#micStatus"))$("#micStatus").textContent="Denied: "+e.message;
    return false;
  }
}
function loadVoices(){
  if(!synth||!$("#voiceSelect"))return;
  const voices=synth.getVoices();
  if(!voices.length)return;
  $("#voiceSelect").innerHTML=voices.map(v=>`<option value="${v.name}"${v.name===userSettings.voiceName?" selected":""}>${v.name} (${v.lang})</option>`).join("");
  if(!userSettings.voiceName&&voices[0])userSettings.voiceName=voices[0].name;
}
function speakText(text,onEnd){
  if(!synth||!text){onEnd&&onEnd();return;}
  try{synth.cancel();}catch{}
  const u=new SpeechSynthesisUtterance(String(text).slice(0,1500));
  const v=synth.getVoices().find(x=>x.name===userSettings.voiceName);
  if(v)u.voice=v;
  u.rate=userSettings.voiceRate||1;
  u.pitch=1;u.volume=1;
  let ended=false;
  const finish=()=>{if(ended)return;ended=true;clearTimeout(callSpeakEndTimer);onEnd&&onEnd();};
  u.onend=finish;u.onerror=finish;
  const estimated=Math.max(2000,Math.min(30000,String(text).length*80));
  callSpeakEndTimer=setTimeout(finish,estimated);
  try{synth.speak(u);}catch{finish();}
}
function startMic(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){alert("Voice input not supported in this browser.");return;}
  if(!recognition){
    recognition=new SR();
    recognition.continuous=false;recognition.interimResults=true;
    recognition.lang=userSettings.language||"en-US";
    recognition.onresult=e=>{let t="";for(let i=0;i<e.results.length;i++)t+=e.results[i][0].transcript;$("#messageInput").value=t;const sb=$("#sendBtn");if(sb)sb.disabled=false;};
    recognition.onend=()=>$("#micBtn")?.classList.remove("recording");
  }
  try{recognition.start();$("#micBtn")?.classList.add("recording");}catch{}
}

/* ---------- CALL MODE ---------- */
function setCallStatus(text){const el=$("#callStatus");if(el)el.textContent=text;}
function setCallTranscript(text){const el=$("#callTranscript");if(el)el.textContent=text;}
function setCallOrb(state){const orb=$("#callOrb");if(!orb)return;orb.classList.remove("listening","speaking");if(state)orb.classList.add(state);}

async function startCall(){
  if(callActive)return;
  if(!__user){openModal("loginModal");return;}
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){alert("Voice recognition is not supported in this browser. Try Chrome or Edge.");return;}
  if(!synth){alert("Speech synthesis is not supported in this browser.");return;}
  callActive=true;callMuted=false;
  $("#callOverlay")?.classList.add("open");
  $("#callMuteBtn")?.classList.remove("muted");
  setCallStatus("Requesting microphone…");
  setCallTranscript("Please allow microphone access…");
  setCallOrb(null);
  const ok=await requestMic();
  if(!callActive)return;
  if(!ok){setCallStatus("Microphone denied");setCallTranscript("Grant microphone permission and try again.");return;}
  setCallStatus("Connecting…");
  setCallTranscript("Say something to begin.");
  loadVoices();
  setTimeout(()=>{if(callActive)startCallListening();},400);
}
function startCallListening(){
  if(!callActive||callMuted)return;
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR)return;
  setCallStatus("Listening…");
  setCallOrb("listening");
  setCallTranscript("");
  callRecognition=new SR();
  callRecognition.continuous=false;callRecognition.interimResults=true;
  callRecognition.lang=userSettings.language||"en-US";
  callRecognition.maxAlternatives=1;
  let finalText="",sent=false;
  callRecognition.onresult=e=>{
    let interim="";
    for(let i=e.resultIndex;i<e.results.length;i++){
      const r=e.results[i];
      if(r.isFinal)finalText+=r[0].transcript;
      else interim+=r[0].transcript;
    }
    setCallTranscript(finalText||interim);
  };
  callRecognition.onerror=ev=>{
    if(!callActive)return;
    if(ev.error==="no-speech"){if(!callMuted&&callActive)setTimeout(startCallListening,500);return;}
    if(ev.error==="not-allowed"||ev.error==="service-not-allowed"){setCallStatus("Mic blocked");setCallTranscript("Microphone permission was denied.");return;}
    if(!callMuted&&callActive)setTimeout(startCallListening,800);
  };
  callRecognition.onend=()=>{
    if(!callActive)return;
    const said=(finalText||"").trim();
    if(said&&!sent){sent=true;sendCallMessage(said);}
    else if(!callMuted&&callActive){clearTimeout(callRestartTimer);callRestartTimer=setTimeout(startCallListening,400);}
  };
  try{callRecognition.start();}catch{clearTimeout(callRestartTimer);callRestartTimer=setTimeout(startCallListening,600);}
}
async function sendCallMessage(text){
  if(!callActive)return;
  setCallStatus("Thinking…");setCallOrb(null);
  try{
    const r=await authFetch("/api/chat",{method:"POST",body:JSON.stringify({message:text,history:[],model:__model||getDefaultModel(),voice_mode:true})});
    const d=await readJson(r,null);
    if(!callActive)return;
    if(!d||!d.ok){
      setCallStatus("Error");
      setCallTranscript((d&&d.error)||"Could not reach the AI.");
      clearTimeout(callRestartTimer);
      callRestartTimer=setTimeout(startCallListening,1500);
      return;
    }
    const reply=(d.reply||"").trim()||"I don't have a response.";
    setCallTranscript(reply);
    setCallStatus("Speaking…");
    setCallOrb("speaking");
    speakText(reply,()=>{
      if(!callActive)return;
      setCallOrb(null);
      if(!callMuted){setCallStatus("Listening…");clearTimeout(callRestartTimer);callRestartTimer=setTimeout(startCallListening,300);}
      else setCallStatus("Muted");
    });
  }catch{
    if(!callActive)return;
    setCallStatus("Error");setCallTranscript("Connection failed. Retrying…");
    clearTimeout(callRestartTimer);
    callRestartTimer=setTimeout(startCallListening,1500);
  }
}
function toggleMute(){
  callMuted=!callMuted;
  $("#callMuteBtn")?.classList.toggle("muted",callMuted);
  if(callMuted){
    try{callRecognition?.stop();}catch{}
    try{synth?.cancel();}catch{}
    setCallStatus("Muted");setCallOrb(null);
  }else if(callActive){
    setCallStatus("Listening…");
    clearTimeout(callRestartTimer);
    callRestartTimer=setTimeout(startCallListening,200);
  }
}
function endCall(){
  callActive=false;callMuted=false;
  clearTimeout(callRestartTimer);clearTimeout(callSpeakEndTimer);
  try{callRecognition?.stop();}catch{}
  try{synth?.cancel();}catch{}
  $("#callOverlay")?.classList.remove("open");
  setCallOrb(null);
  setCallStatus("Tap the mic to start");
  setCallTranscript("Say something…");
}

function updateRailToggleIcon(){const i=$("#railToggleIcon");if(!i)return;i.className=document.body.classList.contains("rail-collapsed")?"ri-side-bar-line":"ri-contract-left-line";}

async function boot(){
  try{killLoader();loadAppearance();loadBackground();loadUserSettings();}catch(e){}
  try{await loadConfig();}catch(e){}
  try{await loadMe();}catch(e){}
  try{loadChatsFromLS();renderHistory();}catch(e){}
  try{updateRailToggleIcon();renderSettings();}catch(e){}
  try{loadVoices();if(synth){synth.addEventListener?.("voiceschanged",loadVoices);}}catch(e){}
  killLoader();
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);
else boot();
setTimeout(()=>{try{renderHistory();}catch{}},1200);

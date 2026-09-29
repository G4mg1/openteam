const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);
let __config=null,__user=null,__tier="free",__model=null;
let currentConversationId=null,isReplying=false,__conversations=[],pendingFiles=[];
let bgState={url:null,dim:45,blur:0},recognition=null,callRecognition=null;
let synth=window.speechSynthesis,callActive=false,callMuted=false,micStream=null;
const LS_KEY="miroxai_conversations_v1",TOKEN_KEY="mirox_token",USER_SETTINGS_KEY="miroxai_user_settings";

/* ---------- SAFE JSON ---------- */
async function readJson(r, fallback=null){
  if(!r) return fallback;
  const ct=(r.headers.get("content-type")||"").toLowerCase();
  if(!ct.includes("application/json")){ try{ await r.text(); }catch{} return fallback; }
  try{ return await r.json(); } catch{ return fallback; }
}
async function safeFetch(url, opts={}){
  try{
    const r=await fetch(url,opts);
    const data=await readJson(r,null);
    return { ok:r.ok, status:r.status, data };
  }catch{ return { ok:false, status:0, data:null }; }
}

function getToken(){try{return localStorage.getItem(TOKEN_KEY)||"";}catch{return"";}}
function setToken(t){try{t?localStorage.setItem(TOKEN_KEY,t):localStorage.removeItem(TOKEN_KEY);}catch{}}
function authFetch(u,o={}){const h={"Content-Type":"application/json",...(o.headers||{})};const t=getToken();if(t)h.Authorization="Bearer "+t;return fetch(u,{...o,headers:h,credentials:"same-origin",cache:"no-store"});}
async function authJson(u,o={},fallback=null){
  try{ const r=await authFetch(u,o); return await readJson(r,fallback); }catch{ return fallback; }
}

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

let userSettings={temperature:0.7,length:"medium",language:"en",autoscroll:true,soundOn:true,notifOn:true,voiceRate:1,voiceName:""};
function loadUserSettings(){try{const s=JSON.parse(localStorage.getItem(USER_SETTINGS_KEY)||"{}");userSettings={...userSettings,...s};}catch{}}
function saveUserSettings(){try{localStorage.setItem(USER_SETTINGS_KEY,JSON.stringify(userSettings));}catch{}if(__user){authJson("/api/settings/user",{method:"POST",body:JSON.stringify({settings:userSettings})}).catch(()=>{});}}

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
  if(tg){const k=tg.dataset.toggle;userSettings[k]=!userSettings[k];tg.textContent=tg.textContent.replace(/ON|OFF/,userSettings[k]?"ON":"OFF");tg.classList.toggle("active",userSettings[k]);saveUserSettings();return;}
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
  if(closest("#testVoiceBtn")){speak("Hi, this is Mirox, made by the OpenSurr team.");return;}
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

/* ---------- FILE HANDLING ---------- */
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
      r.onload=()=>{
        newFiles.push({name:f.name,size:f.size,type:"image",content:"[Image] "+f.name,dataUrl:String(r.result),order:idx});
        done++;if(done===fileArr.length)finish();
      };
      r.onerror=()=>{done++;if(done===fileArr.length)finish();};
      r.readAsDataURL(f);
    }else{
      if(f.size>2*1024*1024){done++;if(done===fileArr.length)finish();return;}
      const r=new FileReader();
      r.onload=()=>{
        newFiles.push({name:f.name,size:f.size,type:"text",content:String(r.result).slice(0,50000),order:idx});
        done++;if(done===fileArr.length)finish();
      };
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

/* ---------- SEND ---------- */
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
    let buf="",full="",first=true;
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
            full+=evt.d;bubble.textContent=full;
            const cur=document.createElement("span");cur.className="stream-cursor";bubble.appendChild(cur);
            const chat=$("#chat");
            if(userSettings.autoscroll&&chat.scrollHeight-chat.scrollTop-chat.clientHeight<200)chat.scrollTop=chat.scrollHeight;
          }else if(evt.done){bubble.textContent=full||"(empty reply)";const sub=$("#chatSubtitle");if(sub)sub.textContent=(evt.model||"")+(evt.ms?` · ${evt.ms}ms`:"");}
          else if(evt.error)throw new Error(evt.error);
        }
      }
    }
    bubble.textContent=full||"(empty reply)";
    convo.messages.push({role:"ai",text:full});
    convo.updatedAt=Date.now();
    if(__user)saveChatsToLS();
  }catch(err){bubble.textContent=err.message||"Something went wrong.";}
  finally{isReplying=false;if(sb)sb.disabled=!($("#messageInput")?.value.trim());}
}

/* ---------- MESSAGES ---------- */
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
        const img=document.createElement("img");
        img.className="chat-file-img";img.src=f.dataUrl;img.alt=f.name;img.loading="lazy";
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
  const bubble=m.querySelector(".bubble");bubble.textContent=text||"";
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

/* ---------- CHATS ---------- */
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

/* ---------- AUTH ---------- */
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

/* ---------- LOADERS ---------- */
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
  if($("#voiceRateInput"))$("#voiceRateInput").value=userSettings.voiceRate;
  if($("#voiceRateLabel"))$("#voiceRateLabel").textContent=userSettings.voiceRate.toFixed(1)+"×";
  loadVoices();
}
async function loadPersona(){if(!__user){if($("#personaInput"))$("#personaInput").value="";return;}const d=await authJson("/api/settings/persona",{},null);if($("#personaInput"))$("#personaInput").value=(d&&d.persona)||"";}
async function savePersona(){
  if(!__user){$("#personaStatus").textContent="Sign in first.";return;}
  const p=$("#personaInput")?.value||"";
  const s=$("#personaStatus");if(s)s.textContent="Saving…";
  const d=await authJson("/api/settings/persona",{method:"POST",body:JSON.stringify({persona:p})},null);
  if(s)s.textContent=(d&&d.ok)?"Saved.":"Failed.";
}
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
async function addMemory(){
  if(!__user)return;
  const v=$("#memoryInput")?.value.trim();if(!v)return;
  await authJson("/api/memory",{method:"POST",body:JSON.stringify({fact:v})});
  $("#memoryInput").value="";loadMemory();
}
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

/* ---------- MODEL PICKER ---------- */
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

/* ---------- APPEARANCE ---------- */
const root=document.documentElement;
function applyAppearance({mode,theme,corner,font}){
  if(mode)root.setAttribute("data-mode",mode);
  if(theme)root.setAttribute("data-theme",theme);
  if(corner)root.setAttribute("data-corner",corner);
  if(font)root.setAttribute("data-font",font);
  $$("#modeOptions .option-btn").forEach(b=>b.classList.toggle("active",b.dataset.mode===(mode||root.getAttribute("data-mode"))));
  $$("#themeSwatches .swatch").forEach(s=>s.classList.toggle("active",s.dataset.theme===(theme||root.getAttribute("data-theme"))));
  $$("#cornerOptions .option-btn").forEach(b=>b.classList.toggle("active",b.dataset.corner===(corner||root.getAttribute("data-corner"))));
  $$("#fontOptions .option-btn").forEach(b=>b.classList.toggle("active",b.dataset.font===(font||root.getAttribute("data-font"))));
}
function loadAppearance(){let s={};try{s=JSON.parse(localStorage.getItem("miroxai_appearance")||"{}");}catch{}applyAppearance({mode:s.mode||"light",theme:s.theme||"warm",corner:s.corner||"soft",font:s.font||"system"});}
function saveAppearance(patch){let c={};try{c=JSON.parse(localStorage.getItem("miroxai_appearance")||"{}");}catch{}const m={...c,...patch};try{localStorage.setItem("miroxai_appearance",JSON.stringify(m));}catch{}applyAppearance(m);}

/* ---------- BACKGROUND ---------- */
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

/* ---------- IMAGE STUDIO ---------- */
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

/* ---------- VOICE ---------- */
async function requestMic(){
  try{micStream=await navigator.mediaDevices.getUserMedia({audio:true});if($("#micStatus"))$("#micStatus").textContent="Microphone granted ✅";return true;}
  catch(e){if($("#micStatus"))$("#micStatus").textContent="Denied: "+e.message;return false;}
}
function loadVoices(){
  if(!synth||!$("#voiceSelect"))return;
  const voices=synth.getVoices();if(!voices.length)return;
  $("#voiceSelect").innerHTML=voices.map(v=>`<option value="${v.name}"${v.name===userSettings.voiceName?" selected":""}>${v.name} (${v.lang})</option>`).join("");
}
function speak(text,onEnd){
  if(!synth){onEnd&&onEnd();return;}
  synth.cancel();
  const u=new SpeechSynthesisUtterance(text);
  const v=synth.getVoices().find(x=>x.name===userSettings.voiceName);
  if(v)u.voice=v;u.rate=userSettings.voiceRate||1;
  u.onend=()=>onEnd&&onEnd();u.onerror=()=>onEnd&&onEnd();
  synth.speak(u);
}
function startMic(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){alert("Voice input not supported.");return;}
  if(!recognition){
    recognition=new SR();recognition.continuous=false;recognition.interimResults=true;
    recognition.onresult=e=>{let t="";for(let i=0;i<e.results.length;i++)t+=e.results[i][0].transcript;$("#messageInput").value=t;const sb=$("#sendBtn");if(sb)sb.disabled=false;};
    recognition.onend=()=>$("#micBtn")?.classList.remove("recording");
  }
  try{recognition.start();$("#micBtn")?.classList.add("recording");}catch{}
}

/* ---------- CALL ---------- */
async function startCall(){
  if(!__user){openModal("loginModal");return;}
  callActive=true;callMuted=false;
  $("#callOverlay").classList.add("open");
  $("#callStatus").textContent="Requesting mic…";
  const ok=await requestMic();
  if(!ok){$("#callStatus").textContent="Mic denied";return;}
  $("#callStatus").textContent="Listening…";
  $("#callOrb")?.classList.add("listening");
  startCallListening();
}
function startCallListening(){
  if(!callActive||callMuted)return;
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){$("#callStatus").textContent="Voice not supported";return;}
  callRecognition=new SR();
  callRecognition.continuous=false;callRecognition.interimResults=true;
  callRecognition.onresult=e=>{let t="";for(let i=0;i<e.results.length;i++)t+=e.results[i][0].transcript;$("#callTranscript").textContent=t;};
  callRecognition.onend=()=>{if(!callActive)return;const s=$("#callTranscript").textContent.trim();if(s&&!callMuted)sendCallMessage(s);else if(!callMuted)startCallListening();};
  callRecognition.onerror=()=>{if(callActive&&!callMuted)setTimeout(startCallListening,500);};
  try{callRecognition.start();}catch{}
}
async function sendCallMessage(text){
  $("#callStatus").textContent="Thinking…";
  $("#callOrb")?.classList.remove("listening");
  const d=await authJson("/api/chat",{method:"POST",body:JSON.stringify({message:text,history:[],model:__model||getDefaultModel()})},null);
  if(!callActive)return;
  if(!d||!d.ok){$("#callStatus").textContent="Error";return;}
  $("#callTranscript").textContent=d.reply||"(no reply)";
  $("#callStatus").textContent="Speaking…";
  $("#callOrb")?.classList.add("speaking");
  speak(d.reply,()=>{
    if(!callActive)return;
    $("#callOrb")?.classList.remove("speaking");
    $("#callStatus").textContent="Listening…";
    $("#callOrb")?.classList.add("listening");
    startCallListening();
  });
}
function toggleMute(){
  callMuted=!callMuted;
  $("#callMuteBtn")?.classList.toggle("muted",callMuted);
  if(callMuted){try{callRecognition?.stop();}catch{};$("#callStatus").textContent="Muted";}
  else{startCallListening();$("#callStatus").textContent="Listening…";}
}
function endCall(){
  callActive=false;
  try{callRecognition?.stop();}catch{}
  if(synth)synth.cancel();
  $("#callOverlay").classList.remove("open");
  $("#callOrb")?.classList.remove("listening","speaking");
}

function updateRailToggleIcon(){const i=$("#railToggleIcon");if(!i)return;i.className=document.body.classList.contains("rail-collapsed")?"ri-side-bar-line":"ri-contract-left-line";}

/* ---------- BOOT ---------- */
async function boot(){
  try{killLoader();loadAppearance();loadBackground();loadUserSettings();}catch(e){}
  try{await loadConfig();}catch(e){}
  try{await loadMe();}catch(e){}
  try{loadChatsFromLS();renderHistory();}catch(e){}
  try{updateRailToggleIcon();renderSettings();}catch(e){}
  try{loadVoices();if(synth)synth.addEventListener?.("voiceschanged",loadVoices);}catch(e){}
  killLoader();
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);
else boot();
setTimeout(()=>{try{renderHistory();}catch{}},1200);

const express = require('express');
const crypto  = require('crypto');
const app = express();
app.use(express.json({ limit: '15mb' }));

const OPENAI_API_KEY  = (process.env.OPENAI_API_KEY || '').trim();
const HF_API_KEY      = (process.env.HF_API_KEY || '').trim();
const DISCORD_WEBHOOK = (process.env.DISCORD_WEBHOOK || '').trim();
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD || '2010';
const SECRET          = process.env.SECRET_KEY || 'mirox-dev-fallback-change-me';

const OPENAI_CHAT   = 'https://api.openai.com/v1/chat/completions';
const OPENAI_IMAGES = 'https://api.openai.com/v1/images/generations';
const HF_CHAT       = 'https://router.huggingface.co/v1/chat/completions';

/* ---------- Upstash persistence ---------- */
const KV_URL   = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
const KV_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const KV_ON    = !!(KV_URL && KV_TOKEN);

async function kvGet(key){
  if(!KV_ON)return null;
  try{
    const r=await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${KV_TOKEN}`}});
    if(!r.ok)return null;
    const j=await r.json();
    if(!j||j.result==null)return null;
    try{return typeof j.result==='string'?JSON.parse(j.result):j.result;}catch{return j.result;}
  }catch{return null;}
}
async function kvSet(key,value){
  if(!KV_ON)return false;
  try{
    const v=typeof value==='string'?value:JSON.stringify(value);
    const r=await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(v)}`,{method:'POST',headers:{Authorization:`Bearer ${KV_TOKEN}`}});
    return r.ok;
  }catch{return false;}
}
async function kvDel(key){
  if(!KV_ON)return false;
  try{
    const r=await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`,{method:'POST',headers:{Authorization:`Bearer ${KV_TOKEN}`}});
    return r.ok;
  }catch{return false;}
}

/* ---------- Session ---------- */
function signSession(d){const p=Buffer.from(JSON.stringify(d)).toString('base64url');return p+'.'+crypto.createHmac('sha256',SECRET).update(p).digest('base64url');}
function verifySession(t){if(!t)return{};const a=t.split('.');if(a.length!==2)return{};const e=crypto.createHmac('sha256',SECRET).update(a[0]).digest('base64url');if(e!==a[1])return{};try{return JSON.parse(Buffer.from(a[0],'base64url').toString());}catch{return{};}}
function getSession(req){const a=req.headers.authorization||'';if(a.startsWith('Bearer ')){const s=verifySession(a.slice(7).trim());if(s&&s.uid)return s;}const m=(req.headers.cookie||'').match(/(?:^|;\s*)mirox_sess=([^;]+)/);if(!m)return{};return verifySession(decodeURIComponent(m[1]));}
function setSession(res,d){const t=signSession(d);const sc=process.env.VERCEL==='1'?'; Secure':'';res.setHeader('Set-Cookie',`mirox_sess=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*60*60}${sc}`);return t;}
function clearSession(res){res.setHeader('Set-Cookie','mirox_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');}

/* ---------- Stores ---------- */
const USERS=Object.create(null),MEMORY=Object.create(null),PERSONAS=Object.create(null),KEYS=Object.create(null),TICKETS=Object.create(null),TICKET_BY_ID=Object.create(null),SETTINGS=Object.create(null);
const CHAT_LOG=[],IMG_LOG=[],USER_LOG=[],KB=[];

const COLORS={signin:0x16a34a,chat:0x3b82f6,image:0x8b5cf6,subscription:0xd97706,error:0xef4444,admin:0xdc2626,support:0x0ea5e9};
async function logDiscord(kind,title,description='',fields=[]){
  if(!DISCORD_WEBHOOK)return;
  const embed={title,description:(description||'').slice(0,2000),color:COLORS[kind]||0x6366f1,footer:{text:'MiroxAI'},timestamp:new Date().toISOString()};
  if(fields?.length)embed.fields=fields.map(([k,v])=>({name:String(k).slice(0,200),value:String(v).slice(0,1000),inline:false}));
  try{await fetch(DISCORD_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'MiroxAI',embeds:[embed]})});}catch{}
}

/* ---------- Models ---------- */
const MODELS={
  'mirox-luna-1.2':{label:'Luna',tagline:'Fast · warm',tier:'free',default:true,openai:'gpt-4o-mini',tokens:900,
    prompt:'You are Luna, a warm and friendly assistant created by the OpenSurr team. Speak naturally. When writing code, ALWAYS use fenced code blocks with the language name on the opening fence line, like ```python\\n...\\n```. Never mention any other company or AI model. If asked who made you, answer: OpenSurr. If asked your model name, answer: Luna.'},
  'mirox-gen-1':{label:'Gen',tagline:'Ultra concise',tier:'free',fallback:true,openai:'gpt-4o-mini',tokens:600,
    prompt:'You are Gen, an ultra-concise assistant from the OpenSurr team. For code, output ONLY the code block with the language name on the opening fence. Never mention any other company or AI model. If asked who made you, answer: OpenSurr.'},
  'mirox-pro-5':{label:'Pro',tagline:'Balanced · thorough',tier:'pro',openai:'gpt-4o-mini',tokens:1400,
    prompt:'You are Pro, a professional assistant from the OpenSurr team. When writing code, ALWAYS use fenced code blocks with the language name on the opening fence line. Never mention any other company or AI model. If asked who made you, answer: OpenSurr. If asked your model name, answer: Pro.'},
  'mirox-ultra-10':{label:'Ultra',tagline:'Deep reasoning',tier:'pro',openai:'gpt-4o',tokens:1800,
    prompt:'You are Ultra, an analytical assistant from the OpenSurr team. When writing code, ALWAYS use fenced code blocks with the language name on the opening fence line. Never mention any other company or AI model. If asked who made you, answer: OpenSurr. If asked your model name, answer: Ultra.'},
  'mirox-eclipse-2.0':{label:'Eclipse',tagline:'Advanced · creative',tier:'ultimate',openai:'gpt-4o',tokens:2400,
    prompt:'You are Eclipse, the most advanced assistant from the OpenSurr team. When writing code, ALWAYS use fenced code blocks with the language name on the opening fence line. Never mention any other company or AI model. If asked who made you, answer: OpenSurr. If asked your model name, answer: Eclipse.'},
};
const HF_FALLBACK=[{h:'Qwen/Qwen2.5-7B-Instruct',t:700},{h:'meta-llama/Llama-3.1-8B-Instruct',t:900},{h:'mistralai/Mistral-7B-Instruct-v0.3',t:700}];
const TIER_RANK={free:0,pro:1,ultimate:2};
const PLANS={
  free:{label:'Free',daily_limit:50,ultimate_trial_limit:10,price_robux:0,price_afg:0,price_hesab:0,gamepass_id:''},
  pro:{label:'Pro',daily_limit:500,ultimate_trial_limit:0,price_robux:250,price_afg:120,price_hesab:150,gamepass_id:''},
  ultimate:{label:'Ultimate',daily_limit:5000,ultimate_trial_limit:0,price_robux:1200,price_afg:450,price_hesab:550,gamepass_id:''},
};
const ANNOUNCEMENT={enabled:true,version:'v13-luna',title:'Meet Luna',image:'Luna.png',body:'Luna is now the default — warm, smart, and free.',highlights:['Luna — new default, free','Vision + web search','DALL·E 3 image generation','Live support chat']};
const now=()=>Math.floor(Date.now()/1000);
const today=()=>new Date().toISOString().slice(0,10);

function newUserRecord(email,name){
  return {email,name:name||'',tier:'free',tier_expires:0,daily_used:0,trial_used:0,daily_reset:today(),gmail:'',settings:{},created_at:now()};
}
async function getUserRecord(email){
  if(!email)return null;
  if(USERS[email])return USERS[email];
  const rec=await kvGet(`mirox:user:${email}`);
  if(rec){USERS[email]=rec;return rec;}
  return null;
}
async function saveUserRecord(rec){
  if(!rec||!rec.email)return;
  USERS[rec.email]=rec;
  await kvSet(`mirox:user:${rec.email}`,rec);
}
async function ensureFreshUser(email){
  if(!email)return null;
  let rec=await getUserRecord(email);
  if(!rec){rec=newUserRecord(email,'');await saveUserRecord(rec);return rec;}
  let dirty=false;
  if(rec.daily_reset!==today()){rec.daily_used=0;rec.trial_used=0;rec.daily_reset=today();dirty=true;}
  if(rec.tier_expires&&rec.tier_expires<now()&&rec.tier!=='free'){rec.tier='free';rec.tier_expires=0;dirty=true;}
  if(dirty)await saveUserRecord(rec);
  return rec;
}
async function currentUser(req){const s=getSession(req);if(!s.uid)return null;return await ensureFreshUser(s.uid);}
function sessionOnly(req){const s=getSession(req);return s.uid?s:null;}

/* ---------- Provider streams ---------- */
async function openaiStream(model,messages,maxTokens,signal){
  if(!OPENAI_API_KEY)throw new Error('OPENAI_API_KEY not configured');
  const r=await fetch(OPENAI_CHAT,{method:'POST',
    headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json','Accept':'text/event-stream'},
    body:JSON.stringify({model,messages,max_tokens:maxTokens,temperature:0.7,stream:true}),signal});
  if(!r.ok){let b='';try{b=(await r.text()).slice(0,300);}catch{};throw new Error(`OpenAI ${r.status} ${b}`);}
  return r.body;
}
async function hfStream(chain,messages,maxTokens,signal){
  if(!HF_API_KEY)throw new Error('HF_API_KEY not configured');
  const errors=[];
  for(const m of chain){
    const modelId=typeof m==='string'?m:m.h;
    try{
      const r=await fetch(HF_CHAT,{method:'POST',
        headers:{'Authorization':`Bearer ${HF_API_KEY}`,'Content-Type':'application/json','Accept':'text/event-stream'},
        body:JSON.stringify({model:modelId,messages,max_tokens:maxTokens,temperature:0.7,stream:true}),signal});
      if(!r.ok){errors.push(`${modelId}:${r.status}`);continue;}
      return r.body;
    }catch(e){if(e.name==='AbortError')throw e;errors.push(`${modelId}:${e.message.slice(0,40)}`);}
  }
  throw new Error(`All HF models failed → ${errors.slice(0,3).join(' | ')}`);
}
async function webSearch(q){
  try{
    const r=await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`);
    if(!r.ok)return null;
    const j=await r.json();
    const parts=[];
    if(j.AbstractText)parts.push(j.AbstractText);
    if(j.Answer)parts.push('Answer: '+j.Answer);
    if(Array.isArray(j.RelatedTopics)){
      for(const t of j.RelatedTopics.slice(0,6)){
        if(t.Text)parts.push('• '+t.Text);
        else if(Array.isArray(t.Topics))for(const s of t.Topics.slice(0,3))if(s.Text)parts.push('• '+s.Text);
      }
    }
    return (parts.join('\n').slice(0,2500))||null;
  }catch{return null;}
}

function buildMessages(systemPrompt,history,userText,persona='',mem=[],searchCtx='',files=[]){
  let sys=systemPrompt;
  if(KB.length){const r=KB.slice(-50).map(k=>`- ${k.q?k.q+': ':''}${k.a}`).join('\n');sys+='\n\nKNOWLEDGE BASE:\n'+r;}
  const msgs=[{role:'system',content:sys}];
  if(persona)msgs.push({role:'system',content:`User preference: ${String(persona).slice(0,1500)}`});
  if(mem.length)msgs.push({role:'system',content:'Remember: '+mem.slice(-8).map(m=>m.text).join(' | ')});
  if(searchCtx)msgs.push({role:'system',content:'WEB SEARCH RESULTS (current facts):\n'+searchCtx});
  for(const h of (history||[]).slice(-14)){
    const role=h.role,txt=String(h.content||'').trim().slice(0,4000);
    if((role==='user'||role==='assistant')&&txt)msgs.push({role,content:txt});
  }
  const textFiles=(files||[]).filter(f=>f.type!=='image');
  const imageFiles=(files||[]).filter(f=>f.type==='image'&&f.dataUrl);
  let textPart=userText||'';
  if(textFiles.length){
    const fileText=textFiles.map(f=>`[Attached file: ${f.name}]\n\`\`\`\n${String(f.content||'').slice(0,6000)}\n\`\`\``).join('\n\n');
    textPart=(fileText+'\n\n'+(userText||'')).trim();
  }
  if(imageFiles.length){
    const content=[{type:'text',text:textPart||'Please look at the attached image(s).'}];
    for(const img of imageFiles)content.push({type:'image_url',image_url:{url:img.dataUrl}});
    msgs.push({role:'user',content});
  }else{
    msgs.push({role:'user',content:textPart||'(empty)'});
  }
  return msgs;
}
async function pipeSSE(stream,res,onDone){
  const reader=stream.getReader(),dec=new TextDecoder();
  let buf='',full='';
  while(true){
    const {value,done}=await reader.read();if(done)break;
    buf+=dec.decode(value,{stream:true});
    let idx;
    while((idx=buf.indexOf('\n'))!==-1){
      const line=buf.slice(0,idx).trim();buf=buf.slice(idx+1);
      if(!line.startsWith('data:'))continue;
      const pl=line.slice(5).trim();if(!pl||pl==='[DONE]')continue;
      try{const o=JSON.parse(pl);const d=o.choices?.[0]?.delta?.content;if(d){full+=d;res.write(`data: ${JSON.stringify({d})}\n\n`);}}catch{}
    }
  }
  if(onDone)onDone(full);
  return full;
}

/* ---------- Config / health ---------- */
app.get(['/api/config','/config','/config.json'],async(req,res)=>{
  const u=await currentUser(req);
  res.json({app:{name:'MiroxAI',made_by:'OpenSurr',version:'v13'},
    models:Object.entries(MODELS).map(([id,m])=>({id,label:m.label,tagline:m.tagline,tier:m.tier,default:!!m.default,fallback:!!m.fallback})),
    plans:PLANS,announcement:ANNOUNCEMENT,
    user_tier:u?u.tier:'free',guest:!u,
    openai_ready:!!OPENAI_API_KEY,hf_ready:!!HF_API_KEY,kv_ready:KV_ON,
    maintenance:!!SETTINGS.maintenance});
});
app.get(['/api/health','/health','/api/ping','/ping'],(req,res)=>{
  res.json({ok:true,app:'MiroxAI',openai:!!OPENAI_API_KEY,hf:!!HF_API_KEY,kv:KV_ON,t:now()});
});

/* ---------- Auth ---------- */
app.post(['/api/auth/simple-login','/auth/simple-login'],async(req,res)=>{
  const {name,email}=req.body||{};
  const n=String(name||'').trim().slice(0,60);
  const e=String(email||'').trim().toLowerCase().slice(0,120);
  if(!n||!e||!e.includes('@')||!e.split('@')[1].includes('.'))return res.status(400).json({ok:false,error:'Valid name and email required'});
  let rec=await getUserRecord(e);
  const existing=!!rec;
  if(!rec)rec=newUserRecord(e,n);
  else rec.name=n;
  await saveUserRecord(rec);
  const idx=(await kvGet('mirox:user_index'))||[];
  if(!Array.isArray(idx)){}else if(!idx.includes(e)){idx.push(e);await kvSet('mirox:user_index',idx);}
  else {await kvSet('mirox:user_index',[e]);}
  const token=setSession(res,{uid:e,name:n,tier:rec.tier});
  USER_LOG.unshift({email:e,event:existing?'signin':'signup',ts:now(),ua:req.headers['user-agent']||''});
  if(USER_LOG.length>1000)USER_LOG.length=1000;
  logDiscord('signin',existing?'👤 Sign in':'👤 New user','',[['Name',n],['Email',e],['Tier',rec.tier]]);
  res.json({ok:true,token,user:{id:e,email:e,name:n,tier:rec.tier,tier_label:PLANS[rec.tier].label}});
});
app.post(['/api/logout','/logout'],(req,res)=>{
  const s=getSession(req);if(s.uid)USER_LOG.unshift({email:s.uid,event:'logout',ts:now(),ua:req.headers['user-agent']||''});
  clearSession(res);res.json({ok:true});
});
app.get(['/api/me','/me'],async(req,res)=>{
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
  const u=await currentUser(req);
  if(!u)return res.json({user:null});
  res.json({user:{id:u.email,email:u.email,name:u.name,tier:u.tier,tier_label:PLANS[u.tier].label}});
});

/* ---------- Subscription ---------- */
app.get(['/api/subscription/me','/subscription/me'],async(req,res)=>{
  const u=await currentUser(req);
  if(!u)return res.json({ok:false,error:'Sign in first'});
  const p=PLANS[u.tier];
  const trialLimit=p.ultimate_trial_limit||0;
  const trialUsed=u.trial_used||0;
  const dailyRemaining=Math.max(0,p.daily_limit-(u.daily_used||0));
  const ks=KEYS[u.email]||[];
  res.json({ok:true,tier:u.tier,tier_label:p.label,
    daily_limit:p.daily_limit,daily_remaining:dailyRemaining,
    trial_limit:trialLimit,trial_remaining:Math.max(0,trialLimit-trialUsed),
    trial_used:trialUsed,daily_used:u.daily_used||0,
    images_allowed:true,email_connected:!!u.gmail,
    keys_remaining:Math.max(0,3-ks.length),keys_per_period:3,refill_days:1,
    lite_mode:dailyRemaining<=0});
});
app.get(['/api/subscription/plans','/subscription/plans'],(req,res)=>{
  const perks={
    free:['Luna & Gen — free models','Vision + web search','10 Eclipse chats/day','Memory & persona'],
    pro:['Pro & Ultra models','500 msgs/day','DALL·E 3 image generation','Priority speed'],
    ultimate:['Eclipse — best model','5000 msgs/day','Everything in Pro','Ultimate badge'],
  };
  const out=Object.entries(PLANS).map(([id,p])=>({id,label:p.label,
    tagline:{free:'Free forever',pro:'Most popular',ultimate:'For power users'}[id],
    daily_limit:p.daily_limit,price_robux:p.price_robux,price_afg:p.price_afg,
    price_hesab:p.price_hesab,gamepass_id:p.gamepass_id,perks:perks[id]}));
  res.json({ok:true,plans:out,admin_email:'admin@example.com',admin_phone:''});
});

/* ---------- Chat stream ---------- */
app.post(['/api/chat/stream','/chat/stream'],async(req,res)=>{
  if(SETTINGS.maintenance)return res.status(503).json({ok:false,error:'Server is in maintenance mode.'});
  const {message,history,model:modelKey,web_search,files}=req.body||{};
  const msg=String(message||'').trim();
  if(!msg&&!files?.length)return res.status(400).json({ok:false,error:'Empty message'});

  const u=await currentUser(req);
  const userTier=u?u.tier:'free';

  if(u){
    const plan=PLANS[u.tier];
    if((u.daily_used||0)>=plan.daily_limit){
      return res.status(429).json({ok:false,error:`Daily message limit reached (${plan.daily_limit}/day). Refills in 24 hours.`,limit_reached:true,daily_remaining:0,daily_limit:plan.daily_limit});
    }
  }

  const requestedKey=modelKey||'mirox-luna-1.2';
  let cfg=MODELS[requestedKey]||MODELS['mirox-luna-1.2'];
  const originalLabel=cfg.label;
  let switched=false,usingTrial=false;
  if(TIER_RANK[cfg.tier]>TIER_RANK[userTier]){
    if(userTier==='free'&&cfg.tier==='ultimate'){
      const tl=PLANS.free.ultimate_trial_limit||0;
      const tu=u?(u.trial_used||0):0;
      if(tu>=tl){cfg=MODELS['mirox-luna-1.2'];switched=true;}
      else{usingTrial=true;}
    }else{cfg=MODELS['mirox-luna-1.2'];switched=true;}
  }

  const mem=u?(MEMORY[u.email]||[]):[];
  const persona=u?(PERSONAS[u.email]||''):'';
  let searchCtx='';
  if(web_search&&msg){const r=await webSearch(msg);if(r)searchCtx=r;}

  const msgs=buildMessages(cfg.prompt,history,msg,persona,mem,searchCtx,files||[]);
  CHAT_LOG.unshift({email:u?u.email:'guest',model:cfg.label,message:msg.slice(0,1000),reply:'',ts:now()});
  if(CHAT_LOG.length>500)CHAT_LOG.length=500;

  res.setHeader('Content-Type','text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control','no-cache, no-transform');
  res.setHeader('X-Accel-Buffering','no');
  res.setHeader('Connection','keep-alive');
  if(res.flushHeaders)res.flushHeaders();

  const t0=Date.now();let fullReply='',usedModel=cfg.label,localFallback=false;
  const abortCtrl=new AbortController();
  req.on('close',()=>{try{abortCtrl.abort();}catch{}});

  try{
    let stream=null;
    if(OPENAI_API_KEY){try{stream=await openaiStream(cfg.openai,msgs,cfg.tokens,abortCtrl.signal);usedModel=cfg.openai;}catch(e){if(e.name==='AbortError')throw e;stream=null;}}
    if(!stream&&HF_API_KEY){stream=await hfStream(HF_FALLBACK,msgs,cfg.tokens,abortCtrl.signal);usedModel='HF-fallback';}
    if(!stream){localFallback=true;throw new Error('No AI provider available');}
    await pipeSSE(stream,res,(full)=>{fullReply=full;});
  }catch(e){
    if(e.name!=='AbortError'){
      localFallback=true;
      res.write(`data: ${JSON.stringify({error:String(e.message).slice(0,240)})}\n\n`);
      logDiscord('error','❌ Chat failed',String(e.message).slice(0,400),[]);
    }
  }

  if(u&&!localFallback){
    u.daily_used=(u.daily_used||0)+1;
    if(usingTrial)u.trial_used=(u.trial_used||0)+1;
    await saveUserRecord(u);
  }
  if(CHAT_LOG[0])CHAT_LOG[0].reply=fullReply.slice(0,2000);

  const plan=u?PLANS[u.tier]:PLANS.free;
  const dailyUsed=u?(u.daily_used||0):0;
  const dailyRemaining=Math.max(0,plan.daily_limit-dailyUsed);
  const trialLimit=plan.ultimate_trial_limit||0;
  const trialUsed=u?(u.trial_used||0):0;
  const trialRemaining=Math.max(0,trialLimit-trialUsed);

  res.write(`data: ${JSON.stringify({done:true,model:cfg.label,used:usedModel,ms:Date.now()-t0,
    switched,switchedFrom:switched?originalLabel:null,
    using_trial:usingTrial,
    daily_used:dailyUsed,daily_remaining:dailyRemaining,daily_limit:plan.daily_limit,
    trial_used:trialUsed,trial_remaining:trialRemaining,trial_limit:trialLimit})}\n\n`);
  res.end();
});

/* ---------- Chat (non-stream) ---------- */
app.post(['/api/chat','/chat'],async(req,res)=>{
  if(SETTINGS.maintenance)return res.status(503).json({ok:false,error:'Maintenance mode'});
  const {message,history,model:modelKey}=req.body||{};
  const msg=String(message||'').trim();
  if(!msg)return res.status(400).json({ok:false,error:'Empty message'});
  const u=await currentUser(req);
  const userTier=u?u.tier:'free';
  if(u){
    const plan=PLANS[u.tier];
    if((u.daily_used||0)>=plan.daily_limit)return res.status(429).json({ok:false,error:`Daily limit reached (${plan.daily_limit}/day).`});
  }
  const requestedKey=modelKey||'mirox-luna-1.2';
  let cfg=MODELS[requestedKey]||MODELS['mirox-luna-1.2'];
  let usingTrial=false;
  if(TIER_RANK[cfg.tier]>TIER_RANK[userTier]){
    if(userTier==='free'&&cfg.tier==='ultimate'){
      const tl=PLANS.free.ultimate_trial_limit||0;
      const tu=u?(u.trial_used||0):0;
      if(tu<tl)usingTrial=true;else cfg=MODELS['mirox-luna-1.2'];
    }else{cfg=MODELS['mirox-luna-1.2'];}
  }
  const mem=u?(MEMORY[u.email]||[]):[];
  const persona=u?(PERSONAS[u.email]||''):'';
  const msgs=buildMessages(cfg.prompt,history,msg,persona,mem);
  try{
    let stream;
    if(OPENAI_API_KEY){try{stream=await openaiStream(cfg.openai,msgs,cfg.tokens);}catch{stream=null;}}
    if(!stream&&HF_API_KEY)stream=await hfStream(HF_FALLBACK,msgs,cfg.tokens);
    if(!stream)throw new Error('No AI provider available');
    let out='';
    await pipeSSE(stream,{write:()=>{}},(f)=>{out=f;});
    if(u){u.daily_used=(u.daily_used||0)+1;if(usingTrial)u.trial_used=(u.trial_used||0)+1;await saveUserRecord(u);}
    res.json({ok:true,reply:out,model:cfg.label});
  }catch(e){res.status(502).json({ok:false,error:String(e.message).slice(0,200)});}
});

/* ---------- Memory / persona / settings ---------- */
app.get(['/api/memory','/memory'],(req,res)=>{const s=sessionOnly(req);if(!s)return res.json({ok:true,facts:[]});res.json({ok:true,facts:MEMORY[s.uid]||[]});});
app.post(['/api/memory','/memory'],(req,res)=>{const s=sessionOnly(req);if(!s)return res.status(401).json({ok:false,error:'Sign in first'});const fact=String(req.body?.fact||'').trim().slice(0,500);if(!fact)return res.status(400).json({ok:false,error:'Fact required'});const item={id:Math.random().toString(36).slice(2,10),text:fact};(MEMORY[s.uid]||(MEMORY[s.uid]=[])).push(item);res.json({ok:true,fact:item});});
app.delete(['/api/memory/:id','/memory/:id'],(req,res)=>{const s=sessionOnly(req);if(!s)return res.status(401).json({ok:false,error:'Sign in first'});const l=MEMORY[s.uid]||[];const i=l.findIndex(m=>m.id===req.params.id);if(i>=0)l.splice(i,1);res.json({ok:true});});
app.get(['/api/settings/persona','/settings/persona'],(req,res)=>{const s=sessionOnly(req);if(!s)return res.json({ok:true,persona:''});res.json({ok:true,persona:PERSONAS[s.uid]||''});});
app.post(['/api/settings/persona','/settings/persona'],(req,res)=>{const s=sessionOnly(req);if(!s)return res.status(401).json({ok:false,error:'Sign in first'});PERSONAS[s.uid]=String(req.body?.persona||'').slice(0,2000);res.json({ok:true});});
app.get(['/api/settings/user','/settings/user'],async(req,res)=>{const u=await currentUser(req);if(!u)return res.json({ok:true,settings:{}});res.json({ok:true,settings:u.settings||{}});});
app.post(['/api/settings/user','/settings/user'],async(req,res)=>{
  const u=await currentUser(req);if(!u)return res.status(401).json({ok:false,error:'Sign in first'});
  const patch=req.body?.settings||{};
  u.settings={...(u.settings||{}),...patch};
  await saveUserRecord(u);
  res.json({ok:true,settings:u.settings});
});

/* ---------- API keys ---------- */
app.get(['/api/keys','/keys'],(req,res)=>{const s=sessionOnly(req);if(!s)return res.json({ok:true,keys:[]});res.json({ok:true,keys:KEYS[s.uid]||[]});});
app.post(['/api/keys/generate','/keys/generate'],async(req,res)=>{
  const u=await currentUser(req);if(!u)return res.status(401).json({ok:false,error:'Sign in first'});
  const name=String(req.body?.name||'My key').slice(0,60);
  const raw='mx_'+crypto.randomBytes(24).toString('base64url');
  const k={id:'k_'+Math.random().toString(36).slice(2,10),name,key:raw,preview:raw.slice(0,8)+'…'+raw.slice(-4),revoked:false,created_at:now(),tier:u.tier};
  (KEYS[u.email]||(KEYS[u.email]=[])).push(k);
  res.json({ok:true,id:k.id,key:raw});
});

/* ---------- Support ---------- */
app.post(['/api/report','/report'],async(req,res)=>{
  const u=await currentUser(req);if(!u)return res.status(401).json({ok:false,error:'Sign in first'});
  const {subject,category,message}=req.body||{};
  const tid='t_'+Math.random().toString(36).slice(2,12);
  const tk={id:tid,email:u.email,subject:String(subject||'(no subject)').slice(0,120),
    category:String(category||'general').slice(0,40),status:'open',unread_user:0,unread_admin:1,
    created_at:now(),updated_at:now(),
    messages:[{from:'user',text:String(message||'').slice(0,4000),ts:now()}]};
  (TICKETS[u.email]||(TICKETS[u.email]=[])).unshift(tk);
  TICKET_BY_ID[tid]={email:u.email,ticket:tk};
  USER_LOG.unshift({email:u.email,event:'ticket_open:'+tid,ts:now(),ua:req.headers['user-agent']||''});
  logDiscord('support','🎫 New ticket','',[['User',u.email],['Subject',tk.subject],['ID',tid]]);
  res.json({ok:true,ticket_id:tid});
});
app.get(['/api/report/mine','/report/mine'],(req,res)=>{
  const s=sessionOnly(req);if(!s)return res.json({ok:true,reports:[]});
  res.json({ok:true,reports:(TICKETS[s.uid]||[]).map(t=>({...t,unread_admin:undefined}))});
});
app.get(['/api/report/:id','/report/:id'],(req,res)=>{
  const s=sessionOnly(req);if(!s)return res.status(401).json({ok:false,error:'Sign in first'});
  const rec=TICKET_BY_ID[req.params.id];
  if(!rec||rec.email!==s.uid)return res.status(404).json({ok:false,error:'Not found'});
  rec.ticket.unread_user=0;
  res.json({ok:true,ticket:rec.ticket});
});
app.post(['/api/report/:id/reply','/report/:id/reply'],(req,res)=>{
  const s=sessionOnly(req);if(!s)return res.status(401).json({ok:false,error:'Sign in first'});
  const rec=TICKET_BY_ID[req.params.id];
  if(!rec||rec.email!==s.uid)return res.status(404).json({ok:false,error:'Not found'});
  const text=String(req.body?.text||'').slice(0,4000);if(!text)return res.status(400).json({ok:false,error:'Text required'});
  rec.ticket.messages.push({from:'user',text,ts:now()});
  rec.ticket.status='open';
  rec.ticket.unread_admin=(rec.ticket.unread_admin||0)+1;
  rec.ticket.updated_at=now();
  logDiscord('support','💬 User reply','',[['User',s.uid],['ID',rec.ticket.id],['Msg',text.slice(0,300)]]);
  res.json({ok:true});
});

/* ---------- Admin ---------- */
function requireAdmin(req,res,next){const s=getSession(req);if(!s.is_admin)return res.status(403).json({ok:false,error:'Admin only'});next();}
app.get(['/api/admin/status','/admin/status'],(req,res)=>{const s=getSession(req);res.json({ok:true,is_admin:!!s.is_admin});});
app.post(['/api/admin/login','/admin/login'],async(req,res)=>{
  const pw=String(req.body?.password||'').trim();
  if(pw&&pw===ADMIN_PASSWORD){const s=getSession(req);setSession(res,{...s,is_admin:true});logDiscord('admin','🔐 Admin login','',[['Time',new Date().toISOString()]]);return res.json({ok:true});}
  res.status(401).json({ok:false,error:'Wrong password'});
});
app.post(['/api/admin/logout','/admin/logout'],(req,res)=>{const s=getSession(req);delete s.is_admin;setSession(res,s);res.json({ok:true});});

app.get(['/api/admin/users','/admin/users'],requireAdmin,async(req,res)=>{
  const idxRaw=await kvGet('mirox:user_index');
  const idx=Array.isArray(idxRaw)?idxRaw:Object.keys(USERS);
  const arr=[];
  for(const email of idx){const rec=await getUserRecord(email);if(rec)arr.push(rec);}
  const seen=new Set();
  const uniq=arr.filter(u=>{if(seen.has(u.email))return false;seen.add(u.email);return true;});
  uniq.sort((a,b)=>(b.created_at||0)-(a.created_at||0));
  res.json({ok:true,users:uniq});
});
app.post(['/api/admin/set-tier','/admin/set-tier'],requireAdmin,async(req,res)=>{
  const {email,tier}=req.body||{};
  const e=String(email||'').trim().toLowerCase();
  const t=String(tier||'free').trim().toLowerCase();
  if(!PLANS[t])return res.status(400).json({ok:false,error:'Invalid tier'});
  if(!e)return res.status(400).json({ok:false,error:'Email required'});
  let rec=await getUserRecord(e);
  if(!rec)rec=newUserRecord(e,'');
  rec.tier=t;
  if(t==='free')rec.tier_expires=0;
  else if(t==='pro')rec.tier_expires=now()+30*86400;
  else rec.tier_expires=now()+365*86400;
  await saveUserRecord(rec);
  const idxRaw=await kvGet('mirox:user_index');
  const arr=Array.isArray(idxRaw)?idxRaw:[];
  if(!arr.includes(e)){arr.push(e);await kvSet('mirox:user_index',arr);}
  USER_LOG.unshift({email:e,event:'tier_change:'+t,ts:now(),ua:'admin'});
  logDiscord('subscription','👑 Tier changed','',[['User',e],['New tier',t]]);
  res.json({ok:true,user:rec});
});
app.post(['/api/admin/delete-user','/admin/delete-user'],requireAdmin,async(req,res)=>{
  const e=String(req.body?.email||'').trim().toLowerCase();
  if(!e)return res.status(400).json({ok:false,error:'Email required'});
  delete USERS[e];delete MEMORY[e];delete PERSONAS[e];delete KEYS[e];
  const list=TICKETS[e]||[];for(const t of list)delete TICKET_BY_ID[t.id];delete TICKETS[e];
  await kvDel(`mirox:user:${e}`);
  const idxRaw=await kvGet('mirox:user_index');
  const arr=Array.isArray(idxRaw)?idxRaw.filter(x=>x!==e):[];
  await kvSet('mirox:user_index',arr);
  USER_LOG.unshift({email:e,event:'deleted',ts:now(),ua:'admin'});
  res.json({ok:true});
});
app.get(['/api/admin/stats','/admin/stats'],requireAdmin,async(req,res)=>{
  const idxRaw=await kvGet('mirox:user_index');
  const idx=Array.isArray(idxRaw)?idxRaw:Object.keys(USERS);
  let free=0,pro=0,ult=0;
  for(const email of idx){const rec=await getUserRecord(email);if(!rec)continue;
    if(rec.tier==='free')free++;else if(rec.tier==='pro')pro++;else if(rec.tier==='ultimate')ult++;}
  let openTickets=0;
  for(const email in TICKETS)for(const t of TICKETS[email])if(t.status==='open')openTickets++;
  res.json({ok:true,total:idx.length,free,pro,ultimate:ult,
    chats:CHAT_LOG.length,images:IMG_LOG.length,logs:USER_LOG.length,tickets:openTickets,kv:KV_ON});
});
app.get(['/api/admin/chats','/admin/chats'],requireAdmin,(req,res)=>{res.json({ok:true,chats:CHAT_LOG.slice(0,200)});});
app.get(['/api/admin/images','/admin/images'],requireAdmin,(req,res)=>{res.json({ok:true,images:IMG_LOG.slice(0,200)});});
app.get(['/api/admin/logs','/admin/logs'],requireAdmin,(req,res)=>{res.json({ok:true,logs:USER_LOG.slice(0,300)});});
app.post(['/api/admin/maintenance','/admin/maintenance'],requireAdmin,(req,res)=>{SETTINGS.maintenance=!!req.body?.enabled;res.json({ok:true,enabled:!!SETTINGS.maintenance});});
app.post(['/api/admin/broadcast','/admin/broadcast'],requireAdmin,(req,res)=>{SETTINGS.broadcast=String(req.body?.message||'').slice(0,500);res.json({ok:true});});
app.get(['/api/admin/broadcast','/admin/broadcast'],(req,res)=>{res.json({ok:true,message:SETTINGS.broadcast||''});});

/* Admin support */
app.get(['/api/admin/tickets','/admin/tickets'],requireAdmin,(req,res)=>{
  const all=[];for(const email in TICKETS)for(const t of TICKETS[email])all.push({...t,email});
  all.sort((a,b)=>(b.updated_at||0)-(a.updated_at||0));
  res.json({ok:true,tickets:all.slice(0,300)});
});
app.get(['/api/admin/tickets/:id','/admin/tickets/:id'],requireAdmin,(req,res)=>{
  const rec=TICKET_BY_ID[req.params.id];if(!rec)return res.status(404).json({ok:false,error:'Not found'});
  rec.ticket.unread_admin=0;res.json({ok:true,ticket:rec.ticket,email:rec.email});
});
app.post(['/api/admin/tickets/:id/reply','/admin/tickets/:id/reply'],requireAdmin,(req,res)=>{
  const rec=TICKET_BY_ID[req.params.id];if(!rec)return res.status(404).json({ok:false,error:'Not found'});
  const text=String(req.body?.text||'').slice(0,4000);if(!text)return res.status(400).json({ok:false,error:'Text required'});
  rec.ticket.messages.push({from:'admin',text,ts:now()});
  rec.ticket.status='replied';
  rec.ticket.unread_user=(rec.ticket.unread_user||0)+1;
  rec.ticket.updated_at=now();
  logDiscord('support','💬 Admin reply','',[['To',rec.email],['ID',rec.ticket.id]]);
  res.json({ok:true});
});
app.post(['/api/admin/tickets/:id/close','/admin/tickets/:id/close'],requireAdmin,(req,res)=>{
  const rec=TICKET_BY_ID[req.params.id];if(!rec)return res.status(404).json({ok:false,error:'Not found'});
  rec.ticket.status='closed';rec.ticket.updated_at=now();res.json({ok:true});
});

/* Knowledge base */
app.get(['/api/admin/kb','/admin/kb'],requireAdmin,(req,res)=>{res.json({ok:true,kb:KB.slice(-200)});});
app.post(['/api/admin/kb','/admin/kb'],requireAdmin,(req,res)=>{
  const q=String(req.body?.q||'').slice(0,300);
  const a=String(req.body?.a||'').slice(0,2000);
  if(!a)return res.status(400).json({ok:false,error:'Answer required'});
  KB.push({id:Math.random().toString(36).slice(2,10),q,a,ts:now()});
  res.json({ok:true});
});
app.delete(['/api/admin/kb/:id','/admin/kb/:id'],requireAdmin,(req,res)=>{
  const i=KB.findIndex(x=>x.id===req.params.id);
  if(i>=0)KB.splice(i,1);
  res.json({ok:true});
});

/* ---------- Image generation ---------- */
app.post(['/api/image/generate','/image/generate'],async(req,res)=>{
  const prompt=String(req.body?.prompt||'').trim().slice(0,1000);
  if(!prompt)return res.status(400).json({ok:false,error:'Prompt required'});
  const u=await currentUser(req);
  logDiscord('image','🎨 Image request','',[['User',u?u.email:'guest'],['Prompt',prompt.slice(0,400)]]);
  if(OPENAI_API_KEY){
    try{
      const r=await fetch(OPENAI_IMAGES,{method:'POST',
        headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
        body:JSON.stringify({model:'dall-e-3',prompt,n:1,size:'1024x1024',quality:'standard',response_format:'url'})});
      if(r.ok){
        const j=await r.json();const it=(j.data||[])[0];
        const url=it?.url||(it?.b64_json?('data:image/png;base64,'+it.b64_json):null);
        if(url){
          IMG_LOG.unshift({email:u?u.email:'guest',prompt:prompt.slice(0,500),url,model:'dall-e-3',ts:now()});
          if(IMG_LOG.length>300)IMG_LOG.length=300;
          return res.json({ok:true,image:url,url,model:'dall-e-3',provider:'OpenAI'});
        }
      }
    }catch{}
  }
  if(HF_API_KEY){
    const hfModels=['black-forest-labs/FLUX.1-schnell','Qwen/Qwen-Image'];
    for(const model of hfModels){
      try{
        const r=await fetch('https://router.huggingface.co/v1/images/generations',{method:'POST',
          headers:{'Authorization':`Bearer ${HF_API_KEY}`,'Content-Type':'application/json'},
          body:JSON.stringify({model,prompt,n:1,size:'1024x1024',response_format:'url'})});
        if(!r.ok)continue;
        const j=await r.json();const it=(j.data||[])[0];
        const url=it?.url||(it?.b64_json?('data:image/png;base64,'+it.b64_json):null);
        if(!url)continue;
        IMG_LOG.unshift({email:u?u.email:'guest',prompt:prompt.slice(0,500),url,model,ts:now()});
        if(IMG_LOG.length>300)IMG_LOG.length=300;
        return res.json({ok:true,image:url,url,model,provider:'Hugging Face'});
      }catch{}
    }
  }
  res.status(500).json({ok:false,error:'Image generation failed. Set OPENAI_API_KEY or HF_API_KEY.'});
});

app.use((req,res)=>{
  if(req.path.startsWith('/api/'))return res.status(404).json({ok:false,error:'Not found'});
  res.status(404).send('Not found');
});

console.log(KV_ON?'[MiroxAI] Persistent storage: Upstash Redis':'[MiroxAI] Persistent storage: OFF (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)');
module.exports=app;

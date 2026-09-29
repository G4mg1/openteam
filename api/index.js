const express = require('express');
const crypto  = require('crypto');

const app = express();
app.use(express.json({ limit: '12mb' }));

const HF_API_KEY      = (process.env.HF_API_KEY || '').trim();
const DISCORD_WEBHOOK = (process.env.DISCORD_WEBHOOK || '').trim();
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD || '2010';
const SECRET          = process.env.SECRET_KEY || 'mirox-dev-fallback-change-me';
const HF_CHAT   = 'https://router.huggingface.co/v1/chat/completions';
const HF_IMAGES = 'https://router.huggingface.co/v1/images/generations';

function signSession(d){const p=Buffer.from(JSON.stringify(d)).toString('base64url');return p+'.'+crypto.createHmac('sha256',SECRET).update(p).digest('base64url');}
function verifySession(t){if(!t)return{};const a=t.split('.');if(a.length!==2)return{};const e=crypto.createHmac('sha256',SECRET).update(a[0]).digest('base64url');if(e!==a[1])return{};try{return JSON.parse(Buffer.from(a[0],'base64url').toString());}catch{return{};}}
function getSession(req){const a=req.headers.authorization||'';if(a.startsWith('Bearer ')){const s=verifySession(a.slice(7).trim());if(s&&s.uid)return s;}const m=(req.headers.cookie||'').match(/(?:^|;\s*)mirox_sess=([^;]+)/);if(!m)return{};return verifySession(decodeURIComponent(m[1]));}
function setSession(res,d){const t=signSession(d);const sc=process.env.VERCEL==='1'?'; Secure':'';res.setHeader('Set-Cookie',`mirox_sess=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*60*60}${sc}`);return t;}
function clearSession(res){res.setHeader('Set-Cookie','mirox_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');}

const USERS=Object.create(null),MEMORY=Object.create(null),PERSONAS=Object.create(null),KEYS=Object.create(null),TICKETS=Object.create(null),SETTINGS=Object.create(null);
const CHAT_LOG=[],IMG_LOG=[],USER_LOG=[],KB=[];

const COLORS={signin:0x16a34a,chat:0x3b82f6,image:0x8b5cf6,subscription:0xd97706,error:0xef4444,admin:0xdc2626};
async function logDiscord(kind,title,description='',fields=[]){
  if(!DISCORD_WEBHOOK)return;
  const embed={title,description:(description||'').slice(0,2000),color:COLORS[kind]||0x6366f1,footer:{text:'MiroxAI'},timestamp:new Date().toISOString()};
  if(fields?.length)embed.fields=fields.map(([k,v])=>({name:String(k).slice(0,200),value:String(v).slice(0,1000),inline:false}));
  try{await fetch(DISCORD_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'MiroxAI',embeds:[embed]})});}catch(e){}
}

const MODELS={
  'mirox-luna-1.2':{label:'Luna',tagline:'Warm & friendly',tier:'free',default:true,
    chain:['Qwen/Qwen2.5-7B-Instruct','meta-llama/Llama-3.1-8B-Instruct','mistralai/Mistral-7B-Instruct-v0.3'],
    tokens:700, prompt:'You are Luna, a warm and friendly assistant created by the OpenSurr team. Speak naturally, with a personal, encouraging tone. Be brief but caring. Never mention any other company or AI model. If asked who made you, answer: OpenSurr. If asked your model name, answer: Luna.'},
  'mirox-gen-1':{label:'Gen',tagline:'Quick & concise',tier:'free',fallback:true,
    chain:['Qwen/Qwen2.5-7B-Instruct','mistralai/Mistral-7B-Instruct-v0.3'],
    tokens:512, prompt:'You are Gen, an ultra-concise assistant from the OpenSurr team. Give the shortest clear answer possible. Skip filler. Never mention any other company or AI model. If asked who made you, answer: OpenSurr.'},
  'mirox-pro-5':{label:'Pro',tagline:'Balanced & thorough',tier:'pro',
    chain:['Qwen/Qwen2.5-7B-Instruct','meta-llama/Llama-3.1-8B-Instruct','mistralai/Mistral-7B-Instruct-v0.3'],
    tokens:900, prompt:'You are Pro, a professional assistant from the OpenSurr team. Give balanced, well-structured answers with clear reasoning. Use headings or lists when helpful. Never mention any other company or AI model. If asked who made you, answer: OpenSurr. If asked your model name, answer: Pro.'},
  'mirox-ultra-10':{label:'Ultra',tagline:'Deep reasoning',tier:'pro',
    chain:['Qwen/Qwen2.5-14B-Instruct','Qwen/Qwen2.5-7B-Instruct','meta-llama/Llama-3.1-8B-Instruct'],
    tokens:1200, prompt:'You are Ultra, an analytical assistant from the OpenSurr team. Think step by step. Break complex problems into clear logical parts. Show your reasoning when it helps the user. Never mention any other company or AI model. If asked who made you, answer: OpenSurr. If asked your model name, answer: Ultra.'},
  'mirox-eclipse-2.0':{label:'Eclipse',tagline:'Advanced & creative',tier:'ultimate',
    chain:['Qwen/Qwen2.5-14B-Instruct','Qwen/Qwen2.5-7B-Instruct','meta-llama/Llama-3.1-8B-Instruct'],
    tokens:1400, prompt:'You are Eclipse, the most advanced assistant from the OpenSurr team. Blend deep reasoning with creativity. Explore ideas from multiple angles. Offer novel insights, but stay accurate. Never mention any other company or AI model. If asked who made you, answer: OpenSurr. If asked your model name, answer: Eclipse.'},
};
const TIER_RANK={free:0,pro:1,ultimate:2};
const PLANS={
  free:{label:'Free',daily_limit:50,ultimate_trial_limit:10,price_robux:0,price_afg:0,price_hesab:0,gamepass_id:''},
  pro:{label:'Pro',daily_limit:500,ultimate_trial_limit:0,price_robux:250,price_afg:120,price_hesab:150,gamepass_id:''},
  ultimate:{label:'Ultimate',daily_limit:5000,ultimate_trial_limit:0,price_robux:1200,price_afg:450,price_hesab:550,gamepass_id:''},
};
const ANNOUNCEMENT={enabled:true,version:'v9-luna',title:'Meet Luna',image:'Luna.png',body:'Luna is now the default — warm, smart, and free.',highlights:['Luna — new default, free','Pro & Ultra on Pro plan','Eclipse on Ultimate','Guest mode available']};
const now=()=>Math.floor(Date.now()/1000);

function currentUser(req){
  const s=getSession(req); if(!s.uid)return null;
  if(!USERS[s.uid])USERS[s.uid]={email:s.uid,name:s.name||'',tier:s.tier||'free',created_at:now(),gmail:'',settings:{}};
  return {...USERS[s.uid]};
}
const memBox=e=>(MEMORY[e]||=[]);
const keysBox=e=>(KEYS[e]||=[]);
const ticketsBox=e=>(TICKETS[e]||=[]);

async function hfStream(chain,messages,maxTokens){
  if(!HF_API_KEY)throw new Error('HF_API_KEY not configured');
  const errors=[];
  for(const modelId of chain){
    try{
      const r=await fetch(HF_CHAT,{method:'POST',
        headers:{'Authorization':`Bearer ${HF_API_KEY}`,'Content-Type':'application/json','Accept':'text/event-stream'},
        body:JSON.stringify({model:modelId,messages,max_tokens:maxTokens,temperature:0.7,top_p:0.95,stream:true})});
      if(!r.ok){let b='';try{b=(await r.text()).slice(0,200);}catch{}errors.push(`${modelId}: HTTP ${r.status}`);continue;}
      return {stream:r.body,model:modelId};
    }catch(e){errors.push(`${modelId}: ${e.message.slice(0,80)}`);}
  }
  throw new Error(`All models failed → ${errors.slice(0,3).join(' | ')}`);
}

async function webSearch(q){
  try{
    const r=await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`);
    if(!r.ok)return null;
    const j=await r.json();
    const parts=[];
    if(j.AbstractText)parts.push(j.AbstractText);
    if(j.Answer)parts.push('Answer: '+j.Answer);
    if(j.RelatedTopics?.length){
      for(const t of j.RelatedTopics.slice(0,5)){
        if(t.Text)parts.push('• '+t.Text);
        else if(t.Topics)for(const s of t.Topics.slice(0,3))if(s.Text)parts.push('• '+s.Text);
      }
    }
    return parts.join('\n').slice(0,2000)||null;
  }catch{return null;}
}

function buildMessages(systemPrompt,history,userText,persona='',mem=[],searchCtx='',files=[]){
  let sys=systemPrompt;
  if(KB.length){
    const recent=KB.slice(-40).map(k=>`- ${k.q?k.q+': ':''}${k.a}`).join('\n');
    sys+='\n\nKNOWLEDGE BASE (always use when relevant):\n'+recent;
  }
  const msgs=[{role:'system',content:sys}];
  if(persona)msgs.push({role:'system',content:`User preference: ${String(persona).slice(0,1500)}`});
  if(mem.length)msgs.push({role:'system',content:'Remember: '+mem.slice(-8).map(m=>m.text).join(' | ')});
  if(searchCtx)msgs.push({role:'system',content:'WEB SEARCH RESULTS:\n'+searchCtx});
  for(const h of (history||[]).slice(-12)){
    const role=h.role,txt=String(h.content||'').trim().slice(0,3000);
    if((role==='user'||role==='assistant')&&txt)msgs.push({role,content:txt});
  }
  let finalText=userText;
  if(files?.length){
    const fileText=files.filter(f=>f.type!=='image').map(f=>`[File: ${f.name}]\n${String(f.content||'').slice(0,6000)}`).join('\n\n');
    const imgNote=files.filter(f=>f.type==='image').length;
    if(fileText)finalText=fileText+'\n\nUser request:\n'+userText;
    if(imgNote>0)finalText=(finalText||'')+`\n\n[User attached ${imgNote} image(s)]`;
  }
  msgs.push({role:'user',content:finalText.slice(0,9000)});
  return msgs;
}

app.get(['/api/config','/config','/config.json'],(req,res)=>{
  const u=currentUser(req);
  res.json({
    app:{name:'MiroxAI',made_by:'OpenSurr',version:'v9'},
    models:Object.entries(MODELS).map(([id,m])=>({id,label:m.label,tagline:m.tagline,tier:m.tier,default:!!m.default,fallback:!!m.fallback})),
    plans:PLANS,
    announcement:ANNOUNCEMENT,
    user_tier:u?u.tier:'free',
    guest:!u,
    hf_ready:!!HF_API_KEY,
    maintenance:!!SETTINGS.maintenance,
  });
});

app.get(['/api/health','/health','/api/ping','/ping'],(req,res)=>{
  res.json({ok:true,app:'MiroxAI',hf:!!HF_API_KEY,t:now(),maintenance:!!SETTINGS.maintenance});
});

app.post(['/api/auth/simple-login','/auth/simple-login'],async(req,res)=>{
  const {name,email}=req.body||{};
  const n=String(name||'').trim().slice(0,60);
  const e=String(email||'').trim().toLowerCase().slice(0,120);
  if(!n||!e||!e.includes('@')||!e.split('@')[1].includes('.'))return res.status(400).json({ok:false,error:'Valid name and email required'});
  const existing=!!USERS[e];
  if(!existing)USERS[e]={email:e,name:n,tier:'free',created_at:now(),gmail:'',settings:{}};
  else USERS[e].name=n;
  const token=setSession(res,{uid:e,name:n,tier:USERS[e].tier});
  USER_LOG.unshift({email:e,event:existing?'signin':'signup',ts:now(),ua:req.headers['user-agent']||''});
  logDiscord('signin',existing?'👤 Sign in':'👤 New user','',[['Name',n],['Email',e],['Tier',USERS[e].tier]]);
  res.json({ok:true,token,user:{id:e,email:e,name:n,tier:USERS[e].tier,tier_label:PLANS[USERS[e].tier].label}});
});

app.post(['/api/logout','/logout'],(req,res)=>{
  const s=getSession(req);
  if(s.uid)USER_LOG.unshift({email:s.uid,event:'logout',ts:now(),ua:req.headers['user-agent']||''});
  clearSession(res);res.json({ok:true});
});

app.get(['/api/me','/me'],(req,res)=>{
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
  const u=currentUser(req);
  if(!u)return res.json({user:null});
  res.json({user:{id:u.email,email:u.email,name:u.name,tier:u.tier,tier_label:PLANS[u.tier].label}});
});

app.get(['/api/subscription/me','/subscription/me'],(req,res)=>{
  const u=currentUser(req);
  if(!u)return res.json({ok:false,error:'Sign in first'});
  const p=PLANS[u.tier],ks=keysBox(u.email);
  res.json({ok:true,tier:u.tier,tier_label:p.label,daily_limit:p.daily_limit,daily_remaining:p.daily_limit,
    trial_limit:p.ultimate_trial_limit,trial_remaining:p.ultimate_trial_limit,
    images_allowed:true,email_connected:!!u.gmail,keys_remaining:Math.max(0,3-ks.length),
    keys_per_period:3,refill_days:30,daily_reset_seconds:86400,lite_mode:false});
});

app.get(['/api/subscription/plans','/subscription/plans'],(req,res)=>{
  const perks={
    free:['Luna & Gen — free models','10 Eclipse chats/day','Image generation','Memory & persona'],
    pro:['Pro & Ultra models','500 msgs/day','Image generation','Priority speed'],
    ultimate:['Eclipse — best model','5000 msgs/day','Everything in Pro','Ultimate badge'],
  };
  const out=Object.entries(PLANS).map(([id,p])=>({id,label:p.label,
    tagline:{free:'Free forever',pro:'Most popular',ultimate:'For power users'}[id],
    daily_limit:p.daily_limit,price_robux:p.price_robux,price_afg:p.price_afg,
    price_hesab:p.price_hesab,gamepass_id:p.gamepass_id,perks:perks[id]}));
  res.json({ok:true,plans:out,admin_email:'admin@example.com',admin_phone:''});
});

app.post(['/api/chat/stream','/chat/stream'],async(req,res)=>{
  if(SETTINGS.maintenance)return res.status(503).json({ok:false,error:'Server is in maintenance mode.'});
  const {message,history,model:modelKey,web_search,files}=req.body||{};
  const msg=String(message||'').trim();
  if(!msg&&!files?.length)return res.status(400).json({ok:false,error:'Empty message'});

  const u=currentUser(req);
  const tier=u?u.tier:'free';
  let cfg=MODELS[modelKey]||MODELS['mirox-luna-1.2'];
  if(TIER_RANK[cfg.tier]>TIER_RANK[tier]){
    if(!(tier==='free'&&cfg.tier==='ultimate'))cfg=MODELS['mirox-luna-1.2'];
  }
  const mem=u?memBox(u.email):[];
  const persona=u?(PERSONAS[u.email]||''):'';

  let searchCtx='';
  if(web_search){const r=await webSearch(msg);if(r)searchCtx=r;}

  const msgs=buildMessages(cfg.prompt,history,msg,persona,mem,searchCtx,files||[]);
  CHAT_LOG.unshift({email:u?u.email:'guest',model:cfg.label,message:msg.slice(0,1000),reply:'',ts:now()});
  if(CHAT_LOG.length>500)CHAT_LOG.length=500;
  logDiscord('chat',u?'💬 Chat':'💬 Guest','',[['User',u?u.email:'guest'],['Model',cfg.label],['Message',msg.slice(0,400)]]);

  res.setHeader('Content-Type','text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control','no-cache, no-transform');
  res.setHeader('X-Accel-Buffering','no');
  res.setHeader('Connection','keep-alive');
  if(res.flushHeaders)res.flushHeaders();

  const t0=Date.now();
  let usedModel=cfg.chain[0],fullReply='';
  try{
    const {stream,model}=await hfStream(cfg.chain,msgs,cfg.tokens);
    usedModel=model;
    const reader=stream.getReader(),dec=new TextDecoder();
    let buf='';
    while(true){
      const {value,done}=await reader.read(); if(done)break;
      buf+=dec.decode(value,{stream:true});
      let idx;
      while((idx=buf.indexOf('\n'))!==-1){
        const line=buf.slice(0,idx).trim(); buf=buf.slice(idx+1);
        if(!line.startsWith('data:'))continue;
        const pl=line.slice(5).trim(); if(!pl||pl==='[DONE]')continue;
        try{const o=JSON.parse(pl);const d=o.choices?.[0]?.delta?.content;if(d){fullReply+=d;res.write(`data: ${JSON.stringify({d})}\n\n`);}}catch{}
      }
    }
  }catch(e){
    res.write(`data: ${JSON.stringify({error:String(e.message).slice(0,240)})}\n\n`);
    logDiscord('error','❌ Chat failed',String(e.message).slice(0,400),[]);
  }
  if(CHAT_LOG[0])CHAT_LOG[0].reply=fullReply.slice(0,2000);
  res.write(`data: ${JSON.stringify({done:true,model:cfg.label,used:usedModel,ms:Date.now()-t0})}\n\n`);
  res.end();
});

app.post(['/api/chat','/chat'],async(req,res)=>{
  if(SETTINGS.maintenance)return res.status(503).json({ok:false,error:'Maintenance mode'});
  const {message,history,model:modelKey}=req.body||{};
  const msg=String(message||'').trim();
  if(!msg)return res.status(400).json({ok:false,error:'Empty message'});
  const u=currentUser(req);
  const tier=u?u.tier:'free';
  let cfg=MODELS[modelKey]||MODELS['mirox-luna-1.2'];
  if(TIER_RANK[cfg.tier]>TIER_RANK[tier])cfg=MODELS['mirox-luna-1.2'];
  const mem=u?memBox(u.email):[];
  const persona=u?(PERSONAS[u.email]||''):'';
  const msgs=buildMessages(cfg.prompt,history,msg,persona,mem);
  try{
    const {stream,model}=await hfStream(cfg.chain,msgs,cfg.tokens);
    const reader=stream.getReader(),dec=new TextDecoder();
    let buf='',out='';
    while(true){
      const {value,done}=await reader.read(); if(done)break;
      buf+=dec.decode(value,{stream:true});
      let idx;
      while((idx=buf.indexOf('\n'))!==-1){
        const line=buf.slice(0,idx).trim(); buf=buf.slice(idx+1);
        if(!line.startsWith('data:'))continue;
        const pl=line.slice(5).trim(); if(!pl||pl==='[DONE]')continue;
        try{const o=JSON.parse(pl);const d=o.choices?.[0]?.delta?.content;if(d)out+=d;}catch{}
      }
    }
    res.json({ok:true,reply:out,model:cfg.label,used:model});
  }catch(e){res.status(502).json({ok:false,error:String(e.message).slice(0,200)});}
});

app.get(['/api/memory','/memory'],(req,res)=>{const u=currentUser(req);if(!u)return res.json({ok:true,facts:[]});res.json({ok:true,facts:memBox(u.email)});});
app.post(['/api/memory','/memory'],(req,res)=>{const u=currentUser(req);if(!u)return res.status(401).json({ok:false,error:'Sign in first'});const fact=String(req.body?.fact||'').trim().slice(0,500);if(!fact)return res.status(400).json({ok:false,error:'Fact required'});const item={id:Math.random().toString(36).slice(2,10),text:fact};memBox(u.email).push(item);res.json({ok:true,fact:item});});
app.delete(['/api/memory/:id','/memory/:id'],(req,res)=>{const u=currentUser(req);if(!u)return res.status(401).json({ok:false,error:'Sign in first'});const l=memBox(u.email);const i=l.findIndex(m=>m.id===req.params.id);if(i>=0)l.splice(i,1);res.json({ok:true});});
app.get(['/api/settings/persona','/settings/persona'],(req,res)=>{const u=currentUser(req);if(!u)return res.json({ok:true,persona:''});res.json({ok:true,persona:PERSONAS[u.email]||''});});
app.post(['/api/settings/persona','/settings/persona'],(req,res)=>{const u=currentUser(req);if(!u)return res.status(401).json({ok:false,error:'Sign in first'});PERSONAS[u.email]=String(req.body?.persona||'').slice(0,2000);res.json({ok:true});});

app.get(['/api/settings/user','/settings/user'],(req,res)=>{const u=currentUser(req);if(!u)return res.json({ok:true,settings:{}});res.json({ok:true,settings:u.settings||{}});});
app.post(['/api/settings/user','/settings/user'],(req,res)=>{
  const u=currentUser(req);if(!u)return res.status(401).json({ok:false,error:'Sign in first'});
  const patch=req.body?.settings||{};
  USERS[u.email].settings={...(USERS[u.email].settings||{}),...patch};
  res.json({ok:true,settings:USERS[u.email].settings});
});

app.post(['/api/report','/report'],(req,res)=>{
  const u=currentUser(req);if(!u)return res.status(401).json({ok:false,error:'Sign in first'});
  const {subject,category,message}=req.body||{};
  const tid='t_'+Math.random().toString(36).slice(2,12);
  ticketsBox(u.email).unshift({id:tid,subject:String(subject||'(no subject)').slice(0,120),category:String(category||'general').slice(0,40),status:'open',unread_user:0,created_at:now(),messages:[{from:'user',text:String(message||'').slice(0,4000),ts:now()}]});
  res.json({ok:true,ticket_id:tid});
});
app.get(['/api/report/mine','/report/mine'],(req,res)=>{const u=currentUser(req);if(!u)return res.json({ok:true,reports:[]});res.json({ok:true,reports:ticketsBox(u.email)});});

app.get(['/api/keys','/keys'],(req,res)=>{const u=currentUser(req);if(!u)return res.json({ok:true,keys:[]});res.json({ok:true,keys:keysBox(u.email)});});
app.post(['/api/keys/generate','/keys/generate'],(req,res)=>{
  const u=currentUser(req);if(!u)return res.status(401).json({ok:false,error:'Sign in first'});
  const name=String(req.body?.name||'My key').slice(0,60);
  const raw='mx_'+crypto.randomBytes(24).toString('base64url');
  const k={id:'k_'+Math.random().toString(36).slice(2,10),name,key:raw,preview:raw.slice(0,8)+'…'+raw.slice(-4),revoked:false,created_at:now(),tier:u.tier};
  keysBox(u.email).push(k);res.json({ok:true,id:k.id,key:raw});
});

app.post(['/api/image/generate','/image/generate'],async(req,res)=>{
  const prompt=String(req.body?.prompt||'').trim().slice(0,1000);
  if(!prompt)return res.status(400).json({ok:false,error:'Prompt required'});
  if(!HF_API_KEY)return res.status(500).json({ok:false,error:'HF_API_KEY missing'});
  const u=currentUser(req);
  logDiscord('image','🎨 Image request','',[['User',u?u.email:'guest'],['Prompt',prompt.slice(0,400)]]);
  const imageModels=['black-forest-labs/FLUX.1-schnell','stabilityai/stable-diffusion-xl-base-1.0'];
  let lastErr='';
  for(const model of imageModels){
    try{
      const r=await fetch(HF_IMAGES,{method:'POST',
        headers:{'Authorization':`Bearer ${HF_API_KEY}`,'Content-Type':'application/json'},
        body:JSON.stringify({model,prompt,n:1,size:'1024x1024',response_format:'url'})});
      if(!r.ok){lastErr=`${model}: HTTP ${r.status}`;continue;}
      const j=await r.json();
      const it=(j.data||[{}])[0];
      const url=it.url||(it.b64_json?('data:image/png;base64,'+it.b64_json):null);
      if(!url){lastErr=`${model}: no url`;continue;}
      IMG_LOG.unshift({email:u?u.email:'guest',prompt:prompt.slice(0,500),url,model,ts:now()});
      if(IMG_LOG.length>300)IMG_LOG.length=300;
      return res.json({ok:true,image:url,url,model,provider:'Hugging Face'});
    }catch(e){lastErr=`${model}: ${e.message.slice(0,100)}`;}
  }
  res.status(502).json({ok:false,error:lastErr.slice(0,200)});
});

function requireAdmin(req,res,next){const s=getSession(req);if(!s.is_admin)return res.status(403).json({ok:false,error:'Admin only'});next();}

app.get(['/api/admin/status','/admin/status'],(req,res)=>{const s=getSession(req);res.json({ok:true,is_admin:!!s.is_admin});});
app.post(['/api/admin/login','/admin/login'],async(req,res)=>{
  const pw=String(req.body?.password||'').trim();
  if(pw&&pw===ADMIN_PASSWORD){const s=getSession(req);setSession(res,{...s,is_admin:true});logDiscord('admin','🔐 Admin login','',[['Time',new Date().toISOString()]]);return res.json({ok:true});}
  res.status(401).json({ok:false,error:'Wrong password'});
});
app.post(['/api/admin/logout','/admin/logout'],(req,res)=>{const s=getSession(req);delete s.is_admin;setSession(res,s);res.json({ok:true});});

app.get(['/api/admin/users','/admin/users'],requireAdmin,(req,res)=>{
  const arr=Object.values(USERS).sort((a,b)=>(b.created_at||0)-(a.created_at||0));
  res.json({ok:true,users:arr});
});
app.post(['/api/admin/set-tier','/admin/set-tier'],requireAdmin,(req,res)=>{
  const {email,tier}=req.body||{};
  const e=String(email||'').trim().toLowerCase();
  const t=String(tier||'free').trim().toLowerCase();
  if(!PLANS[t])return res.status(400).json({ok:false,error:'Invalid tier'});
  if(!e)return res.status(400).json({ok:false,error:'Email required'});
  if(!USERS[e])USERS[e]={email:e,name:'',tier:t,created_at:now(),gmail:'',settings:{}};
  else USERS[e].tier=t;
  USER_LOG.unshift({email:e,event:'tier_change:'+t,ts:now(),ua:'admin'});
  logDiscord('subscription','👑 Tier changed','',[['User',e],['New tier',t]]);
  res.json({ok:true,user:USERS[e]});
});
app.post(['/api/admin/delete-user','/admin/delete-user'],requireAdmin,(req,res)=>{
  const e=String(req.body?.email||'').trim().toLowerCase();
  if(!e)return res.status(400).json({ok:false,error:'Email required'});
  delete USERS[e];delete MEMORY[e];delete PERSONAS[e];delete KEYS[e];delete TICKETS[e];
  USER_LOG.unshift({email:e,event:'deleted',ts:now(),ua:'admin'});
  res.json({ok:true});
});
app.get(['/api/admin/stats','/admin/stats'],requireAdmin,(req,res)=>{
  const arr=Object.values(USERS);
  res.json({ok:true,total:arr.length,
    free:arr.filter(x=>x.tier==='free').length,
    pro:arr.filter(x=>x.tier==='pro').length,
    ultimate:arr.filter(x=>x.tier==='ultimate').length,
    chats:CHAT_LOG.length,images:IMG_LOG.length,logs:USER_LOG.length});
});
app.get(['/api/admin/chats','/admin/chats'],requireAdmin,(req,res)=>{res.json({ok:true,chats:CHAT_LOG.slice(0,200)});});
app.get(['/api/admin/images','/admin/images'],requireAdmin,(req,res)=>{res.json({ok:true,images:IMG_LOG.slice(0,200)});});
app.get(['/api/admin/logs','/admin/logs'],requireAdmin,(req,res)=>{res.json({ok:true,logs:USER_LOG.slice(0,300)});});
app.post(['/api/admin/maintenance','/admin/maintenance'],requireAdmin,(req,res)=>{
  SETTINGS.maintenance=!!req.body?.enabled;
  res.json({ok:true,enabled:!!SETTINGS.maintenance});
});
app.post(['/api/admin/broadcast','/admin/broadcast'],requireAdmin,(req,res)=>{
  SETTINGS.broadcast=String(req.body?.message||'').slice(0,500);
  logDiscord('admin','📢 Broadcast','',[['Message',SETTINGS.broadcast]]);
  res.json({ok:true});
});
app.get(['/api/admin/broadcast','/admin/broadcast'],(req,res)=>{res.json({ok:true,message:SETTINGS.broadcast||''});});
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

app.use((req,res)=>{
  if(req.path.startsWith('/api/'))return res.status(404).json({ok:false,error:'Not found'});
  res.status(404).send('Not found');
});

module.exports = app;

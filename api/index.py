import os, json, time, secrets, hmac, threading, uuid
from datetime import timedelta
from functools import wraps
from flask import Flask, request, jsonify, session, Response, stream_with_context
import requests

# ---------- CONFIG ----------
HF_API_KEY = os.environ.get("HF_API_KEY", "").strip()
HF_CHAT    = "https://router.huggingface.co/v1/chat/completions"
HF_IMAGES  = "https://router.huggingface.co/v1/images/generations"
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "2010")

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=True,
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)

# ---------- IN-MEMORY STORES ----------
_LOCK = threading.Lock()
USERS, CHATS, MEMORY, PERSONAS, KEYS, TICKETS = {}, {}, {}, {}, {}, {}

# ---------- MODELS ----------
MODELS = {
    "mirox-luna-1.2":    {"label":"Luna","tagline":"Smart and fast","tier":"free",
                          "hf":"meta-llama/Llama-3.2-3B-Instruct","tokens":700,
                          "default":True},
    "mirox-gen-1":       {"label":"Gen","tagline":"Quick and light","tier":"free",
                          "hf":"meta-llama/Llama-3.2-1B-Instruct","tokens":512,
                          "fallback":True},
    "mirox-pro-5":       {"label":"Pro","tagline":"Balanced intelligence","tier":"pro",
                          "hf":"Qwen/Qwen2.5-7B-Instruct","tokens":900},
    "mirox-ultra-10":    {"label":"Ultra","tagline":"Maximum power","tier":"pro",
                          "hf":"meta-llama/Llama-3.1-8B-Instruct","tokens":1200},
    "mirox-eclipse-2.0": {"label":"Eclipse","tagline":"Advanced reasoning","tier":"ultimate",
                          "hf":"Qwen/Qwen2.5-14B-Instruct","tokens":1400},
}
TIER_RANK = {"free":0, "pro":1, "ultimate":2}
PLANS = {
    "free":     {"label":"Free","daily_limit":50,"ultimate_trial_limit":10,
                 "fallback_model":"mirox-gen-1","trial_model":"mirox-eclipse-2.0",
                 "price_robux":0,"price_afg":0,"price_hesab":0,"gamepass_id":""},
    "pro":      {"label":"Pro","daily_limit":500,"ultimate_trial_limit":0,
                 "fallback_model":"mirox-pro-5","trial_model":"",
                 "price_robux":250,"price_afg":120,"price_hesab":150,"gamepass_id":""},
    "ultimate": {"label":"Ultimate","daily_limit":5000,"ultimate_trial_limit":0,
                 "fallback_model":"mirox-ultra-10","trial_model":"",
                 "price_robux":1200,"price_afg":450,"price_hesab":550,"gamepass_id":""},
}
SYSTEM_PROMPT = (
    "You are Mirox, an AI assistant created by the OpenSurr team. Your name is Mirox. "
    "Never mention any other company or model. If asked who made you, answer: OpenSurr. "
    "Be warm, clear, and concise. Remember the earlier conversation."
)
ANNOUNCEMENT = {
    "enabled": True, "version": "v43-luna", "title": "Meet Luna",
    "image": "Luna.png",
    "body": "Luna is now the default — smart, fast, and free.",
    "highlights": ["Luna — new default, free", "Pro & Ultra unlocked on Pro",
                   "Eclipse exclusive to Ultimate", "Image generation ready"],
}

# ---------- HELPERS ----------
def now(): return int(time.time())

def current_user():
    uid = session.get("uid")
    if not uid: return None
    with _LOCK:
        rec = USERS.get(uid)
        if not rec:
            rec = {"email":uid,"name":session.get("name",""),
                   "tier":session.get("tier","free"),"created_at":now(),"gmail":""}
            USERS[uid] = rec
        return dict(rec)

def require_user(fn):
    @wraps(fn)
    def w(*a, **k):
        if not session.get("uid"): return jsonify({"ok":False,"error":"Sign in first"}), 401
        return fn(*a, **k)
    return w

def require_admin(fn):
    @wraps(fn)
    def w(*a, **k):
        if not session.get("is_admin"): return jsonify({"ok":False,"error":"Admin only"}), 403
        return fn(*a, **k)
    return w

def bucket(name, email):
    with _LOCK:
        return name.setdefault(email, {} if name in (CHATS,) else [])

# ---------- CONFIG / HEALTH ----------
@app.route("/config.json")
@app.route("/api/config")
def config():
    u = current_user()
    return jsonify({
        "app":{"name":"MiroxAI","made_by":"OpenSurr","version":"v43"},
        "models":[{"id":k,"label":v["label"],"tagline":v["tagline"],
                   "tier":v["tier"],"default":v.get("default",False),
                   "fallback":v.get("fallback",False)} for k,v in MODELS.items()],
        "plans":PLANS,
        "payments":{"hesabpay":{"enabled":False},"robux":{"enabled":True},"afg_cash":{"enabled":True}},
        "email":{"enabled":True,"free_daily_limit":5,"paid_daily_limit":100,
                 "signature":"made by mirox ai","from_name":"MiroxAI"},
        "announcement":ANNOUNCEMENT,
        "image_models":["black-forest-labs/FLUX.1-schnell"],
        "video_models":[],
        "user_tier":u["tier"] if u else "free",
        "hf_ready":bool(HF_API_KEY),
    })

@app.route("/api/health")
@app.route("/api/ping")
def health(): return jsonify({"ok":True,"app":"MiroxAI","hf":bool(HF_API_KEY),"t":now()})

# ---------- AUTH ----------
@app.route("/api/auth/simple-login", methods=["POST"])
def login():
    d = request.get_json(silent=True) or {}
    name  = (d.get("name")  or "").strip()[:60]
    email = (d.get("email") or "").strip().lower()[:120]
    gmail = (d.get("gmail_address") or "").strip().lower()
    if not name or "@" not in email or "." not in email.split("@")[-1]:
        return jsonify({"ok":False,"error":"Valid name and email required"}), 400
    with _LOCK:
        rec = USERS.get(email)
        if not rec:
            rec = {"email":email,"name":name,"tier":"free","created_at":now(),"gmail":gmail}
            USERS[email] = rec
        else:
            rec["name"] = name
            if gmail: rec["gmail"] = gmail
    session.permanent = True
    session.update(uid=email, email=email, name=name, tier=rec["tier"])
    return jsonify({"ok":True,"user":{
        "id":email,"email":email,"name":name,
        "tier":rec["tier"],"tier_label":PLANS[rec["tier"]]["label"]}})

@app.route("/api/logout", methods=["POST"])
def logout(): session.clear(); return jsonify({"ok":True})

@app.route("/api/me")
def me():
    u = current_user()
    if not u: return jsonify({"user":None})
    return jsonify({"user":{"id":u["email"],"email":u["email"],"name":u["name"],
                            "tier":u["tier"],"tier_label":PLANS[u["tier"]]["label"]}})

# ---------- SUBSCRIPTION ----------
@app.route("/api/subscription/me")
@require_user
def sub_me():
    u = current_user()
    p = PLANS[u["tier"]]
    ks = bucket(KEYS, u["email"])
    return jsonify({
        "ok":True,"tier":u["tier"],"tier_label":p["label"],
        "daily_limit":p["daily_limit"],"daily_remaining":p["daily_limit"],
        "trial_limit":p["ultimate_trial_limit"],
        "trial_remaining":p["ultimate_trial_limit"],
        "images_allowed":True,"video_allowed":False,
        "email_connected":bool(u.get("gmail")),
        "keys_remaining":max(0,3-len(ks)),"keys_per_period":3,"refill_days":30,
        "daily_reset_seconds":86400,"lite_mode":False,"fallback_active":False,
    })

@app.route("/api/subscription/plans")
def plans_list():
    out = []
    perks = {
        "free":["Luna & Gen — free models","10 Eclipse chats/day","Image generation","Memory & persona","Support tickets"],
        "pro":["Pro & Ultra models","500 msgs/day","Image generation","Priority speed","API keys"],
        "ultimate":["Eclipse — best model","5000 msgs/day","Everything in Pro","Ultimate badge"],
    }
    for pid, p in PLANS.items():
        out.append({"id":pid,"label":p["label"],
                    "tagline":{"free":"Free forever","pro":"Most popular","ultimate":"For power users"}[pid],
                    "daily_limit":p["daily_limit"],
                    "price_robux":p["price_robux"],"price_afg":p["price_afg"],
                    "price_hesab":p["price_hesab"],"gamepass_id":p["gamepass_id"],
                    "perks":perks[pid]})
    return jsonify({"ok":True,"plans":out,"admin_email":"admin@example.com","admin_phone":""})

# ---------- HF CHAT ----------
def hf_stream(model_id, messages, max_tokens, timeout=45):
    if not HF_API_KEY: raise RuntimeError("HF_API_KEY not configured")
    r = requests.post(HF_CHAT,
        headers={"Authorization":f"Bearer {HF_API_KEY}",
                 "Content-Type":"application/json","Accept":"text/event-stream"},
        json={"model":model_id,"messages":messages,"max_tokens":max_tokens,
              "temperature":0.7,"top_p":0.95,"stream":True},
        stream=True, timeout=timeout)
    if r.status_code >= 400:
        try: b = r.text[:200]
        except: b = ""
        raise RuntimeError(f"HTTP {r.status_code} {b}")
    for raw in r.iter_lines(decode_unicode=True):
        if not raw or not raw.startswith("data:"): continue
        p = raw[5:].strip()
        if not p or p == "[DONE]": continue
        try: o = json.loads(p)
        except: continue
        ch = o.get("choices") or []
        if not ch: continue
        c = (ch[0].get("delta") or {}).get("content")
        if c: yield c

def build_messages(system, history, user_text, persona="", mem=None):
    msgs = [{"role":"system","content":system}]
    if persona: msgs.append({"role":"system","content":f"User preference: {persona[:1500]}"})
    if mem: msgs.append({"role":"system","content":"Remember: " + " | ".join(m["text"] for m in mem[-8:])})
    for h in (history or [])[-12:]:
        role, txt = h.get("role"), (h.get("content") or "").strip()[:3000]
        if role in ("user","assistant") and txt: msgs.append({"role":role,"content":txt})
    msgs.append({"role":"user","content":user_text[:8000]})
    return msgs

@app.route("/api/chat/stream", methods=["POST"])
@require_user
def chat_stream():
    d = request.get_json(silent=True) or {}
    msg = (d.get("message") or "").strip()
    history = d.get("history") or []
    key = d.get("model") or "mirox-luna-1.2"
    if not msg: return jsonify({"ok":False,"error":"Empty message"}), 400
    u = current_user()
    cfg = MODELS.get(key) or MODELS["mirox-luna-1.2"]
    if TIER_RANK[cfg["tier"]] > TIER_RANK[u["tier"]]:
        if not (u["tier"] == "free" and cfg["tier"] == "ultimate"):
            cfg = MODELS["mirox-luna-1.2"]
    mem = bucket(MEMORY, u["email"])
    persona = PERSONAS.get(u["email"], "")
    msgs = build_messages(SYSTEM_PROMPT, history, msg, persona, mem)

    def gen():
        t0 = time.time()
        try:
            for tok in hf_stream(cfg["hf"], msgs, cfg["tokens"]):
                yield f"data: {json.dumps({'d':tok})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error':str(e)[:220]})}\n\n"
            return
        yield f"data: {json.dumps({'done':True,'model':cfg['label'],'ms':int((time.time()-t0)*1000)})}\n\n"

    return Response(stream_with_context(gen()), mimetype="text/event-stream",
                    headers={"Cache-Control":"no-cache, no-transform",
                             "X-Accel-Buffering":"no","Connection":"keep-alive"})

@app.route("/api/chat", methods=["POST"])
@require_user
def chat_once():
    d = request.get_json(silent=True) or {}
    msg = (d.get("message") or "").strip()
    history = d.get("history") or []
    key = d.get("model") or "mirox-luna-1.2"
    if not msg: return jsonify({"ok":False,"error":"Empty message"}), 400
    u = current_user()
    cfg = MODELS.get(key) or MODELS["mirox-luna-1.2"]
    mem = bucket(MEMORY, u["email"])
    persona = PERSONAS.get(u["email"], "")
    out = ""
    try:
        for tok in hf_stream(cfg["hf"], build_messages(SYSTEM_PROMPT, history, msg, persona, mem), cfg["tokens"]):
            out += tok
    except Exception as e:
        return jsonify({"ok":False,"error":str(e)}), 502
    return jsonify({"ok":True,"reply":out,"model":cfg["label"]})

# ---------- HISTORY ----------
@app.route("/api/history")
@require_user
def hist_list():
    chats = bucket(CHATS, session["uid"])
    arr = sorted(chats.values(), key=lambda c: c.get("updatedAt",0), reverse=True)[:100]
    return jsonify({"conversations":[{"id":c["id"],"title":c["title"],
                                       "updated_at":c.get("updatedAt",0)} for c in arr]})

@app.route("/api/history/search")
@require_user
def hist_search():
    q = (request.args.get("q") or "").strip().lower()
    if not q: return hist_list()
    chats = bucket(CHATS, session["uid"])
    out = [{"id":c["id"],"title":c["title"],"updated_at":c.get("updatedAt",0),
            "match":""} for c in chats.values() if q in (c["title"] or "").lower()]
    return jsonify({"conversations":out})

@app.route("/api/history/<cid>")
@require_user
def hist_get(cid):
    c = bucket(CHATS, session["uid"]).get(cid)
    if not c: return jsonify({"ok":False,"error":"Not found"}), 404
    return jsonify({"id":c["id"],"title":c["title"],
                    "messages":[{"role":m["role"],"text":m.get("text") or m.get("content","")}
                                for m in c["messages"]]})

@app.route("/api/history/<cid>", methods=["DELETE"])
@require_user
def hist_del(cid):
    bucket(CHATS, session["uid"]).pop(cid, None)
    return jsonify({"ok":True})

@app.route("/api/history/<cid>/rename", methods=["POST"])
@require_user
def hist_rename(cid):
    d = request.get_json(silent=True) or {}
    t = (d.get("title") or "").strip()[:120]
    c = bucket(CHATS, session["uid"]).get(cid)
    if c and t: c["title"] = t
    return jsonify({"ok":True})

@app.route("/api/history/save", methods=["POST"])
@require_user
def hist_save():
    d = request.get_json(silent=True) or {}
    cid = d.get("id") or ("c_" + uuid.uuid4().hex[:12])
    chats = bucket(CHATS, session["uid"])
    chats[cid] = {"id":cid,"title":(d.get("title") or "New chat")[:120],
                  "messages":d.get("messages") or [],"updatedAt":now()}
    return jsonify({"ok":True,"id":cid})

# ---------- MEMORY ----------
@app.route("/api/memory")
@require_user
def mem_list(): return jsonify({"ok":True,"facts":bucket(MEMORY, session["uid"])})

@app.route("/api/memory", methods=["POST"])
@require_user
def mem_add():
    d = request.get_json(silent=True) or {}
    t = (d.get("fact") or "").strip()[:500]
    if not t: return jsonify({"ok":False,"error":"Fact required"}), 400
    item = {"id":uuid.uuid4().hex[:8],"text":t}
    bucket(MEMORY, session["uid"]).append(item)
    return jsonify({"ok":True,"fact":item})

@app.route("/api/memory/<mid>", methods=["DELETE"])
@require_user
def mem_del(mid):
    lst = bucket(MEMORY, session["uid"])
    lst[:] = [m for m in lst if m["id"] != mid]
    return jsonify({"ok":True})

# ---------- PERSONA ----------
@app.route("/api/settings/persona", methods=["GET"])
@require_user
def persona_get(): return jsonify({"ok":True,"persona":PERSONAS.get(session["uid"],"")})

@app.route("/api/settings/persona", methods=["POST"])
@require_user
def persona_set():
    d = request.get_json(silent=True) or {}
    PERSONAS[session["uid"]] = (d.get("persona") or "").strip()[:2000]
    return jsonify({"ok":True})

# ---------- SUPPORT ----------
@app.route("/api/report", methods=["POST"])
@require_user
def report_new():
    d = request.get_json(silent=True) or {}
    tid = "t_" + uuid.uuid4().hex[:8]
    tk = {"id":tid,"subject":(d.get("subject") or "(no subject)")[:120],
          "category":(d.get("category") or "general")[:40],"status":"open",
          "unread_user":0,"created_at":now(),
          "messages":[{"from":"user","text":(d.get("message") or "")[:4000],"ts":now()}]}
    bucket(TICKETS, session["uid"]).insert(0, tk)
    return jsonify({"ok":True,"ticket_id":tid})

@app.route("/api/report/mine")
@require_user
def report_mine(): return jsonify({"ok":True,"reports":bucket(TICKETS, session["uid"])})

@app.route("/api/report/<tid>/reply", methods=["POST"])
@require_user
def report_reply(tid):
    d = request.get_json(silent=True) or {}
    for t in bucket(TICKETS, session["uid"]):
        if t["id"] == tid:
            t["messages"].append({"from":"user","text":(d.get("text") or "")[:4000],"ts":now()})
            t["status"] = "open"
    return jsonify({"ok":True})

# ---------- API KEYS ----------
@app.route("/api/keys")
@require_user
def keys_list(): return jsonify({"ok":True,"keys":bucket(KEYS, session["uid"])})

@app.route("/api/keys/generate", methods=["POST"])
@require_user
def keys_gen():
    d = request.get_json(silent=True) or {}
    raw = "mx_" + secrets.token_urlsafe(32)
    k = {"id":"k_" + uuid.uuid4().hex[:8],"name":(d.get("name") or "My key")[:60],
         "key":raw,"preview":raw[:8] + "…" + raw[-4:],"revoked":False,
         "created_at":now(),"tier":current_user()["tier"]}
    bucket(KEYS, session["uid"]).append(k)
    return jsonify({"ok":True,"id":k["id"],"key":raw})

@app.route("/api/keys/<kid>", methods=["DELETE"])
@require_user
def keys_del(kid):
    for k in bucket(KEYS, session["uid"]):
        if k["id"] == kid: k["revoked"] = True
    return jsonify({"ok":True})

# ---------- EMAIL (stubs) ----------
@app.route("/api/email/status")
@require_user
def email_status():
    u = current_user()
    return jsonify({"ok":True,"connected":bool(u.get("gmail")),
                    "address":u.get("gmail",""),"used_today":0,"daily_limit":5})

@app.route("/api/email/connect", methods=["POST"])
@require_user
def email_connect():
    d = request.get_json(silent=True) or {}
    a = (d.get("address") or "").strip().lower()
    with _LOCK:
        if session["uid"] in USERS: USERS[session["uid"]]["gmail"] = a
    return jsonify({"ok":True})

@app.route("/api/email/disconnect", methods=["POST"])
@require_user
def email_disc():
    with _LOCK:
        if session["uid"] in USERS: USERS[session["uid"]]["gmail"] = ""
    return jsonify({"ok":True})

@app.route("/api/email/test", methods=["POST"])
@require_user
def email_test():
    return jsonify({"ok":False,"error":"Email sending isn't enabled on this deployment."}), 501

@app.route("/api/email/send", methods=["POST"])
@require_user
def email_send():
    return jsonify({"ok":False,"error":"Email sending isn't enabled on this deployment."}), 501

# ---------- IMAGE ----------
@app.route("/api/image/generate", methods=["POST"])
@require_user
def image_gen():
    d = request.get_json(silent=True) or {}
    prompt = (d.get("prompt") or "").strip()[:1000]
    if not prompt: return jsonify({"ok":False,"error":"Prompt required"}), 400
    if not HF_API_KEY: return jsonify({"ok":False,"error":"HF_API_KEY missing"}), 500
    try:
        r = requests.post(HF_IMAGES,
            headers={"Authorization":f"Bearer {HF_API_KEY}","Content-Type":"application/json"},
            json={"model":"black-forest-labs/FLUX.1-schnell","prompt":prompt,"n":1,
                  "size":"1024x1024","response_format":"url"},
            timeout=60)
        if r.status_code >= 400:
            return jsonify({"ok":False,"error":f"HTTP {r.status_code}"}), 502
        j = r.json()
        it = (j.get("data") or [{}])[0]
        url = it.get("url") or (("data:image/png;base64," + it["b64_json"]) if it.get("b64_json") else None)
        if not url: return jsonify({"ok":False,"error":"No image returned"}), 502
        return jsonify({"ok":True,"image":url,"url":url,"model":"FLUX.1-schnell",
                        "provider":"Hugging Face"})
    except Exception as e:
        return jsonify({"ok":False,"error":str(e)[:200]}), 502

@app.route("/api/video/generate", methods=["POST"])
@require_user
def video_stub():
    return jsonify({"ok":False,"error":"Video generation isn't available on this deployment."}), 501

# ---------- PAYMENTS ----------
@app.route("/api/payment/hesabpay/create", methods=["POST"])
@require_user
def hesab_create():
    return jsonify({"ok":False,"error":"HesabPay isn't configured."}), 400

# ==================== ADMIN ====================
@app.route("/api/admin/status")
def admin_status(): return jsonify({"ok":True,"is_admin":bool(session.get("is_admin"))})

@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    d = request.get_json(silent=True) or {}
    pw = (d.get("password") or "").strip()
    if pw and hmac.compare_digest(pw, ADMIN_PASSWORD):
        session["is_admin"] = True
        return jsonify({"ok":True})
    return jsonify({"ok":False,"error":"Wrong password"}), 401

@app.route("/api/admin/logout", methods=["POST"])
def admin_logout(): session.pop("is_admin", None); return jsonify({"ok":True})

@app.route("/api/admin/users")
@require_admin
def admin_users():
    with _LOCK:
        arr = list(USERS.values())
    arr.sort(key=lambda u: u.get("created_at",0), reverse=True)
    return jsonify({"ok":True,"users":arr})

@app.route("/api/admin/set-tier", methods=["POST"])
@require_admin
def admin_set_tier():
    d = request.get_json(silent=True) or {}
    email = (d.get("email") or "").strip().lower()
    tier = (d.get("tier") or "free").strip().lower()
    if tier not in PLANS: return jsonify({"ok":False,"error":"Invalid tier"}), 400
    if not email: return jsonify({"ok":False,"error":"Email required"}), 400
    with _LOCK:
        rec = USERS.get(email)
        if not rec:
            rec = {"email":email,"name":"","tier":tier,"created_at":now(),"gmail":""}
            USERS[email] = rec
        else:
            rec["tier"] = tier
    return jsonify({"ok":True,"user":rec})

@app.route("/api/admin/stats")
@require_admin
def admin_stats():
    with _LOCK:
        u = list(USERS.values())
    return jsonify({"ok":True,"total":len(u),
                    "free":sum(1 for x in u if x["tier"] == "free"),
                    "pro":sum(1 for x in u if x["tier"] == "pro"),
                    "ultimate":sum(1 for x in u if x["tier"] == "ultimate")})

# ---------- ADMIN CONSOLE ----------
ADMIN_HTML = r"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mirox Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
button{font:inherit;cursor:pointer;background:none;border:none;color:inherit}
input,select{font:inherit;color:inherit}
body{font-family:Inter,-apple-system,sans-serif;background:#08080c;color:#f4f4f8;min-height:100vh;font-size:14px;line-height:1.5}
.wrap{max-width:1000px;margin:0 auto;padding:32px 20px}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}
.brand{display:flex;align-items:center;gap:10px}
.brand-mark{width:32px;height:32px;border-radius:10px;background:linear-gradient(135deg,#4f46e5,#6366f1);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px}
.brand-name{font-weight:700;font-size:16px}
.badge{background:#1e1e28;border:1px solid #2a2a36;color:#8f8f9d;font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px;text-transform:uppercase}
.logout-btn{background:#1e1e28;border:1px solid #2a2a36;color:#f4f4f8;padding:8px 14px;border-radius:9px;font-size:13px;font-weight:600}
.login-card{max-width:380px;margin:80px auto 0;background:#13131a;border:1px solid #1e1e28;border-radius:20px;padding:32px}
.login-card h1{font-size:22px;font-weight:700;margin-bottom:8px}
.login-card p{color:#8f8f9d;font-size:13.5px;margin-bottom:22px}
.login-card label{display:block;font-size:12.5px;font-weight:600;color:#8f8f9d;margin-bottom:6px}
.login-card input{width:100%;padding:12px;background:#08080c;border:1px solid #1e1e28;color:#f4f4f8;border-radius:11px;font-size:16px;outline:none;font-family:'JetBrains Mono',monospace;letter-spacing:.3em;text-align:center}
.login-card input:focus{border-color:#4f46e5}
.login-card button{width:100%;margin-top:16px;padding:12px;background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;border-radius:11px;font-weight:600;font-size:14px}
.login-card button:disabled{opacity:.5}
.err{color:#f87171;font-size:12.5px;margin-top:10px;text-align:center;min-height:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.stat{background:#13131a;border:1px solid #1e1e28;border-radius:14px;padding:16px 18px}
.stat-n{font-size:26px;font-weight:700;font-family:'JetBrains Mono',monospace}
.stat-l{font-size:11px;color:#8f8f9d;text-transform:uppercase;font-weight:700;margin-top:2px}
.card{background:#13131a;border:1px solid #1e1e28;border-radius:16px;overflow:hidden}
.card-head{padding:16px 20px;border-bottom:1px solid #1e1e28;display:flex;align-items:center;justify-content:space-between}
.card-head h2{font-size:15px;font-weight:700}
.refresh{background:#1e1e28;border:1px solid #2a2a36;padding:6px 12px;border-radius:8px;font-size:12.5px;font-weight:600}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:12px 18px;font-size:11px;font-weight:700;color:#8f8f9d;text-transform:uppercase;background:#0e0e14;border-bottom:1px solid #1e1e28}
td{padding:14px 18px;border-bottom:1px solid #13131a;font-size:13.5px}
tr:hover td{background:#17171f}
.email{font-family:'JetBrains Mono',monospace;font-size:12.5px;color:#c8c8d2;word-break:break-all}
.when{font-family:'JetBrains Mono',monospace;font-size:12px;color:#66667a}
.empty{padding:40px;text-align:center;color:#66667a;font-style:italic}
.tier-select{background:#0e0e14;border:1px solid #2a2a36;color:#f4f4f8;padding:7px 10px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
.pill{display:inline-block;padding:3px 9px;border-radius:12px;font-size:11px;font-weight:700;text-transform:uppercase}
.pill.free{background:#1e1e28;color:#8f8f9d}
.pill.pro{background:rgba(99,102,241,.15);color:#a5b4fc}
.pill.ultimate{background:rgba(139,92,246,.15);color:#c4b5fd}
.toast{position:fixed;bottom:20px;right:20px;background:#13131a;border:1px solid #2a2a36;color:#f4f4f8;padding:12px 18px;border-radius:11px;font-size:13px;font-weight:600;opacity:0;transform:translateY(6px);transition:.2s;pointer-events:none}
.toast.show{opacity:1;transform:none}
</style></head><body>
<div class="wrap" id="app"></div>
<div class="toast" id="toast"></div>
<script>
const root=document.getElementById('app');
const toastEl=document.getElementById('toast');
let toastTimer=null;
function toast(m){toastEl.textContent=m;toastEl.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastEl.classList.remove('show'),1800);}
function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
async function api(p,o={}){return fetch(p,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...o});}
async function isAdmin(){try{const r=await api('/api/admin/status');const d=await r.json();return !!d.is_admin;}catch{return false;}}
async function render(){const a=await isAdmin();if(!a)return renderLogin();renderDash();}
function renderLogin(){
  root.innerHTML=`<div class="top"><div class="brand"><div class="brand-mark">M</div><div class="brand-name">Mirox</div><span class="badge">Admin</span></div></div>
  <div class="login-card"><h1>Admin access</h1><p>Enter the admin password to continue.</p>
  <label>Password</label><input id="pw" type="password" placeholder="••••" autofocus maxlength="32">
  <button id="loginBtn">Unlock</button><div class="err" id="err"></div></div>`;
  const pw=document.getElementById('pw'),btn=document.getElementById('loginBtn'),err=document.getElementById('err');
  async function go(){const p=pw.value.trim();if(!p)return;btn.disabled=true;err.textContent='';
    try{const r=await api('/api/admin/login',{method:'POST',body:JSON.stringify({password:p})});
      const d=await r.json();if(!d.ok)throw new Error(d.error||'Failed');render();
    }catch(e){err.textContent=e.message;}finally{btn.disabled=false;}}
  btn.addEventListener('click',go);
  pw.addEventListener('keydown',e=>{if(e.key==='Enter')go();});
}
async function renderDash(){
  root.innerHTML=`<div class="top"><div class="brand"><div class="brand-mark">M</div><div class="brand-name">Mirox</div><span class="badge">Admin</span></div>
  <button class="logout-btn" id="lo">Sign out</button></div>
  <div class="stats" id="stats"></div>
  <div class="card"><div class="card-head"><h2>Users</h2><button class="refresh" id="rf">Refresh</button></div>
  <div id="tbl"><div class="empty">Loading…</div></div></div>`;
  document.getElementById('lo').addEventListener('click',async()=>{await api('/api/admin/logout',{method:'POST'});render();});
  document.getElementById('rf').addEventListener('click',loadUsers);
  await loadUsers();
}
async function loadUsers(){
  const box=document.getElementById('tbl'),sb=document.getElementById('stats');
  try{
    const r=await api('/api/admin/users');const d=await r.json();
    const us=d.users||[];
    const c={free:0,pro:0,ultimate:0};us.forEach(u=>c[u.tier||'free']++);
    sb.innerHTML=`<div class="stat"><div class="stat-n">${us.length}</div><div class="stat-l">Total</div></div>
      <div class="stat"><div class="stat-n">${c.free}</div><div class="stat-l">Free</div></div>
      <div class="stat"><div class="stat-n">${c.pro}</div><div class="stat-l">Pro</div></div>
      <div class="stat"><div class="stat-n">${c.ultimate}</div><div class="stat-l">Ultimate</div></div>`;
    if(!us.length){box.innerHTML='<div class="empty">No users yet. Sign in from the main app first.</div>';return;}
    box.innerHTML=`<table><thead><tr><th>Email</th><th>Name</th><th>Tier</th><th>Joined</th><th>Change</th></tr></thead><tbody>${us.map(u=>{
      const t=u.tier||'free',dt=u.created_at?new Date(u.created_at*1000).toLocaleString():'—';
      return `<tr><td class="email">${esc(u.email)}</td><td>${esc(u.name||'—')}</td>
        <td><span class="pill ${t}">${t}</span></td><td class="when">${dt}</td>
        <td><select class="tier-select" data-email="${esc(u.email)}">
          <option value="free" ${t==='free'?'selected':''}>Free</option>
          <option value="pro" ${t==='pro'?'selected':''}>Pro</option>
          <option value="ultimate" ${t==='ultimate'?'selected':''}>Ultimate</option>
        </select></td></tr>`;}).join('')}</tbody></table>`;
    box.querySelectorAll('.tier-select').forEach(s=>{
      s.addEventListener('change',async()=>{
        const email=s.dataset.email,tier=s.value;
        try{const r=await api('/api/admin/set-tier',{method:'POST',body:JSON.stringify({email,tier})});
          const d=await r.json();if(!d.ok)throw new Error(d.error||'Failed');
          toast(`Set ${email} → ${tier}`);loadUsers();
        }catch(e){toast(e.message);}});
    });
  }catch(e){box.innerHTML='<div class="empty">Failed to load.</div>';}
}
render();
</script></body></html>"""

@app.route("/admin/console")
def admin_console(): return Response(ADMIN_HTML, mimetype="text/html")

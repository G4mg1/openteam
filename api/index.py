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

DISCORD_WEBHOOK = os.environ.get(
    "DISCORD_WEBHOOK",
    "https://discord.com/api/webhooks/1554014348794667078/1KhZnYj62iJQyRIg7CMIeRiaophKYppiXegaJ54vgbVARlYu1nx1OCSVU-N4PuN69mgI",
).strip()

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

# ---------- DISCORD LOGGING ----------
COLORS = {
    "signin":       0x16a34a,
    "chat":         0x3b82f6,
    "image":        0x8b5cf6,
    "video":        0xdc2626,
    "subscription": 0xd97706,
    "error":        0xef4444,
}

def _discord_post(payload):
    if not DISCORD_WEBHOOK:
        return
    try:
        requests.post(DISCORD_WEBHOOK, json=payload, timeout=4)
    except Exception:
        pass

def log_discord(kind, title, description="", fields=None):
    """Fire-and-forget Discord embed."""
    if not DISCORD_WEBHOOK:
        return
    embed = {
        "title": title,
        "description": (description or "")[:2000],
        "color": COLORS.get(kind, 0x6366f1),
        "footer": {"text": "MiroxAI"},
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if fields:
        embed["fields"] = [
            {"name": str(k)[:200], "value": str(v)[:1000], "inline": False}
            for k, v in fields
        ]
    payload = {
        "username": "MiroxAI",
        "embeds": [embed],
    }
    threading.Thread(target=_discord_post, args=(payload,), daemon=True).start()

# ---------- MODELS ----------
MODELS = {
    "mirox-luna-1.2":    {"label":"Luna","tagline":"Smart and fast","tier":"free",
                          "hf":"meta-llama/Llama-3.2-3B-Instruct","tokens":700,"default":True},
    "mirox-gen-1":       {"label":"Gen","tagline":"Quick and light","tier":"free",
                          "hf":"meta-llama/Llama-3.2-1B-Instruct","tokens":512,"fallback":True},
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
                 "trial_model":"mirox-eclipse-2.0","fallback_model":"mirox-gen-1",
                 "price_robux":0,"price_afg":0,"price_hesab":0,"gamepass_id":""},
    "pro":      {"label":"Pro","daily_limit":500,"ultimate_trial_limit":0,
                 "trial_model":"","fallback_model":"mirox-pro-5",
                 "price_robux":250,"price_afg":120,"price_hesab":150,"gamepass_id":""},
    "ultimate": {"label":"Ultimate","daily_limit":5000,"ultimate_trial_limit":0,
                 "trial_model":"","fallback_model":"mirox-ultra-10",
                 "price_robux":1200,"price_afg":450,"price_hesab":550,"gamepass_id":""},
}
SYSTEM_PROMPT = (
    "You are Mirox, an AI assistant created by the OpenSurr team. Your name is Mirox. "
    "Never mention any other company or model. If asked who made you, answer: OpenSurr. "
    "Be warm, clear, and concise."
)
ANNOUNCEMENT = {
    "enabled": True, "version": "v1-luna", "title": "Meet Luna",
    "image": "luna.png",
    "body": "Luna is now the default — smart, fast, and free.",
    "highlights": ["Luna — new default", "Pro & Ultra on Pro plan", "Eclipse on Ultimate", "Image generation ready"],
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
        default = {} if name is CHATS else []
        return name.setdefault(email, default)

# ---------- CONFIG ----------
@app.route("/config.json")
@app.route("/api/config")
def config():
    u = current_user()
    return jsonify({
        "app":{"name":"MiroxAI","made_by":"OpenSurr","version":"v1"},
        "models":[{"id":k,"label":v["label"],"tagline":v["tagline"],
                   "tier":v["tier"],"default":v.get("default",False),
                   "fallback":v.get("fallback",False)} for k,v in MODELS.items()],
        "plans":PLANS,
        "payments":{"hesabpay":{"enabled":False},"robux":{"enabled":True},"afg_cash":{"enabled":True}},
        "email":{"enabled":True,"free_daily_limit":5,"paid_daily_limit":100,
                 "signature":"made by mirox ai","from_name":"MiroxAI"},
        "announcement":ANNOUNCEMENT,
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
    if not name or "@" not in email or "." not in email.split("@")[-1]:
        return jsonify({"ok":False,"error":"Valid name and email required"}), 400
    with _LOCK:
        rec = USERS.get(email)
        existing = bool(rec)
        if not rec:
            rec = {"email":email,"name":name,"tier":"free","created_at":now(),"gmail":""}
            USERS[email] = rec
        else:
            rec["name"] = name
    session.permanent = True
    session.update(uid=email, email=email, name=name, tier=rec["tier"])

    log_discord(
        "signin",
        f"👤 {'New user' if not existing else 'Sign in'}",
        "",
        [
            ("Name", name),
            ("Email", email),
            ("Tier", rec["tier"]),
            ("Time", time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())),
        ],
    )
    return jsonify({"ok":True,"user":{"id":email,"email":email,"name":name,
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
    u = current_user(); p = PLANS[u["tier"]]
    ks = bucket(KEYS, u["email"])
    return jsonify({
        "ok":True,"tier":u["tier"],"tier_label":p["label"],
        "daily_limit":p["daily_limit"],"daily_remaining":p["daily_limit"],
        "trial_limit":p["ultimate_trial_limit"],"trial_remaining":p["ultimate_trial_limit"],
        "images_allowed":True,"video_allowed":False,
        "email_connected":bool(u.get("gmail")),
        "keys_remaining":max(0,3-len(ks)),"keys_per_period":3,"refill_days":30,
        "daily_reset_seconds":86400,"lite_mode":False,
    })

@app.route("/api/subscription/plans")
def plans_list():
    perks = {
        "free":["Luna & Gen — free models","10 Eclipse chats/day","Image generation","Memory & persona"],
        "pro":["Pro & Ultra models","500 msgs/day","Image generation","Priority speed"],
        "ultimate":["Eclipse — best model","5000 msgs/day","Everything in Pro","Ultimate badge"],
    }
    out = []
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
        headers={"Authorization":f"Bearer {HF_API_KEY}","Content-Type":"application/json",
                 "Accept":"text/event-stream"},
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

    log_discord("chat", "💬 Chat message", "",
                [("User", u["email"]), ("Model", cfg["label"]),
                 ("Message", msg[:500]), ("Length", f"{len(msg)} chars")])

    def gen():
        t0 = time.time(); full = ""
        try:
            for tok in hf_stream(cfg["hf"], msgs, cfg["tokens"]):
                full += tok
                yield f"data: {json.dumps({'d':tok})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error':str(e)[:220]})}\n\n"
            log_discord("error", "❌ Chat failed", str(e)[:400],
                        [("User", u["email"]), ("Model", cfg["label"])])
            return
        ms = int((time.time()-t0)*1000)
        yield f"data: {json.dumps({'done':True,'model':cfg['label'],'ms':ms})}\n\n"

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
    bucket(CHATS, session["uid"])[cid] = {"id":cid,
        "title":(d.get("title") or "New chat")[:120],
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
def email_connect(): return jsonify({"ok":True})
@app.route("/api/email/disconnect", methods=["POST"])
@require_user
def email_disc(): return jsonify({"ok":True})
@app.route("/api/email/test", methods=["POST"])
@require_user
def email_test(): return jsonify({"ok":False,"error":"Email not enabled"}), 501
@app.route("/api/email/send", methods=["POST"])
@require_user
def email_send(): return jsonify({"ok":False,"error":"Email not enabled"}), 501

# ---------- IMAGE ----------
@app.route("/api/image/generate", methods=["POST"])
@require_user
def image_gen():
    d = request.get_json(silent=True) or {}
    prompt = (d.get("prompt") or "").strip()[:1000]
    if not prompt: return jsonify({"ok":False,"error":"Prompt required"}), 400
    if not HF_API_KEY: return jsonify({"ok":False,"error":"HF_API_KEY missing"}), 500
    u = current_user()
    log_discord("image", "🎨 Image request", "",
                [("User", u["email"]), ("Prompt", prompt[:500])])
    try:
        r = requests.post(HF_IMAGES,
            headers={"Authorization":f"Bearer {HF_API_KEY}","Content-Type":"application/json"},
            json={"model":"black-forest-labs/FLUX.1-schnell","prompt":prompt,"n":1,
                  "size":"1024x1024","response_format":"url"},
            timeout=60)
        if r.status_code >= 400:
            log_discord("error", "❌ Image failed", f"HTTP {r.status_code}",
                        [("User", u["email"]), ("Prompt", prompt[:300])])
            return jsonify({"ok":False,"error":f"HTTP {r.status_code}"}), 502
        j = r.json()
        it = (j.get("data") or [{}])[0]
        url = it.get("url") or (("data:image/png;base64," + it["b64_json"]) if it.get("b64_json") else None)
        if not url: return jsonify({"ok":False,"error":"No image returned"}), 502
        log_discord("image", "✅ Image generated", "",
                    [("User", u["email"]), ("Model", "FLUX.1-schnell")])
        return jsonify({"ok":True,"image":url,"url":url,"model":"FLUX.1-schnell","provider":"Hugging Face"})
    except Exception as e:
        log_discord("error", "❌ Image error", str(e)[:300], [("User", u["email"])])
        return jsonify({"ok":False,"error":str(e)[:200]}), 502

# ---------- VIDEO ----------
@app.route("/api/video/generate", methods=["POST"])
@require_user
def video_stub():
    d = request.get_json(silent=True) or {}
    u = current_user()
    log_discord("video", "🎬 Video request", "Not enabled",
                [("User", u["email"]), ("Prompt", (d.get("prompt") or "")[:300])])
    return jsonify({"ok":False,"error":"Video generation isn't available on this deployment."}), 501

# ---------- PAYMENTS ----------
@app.route("/api/payment/hesabpay/create", methods=["POST"])
@require_user
def hesab_create(): return jsonify({"ok":False,"error":"HesabPay isn't configured."}), 400

# ==================== ADMIN ====================
@app.route("/api/admin/status")
def admin_status(): return jsonify({"ok":True,"is_admin":bool(session.get("is_admin"))})

@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    d = request.get_json(silent=True) or {}
    pw = (d.get("password") or "").strip()
    if pw and hmac.compare_digest(pw, ADMIN_PASSWORD):
        session["is_admin"] = True
        log_discord("signin", "🔐 Admin login", "", [("Time", time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()))])
        return jsonify({"ok":True})
    return jsonify({"ok":False,"error":"Wrong password"}), 401

@app.route("/api/admin/logout", methods=["POST"])
def admin_logout(): session.pop("is_admin", None); return jsonify({"ok":True})

@app.route("/api/admin/users")
@require_admin
def admin_users():
    with _LOCK: arr = list(USERS.values())
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
    log_discord("subscription", "👑 Subscription changed", "",
                [("User", email), ("New tier", tier)])
    return jsonify({"ok":True,"user":rec})

@app.route("/api/admin/stats")
@require_admin
def admin_stats():
    with _LOCK: u = list(USERS.values())
    return jsonify({"ok":True,"total":len(u),
                    "free":sum(1 for x in u if x["tier"] == "free"),
                    "pro":sum(1 for x in u if x["tier"] == "pro"),
                    "ultimate":sum(1 for x in u if x["tier"] == "ultimate")})

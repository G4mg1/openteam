import os, json, time, secrets, hmac, threading
from datetime import timedelta
from functools import wraps
from flask import (Flask, request, jsonify, session,
                   Response, stream_with_context)
import requests

# -------------------- CONFIG --------------------
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

# -------------------- USER STORE (memory + /tmp) --------------------
_USERS = {}
_LOCK  = threading.Lock()
_USERS_FILE = "/tmp/mirox_users.json"

def _load_users():
    global _USERS
    if _USERS:
        return
    try:
        if os.path.exists(_USERS_FILE):
            with open(_USERS_FILE, "r") as f:
                _USERS = json.load(f) or {}
    except Exception:
        _USERS = {}

def _save_users():
    try:
        with open(_USERS_FILE, "w") as f:
            json.dump(_USERS, f)
    except Exception:
        pass

def get_user_record(email):
    if not email:
        return None
    with _LOCK:
        _load_users()
        return _USERS.get(email.lower())

def upsert_user(email, name=None, tier=None):
    if not email:
        return None
    with _LOCK:
        _load_users()
        k = email.lower()
        rec = _USERS.get(k) or {}
        rec["email"] = k
        if name:
            rec["name"] = name
        if tier is not None:
            rec["tier"] = tier
        rec.setdefault("name", "")
        rec.setdefault("tier", "free")
        rec.setdefault("created_at", int(time.time()))
        _USERS[k] = rec
        _save_users()
        return rec

def list_users():
    with _LOCK:
        _load_users()
        return list(_USERS.values())

# -------------------- MODELS --------------------
MODELS = {
    "luna":  {"label": "Luna",  "hf": "meta-llama/Llama-3.2-3B-Instruct",  "tokens": 512, "tier": "free"},
    "swift": {"label": "Swift", "hf": "Qwen/Qwen2.5-7B-Instruct",          "tokens": 700, "tier": "pro"},
    "sage":  {"label": "Sage",  "hf": "meta-llama/Llama-3.1-8B-Instruct", "tokens": 900, "tier": "pro"},
}

TIER_RANK = {"free": 0, "pro": 1, "ultimate": 2}

SYSTEM_PROMPT = (
    "You are Mirox, a warm, concise, and helpful AI assistant made by the OpenSurr team. "
    "Your name is Mirox. If asked who made you, answer: OpenSurr. "
    "Never mention any other company, model, or provider. "
    "Answer clearly. Keep replies short unless the user asks for depth. "
    "Use plain, natural language."
)

# -------------------- HELPERS --------------------
def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    rec = get_user_record(uid) or {}
    tier = rec.get("tier") or session.get("tier") or "free"
    session["tier"] = tier
    return {
        "id":    uid,
        "email": session.get("email", ""),
        "name":  rec.get("name") or session.get("name", ""),
        "tier":  tier,
    }

def require_user(fn):
    @wraps(fn)
    def w(*a, **k):
        if not session.get("uid"):
            return jsonify({"ok": False, "error": "Sign in first"}), 401
        return fn(*a, **k)
    return w

def require_admin(fn):
    @wraps(fn)
    def w(*a, **k):
        if not session.get("is_admin"):
            return jsonify({"ok": False, "error": "Admin only"}), 403
        return fn(*a, **k)
    return w

# -------------------- META --------------------
@app.route("/api/config")
def config():
    u = current_user()
    return jsonify({
        "models": [
            {"id": k, "label": v["label"], "tier": v["tier"]}
            for k, v in MODELS.items()
        ],
        "hf_ready": bool(HF_API_KEY),
        "user_tier": u["tier"] if u else "free",
    })

@app.route("/api/health")
def health():
    return jsonify({"ok": True, "hf": bool(HF_API_KEY), "t": int(time.time())})

# -------------------- AUTH --------------------
@app.route("/api/auth/login", methods=["POST"])
def login():
    data  = request.get_json(silent=True) or {}
    name  = (data.get("name")  or "").strip()[:60]
    email = (data.get("email") or "").strip().lower()[:120]
    if not name or "@" not in email or "." not in email.split("@")[-1]:
        return jsonify({"ok": False, "error": "Valid name and email required"}), 400
    rec = upsert_user(email, name=name)
    session.permanent = True
    session["uid"]   = email
    session["email"] = email
    session["name"]  = name
    session["tier"]  = rec.get("tier", "free")
    return jsonify({"ok": True, "user": current_user()})

@app.route("/api/auth/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})

@app.route("/api/me")
def me():
    return jsonify({"user": current_user()})

# -------------------- HF CHAT (stream) --------------------
def hf_stream(model_id, messages, max_tokens, timeout=45):
    if not HF_API_KEY:
        raise RuntimeError("HF_API_KEY not configured")
    r = requests.post(
        HF_CHAT,
        headers={
            "Authorization": f"Bearer {HF_API_KEY}",
            "Content-Type":  "application/json",
            "Accept":        "text/event-stream",
        },
        json={
            "model":       model_id,
            "messages":    messages,
            "max_tokens":  max_tokens,
            "temperature": 0.7,
            "top_p":       0.95,
            "stream":      True,
        },
        stream=True,
        timeout=timeout,
    )
    if r.status_code >= 400:
        body = ""
        try: body = r.text[:200]
        except Exception: pass
        raise RuntimeError(f"HTTP {r.status_code} {body}")

    for raw in r.iter_lines(decode_unicode=True):
        if not raw:
            continue
        if not raw.startswith("data:"):
            continue
        payload = raw[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            obj = json.loads(payload)
        except Exception:
            continue
        choices = obj.get("choices") or []
        if not choices:
            continue
        delta = choices[0].get("delta") or {}
        content = delta.get("content")
        if content:
            yield content

def build_messages(message, history):
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    for h in (history or [])[-12:]:
        role = h.get("role")
        text = (h.get("content") or "").strip()[:3000]
        if role in ("user", "assistant") and text:
            msgs.append({"role": role, "content": text})
    msgs.append({"role": "user", "content": message[:8000]})
    return msgs

@app.route("/api/chat", methods=["POST"])
@require_user
def chat():
    data    = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    history = data.get("history") or []
    model_key = data.get("model") or "luna"

    if not message:
        return jsonify({"ok": False, "error": "Empty message"}), 400

    user_tier = (current_user() or {}).get("tier", "free")
    cfg = MODELS.get(model_key) or MODELS["luna"]
    if TIER_RANK.get(cfg.get("tier", "free"), 0) > TIER_RANK.get(user_tier, 0):
        cfg = MODELS["luna"]

    messages = build_messages(message, history)

    def generate():
        t0 = time.time()
        try:
            for token in hf_stream(cfg["hf"], messages, cfg["tokens"]):
                yield f"data: {json.dumps({'d': token})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)[:220]})}\n\n"
            return
        yield f"data: {json.dumps({'done': True, 'model': cfg['label'], 'ms': int((time.time()-t0)*1000)})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )

# -------------------- IMAGE --------------------
@app.route("/api/image", methods=["POST"])
@require_user
def image():
    data   = request.get_json(silent=True) or {}
    prompt = (data.get("prompt") or "").strip()[:1000]
    if not prompt:
        return jsonify({"ok": False, "error": "Prompt required"}), 400
    if not HF_API_KEY:
        return jsonify({"ok": False, "error": "HF_API_KEY missing"}), 500
    try:
        r = requests.post(
            HF_IMAGES,
            headers={
                "Authorization": f"Bearer {HF_API_KEY}",
                "Content-Type":  "application/json",
            },
            json={
                "model": "black-forest-labs/FLUX.1-schnell",
                "prompt": prompt,
                "n": 1,
                "size": "1024x1024",
                "response_format": "url",
            },
            timeout=60,
        )
        if r.status_code >= 400:
            return jsonify({"ok": False, "error": f"HTTP {r.status_code}"}), 502
        d = r.json()
        item = (d.get("data") or [{}])[0]
        url  = item.get("url") or (
            ("data:image/png;base64," + item["b64_json"]) if item.get("b64_json") else None
        )
        if not url:
            return jsonify({"ok": False, "error": "No image returned"}), 502
        return jsonify({"ok": True, "url": url})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:200]}), 502

# ==================== ADMIN API ====================
@app.route("/api/admin/status")
def admin_status():
    return jsonify({"ok": True, "is_admin": bool(session.get("is_admin"))})

@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    data = request.get_json(silent=True) or {}
    pw = (data.get("password") or "").strip()
    if pw and hmac.compare_digest(pw, ADMIN_PASSWORD):
        session["is_admin"] = True
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Wrong password"}), 401

@app.route("/api/admin/logout", methods=["POST"])
def admin_logout():
    session.pop("is_admin", None)
    return jsonify({"ok": True})

@app.route("/api/admin/users")
@require_admin
def admin_users():
    users = list_users()
    users.sort(key=lambda u: u.get("created_at", 0), reverse=True)
    return jsonify({"ok": True, "users": users})

@app.route("/api/admin/set-tier", methods=["POST"])
@require_admin
def admin_set_tier():
    data  = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    tier  = (data.get("tier")  or "free").strip().lower()
    if tier not in ("free", "pro", "ultimate"):
        return jsonify({"ok": False, "error": "Invalid tier"}), 400
    if not email:
        return jsonify({"ok": False, "error": "Email required"}), 400
    rec = upsert_user(email, tier=tier)
    return jsonify({"ok": True, "user": rec})

# -------------------- ADMIN CONSOLE (HTML) --------------------
ADMIN_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mirox Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
button{font:inherit;cursor:pointer;background:none;border:none;color:inherit}
input,select{font:inherit;color:inherit}
body{font-family:'Inter',-apple-system,sans-serif;background:#08080c;color:#f4f4f8;min-height:100vh;-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.5}
.wrap{max-width:1000px;margin:0 auto;padding:32px 20px}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}
.brand{display:flex;align-items:center;gap:10px}
.brand-mark{width:32px;height:32px;border-radius:10px;background:linear-gradient(135deg,#4f46e5,#6366f1);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px}
.brand-name{font-weight:700;font-size:16px;letter-spacing:-.015em}
.badge{background:#1e1e28;border:1px solid #2a2a36;color:#8f8f9d;font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px;letter-spacing:.4px;text-transform:uppercase}
.logout-btn{background:#1e1e28;border:1px solid #2a2a36;color:#f4f4f8;padding:8px 14px;border-radius:9px;font-size:13px;font-weight:600;transition:background .15s}
.logout-btn:hover{background:#2a2a36}
.login-card{max-width:380px;margin:80px auto 0;background:#13131a;border:1px solid #1e1e28;border-radius:20px;padding:32px}
.login-card h1{font-size:22px;font-weight:700;letter-spacing:-.02em;margin-bottom:8px}
.login-card p{color:#8f8f9d;font-size:13.5px;margin-bottom:22px}
.login-card label{display:block;font-size:12.5px;font-weight:600;color:#8f8f9d;margin-bottom:6px}
.login-card input{width:100%;padding:12px 14px;background:#08080c;border:1px solid #1e1e28;color:#f4f4f8;border-radius:11px;font-size:16px;outline:none;transition:border-color .15s,box-shadow .15s;font-family:'JetBrains Mono',monospace;letter-spacing:.3em;text-align:center}
.login-card input:focus{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,.15)}
.login-card button{width:100%;margin-top:16px;padding:12px;background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;border-radius:11px;font-weight:600;font-size:14px;transition:transform .15s}
.login-card button:hover:not(:disabled){transform:translateY(-1px)}
.login-card button:disabled{opacity:.5;cursor:not-allowed}
.err{color:#f87171;font-size:12.5px;margin-top:10px;text-align:center;min-height:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.stat{background:#13131a;border:1px solid #1e1e28;border-radius:14px;padding:16px 18px}
.stat-n{font-size:26px;font-weight:700;font-family:'JetBrains Mono',monospace;letter-spacing:-.02em}
.stat-l{font-size:11px;color:#8f8f9d;text-transform:uppercase;font-weight:700;letter-spacing:.5px;margin-top:2px}
.card{background:#13131a;border:1px solid #1e1e28;border-radius:16px;overflow:hidden}
.card-head{padding:16px 20px;border-bottom:1px solid #1e1e28;display:flex;align-items:center;justify-content:space-between}
.card-head h2{font-size:15px;font-weight:700}
.refresh{background:#1e1e28;border:1px solid #2a2a36;padding:6px 12px;border-radius:8px;font-size:12.5px;font-weight:600}
.refresh:hover{background:#2a2a36}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:12px 18px;font-size:11px;font-weight:700;color:#8f8f9d;text-transform:uppercase;letter-spacing:.5px;background:#0e0e14;border-bottom:1px solid #1e1e28}
td{padding:14px 18px;border-bottom:1px solid #13131a;font-size:13.5px}
tr:last-child td{border-bottom:none}
tr:hover td{background:#17171f}
.email{font-family:'JetBrains Mono',monospace;font-size:12.5px;color:#c8c8d2;word-break:break-all}
.name{color:#f4f4f8;font-weight:500}
.when{font-family:'JetBrains Mono',monospace;font-size:12px;color:#66667a}
.empty{padding:40px;text-align:center;color:#66667a;font-style:italic}
.tier-select{background:#0e0e14;border:1px solid #2a2a36;color:#f4f4f8;padding:7px 10px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;outline:none}
.tier-select:focus{border-color:#4f46e5}
.tier-select[data-tier="pro"]{color:#a5b4fc;border-color:rgba(99,102,241,.4)}
.tier-select[data-tier="ultimate"]{color:#c4b5fd;border-color:rgba(139,92,246,.4)}
.pill{display:inline-block;padding:3px 9px;border-radius:12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px}
.pill.free{background:#1e1e28;color:#8f8f9d}
.pill.pro{background:rgba(99,102,241,.15);color:#a5b4fc}
.pill.ultimate{background:rgba(139,92,246,.15);color:#c4b5fd}
.toast{position:fixed;bottom:20px;right:20px;background:#13131a;border:1px solid #2a2a36;color:#f4f4f8;padding:12px 18px;border-radius:11px;font-size:13px;font-weight:600;box-shadow:0 20px 60px -20px rgba(0,0,0,.6);opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s;pointer-events:none}
.toast.show{opacity:1;transform:none}
</style>
</head>
<body>

<div class="wrap" id="app"></div>
<div class="toast" id="toast"></div>

<script>
const root = document.getElementById('app');
const toastEl = document.getElementById('toast');
let toastTimer = null;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}

async function api(path, opts={}) {
  return fetch(path, {
    credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    ...opts,
  });
}

async function isAdmin() {
  try {
    const r = await api('/api/admin/status');
    const d = await r.json();
    return !!d.is_admin;
  } catch { return false; }
}

async function render() {
  const admin = await isAdmin();
  if (!admin) return renderLogin();
  renderDashboard();
}

function renderLogin() {
  root.innerHTML = `
    <div class="top">
      <div class="brand">
        <div class="brand-mark">M</div>
        <div class="brand-name">Mirox</div>
        <span class="badge">Admin</span>
      </div>
    </div>
    <div class="login-card">
      <h1>Admin access</h1>
      <p>Enter the admin password to continue.</p>
      <label>Password</label>
      <input id="pw" type="password" placeholder="••••" autofocus maxlength="32">
      <button id="loginBtn">Unlock</button>
      <div class="err" id="err"></div>
    </div>
  `;
  const pwEl  = document.getElementById('pw');
  const btnEl = document.getElementById('loginBtn');
  const errEl = document.getElementById('err');

  async function go() {
    const pw = pwEl.value.trim();
    if (!pw) return;
    btnEl.disabled = true;
    errEl.textContent = '';
    try {
      const r = await api('/api/admin/login', {
        method:'POST',
        body: JSON.stringify({password: pw}),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Failed');
      render();
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      btnEl.disabled = false;
    }
  }
  btnEl.addEventListener('click', go);
  pwEl.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

async function renderDashboard() {
  root.innerHTML = `
    <div class="top">
      <div class="brand">
        <div class="brand-mark">M</div>
        <div class="brand-name">Mirox</div>
        <span class="badge">Admin</span>
      </div>
      <button class="logout-btn" id="logoutBtn">Sign out</button>
    </div>
    <div class="stats" id="stats"></div>
    <div class="card">
      <div class="card-head">
        <h2>Users</h2>
        <button class="refresh" id="refreshBtn">Refresh</button>
      </div>
      <div id="tableBox"><div class="empty">Loading…</div></div>
    </div>
  `;
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api('/api/admin/logout', {method:'POST'});
    render();
  });
  document.getElementById('refreshBtn').addEventListener('click', loadUsers);
  await loadUsers();
}

async function loadUsers() {
  const box = document.getElementById('tableBox');
  const statsBox = document.getElementById('stats');
  try {
    const r = await api('/api/admin/users');
    const d = await r.json();
    const users = d.users || [];

    const counts = {free:0, pro:0, ultimate:0};
    users.forEach(u => counts[u.tier || 'free']++);
    statsBox.innerHTML = `
      <div class="stat"><div class="stat-n">${users.length}</div><div class="stat-l">Total users</div></div>
      <div class="stat"><div class="stat-n">${counts.free}</div><div class="stat-l">Free</div></div>
      <div class="stat"><div class="stat-n">${counts.pro}</div><div class="stat-l">Pro</div></div>
      <div class="stat"><div class="stat-n">${counts.ultimate}</div><div class="stat-l">Ultimate</div></div>
    `;

    if (!users.length) {
      box.innerHTML = '<div class="empty">No users yet. Sign in from the main app first.</div>';
      return;
    }

    const rows = users.map(u => {
      const tier = u.tier || 'free';
      const created = u.created_at ? new Date(u.created_at*1000).toLocaleString() : '—';
      return `
        <tr>
          <td class="email">${esc(u.email)}</td>
          <td class="name">${esc(u.name || '—')}</td>
          <td><span class="pill ${tier}">${esc(tier)}</span></td>
          <td class="when">${esc(created)}</td>
          <td>
            <select class="tier-select" data-email="${esc(u.email)}" data-tier="${tier}">
              <option value="free"     ${tier==='free'?'selected':''}>Free</option>
              <option value="pro"      ${tier==='pro'?'selected':''}>Pro</option>
              <option value="ultimate" ${tier==='ultimate'?'selected':''}>Ultimate</option>
            </select>
          </td>
        </tr>
      `;
    }).join('');

    box.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Tier</th>
            <th>Joined</th>
            <th>Change plan</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    box.querySelectorAll('.tier-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const email = sel.dataset.email;
        const tier  = sel.value;
        try {
          const r = await api('/api/admin/set-tier', {
            method:'POST',
            body: JSON.stringify({email, tier}),
          });
          const d = await r.json();
          if (!d.ok) throw new Error(d.error || 'Failed');
          toast(`Set ${email} → ${tier}`);
          loadUsers();
        } catch (e) {
          toast(e.message || 'Failed');
        }
      });
    });
  } catch (e) {
    box.innerHTML = '<div class="empty">Failed to load users.</div>';
  }
}

render();
</script>
</body>
</html>"""

@app.route("/admin/console")
def admin_console():
    return Response(ADMIN_HTML, mimetype="text/html")

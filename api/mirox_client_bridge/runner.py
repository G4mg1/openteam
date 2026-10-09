#!/usr/bin/env python3
"""
MiroxAI Bridge Client v5
- Reports the REAL home folder (no "." or "~" paths anywhere)
- Every path the AI sends is resolved to an absolute path under home
- Sudo (password kept in memory only), SMTP email, git, clipboard, screenshots
- KDE Connect endpoints via kdeconnect-cli (list, ping, ring, share, sms, lock, ...)
"""

import os
import re
import sys
import json
import time
import platform
import tempfile
import subprocess
import shutil
import smtplib
import ssl
import urllib.request
from pathlib import Path
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

try:
    from aiohttp import web
except ImportError:
    print("=" * 60)
    print("Missing dependency: aiohttp")
    print("Install it with:  pip install aiohttp")
    print("=" * 60)
    sys.exit(1)


# ---------------- Config ----------------
CONFIG_FILE = Path(__file__).resolve().parent / "config.json"
CONFIG = {}
if CONFIG_FILE.exists():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            CONFIG = json.load(f)
    except Exception as e:
        print(f"[Bridge] config.json unreadable ({e}), using defaults.")
        CONFIG = {}

CONFIG.setdefault("bridge_name", "My Laptop")
CONFIG.setdefault("port", 8765)
CONFIG.setdefault("allowed_dirs", ["~"])
CONFIG.setdefault("max_output_bytes", 200000)
CONFIG.setdefault("smtp", {})

PORT = int(CONFIG["port"])
NAME = CONFIG["bridge_name"]
MAX_OUTPUT = int(CONFIG["max_output_bytes"])
SMTP = CONFIG.get("smtp") or {}

IS_WINDOWS = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"
HOME = Path.home().resolve()


# ---------------- Allowed dirs ----------------
def _resolve(p):
    try:
        return Path(os.path.expanduser(str(p))).resolve()
    except Exception:
        return None


ALLOWED_DIRS = []
for d in (CONFIG.get("allowed_dirs") or ["~"]):
    r = _resolve(d)
    if r and r not in ALLOWED_DIRS:
        ALLOWED_DIRS.append(r)
# Home is always allowed, temp is allowed for scratch work. The runner's own folder is NOT.
for extra in (HOME, _resolve(tempfile.gettempdir())):
    if extra and extra not in ALLOWED_DIRS:
        ALLOWED_DIRS.append(extra)


def is_path_allowed(p: Path) -> bool:
    try:
        p = p.resolve()
    except Exception:
        return False
    for base in ALLOWED_DIRS:
        try:
            p.relative_to(base)
            return True
        except ValueError:
            continue
    return False


def to_abs(raw: str) -> str:
    """Turn '.', '~', './x', '~/x', or 'x' into an absolute path under HOME."""
    s = str(raw or "").strip().replace("\\", "/")
    if s in ("", "~", ".", "./"):
        return str(HOME)
    if s.startswith("~/"):
        return str(HOME / s[2:])
    if s.startswith("./"):
        return str(HOME / s[2:])
    if not s.startswith("/") and not re.match(r"^[A-Za-z]:/", s):
        return str(HOME / s)
    return s


def safe_path(raw: str):
    if not raw:
        return None
    p = Path(to_abs(raw))
    try:
        p = p.resolve()
    except Exception:
        return None
    return p if is_path_allowed(p) else None


def home_cwd(raw=None):
    p = safe_path(raw) if raw else None
    return p if (p and p.is_dir()) else HOME


# ---------------- CORS middleware ----------------
@web.middleware
async def cors_mw(request, handler):
    if request.method == "OPTIONS":
        resp = web.Response()
    else:
        try:
            resp = await handler(request)
        except web.HTTPException as e:
            resp = e
        except Exception as e:
            resp = web.json_response({"ok": False, "error": str(e)}, status=500)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Access-Control-Max-Age"] = "86400"
    return resp


async def body_json(req):
    try:
        data = await req.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return None


def _which(name):
    return shutil.which(name)


def _sudo_available():
    return bool(_which("sudo")) or IS_WINDOWS


# ---------------- Basic endpoints ----------------
async def ping(req):
    return web.json_response({
        "ok": True,
        "name": NAME,
        "cwd": str(HOME),
        "platform": platform.system(),
        "sudo_available": _sudo_available(),
        "time": time.time(),
    })


async def env_info(req):
    home = str(HOME)
    return web.json_response({
        "ok": True,
        "name": NAME,
        "user": HOME.name,
        "home": home,
        "cwd": home,
        "platform": platform.system(),
        "platform_release": platform.release(),
        "python": platform.python_version(),
        "allowed_dirs": [str(d) for d in ALLOWED_DIRS],
        "smtp_configured": bool(SMTP.get("host")),
        "sudo_available": _sudo_available(),
        "kde_connect_available": bool(_which("kdeconnect-cli")),
        "separator": os.sep,
        "time": time.time(),
    })


# ---------------- Command execution ----------------
def _run_command(cmd, cwd, timeout=120, stdin=None):
    try:
        proc = subprocess.run(
            cmd, shell=True, cwd=str(cwd),
            capture_output=True, text=True, timeout=timeout,
            input=stdin,
        )
        return True, proc.returncode, proc.stdout or "", proc.stderr or "", None
    except subprocess.TimeoutExpired:
        return False, -1, "", "", "Command timed out"
    except Exception as e:
        return False, -1, "", "", str(e)


def _looks_like_sudo(cmd):
    return bool(cmd) and bool(re.search(r"(?:^|[\s&|;])sudo(?:\s|$)", cmd))


def _strip_sudo(cmd):
    return re.sub(r"(?:^|[\s&|;])sudo\s+", lambda m: (m.group(0)[0] if m.group(0)[0] in "&|;" else ""), cmd, count=1).strip()


async def exec_cmd(req):
    data = await body_json(req)
    if data is None:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    cmd = str(data.get("command", "")).strip()
    if not cmd:
        return web.json_response({"ok": False, "error": "No command provided"})
    if _looks_like_sudo(cmd):
        return web.json_response({
            "ok": False, "needs_sudo": True,
            "command": _strip_sudo(cmd),
            "error": "This command needs sudo. Provide a password via /sudo-exec.",
        })
    cwd = home_cwd(data.get("cwd"))
    timeout = int(data.get("timeout", 120))
    ok, code, out, err, err2 = _run_command(cmd, cwd, timeout=timeout)
    if not ok:
        return web.json_response({"ok": False, "error": err2 or "failed"})
    return web.json_response({
        "ok": True, "exit_code": code,
        "stdout": out[:MAX_OUTPUT], "stderr": err[:MAX_OUTPUT],
        "cwd": str(cwd),
    })


async def sudo_exec(req):
    data = await body_json(req)
    if data is None:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    raw_cmd = str(data.get("command", "")).strip()
    password = str(data.get("password", ""))
    if not raw_cmd:
        return web.json_response({"ok": False, "error": "No command provided"})
    if not password:
        return web.json_response({"ok": False, "error": "No password provided"})
    if IS_WINDOWS:
        return web.json_response({
            "ok": False,
            "error": "sudo is not available on Windows. Run the bridge in an elevated terminal if you need admin.",
        })

    inner = _strip_sudo(raw_cmd) if _looks_like_sudo(raw_cmd) else raw_cmd
    cwd = home_cwd(data.get("cwd"))
    timeout = int(data.get("timeout", 120))
    try:
        proc = subprocess.run(
            ["sudo", "-S", "-p", "", "--", "sh", "-c", inner],
            cwd=str(cwd), capture_output=True, text=True,
            timeout=timeout, input=password + "\n",
        )
        out = proc.stdout or ""
        err = proc.stderr or ""
        low = err.lower()
        wrong = ("incorrect password" in low or "sorry, try again" in low or "authentication failure" in low)
        ok = proc.returncode == 0
        return web.json_response({
            "ok": ok,
            "exit_code": proc.returncode,
            "stdout": out[:MAX_OUTPUT],
            "stderr": err[:MAX_OUTPUT],
            "cwd": str(cwd),
            "wrong_password": wrong,
            "error": ("Wrong sudo password" if wrong and not ok else (None if ok else "sudo failed")),
        })
    except subprocess.TimeoutExpired:
        return web.json_response({"ok": False, "error": "Command timed out"})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# ---------------- File operations ----------------
async def write_file(req):
    data = await body_json(req)
    if data is None:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    p = safe_path(data.get("path", ""))
    if not p:
        return web.json_response({"ok": False, "error": "Path not allowed", "allowed_dirs": [str(d) for d in ALLOWED_DIRS]})
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        content = str(data.get("content", ""))
        p.write_text(content, encoding="utf-8")
        return web.json_response({"ok": True, "path": str(p), "bytes": len(content.encode("utf-8"))})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def append_file(req):
    data = await body_json(req)
    if data is None:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    p = safe_path(data.get("path", ""))
    if not p:
        return web.json_response({"ok": False, "error": "Path not allowed"})
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(str(data.get("content", "")))
        return web.json_response({"ok": True, "path": str(p)})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def read_file(req):
    data = await body_json(req)
    if data is None:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    p = safe_path(data.get("path", ""))
    if not p or not p.exists():
        return web.json_response({"ok": False, "error": "File not found", "path": to_abs(data.get("path", ""))})
    if p.is_dir():
        return web.json_response({"ok": False, "error": "Is a directory", "path": str(p)})
    try:
        return web.json_response({
            "ok": True, "path": str(p),
            "content": p.read_text(encoding="utf-8", errors="replace")[:MAX_OUTPUT],
        })
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def list_dir(req):
    data = await body_json(req) or {}
    p = safe_path(data.get("path", str(HOME)))
    if not p or not p.is_dir():
        return web.json_response({"ok": False, "error": "Not a directory"})
    try:
        items = [{
            "name": c.name,
            "is_dir": c.is_dir(),
            "size": c.stat().st_size if c.is_file() else 0,
        } for c in sorted(p.iterdir())]
        return web.json_response({"ok": True, "path": str(p), "items": items[:500]})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def delete_path(req):
    data = await body_json(req)
    if data is None:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    p = safe_path(data.get("path", ""))
    if not p or not p.exists():
        return web.json_response({"ok": False, "error": "Not found"})
    if p == HOME:
        return web.json_response({"ok": False, "error": "Refusing to delete the home folder"})
    try:
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
        return web.json_response({"ok": True, "path": str(p)})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def move_path(req):
    data = await body_json(req)
    if data is None:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    a = safe_path(data.get("from", ""))
    b = safe_path(data.get("to", ""))
    if not a or not b:
        return web.json_response({"ok": False, "error": "Path not allowed"})
    try:
        b.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(a), str(b))
        return web.json_response({"ok": True, "from": str(a), "to": str(b)})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def copy_path(req):
    data = await body_json(req)
    if data is None:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    a = safe_path(data.get("from", ""))
    b = safe_path(data.get("to", ""))
    if not a or not b:
        return web.json_response({"ok": False, "error": "Path not allowed"})
    try:
        b.parent.mkdir(parents=True, exist_ok=True)
        if a.is_dir():
            shutil.copytree(str(a), str(b), dirs_exist_ok=True)
        else:
            shutil.copy2(str(a), str(b))
        return web.json_response({"ok": True, "from": str(a), "to": str(b)})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# ---------------- System info ----------------
async def sysinfo(req):
    try:
        info = {
            "platform": platform.system(), "release": platform.release(),
            "version": platform.version(), "machine": platform.machine(),
            "python": platform.python_version(),
            "cpu_count": os.cpu_count(), "home": str(HOME),
        }
        try:
            total, used, free = shutil.disk_usage(str(HOME))
            info["disk"] = {
                "total_gb": round(total / 1e9, 2),
                "used_gb": round(used / 1e9, 2),
                "free_gb": round(free / 1e9, 2),
            }
        except Exception:
            pass
        try:
            p = subprocess.run("node --version", shell=True, capture_output=True, text=True, timeout=5)
            info["node"] = p.stdout.strip()
        except Exception:
            pass
        return web.json_response({"ok": True, **info})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def syscheck(req):
    checks = {}
    try:
        total, used, free = shutil.disk_usage(str(HOME))
        pct = (used / total) * 100 if total else 0
        checks["disk"] = {"ok": pct < 90, "used_pct": round(pct, 1), "free_gb": round(free / 1e9, 2)}
    except Exception as e:
        checks["disk"] = {"ok": False, "error": str(e)}
    checks["python"] = {"ok": True, "version": platform.python_version()}
    checks["cpu"] = {"ok": (os.cpu_count() or 0) >= 2, "count": os.cpu_count()}
    try:
        tf = HOME / ".mirox_write_test"
        tf.write_text("ok")
        tf.unlink()
        checks["home_writable"] = {"ok": True}
    except Exception as e:
        checks["home_writable"] = {"ok": False, "error": str(e)}
    try:
        p = subprocess.run("node --version", shell=True, capture_output=True, text=True, timeout=5)
        checks["node"] = {"ok": p.returncode == 0, "version": p.stdout.strip()}
    except Exception:
        checks["node"] = {"ok": False, "version": ""}
    overall = all(c.get("ok") for c in checks.values() if isinstance(c, dict))
    return web.json_response({"ok": True, "check": checks, "healthy": overall})


async def processes(req):
    try:
        cmd = "ps aux --sort=-%cpu | head -n 16" if not IS_WINDOWS else "tasklist"
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=8)
        return web.json_response({"ok": True, "raw": p.stdout[:MAX_OUTPUT]})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# ---------------- Email / HTTP ----------------
async def send_email(req):
    data = await body_json(req)
    if data is None:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    if not SMTP.get("host"):
        return web.json_response({"ok": False, "error": "SMTP not configured in config.json"})
    to = str(data.get("to", "")).strip()
    subject = str(data.get("subject", "")).strip() or "(no subject)"
    body = str(data.get("body", ""))
    if not to or "@" not in to:
        return web.json_response({"ok": False, "error": "Invalid recipient"})
    try:
        msg = MIMEMultipart()
        msg["From"] = SMTP.get("from") or SMTP.get("user")
        msg["To"] = to
        msg["Subject"] = subject
        msg.attach(MIMEText(body, "plain", "utf-8"))
        ctx = ssl.create_default_context()
        port = int(SMTP.get("port", 587))
        if SMTP.get("use_tls", True):
            with smtplib.SMTP(SMTP["host"], port, timeout=20) as s:
                s.starttls(context=ctx)
                s.login(SMTP.get("user"), SMTP.get("pass"))
                s.send_message(msg)
        else:
            with smtplib.SMTP_SSL(SMTP["host"], port, timeout=20, context=ctx) as s:
                s.login(SMTP.get("user"), SMTP.get("pass"))
                s.send_message(msg)
        return web.json_response({"ok": True, "sent_to": to, "subject": subject})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def http_call(req):
    data = await body_json(req)
    if data is None:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    url = str(data.get("url", "")).strip()
    method = str(data.get("method", "GET")).upper()
    body = data.get("body") or None
    if not url:
        return web.json_response({"ok": False, "error": "No url"})
    if not (url.startswith("http://") or url.startswith("https://")):
        return web.json_response({"ok": False, "error": "Only http(s) allowed"})
    try:
        r2 = urllib.request.Request(url, method=method, data=(str(body).encode() if body else None))
        r2.add_header("User-Agent", "MiroxBridge/5.0")
        if body:
            r2.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(r2, timeout=20) as r:
            raw = r.read()[:MAX_OUTPUT]
            return web.json_response({"ok": True, "status": r.status, "body": raw.decode("utf-8", errors="replace")})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# ---------------- Clipboard / screenshot ----------------
async def clipboard(req):
    data = await body_json(req)
    if data is None:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    action = data.get("action", "get")
    content = str(data.get("content", ""))
    try:
        import pyperclip
        if action == "set":
            pyperclip.copy(content)
            return web.json_response({"ok": True})
        return web.json_response({"ok": True, "content": pyperclip.paste()})
    except ImportError:
        pass
    try:
        if IS_MAC:
            if action == "set":
                subprocess.run("pbcopy", input=content, text=True)
                return web.json_response({"ok": True})
            p = subprocess.run("pbpaste", capture_output=True, text=True)
            return web.json_response({"ok": True, "content": p.stdout})
        if IS_WINDOWS:
            if action == "set":
                subprocess.run("clip", input=content, text=True)
                return web.json_response({"ok": True})
            p = subprocess.run(["powershell", "-command", "Get-Clipboard"], capture_output=True, text=True)
            return web.json_response({"ok": True, "content": p.stdout})
        if action == "set":
            subprocess.run(["xclip", "-selection", "clipboard"], input=content, text=True)
            return web.json_response({"ok": True})
        p = subprocess.run(["xclip", "-selection", "clipboard", "-o"], capture_output=True, text=True)
        return web.json_response({"ok": True, "content": p.stdout})
    except Exception as e:
        return web.json_response({"ok": False, "error": "clipboard unavailable: " + str(e)})


async def screenshot(req):
    data = await body_json(req) or {}
    p = safe_path(data.get("path", "")) or (HOME / "mirox_screenshot.png")
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import ImageGrab
        ImageGrab.grab().save(str(p))
        return web.json_response({"ok": True, "path": str(p)})
    except ImportError:
        if IS_MAC:
            r = subprocess.run(["screencapture", "-x", str(p)], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                return web.json_response({"ok": True, "path": str(p)})
            return web.json_response({"ok": False, "error": r.stderr})
        return web.json_response({"ok": False, "error": "pip install pillow for screenshots"})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# ---------------- Git / packages ----------------
GIT_COMMANDS = {
    "status": "git status",
    "log": "git log --oneline -n 20",
    "branch": "git branch -a",
    "diff": "git diff",
    "add-all": "git add -A",
    "pull": "git pull",
    "push": "git push",
    "remote": "git remote -v",
}


async def git_op(req):
    data = await body_json(req)
    if data is None:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    action = str(data.get("action", "status"))
    cwd = home_cwd(data.get("cwd"))
    msg = str(data.get("message", ""))
    if action == "commit":
        if not msg:
            return web.json_response({"ok": False, "error": "message required"})
        args = ["git", "commit", "-m", msg]
    elif action in GIT_COMMANDS:
        args = GIT_COMMANDS[action].split()
    else:
        return web.json_response({"ok": False, "error": "unknown action"})
    try:
        p = subprocess.run(args, cwd=str(cwd), capture_output=True, text=True, timeout=60)
        return web.json_response({
            "ok": p.returncode == 0,
            "stdout": p.stdout[:MAX_OUTPUT],
            "stderr": p.stderr[:MAX_OUTPUT],
        })
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


PKG_COMMANDS = {
    "pip": ["pip", "list"],
    "npm": ["npm", "list", "--depth=0"],
    "pip-freeze": ["pip", "freeze"],
}


async def pkgs(req):
    data = await body_json(req) or {}
    t = str(data.get("type", "pip"))
    if t not in PKG_COMMANDS:
        return web.json_response({"ok": False, "error": "unknown type"})
    cwd = home_cwd(data.get("cwd"))
    try:
        p = subprocess.run(PKG_COMMANDS[t], cwd=str(cwd), capture_output=True, text=True, timeout=30)
        return web.json_response({"ok": p.returncode == 0, "raw": p.stdout[:MAX_OUTPUT]})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# ---------------- KDE Connect ----------------
def _kde(args, timeout=20):
    """Run kdeconnect-cli with a list of args. Returns (ok, stdout, stderr)."""
    if not _which("kdeconnect-cli"):
        return False, "", "kdeconnect-cli not installed"
    try:
        p = subprocess.run(["kdeconnect-cli"] + args, capture_output=True, text=True, timeout=timeout)
        return p.returncode == 0, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return False, "", "kdeconnect-cli timed out"
    except Exception as e:
        return False, "", str(e)


_DEVICE_RE = re.compile(r"^-\s*(.+?):\s*(.+?)\s*\(([^)]*)\)(.*)$")


def _parse_devices(stdout):
    """Parse `kdeconnect-cli -a` / `-l` output into [{id, name, reachable, paired}]."""
    devices = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("-"):
            continue
        m = _DEVICE_RE.match(line)
        if not m:
            continue
        dev_id, name, state, rest = m.group(1).strip(), m.group(2).strip(), m.group(3).strip(), m.group(4)
        devices.append({
            "id": dev_id,
            "name": name,
            "reachable": "reachable" in state.lower() and "unreachable" not in state.lower(),
            "paired": "paired" in rest.lower() or "paired" in state.lower(),
        })
    return devices


async def kde_refresh(req):
    ok, _, err = _kde(["--refresh"])
    return web.json_response({"ok": ok, "error": None if ok else err})


async def kde_list(req):
    data = await body_json(req) or {}
    if not _which("kdeconnect-cli"):
        return web.json_response({"ok": False, "installed": False, "devices": [], "error": "kdeconnect-cli not installed"})
    args = ["-a", "--id-name-only"] if data.get("available") else ["-l", "--id-name-only"]
    ok, out, err = _kde(args)
    devices = []
    for line in out.splitlines():
        parts = line.strip().split(" ", 1)
        if len(parts) == 2 and parts[0]:
            devices.append({"id": parts[0], "name": parts[1], "reachable": bool(data.get("available")), "paired": True})
    if not devices and ok:
        ok2, out2, _ = _kde(["-a"])
        devices = _parse_devices(out2)
    return web.json_response({"ok": ok, "installed": True, "devices": devices, "error": None if ok else err})


async def kde_my_id(req):
    ok, out, err = _kde(["-i"])
    return web.json_response({"ok": ok, "id": out.strip(), "error": None if ok else err})


async def kde_ping(req):
    data = await body_json(req) or {}
    dev = str(data.get("device", ""))
    msg = str(data.get("message", "")).strip()
    if not dev:
        return web.json_response({"ok": False, "error": "device required"})
    args = ["-d", dev, "--ping-msg", msg] if msg else ["-d", dev, "--ping"]
    ok, _, err = _kde(args)
    return web.json_response({"ok": ok, "online": ok, "device": {"id": dev}, "error": None if ok else err})


async def kde_ring(req):
    data = await body_json(req) or {}
    dev = str(data.get("device", ""))
    ok, _, err = _kde(["-d", dev, "--ring"])
    return web.json_response({"ok": ok, "error": None if ok else err})


async def kde_share(req):
    data = await body_json(req) or {}
    dev = str(data.get("device", ""))
    p = safe_path(str(data.get("path", "")))
    if not dev or not p or not p.exists():
        return web.json_response({"ok": False, "error": "device and an existing allowed path are required"})
    send = p
    was_dir = False
    if p.is_dir():
        was_dir = True
        archive_base = str(tempfile.mkdtemp(prefix="mirox_"))
        send = Path(shutil.make_archive(os.path.join(archive_base, p.name), "zip", root_dir=str(p.parent), base_dir=p.name))
    ok, _, err = _kde(["-d", dev, "--share", str(send)], timeout=120)
    return web.json_response({"ok": ok, "device": {"id": dev}, "was_dir": was_dir, "error": None if ok else err})


async def kde_share_text(req):
    data = await body_json(req) or {}
    dev = str(data.get("device", ""))
    text = str(data.get("text", ""))
    if not dev:
        return web.json_response({"ok": False, "error": "device required"})
    ok, _, err = _kde(["-d", dev, "--share-text", text])
    return web.json_response({"ok": ok, "error": None if ok else err})


async def kde_sms(req):
    data = await body_json(req) or {}
    dev = str(data.get("device", ""))
    number = str(data.get("number", ""))
    message = str(data.get("message", ""))
    if not dev or not number:
        return web.json_response({"ok": False, "error": "device and number required"})
    ok, _, err = _kde(["-d", dev, "--send-sms", message, "--destination", number])
    return web.json_response({"ok": ok, "error": None if ok else err})


async def kde_lock(req):
    data = await body_json(req) or {}
    dev = str(data.get("device", ""))
    ok, _, err = _kde(["-d", dev, "--lock"])
    return web.json_response({"ok": ok, "error": None if ok else err})


async def kde_notifications(req):
    data = await body_json(req) or {}
    dev = str(data.get("device", ""))
    ok, out, err = _kde(["-d", dev, "--list-notifications"])
    return web.json_response({"ok": ok, "raw": out[:MAX_OUTPUT], "error": None if ok else err})


async def kde_plugins(req):
    data = await body_json(req) or {}
    dev = str(data.get("device", ""))
    ok, out, err = _kde(["-d", dev, "--list-available"])
    return web.json_response({"ok": ok, "raw": out[:MAX_OUTPUT], "error": None if ok else err})


async def kde_photo(req):
    data = await body_json(req) or {}
    dev = str(data.get("device", ""))
    dest = safe_path(str(data.get("path", ""))) or (HOME / "mirox_photo.jpg")
    dest.parent.mkdir(parents=True, exist_ok=True)
    ok, _, err = _kde(["-d", dev, "--get-photo", str(dest)], timeout=60)
    return web.json_response({"ok": ok, "path": str(dest), "error": None if ok else err})


# ---------------- App ----------------
def build_app():
    app = web.Application(middlewares=[cors_mw])

    routes = [
        ("/ping", "GET", ping),
        ("/env", "GET", env_info),
        ("/exec", "POST", exec_cmd),
        ("/sudo-exec", "POST", sudo_exec),
        ("/write", "POST", write_file),
        ("/append", "POST", append_file),
        ("/read", "POST", read_file),
        ("/list", "POST", list_dir),
        ("/delete", "POST", delete_path),
        ("/move", "POST", move_path),
        ("/copy", "POST", copy_path),
        ("/sysinfo", "POST", sysinfo),
        ("/syscheck", "POST", syscheck),
        ("/processes", "POST", processes),
        ("/email", "POST", send_email),
        ("/http", "POST", http_call),
        ("/clipboard", "POST", clipboard),
        ("/screenshot", "POST", screenshot),
        ("/git", "POST", git_op),
        ("/pkgs", "POST", pkgs),
        ("/kde/refresh", "POST", kde_refresh),
        ("/kde/list", "POST", kde_list),
        ("/kde/my-id", "POST", kde_my_id),
        ("/kde/ping", "POST", kde_ping),
        ("/kde/ring", "POST", kde_ring),
        ("/kde/share", "POST", kde_share),
        ("/kde/share-text", "POST", kde_share_text),
        ("/kde/sms", "POST", kde_sms),
        ("/kde/lock", "POST", kde_lock),
        ("/kde/notifications", "POST", kde_notifications),
        ("/kde/plugins", "POST", kde_plugins),
        ("/kde/photo", "POST", kde_photo),
    ]
    for route, method, handler in routes:
        app.router.add_route(method, route, handler)
        app.router.add_route("OPTIONS", route, lambda r: web.Response())
    return app


if __name__ == "__main__":
    print("=" * 60)
    print(f"[Bridge] {NAME} on http://127.0.0.1:{PORT}")
    print(f"[Bridge] Home: {HOME}")
    print(f"[Bridge] Platform: {platform.system()} {platform.release()}")
    for d in ALLOWED_DIRS:
        print(f"[Bridge]   allowed: {d}")
    print(f"[Bridge] SMTP configured: {bool(SMTP.get('host'))}")
    print(f"[Bridge] Sudo available: {_sudo_available()}")
    print(f"[Bridge] KDE Connect: {bool(_which('kdeconnect-cli'))}")
    print("=" * 60)
    try:
        web.run_app(build_app(), host="127.0.0.1", port=PORT, print=None, access_log=None)
    except KeyboardInterrupt:
        print("\n[Bridge] Stopped.")
    except OSError as e:
        print(f"[Bridge] Failed to start: {e}")
        sys.exit(1)

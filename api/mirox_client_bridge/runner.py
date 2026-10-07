#!/usr/bin/env python3
"""
MiroxAI Bridge Client v4
- Fixed aiohttp middleware signature
- Sudo support (/sudo-exec, password kept in memory only)
- SMTP email support
- Full file / system / git / clipboard / screenshot endpoints
"""

import os
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
CONFIG_FILE = Path(__file__).parent / "config.json"
if CONFIG_FILE.exists():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            CONFIG = json.load(f)
    except Exception as e:
        print(f"[Bridge] config.json unreadable ({e}), using defaults.")
        CONFIG = {}
else:
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


# ---------------- Allowed dirs ----------------
def _resolve(p):
    try:
        return Path(p).expanduser().resolve()
    except Exception:
        return None


raw_dirs = [d for d in (CONFIG.get("allowed_dirs") or ["~"]) if d and d != "."]
ALLOWED_DIRS = [r for r in (_resolve(d) for d in raw_dirs) if r]
for extra in (_resolve("~"), _resolve("."), _resolve(tempfile.gettempdir())):
    if extra and extra not in ALLOWED_DIRS:
        ALLOWED_DIRS.append(extra)


def is_path_allowed(p: Path) -> bool:
    try:
        p = p.expanduser().resolve()
    except Exception:
        return False
    for base in ALLOWED_DIRS:
        try:
            p.relative_to(base)
            return True
        except ValueError:
            continue
    return False


def safe_path(raw: str):
    if not raw:
        return None
    p = Path(raw).expanduser()
    if not p.is_absolute():
        p = Path.home() / p
    try:
        p = p.resolve()
    except Exception:
        return None
    return p if is_path_allowed(p) else None


# ---------------- CORS middleware (aiohttp 3.10+ compatible) ----------------
@web.middleware
async def cors_mw(request, handler, **kwargs):
    if handler is None:
        handler = kwargs.get("handler")
    if request is None:
        request = kwargs.get("request")

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


# ---------------- Endpoints ----------------
async def ping(req):
    return web.json_response({
        "ok": True,
        "name": NAME,
        "cwd": os.getcwd(),
        "platform": platform.system(),
        "sudo_available": bool(shutil.which("sudo")) or IS_WINDOWS,
        "time": time.time(),
    })


async def env_info(req):
    return web.json_response({
        "ok": True, "name": NAME,
        "home": str(Path.home()), "cwd": os.getcwd(),
        "platform": platform.system(), "platform_release": platform.release(),
        "python": platform.python_version(),
        "allowed_dirs": [str(d) for d in ALLOWED_DIRS],
        "smtp_configured": bool(SMTP.get("host")),
        "sudo_available": bool(shutil.which("sudo")) or IS_WINDOWS,
        "separator": os.sep,
        "time": time.time(),
    })


def _run_command(cmd, cwd, timeout=120, env=None, stdin=None):
    """Run a shell command; return (ok, exit_code, stdout, stderr, error)."""
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            input=stdin if stdin is not None else None,
        )
        return (True, proc.returncode, proc.stdout or "", proc.stderr or "", None)
    except subprocess.TimeoutExpired:
        return (False, -1, "", "", "Command timed out")
    except Exception as e:
        return (False, -1, "", "", str(e))


async def exec_cmd(req):
    try:
        data = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    cmd = str(data.get("command", "")).strip()
    if not cmd:
        return web.json_response({"ok": False, "error": "No command provided"})

    # Refuse sudo commands here — they must go through /sudo-exec so we can
    # prompt the user for their password.
    if _looks_like_sudo(cmd):
        return web.json_response({
            "ok": False,
            "needs_sudo": True,
            "command": _strip_sudo(cmd),
            "error": "This command needs sudo. Provide a password via /sudo-exec.",
        })

    cwd = safe_path(data.get("cwd") or str(Path.home())) or Path.home()
    timeout = int(data.get("timeout", 120))
    ok, code, out, err, err2 = _run_command(cmd, cwd, timeout=timeout)
    if not ok:
        return web.json_response({"ok": False, "error": err2 or "failed"})
    return web.json_response({
        "ok": True, "exit_code": code,
        "stdout": out[:MAX_OUTPUT], "stderr": err[:MAX_OUTPUT],
        "cwd": str(cwd),
    })


def _looks_like_sudo(cmd):
    if not cmd:
        return False
    # match "sudo" as its own word at start or after a shell separator
    import re
    return bool(re.search(r"(?:^|[\s&|;])sudo(?:\s|$)", cmd))


def _strip_sudo(cmd):
    import re
    return re.sub(r"(?:^|[\s&|;])sudo\s+", lambda m: (m.group(0)[0] if m.group(0)[0] in "&|;" else ""), cmd, count=1).strip()


async def sudo_exec(req):
    """Run a command via sudo. The password is used once and NOT stored."""
    try:
        data = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"})

    raw_cmd = str(data.get("command", "")).strip()
    password = str(data.get("password", ""))
    if not raw_cmd:
        return web.json_response({"ok": False, "error": "No command provided"})
    if not password:
        return web.json_response({"ok": False, "error": "No password provided"})

    # Remove leading "sudo " if present so we don't double-wrap
    inner = raw_cmd
    if _looks_like_sudo(inner):
        inner = _strip_sudo(inner)

    cwd = safe_path(data.get("cwd") or str(Path.home())) or Path.home()
    timeout = int(data.get("timeout", 120))

    if IS_WINDOWS:
        # Windows: use runas is interactive; we cannot pipe password safely.
        # Return a clear message.
        return web.json_response({
            "ok": False,
            "error": "sudo is not available on Windows. Run the bridge in an elevated terminal if you need admin."
        })

    # Use sudo -S with empty prompt so it reads from stdin
    full = ["sudo", "-S", "-p", "", "--"] + [inner]
    try:
        proc = subprocess.run(
            full,
            shell=False,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            input=password + "\n",
        )
        out = proc.stdout or ""
        err = proc.stderr or ""
        # Clean the [sudo] password prompt line if it appears
        err = err.replace("[sudo] password for", "").strip() if err.startswith("[sudo]") else err
        ok = (proc.returncode == 0)
        # Detect wrong password
        wrong = (
            "incorrect password" in err.lower()
            or "sorry, try again" in err.lower()
            or "authentication failure" in err.lower()
        )
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


async def write_file(req):
    try:
        data = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    p = safe_path(data.get("path", ""))
    if not p:
        return web.json_response({
            "ok": False, "error": "Path not allowed",
            "allowed_dirs": [str(d) for d in ALLOWED_DIRS],
        })
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        content = data.get("content", "")
        p.write_text(content, encoding="utf-8")
        return web.json_response({"ok": True, "path": str(p), "bytes": len(content)})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def append_file(req):
    try:
        data = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    p = safe_path(data.get("path", ""))
    if not p:
        return web.json_response({"ok": False, "error": "Path not allowed"})
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(data.get("content", ""))
        return web.json_response({"ok": True, "path": str(p)})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def read_file(req):
    try:
        data = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    p = safe_path(data.get("path", ""))
    if not p or not p.exists():
        return web.json_response({"ok": False, "error": "File not found"})
    try:
        return web.json_response({
            "ok": True, "path": str(p),
            "content": p.read_text(encoding="utf-8", errors="replace")[:MAX_OUTPUT],
        })
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def list_dir(req):
    try:
        data = await req.json()
    except Exception:
        data = {}
    p = safe_path(data.get("path", str(Path.home())))
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
    try:
        data = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    p = safe_path(data.get("path", ""))
    if not p or not p.exists():
        return web.json_response({"ok": False, "error": "Not found"})
    try:
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
        return web.json_response({"ok": True, "path": str(p)})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def move_path(req):
    try:
        data = await req.json()
    except Exception:
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
    try:
        data = await req.json()
    except Exception:
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


async def sysinfo(req):
    try:
        info = {
            "platform": platform.system(), "release": platform.release(),
            "version": platform.version(), "machine": platform.machine(),
            "python": platform.python_version(),
            "cpu_count": os.cpu_count(), "home": str(Path.home()),
        }
        try:
            total, used, free = shutil.disk_usage(str(Path.home()))
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
    try:
        checks = {}
        try:
            total, used, free = shutil.disk_usage(str(Path.home()))
            pct = (used / total) * 100 if total else 0
            checks["disk"] = {"ok": pct < 90, "used_pct": round(pct, 1), "free_gb": round(free / 1e9, 2)}
        except Exception as e:
            checks["disk"] = {"ok": False, "error": str(e)}
        checks["python"] = {"ok": True, "version": platform.python_version()}
        checks["cpu"] = {"ok": (os.cpu_count() or 0) >= 2, "count": os.cpu_count()}
        try:
            tf = Path.home() / ".mirox_write_test"
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
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def processes(req):
    try:
        cmd = "ps aux --sort=-%cpu | head -n 16" if not IS_WINDOWS else "tasklist"
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=8)
        return web.json_response({"ok": True, "raw": p.stdout[:MAX_OUTPUT]})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def send_email(req):
    try:
        data = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    if not SMTP.get("host"):
        return web.json_response({"ok": False, "error": "SMTP not configured. Run smtp_setup.py."})
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
    try:
        data = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    url = str(data.get("url", "")).strip()
    method = str(data.get("method", "GET")).upper()
    body = data.get("body") or None
    if not url:
        return web.json_response({"ok": False, "error": "No url"})
    if not (url.startswith("http://") or url.startswith("https://")):
        return web.json_response({"ok": False, "error": "Only http(s) allowed"})
    try:
        req2 = urllib.request.Request(url, method=method, data=(body.encode() if body else None))
        req2.add_header("User-Agent", "MiroxBridge/4.0")
        if body:
            req2.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req2, timeout=20) as r:
            raw = r.read()[:MAX_OUTPUT]
            text = raw.decode("utf-8", errors="replace")
            return web.json_response({"ok": True, "status": r.status, "body": text})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def clipboard(req):
    try:
        data = await req.json()
    except Exception:
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
                subprocess.run("pbcopy", shell=True, input=content, text=True)
                return web.json_response({"ok": True})
            p = subprocess.run("pbpaste", shell=True, capture_output=True, text=True)
            return web.json_response({"ok": True, "content": p.stdout})
        if IS_WINDOWS:
            if action == "set":
                subprocess.run("clip", shell=True, input=content, text=True)
                return web.json_response({"ok": True})
            p = subprocess.run("powershell Get-Clipboard", shell=True, capture_output=True, text=True)
            return web.json_response({"ok": True, "content": p.stdout})
        if action == "set":
            subprocess.run("xclip -selection clipboard", shell=True, input=content, text=True)
            return web.json_response({"ok": True})
        p = subprocess.run("xclip -selection clipboard -o", shell=True, capture_output=True, text=True)
        return web.json_response({"ok": True, "content": p.stdout})
    except Exception as e:
        return web.json_response({"ok": False, "error": "clipboard unavailable: " + str(e)})


async def screenshot(req):
    try:
        data = await req.json()
    except Exception:
        data = {}
    raw = data.get("path", "") or str(Path.home() / "mirox_screenshot.png")
    p = safe_path(raw) or (Path.home() / "mirox_screenshot.png")
    try:
        from PIL import ImageGrab
        img = ImageGrab.grab()
        p.parent.mkdir(parents=True, exist_ok=True)
        img.save(str(p))
        return web.json_response({"ok": True, "path": str(p)})
    except ImportError:
        try:
            if IS_MAC:
                p.parent.mkdir(parents=True, exist_ok=True)
                r = subprocess.run(f"screencapture -x {str(p)}", shell=True,
                                   capture_output=True, text=True, timeout=15)
                if r.returncode == 0:
                    return web.json_response({"ok": True, "path": str(p)})
                return web.json_response({"ok": False, "error": r.stderr})
            return web.json_response({"ok": False, "error": "pip install pillow for screenshots"})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def git_op(req):
    try:
        data = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"})
    action = data.get("action", "status")
    cwd = safe_path(data.get("cwd") or str(Path.home())) or Path.home()
    msg = data.get("message", "")
    if action == "status": cmd = "git status"
    elif action == "log": cmd = "git log --oneline -n 20"
    elif action == "branch": cmd = "git branch -a"
    elif action == "diff": cmd = "git diff"
    elif action == "add-all": cmd = "git add -A"
    elif action == "commit":
        if not msg:
            return web.json_response({"ok": False, "error": "message required"})
        cmd = f'git commit -m "{msg}"'
    elif action == "pull": cmd = "git pull"
    elif action == "push": cmd = "git push"
    elif action == "remote": cmd = "git remote -v"
    else:
        return web.json_response({"ok": False, "error": "unknown action"})
    try:
        p = subprocess.run(cmd, shell=True, cwd=str(cwd),
                           capture_output=True, text=True, timeout=60)
        return web.json_response({
            "ok": p.returncode == 0,
            "stdout": p.stdout[:MAX_OUTPUT],
            "stderr": p.stderr[:MAX_OUTPUT],
        })
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def pkgs(req):
    try:
        data = await req.json()
    except Exception:
        data = {}
    t = data.get("type", "pip")
    cwd = safe_path(data.get("cwd") or str(Path.home())) or Path.home()
    if t == "pip": cmd = "pip list"
    elif t == "npm": cmd = "npm list --depth=0"
    elif t == "pip-freeze": cmd = "pip freeze"
    else:
        return web.json_response({"ok": False, "error": "unknown type"})
    try:
        p = subprocess.run(cmd, shell=True, cwd=str(cwd),
                           capture_output=True, text=True, timeout=30)
        return web.json_response({"ok": p.returncode == 0, "raw": p.stdout[:MAX_OUTPUT]})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# ---------------- App ----------------
def build_app():
    app = web.Application(middlewares=[cors_mw])

    def add(route, method, handler):
        app.router.add_route(method, route, handler)
        app.router.add_route("OPTIONS", route, lambda r: web.Response())

    add("/ping", "GET", ping)
    add("/env", "GET", env_info)
    add("/exec", "POST", exec_cmd)
    add("/sudo-exec", "POST", sudo_exec)
    add("/write", "POST", write_file)
    add("/append", "POST", append_file)
    add("/read", "POST", read_file)
    add("/list", "POST", list_dir)
    add("/delete", "POST", delete_path)
    add("/move", "POST", move_path)
    add("/copy", "POST", copy_path)
    add("/sysinfo", "POST", sysinfo)
    add("/syscheck", "POST", syscheck)
    add("/processes", "POST", processes)
    add("/email", "POST", send_email)
    add("/http", "POST", http_call)
    add("/clipboard", "POST", clipboard)
    add("/screenshot", "POST", screenshot)
    add("/git", "POST", git_op)
    add("/pkgs", "POST", pkgs)
    return app


if __name__ == "__main__":
    print("=" * 60)
    print(f"[Bridge] {NAME} on http://127.0.0.1:{PORT}")
    print(f"[Bridge] Home: {Path.home()}")
    print(f"[Bridge] Platform: {platform.system()} {platform.release()}")
    for d in ALLOWED_DIRS:
        print(f"[Bridge]   allowed: {d}")
    print(f"[Bridge] SMTP configured: {bool(SMTP.get('host'))}")
    print(f"[Bridge] Sudo available: {bool(shutil.which('sudo')) or IS_WINDOWS}")
    print("=" * 60)
    try:
        web.run_app(build_app(), host="127.0.0.1", port=PORT, print=None, access_log=None)
    except KeyboardInterrupt:
        print("\n[Bridge] Stopped.")
    except OSError as e:
        print(f"[Bridge] Failed to start: {e}")
        sys.exit(1)

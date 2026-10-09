#!/usr/bin/env python3
"""
MiroxAI Bridge Client v5

Changes from v4:
- Every path is normalised to a REAL absolute path. "." and "~" resolve to the
  home folder, and every response returns the absolute path (path / cwd / home),
  so the AI never has to echo "." or "~" back.
- New /resolve endpoint: ask the bridge what a path really is.
- Security: requests from a foreign Origin are rejected, so a random website can
  no longer run shell commands on this machine through the browser. An optional
  token can be set in config.json ("token") and sent as X-Mirox-Token.
- sudo runs `sudo -S sh -c "<cmd>"`. The old code passed one string as the
  program name, so sudo always failed.
- git commit messages are passed as argv, not spliced into a shell string.
- Commands run through bash when available, so cd, ~ and pipes work.
- Larger request bodies (client_max_size) so big files can be written.
- Screenshot paths are quoted and Linux screenshot tools are supported.
- HTTP errors return the status code and body.
- The home folder and allowed roots cannot be deleted.
"""

import getpass
import json
import os
import platform
import re
import shutil
import smtplib
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from email.message import EmailMessage
from pathlib import Path

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


def _load_config():
    if not CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8")) or {}
    except Exception as e:
        print(f"[Bridge] config.json unreadable ({e}), using defaults.")
        return {}


CONFIG = _load_config()
CONFIG.setdefault("bridge_name", "My Laptop")
CONFIG.setdefault("port", 8765)
CONFIG.setdefault("allowed_dirs", ["~"])
CONFIG.setdefault("max_output_bytes", 200000)
CONFIG.setdefault("max_body_mb", 60)
CONFIG.setdefault("allowed_origins", [])
CONFIG.setdefault("token", "")
CONFIG.setdefault("smtp", {})

PORT = int(CONFIG["port"])
NAME = str(CONFIG["bridge_name"])
MAX_OUTPUT = int(CONFIG["max_output_bytes"])
MAX_BODY = int(CONFIG["max_body_mb"]) * 1024 * 1024
SMTP = CONFIG.get("smtp") or {}
TOKEN = str(CONFIG.get("token") or "").strip()

IS_WINDOWS = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"

# Relative paths, "." and "~" all resolve against the home folder.
HOME = Path.home().resolve()


def _current_user():
    try:
        return getpass.getuser()
    except Exception:
        return os.environ.get("USER") or os.environ.get("USERNAME") or "user"


USER = _current_user()

# Browser origins allowed to talk to the bridge. Localhost is always allowed.
DEFAULT_ORIGINS = ["https://miroxai.org", "https://www.miroxai.org"]
ALLOWED_ORIGINS = set(DEFAULT_ORIGINS + [str(o).rstrip("/") for o in CONFIG["allowed_origins"]])
LOCAL_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")


# ---------------- Allowed dirs ----------------
def _resolve_dir(p):
    try:
        return Path(str(p)).expanduser().resolve()
    except Exception:
        return None


ALLOWED_DIRS = []
for raw in CONFIG.get("allowed_dirs") or ["~"]:
    raw = str(raw).strip()
    base = HOME if raw in ("", ".", "./") else _resolve_dir(raw)
    if base and base not in ALLOWED_DIRS:
        ALLOWED_DIRS.append(base)
for extra in (HOME, _resolve_dir(tempfile.gettempdir())):
    if extra and extra not in ALLOWED_DIRS:
        ALLOWED_DIRS.append(extra)


def is_path_allowed(p: Path) -> bool:
    for base in ALLOWED_DIRS:
        try:
            p.relative_to(base)
            return True
        except ValueError:
            continue
    return False


def expand(raw) -> Path:
    """Turn any AI or user supplied path into an absolute Path.

    ""  or "."     -> HOME
    "~", "~/x"     -> HOME, HOME/x
    "x/y"          -> HOME/x/y
    "/abs", "C:\\" -> unchanged
    """
    s = str(raw or "").strip()
    if s in ("", ".", "./", "~", "~/"):
        return HOME
    p = Path(s).expanduser()
    if not p.is_absolute():
        p = HOME / p
    return p


def safe_path(raw):
    """Resolved absolute path if it sits inside an allowed root, otherwise None."""
    try:
        p = expand(raw).resolve()
    except Exception:
        return None
    return p if is_path_allowed(p) else None


def workdir(data) -> Path:
    """Working directory for a command: the requested cwd, or HOME."""
    return safe_path(data.get("cwd")) or HOME


# ---------------- Helpers ----------------
def _shell_kwargs():
    if IS_WINDOWS:
        return {}
    return {"executable": shutil.which("bash") or "/bin/sh"}


def _trim(text):
    text = text or ""
    if len(text) > MAX_OUTPUT:
        return text[:MAX_OUTPUT], True
    return text, False


def _ok(**kw):
    return web.json_response({"ok": True, **kw})


def _err(msg, **kw):
    return web.json_response({"ok": False, "error": msg, **kw})


async def _json(req):
    """Parsed JSON object body, {} when empty, None when the body is not valid JSON."""
    try:
        data = await req.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return None


def _run_argv(argv, cwd=None, timeout=60, input_text=None):
    """Run an argv list without a shell. Returns (returncode, stdout, stderr)."""
    proc = subprocess.run(
        argv,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        timeout=timeout,
        input=input_text,
    )
    return proc.returncode, proc.stdout or "", proc.stderr or ""


# ---------------- Security middleware ----------------
def _origin_allowed(origin: str) -> bool:
    if not origin:  # no Origin header: a local tool or the bridge itself
        return True
    origin = origin.rstrip("/")
    return origin in ALLOWED_ORIGINS or bool(LOCAL_ORIGIN_RE.match(origin))


def _add_cors(resp, origin):
    if origin and _origin_allowed(origin):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Mirox-Token"
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Access-Control-Max-Age"] = "86400"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@web.middleware
async def guard_mw(request, handler):
    origin = request.headers.get("Origin", "")
    if not _origin_allowed(origin):
        return web.json_response({"ok": False, "error": "Origin not allowed"}, status=403)

    if request.method == "OPTIONS":
        return _add_cors(web.Response(status=204), origin)

    # /ping only reveals the bridge name, so it stays open for discovery.
    if TOKEN and request.path != "/ping":
        if request.headers.get("X-Mirox-Token", "") != TOKEN:
            return web.json_response({"ok": False, "error": "Bad or missing bridge token"}, status=401)

    try:
        resp = await handler(request)
    except web.HTTPException as e:
        resp = e
    except Exception as e:
        resp = web.json_response({"ok": False, "error": str(e)}, status=500)
    return _add_cors(resp, origin)


# ---------------- Endpoints ----------------
async def ping(req):
    return _ok(
        name=NAME, cwd=str(HOME), home=str(HOME), user=USER,
        platform=platform.system(),
        sudo_available=bool(shutil.which("sudo")) and not IS_WINDOWS,
        time=time.time(),
    )


async def env_info(req):
    return _ok(
        name=NAME,
        user=USER,
        home=str(HOME),
        cwd=str(HOME),
        default_cwd=str(HOME),
        platform=platform.system(),
        platform_release=platform.release(),
        python=platform.python_version(),
        allowed_dirs=[str(d) for d in ALLOWED_DIRS],
        separator=os.sep,
        smtp_configured=bool(SMTP.get("host")),
        sudo_available=bool(shutil.which("sudo")) and not IS_WINDOWS,
        kde_connect_available=bool(shutil.which("kdeconnect-cli")),
        time=time.time(),
    )


async def resolve_path(req):
    """Tell the caller what a path really is. Use this instead of guessing."""
    data = await _json(req)
    if data is None:
        return _err("Invalid JSON")
    raw = data.get("path", "")
    try:
        p = expand(raw).resolve()
    except Exception as e:
        return _err(str(e), input=str(raw))
    return _ok(
        input=str(raw),
        path=str(p),
        exists=p.exists(),
        is_dir=p.is_dir(),
        is_file=p.is_file(),
        allowed=is_path_allowed(p),
        home=str(HOME),
        separator=os.sep,
    )


# -- commands --
# Matches "sudo" only at the start of a command or after ; & | ( (not inside echo text).
_SUDO_RE = re.compile(r"((?:^|[;&|(])\s*)sudo\s+", re.IGNORECASE)


def _needs_sudo(cmd: str) -> bool:
    return bool(_SUDO_RE.search(cmd))


def _strip_sudo(cmd: str) -> str:
    return _SUDO_RE.sub(r"\1", cmd).strip()


async def exec_cmd(req):
    data = await _json(req)
    if data is None:
        return _err("Invalid JSON")
    cmd = str(data.get("command", "")).strip()
    if not cmd:
        return _err("No command provided")

    if _needs_sudo(cmd):
        return web.json_response({
            "ok": False,
            "needs_sudo": True,
            "command": _strip_sudo(cmd),
            "error": "This command needs sudo. Provide a password via /sudo-exec.",
        })

    cwd = workdir(data)
    timeout = max(1, min(int(data.get("timeout", 120)), 600))
    try:
        proc = subprocess.run(
            cmd, shell=True, cwd=str(cwd), capture_output=True, text=True,
            timeout=timeout, **_shell_kwargs(),
        )
    except subprocess.TimeoutExpired:
        return _err(f"Command timed out after {timeout}s", cwd=str(cwd))
    except Exception as e:
        return _err(str(e), cwd=str(cwd))

    out, t1 = _trim(proc.stdout)
    err, t2 = _trim(proc.stderr)
    return _ok(exit_code=proc.returncode, stdout=out, stderr=err,
               truncated=t1 or t2, cwd=str(cwd))


async def sudo_exec(req):
    """Run a command as root. The password is used once and never stored."""
    data = await _json(req)
    if data is None:
        return _err("Invalid JSON")
    raw_cmd = str(data.get("command", "")).strip()
    password = str(data.get("password", ""))
    if not raw_cmd:
        return _err("No command provided")
    if not password:
        return _err("No password provided")
    if IS_WINDOWS or not shutil.which("sudo"):
        return _err("sudo is not available here. Run the bridge from an elevated terminal instead.")

    inner = _strip_sudo(raw_cmd)
    cwd = workdir(data)
    timeout = max(1, min(int(data.get("timeout", 120)), 600))

    # -k ignores cached credentials, -S reads the password from stdin,
    # and sh -c runs the whole command line as one unit under root.
    argv = ["sudo", "-k", "-S", "-p", "", "--", "sh", "-c", inner]
    try:
        proc = subprocess.run(
            argv, cwd=str(cwd), capture_output=True, text=True,
            timeout=timeout, input=password + "\n",
        )
    except subprocess.TimeoutExpired:
        return _err(f"Command timed out after {timeout}s", cwd=str(cwd))
    except Exception as e:
        return _err(str(e), cwd=str(cwd))

    err_text = proc.stderr or ""
    wrong = any(s in err_text.lower() for s in (
        "incorrect password", "sorry, try again", "authentication failure"))
    out, t1 = _trim(proc.stdout)
    err, t2 = _trim(err_text)
    ok = proc.returncode == 0 and not wrong
    return web.json_response({
        "ok": ok,
        "exit_code": proc.returncode,
        "stdout": out,
        "stderr": err,
        "truncated": t1 or t2,
        "cwd": str(cwd),
        "wrong_password": wrong,
        "error": "Wrong sudo password" if wrong else (None if ok else "sudo command failed"),
    })


# -- files --
async def write_file(req):
    data = await _json(req)
    if data is None:
        return _err("Invalid JSON")
    p = safe_path(data.get("path", ""))
    if not p:
        return _err("Path not allowed", allowed_dirs=[str(d) for d in ALLOWED_DIRS])
    if p.is_dir():
        return _err("Path is a directory", path=str(p))
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        content = str(data.get("content", ""))
        p.write_text(content, encoding="utf-8")
        return _ok(path=str(p), bytes=len(content.encode("utf-8")))
    except Exception as e:
        return _err(str(e), path=str(p))


async def append_file(req):
    data = await _json(req)
    if data is None:
        return _err("Invalid JSON")
    p = safe_path(data.get("path", ""))
    if not p:
        return _err("Path not allowed")
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        content = str(data.get("content", ""))
        with p.open("a", encoding="utf-8") as f:
            f.write(content)
        return _ok(path=str(p), bytes=len(content.encode("utf-8")))
    except Exception as e:
        return _err(str(e), path=str(p))


async def read_file(req):
    data = await _json(req)
    if data is None:
        return _err("Invalid JSON")
    p = safe_path(data.get("path", ""))
    if not p or not p.exists():
        return _err("File not found", path=str(expand(data.get("path", ""))))
    if not p.is_file():
        return _err("Not a file", path=str(p))
    try:
        size = p.stat().st_size
        out, truncated = _trim(p.read_text(encoding="utf-8", errors="replace"))
        return _ok(path=str(p), content=out, size=size, truncated=truncated)
    except Exception as e:
        return _err(str(e), path=str(p))


async def list_dir(req):
    data = await _json(req) or {}
    p = safe_path(data.get("path", "")) or HOME
    if not p.is_dir():
        return _err("Not a directory", path=str(p))
    try:
        entries = sorted(p.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower()))
        items = []
        for c in entries[:500]:
            try:
                size = c.stat().st_size if c.is_file() else 0
            except OSError:
                size = 0
            items.append({"name": c.name, "is_dir": c.is_dir(), "size": size, "path": str(c)})
        return _ok(path=str(p), total=len(entries), items=items)
    except Exception as e:
        return _err(str(e), path=str(p))


async def delete_path(req):
    data = await _json(req)
    if data is None:
        return _err("Invalid JSON")
    p = safe_path(data.get("path", ""))
    if not p or not p.exists():
        return _err("Not found")
    if p == HOME or p in ALLOWED_DIRS:
        return _err("Refusing to delete a protected root folder", path=str(p))
    try:
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
        return _ok(path=str(p))
    except Exception as e:
        return _err(str(e), path=str(p))


async def move_path(req):
    data = await _json(req)
    if data is None:
        return _err("Invalid JSON")
    a = safe_path(data.get("from", ""))
    b = safe_path(data.get("to", ""))
    if not a or not b:
        return _err("Path not allowed")
    if not a.exists():
        return _err("Source not found", path=str(a))
    try:
        b.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(a), str(b))
        return _ok(**{"from": str(a), "to": str(b)})
    except Exception as e:
        return _err(str(e))


async def copy_path(req):
    data = await _json(req)
    if data is None:
        return _err("Invalid JSON")
    a = safe_path(data.get("from", ""))
    b = safe_path(data.get("to", ""))
    if not a or not b:
        return _err("Path not allowed")
    if not a.exists():
        return _err("Source not found", path=str(a))
    try:
        b.parent.mkdir(parents=True, exist_ok=True)
        if a.is_dir():
            shutil.copytree(str(a), str(b), dirs_exist_ok=True)
        else:
            shutil.copy2(str(a), str(b))
        return _ok(**{"from": str(a), "to": str(b)})
    except Exception as e:
        return _err(str(e))


# -- system --
def _node_version():
    try:
        p = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=5)
        return p.stdout.strip() if p.returncode == 0 else ""
    except Exception:
        return ""


async def sysinfo(req):
    info = {
        "platform": platform.system(), "release": platform.release(),
        "version": platform.version(), "machine": platform.machine(),
        "python": platform.python_version(), "cpu_count": os.cpu_count(),
        "home": str(HOME), "user": USER, "node": _node_version(),
    }
    try:
        total, used, free = shutil.disk_usage(str(HOME))
        info["disk"] = {"total_gb": round(total / 1e9, 2), "used_gb": round(used / 1e9, 2),
                        "free_gb": round(free / 1e9, 2)}
    except Exception:
        pass
    return _ok(**info)


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
    node = _node_version()
    checks["node"] = {"ok": bool(node), "version": node}
    healthy = all(c.get("ok") for c in checks.values())
    return _ok(check=checks, healthy=healthy)


async def processes(req):
    try:
        if IS_WINDOWS:
            _code, out, _err_text = _run_argv(["tasklist"], timeout=8)
            return _ok(raw=out[:MAX_OUTPUT])
        _code, out, err_text = _run_argv(["ps", "aux"], timeout=8)
        lines = out.splitlines()
        if not lines:
            return _err(err_text or "ps returned nothing")
        header, rows = lines[0], lines[1:]

        def cpu(row):
            try:
                return float(row.split(None, 3)[2])
            except (ValueError, IndexError):
                return 0.0

        rows.sort(key=cpu, reverse=True)
        return _ok(raw="\n".join([header] + rows[:15])[:MAX_OUTPUT])
    except Exception as e:
        return _err(str(e))


async def send_email(req):
    data = await _json(req)
    if data is None:
        return _err("Invalid JSON")
    if not SMTP.get("host"):
        return _err("SMTP not configured. Run smtp_setup.py.")
    to = str(data.get("to", "")).strip()
    subject = str(data.get("subject", "")).strip() or "(no subject)"
    body = str(data.get("body", ""))
    if not to or "@" not in to:
        return _err("Invalid recipient")
    try:
        msg = EmailMessage()
        msg["From"] = SMTP.get("from") or SMTP.get("user") or ""
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(body)
        ctx = ssl.create_default_context()
        port = int(SMTP.get("port", 587))
        if SMTP.get("use_tls", True):
            with smtplib.SMTP(SMTP["host"], port, timeout=20) as s:
                s.starttls(context=ctx)
                if SMTP.get("user"):
                    s.login(SMTP["user"], SMTP.get("pass", ""))
                s.send_message(msg)
        else:
            with smtplib.SMTP_SSL(SMTP["host"], port, timeout=20, context=ctx) as s:
                if SMTP.get("user"):
                    s.login(SMTP["user"], SMTP.get("pass", ""))
                s.send_message(msg)
        return _ok(sent_to=to, subject=subject)
    except Exception as e:
        return _err(str(e))


async def http_call(req):
    data = await _json(req)
    if data is None:
        return _err("Invalid JSON")
    url = str(data.get("url", "")).strip()
    method = str(data.get("method", "GET")).upper()
    body = data.get("body") or None
    headers = data.get("headers") or {}
    if not url:
        return _err("No url")
    if not url.startswith(("http://", "https://")):
        return _err("Only http(s) allowed")
    if method not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"):
        return _err("Method not allowed")
    payload = None
    if body is not None:
        payload = body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8")
    r = urllib.request.Request(url, method=method, data=payload)
    r.add_header("User-Agent", "MiroxBridge/5.0")
    if payload is not None:
        r.add_header("Content-Type", "application/json")
    if isinstance(headers, dict):
        for k, v in headers.items():
            r.add_header(str(k), str(v))
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            text = resp.read(MAX_OUTPUT).decode("utf-8", errors="replace")
            return _ok(status=resp.status, body=text)
    except urllib.error.HTTPError as e:
        text = e.read(MAX_OUTPUT).decode("utf-8", errors="replace") if e.fp else ""
        return web.json_response({"ok": False, "status": e.code, "error": str(e.reason), "body": text})
    except Exception as e:
        return _err(str(e))


# -- clipboard / screenshot --
async def clipboard(req):
    data = await _json(req)
    if data is None:
        return _err("Invalid JSON")
    action = data.get("action", "get")
    content = str(data.get("content", ""))
    try:
        import pyperclip  # optional
        if action == "set":
            pyperclip.copy(content)
            return _ok()
        return _ok(content=pyperclip.paste())
    except ImportError:
        pass
    except Exception as e:
        return _err("clipboard unavailable: " + str(e))
    try:
        if IS_MAC:
            argv_set, argv_get = ["pbcopy"], ["pbpaste"]
        elif IS_WINDOWS:
            argv_set, argv_get = ["clip"], ["powershell", "-command", "Get-Clipboard"]
        else:
            argv_set = ["xclip", "-selection", "clipboard"]
            argv_get = ["xclip", "-selection", "clipboard", "-o"]
        if action == "set":
            subprocess.run(argv_set, input=content, text=True, check=True, timeout=10)
            return _ok()
        _code, out, _e = _run_argv(argv_get, timeout=10)
        return _ok(content=out)
    except Exception as e:
        return _err("clipboard unavailable (install pyperclip or xclip): " + str(e))


async def screenshot(req):
    data = await _json(req) or {}
    p = safe_path(data.get("path", "")) or (HOME / "mirox_screenshot.png")
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return _err(str(e))

    # 1) Pillow works on Windows, macOS and most Linux desktops.
    try:
        from PIL import ImageGrab  # optional
        ImageGrab.grab().save(str(p))
        return _ok(path=str(p))
    except ImportError:
        pass
    except Exception:
        pass

    # 2) Platform tools, called with argv (no shell, so paths are safe).
    if IS_WINDOWS:
        return _err("Install Pillow for screenshots: pip install pillow")
    if IS_MAC:
        candidates = [["screencapture", "-x", str(p)]]
    else:
        candidates = [
            ["gnome-screenshot", "-f", str(p)],
            ["scrot", str(p)],
            ["import", "-window", "root", str(p)],
        ]
    for argv in candidates:
        if not shutil.which(argv[0]):
            continue
        try:
            code, _out, _e = _run_argv(argv, timeout=15)
            if code == 0 and p.exists():
                return _ok(path=str(p))
        except Exception:
            continue
    return _err("No screenshot tool found. Run: pip install pillow")


# -- git / packages --
GIT_ARGS = {
    "status": ["git", "status"],
    "log": ["git", "log", "--oneline", "-n", "20"],
    "branch": ["git", "branch", "-a"],
    "diff": ["git", "diff"],
    "add-all": ["git", "add", "-A"],
    "pull": ["git", "pull"],
    "push": ["git", "push"],
    "remote": ["git", "remote", "-v"],
}


async def git_op(req):
    data = await _json(req)
    if data is None:
        return _err("Invalid JSON")
    action = str(data.get("action", "status"))
    cwd = workdir(data)
    if action == "commit":
        msg = str(data.get("message", "")).strip()
        if not msg:
            return _err("message required")
        argv = ["git", "commit", "-m", msg]  # argv: no shell, no quoting bugs
    elif action in GIT_ARGS:
        argv = GIT_ARGS[action]
    else:
        return _err("unknown action")
    try:
        code, out, err_text = _run_argv(argv, cwd=cwd, timeout=60)
        out, _ = _trim(out)
        err_text, _ = _trim(err_text)
        return web.json_response({"ok": code == 0, "stdout": out, "stderr": err_text, "cwd": str(cwd)})
    except FileNotFoundError:
        return _err("git is not installed")
    except Exception as e:
        return _err(str(e))


PKG_ARGS = {
    "pip": [sys.executable, "-m", "pip", "list"],
    "pip-freeze": [sys.executable, "-m", "pip", "freeze"],
    "npm": ["npm", "list", "--depth=0"],
}


async def pkgs(req):
    data = await _json(req) or {}
    t = str(data.get("type", "pip"))
    if t not in PKG_ARGS:
        return _err("unknown type")
    try:
        code, out, err_text = _run_argv(PKG_ARGS[t], cwd=workdir(data), timeout=30)
        return web.json_response({"ok": code == 0, "raw": (out or err_text)[:MAX_OUTPUT]})
    except Exception as e:
        return _err(str(e))


# ---------------- App ----------------
def build_app():
    app = web.Application(middlewares=[guard_mw], client_max_size=MAX_BODY)

    routes = [
        ("GET", "/ping", ping),
        ("GET", "/env", env_info),
        ("POST", "/env", env_info),
        ("POST", "/resolve", resolve_path),
        ("POST", "/exec", exec_cmd),
        ("POST", "/sudo-exec", sudo_exec),
        ("POST", "/write", write_file),
        ("POST", "/append", append_file),
        ("POST", "/read", read_file),
        ("POST", "/list", list_dir),
        ("POST", "/delete", delete_path),
        ("POST", "/move", move_path),
        ("POST", "/copy", copy_path),
        ("POST", "/sysinfo", sysinfo),
        ("POST", "/syscheck", syscheck),
        ("POST", "/processes", processes),
        ("POST", "/email", send_email),
        ("POST", "/http", http_call),
        ("POST", "/clipboard", clipboard),
        ("POST", "/screenshot", screenshot),
        ("POST", "/git", git_op),
        ("POST", "/pkgs", pkgs),
    ]
    for method, path, handler in routes:
        app.router.add_route(method, path, handler)

    # Catch-all for CORS preflight. guard_mw answers it with the right headers.
    app.router.add_route("OPTIONS", "/{tail:.*}", lambda r: web.Response(status=204))
    return app


if __name__ == "__main__":
    print("=" * 60)
    print(f"[Bridge] {NAME} v5 on http://127.0.0.1:{PORT}")
    print(f"[Bridge] User: {USER}   Home: {HOME}")
    print(f"[Bridge] Platform: {platform.system()} {platform.release()}")
    for d in ALLOWED_DIRS:
        print(f"[Bridge]   allowed: {d}")
    print(f"[Bridge] Origins: {', '.join(sorted(ALLOWED_ORIGINS))} + localhost")
    print(f"[Bridge] Token required: {'yes' if TOKEN else 'no (set \"token\" in config.json)'}")
    print(f"[Bridge] SMTP configured: {bool(SMTP.get('host'))}")
    print("=" * 60)
    try:
        web.run_app(build_app(), host="127.0.0.1", port=PORT, print=None, access_log=None)
    except KeyboardInterrupt:
        print("\n[Bridge] Stopped.")
    except OSError as e:
        print(f"[Bridge] Failed to start: {e}")
        sys.exit(1)

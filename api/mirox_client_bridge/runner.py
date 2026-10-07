#!/usr/bin/env python3
"""
MiroxAI Bridge Client — HTTP-only (aiohttp).

Fix: allowed_dirs always includes home + cwd + temp so the AI can
write projects without getting "Path not allowed" errors.
"""

import os
import sys
import json
import time
import platform
import tempfile
import subprocess
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

PORT = int(CONFIG["port"])
NAME = CONFIG["bridge_name"]
MAX_OUTPUT = int(CONFIG["max_output_bytes"])


# ---------------- Build allowed_dirs ----------------
def _resolve(p):
    try:
        return Path(p).expanduser().resolve()
    except Exception:
        return None


raw_dirs = CONFIG.get("allowed_dirs", ["~"]) or ["~"]
# If config says "." or is empty, use home instead
raw_dirs = [d for d in raw_dirs if d and d != "."]

resolved = []
for d in raw_dirs:
    r = _resolve(d)
    if r:
        resolved.append(r)

# ALWAYS add home, cwd, and temp so the AI never gets blocked
home_path = _resolve("~")
cwd_path = _resolve(".")
tmp_path = _resolve(tempfile.gettempdir())

for extra in (home_path, cwd_path, tmp_path):
    if extra and extra not in resolved:
        resolved.append(extra)

ALLOWED_DIRS = resolved


# ---------------- Path safety ----------------
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
    """Return a resolved Path if allowed, else None.
    Bare relative names are resolved against home (not cwd) so the AI
    can just say 'project/file.js' and it lands in the home dir."""
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


# ---------------- Endpoints ----------------
async def ping(req):
    return web.json_response({
        "ok": True,
        "name": NAME,
        "cwd": os.getcwd(),
        "time": time.time(),
    })


async def env_info(req):
    home = str(Path.home())
    return web.json_response({
        "ok": True,
        "name": NAME,
        "home": home,
        "cwd": os.getcwd(),
        "platform": platform.system(),
        "platform_release": platform.release(),
        "python": platform.python_version(),
        "allowed_dirs": [str(d) for d in ALLOWED_DIRS],
        "separator": os.sep,
        "time": time.time(),
    })


async def exec_cmd(req):
    try:
        data = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"})

    cmd = str(data.get("command", "")).strip()
    if not cmd:
        return web.json_response({"ok": False, "error": "No command provided"})

    cwd = data.get("cwd") or str(Path.home())
    cwd_path = safe_path(cwd) or Path.home()
    timeout = int(data.get("timeout", 120))

    print(f"[Bridge] exec: {cmd[:120]} (cwd={cwd_path})")
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            cwd=str(cwd_path),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return web.json_response({
            "ok": True,
            "exit_code": proc.returncode,
            "stdout": (proc.stdout or "")[:MAX_OUTPUT],
            "stderr": (proc.stderr or "")[:MAX_OUTPUT],
            "cwd": str(cwd_path),
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

    raw = data.get("path", "")
    p = safe_path(raw)
    if not p:
        return web.json_response({
            "ok": False,
            "error": "Path not allowed",
            "requested": raw,
            "allowed_dirs": [str(d) for d in ALLOWED_DIRS],
            "hint": "Use an absolute path under one of allowed_dirs, or a relative path (resolved against home)."
        })

    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        content = data.get("content", "")
        p.write_text(content, encoding="utf-8")
        print(f"[Bridge] wrote: {p} ({len(content)} bytes)")
        return web.json_response({"ok": True, "path": str(p), "bytes": len(content)})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def read_file(req):
    try:
        data = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"})

    p = safe_path(data.get("path", ""))
    if not p:
        return web.json_response({"ok": False, "error": "Path not allowed"})
    if not p.exists():
        return web.json_response({"ok": False, "error": "File not found"})

    try:
        text = p.read_text(encoding="utf-8", errors="replace")[:MAX_OUTPUT]
        return web.json_response({"ok": True, "path": str(p), "content": text})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def list_dir(req):
    try:
        data = await req.json()
    except Exception:
        data = {}

    p = safe_path(data.get("path", str(Path.home())))
    if not p:
        return web.json_response({"ok": False, "error": "Path not allowed"})
    if not p.is_dir():
        return web.json_response({"ok": False, "error": "Not a directory"})

    try:
        items = []
        for child in sorted(p.iterdir()):
            items.append({
                "name": child.name,
                "is_dir": child.is_dir(),
                "size": child.stat().st_size if child.is_file() else 0,
            })
        return web.json_response({"ok": True, "path": str(p), "items": items[:500]})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# ---------------- App ----------------
def build_app():
    app = web.Application(middlewares=[cors_mw])
    app.router.add_get("/ping", ping)
    app.router.add_options("/ping", lambda r: web.Response())
    app.router.add_get("/env", env_info)
    app.router.add_options("/env", lambda r: web.Response())
    app.router.add_post("/exec", exec_cmd)
    app.router.add_options("/exec", lambda r: web.Response())
    app.router.add_post("/write", write_file)
    app.router.add_options("/write", lambda r: web.Response())
    app.router.add_post("/read", read_file)
    app.router.add_options("/read", lambda r: web.Response())
    app.router.add_post("/list", list_dir)
    app.router.add_options("/list", lambda r: web.Response())
    return app


if __name__ == "__main__":
    print("=" * 60)
    print(f"[Bridge] Starting '{NAME}' on http://127.0.0.1:{PORT}")
    print(f"[Bridge] Home: {Path.home()}")
    print(f"[Bridge] Platform: {platform.system()} {platform.release()}")
    print(f"[Bridge] Allowed dirs:")
    for d in ALLOWED_DIRS:
        print(f"[Bridge]   - {d}")
    print("=" * 60)
    print(f"[Bridge] Ready. Open MiroxAI and click 'Connect'.")
    print(f"[Bridge] Health check: http://localhost:{PORT}/ping")
    print(f"[Bridge] Env check:    http://localhost:{PORT}/env")
    print("=" * 60)

    try:
        web.run_app(build_app(), host="127.0.0.1", port=PORT, print=None, access_log=None)
    except KeyboardInterrupt:
        print("\n[Bridge] Stopped.")
    except OSError as e:
        if "address already in use" in str(e).lower() or e.errno in (98, 48):
            print(f"[Bridge] Port {PORT} is already in use.")
        else:
            print(f"[Bridge] Failed to start: {e}")
        sys.exit(1)

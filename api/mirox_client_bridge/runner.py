#!/usr/bin/env python3
"""
MiroxAI Bridge Client — HTTP-only (aiohttp).
Works with the modern Mirox frontend which calls HTTP endpoints
(/ping, /env, /exec, /write, /read, /list).

Install:
    pip install aiohttp

Run:
    python runner.py
"""

import os
import sys
import json
import time
import platform
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
ALLOWED_DIRS = [Path(p).expanduser().resolve() for p in CONFIG["allowed_dirs"]]
MAX_OUTPUT = int(CONFIG["max_output_bytes"])


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
    p = Path(raw).expanduser()
    if not p.is_absolute():
        p = Path.cwd() / p
    try:
        p = p.resolve()
    except Exception:
        return None
    return p if is_path_allowed(p) else None


# ---------------- CORS middleware ----------------
@web.middleware
async def cors_mw(request, handler):
    # Handle preflight
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
    # Required by Chrome for HTTPS pages to reach http://localhost
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Access-Control-Max-Age"] = "86400"
    return resp


# ---------------- Endpoints ----------------
async def ping(req):
    """Health check — used by the frontend 'Connect' button."""
    return web.json_response({
        "ok": True,
        "name": NAME,
        "cwd": os.getcwd(),
        "time": time.time(),
    })


async def env_info(req):
    """Environment info so the AI knows the real home dir + OS."""
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

    print(f"[Bridge] exec: {cmd[:120]}")
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

    p = safe_path(data.get("path", ""))
    if not p:
        return web.json_response({"ok": False, "error": "Path not allowed"})

    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        content = data.get("content", "")
        p.write_text(content, encoding="utf-8")
        print(f"[Bridge] wrote: {p}")
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

    p = safe_path(data.get("path", "."))
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
    print(f"[Bridge] Home directory: {Path.home()}")
    print(f"[Bridge] Platform: {platform.system()} {platform.release()}")
    print(f"[Bridge] Allowed dirs: {[str(d) for d in ALLOWED_DIRS]}")
    print("=" * 60)
    print(f"[Bridge] Ready. Open MiroxAI and click 'Connect'.")
    print(f"[Bridge] Health check: http://localhost:{PORT}/ping")
    print("=" * 60)

    try:
        web.run_app(
            build_app(),
            host="127.0.0.1",
            port=PORT,
            print=None,
            access_log=None,
        )
    except KeyboardInterrupt:
        print("\n[Bridge] Stopped.")
    except OSError as e:
        if "address already in use" in str(e).lower() or e.errno == 98 or e.errno == 48:
            print(f"[Bridge] Port {PORT} is already in use. Close the other process or change the port.")
        else:
            print(f"[Bridge] Failed to start: {e}")
        sys.exit(1)

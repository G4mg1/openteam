#!/usr/bin/env python3
"""
MiroxAI Bridge Client — HTTP-only.
Runs on 127.0.0.1:PORT and lets MiroxAI (from any HTTPS page) drive
your laptop: run commands, write files, read files, list directories.

Sends the "Access-Control-Allow-Private-Network: true" header so that
Chrome allows HTTPS pages (like https://miroxai.org) to reach it.
"""
import os
import sys
import json
import time
import subprocess
import asyncio
from pathlib import Path

try:
    from aiohttp import web
except ImportError:
    print("Missing dependency: aiohttp")
    print("Install with: pip install aiohttp")
    sys.exit(1)


# ---------- Config ----------
CONFIG_FILE = Path(__file__).parent / "config.json"
if CONFIG_FILE.exists():
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        CONFIG = json.load(f)
else:
    CONFIG = {
        "bridge_name": "My Laptop",
        "port": 8765,
        "model": "mirox-luna-1.2",
        "allowed_dirs": ["~"],
        "max_output_bytes": 200000,
    }

PORT = int(CONFIG.get("port", 8765))
NAME = CONFIG.get("bridge_name", "My Laptop")
ALLOWED_DIRS = [Path(p).expanduser().resolve() for p in CONFIG.get("allowed_dirs", ["~"])]
MAX_OUTPUT = CONFIG.get("max_output_bytes", 200000)


# ---------- Safety ----------
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


# ---------- CORS middleware ----------
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
    # CRITICAL — required by Chrome for HTTPS pages to call http://localhost
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Access-Control-Max-Age"] = "86400"
    return resp


# ---------- Handlers ----------
async def ping(req):
    return web.json_response({
        "ok": True,
        "name": NAME,
        "cwd": os.getcwd(),
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
            cmd, shell=True, cwd=str(cwd_path),
            capture_output=True, text=True, timeout=timeout,
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
        return web.json_response({"ok": False, "error": "Not found"})

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


# ---------- App ----------
def build_app():
    app = web.Application(middlewares=[cors_mw])
    app.router.add_get("/ping", ping)
    app.router.add_options("/ping", lambda r: web.Response())
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
    print(f"[Bridge] Starting '{NAME}' on http://127.0.0.1:{PORT}")
    print(f"[Bridge] Allowed dirs: {[str(d) for d in ALLOWED_DIRS]}")
    print(f"[Bridge] Ready. Open MiroxAI and click 'Connect'.")
    print(f"[Bridge] Health check: http://localhost:{PORT}/ping")
    web.run_app(build_app(), host="127.0.0.1", port=PORT, print=None, access_log=None)

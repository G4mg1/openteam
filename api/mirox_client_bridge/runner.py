#!/usr/bin/env python3
"""
MiroxAI Bridge Client
=====================
Run this on your laptop to let Mirox control it.
It opens a WebSocket server on localhost:PORT and waits for commands.

Commands supported:
  exec    — run a shell command
  write   — write a file
  read    — read a file
  list    — list directory contents
  ping    — health check
"""

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

try:
    import websockets
except ImportError:
    print("Missing dependency: websockets")
    print("Install with: pip install websockets")
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
        "allowed_dirs": [str(Path.home())],
        "max_output_bytes": 200000,
    }

PORT = CONFIG.get("port", 8765)
NAME = CONFIG.get("bridge_name", "My Laptop")
ALLOWED_DIRS = [Path(p).expanduser().resolve() for p in CONFIG.get("allowed_dirs", [str(Path.home())])]
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

def safe_path(raw: str) -> Path | None:
    p = Path(raw).expanduser()
    if not p.is_absolute():
        p = Path.cwd() / p
    try:
        p = p.resolve()
    except Exception:
        return None
    if not is_path_allowed(p):
        return None
    return p

# ---------- Handlers ----------
async def handle_exec(args: dict) -> dict:
    cmd = args.get("command", "").strip()
    if not cmd:
        return {"ok": False, "error": "No command provided"}
    cwd = args.get("cwd") or str(Path.home())
    cwd_path = safe_path(cwd) or Path.home()
    try:
        proc = subprocess.run(
            cmd, shell=True, cwd=str(cwd_path),
            capture_output=True, text=True, timeout=args.get("timeout", 120),
        )
        out = (proc.stdout or "")[:MAX_OUTPUT]
        err = (proc.stderr or "")[:MAX_OUTPUT]
        return {"ok": True, "exit_code": proc.returncode, "stdout": out, "stderr": err, "cwd": str(cwd_path)}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Command timed out"}
    except Exception as e:
        return {"ok": False, "error": str(e)}

async def handle_write(args: dict) -> dict:
    raw_path = args.get("path", "")
    content = args.get("content", "")
    p = safe_path(raw_path)
    if not p:
        return {"ok": False, "error": "Path not allowed or invalid"}
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return {"ok": True, "path": str(p), "bytes": len(content.encode("utf-8"))}
    except Exception as e:
        return {"ok": False, "error": str(e)}

async def handle_read(args: dict) -> dict:
    p = safe_path(args.get("path", ""))
    if not p:
        return {"ok": False, "error": "Path not allowed or invalid"}
    if not p.exists():
        return {"ok": False, "error": "File not found"}
    try:
        text = p.read_text(encoding="utf-8", errors="replace")[:MAX_OUTPUT]
        return {"ok": True, "path": str(p), "content": text}
    except Exception as e:
        return {"ok": False, "error": str(e)}

async def handle_list(args: dict) -> dict:
    p = safe_path(args.get("path", str(Path.home())))
    if not p:
        return {"ok": False, "error": "Path not allowed or invalid"}
    if not p.is_dir():
        return {"ok": False, "error": "Not a directory"}
    try:
        items = []
        for child in sorted(p.iterdir()):
            items.append({
                "name": child.name,
                "is_dir": child.is_dir(),
                "size": child.stat().st_size if child.is_file() else 0,
            })
        return {"ok": True, "path": str(p), "items": items[:500]}
    except Exception as e:
        return {"ok": False, "error": str(e)}

async def handle_ping(_: dict) -> dict:
    return {"ok": True, "name": NAME, "time": time.time(), "cwd": os.getcwd()}

HANDLERS = {
    "exec": handle_exec,
    "write": handle_write,
    "read": handle_read,
    "list": handle_list,
    "ping": handle_ping,
}

# ---------- WebSocket server ----------
async def client_handler(websocket):
    peer = websocket.remote_address
    print(f"[Bridge] Client connected from {peer}")
    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send(json.dumps({"ok": False, "error": "Invalid JSON"}))
                continue

            cmd = msg.get("command", "")
            args = msg.get("args", {}) or {}
            req_id = msg.get("id", "")

            handler = HANDLERS.get(cmd)
            if not handler:
                await websocket.send(json.dumps({"id": req_id, "ok": False, "error": f"Unknown command: {cmd}"}))
                continue

            try:
                result = await handler(args)
            except Exception as e:
                result = {"ok": False, "error": str(e)}

            result["id"] = req_id
            await websocket.send(json.dumps(result))
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        print(f"[Bridge] Client disconnected: {peer}")

async def main():
    print(f"[Bridge] Starting '{NAME}' on ws://localhost:{PORT}")
    print(f"[Bridge] Allowed dirs: {[str(d) for d in ALLOWED_DIRS]}")
    async with websockets.serve(client_handler, "localhost", PORT):
        print("[Bridge] Ready. Waiting for Mirox…")
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[Bridge] Stopped.")

#!/usr/bin/env python3
"""
MiroxAI SMTP Setup Wizard
- Interactive configuration for outbound email
- Presets for Gmail, Outlook, Yahoo, iCloud, custom
- Tests the connection
- Writes the SMTP block into config.json (used by runner.py's /email endpoint)
- Also offers to run a LOCAL test SMTP server so you can preview outgoing mail
"""

import os
import sys
import json
import ssl
import smtplib
import socket
import threading
import time
import argparse
from pathlib import Path
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart


CONFIG_FILE = Path(__file__).parent / "config.json"

PRESETS = {
    "gmail":   {"host": "smtp.gmail.com",     "port": 587, "use_tls": True,  "hint": "Use an App Password (not your normal password)."},
    "outlook": {"host": "smtp-mail.outlook.com","port": 587, "use_tls": True,  "hint": "Use your normal Microsoft password or an App Password."},
    "office365":{"host":"smtp.office365.com", "port": 587, "use_tls": True,  "hint": "Microsoft 365 account."},
    "yahoo":   {"host": "smtp.mail.yahoo.com","port": 587, "use_tls": True,  "hint": "Generate an App Password in Yahoo account security."},
    "icloud":  {"host": "smtp.mail.me.com",   "port": 587, "use_tls": True,  "hint": "Use an App-Specific Password."},
    "zoho":    {"host": "smtp.zoho.com",      "port": 587, "use_tls": True,  "hint": "Use an App Password."},
    "custom":  {"host": "",                   "port": 587, "use_tls": True,  "hint": "Enter your provider's SMTP details."},
}


def load_config():
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_config(cfg):
    tmp = CONFIG_FILE.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    tmp.replace(CONFIG_FILE)


def prompt(msg, default=""):
    if default:
        v = input(f"{msg} [{default}]: ").strip()
        return v or default
    return input(f"{msg}: ").strip()


def prompt_yes_no(msg, default=True):
    suffix = "Y/n" if default else "y/N"
    v = input(f"{msg} [{suffix}]: ").strip().lower()
    if not v:
        return default
    return v in ("y", "yes")


def test_connection(host, port, use_tls, user, password):
    print(f"\n→ Testing connection to {host}:{port} …")
    try:
        ctx = ssl.create_default_context()
        if use_tls:
            with smtplib.SMTP(host, port, timeout=15) as s:
                s.ehlo()
                s.starttls(context=ctx)
                s.ehlo()
                s.login(user, password)
                s.noop()
            print("✓ Connection OK and login succeeded.")
            return True
        else:
            with smtplib.SMTP_SSL(host, port, timeout=15, context=ctx) as s:
                s.login(user, password)
                s.noop()
            print("✓ Connection OK (SSL) and login succeeded.")
            return True
    except smtplib.SMTPAuthenticationError as e:
        print("✗ Authentication failed:", e)
        print("  Tip: most providers require an App Password, not your normal password.")
        return False
    except socket.gaierror as e:
        print("✗ Could not resolve host:", e)
        return False
    except Exception as e:
        print("✗ Connection failed:", e)
        return False


def send_test_email(host, port, use_tls, user, password, from_addr, to_addr):
    print(f"\n→ Sending test email to {to_addr} …")
    try:
        msg = MIMEMultipart()
        msg["From"] = from_addr
        msg["To"] = to_addr
        msg["Subject"] = "MiroxAI SMTP test"
        msg.attach(MIMEText("This is a test email from MiroxAI Bridge.\n\nIf you can read this, your SMTP setup works.", "plain", "utf-8"))
        ctx = ssl.create_default_context()
        if use_tls:
            with smtplib.SMTP(host, port, timeout=20) as s:
                s.ehlo(); s.starttls(context=ctx); s.ehlo()
                s.login(user, password)
                s.send_message(msg)
        else:
            with smtplib.SMTP_SSL(host, port, timeout=20, context=ctx) as s:
                s.login(user, password)
                s.send_message(msg)
        print("✓ Test email sent. Check your inbox.")
        return True
    except Exception as e:
        print("✗ Failed to send test email:", e)
        return False


def wizard():
    print("=" * 60)
    print("  MiroxAI SMTP Setup")
    print("=" * 60)

    cfg = load_config()
    existing = cfg.get("smtp") or {}

    print("\nChoose your provider:")
    names = list(PRESETS.keys())
    for i, name in enumerate(names, 1):
        print(f"  {i}) {name.capitalize()}")
    sel = prompt("Number", "1")
    try:
        idx = int(sel) - 1
        if idx < 0 or idx >= len(names):
            raise ValueError
        provider_key = names[idx]
    except Exception:
        print("Invalid choice.")
        sys.exit(1)

    preset = PRESETS[provider_key]
    print(f"\nProvider: {provider_key}")
    print("Hint:", preset["hint"])

    host = prompt("SMTP host", existing.get("host") or preset["host"])
    port = int(prompt("SMTP port", str(existing.get("port") or preset["port"])))
    use_tls = prompt_yes_no("Use STARTTLS (recommended)", existing.get("use_tls", preset["use_tls"]))

    print("\nLogin credentials (kept in config.json — used only by the local bridge):")
    user = prompt("SMTP username (usually your full email)", existing.get("user", ""))
    pwd = prompt("SMTP password / app password", existing.get("pass", ""))
    from_addr = prompt("From address (leave blank to use username)", existing.get("from") or user)

    ok = test_connection(host, port, use_tls, user, pwd)
    if not ok:
        if not prompt_yes_no("Save anyway?", default=False):
            print("Aborted.")
            sys.exit(1)

    cfg["smtp"] = {
        "enabled": True,
        "host": host,
        "port": port,
        "use_tls": bool(use_tls),
        "user": user,
        "pass": pwd,
        "from": from_addr,
    }
    save_config(cfg)
    print(f"\n✓ Saved SMTP config to {CONFIG_FILE}")

    if prompt_yes_no("Send a test email now?", default=True):
        to_addr = prompt("Send to", from_addr or user)
        send_test_email(host, port, use_tls, user, pwd, from_addr, to_addr)

    print("\nDone. Restart the bridge (runner.py) for the new SMTP settings to take effect.")


# ---------------- Local test SMTP server ----------------
def run_local_test_server(host="127.0.0.1", port=1025):
    """A tiny in-process SMTP server that prints incoming messages to stdout.

    Useful for development: point your app at 127.0.0.1:1025 and see what
    Mirox would send, without actually emailing anyone.
    """
    try:
        from aiosmtpd.controller import Controller
        from aiosmtpd.handlers import Debugging
    except ImportError:
        print("This local test server needs aiosmtpd:")
        print("    pip install aiosmtpd")
        sys.exit(1)

    print("=" * 60)
    print(f"  Local SMTP test server on {host}:{port}")
    print("  Incoming messages will be printed here.")
    print("  Press Ctrl+C to stop.")
    print("=" * 60)

    controller = Controller(Debugging(), hostname=host, port=port)
    controller.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping…")
    finally:
        controller.stop()


# ---------------- CLI ----------------
def main():
    ap = argparse.ArgumentParser(description="MiroxAI SMTP setup & test tools")
    ap.add_argument("--local-server", action="store_true",
                    help="Run a local SMTP server on 127.0.0.1:1025 (for testing only).")
    ap.add_argument("--port", type=int, default=1025, help="Port for --local-server.")
    ap.add_argument("--show", action="store_true", help="Show the current SMTP config (password masked).")
    ap.add_argument("--clear", action="store_true", help="Remove the SMTP config from config.json.")
    args = ap.parse_args()

    if args.local_server:
        run_local_test_server(port=args.port)
        return

    if args.show:
        cfg = load_config()
        smtp = cfg.get("smtp") or {}
        if not smtp:
            print("No SMTP config yet. Run without arguments to set up.")
            return
        masked = dict(smtp)
        if masked.get("pass"):
            masked["pass"] = "•" * min(12, len(masked["pass"]))
        print(json.dumps(masked, indent=2))
        return

    if args.clear:
        cfg = load_config()
        cfg.pop("smtp", None)
        save_config(cfg)
        print("SMTP config removed.")
        return

    wizard()


if __name__ == "__main__":
    main()

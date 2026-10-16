# MiroxAI Bridge Client

Connect your laptop to MiroxAI so the AI can:
- Use the **Mirox Code** profile for practical Python project work (plan, create files, run checks, and report results).
- Run shell commands (only in folders you allow)
- Write files
- Read files
- List directories
- Send email, use git, read/write the clipboard, take screenshots (optional)

The bridge listens on http://127.0.0.1:8765 and only accepts connections from your own machine.

## Install

1. Install Python 3.10 or newer.
2. Install the dependencies from this folder:

   ```bash
   pip install -r requirements.txt
   ```

   On Linux systems that block global pip installs, use a virtual environment:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

## Configure

Edit `config.json`:

- `bridge_name`: the name shown in MiroxAI.
- `port`: the local port (default 8765).
- `allowed_dirs`: folders the AI may touch. `"."` means your home folder.
- `max_output_bytes`: limit for command and file output.
- `coding_style`: default code-generation profile (`mirox-code`). This profile is intended for clean, practical Python projects and uses MiroxAI’s own avatar/mascot assets when a project needs an avatar; it does not copy Claude Code branding or assets.
- `smtp`: optional. Run `python smtp_setup.py` to fill this in with a wizard.

## Run

```bash
python runner.py
```

You should see the home folder, allowed folders, and which features are available. Leave the window open while you use MiroxAI. Press Ctrl+C to stop.

## Troubleshooting

- **"Missing dependency: aiohttp"**: run `pip install -r requirements.txt` in this folder.
- **"Failed to start: address already in use"**: another program is using the port. Change `port` in `config.json`.
- **"Path not allowed"**: the requested folder is outside `allowed_dirs`. Add it to `allowed_dirs` and restart the bridge.
- **Sudo commands**: the bridge never stores your sudo password on disk. It is kept in memory only while the bridge runs.

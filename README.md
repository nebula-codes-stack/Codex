# Nova Terminal

![Nova Terminal preview](docs/preview.svg)

Nova Terminal is a beautiful browser-based shell for local development. The UI is custom-built for this project, while the terminal emulation layer uses xterm.js because ANSI parsing, cursor addressing, scrollback, selection, and resize behavior are exactly the hard parts a real terminal should not fake.

## What it includes

- A polished glassmorphism terminal workspace in `public/`.
- A Node.js backend in `server/`.
- A WebSocket endpoint at `/terminal`.
- A real pseudo-terminal powered by `node-pty`.
- Resize support through the xterm fit addon.
- Clear and reconnect controls in the toolbar.
- Starter scripts for Linux, macOS, Windows Command Prompt, and Windows PowerShell.
- Password login at `/login` with a salted scrypt hash stored in `.nova/auth.json`.
- Simple pages for `/settings`, `/debug`, `/whats-new`, and `/something`.
- OS-detected quick command bars loaded from JSON files in `quick-commands/`.
- Detachable terminal sessions with stored output buffers, attach/reconnect support, logs, and session cleanup.
- Smooth page transitions, command palette, copy/download/clear-output actions, and responsive toolbar wrapping so controls stay inside the frame.

## Quick start

Pick the launcher for your operating system. Each launcher installs dependencies if `node_modules/` is missing, starts the Node.js server, opens the app in your browser, and sets terminal sessions to start in this project directory instead of `~`.

| OS / shell | Launcher |
| --- | --- |
| Linux / WSL / Git Bash | `./start.sh` |
| macOS Terminal | `./start.sh` |
| macOS Finder double-click | `start.command` |
| Windows Command Prompt | `start.bat` |
| Windows PowerShell | `./start.ps1` |

You can still run it manually:

```bash
npm install
npm run dev
```

Then open [http://127.0.0.1:3000/login](http://127.0.0.1:3000/login).


## Login and password hash

On first launch, Nova creates `.nova/auth.json` with a salted scrypt hash. Set your initial password before first launch:

```bash
NOVA_PASSWORD="change-me" ./start.sh
```

If you do not set `NOVA_PASSWORD`, the first-run password is `nova`. To reset it during local development, stop the server, delete `.nova/auth.json`, set `NOVA_PASSWORD`, and start Nova again.

## Configuration

You can change the bind address, port, terminal shell, or terminal working directory with environment variables. If `TERMINAL_CWD` is not set, the backend uses the project/server directory:

```bash
HOST=127.0.0.1 PORT=4000 TERMINAL_SHELL=/bin/zsh TERMINAL_CWD="$PWD" ./start.sh
```

On Windows PowerShell:

```powershell
$env:PORT = "4000"
$env:TERMINAL_SHELL = "powershell.exe"
./start.ps1
```

Set `NO_OPEN=1` if you do not want the starter to open your browser automatically. Runtime details are visible at `/settings` and `/debug` after login. Set `NOVA_STARTUP_COMMAND=""` to disable the visible first command; by default Nova runs `cd ~` before the connected banner appears so the user can see the shell move home first.



## Sessions, attach, and logs

Nova keeps terminal sessions alive after a browser socket disconnects. Use the Sessions panel to create, attach, rename, and close sessions. Each session stores a bounded output buffer in memory so a refreshed browser can reattach and replay recent output. Use the toolbar to copy output, download a `.log`, clear stored history, or open the command palette with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>K</kbd>.

Environment controls:

- `NOVA_SESSION_IDLE_MINUTES` controls how long detached sessions stay alive.
- `NOVA_OUTPUT_MAX_CHUNKS` and `NOVA_OUTPUT_MAX_BYTES` bound stored output memory.

## Quick commands

Nova detects the server OS and loads quick commands from JSON files in `quick-commands/`:

- `Ubuntu.json`
- `Linux.json`
- `Mac.json`
- `Windows.json`
- `Other.json`

Each item has a `label` and `command`. Clicking a quick-command button sends that command to the live terminal. User-defined quick commands can be edited in `/settings` and are stored in `.nova/quick-commands.user.json`.

## About the command line position

Nova keeps a real PTY connected to xterm.js, so the command prompt is controlled by the shell and terminal emulator. A separate fixed input box at the bottom would break interactive programs such as editors, prompts, pagers, and full-screen CLIs. The app now sends the browser terminal size before spawning the PTY, wraps toolbar buttons on small screens, replays stored output when attaching, and auto-scrolls to the bottom on output, which is the safest way to keep input visible without breaking real terminal behavior.

## Security warning

This application exposes shell access through a browser. By default, the server binds to `127.0.0.1` so it is only available locally. Do not bind it to a public interface unless you add authentication, authorization, TLS, audit logging, and strict session controls.

Recommended production hardening:

1. Require authentication before opening `/terminal`.
2. Run the PTY as an unprivileged user inside a container or sandbox.
3. Restrict working directories and environment variables.
4. Add rate limits and session timeouts.
5. Put the service behind HTTPS/WSS.

## Why xterm.js?

We build the product shell, layout, theme, controls, connection UX, launchers, and backend ourselves. We use xterm.js only for robust terminal emulation, because reproducing full terminal behavior from scratch would mean rebuilding years of ANSI/VT compatibility work before the app could be useful.

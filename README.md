# STRATEGOS — Autonomous Solana DeFi Agent

## First-time setup

1. Copy `.env.example` to `.env` and fill in your keys
2. Run the full dependency install:

```
npm install --legacy-peer-deps
```

3. Start the app:

```
npm start
```

## Dependencies

Some DeFi SDK packages (Orca Whirlpools, Marinade) have conflicting peer
dependencies. The `--legacy-peer-deps` flag is required for a clean install.

If any optional SDK is missing, the app will still launch — affected strategies
will degrade gracefully and log a warning instead of crashing.

## Daily Email Reports (Phase 4)

Strategos can send a daily intelligence briefing to your email at 6:00 AM local time.

### Gmail App Password Setup

1. Go to [myaccount.google.com](https://myaccount.google.com)
2. Navigate to **Security** and enable **2-Step Verification** (required)
3. Search for **App Passwords** and create one named "Strategos"
4. Copy the 16-character password into `.env` as `GMAIL_APP_PASSWORD`

> **This is NOT your regular Gmail password.** App Passwords are separate
> credentials generated specifically for third-party apps.

Add to your `.env`:

```
GMAIL_USER=your.gmail.address@gmail.com
GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
REPORT_RECIPIENT=email.to.receive.reports@gmail.com
```

If these variables are not set, reports are silently disabled and the app
functions normally.

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Launch the Electron app |
| `npm run install-all` | Install all deps with `--legacy-peer-deps` |
| `npm run build` | Build Windows installer + portable exe |
| `npm run build:installer` | Build Windows NSIS installer only |
| `npm run build:portable` | Build Windows portable exe only |

## Building the Windows EXE

### Prerequisites
1. Place icon files in assets/ folder:
   - assets/strategos.ico
   - assets/strategos_512.png
   - assets/strategos_256.png

2. Install build dependencies:
   npm install --legacy-peer-deps

### Build both installer and portable:
   npm run build

### Build installer only:
   npm run build:installer

### Build portable only:
   npm run build:portable

### Output
Built files appear in the dist/ folder:
- Strategos Setup X.X.X.exe    ← Installer (double-click to install)
- Strategos-Portable-X.X.X.exe ← Portable (run from anywhere)

### After installing
On first launch, Strategos will ask to add itself to Windows startup.
The .env file is preserved between uninstalls/reinstalls.

## System Tray

Closing the Strategos window no longer quits the app — it minimizes to the
Windows system tray so the agent keeps running. Right-click the tray icon
for quick actions (Start/Halt agent, Manual Sweep, Quit). Double-click the
tray icon to restore the dashboard.

## Auto-Launch on Startup

Strategos can launch automatically (minimized to tray) when you sign in to
Windows. Toggle this via the **Launch on Startup** switch in the Tactical
Config section of the sidebar. Auto-launch is enabled by default.

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

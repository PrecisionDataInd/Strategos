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

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Launch the Electron app |
| `npm run install-all` | Install all deps with `--legacy-peer-deps` |

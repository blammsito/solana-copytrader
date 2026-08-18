# solana-copytrader

Copy-trading bot for Solana memecoins. Watches a fixed list of wallets and
mirrors their SOL → token buys. Does **not** scan new launches, does **not**
chase momentum, and does **not** copy sells — it only mirrors buys from
wallets you explicitly choose to follow.

**Ships in dry-run mode by default.** In dry-run, the bot runs the full
pipeline — webhook ingestion, risk checks, spend accounting — and logs what
it *would* do, but never signs or sends a transaction. You must explicitly
set `DRY_RUN=false` to trade with real SOL.

## How it works

1. `walletMonitor.ts` runs a small HTTP server that receives Helius
   "enhanced transaction" webhooks, checks whether the transaction's fee
   payer is one of your `TARGET_WALLETS`, and extracts a buy signal if the
   wallet just swapped SOL for a token.
2. `riskChecks.ts` runs three checks on the token before anything is
   bought. **Any single failure blocks the trade** (fails closed):
   - Mint authority and freeze authority are both renounced.
   - A sell route exists on Jupiter (catches honeypots that can be bought
     but not sold).
   - Buying your configured position size doesn't move the price more than
     5% (liquidity depth proxy).
3. `spendTracker.ts` enforces a rolling 24h spend cap and blocks re-buying
   the same mint within a configurable window (default 10 min), tracked in
   `spend-state.json`.
4. `executor.ts` gets a Jupiter quote and, if not in dry-run, builds and
   sends the swap transaction.
5. `index.ts` wires these together: signal → spend check → risk checks →
   execute → record.

There is deliberately no sell/exit logic yet — that's a separate decision
to make once you've watched the bot's buy behavior for a while.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `HELIUS_API_KEY` — from [helius.dev](https://helius.dev), free tier is
  enough to start.
- `TARGET_WALLETS` — comma-separated Solana addresses to copy. Leave empty
  and the bot will start but do nothing (see "Picking wallets" below).
- `HELIUS_WEBHOOK_SECRET` — any random string; the bot rejects webhook
  calls that don't send it as the `Authorization` header. Set the same
  value when you register the webhook in Helius.
- Leave `DRY_RUN=true` for now.

## Running in dry-run

```bash
npm run dev
```

This starts the webhook server on `WEBHOOK_PORT` (default 8080). To
receive real Helius webhooks, that port needs to be reachable from the
internet:

```bash
ngrok http 8080
```

Then, in the [Helius dashboard](https://dashboard.helius.dev) (or via
their webhook API), create an **enhanced webhook**:

- Webhook URL: `https://<your-ngrok-subdomain>.ngrok-free.app/webhook/helius`
- Transaction type(s): `SWAP` (you can widen this later if you find target
  wallets buying through venues Helius doesn't tag as SWAP)
- Account addresses: your `TARGET_WALLETS`
- Auth header: the same value as `HELIUS_WEBHOOK_SECRET`

Once wired up, any SOL→token buy from a watched wallet should show up in
your terminal as a `[walletMonitor] buy signal` log, followed by risk
check and spend check results. Nothing gets bought — dry-run just tells
you what it *would* have done.

ngrok URLs on the free tier change every restart, so you'll need to update
the webhook URL in Helius each time you restart ngrok. A paid ngrok static
domain, or deploying the bot somewhere with a stable URL, removes that
friction once you're past testing.

## Picking target wallets

`TARGET_WALLETS` is empty by default — the bot won't react to anything
until you populate it. Wallet selection isn't built into this bot yet;
worth deciding on criteria (win rate, hold time, position sizing
consistency, how early they typically buy, etc.) before picking wallets to
follow, likely using a Solana wallet analytics tool (e.g. a PnL/leaderboard
tracker) to shortlist candidates.

## Going live

1. Watch dry-run output for a while and confirm the buy signals and risk
   check verdicts look right for wallets you're following.
2. Set `WALLET_PRIVATE_KEY` (base58-encoded secret key) in `.env`. Use a
   dedicated wallet funded only with what you're willing to risk — not
   your main wallet.
3. Set `DRY_RUN=false`.
4. Start with a small `POSITION_SIZE_SOL` and `DAILY_SPEND_CAP_SOL` and
   raise them only after you trust the behavior.

## Config reference (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `DRY_RUN` | `true` | Set to `false` to send real transactions |
| `HELIUS_API_KEY` | — | required |
| `HELIUS_WEBHOOK_SECRET` | — | recommended, validates incoming webhooks |
| `HELIUS_RPC_URL` | derived from API key | override for a custom RPC |
| `WEBHOOK_PORT` | `8080` | local port for the webhook server |
| `TARGET_WALLETS` | — | comma-separated wallet addresses to copy |
| `WALLET_PRIVATE_KEY` | — | required only when `DRY_RUN=false` |
| `POSITION_SIZE_SOL` | `0.05` | SOL spent per copied buy |
| `DAILY_SPEND_CAP_SOL` | `0.5` | rolling 24h hard cap across all buys |
| `DUPLICATE_BUY_WINDOW_MIN` | `10` | won't re-buy the same mint within this window |
| `MAX_SLIPPAGE_BPS` | `300` | slippage tolerance passed to Jupiter |
| `JUPITER_API_URL` | `https://quote-api.jup.ag/v6` | Jupiter Swap API base |
| `SPEND_STATE_FILE` | `spend-state.json` | where spend/duplicate state is persisted |

## Known limitations / not yet done

- Never run against live webhook traffic yet — this build hasn't been
  exercised end-to-end, even in dry-run.
- No sell/exit logic (by design, for now).
- No wallet-evaluation tooling — you pick `TARGET_WALLETS` by hand.
- Single-process, single-machine: `spend-state.json` is local file state,
  not safe for multiple concurrent instances.
- Liquidity/price-impact check is a proxy, not a full order-book analysis.

# trend-scout (Cloudflare Worker)

A standalone helper for the bot's trend-following entry strategy. It runs
the same GeckoTerminal scan (trending pools -> OHLCV -> uptrend/pullback
check) as `src/trendScanner.ts`, but from Cloudflare's network instead of
Railway's — which sidesteps the shared-IP rate limiting the bot has been
hitting. Qualifying signals get POSTed to the bot's `/signals/trend`
endpoint and flow through the exact same conviction/risk/execution pipeline
as a signal found in-process.

This is separate from the main app's build — Railway only looks at the
repo root's `package.json`, so this folder doesn't affect your Railway
deploys at all. It deploys independently, straight to Cloudflare.

## One-time setup

You'll need a free Cloudflare account (no credit card required for this
usage level) and Node.js installed locally. All commands below run from
this folder (`workers/trend-scout`).

1. **Log in to Cloudflare** (opens a browser window to authorize):
   ```bash
   npx wrangler login
   ```

2. **Create the KV namespace** (stores which mints were recently signaled,
   so the same token isn't re-sent every 5 minutes):
   ```bash
   npx wrangler kv:namespace create TREND_KV
   ```
   This prints an `id = "..."`. Copy it into `wrangler.toml`, replacing
   `REPLACE_WITH_KV_NAMESPACE_ID`.

3. **Set your bot's control-API secret as a Worker secret** (same value as
   `CONTROL_API_SECRET` in the bot's Railway environment — never gets
   written to any file, stored encrypted by Cloudflare):
   ```bash
   npx wrangler secret put BOT_SECRET
   ```
   Paste the secret when prompted.

4. **Check `wrangler.toml`'s `BOT_URL`** matches your Railway public
   domain (already set to `https://solana-copytrader-production.up.railway.app`
   — update if that ever changes).

5. **Deploy:**
   ```bash
   npx wrangler deploy
   ```

## Verifying it's working

- **Trigger a run manually** (don't wait for the 5-minute cron) by opening
  the URL wrangler prints after deploy (something like
  `https://geckoterminal-trend-scout.<your-subdomain>.workers.dev`) in a
  browser, or:
  ```bash
  curl https://geckoterminal-trend-scout.<your-subdomain>.workers.dev
  ```
- **Watch live logs:**
  ```bash
  npx wrangler tail
  ```
  then trigger a run (either the cron firing naturally within 5 minutes, or
  hitting the URL above) and watch for `scan complete — N OHLCV calls, N
  signal(s) sent`.
- **Check the bot picked it up:** Railway logs should show
  `[controlServer] received external trend signal for <mint> from helper
  scanner`, followed by the normal conviction-scoring log line.

## Tuning

Thresholds live in the `CONFIG` object at the top of `src/index.js` —
they mirror `src/config.ts`'s `TREND_*` defaults on the bot itself. If you
change one side, consider updating the other so both scanners agree on
what counts as a real trend. `trendMaxOhlcvCallsPerRun` and the cron
schedule in `wrangler.toml` can be pushed more aggressively than the bot's
own Railway-side settings, since this Worker isn't the one being
throttled — GeckoTerminal's free tier is still 30 calls/min, so stay under
that (8 calls every 5 minutes here is comfortably inside it).

## Redeploying after a code change

```bash
npx wrangler deploy
```

No need to repeat the login/KV/secret setup steps — those persist.

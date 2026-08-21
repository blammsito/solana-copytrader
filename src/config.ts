import 'dotenv/config';
import fs from 'fs';
import path from 'path';

// Railway (and similar platforms) run the app from an ephemeral container
// filesystem — anything written under the app's own working directory is
// wiped on every restart or redeploy. A Railway Volume mounted at /data is
// the persistent alternative. If one's present, default all on-disk state
// (positions, trade ledger, spend tracking) there instead of next to the
// code, so a redeploy can never silently forget an open position again.
// Falls back to the working directory for local dev, where /data won't
// exist and persistence across restarts doesn't matter the same way.
const DATA_DIR = fs.existsSync('/data') ? '/data' : '.';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function parseWalletList(raw: string): string[] {
  return raw
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
}

export interface Config {
  dryRun: boolean;
  heliusApiKey: string;
  heliusWebhookSecret: string;
  heliusRpcUrl: string;
  webhookPort: number;
  targetWallets: string[];
  walletPrivateKey: string; // base58, only required if not dry run
  // Position size is no longer fixed — see conviction.ts. It's scaled
  // between these bounds based on a composite conviction score (momentum
  // strength, holder concentration health, wash-trading health).
  minPositionSizeSol: number;
  maxPositionSizeSol: number;
  dailySpendCapSol: number;
  duplicateBuyWindowMs: number;
  minLiquidityUsd: number;
  maxSlippageBps: number;
  maxPriceImpactPct: number;
  maxSellPriceImpactPct: number;
  jupiterApiUrl: string;
  jupiterApiKey: string;
  spendStateFile: string;
  // Exit strategy
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldMinutes: number;
  exitCheckIntervalSec: number;
  positionsStateFile: string;
  tradeLedgerFile: string;
  // ==== Smarter exits: trailing stop + partial scale-out ====
  // Once a position's profit reaches this ratio, the fixed STOP_LOSS_PCT
  // stops applying and a trailing stop takes over instead — the goal is to
  // stop giving back an entire winning move to the same noise the fixed
  // stop-loss has to tolerate on the way up. 0.2 = arms once +20% in profit.
  trailingStopArmPct: number;
  // How far (as a ratio) price is allowed to pull back from its peak, once
  // the trailing stop is armed, before it exits. Trails the peak upward as
  // new highs are made; never re-tightens on a pullback that doesn't exit.
  trailingStopPct: number;
  // Profit ratio at which a partial scale-out fires: sell PARTIAL_SCALE_OUT_FRACTION
  // of the position once, bank that profit for real, and let the remainder
  // ride under a breakeven-or-better floor plus the trailing stop above.
  // Set to 0 (or PARTIAL_SCALE_OUT_FRACTION to 0) to disable.
  partialTakeProfitPct: number;
  // Fraction of the position sold at the partial take-profit trigger (e.g.
  // 0.5 = sell half). The remainder keeps its own reduced cost basis and is
  // marked scaledOut so this can only fire once per position.
  partialScaleOutFraction: number;
  // How much worse (in %) our effective entry price is allowed to be versus
  // the source wallet's own fill price before we skip the buy. By the time
  // our webhook fires and we get a quote, seconds have passed and the source
  // wallet's buy may have already spiked the price — buying into that spike
  // is "chasing the pump" and is a major driver of the quick-stop-loss
  // pattern observed in real trades.
  maxEntryRunUpPct: number;
  // Seconds after entry during which stop-loss is not allowed to trigger.
  // Prices on brand-new pump.fun pools are extremely noisy in the first
  // seconds after any buy (including our own, which moves price on a thin
  // pool) — without a grace period, normal early volatility gets misread as
  // a real reversal and stops the position out almost immediately.
  stopLossGraceSec: number;
  // Milliseconds to wait between processing each position in an exit-check
  // cycle. Each position costs at least one Jupiter quote call, plus (when
  // an exit condition is hit) Helius RPC balance checks and a swap. With
  // enough open positions, firing all of that back-to-back in one tick was
  // enough to trip Jupiter's/Helius's rate limits in production, causing
  // 429s and "could not price" skips — including on live positions that
  // genuinely needed a stop-loss to fire. Spreading requests out over the
  // cycle trades a little exit-reaction latency for actually getting an
  // answer instead of a rate-limit error.
  exitCheckStaggerMs: number;
  // Discord webhook URL used to push a phone notification (via the Discord
  // mobile app) on every real buy/sell. Optional — if unset, notifications
  // are silently skipped so this never blocks the bot from running.
  discordWebhookUrl: string;
  // Shared secret for the small HTTP control API (controlServer.ts) that
  // lets you manually put a specific open position "on hold" — exitManager
  // skips it entirely (no take-profit/stop-loss/trailing/max-hold) until
  // you release it. Soft-required: if unset, the control endpoints refuse
  // every request with a clear error rather than the bot crashing on boot,
  // since this feature is optional.
  controlApiSecret: string;
  // ==== Own-trader entry strategy (launchMonitor.ts) ====
  // The bot no longer mirrors specific wallets — it watches every new
  // pump.fun launch itself via PumpPortal's websocket feed and buys into
  // ones showing real early momentum. This key is required: new-token
  // events are free, but per-token trade/volume tracking (subscribeTokenTrade)
  // is metered and needs an authenticated, funded PumpPortal account.
  pumpPortalApiKey: string;
  // How long after launch to keep counting buys/volume before giving up on
  // a token that never caught on. Short on purpose — the whole point is
  // catching momentum early, not confirming it after the move is over.
  momentumWindowSec: number;
  // Minimum number of buy transactions within the window before a token is
  // considered to have real momentum (not just one or two whale buys).
  momentumMinBuys: number;
  // Minimum SOL volume (buys only) within the window, required alongside
  // momentumMinBuys — combining count + volume avoids both a wash of tiny
  // dust buys and a single large buy looking like broad interest.
  momentumMinVolumeSol: number;
  // Hard-reject (in conviction.ts) if fewer than this many distinct wallets
  // made up the buy activity that triggered the signal. momentumMinBuys
  // alone can be satisfied by 2-3 wallets buying repeatedly — this is what
  // actually enforces "holder-backed": real, broad-based demand from many
  // separate buyers, not volume/count manufactured by a handful of wallets
  // (which is also a common wash-trading pattern the round-trip check alone
  // doesn't catch, since these wallets may never sell within the window).
  momentumMinUniqueBuyers: number;
  // Caps how many just-launched tokens we track buy/volume data for at
  // once. Each tracked token costs metered PumpPortal trade events, so this
  // bounds both cost and memory during a burst of new launches.
  momentumMaxConcurrent: number;
  // ==== "Stable" entry strategy: tokens that already migrated off the
  // pump.fun bonding curve to a real AMM (Raydium/PumpSwap). Runs alongside
  // the brand-new-launch strategy above on the same PumpPortal connection
  // (subscribeMigration) — a second, independent signal source feeding the
  // same conviction/risk/exit pipeline. A migration itself already proves
  // the token raised enough real buy pressure to graduate; this then looks
  // for a fresh burst of renewed momentum on the now-real pool, same
  // buys+volume+unique-buyers logic as the launch strategy but with looser
  // per-signal thresholds (a migrated pool's baseline activity is bigger
  // than a bonding-curve token's first seconds) and a longer window (less
  // frantic than sniping a token seconds old).
  stableMomentumWindowSec: number;
  stableMomentumMinBuys: number;
  stableMomentumMinVolumeSol: number;
  // Separate concurrency cap from momentumMaxConcurrent — migrations are far
  // less frequent than new launches, so this can reasonably be smaller.
  stableMaxConcurrent: number;
  // ==== Conviction scoring (conviction.ts) ====
  // Hard-reject a buy if the creator wallet holds more than this fraction
  // of total supply outright — a large personal stash outside the bonding
  // curve is a dump risk. Default 5% matches the commonly-cited rug-pull
  // threshold (see conviction.ts for sourcing).
  maxCreatorHoldingPct: number;
  // Hard-reject if holder ranks #2-#11 (the single largest holder is
  // excluded — pre-migration that's almost always the bonding curve's own
  // reserve, not a real holder) together hold more than this fraction of
  // total supply. Default 30%, same rationale as maxCreatorHoldingPct.
  maxTopHolderConcentrationPct: number;
  // Hard-reject if more than this fraction of buy volume in the momentum
  // window came from wallets that also sold within the same window — that
  // round-tripping pattern (buy then sell, not just accumulate) is the
  // clearest wash-trading signal available from trade data alone.
  maxRoundTripVolumeSharePct: number;
  // Hard-reject (in conviction.ts) if the token's marketCapSol has already
  // pulled back more than this fraction from its peak-within-the-window by
  // the time the buy/volume threshold was met — see launchMonitor.ts's
  // trigger() and the "buying the top" gate in conviction.ts. Clearing the
  // momentum threshold doesn't mean price is still climbing right now; this
  // catches the case where it already peaked and is fading.
  maxEntryPullbackFromPeakPct: number;
  // Window (seconds, from token creation/tracking start) within which buy
  // volume is counted toward the "sniper burst" gate below. Research on
  // Solana memecoin sniping found deployer-funded sniper wallets typically
  // buy within the same block as launch — a few seconds is generous enough
  // to catch that pattern without flagging every fast-but-organic launch.
  snipeBurstWindowSec: number;
  // Hard-reject (in conviction.ts) if more than this fraction of total buy
  // volume landed within snipeBurstWindowSec — looks like a coordinated/
  // insider same-block buy-in rather than momentum building organically
  // over the full window.
  maxEarlyBurstVolumeSharePct: number;
  // ==== Trend-following entry strategy (trendScanner.ts) — replaces the
  // reactive launch/migration momentum strategy above. Instead of reacting
  // to brand-new tokens seconds old, this periodically scans Solana's
  // trending pools (via GeckoTerminal's free public API, no key required)
  // for tokens that have already proven a real uptrend and pulled back into
  // a buyable dip — never a token still climbing straight up, never one
  // with no real trend behind it. ====
  // How often (seconds) to run a scan cycle.
  trendScanIntervalSec: number;
  // OHLCV candle size in minutes (GeckoTerminal's minute-timeframe
  // aggregate) and how many candles to pull per pool — together these set
  // the lookback window used to judge "is this a real uptrend." E.g. 15 x
  // 32 = an 8-hour lookback built from 15-minute candles.
  trendCandleAggregateMin: number;
  trendCandleLimit: number;
  // Minimum candles required before a trend judgement is trusted — too few
  // and there isn't enough history to distinguish a real trend from noise.
  trendMinCandles: number;
  // Minimum peak-vs-window-start gain required to count as a real,
  // tradeable uptrend rather than noise.
  trendMinGainPct: number;
  // The "buy the dip" zone: how far off the peak the current price must
  // have pulled back — too shallow (below the min) and we're still buying
  // near the top; too deep (above the max) and the trend may have already
  // broken down rather than just be pulling back.
  trendMinPullbackPct: number;
  trendMaxPullbackPct: number;
  // The current price must still be at least this much above where the
  // lookback window started — guards against a near-total round-trip back
  // to baseline being mistaken for a healthy pullback.
  trendMinFloorAboveStartPct: number;
  // Minimum fraction of run-up-leg candles (window start through the peak)
  // that must have closed up. Standard momentum-trading practice treats a
  // single outsized candle carrying an entire "trend" as unreliable — a
  // spike, not a real higher-highs/higher-lows structure — so this rejects
  // trends built from one lucky print rather than sustained buying.
  trendMinUpCandleRatio: number;
  // How the pullback leg's average candle volume is allowed to compare to
  // the run-up leg's average candle volume (as a ratio). A pullback that
  // trades on lighter volume than the rally that preceded it is a healthy
  // pause; one on volume as heavy or heavier looks like real distribution/
  // selling pressure rather than buyers just stepping back. 1.0 = pullback
  // volume can't exceed run-up volume at all.
  trendMaxPullbackVolumeRatio: number;
  // Minimum ratio of buys to sells (last 1h, from the free trending_pools
  // response) required to treat a candidate's recent activity as net
  // buying pressure rather than distribution. 1.0 = at least as many buys
  // as sells.
  trendMinBuySellRatio: number;
  // Minimum combined buy+sell transaction count (last 1h) before the
  // trendMinBuySellRatio check is trusted — too few transactions and the
  // ratio is just noise, so the check is skipped rather than applied.
  trendMinHourlyTxCount: number;
  // Cheap prefilters applied directly from the trending_pools response
  // (before spending part of the OHLCV call budget on a candidate).
  trendMinLiquidityUsd: number;
  trendMinVolume24hUsd: number;
  // Caps how many OHLCV calls a single scan cycle can make — keeps every
  // cycle well under GeckoTerminal's free-tier 30-calls/minute limit
  // regardless of how many pools are trending at once.
  trendMaxOhlcvCallsPerScan: number;
  // Once a mint has produced a signal, suppress re-signaling it again for
  // this many milliseconds — avoids repeatedly re-evaluating (and
  // re-spending risk-check RPC calls on) the same still-qualifying token
  // every single scan cycle.
  trendSignalCooldownMs: number;
  // Delay between successive GeckoTerminal API calls within a scan cycle.
  // Free tier is 30 calls/minute (1 every 2s) — spacing at slightly more
  // than that keeps every cycle safely under the limit.
  geckoTerminalRequestDelayMs: number;
  // If a scan cycle hits this many consecutive 429s in a row, stop that
  // cycle early rather than keep spending the call budget on requests that
  // are just going to fail — GeckoTerminal's rate limit appears to be
  // enforced against Railway's shared egress IP as a whole, not just this
  // process's own request rate, so backing off is sometimes the only
  // option regardless of how conservative our own pacing is.
  trendMax429BeforeAbort: number;
  // After a cycle hits trendMax429BeforeAbort, skip this many full scan
  // cycles entirely (no GeckoTerminal calls at all) before resuming normal
  // cadence. A per-call backoff alone wasn't enough in production — cycles
  // were still opening with most/all OHLCV calls immediately 429ing, which
  // points at a rate-limit window shared across everything on Railway's
  // egress IP, not just this process's own pacing. A real cooldown gives
  // that shared window time to actually clear.
  trendThrottleCooldownCycles: number;
}

function loadConfig(): Config {
  const dryRun = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';

  const targetWalletsRaw = process.env.TARGET_WALLETS ?? '';
  const targetWallets = parseWalletList(targetWalletsRaw);

  if (targetWallets.length === 0) {
    console.warn(
      '[config] TARGET_WALLETS is empty — the bot will not react to any wallet activity until you populate it.'
    );
  }

  const walletPrivateKey = process.env.WALLET_PRIVATE_KEY ?? '';
  if (!dryRun && !walletPrivateKey) {
    throw new Error(
      'WALLET_PRIVATE_KEY is required when DRY_RUN=false (live trading needs a signer).'
    );
  }

  const heliusApiKey = requireEnv('HELIUS_API_KEY');

  const jupiterApiKey = process.env.JUPITER_API_KEY ?? '';
  if (!jupiterApiKey) {
    console.warn(
      '[config] JUPITER_API_KEY is empty — Jupiter now requires a free API key (get one at https://portal.jup.ag). Quotes/swaps will fail without it.'
    );
  }

  return {
    dryRun,
    heliusApiKey,
    heliusWebhookSecret: process.env.HELIUS_WEBHOOK_SECRET ?? '',
    heliusRpcUrl:
      process.env.HELIUS_RPC_URL && process.env.HELIUS_RPC_URL.trim() !== ''
        ? process.env.HELIUS_RPC_URL
        : `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`,
    // Cloud platforms (Railway, Fly, etc.) inject PORT and expect the app to
    // listen on it — prefer that over WEBHOOK_PORT when present, so the same
    // code runs unmodified locally and in the cloud.
    webhookPort: Number(process.env.PORT ?? process.env.WEBHOOK_PORT ?? 8080),
    targetWallets,
    walletPrivateKey,
    minPositionSizeSol: Number(process.env.MIN_POSITION_SIZE_SOL ?? 0.03),
    maxPositionSizeSol: Number(process.env.MAX_POSITION_SIZE_SOL ?? 0.08),
    dailySpendCapSol: Number(process.env.DAILY_SPEND_CAP_SOL ?? 0.5),
    duplicateBuyWindowMs: Number(process.env.DUPLICATE_BUY_WINDOW_MIN ?? 10) * 60_000,
    minLiquidityUsd: Number(process.env.MIN_LIQUIDITY_USD ?? 5000),
    maxSlippageBps: Number(process.env.MAX_SLIPPAGE_BPS ?? 300),
    // Tightened from the original hardcoded 5% — reject buys where our own
    // position size would move the price more than this.
    maxPriceImpactPct: Number(process.env.MAX_PRICE_IMPACT_PCT ?? 0.03),
    // Separate, slightly looser cap on the *sell* side quote used by the
    // honeypot check — selling naturally has more impact than buying on thin
    // pools, so this catches "technically sellable but you'd lose most of it"
    // tokens without being so strict it flags healthy pools as honeypots.
    maxSellPriceImpactPct: Number(process.env.MAX_SELL_PRICE_IMPACT_PCT ?? 0.05),
    // Jupiter deprecated the old public quote-api.jup.ag/v6 endpoint. The
    // current free-tier endpoint is api.jup.ag/swap/v1, gated by an API key.
    jupiterApiUrl: process.env.JUPITER_API_URL ?? 'https://api.jup.ag/swap/v1',
    jupiterApiKey,
    // Defaults to DATA_DIR (the persistent /data volume on Railway, if
    // mounted — see the comment on DATA_DIR above) rather than a bare
    // filename, so this survives restarts/redeploys instead of silently
    // resetting to empty on every deploy.
    spendStateFile: process.env.SPEND_STATE_FILE ?? path.join(DATA_DIR, 'spend-state.json'),
    takeProfitPct: Number(process.env.TAKE_PROFIT_PCT ?? 0.5),
    stopLossPct: Number(process.env.STOP_LOSS_PCT ?? 0.2),
    maxHoldMinutes: Number(process.env.MAX_HOLD_MINUTES ?? 60),
    exitCheckIntervalSec: Number(process.env.EXIT_CHECK_INTERVAL_SEC ?? 30),
    // Same DATA_DIR rationale as spendStateFile above — this is the file
    // that makes an open position "exist" as far as exitManager is
    // concerned. Losing it on a redeploy doesn't close the position on-chain
    // (the wallet still holds the tokens); it just makes the bot forget it
    // needs to manage it, so it never gets sold by any rule again.
    positionsStateFile: process.env.POSITIONS_STATE_FILE ?? path.join(DATA_DIR, 'positions.json'),
    tradeLedgerFile: process.env.TRADE_LEDGER_FILE ?? path.join(DATA_DIR, 'trades.json'),
    trailingStopArmPct: Number(process.env.TRAILING_STOP_ARM_PCT ?? 0.2),
    trailingStopPct: Number(process.env.TRAILING_STOP_PCT ?? 0.15),
    partialTakeProfitPct: Number(process.env.PARTIAL_TAKE_PROFIT_PCT ?? 0.3),
    partialScaleOutFraction: Number(process.env.PARTIAL_SCALE_OUT_FRACTION ?? 0.5),
    maxEntryRunUpPct: Number(process.env.MAX_ENTRY_RUNUP_PCT ?? 0.2),
    stopLossGraceSec: Number(process.env.STOP_LOSS_GRACE_SEC ?? 45),
    exitCheckStaggerMs: Number(process.env.EXIT_CHECK_STAGGER_MS ?? 400),
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
    controlApiSecret: process.env.CONTROL_API_SECRET ?? '',
    // Soft-required, not requireEnv(): standalone scripts (report.ts,
    // vetSniperWallets.ts, convictionReport.ts) all import config.ts but
    // never touch PumpPortal, and shouldn't crash just because a local
    // .env doesn't have this set. launchMonitor.ts — the actual consumer —
    // checks this itself and refuses to start without it, so the real bot
    // process still fails loud rather than silently running with no feed.
    pumpPortalApiKey: process.env.PUMPPORTAL_API_KEY ?? '',
    momentumWindowSec: Number(process.env.MOMENTUM_WINDOW_SEC ?? 20),
    // Tightened from 8/3 — raises the bar for what counts as "real"
    // momentum in the first place, before conviction scoring even runs.
    momentumMinBuys: Number(process.env.MOMENTUM_MIN_BUYS ?? 10),
    momentumMinVolumeSol: Number(process.env.MOMENTUM_MIN_VOLUME_SOL ?? 4),
    momentumMinUniqueBuyers: Number(process.env.MOMENTUM_MIN_UNIQUE_BUYERS ?? 6),
    momentumMaxConcurrent: Number(process.env.MOMENTUM_MAX_CONCURRENT ?? 40),
    stableMomentumWindowSec: Number(process.env.STABLE_MOMENTUM_WINDOW_SEC ?? 60),
    stableMomentumMinBuys: Number(process.env.STABLE_MOMENTUM_MIN_BUYS ?? 15),
    stableMomentumMinVolumeSol: Number(process.env.STABLE_MOMENTUM_MIN_VOLUME_SOL ?? 8),
    stableMaxConcurrent: Number(process.env.STABLE_MAX_CONCURRENT ?? 20),
    maxCreatorHoldingPct: Number(process.env.MAX_CREATOR_HOLDING_PCT ?? 0.05),
    maxTopHolderConcentrationPct: Number(process.env.MAX_TOP_HOLDER_CONCENTRATION_PCT ?? 0.3),
    maxRoundTripVolumeSharePct: Number(process.env.MAX_ROUND_TRIP_VOLUME_SHARE_PCT ?? 0.5),
    maxEntryPullbackFromPeakPct: Number(process.env.MAX_ENTRY_PULLBACK_FROM_PEAK_PCT ?? 0.15),
    snipeBurstWindowSec: Number(process.env.SNIPE_BURST_WINDOW_SEC ?? 3),
    maxEarlyBurstVolumeSharePct: Number(process.env.MAX_EARLY_BURST_VOLUME_SHARE_PCT ?? 0.65),
    trendScanIntervalSec: Number(process.env.TREND_SCAN_INTERVAL_SEC ?? 600),
    trendCandleAggregateMin: Number(process.env.TREND_CANDLE_AGGREGATE_MIN ?? 15),
    trendCandleLimit: Number(process.env.TREND_CANDLE_LIMIT ?? 32),
    trendMinCandles: Number(process.env.TREND_MIN_CANDLES ?? 12),
    trendMinGainPct: Number(process.env.TREND_MIN_GAIN_PCT ?? 0.4),
    trendMinPullbackPct: Number(process.env.TREND_MIN_PULLBACK_PCT ?? 0.1),
    trendMaxPullbackPct: Number(process.env.TREND_MAX_PULLBACK_PCT ?? 0.35),
    trendMinFloorAboveStartPct: Number(process.env.TREND_MIN_FLOOR_ABOVE_START_PCT ?? 0.15),
    trendMinUpCandleRatio: Number(process.env.TREND_MIN_UP_CANDLE_RATIO ?? 0.35),
    trendMaxPullbackVolumeRatio: Number(process.env.TREND_MAX_PULLBACK_VOLUME_RATIO ?? 1.0),
    trendMinBuySellRatio: Number(process.env.TREND_MIN_BUY_SELL_RATIO ?? 1.0),
    trendMinHourlyTxCount: Number(process.env.TREND_MIN_HOURLY_TX_COUNT ?? 10),
    trendMinLiquidityUsd: Number(process.env.TREND_MIN_LIQUIDITY_USD ?? 10000),
    trendMinVolume24hUsd: Number(process.env.TREND_MIN_VOLUME_24H_USD ?? 20000),
    trendMaxOhlcvCallsPerScan: Number(process.env.TREND_MAX_OHLCV_CALLS_PER_SCAN ?? 1),
    trendSignalCooldownMs: Number(process.env.TREND_SIGNAL_COOLDOWN_MIN ?? 30) * 60_000,
    geckoTerminalRequestDelayMs: Number(process.env.GECKOTERMINAL_REQUEST_DELAY_MS ?? 8000),
    trendMax429BeforeAbort: Number(process.env.TREND_MAX_429_BEFORE_ABORT ?? 5),
    trendThrottleCooldownCycles: Number(process.env.TREND_THROTTLE_COOLDOWN_CYCLES ?? 2),
  };
}

export const config = loadConfig();

if (!config.controlApiSecret) {
  console.warn(
    '[config] CONTROL_API_SECRET is not set — the hold/release control API will refuse all requests until you set it.'
  );
}

if (!config.dryRun) {
  console.warn(
    '[config] DRY_RUN=false — this instance will send real transactions and spend real SOL.'
  );
}

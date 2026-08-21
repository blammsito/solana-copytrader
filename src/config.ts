import 'dotenv/config';

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
  // Caps how many just-launched tokens we track buy/volume data for at
  // once. Each tracked token costs metered PumpPortal trade events, so this
  // bounds both cost and memory during a burst of new launches.
  momentumMaxConcurrent: number;
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
    spendStateFile: process.env.SPEND_STATE_FILE ?? 'spend-state.json',
    takeProfitPct: Number(process.env.TAKE_PROFIT_PCT ?? 0.5),
    stopLossPct: Number(process.env.STOP_LOSS_PCT ?? 0.2),
    maxHoldMinutes: Number(process.env.MAX_HOLD_MINUTES ?? 60),
    exitCheckIntervalSec: Number(process.env.EXIT_CHECK_INTERVAL_SEC ?? 30),
    positionsStateFile: process.env.POSITIONS_STATE_FILE ?? 'positions.json',
    tradeLedgerFile: process.env.TRADE_LEDGER_FILE ?? 'trades.json',
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
    momentumMinBuys: Number(process.env.MOMENTUM_MIN_BUYS ?? 8),
    momentumMinVolumeSol: Number(process.env.MOMENTUM_MIN_VOLUME_SOL ?? 3),
    momentumMaxConcurrent: Number(process.env.MOMENTUM_MAX_CONCURRENT ?? 40),
    maxCreatorHoldingPct: Number(process.env.MAX_CREATOR_HOLDING_PCT ?? 0.05),
    maxTopHolderConcentrationPct: Number(process.env.MAX_TOP_HOLDER_CONCENTRATION_PCT ?? 0.3),
    maxRoundTripVolumeSharePct: Number(process.env.MAX_ROUND_TRIP_VOLUME_SHARE_PCT ?? 0.5),
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

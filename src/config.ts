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
  positionSizeSol: number;
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
    positionSizeSol: Number(process.env.POSITION_SIZE_SOL ?? 0.05),
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
    maxEntryRunUpPct: Number(process.env.MAX_ENTRY_RUNUP_PCT ?? 0.2),
    stopLossGraceSec: Number(process.env.STOP_LOSS_GRACE_SEC ?? 45),
    exitCheckStaggerMs: Number(process.env.EXIT_CHECK_STAGGER_MS ?? 400),
  };
}

export const config = loadConfig();

if (!config.dryRun) {
  console.warn(
    '[config] DRY_RUN=false — this instance will send real transactions and spend real SOL.'
  );
}

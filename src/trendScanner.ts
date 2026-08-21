import { config } from './config';
import { BuySignal } from './walletMonitor';

type SignalHandler = (signal: BuySignal) => void | Promise<void>;

const GT_BASE = 'https://api.geckoterminal.com/api/v2';

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface TrendAnalysis {
  qualifies: boolean;
  overallGainPct: number;
  pullbackFromPeakPct: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gtFetch(path: string): Promise<any> {
  const res = await fetch(`${GT_BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Judges whether a run of OHLCV candles (ascending by time) represents a
 * real uptrend that has since pulled back into a buyable "dip" zone, rather
 * than either (a) a flat/declining token that never had real momentum, or
 * (b) a token still at/near its high with no pullback yet (chasing the top
 * — the exact pattern the pullback-from-peak gate in the old momentum
 * strategy was built to avoid).
 *
 * - overallGainPct: peak high vs. the window's starting close. Must clear
 *   trendMinGainPct to count as a real trend, not noise.
 * - peakReachedLateEnough: the peak can't be the very first candle — that
 *   would mean the "trend" is just the window starting already-elevated,
 *   not a climb we can actually observe.
 * - pullbackFromPeakPct: how far the latest close has fallen from that
 *   peak. Must land inside [trendMinPullbackPct, trendMaxPullbackPct] — too
 *   shallow and we're still buying near the top; too deep and the trend
 *   may have already broken down rather than just be pulling back.
 * - aboveFloor: the current price must still be meaningfully above where
 *   the window started, so a "dip" can't be a near-total round-trip back
 *   to baseline wearing a pullback's clothing.
 */
function analyzeTrend(candles: Candle[]): TrendAnalysis {
  const startClose = candles[0].close;
  let peakHigh = -Infinity;
  let peakIdx = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].high > peakHigh) {
      peakHigh = candles[i].high;
      peakIdx = i;
    }
  }
  const current = candles[candles.length - 1].close;

  if (!(startClose > 0) || !(peakHigh > 0) || !(current > 0)) {
    return { qualifies: false, overallGainPct: 0, pullbackFromPeakPct: 0 };
  }

  const overallGainPct = (peakHigh - startClose) / startClose;
  const pullbackFromPeakPct = (peakHigh - current) / peakHigh;
  const peakReachedLateEnough = peakIdx >= Math.floor(candles.length * 0.15);
  const aboveFloor = current >= startClose * (1 + config.trendMinFloorAboveStartPct);

  const isUptrend = overallGainPct >= config.trendMinGainPct && peakReachedLateEnough;
  const isGoodDip =
    pullbackFromPeakPct >= config.trendMinPullbackPct && pullbackFromPeakPct <= config.trendMaxPullbackPct;

  return {
    qualifies: isUptrend && isGoodDip && aboveFloor,
    overallGainPct,
    pullbackFromPeakPct,
  };
}

async function scanOnce(onSignal: SignalHandler, tracked: Map<string, number>): Promise<void> {
  let json: any;
  try {
    json = await gtFetch('/networks/solana/trending_pools?include=base_token,quote_token');
  } catch (err) {
    console.warn(`[trendScanner] failed to fetch trending pools: ${(err as Error).message}`);
    return;
  }

  const pools: any[] = json?.data ?? [];
  const included: any[] = json?.included ?? [];
  const tokenById = new Map(included.filter((r) => r.type === 'token').map((r) => [r.id, r]));

  const now = Date.now();
  let ohlcvCallsThisCycle = 0;
  let consecutive429Delay = 0;
  let consecutive429Count = 0;

  for (const pool of pools) {
    if (ohlcvCallsThisCycle >= config.trendMaxOhlcvCallsPerScan) break;

    const attrs = pool.attributes ?? {};
    const baseTokenRel = pool.relationships?.base_token?.data;
    const baseToken = baseTokenRel ? tokenById.get(baseTokenRel.id) : null;
    const mint: string | undefined = baseToken?.attributes?.address;
    if (!mint) continue;

    const lastSignaledAt = tracked.get(mint);
    if (lastSignaledAt && now - lastSignaledAt < config.trendSignalCooldownMs) continue;

    // Cheap prefilter using data already in the trending_pools response —
    // no extra API call — before spending part of the OHLCV budget on this
    // candidate.
    const liquidityUsd = Number(attrs.reserve_in_usd ?? 0);
    const volume24hUsd = Number(attrs.volume_usd?.h24 ?? 0);
    if (liquidityUsd < config.trendMinLiquidityUsd || volume24hUsd < config.trendMinVolume24hUsd) continue;

    const poolAddress = attrs.address;
    if (!poolAddress) continue;

    let ohlcv: any;
    try {
      // GeckoTerminal's documented free-tier limit is 30 calls/min, but in
      // practice a shared PaaS egress IP (Railway routes many unrelated
      // tenants through the same pool of outbound IPs) can trip 429s well
      // before that, since the limit is almost certainly enforced per-IP
      // against combined traffic we don't control. consecutive429Delay
      // adapts to that: every 429 slows down the rest of this cycle rather
      // than hammering an endpoint that's already told us to back off.
      await sleep(config.geckoTerminalRequestDelayMs + consecutive429Delay);
      ohlcvCallsThisCycle += 1;
      ohlcv = await gtFetch(
        `/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=${config.trendCandleAggregateMin}&limit=${config.trendCandleLimit}`
      );
      consecutive429Delay = 0;
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[trendScanner] OHLCV fetch failed for ${mint}: ${message}`);
      if (message.includes('429')) {
        consecutive429Delay = Math.min(consecutive429Delay + 3000, 15000);
        consecutive429Count += 1;
        if (consecutive429Count >= config.trendMax429BeforeAbort) {
          console.warn(
            `[trendScanner] ${consecutive429Count} consecutive rate-limit errors — GeckoTerminal is throttling this IP hard right now, ending this scan cycle early rather than continuing to spend the call budget on failures`
          );
          break;
        }
      }
      continue;
    }

    const rawCandles: number[][] = ohlcv?.data?.attributes?.ohlcv_list ?? [];
    if (rawCandles.length < config.trendMinCandles) continue;

    const candles: Candle[] = rawCandles
      .map(([timestamp, open, high, low, close, volume]) => ({ timestamp, open, high, low, close, volume }))
      .sort((a, b) => a.timestamp - b.timestamp);

    const analysis = analyzeTrend(candles);
    if (!analysis.qualifies) continue;

    tracked.set(mint, now);

    console.log(
      `[trendScanner] TREND signal: ${mint} (${attrs.name ?? 'unknown'}) — ` +
        `+${(analysis.overallGainPct * 100).toFixed(0)}% over the lookback window, now ` +
        `${(analysis.pullbackFromPeakPct * 100).toFixed(1)}% off peak (buy-the-dip zone), ` +
        `liquidity $${liquidityUsd.toFixed(0)}, 24h volume $${volume24hUsd.toFixed(0)}`
    );

    const signal: BuySignal = {
      // No copied/creator wallet concept for a trend-discovered token —
      // kept as a readable placeholder for logs/notifications/position
      // provenance rather than an empty string.
      walletAddress: 'trend-scanner',
      mint,
      // Not a meaningful "SOL spent" figure for this strategy (there's no
      // single triggering trade) — left at 0. riskChecks.ts's
      // checkEntryMomentum only activates when tokensReceivedRaw is also
      // set, which it never is here, so this has no downstream effect.
      solSpent: 0,
      signature: '',
      timestamp: now,
      trend: {
        overallGainPct: analysis.overallGainPct,
        pullbackFromPeakPct: analysis.pullbackFromPeakPct,
        liquidityUsd,
        volume24hUsd,
        source: 'trend',
      },
    };

    try {
      await onSignal(signal);
    } catch (err) {
      console.error(`[trendScanner] signal handler failed for ${mint}`, err);
    }
  }

  // Prune cooldown entries once they've expired so this map doesn't grow
  // forever across a long-running process.
  for (const [mint, at] of tracked) {
    if (now - at > config.trendSignalCooldownMs) tracked.delete(mint);
  }
}

/**
 * Replaces the old reactive, seconds-old-launch momentum strategy
 * (launchMonitor.ts, still in the repo but no longer wired into index.ts)
 * with a periodic scan across all of Solana's trending pools via
 * GeckoTerminal's free public API — no PumpPortal dependency, no per-token
 * websocket subscription cost.
 *
 * Each cycle: pull the current trending-pools list, cheaply prefilter on
 * liquidity/volume already present in that response, then pull OHLCV
 * candles for the survivors and only signal a buy when a token has both
 * (a) a confirmed uptrend over the lookback window and (b) pulled back into
 * a configured "buy the dip" zone off its peak — see analyzeTrend() above.
 * This deliberately never buys a token that's still climbing straight up
 * (that's chasing the top) or one that's flat/declining (no real trend to
 * ride) — only ones that have proven a move and offered a better entry
 * than the peak.
 */
export function startTrendScanner(onSignal: SignalHandler): void {
  const tracked = new Map<string, number>();
  let scanning = false;

  console.log(
    `[trendScanner] starting — scanning Solana trending pools every ${config.trendScanIntervalSec}s | ` +
      `requires +${(config.trendMinGainPct * 100).toFixed(0)}% confirmed uptrend then a ` +
      `${(config.trendMinPullbackPct * 100).toFixed(0)}-${(config.trendMaxPullbackPct * 100).toFixed(0)}% pullback off peak (buy-the-dip) | ` +
      `min liquidity $${config.trendMinLiquidityUsd}, min 24h volume $${config.trendMinVolume24hUsd}`
  );

  const run = () => {
    if (scanning) {
      console.warn('[trendScanner] previous scan cycle still running — skipping this tick');
      return;
    }
    scanning = true;
    scanOnce(onSignal, tracked)
      .catch((err) => console.error('[trendScanner] scan cycle failed', err))
      .finally(() => {
        scanning = false;
      });
  };

  run();
  setInterval(run, config.trendScanIntervalSec * 1000);
}

/**
 * Cloudflare Worker "trend scout" — a standalone helper for the
 * solana-copytrader bot's trend-following entry strategy.
 *
 * Why this exists: the bot's own in-process scanner (src/trendScanner.ts,
 * running on Railway) kept getting 429'd by GeckoTerminal's free-tier rate
 * limit, almost certainly because Railway's outbound traffic shares a NAT
 * IP pool across many unrelated tenants — no amount of conservative pacing
 * from this one process fully avoids it. This Worker does the exact same
 * kind of scan (GeckoTerminal trending pools -> OHLCV -> uptrend/pullback
 * analysis) from Cloudflare's network instead, which isn't subject to that
 * same shared-IP throttling, and POSTs any qualifying signal to the bot's
 * POST /signals/trend endpoint. The bot treats it identically to a signal
 * found by its own scanner — same conviction scoring, same risk checks,
 * same duplicate-buy guards.
 *
 * This intentionally duplicates (rather than imports) the analysis logic
 * from src/trendScanner.ts, since Workers deploy as a single standalone
 * script with no access to the bot's own filesystem/module graph. If you
 * tune the thresholds in src/config.ts, consider updating the matching
 * constants below to keep both scanners' judgment consistent.
 */

const GT_BASE = 'https://api.geckoterminal.com/api/v2';

// Mirrors config.ts's trend-scanner defaults. Kept slightly more generous
// on call volume than the bot's own Railway-side settings, since this
// Worker isn't the one being throttled.
const CONFIG = {
  trendCandleAggregateMin: 15,
  trendCandleLimit: 32,
  trendMinCandles: 12,
  trendMinGainPct: 0.4,
  trendMinPullbackPct: 0.1,
  trendMaxPullbackPct: 0.35,
  trendMinFloorAboveStartPct: 0.15,
  trendMinUpCandleRatio: 0.35,
  trendMaxPullbackVolumeRatio: 1.0,
  trendMinBuySellRatio: 1.0,
  trendMinHourlyTxCount: 10,
  trendMinLiquidityUsd: 10000,
  trendMinVolume24hUsd: 20000,
  trendMaxOhlcvCallsPerRun: 8,
  trendSignalCooldownSec: 30 * 60,
  requestDelayMs: 500,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// See src/trendScanner.ts's identical guard on the bot side for the full
// rationale — a throttled API doesn't always fail fast, and a request that
// just hangs forever would otherwise stall this whole scan silently.
const GT_TIMEOUT_MS = 15_000;

async function gtFetch(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GT_TIMEOUT_MS);
  try {
    const res = await fetch(`${GT_BASE}${path}`, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`timed out after ${GT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/** Same judgment as analyzeTrend() in src/trendScanner.ts — see that file
 * for the full rationale behind each check. Expects candles pre-sorted
 * ascending by timestamp. */
function analyzeTrend(candles) {
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
  const aboveFloor = current >= startClose * (1 + CONFIG.trendMinFloorAboveStartPct);

  const isUptrend = overallGainPct >= CONFIG.trendMinGainPct && peakReachedLateEnough;
  const isGoodDip =
    pullbackFromPeakPct >= CONFIG.trendMinPullbackPct && pullbackFromPeakPct <= CONFIG.trendMaxPullbackPct;

  const runUpCandles = candles.slice(0, peakIdx + 1);
  const upCandleCount = runUpCandles.filter((c) => c.close > c.open).length;
  const upCandleRatio = runUpCandles.length > 0 ? upCandleCount / runUpCandles.length : 0;
  const hasRealStructure = upCandleRatio >= CONFIG.trendMinUpCandleRatio;

  const pullbackCandles = candles.slice(peakIdx);
  const avgVolume = (cs) => (cs.length > 0 ? cs.reduce((sum, c) => sum + c.volume, 0) / cs.length : 0);
  const runUpAvgVolume = avgVolume(runUpCandles);
  const pullbackAvgVolume = avgVolume(pullbackCandles);
  const isQuietPullback =
    runUpAvgVolume <= 0 || pullbackAvgVolume <= runUpAvgVolume * CONFIG.trendMaxPullbackVolumeRatio;

  return {
    qualifies: isUptrend && isGoodDip && aboveFloor && hasRealStructure && isQuietPullback,
    overallGainPct,
    pullbackFromPeakPct,
  };
}

async function sendSignal(env, mint, name, analysis, liquidityUsd, volume24hUsd) {
  const url = `${env.BOT_URL}/signals/trend?key=${encodeURIComponent(env.BOT_SECRET)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mint,
      overallGainPct: analysis.overallGainPct,
      pullbackFromPeakPct: analysis.pullbackFromPeakPct,
      liquidityUsd,
      volume24hUsd,
    }),
  });
  if (!res.ok) {
    throw new Error(`bot rejected signal for ${mint} (${name}): HTTP ${res.status} — ${await res.text()}`);
  }
}

async function runScan(env) {
  let json;
  try {
    json = await gtFetch('/networks/solana/trending_pools?include=base_token,quote_token');
  } catch (err) {
    console.warn(`failed to fetch trending pools: ${err.message}`);
    return;
  }

  const pools = json?.data ?? [];
  const included = json?.included ?? [];
  const tokenById = new Map(included.filter((r) => r.type === 'token').map((r) => [r.id, r]));

  const changeProxy = (pool) => {
    const pc = pool?.attributes?.price_change_percentage ?? {};
    const v = Number(pc.h6 ?? pc.h24 ?? pc.h1 ?? 0);
    return Number.isFinite(v) ? v : 0;
  };
  pools.sort((a, b) => changeProxy(b) - changeProxy(a));

  let ohlcvCalls = 0;
  let signalsSent = 0;

  for (const pool of pools) {
    if (ohlcvCalls >= CONFIG.trendMaxOhlcvCallsPerRun) break;

    const attrs = pool.attributes ?? {};
    const baseTokenRel = pool.relationships?.base_token?.data;
    const baseToken = baseTokenRel ? tokenById.get(baseTokenRel.id) : null;
    const mint = baseToken?.attributes?.address;
    if (!mint) continue;

    const cooldownKey = `signaled:${mint}`;
    if (await env.TREND_KV.get(cooldownKey)) continue;

    const liquidityUsd = Number(attrs.reserve_in_usd ?? 0);
    const volume24hUsd = Number(attrs.volume_usd?.h24 ?? 0);
    if (liquidityUsd < CONFIG.trendMinLiquidityUsd || volume24hUsd < CONFIG.trendMinVolume24hUsd) continue;

    const h1Tx = attrs.transactions?.h1;
    if (h1Tx) {
      const buys = Number(h1Tx.buys ?? NaN);
      const sells = Number(h1Tx.sells ?? NaN);
      if (Number.isFinite(buys) && Number.isFinite(sells) && buys + sells >= CONFIG.trendMinHourlyTxCount) {
        if (buys < sells * CONFIG.trendMinBuySellRatio) continue;
      }
    }

    const poolAddress = attrs.address;
    if (!poolAddress) continue;

    let ohlcv;
    try {
      await sleep(CONFIG.requestDelayMs);
      ohlcvCalls += 1;
      ohlcv = await gtFetch(
        `/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=${CONFIG.trendCandleAggregateMin}&limit=${CONFIG.trendCandleLimit}`
      );
    } catch (err) {
      console.warn(`OHLCV fetch failed for ${mint}: ${err.message}`);
      continue;
    }

    const rawCandles = ohlcv?.data?.attributes?.ohlcv_list ?? [];
    if (rawCandles.length < CONFIG.trendMinCandles) continue;

    const candles = rawCandles
      .map(([timestamp, open, high, low, close, volume]) => ({ timestamp, open, high, low, close, volume }))
      .sort((a, b) => a.timestamp - b.timestamp);

    const analysis = analyzeTrend(candles);
    if (!analysis.qualifies) continue;

    try {
      await sendSignal(env, mint, attrs.name ?? 'unknown', analysis, liquidityUsd, volume24hUsd);
      await env.TREND_KV.put(cooldownKey, '1', { expirationTtl: CONFIG.trendSignalCooldownSec });
      signalsSent += 1;
      console.log(
        `sent TREND signal: ${mint} (${attrs.name ?? 'unknown'}) — +${(analysis.overallGainPct * 100).toFixed(0)}% ` +
          `over the lookback window, now ${(analysis.pullbackFromPeakPct * 100).toFixed(1)}% off peak`
      );
    } catch (err) {
      console.error(err.message);
    }
  }

  console.log(`scan complete — ${ohlcvCalls} OHLCV calls, ${signalsSent} signal(s) sent`);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env));
  },
  // Lets you trigger a run manually by visiting the Worker's URL, handy for
  // testing the deployment before waiting on the cron schedule.
  async fetch(request, env, ctx) {
    ctx.waitUntil(runScan(env));
    return new Response('trend scout scan triggered — check `wrangler tail` for output\n');
  },
};

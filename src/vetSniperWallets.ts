import { config } from './config';

const ENH_URL = 'https://api.helius.xyz/v0/addresses';

interface RecentBuy {
  mint: string;
  timestamp: number;
  signature: string;
  source: string;
}

interface WalletVetResult {
  wallet: string;
  sampled: number;
  buysFound: number;
  medianLagSec?: number;
  avgLagSec?: number;
  pctUnder60s?: number;
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(config.heliusRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

/**
 * Walks getSignaturesForAddress backwards (newest-first, paginating via
 * `before`) until a page comes back under 1000 results, which means we've
 * reached the mint's genesis. Capped at maxPages for cost control — heavily
 * traded tokens can hit this cap before reaching true genesis, which shows
 * up downstream as a spuriously negative "entry lag" (the wallet's buy
 * predates the oldest signature we paged back to). Treat a negative lag as
 * "very early, precise value unmeasured" rather than literally negative.
 */
async function getMintCreationTime(mint: string, maxPages = 15): Promise<number | null> {
  let before: string | undefined;
  let lastPage: any[] | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page = await rpc('getSignaturesForAddress', [mint, { limit: 1000, before }]);
    if (!page || page.length === 0) break;
    lastPage = page;
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  if (!lastPage || lastPage.length === 0) return null;
  const oldest = lastPage[lastPage.length - 1];
  return oldest.blockTime ?? null;
}

/**
 * Pulls a wallet's recent SWAP-tagged transactions from Helius's Enhanced
 * Transactions API and picks out the pump.fun buys.
 *
 * Deliberately reads tokenTransfers rather than events.swap.tokenOutputs:
 * events.swap is only populated when Helius attributes the tx to a
 * Jupiter-routed swap (source: "JUPITER"). Direct AMM-sourced swaps (very
 * common for fast snipers buying straight off PUMP_AMM) come back with an
 * empty events object, but tokenTransfers is populated for every source —
 * it's the reliable signal.
 */
async function getRecentBuys(wallet: string, limit = 20): Promise<RecentBuy[]> {
  const url = `${ENH_URL}/${wallet}/transactions?api-key=${config.heliusApiKey}&limit=${limit}&type=SWAP`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`enhanced tx fetch failed (${res.status})`);
  const txs = (await res.json()) as any[];

  const buys: RecentBuy[] = [];
  for (const tx of txs) {
    const transfers = tx.tokenTransfers || [];
    const received = transfers.find(
      (t: any) => t.toUserAccount === wallet && t.mint && t.mint.toLowerCase().endsWith('pump')
    );
    if (!received) continue;
    buys.push({ mint: received.mint, timestamp: tx.timestamp, signature: tx.signature, source: tx.source });
  }
  return buys;
}

/**
 * Vets a single wallet's "sniper speed" — how quickly, in seconds, it tends
 * to buy newly launched pump.fun tokens after they're created on-chain.
 * Lower lag means the wallet is getting into coins earlier, which is the
 * whole point of copy-trading it.
 */
export async function vetWallet(wallet: string, buyLimit = 15): Promise<WalletVetResult> {
  const buys = await getRecentBuys(wallet, buyLimit);
  const lags: number[] = [];
  for (const b of buys) {
    try {
      const created = await getMintCreationTime(b.mint);
      if (created == null) continue;
      lags.push(b.timestamp - created);
    } catch (err) {
      console.warn(`  mint lookup failed for ${b.mint}: ${(err as Error).message}`);
    }
  }

  if (lags.length === 0) {
    return { wallet, sampled: 0, buysFound: buys.length };
  }

  const sorted = [...lags].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const avg = sorted.reduce((a, c) => a + c, 0) / sorted.length;
  const under60 = sorted.filter((v) => v <= 60).length;

  return {
    wallet,
    sampled: lags.length,
    buysFound: buys.length,
    medianLagSec: median,
    avgLagSec: Math.round(avg),
    pctUnder60s: Math.round((under60 / sorted.length) * 100),
  };
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmtLag(sec: number): string {
  if (sec < 0) return `<0s (very early, beyond page cap)`;
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

/**
 * Vets a list of wallets (default: the live TARGET_WALLETS list) and prints
 * a ranked report, fastest median entry lag first. Meant to be re-run
 * whenever evaluating candidate wallets for the copy-trading watchlist —
 * not just a one-off analysis.
 */
async function main() {
  const wallets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : config.targetWallets;

  if (wallets.length === 0) {
    console.log('No wallets to vet — pass addresses as args or set TARGET_WALLETS.');
    return;
  }

  console.log('='.repeat(72));
  console.log(`SNIPER-SPEED VETTING — ${wallets.length} wallet(s)`);
  console.log('='.repeat(72));

  const results: WalletVetResult[] = [];
  for (const wallet of wallets) {
    console.log(`\nVetting ${short(wallet)}...`);
    try {
      const result = await vetWallet(wallet);
      results.push(result);
    } catch (err) {
      console.warn(`  failed: ${(err as Error).message}`);
      results.push({ wallet, sampled: 0, buysFound: 0 });
    }
  }

  const ranked = results
    .filter((r) => r.sampled > 0)
    .sort((a, b) => (a.medianLagSec ?? Infinity) - (b.medianLagSec ?? Infinity));
  const unranked = results.filter((r) => r.sampled === 0);

  console.log('\n' + '-'.repeat(72));
  console.log('RANKED (fastest median entry lag first):');
  for (const r of ranked) {
    console.log(
      `  ${short(r.wallet)}   median ${fmtLag(r.medianLagSec!)}   avg ${fmtLag(r.avgLagSec!)}   ` +
        `${r.pctUnder60s}% within 60s   (${r.sampled}/${r.buysFound} buys measurable)`
    );
  }

  if (unranked.length > 0) {
    console.log('\nNo measurable data (no pump.fun buys found or all mint lookups failed):');
    for (const r of unranked) {
      console.log(`  ${short(r.wallet)}   (${r.buysFound} buys found, 0 measurable)`);
    }
  }
  console.log('='.repeat(72));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[vetSniperWallets] failed:', err);
    process.exit(1);
  });
}

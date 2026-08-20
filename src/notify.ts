import { config } from './config';

/**
 * Fire-and-forget Discord webhook notification. Used to alert on real
 * buy/sell events so they show up as a phone push notification (via
 * Discord's mobile app) without the user having to watch Railway logs.
 *
 * Deliberately never throws — a failed notification should never be able to
 * take down a buy/sell flow. If DISCORD_WEBHOOK_URL isn't set, this is a
 * silent no-op so notifications are fully optional.
 */
export async function notifyDiscord(message: string): Promise<void> {
  if (!config.discordWebhookUrl) return;
  try {
    const res = await fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    if (!res.ok) {
      console.error(`[notify] Discord webhook returned ${res.status}`);
    }
  } catch (err) {
    console.error('[notify] failed to send Discord notification', err);
  }
}

function shortAddr(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : addr;
}

export function notifyBuy(params: {
  mint: string;
  sourceWallet: string;
  solSpent: number;
  signature?: string;
  dryRun: boolean;
}): void {
  const { mint, sourceWallet, solSpent, signature, dryRun } = params;
  const tag = dryRun ? ' [DRY RUN]' : '';
  const link = !dryRun && signature ? `\nhttps://solscan.io/tx/${signature}` : '';
  void notifyDiscord(
    `🟢 **BUY**${tag} — copied ${shortAddr(sourceWallet)}\n` +
      `Token: \`${mint}\`\n` +
      `Spent: ${solSpent.toFixed(4)} SOL${link}`
  );
}

export function notifySell(params: {
  mint: string;
  pnlSol: number;
  pnlPct: number;
  exitReason: string;
  signature?: string;
  dryRun: boolean;
}): void {
  const { mint, pnlSol, pnlPct, exitReason, signature, dryRun } = params;
  const tag = dryRun ? ' [DRY RUN]' : '';
  const emoji = pnlSol >= 0 ? '🟢' : '🔴';
  const link = !dryRun && signature ? `\nhttps://solscan.io/tx/${signature}` : '';
  void notifyDiscord(
    `${emoji} **SELL**${tag} — ${exitReason}\n` +
      `Token: \`${mint}\`\n` +
      `P&L: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)${link}`
  );
}

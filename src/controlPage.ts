/**
 * Mobile-friendly HTML control page, served by controlServer.ts itself at
 * GET /control (gated by the same checkAuth() as every other route here) —
 * NOT a standalone local file. iOS Safari (and most mobile browsers) block
 * fetch() calls made from a file:// page regardless of CORS headers, so a
 * downloaded/AirDropped copy of this HTML can never successfully call the
 * API; serving it as a real https:// page under the bot's own domain avoids
 * that entirely (and also makes it same-origin, so no CORS is even needed
 * for this page's own requests — the earlier Access-Control-Allow-Origin
 * middleware stays in place for any other external callers).
 *
 * The page never has the secret hardcoded into its source. It reads `key`
 * from its own URL's query string (?key=...) — the same key that had to be
 * correct for checkAuth() to serve this page in the first place — and reuses
 * it for every /positions, /hold, /release call. Bookmark/Add-to-Home-Screen
 * the full URL including ?key=... for one-tap access.
 */
export const CONTROL_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Bot Control</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0b0d10;
    color: #e6e8eb;
    padding: env(safe-area-inset-top) 16px calc(env(safe-area-inset-bottom) + 16px);
  }
  header { display: flex; align-items: center; justify-content: space-between; padding: 20px 0 12px; }
  h1 { font-size: 20px; margin: 0; font-weight: 600; }
  #refreshBtn {
    background: #1b1f24; border: 1px solid #2a2f36; color: #e6e8eb;
    border-radius: 10px; padding: 10px 14px; font-size: 14px; font-weight: 500;
  }
  #refreshBtn:active { background: #262b32; }
  #status { font-size: 13px; color: #8a919c; padding-bottom: 10px; }
  .card { background: #14171b; border: 1px solid #23272d; border-radius: 14px; padding: 16px; margin-bottom: 12px; }
  .mint { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; color: #9fb4ff; word-break: break-all; margin-bottom: 8px; }
  .row { display: flex; justify-content: space-between; font-size: 14px; padding: 3px 0; color: #c3c8cf; }
  .row span:first-child { color: #8a919c; }
  .badges { display: flex; gap: 6px; margin: 10px 0 12px; flex-wrap: wrap; }
  .badge { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.02em; }
  .badge.held { background: #3a2e12; color: #f0b429; }
  .badge.scaled { background: #12302a; color: #3ecf8e; }
  .badge.dry { background: #22242a; color: #9096a1; }
  .actions { display: flex; gap: 10px; }
  button.action { flex: 1; border: none; border-radius: 10px; padding: 12px; font-size: 15px; font-weight: 600; }
  .holdBtn { background: #3a2e12; color: #f0b429; }
  .holdBtn:active { background: #4a3a16; }
  .releaseBtn { background: #12302a; color: #3ecf8e; }
  .releaseBtn:active { background: #16382f; }
  .empty { text-align: center; color: #6b7178; padding: 60px 20px; font-size: 15px; }
  .toast {
    position: fixed; left: 16px; right: 16px; bottom: calc(env(safe-area-inset-bottom) + 16px);
    background: #1b1f24; border: 1px solid #2a2f36; color: #e6e8eb; padding: 12px 16px;
    border-radius: 12px; font-size: 14px; text-align: center; opacity: 0;
    transform: translateY(8px); transition: opacity 0.2s, transform 0.2s; pointer-events: none;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
</style>
</head>
<body>

<header>
  <h1>Open Positions</h1>
  <button id="refreshBtn" onclick="load()">Refresh</button>
</header>
<div id="status">Loading…</div>
<div id="list"></div>
<div class="toast" id="toast"></div>

<script>
  // Same-origin page — relative URLs, and the key comes from this page's
  // own URL (never hardcoded into the served HTML).
  const KEY = new URLSearchParams(location.search).get('key') || '';

  const statusEl = document.getElementById('status');
  const listEl = document.getElementById('list');
  const toastEl = document.getElementById('toast');

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  function fmtSol(n) { return Number(n).toFixed(4) + ' SOL'; }

  function fmtAgo(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    return hrs + 'h ' + (mins % 60) + 'm ago';
  }

  function shortMint(m) { return m.slice(0, 6) + '…' + m.slice(-6); }

  async function load() {
    statusEl.textContent = 'Loading…';
    try {
      const res = await fetch('/positions?key=' + encodeURIComponent(KEY));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      render(data.positions || []);
      statusEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
    } catch (err) {
      statusEl.textContent = 'Failed to load: ' + err.message;
      listEl.innerHTML = '';
    }
  }

  function render(positions) {
    if (positions.length === 0) {
      listEl.innerHTML = '<div class="empty">No open positions right now.</div>';
      return;
    }
    listEl.innerHTML = positions.map((p) => \`
      <div class="card">
        <div class="mint">\${shortMint(p.mint)}</div>
        <div class="row"><span>Entry</span><span>\${fmtSol(p.entrySolSpent)}</span></div>
        <div class="row"><span>Bought</span><span>\${fmtAgo(p.boughtAt)}</span></div>
        \${p.peakPnlRatio != null ? '<div class="row"><span>Peak P&L</span><span>' + ((p.peakPnlRatio - 1) * 100).toFixed(1) + '%</span></div>' : ''}
        <div class="badges">
          \${p.held ? '<span class="badge held">On Hold</span>' : ''}
          \${p.scaledOut ? '<span class="badge scaled">Scaled Out</span>' : ''}
          \${p.dryRun ? '<span class="badge dry">Dry Run</span>' : ''}
        </div>
        <div class="actions">
          \${p.held
            ? '<button class="action releaseBtn" onclick="setHold(\\'' + p.mint + '\\', false, this)">Release</button>'
            : '<button class="action holdBtn" onclick="setHold(\\'' + p.mint + '\\', true, this)">Hold</button>'}
        </div>
      </div>
    \`).join('');
  }

  async function setHold(mint, hold, btn) {
    btn.disabled = true;
    btn.textContent = hold ? 'Holding…' : 'Releasing…';
    try {
      const res = await fetch('/positions/' + mint + '/' + (hold ? 'hold' : 'release') + '?key=' + encodeURIComponent(KEY), {
        method: 'POST',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      toast(hold ? 'Position placed on hold' : 'Position released');
      await load();
    } catch (err) {
      toast('Failed: ' + err.message);
      btn.disabled = false;
    }
  }

  load();
  setInterval(load, 30000);
</script>

</body>
</html>
`;

/* =========================================================================
 * TAPE QUOTES (nightly)
 * -------------------------------------------------------------------------
 * Plain Node 20, no dependencies. Pulls EOD quote + market cap for every
 * universe ticker plus the three ETF proxies from Finnhub, then POSTs one
 * payload to the worker. All API spend happens HERE, not in the worker.
 *
 * Env:
 *   FINNHUB_API_KEY     repo secret
 *   TAPE_SYNC_SECRET    repo secret (matches worker SYNC_SECRET)
 *   TAPE_WORKER_URL     optional, defaults to workers.dev host
 *
 * Pacing: Finnhub free tier is 60 calls/min. Two calls per bank ticker
 * (quote + profile2) and one per ETF proxy, spaced at 1100 ms, keeps a
 * ~140-name universe under six minutes with headroom.
 * ========================================================================= */

const FINNHUB = "https://finnhub.io/api/v1";
const WORKER = process.env.TAPE_WORKER_URL || "https://brw-bank-tape.joeysamowitz.workers.dev";
const KEY = process.env.FINNHUB_API_KEY;
const SECRET = process.env.TAPE_SYNC_SECRET;
const PROXIES = ["KRE", "KBE", "KBWB"];
const PACE_MS = 1100;

if (!SECRET) { console.error("TAPE_SYNC_SECRET missing"); process.exit(1); }
if (!KEY || KEY === "placeholder") {
  console.log("FINNHUB_API_KEY missing or placeholder, exiting green (no-op night).");
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fh(path, params) {
  const qs = new URLSearchParams({ ...params, token: KEY });
  const res = await fetch(`${FINNHUB}${path}?${qs}`);
  if (res.status === 429) {
    console.log("  429, backing off 65s");
    await sleep(65000);
    return fh(path, params);
  }
  if (!res.ok) throw new Error(`${path} ${params.symbol}: HTTP ${res.status}`);
  return res.json();
}

async function loadUniverse() {
  const res = await fetch(`${WORKER}/diag`);
  if (!res.ok) throw new Error(`worker /diag HTTP ${res.status}`);
  // diag confirms the worker is up; the ticker list itself comes from /api/tape
  const tape = await (await fetch(`${WORKER}/api/tape`)).json();
  const tickers = (tape.banks || []).map((b) => b.ticker).filter(Boolean);
  if (!tickers.length) throw new Error("universe empty: seed config:universe first (PUT /admin/universe)");
  return tickers;
}

async function main() {
  const tickers = await loadUniverse();
  console.log(`Universe: ${tickers.length} tickers + ${PROXIES.length} proxies`);

  const quotes = {};
  let ok = 0, fail = 0;
  for (const t of tickers) {
    try {
      const q = await fh("/quote", { symbol: t });
      await sleep(PACE_MS);
      const p = await fh("/stock/profile2", { symbol: t });
      await sleep(PACE_MS);
      if (q && typeof q.c === "number" && q.c > 0) {
        quotes[t] = {
          price: q.c,
          prevClose: q.pc ?? null,
          change: q.d ?? null,
          changePct: q.dp ?? null,
          marketCap: typeof p.marketCapitalization === "number" ? p.marketCapitalization : null // $millions
        };
        ok++;
      } else {
        console.log(`  ${t}: empty quote, skipped`);
        fail++;
      }
    } catch (e) {
      console.log(`  ${t}: ${e.message}`);
      fail++;
    }
  }

  const proxies = {};
  for (const t of PROXIES) {
    try {
      const q = await fh("/quote", { symbol: t });
      await sleep(PACE_MS);
      if (q && typeof q.c === "number" && q.c > 0) {
        proxies[t] = { price: q.c, change: q.d ?? null, changePct: q.dp ?? null };
      }
    } catch (e) {
      console.log(`  proxy ${t}: ${e.message}`);
    }
  }

  if (!ok) { console.error("No quotes retrieved, aborting POST so stale data survives."); process.exit(1); }

  const asOf = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${WORKER}/admin/quotes`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sync-secret": SECRET },
    body: JSON.stringify({ asOf, quotes, proxies })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST /admin/quotes HTTP ${res.status}: ${JSON.stringify(out)}`);
  console.log(`Posted ${ok} quotes (${fail} failed), proxies: ${Object.keys(proxies).join(", ")}. Worker: ${JSON.stringify(out)}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

/* =========================================================================
 * TAPE SEC (quarterly, after fundamentals)
 * -------------------------------------------------------------------------
 * Pulls HOLDCO-level tangible common equity from SEC EDGAR XBRL and POSTs
 * it to the tape worker. This is the plane the call report cannot see: the
 * traded entity is the holding company, and this measures the gap instead
 * of footnoting it. It also rescues multi-charter holdcos (WTFC), whose
 * 10-Q consolidates every charter.
 *
 *   holdco TCE = StockholdersEquity - preferred - goodwill - intangibles
 *
 * EDGAR facts: free, keyless, ~10 req/s, descriptive User-Agent REQUIRED.
 * companyconcept (one tag per call, small) is used instead of companyfacts
 * (one call, but tens of MB for the majors). Ticker -> CIK comes from the
 * SEC's own company_tickers.json. Fact selection: 10-Q/10-K USD facts with
 * end === the tape's fundamentals period, else the latest end on or before
 * it within 100 days; several filings for one end resolve to latest filed.
 * Units contract: XBRL is in DOLLARS; the worker stores call report
 * $thousands, so values are converted here (/1000) before the POST.
 *
 * Env: TAPE_SYNC_SECRET (required), TAPE_WORKER_URL (optional)
 * ========================================================================= */

const WORKER = process.env.TAPE_WORKER_URL || "https://brw-bank-tape.joeysamowitz.workers.dev";
const SECRET = process.env.TAPE_SYNC_SECRET;
const SEC = "https://data.sec.gov";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
/* SEC requires a descriptive UA with contact. Edit if the contact changes. */
const UA = "BankRegWire Bank Tape research tool (contact: bankregwire.com)";
const PACE_MS = 150;

if (!SECRET) { console.error("TAPE_SYNC_SECRET missing"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function secJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip" } });
  if (res.status === 404) return null;              /* tag not used by this filer */
  if (res.status === 429) { await sleep(2000); return secJson(url); }
  if (!res.ok) throw new Error(`SEC HTTP ${res.status} for ${url}`);
  return res.json();
}

/* ---- fact selection ----------------------------------------------------- */

function pickFact(concept, unitKey, periodYmd) {
  const units = concept && concept.units && concept.units[unitKey];
  if (!Array.isArray(units)) return null;
  const target = Date.parse(periodYmd);
  const usable = units.filter((f) =>
    f && f.end && (f.form === "10-Q" || f.form === "10-K" || f.form === "10-K/A" || f.form === "10-Q/A"));
  /* exact period end first, else latest end at or before it (within 100d) */
  let pool = usable.filter((f) => f.end === periodYmd);
  if (!pool.length) {
    pool = usable.filter((f) => {
      const e = Date.parse(f.end);
      return e <= target && target - e <= 100 * 86400000;
    });
    if (pool.length) {
      const best = pool.reduce((a, b) => (a.end > b.end ? a : b)).end;
      pool = pool.filter((f) => f.end === best);
    }
  }
  if (!pool.length) return null;
  /* several filings can restate one end; latest filed wins */
  const fact = pool.reduce((a, b) => ((a.filed || "") > (b.filed || "") ? a : b));
  return { value: fact.val, end: fact.end, form: fact.form, filed: fact.filed };
}

/* Tag ladders: first tag that yields a usable fact wins. */
const LADDERS = {
  equity:      { taxonomy: "us-gaap", unit: "USD", tags: ["StockholdersEquity"] },
  preferred:   { taxonomy: "us-gaap", unit: "USD", tags: [
                   "PreferredStockValue",
                   "PreferredStockValueOutstanding",
                   "PreferredStockIncludingAdditionalPaidInCapital",
                   "PreferredStockLiquidationPreferenceValue"
                 ], optional: true, zeroIsSuspect: true },
  minority:    { taxonomy: "us-gaap", unit: "USD", tags: ["MinorityInterest"], optional: true },
  goodwill:    { taxonomy: "us-gaap", unit: "USD", tags: ["Goodwill"], optional: true },
  intangibles: { taxonomy: "us-gaap", unit: "USD", tags: ["IntangibleAssetsNetExcludingGoodwill", "FiniteLivedIntangibleAssetsNet"], optional: true },
  shares:      { taxonomy: "dei",     unit: "shares", tags: ["EntityCommonStockSharesOutstanding"], optional: true }
};

async function fieldFor(cik, field, periodYmd, tally) {
  const spec = LADDERS[field];
  let zeroFact = null;   /* remembered, but never allowed to end the ladder */
  for (const tag of spec.tags) {
    const url = `${SEC}/api/xbrl/companyconcept/CIK${cik}/${spec.taxonomy}/${tag}.json`;
    const concept = await secJson(url);
    await sleep(PACE_MS);
    if (!concept) continue;
    const fact = pickFact(concept, spec.unit, periodYmd);
    if (!fact) continue;
    fact.tag = tag;
    /* Zero from a par-value line is not evidence of no preferred stock. Keep
       walking the ladder; fall back to the zero only if nothing better exists. */
    if (spec.zeroIsSuspect && !fact.value) { if (!zeroFact) zeroFact = fact; continue; }
    tally[`${field}:${tag}`] = (tally[`${field}:${tag}`] || 0) + 1;
    return fact;
  }
  if (zeroFact) {
    tally[`${field}:${zeroFact.tag} (zero)`] = (tally[`${field}:${zeroFact.tag} (zero)`] || 0) + 1;
    zeroFact.wasZero = true;
    return zeroFact;
  }
  return null;
}

/* ---- main ---------------------------------------------------------------- */

async function main() {
  const tape = await (await fetch(`${WORKER}/api/tape`)).json();
  const period = tape.period;
  if (!period) { console.error("Tape has no fundamentals period yet; run fundamentals first."); process.exit(1); }
  const universe = (tape.banks || []).filter((b) => b.ticker);
  console.log(`Holdco pass for ${universe.length} tickers against period ${period}`);

  const tickerMap = await secJson(TICKERS_URL);
  const cikFor = {};
  for (const row of Object.values(tickerMap || {})) {
    if (row && row.ticker) cikFor[String(row.ticker).toUpperCase()] = String(row.cik_str).padStart(10, "0");
  }

  const holdcos = {};
  const tally = {};
  let ok = 0, noCik = 0, noEquity = 0;

  for (const b of universe) {
    const cik = cikFor[b.ticker.toUpperCase()];
    if (!cik) { console.log(`  ${b.ticker}: no CIK in company_tickers.json`); noCik++; continue; }
    try {
      const eq = await fieldFor(cik, "equity", period, tally);
      if (!eq) { console.log(`  ${b.ticker}: no StockholdersEquity fact near ${period}`); noEquity++; continue; }
      const pref = await fieldFor(cik, "preferred", period, tally);
      const gw = await fieldFor(cik, "goodwill", period, tally);
      const intang = await fieldFor(cik, "intangibles", period, tally);
      const minority = await fieldFor(cik, "minority", period, tally);
      const shares = await fieldFor(cik, "shares", period, tally);

      /* XBRL dollars -> call report thousands */
      const K = (f) => (f ? Math.round(f.value / 1000) : 0);
      const tceK = K(eq) - K(pref) - K(minority) - K(gw) - K(intang);
      holdcos[b.ticker] = {
        cik,
        tceK,
        equityK: K(eq),
        preferredK: K(pref),
        goodwillK: K(gw),
        intangiblesK: K(intang),
        minorityK: K(minority),
        preferredTag: pref && !pref.wasZero ? pref.tag : null,
        shares: shares ? shares.value : null,
        factEnd: eq.end,
        form: eq.form,
        exactPeriod: eq.end === period
      };
      ok++;
      const B = (v) => (v / 1e6).toFixed(2);
      console.log(
        `  ${b.ticker.padEnd(6)} TCE $${B(tceK)}B  = eq ${B(K(eq))}` +
        ` - pref ${B(K(pref))}${pref && !pref.wasZero ? "" : "*"}` +
        ` - nci ${B(K(minority))}` +
        ` - gw ${B(K(gw))}${gw ? "" : "*"}` +
        ` - intang ${B(K(intang))}${intang ? "" : "*"}` +
        `  [${eq.form} ${eq.end}${eq.end === period ? "" : " NEAREST"}]`);
    } catch (e) {
      console.log(`  ${b.ticker}: ${e.message}`);
    }
  }

  console.log("\n  (* means the tag was not found and zero was used)");
  console.log(`\nResolved ${ok}/${universe.length} holdcos (${noCik} no CIK, ${noEquity} no equity fact).`);

  /* Cross-check against bank-level tangible book. A bank subsidiary carrying
     MORE tangible equity than its consolidated parent is real and common
     (double leverage: the holdco borrows and downstreams the proceeds), but
     an extreme ratio can equally mean a component tag was missed on either
     side. Print the tails so the difference is examined, not assumed. */
  const ratios = [];
  for (const b of universe) {
    const h = holdcos[b.ticker];
    if (!h || !h.tceK || b.tbv === null || b.tbv === undefined) continue;
    ratios.push({ ticker: b.ticker, r: b.tbv / h.tceK, noPref: !h.preferredTag });
  }
  ratios.sort((a, b) => b.r - a.r);
  const high = ratios.filter((x) => x.r > 1.10);
  if (high.length) {
    console.log(`\nBank book exceeds holdco tangible common by >10% at ${high.length} banks:`);
    console.log("  ticker  ratio  excess over holdco TCE  holdco gw+intangibles  explained");
    high.forEach((x) => {
      const h = holdcos[x.ticker];
      const bank = universe.find((u) => u.ticker === x.ticker);
      const excess = bank.tbv - h.tceK;
      const intangTotal = (h.goodwillK || 0) + (h.intangiblesK || 0);
      const share = intangTotal ? excess / intangTotal : null;
      console.log(
        `  ${x.ticker.padEnd(6)} ${(x.r * 100).toFixed(0)}%` +
        `   $${(excess / 1e6).toFixed(2)}B` +
        `                 $${(intangTotal / 1e6).toFixed(2)}B` +
        `             ${share === null ? "n/a" : (share * 100).toFixed(0) + "%"}` +
        (x.noPref ? "   [no preferred tag]" : ""));
    });
    console.log("  If 'explained' clusters near 100%, bank-level goodwill is not being");
    console.log("  subtracted on the call report side. If it scatters, the gap is real");
    console.log("  double leverage: holdco debt downstreamed as bank equity.");
  }
  const low = ratios.filter((x) => x.r < 0.70);
  if (low.length) {
    console.log(`\nBank book is under 70% of holdco tangible common at ${low.length} banks (large nonbank operations, or a lead-charter mismatch):`);
    low.forEach((x) => console.log(`  ${x.ticker.padEnd(6)} ${(x.r * 100).toFixed(0)}%`));
  }
  const noPref = ratios.filter((x) => x.noPref).length;
  if (noPref) console.log(`\n${noPref} banks resolved with no preferred tag. Genuine for banks with no preferred stock; overstates TCE for the rest.`);
  console.log("Tag usage (deploy verification):");
  for (const [k, n] of Object.entries(tally)) console.log(`  ${k.padEnd(46)} ${n}`);

  if (!ok) { console.error("Nothing resolved, aborting POST."); process.exit(1); }
  const res = await fetch(`${WORKER}/admin/sec`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sync-secret": SECRET },
    body: JSON.stringify({ period, holdcos })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST /admin/sec HTTP ${res.status}: ${JSON.stringify(out)}`);
  console.log(`\nPosted ${ok} holdcos for ${period}. Worker: ${JSON.stringify(out)}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

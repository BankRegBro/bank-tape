/* =========================================================================
 * TAPE FUNDAMENTALS (quarterly)
 * -------------------------------------------------------------------------
 * Plain Node 20, no dependencies. For every universe bank, pulls native
 * MDRM call report data through the EXISTING fdic.bankregwire.com worker
 * (/callreport, source=ffiec, KV-cached 30d there so FFIEC quota spend is
 * one pass per quarter), computes the Tape metrics, and POSTs one payload
 * to the bank-tape worker.
 *
 * Env:
 *   TAPE_SYNC_SECRET   repo secret (matches bank-tape worker SYNC_SECRET)
 *   TAPE_WORKER_URL    optional override
 *   CALLREPORT_BASE    optional, defaults to https://fdic.bankregwire.com
 *   TAPE_PERIOD        optional, e.g. 2026-03-31; defaults to "latest"
 *
 * The callreport worker is origin-gated, so requests carry the site origin.
 * Re-run safety: if the resolved period matches what the tape worker already
 * holds, the script exits green without spending quota.
 *
 * MDRM map (RCFD preferred, RCON fallback; worker mirrors 041/051 filers):
 *   3210 total equity          1754 HTM amortized cost   2170 total assets
 *   3163 goodwill              1771 HTM fair value       2200 total deposits (+RCFN2200 on 031)
 *   0426 other intangibles     J474 time deposits >$250K 2365 brokered deposits
 *   5597 est. uninsured        RIAD4340 net income YTD   1403 nonaccrual / 1407 90+PD
 *   2150 OREO                  3123 ACL on loans
 *   RIAD4460/4470 dividends declared (common/preferred), for the nowcast
 * J474 and 5597 are the two least certain codes here; the hit-rate table
 * printed at the end is the deploy verification, same pattern as /diag.
 * ========================================================================= */

const WORKER = process.env.TAPE_WORKER_URL || "https://brw-bank-tape.joeysamowitz.workers.dev";
const CR_BASE = process.env.CALLREPORT_BASE || "https://fdic.bankregwire.com";
const SECRET = process.env.TAPE_SYNC_SECRET;
const PERIOD = process.env.TAPE_PERIOD || "latest";
const ORIGIN = "https://bankregwire.com";

if (!SECRET) { console.error("TAPE_SYNC_SECRET missing"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- defensive value extraction ---------------------------------------- */

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[,$\s]/g, ""));
  return isFinite(n) ? n : null;
}

function codeMap(body) {
  // The callreport contract carries a code->value object; read defensively.
  const cand = body.values || body.codes || body.items || body.data || body;
  if (cand && typeof cand === "object" && !Array.isArray(cand)) return cand;
  if (Array.isArray(cand)) {
    const m = {};
    for (const row of cand) {
      const k = row.code || row.mdrm || row.id;
      if (k) m[String(k).toUpperCase()] = row.value ?? row.amount ?? null;
    }
    return m;
  }
  return {};
}

function pick(m, item, prefixes) {
  for (const p of prefixes) {
    const v = toNum(m[p + item]);
    if (v !== null) return v;
  }
  return null;
}

const RC = (m, item) => pick(m, item, ["RCFD", "RCON"]);
const RI = (m, item) => toNum(m["RIAD" + item]);

function annualizer(period) {
  const mo = Number(String(period).slice(5, 7));
  return mo === 3 ? 4 : mo === 6 ? 2 : mo === 9 ? 4 / 3 : 1;
}

/* ---- per-bank computation ---------------------------------------------- */

const HITS = {};
function tally(label, v) { HITS[label] = (HITS[label] || 0) + (v === null ? 0 : 1); }

function compute(m, period) {
  const equity = RC(m, "3210");
  const goodwill = RC(m, "3163") ?? 0;
  const intang = RC(m, "0426") ?? 0;
  const htmAC = RC(m, "1754");
  const htmFV = RC(m, "1771");
  const assets = RC(m, "2170");
  const depDom = toNum(m["RCON2200"]);
  const depFor = toNum(m["RCFN2200"]) ?? 0;
  const timeBig = toNum(m["RCONJ474"]);
  const brokered = toNum(m["RCON2365"]);
  const uninsured = toNum(m["RCON5597"]);
  const ni = RI(m, "4340");
  const divCommon = RI(m, "4460");
  const divPref = RI(m, "4470");
  const nonaccrual = RC(m, "1403");
  const pd90 = RC(m, "1407");
  const oreo = RC(m, "2150");
  const acl = RC(m, "3123");

  tally("3210 equity", equity); tally("3163 goodwill", RC(m, "3163"));
  tally("0426 intangibles", RC(m, "0426")); tally("1754 HTM AC", htmAC);
  tally("1771 HTM FV", htmFV); tally("2170 assets", assets);
  tally("2200 deposits", depDom); tally("J474 time>250K", timeBig);
  tally("2365 brokered", brokered); tally("5597 uninsured", uninsured);
  tally("4340 net income", ni); tally("4460 common divs", divCommon);
  tally("4470 preferred divs", divPref); tally("1403 nonaccrual", nonaccrual);
  tally("1407 90+PD", pd90); tally("2150 OREO", oreo); tally("3123 ACL", acl);

  if (equity === null) return null;

  const tbv = equity - goodwill - intang;
  const htmHaircut = htmAC !== null && htmFV !== null ? htmAC - htmFV : 0;
  const adjTbv = tbv - (htmHaircut || 0);
  const totalDeposits = depDom !== null ? depDom + depFor : null;
  // Core deposits: total less time >$250K less brokered; degrade gracefully.
  let coreDeposits = totalDeposits;
  if (coreDeposits !== null) {
    if (timeBig !== null) coreDeposits -= timeBig;
    if (brokered !== null) coreDeposits -= brokered;
    if (coreDeposits < 0) coreDeposits = totalDeposits;
  }
  const niAnnualized = ni !== null ? ni * annualizer(period) : null;
  const dividendsAnnualized = ((divCommon ?? 0) + (divPref ?? 0)) * annualizer(period);
  const rote = niAnnualized !== null && tbv > 0 ? niAnnualized / tbv : null;
  const creditAdjTbv = tbv
    - ((nonaccrual ?? 0) + (pd90 ?? 0) + (oreo ?? 0) - (acl ?? 0));

  return {
    tbv, adjTbv, htmHaircut, assets,
    totalDeposits, coreDeposits, brokered, uninsured, timeOver250K: timeBig,
    netIncomeAnnualized: niAnnualized, dividendsAnnualized, rote,
    nonaccrual, pd90, oreo, acl, creditAdjTbv /* held for v2, not rendered */
  };
}

/* ---- main --------------------------------------------------------------- */

async function main() {
  const tape = await (await fetch(`${WORKER}/api/tape`)).json();
  const universe = (tape.banks || []).filter((b) => b.cert);
  if (!universe.length) throw new Error("universe empty or certs unresolved: seed config:universe first");

  const banks = {};
  let period = null;
  let ok = 0, fail = 0;

  for (const b of universe) {
    try {
      const url = `${CR_BASE}/callreport?cert=${b.cert}&source=ffiec&period=${encodeURIComponent(PERIOD)}`;
      const res = await fetch(url, { headers: { Origin: ORIGIN, Referer: ORIGIN + "/" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const p = body.period || body.repdte || body.reportPeriod || PERIOD;
      if (!period && p !== "latest") period = p;

      // Re-run guard, checked once we know the live period
      if (ok === 0 && period && tape.period === period) {
        console.log(`Tape already holds ${period}, exiting green.`);
        return;
      }

      const row = compute(codeMap(body), period || p);
      if (!row) throw new Error("no equity value in response");
      banks[String(b.cert)] = row;
      ok++;
      await sleep(400); /* worker-side 30d cache absorbs most of these */
    } catch (e) {
      console.log(`  cert ${b.cert} (${b.ticker}): ${e.message}`);
      fail++;
    }
  }

  console.log("\nMDRM hit rates (deploy verification, expect near-universe counts):");
  for (const [label, n] of Object.entries(HITS)) {
    console.log(`  ${label.padEnd(18)} ${n}/${ok}`);
  }

  if (!ok || !period) { console.error("Nothing computed, aborting POST."); process.exit(1); }

  const res = await fetch(`${WORKER}/admin/fundamentals`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sync-secret": SECRET },
    body: JSON.stringify({ period, banks })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST /admin/fundamentals HTTP ${res.status}: ${JSON.stringify(out)}`);
  console.log(`\nPosted ${ok} banks for ${period} (${fail} failed). Worker: ${JSON.stringify(out)}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

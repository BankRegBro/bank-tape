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
 *   CALLREPORT_BASE    optional. Defaults to the call report worker's
 *                      workers.dev host. The custom domain
 *                      fdic.bankregwire.com is NOT bound to a route and
 *                      fails DNS from the runner; do not "restore" it
 *                      without checking that it resolves first.
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
const CR_BASE = (process.env.CALLREPORT_BASE || "").trim() || "https://fdic-bankregwire.joeysamowitz.workers.dev";
const SECRET = process.env.TAPE_SYNC_SECRET;
const PERIOD = (process.env.TAPE_PERIOD || "latest").trim();

/* The worker validates period as YYYYMMDD ("period must be YYYYMMDD, e.g.
   20251231"). Accept either form from the workflow input, and treat "latest"
   as "send no period at all" since the worker picks the newest itself. */
function periodParam() {
  if (!PERIOD || PERIOD.toLowerCase() === "latest") return null;
  const digits = PERIOD.replace(/-/g, "");
  if (!/^\d{8}$/.test(digits)) {
    console.error(`TAPE_PERIOD must be YYYY-MM-DD or YYYYMMDD, got "${PERIOD}"`);
    process.exit(1);
  }
  return digits;
}

/* Responses carry the reporting date at meta.repdte as YYYYMMDD. Normalize to
   YYYY-MM-DD, which is what the tape worker stores and ages against. */
function readPeriod(body) {
  const raw = (body && body.meta && (body.meta.repdte || body.meta.period)) ||
              (body && (body.repdte || body.period || body.reportPeriod)) || null;
  if (!raw) return null;
  const d = String(raw).replace(/-/g, "");
  return /^\d{8}$/.test(d) ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` : String(raw);
}
const ORIGIN = "https://bankregwire.com";

if (!SECRET) { console.error("TAPE_SYNC_SECRET missing"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Node wraps transport errors as a bare "fetch failed" with the real reason
   on .cause. Without this, DNS failure, refused connection, TLS mismatch and
   timeout are indistinguishable in the log. */
function why(e) {
  const c = e && e.cause;
  if (!c) return e && e.message ? e.message : String(e);
  const bits = [c.code, c.errno, c.syscall, c.hostname, c.message].filter(Boolean);
  return `${e.message} (${bits.join(" ")})`;
}

/* One probe before the loop. Thirty-seven identical failures tell you nothing
   that the first one didn't. */
async function preflight() {
  const url = `${CR_BASE}/diag`;
  console.log(`Preflight: ${url}`);
  let res;
  try {
    res = await fetch(url, { headers: { Origin: ORIGIN, Referer: ORIGIN + "/" } });
  } catch (e) {
    console.error(`\nCannot reach the call report worker at ${CR_BASE}`);
    console.error(`  ${why(e)}`);
    console.error("\nThe request never got a response, so this is not the origin gate");
    console.error("and not a bad cert. Check, in order:");
    console.error(`  1. Does ${CR_BASE} load in a browser? If not, the hostname is wrong.`);
    console.error("  2. Is the call report worker on a workers.dev URL instead of a custom domain?");
    console.error("  3. Re-run this job with the CALLREPORT_BASE input set to the correct origin.");
    process.exit(1);
  }
  console.log(`  responded HTTP ${res.status}`);
  const diagBody = await res.text().catch(() => "");
  if (diagBody) console.log(`  /diag says: ${diagBody.slice(0, 600)}`);
  if (res.status === 401 || res.status === 403) {
    console.error(`\nReached the worker but it refused the request (HTTP ${res.status}).`);
    console.error("That is the origin/referer gate or Zero Trust Access. The script already");
    console.error(`sends Origin: ${ORIGIN}. If Access is on the hostname, this job needs a`);
    console.error("service token or the hostname needs an Access bypass for automation.");
    process.exit(1);
  }
  if (res.status === 404) {
    console.error(`\n${url} returned 404. The worker is reachable but /diag is not there,`);
    console.error("so the path prefix is probably different (for example /api/callreport");
    console.error("rather than /callreport). Set CALLREPORT_BASE to include the prefix.");
    process.exit(1);
  }
}

/* ---- defensive value extraction ---------------------------------------- */

function toNum(v) {
  if (v === null || v === undefined) return null;
  let t = String(v).replace(/[,$\s]/g, "");
  let neg = false;
  const paren = t.match(/^\((.*)\)$/);      /* accounting negative: (1,234) */
  if (paren) { neg = true; t = paren[1]; }
  if (t === "") return null;
  const n = Number(t);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

/* The worker's own note: .values is a generic two-column SDF parse and "the
   fallback, not the authority", with the full facsimile under .raw. If a line
   carries more than two columns, a needed code can be missing from .values
   while sitting in plain sight in .raw. Parse raw tolerantly and use it only
   to fill gaps, never to override what the worker already parsed. */
const MDRM_RE = /^[A-Z]{4}[A-Z0-9]{4}$/;
const RAW_FILLS = [];

function parseRawSdf(raw) {
  const out = {};
  if (typeof raw !== "string" || !raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const cols = line.split(/\t/);
    for (let i = 0; i < cols.length; i++) {
      const code = cols[i].trim().toUpperCase();
      if (!MDRM_RE.test(code)) continue;
      /* take the first parseable number to the right of the code */
      for (let j = i + 1; j < cols.length; j++) {
        const v = toNum(cols[j]);
        if (v !== null) { if (!(code in out)) out[code] = v; break; }
      }
      break;
    }
  }
  return out;
}

function codeMap(body) {
  // The callreport contract carries a code->value object; read defensively.
  const cand = body.values || body.codes || body.items || body.data || body;
  if (cand && typeof cand === "object" && !Array.isArray(cand)) {
    const fromRaw = parseRawSdf(body.raw);
    const filled = Object.keys(fromRaw).filter((k) => !(k in cand)).length;
    if (filled) RAW_FILLS.push(filled);
    return { ...fromRaw, ...cand };   /* worker's parse wins on conflict */
  }
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

/* ---- request-shape discovery -------------------------------------------
 * The /callreport contract is not documented here, so rather than guess at
 * parameters we ask the worker directly with one cert and keep the first
 * shape that answers 200. Every rejection prints its body, which is where
 * the worker explains what it wanted.
 * ----------------------------------------------------------------------- */

const SHAPES = [
  {
    label: "cert + source=ffiec + period",
    usable: true,
    build: (c) => `cert=${c}&source=ffiec&period=${periodParam()}`,
    skip: () => periodParam() === null
  },
  { label: "cert + source=ffiec", usable: true, build: (c) => `cert=${c}&source=ffiec` },
  /* Diagnostic only. The FDIC crosswalk carries derived vitals (equity, assets,
     deposits, net income, ACL) but NOT goodwill, intangibles, HTM amortized cost
     or fair value, uninsured or brokered deposits, dividends, or nonaccruals.
     Without those, "tangible book" is not tangible and the rate adjustment that
     justifies this instrument cannot be computed. Probed so its success proves
     the worker is healthy and the FFIEC credentials are the missing piece;
     never adopted, so a degraded run can never silently publish. */
  { label: "cert only (FDIC crosswalk)", usable: false, build: (c) => `cert=${c}` }
];

async function discoverShape(cert) {
  console.log(`\nProbing /callreport request shapes with cert ${cert}:`);
  let crosswalkWorks = false;
  for (const shape of SHAPES) {
    if (shape.skip && shape.skip()) { console.log(`  [skip] ${shape.label} (no period requested)`); continue; }
    const url = `${CR_BASE}/callreport?${shape.build(cert)}`;
    try {
      const res = await fetch(url, { headers: { Origin: ORIGIN, Referer: ORIGIN + "/" } });
      const body = await res.text().catch(() => "");
      console.log(`  [${res.status}] ${shape.label}`);
      if (body) console.log(`        ${body.slice(0, 300).replace(/\s+/g, " ")}`);
      if (res.ok && shape.usable) {
        console.log(`\nUsing shape: ${shape.label}`);
        return shape;
      }
      if (res.ok && !shape.usable) {
        crosswalkWorks = true;
        console.log("        (usable for vitals only, not adopted)");
      }
    } catch (e) {
      console.log(`  [---] ${shape.label}: ${why(e)}`);
    }
    await sleep(300);
  }
  if (crosswalkWorks) {
    console.error("\nThe call report worker is healthy, but only the FDIC crosswalk path");
    console.error("answers. That path carries derived vitals and cannot supply goodwill,");
    console.error("intangibles, HTM amortized cost or fair value, uninsured or brokered");
    console.error("deposits, dividends, or nonaccruals. Tangible book and the rate");
    console.error("adjustment are not computable from it, so this job will not publish.");
    console.error("\nFix: bind FFIEC_USERID and FFIEC_TOKEN as Secrets on the call report");
    console.error("worker (CDR PWS account), then re-run. Bind its KV namespace too if");
    console.error("/diag still reports kv_bound false, or 37 uncached calls will spend");
    console.error("FFIEC quota on every pass.");
    process.exit(1);
  }
  console.error("\nNo request shape was accepted. The bodies above are the worker's own");
  console.error("explanation; the parameter names or period format need to match them.");
  process.exit(1);
}

/* ---- main --------------------------------------------------------------- */

async function main() {
  console.log(`Call report base: ${CR_BASE}`);
  console.log(`Tape worker:      ${WORKER}`);
  await preflight();
  const tape = await (await fetch(`${WORKER}/api/tape`)).json();
  const universe = (tape.banks || []).filter((b) => b.cert);
  if (!universe.length) throw new Error("universe empty or certs unresolved: seed config:universe first");

  const shape = await discoverShape(universe[0].cert);

  const banks = {};
  const periodCounts = new Map();
  let period = null;
  let ok = 0, fail = 0;

  for (const b of universe) {
    try {
      const url = `${CR_BASE}/callreport?${shape.build(b.cert)}`;
      const res = await fetch(url, { headers: { Origin: ORIGIN, Referer: ORIGIN + "/" } });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${errText ? " " + errText.slice(0, 200).replace(/\s+/g, " ") : ""}`);
      }
      const body = await res.json();
      const p = readPeriod(body);
      if (p) periodCounts.set(p, (periodCounts.get(p) || 0) + 1);
      if (!period && p) period = p;

      // Re-run guard, checked once we know the live period
      if (ok === 0 && period && tape.period === period) {
        console.log(`Tape already holds ${period}, exiting green.`);
        return;
      }

      const row = compute(codeMap(body), period || p || "");
      if (!row) throw new Error("no equity value in response");
      banks[String(b.cert)] = row;
      ok++;
      await sleep(400); /* worker-side 30d cache absorbs most of these */
    } catch (e) {
      console.log(`  cert ${b.cert} (${b.ticker}): ${why(e)}`);
      fail++;
      /* A transport failure is a host problem, not a per-bank problem. Do not
         grind through the rest of the universe proving the same point. */
      if (fail >= 3 && ok === 0) {
        console.error(`\nThree failures with zero successes against ${CR_BASE}. Stopping rather`);
        console.error("than repeating the same error 37 times. The message above is the worker's.");
        process.exit(1);
      }
    }
  }

  /* Report the period distribution before anything else. A split means the
     filing season is open and the tape would carry a single date that is wrong
     for part of the universe. */
  if (periodCounts.size > 1) {
    const sorted = [...periodCounts.entries()].sort((a, b) => b[1] - a[1]);
    console.log("\nPERIOD SPLIT: banks came back on more than one quarter.");
    sorted.forEach(([p, n]) => console.log(`  ${p}: ${n} banks`));
    period = sorted[0][0];
    console.log(`\nLabelling the payload ${period} (most common), but ${ok - sorted[0][1]} banks`);
    console.log("carry a different quarter and their multiples will be mismatched against price.");
    console.log("For a clean pass, re-run with the period input pinned, e.g. 2026-03-31,");
    console.log("and switch to latest once the whole universe has filed the newer quarter.");
  } else if (periodCounts.size === 1) {
    console.log(`\nAll ${ok} banks on ${period}. Clean pass.`);
  }

  if (RAW_FILLS.length) {
    const total = RAW_FILLS.reduce((a, b) => a + b, 0);
    console.log(`\nRaw SDF backfill: ${total} codes across ${RAW_FILLS.length} banks were absent`);
    console.log("from the worker's .values parse and recovered from .raw.");
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

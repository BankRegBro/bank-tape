/* =========================================================================
 * TAPE DIAG (manual, read-only)
 * -------------------------------------------------------------------------
 * Prints the state of both workers in one run. Exists because /diag on the
 * call report worker is origin-gated, so a browser address bar gets a 403;
 * this sends the allowlisted Origin the same way the real job does.
 *
 * Read-only and cheap: two GETs. It does NOT pull any bank data, so it costs
 * nothing against the FFIEC hourly limit beyond the reporting-period list the
 * worker caches anyway.
 * ========================================================================= */

const CR_BASE = (process.env.CALLREPORT_BASE || "").trim() ||
  "https://fdic-bankregwire.joeysamowitz.workers.dev";
const TAPE = process.env.TAPE_WORKER_URL || "https://brw-bank-tape.joeysamowitz.workers.dev";
const ORIGIN = "https://bankregwire.com";

function why(e) {
  const c = e && e.cause;
  if (!c) return e && e.message ? e.message : String(e);
  return `${e.message} (${[c.code, c.syscall, c.hostname].filter(Boolean).join(" ")})`;
}

async function show(label, url, headers) {
  console.log(`\n=== ${label} ===\n${url}`);
  try {
    const res = await fetch(url, { headers: headers || {} });
    const text = await res.text();
    console.log(`HTTP ${res.status}`);
    try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
    catch { console.log(text.slice(0, 1500)); }
    return res.ok ? JSON.parse(text) : null;
  } catch (e) {
    console.log(`unreachable: ${why(e)}`);
    return null;
  }
}

const cr = await show("CALL REPORT WORKER", `${CR_BASE}/diag`,
  { Origin: ORIGIN, Referer: ORIGIN + "/" });
const tape = await show("BANK TAPE WORKER", `${TAPE}/diag`);

console.log("\n=== READINESS ===");
const line = (label, ok, detail) =>
  console.log(`  ${ok ? "OK  " : "NOT "} ${label}${detail ? " — " + detail : ""}`);

if (cr) {
  line("FFIEC credentials bound", !!(cr.ffiec && cr.ffiec.ok),
    cr.ffiec && cr.ffiec.ok ? `latest period ${cr.ffiec.latest}` : (cr.ffiec && cr.ffiec.error));
  line("KV bound (cache + rate limiting)", !!cr.kv_bound,
    cr.kv_bound ? "" : "cache off, every call goes live");
  line("UBPR available (Health Scanner)", !!(cr.ubpr && cr.ubpr.ok),
    cr.ubpr && cr.ubpr.ok ? "" : (cr.ubpr && cr.ubpr.error));
} else {
  line("call report worker reachable", false, "see above");
}
if (tape) {
  line("universe seeded", tape.universeCount > 0, `${tape.universeCount} banks`);
  line("quotes loaded", tape.quotesCount > 0,
    tape.quotesCount ? `${tape.quotesCount} tickers, as of ${tape.quotesAsOf}` : "run job quotes");
  line("fundamentals loaded", tape.fundamentalsCovered > 0,
    tape.fundamentalsCovered ? `${tape.fundamentalsCovered} banks, period ${tape.fundamentalsPeriod}` : "run job fundamentals");
  line("worker at multi-charter build", "multiCharterSuppressed" in tape,
    "multiCharterSuppressed" in tape ? "" : "redeploy bank-tape-worker.js");
  line("peer model fitted", !!(tape.peerModelInputs && tape.peerModelInputs.fitted),
    tape.peerModelInputs ? `n=${tape.peerModelInputs.n}, needs 25` : "");
}
console.log("");

/* =========================================================================
 * TAPE UNIVERSE BUILDER (one-time, then quarterly maintenance)
 * -------------------------------------------------------------------------
 * Resolves each ticker's lead bank to an FDIC cert. Rewritten after the
 * first pass produced five SILENT WRONG MATCHES (Truist -> JPMorgan,
 * Citizens/Valley -> Fifth Third, Commerce -> Zions, United -> UMB).
 *
 * Root cause: the query sorted candidates by assets descending, so when
 * FDIC's search returned loose token matches (almost every bank name
 * contains "Bank"), the largest institution won regardless of whether the
 * name matched at all.
 *
 * The join FDIC actually publishes is bank -> holding company (NAMEHCR /
 * RSSDHCR), so the seed's holdco name is queried and verified alongside
 * the lead-bank name. Holdco names are distinctive where bank names are
 * generic ("United Bankshares" is unique; "United Bank" matches ten).
 *
 * The rule now: relevance fetches candidates, LOCAL VERIFICATION decides.
 * A candidate is accepted only if its normalized name actually matches the
 * seed's. Nothing is ever accepted on size alone. Failure prints the
 * candidates it saw and marks the row UNRESOLVED rather than guessing.
 *
 * Seed row fields:
 *   ticker, name           required
 *   search                 lead bank name to match against
 *   st                     optional 2-letter state. HARD constraint: if no
 *                          candidate sits in that state the row is left
 *                          unresolved rather than matched elsewhere
 *   cert                   optional manual override; verified, not resolved
 * ========================================================================= */

import { readFile, writeFile } from "node:fs/promises";

const FDIC = "https://banks.data.fdic.gov/api/institutions";
const FIELDS = "CERT,NAME,ASSET,FED_RSSD,CITY,STALP,ACTIVE,NAMEHCR,RSSDHCR";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- SECTION 1: name normalization + verification --------------------- */

/* Strip legal furniture so "Comerica Bank" and "COMERICA BANK, N.A."
   reduce to the same distinctive core. */
function core(s) {
  return String(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(national association|national|n a|na|bank|banking|banks|trust|company|co|the|of|inc|incorporated|corp|corporation|federal savings|savings|association|fsb|ssb)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* Accept only if EVERY distinctive token of the seed name appears in the
   candidate. No partial credit: an unresolved row costs one manual cert
   lookup, a wrong row silently corrupts every ratio for that bank. This
   direction of containment is what stops "Truist" matching "JPMorgan
   Chase" no matter how the search ranked them. */
function verify(seedName, candidateName) {
  const want = core(seedName).split(" ").filter(Boolean);
  const got = core(candidateName).split(" ").filter(Boolean);
  if (!want.length || !got.length) return false;
  const gotSet = new Set(got);
  return want.every((t) => gotSet.has(t));
}

/* ---- SECTION 2: candidate retrieval ------------------------------------
 * Two attempts, both WITHOUT sort_by so FDIC ranks by relevance. Results
 * are pooled and deduped; size is used only to break a tie among
 * candidates that already passed verification.
 * ---------------------------------------------------------------------- */

async function fetchCandidates(attempt) {
  const qs = new URLSearchParams({
    fields: FIELDS,
    limit: "10",
    ...(attempt.search
      ? { search: attempt.search, filters: "ACTIVE:1" }
      : { filters: `ACTIVE:1 AND ${attempt.filter}` })
  });
  const res = await fetch(`${FDIC}?${qs}`);
  if (!res.ok) throw new Error(`FDIC HTTP ${res.status}`);
  const body = await res.json();
  return (body.data || []).map((d) => d.data || d);
}

async function candidatesFor(row) {
  const pool = new Map();
  const tried = [];
  const clean = (v) => String(v).replace(/"/g, "");
  const attempts = [
    { search: `NAME:"${clean(row.search)}"` },
    { search: core(row.search) },
    { filter: `NAME:"${clean(row.search)}"` },
    row.name ? { filter: `NAMEHCR:"${clean(row.name)}"` } : null,
    /* FDIC stores formal holdco names ("COMERICA INCORPORATED"); the seed
       says "Comerica Inc.". If the exact phrase misses, retry on the
       distinctive core tokens. */
    row.name && core(row.name) && core(row.name) !== clean(row.name).toLowerCase()
      ? { filter: `NAMEHCR:"${core(row.name)}"` } : null
  ];
  for (const a of attempts) {
    if (!a) continue;
    const label = a.search ? `search ${a.search}` : `filter ${a.filter}`;
    tried.push({ label, attempt: a });
    try {
      for (const c of await fetchCandidates(a)) {
        if (c && c.CERT) pool.set(String(c.CERT), c);
      }
    } catch (e) {
      console.log(`    query failed (${label}): ${e.message}`);
    }
    await sleep(200);
  }
  return Object.assign([...pool.values()], { tried });
}

/* ---- SECTION 3: resolution -------------------------------------------- */

async function resolveRow(row) {
  /* Manual override: verify it exists and is active, never trust blindly. */
  if (row.cert) {
    const c = (await fetchCandidates({ filter: `CERT:${row.cert}` })).find(
      (x) => String(x.CERT) === String(row.cert)
    );
    if (!c) return {
      status: "override-bad",
      note: `cert ${row.cert} not found or inactive. A cert that was valid ` +
            `before and is inactive now usually means the charter was merged ` +
            `away: check whether the ticker still trades before re-resolving.`
    };
    return { status: "override", hit: c };
  }

  const cands = await candidatesFor(row);
  if (!cands.length) return { status: "none", cands, tried: cands.tried };

  let passing = cands.filter((c) =>
    verify(row.search, c.NAME) ||
    (row.name && c.NAMEHCR && verify(row.name, c.NAMEHCR))
  );
  if (row.st) {
    /* Hard constraint, never a soft preference. Falling back to other
       states is how "United Bank" (WV) became United Fidelity (IN). */
    passing = passing.filter((c) => c.STALP === row.st);
  }
  if (!passing.length) return { status: "none", cands, tried: cands.tried };

  passing.sort((a, b) => Number(b.ASSET || 0) - Number(a.ASSET || 0));
  return {
    status: passing.length > 1 ? "ambiguous" : "ok",
    hit: passing[0],
    alts: passing.slice(1)
  };
}

/* ---- SECTION 4: main + integrity report -------------------------------- */

async function main() {
  const seed = JSON.parse(
    await readFile(new URL("../config/universe.seed.json", import.meta.url), "utf8")
  );
  const out = [];
  const problems = [];

  console.log("ticker  cert     rssd      resolved institution");
  console.log("-".repeat(78));

  for (const s of seed) {
    let r;
    try {
      r = await resolveRow(s);
    } catch (e) {
      r = { status: "error", note: e.message };
    }

    if (r.status === "ok" || r.status === "ambiguous" || r.status === "override") {
      const h = r.hit;
      out.push({
        ticker: s.ticker,
        cert: Number(h.CERT),
        rssd: h.FED_RSSD ? Number(h.FED_RSSD) : null,
        name: s.name,
        bank: h.NAME,
        /* Holdcos running several charters: bank-level call report data
           covers one charter while market cap covers all of them, so every
           book-value ratio would be wrong. Carried through to the worker,
           which suppresses those columns rather than printing a bad number. */
        ...(s.multiCharter ? { multiCharter: true } : {})
      });
      const tag = r.status === "override" ? "  [manual override]" :
                  r.status === "ambiguous" ? "  [AMBIGUOUS, verify]" : "";
      console.log(
        `${s.ticker.padEnd(7)} ${String(h.CERT).padEnd(8)} ${String(h.FED_RSSD || "").padEnd(9)} ` +
        `${h.NAME} (${h.CITY}, ${h.STALP})` +
        (h.NAMEHCR ? ` · holdco: ${h.NAMEHCR}` : "") + tag
      );
      if (r.status === "ambiguous") {
        problems.push(s.multiCharter
          ? `${s.ticker}: ${r.alts.length + 1} charters under one holdco (expected; ratios suppressed)`
          : `${s.ticker}: ${r.alts.length + 1} names matched, largest chosen`);
        r.alts.forEach((a) => console.log(`          also matched: ${a.NAME} (${a.CITY}, ${a.STALP}) cert ${a.CERT}`));
      }
    } else {
      out.push({ ticker: s.ticker, cert: null, rssd: null, name: s.name, bank: null });
      console.log(`${s.ticker.padEnd(7)} UNRESOLVED  (search: "${s.search}")${r.note ? " " + r.note : ""}`);
      (r.cands || []).slice(0, 6).forEach((c) =>
        console.log(`          candidate seen: ${c.NAME} (${c.CITY}, ${c.STALP}) cert ${c.CERT}`)
      );
      if (!(r.cands || []).length && r.tried) {
        console.log(`          zero candidates. Queries tried: ${r.tried.map((t) => t.label).join(" | ")}`);
        r.tried.forEach((t) => {
          const qs = new URLSearchParams({
            fields: "CERT,NAME,CITY,STALP,NAMEHCR",
            limit: "5",
            ...(t.attempt.search
              ? { search: t.attempt.search, filters: "ACTIVE:1" }
              : { filters: `ACTIVE:1 AND ${t.attempt.filter}` })
          });
          console.log(`          try in a browser: ${FDIC}?${qs}`);
        });
      }
      problems.push(`${s.ticker}: unresolved, add "cert" or fix "search" in the seed`);
    }
    await sleep(250);
  }

  /* Duplicate certs are the signature of the bug this rewrite fixes.
     One cert serving two tickers is always wrong. */
  const seen = new Map();
  out.forEach((r) => {
    if (!r.cert) return;
    if (seen.has(r.cert)) problems.push(`DUPLICATE cert ${r.cert}: ${seen.get(r.cert)} and ${r.ticker}`);
    else seen.set(r.cert, r.ticker);
  });

  await writeFile(
    new URL("../config/universe.json", import.meta.url),
    JSON.stringify(out, null, 2)
  );

  const resolved = out.filter((r) => r.cert).length;
  console.log("-".repeat(78));
  console.log(`Wrote config/universe.json: ${out.length} rows, ${resolved} resolved, ${out.length - resolved} unresolved.`);
  if (problems.length) {
    console.log("\nNeeds your attention before loading into KV:");
    problems.forEach((p) => console.log("  " + p));
    console.log("\nFix by adding a verified \"cert\" (from FDIC BankFind) or a better \"search\"/\"st\" to config/universe.seed.json, then re-run.");
  } else {
    console.log("\nNo duplicates, no ambiguity, nothing unresolved. Safe to load into KV.");
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });

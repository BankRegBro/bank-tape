/* =========================================================================
 * TAPE UNIVERSE BUILDER (one-time, then quarterly maintenance)
 * -------------------------------------------------------------------------
 * Reads config/universe.seed.json ({ticker, name, search}), resolves each
 * lead bank's FDIC cert via the public institutions API (largest active
 * match by assets wins), and writes config/universe.json for review.
 * Certs are RESOLVED, never hand-typed. Review the printed table, then:
 *
 *   curl -X PUT https://brw-bank-tape.joeysamowitz.workers.dev/admin/universe \
 *        -H "x-sync-secret: $TAPE_SYNC_SECRET" -H "content-type: application/json" \
 *        --data @config/universe.json
 *
 * Growing to the full KRE/KBWB universe later: pull the ETF's published
 * holdings file, append {ticker, name, search} rows to the seed, re-run.
 * ========================================================================= */

import { readFile, writeFile } from "node:fs/promises";

const FDIC = "https://banks.data.fdic.gov/api/institutions";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function esc(s) { return s.replace(/"/g, '\\"'); }

async function resolve(search) {
  const qs = new URLSearchParams({
    search: `NAME:"${esc(search)}"`,
    filters: "ACTIVE:1",
    fields: "CERT,NAME,ASSET,FED_RSSD,CITY,STALP",
    sort_by: "ASSET",
    sort_order: "DESC",
    limit: "3"
  });
  const res = await fetch(`${FDIC}?${qs}`);
  if (!res.ok) throw new Error(`FDIC HTTP ${res.status}`);
  const body = await res.json();
  const rows = (body.data || []).map((d) => d.data || d);
  return rows[0] || null;
}

async function main() {
  const seed = JSON.parse(await readFile(new URL("../config/universe.seed.json", import.meta.url), "utf8"));
  const out = [];
  console.log("ticker  cert     rssd      resolved institution");
  for (const s of seed) {
    try {
      const hit = await resolve(s.search);
      if (!hit) throw new Error("no active match");
      out.push({
        ticker: s.ticker,
        cert: Number(hit.CERT),
        rssd: hit.FED_RSSD ? Number(hit.FED_RSSD) : null,
        name: s.name,
        bank: hit.NAME
      });
      console.log(
        `${s.ticker.padEnd(7)} ${String(hit.CERT).padEnd(8)} ${String(hit.FED_RSSD || "").padEnd(9)} ` +
        `${hit.NAME} (${hit.CITY}, ${hit.STALP})`
      );
    } catch (e) {
      out.push({ ticker: s.ticker, cert: null, rssd: null, name: s.name, bank: null });
      console.log(`${s.ticker.padEnd(7)} UNRESOLVED: ${e.message} (search: "${s.search}")`);
    }
    await sleep(250);
  }
  await writeFile(new URL("../config/universe.json", import.meta.url), JSON.stringify(out, null, 2));
  const unresolved = out.filter((r) => !r.cert).length;
  console.log(`\nWrote config/universe.json: ${out.length} rows, ${unresolved} unresolved.`);
  console.log("Review the resolved-institution column before the PUT; a wrong lead bank here poisons every ratio downstream.");
}

main().catch((e) => { console.error(e.message); process.exit(1); });

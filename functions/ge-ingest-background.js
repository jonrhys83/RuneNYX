// Background function - up to 15 minutes. Pulls the full GE dump, writes a
// gzipped archive copy to Storage, then ingests everything in one RPC call.

import { gzipSync } from "node:zlib";
import { requireEnv, rpc, putObject, isoDate, log, UA } from "./_lib.js";

const DUMP_URL = "https://chisel.weirdgloop.org/gazproj/gazbot/rs_dump.json";
const BUCKET = "ge-archive";
const FIELDS = ["id", "name", "members", "limit", "value", "highalch", "lowalch", "price", "volume"];

export default async (req) => {
  const started = Date.now();
  try {
    requireEnv();

    log("fetching dump");
    const res = await fetch(DUMP_URL, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`dump fetch ${res.status}`);
    const dump = await res.json();

    // Jagex's own timestamp for the update, not our clock. If the GE has not
    // updated since the last run this will match a date we already have, and
    // the upsert simply overwrites it - no duplicate rows.
    const jagexTs = dump["%JAGEX_TIMESTAMP%"];
    const snapshotDate = jagexTs
      ? isoDate(new Date(Number(jagexTs) * 1000))
      : isoDate();

    const items = [];
    const archive = [];
    for (const [k, v] of Object.entries(dump)) {
      if (k.startsWith("%") || v == null || v.id == null) continue;
      const row = {};
      for (const f of FIELDS) if (v[f] !== undefined) row[f] = v[f];
      items.push(row);
      if (v.price != null) archive.push(`${v.id},${v.price},${v.volume ?? ""}`);
    }
    log(`parsed ${items.length} items for ${snapshotDate}`);

    // --- cold storage: one gzipped CSV per day, ~50 KB ---
    const [y, m] = snapshotDate.split("-");
    const gz = gzipSync(Buffer.from(archive.join("\n"), "utf8"), { level: 9 });
    await putObject(BUCKET, `${y}/${m}/${snapshotDate}.csv.gz`, gz, "application/gzip");
    log(`archived ${(gz.length / 1024).toFixed(1)} KB`);

    // --- hot store: one round trip for the whole dump ---
    const inserted = await rpc("ingest_ge_dump", {
      payload: items,
      snapshot_date: snapshotDate,
    });
    log(`ingested ${inserted} price rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);

    return new Response(
      JSON.stringify({ ok: true, snapshotDate, items: items.length, inserted }),
      { headers: { "content-type": "application/json" } }
    );
  } catch (e) {
    log("INGEST FAILED:", e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

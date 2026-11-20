// Hourly snapshot of real RS3 traded prices.
//
// Everything else in this project reads Jagex's guide price, which cannot move
// more than 5% in a day. This reads what items actually traded at: an
// instant-buy price, an instant-sell price, and the volume behind each.
//
// One request returns all ~7,400 items, so this is cheap: a single fetch, a
// single gzipped archive write, and a single RPC carrying the whole payload.
// That is why it can be a plain scheduled function inside the 30s budget
// instead of a background worker.
//
// Accepts GET so it can be triggered by hand for verification.
//
//   curl .../.netlify/functions/ge-rt
//   curl ".../.netlify/functions/ge-rt?hot=300"   # also refresh the hot tier

import { requireEnv, rpc, putObject, log, UA, SUPABASE_URL, SERVICE_KEY } from "./_lib.js";
import { gzipSync } from "node:zlib";

const BUCKET = "ge-archive";
const SRC = "https://prices.runescape.wiki/api/v2/rs/1h";

// This endpoint is public, so it needs to be safe to hit repeatedly. The wiki
// only publishes one new bucket per hour, so if the current hour is already
// absorbed there is nothing to fetch. That caps us at one upstream request per
// hour no matter how often this is called.
async function alreadyHaveThisHour() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/ge_rt_daily?select=last_ts&order=last_ts.desc&limit=1`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  if (!res.ok) return null;                       // fail open; collecting matters more
  const [row] = await res.json();
  if (!row?.last_ts) return null;
  const seen = new Date(row.last_ts).getTime();
  const thisHour = new Date().setUTCMinutes(0, 0, 0);
  return seen >= thisHour ? row.last_ts : null;
}

export default async (req) => {
  const started = Date.now();
  try {
    requireEnv();

    const url = new URL(req.url);

    if (url.searchParams.get("force") !== "1") {
      const have = await alreadyHaveThisHour();
      if (have) {
        return new Response(JSON.stringify({
          ok: true, skipped: "current hour already absorbed", lastTs: have,
        }), { headers: { "content-type": "application/json" } });
      }
    }

    // The wiki pre-blocks default library user agents, so identify properly.
    const res = await fetch(SRC, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      throw new Error(`wiki ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const raw = await res.text();
    const body = JSON.parse(raw);
    const data = body.data || {};
    const itemCount = Object.keys(data).length;
    if (!itemCount) throw new Error("wiki returned an empty data object");

    // The payload carries its own timestamp for the hour it covers. Trust that
    // over our clock, so a late run still files under the right hour.
    const snapTs = body.timestamp
      ? new Date(body.timestamp * 1000).toISOString()
      : new Date().toISOString();

    // Archive the raw response before touching the database. If the absorb
    // fails or the schema changes later, the source of truth is still on disk.
    const d = new Date(snapTs);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const gz = gzipSync(Buffer.from(raw, "utf8"), { level: 9 });
    const objectPath = `rt/${y}/${m}/${y}-${m}-${day}T${hh}.json.gz`;
    await putObject(BUCKET, objectPath, gz, "application/gzip");

    // One round trip for the whole market.
    const absorbed = await rpc("ge_rt_absorb", { snap_ts: snapTs, payload: data });
    const r = Array.isArray(absorbed) ? absorbed[0] : absorbed;

    // Refresh the hot tier once a day, or on demand via ?hot=N.
    let hot = null;
    const hotParam = url.searchParams.get("hot");
    if (hotParam || d.getUTCHours() === 5) {
      hot = await rpc("ge_rt_refresh_hot", { n: Number(hotParam) || 300 });
    }

    const seconds = +((Date.now() - started) / 1000).toFixed(1);
    log(`rt: ${itemCount} items at ${snapTs}, ${r?.day_rows ?? 0} daily rows, ` +
        `${r?.hour_rows ?? 0} hourly, archive ${(gz.length / 1024).toFixed(1)} KB`);

    return new Response(JSON.stringify({
      ok: true,
      snapTs,
      items: itemCount,
      dayRows: r?.day_rows ?? 0,
      hourRows: r?.hour_rows ?? 0,
      hotTier: hot,
      archive: objectPath,
      archiveKB: +(gz.length / 1024).toFixed(1),
      seconds,
    }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    log("GE RT FAILED:", e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
};

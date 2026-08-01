// Pulls reference data from runescape.wiki's Bucket API: item id mapping,
// shop inventories with vendor prices, drop and thieving-stall tables, and
// gathering locations.
//
// This is slow-changing data. Run it weekly, or by hand after a game update:
//   curl -X POST https://runenyx.netlify.app/.netlify/functions/wiki-sync-background
//
// Optionally narrow the run:
//   -d '{"only":["shops","drops"]}'

import { requireEnv, insert, log } from "./_lib.js";

const API = "https://runescape.wiki/api.php";
const PAGE = 5000; // the Bucket API's hard ceiling per request
const UA = "RuneNYX reference sync (runenyx.netlify.app)";

async function bucket(query) {
  const url = `${API}?action=bucket&format=json&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`wiki ${res.status} on ${query.slice(0, 60)}`);
  const body = await res.json();
  if (body.error) throw new Error(`wiki: ${body.error} on ${query.slice(0, 60)}`);
  return body.bucket || [];
}

// Walks a bucket in 5000-row pages until it runs dry.
async function* pages(table, fields, where = "") {
  const sel = fields.map((f) => `'${f}'`).join(",");
  for (let offset = 0; ; offset += PAGE) {
    const rows = await bucket(
      `bucket('${table}').select(${sel})${where}.limit(${PAGE}).offset(${offset}).run()`
    );
    if (!rows.length) return;
    yield rows;
    if (rows.length < PAGE) return;
  }
}

const num = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
};

// Wiki text carries file links and templates. Strip to something readable.
const clean = (v) => {
  if (!v) return null;
  const s = String(v)
    .replace(/\[\[File:[^\]]*\]\]/g, "")
    .replace(/\[\[([^|\]]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
};

const first = (v) => (Array.isArray(v) ? v[0] : v);

export default async (req) => {
  const started = Date.now();
  const done = {};
  try {
    requireEnv();
    let only = null;
    try {
      const body = await req.json();
      if (Array.isArray(body?.only)) only = new Set(body.only);
    } catch { /* no body is fine */ }
    const want = (step) => !only || only.has(step);

    // ---- item name -> GE id. Everything else joins through this. ----
    const idMap = new Map();
    if (want("ids")) {
      let n = 0;
      for await (const rows of pages("item_id", ["page_name", "id"])) {
        const batch = [];
        for (const r of rows) {
          const id = num(first(r.id));
          if (!r.page_name || id == null) continue;
          idMap.set(r.page_name, id);
          batch.push({ item_name: r.page_name, item_id: id });
        }
        n += await insert("wiki_item_ids", dedupe(batch, (r) => r.item_name),
          { onConflict: "item_name" });
      }
      done.item_ids = n;
      log(`item ids: ${n}`);
    } else {
      for await (const rows of pages("item_id", ["page_name", "id"])) {
        for (const r of rows) {
          const id = num(first(r.id));
          if (r.page_name && id != null) idMap.set(r.page_name, id);
        }
      }
    }

    // ---- shops: location and owner ----
    if (want("shops")) {
      let n = 0;
      for await (const rows of pages("infobox_shop",
        ["page_name", "type", "location", "owner", "is_members_only"])) {
        const batch = rows.filter((r) => r.page_name).map((r) => ({
          shop_name: r.page_name,
          shop_type: clean(r.type),
          location: clean(r.location),
          owner: clean(r.owner),
          members_only: r.is_members_only === true || r.is_members_only === "true",
        }));
        n += await insert("wiki_shops", dedupe(batch, (r) => r.shop_name),
          { onConflict: "shop_name" });
      }
      done.shops = n;
      log(`shops: ${n}`);
    }

    // ---- vendor pricing ----
    if (want("shops")) {
      let n = 0;
      for await (const rows of pages("storeline",
        ["page_name", "sold_item", "store_sell_price", "store_buy_price",
         "store_currency", "store_stock", "is_historical", "is_members_only"])) {
        const batch = rows
          .filter((r) => r.page_name && r.sold_item && r.is_historical !== true)
          .map((r) => ({
            shop_name: r.page_name,
            item_name: r.sold_item,
            item_id: idMap.get(r.sold_item) ?? null,
            sell_price: num(r.store_sell_price),
            buy_price: num(r.store_buy_price),
            currency: clean(first(r.store_currency)) || "Coins",
            stock: num(r.store_stock),
            members_only: r.is_members_only === true || r.is_members_only === "true",
          }));
        n += await insert("wiki_shop_lines",
          dedupe(batch, (r) => `${r.shop_name}|${r.item_name}|${r.sell_price}`),
          { onConflict: "shop_name,item_name,sell_price" });
      }
      done.shop_lines = n;
      log(`shop lines: ${n}`);
    }

    // ---- drops, thieving stalls, searchables ----
    if (want("drops")) {
      let n = 0, skipped = 0;
      for await (const rows of pages("dropsline",
        ["page_name", "item_name", "drop_json"])) {
        const batch = [];
        for (const r of rows) {
          if (!r.page_name || !r.item_name) continue;
          const id = idMap.get(r.item_name);
          // Untradeable or unmapped items have no GE price, so they add
          // nothing here. Dropping them keeps the table roughly half the size.
          if (id == null) { skipped++; continue; }
          let j = {};
          try { j = JSON.parse(r.drop_json || "{}"); } catch { /* keep going */ }
          batch.push({
            source_name: r.page_name,
            source_type: j["Drop type"] || null,
            item_name: r.item_name,
            item_id: id,
            rarity: j["Rarity"] || null,
            qty_low: num(j["Quantity Low"]),
            qty_high: num(j["Quantity High"]),
            drop_level: j["Drop level"] ? String(j["Drop level"]) : null,
            region: j["League region"] || null,
          });
        }
        n += await insert("wiki_drops",
          dedupe(batch, (r) =>
            `${r.source_name}|${r.item_name}|${r.rarity}|${r.qty_low}|${r.qty_high}`),
          { onConflict: "source_name,item_name,rarity,qty_low,qty_high" });
      }
      done.drops = n;
      done.drops_skipped_untradeable = skipped;
      log(`drops: ${n} kept, ${skipped} skipped`);
    }

    // ---- mining rocks, fishing spots, trees ----
    if (want("resources")) {
      let n = 0;
      for await (const rows of pages("resource_locations",
        ["location", "resource", "skill", "count", "requirements", "league_region"])) {
        const batch = rows.filter((r) => r.location && r.resource).map((r) => ({
          location: r.location,
          resource: r.resource,
          skill: clean(r.skill),
          node_count: num(r.count),
          requirements: clean(r.requirements),
          region: clean(r.league_region),
        }));
        n += await insert("wiki_resource_locations",
          dedupe(batch, (r) => `${r.location}|${r.resource}|${r.skill}`),
          { onConflict: "location,resource,skill" });
      }
      done.resource_locations = n;
      log(`resource locations: ${n}`);
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    log(`wiki sync finished in ${seconds}s`);
    return new Response(JSON.stringify({ ok: true, seconds: +seconds, ...done }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    log("WIKI SYNC FAILED:", e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message, ...done }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

// Postgres rejects a batch that hits the same conflict key twice, and the wiki
// does contain exact duplicate rows. Keep the first of each.
function dedupe(rows, keyFn) {
  const seen = new Set();
  return rows.filter((r) => {
    const k = keyFn(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

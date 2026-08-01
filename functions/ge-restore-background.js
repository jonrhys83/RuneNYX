// Manual, on demand. Pulls a date range back out of the Storage archive and
// re-inserts the daily rows. Use when you want day-level detail on a past
// window that the rollup has already pruned - seasonals, event aftermath.
//
//   curl -X POST "https://runenyx.netlify.app/.netlify/functions/ge-restore-background" \
//        -H "content-type: application/json" \
//        -d "{\"from\":\"2026-12-01\",\"to\":\"2026-12-31\",\"key\":\"...\"}"
//
// Guarded by RESTORE_KEY so a stranger cannot spam it.

import { gunzipSync } from "node:zlib";
import { requireEnv, rpc, getObject, log } from "./_lib.js";

const BUCKET = "ge-archive";
const BATCH = 20000;

function* dateRange(from, to) {
  const d = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

export default async (req) => {
  try {
    requireEnv();
    const { from, to, key } = await req.json();

    const guard = process.env.RESTORE_KEY;
    if (guard && key !== guard) return new Response("forbidden", { status: 403 });
    if (!from || !to) return new Response("need from and to", { status: 400 });

    let rows = [];
    let restored = 0;
    let missing = 0;
    let corrupt = [];

    const flush = async () => {
      if (!rows.length) return;
      restored += await rpc("restore_archive", { payload: rows });
      rows = [];
    };

    for (const day of dateRange(from, to)) {
      const [y, m] = day.split("-");
      const buf = await getObject(BUCKET, `${y}/${m}/${day}.csv.gz`);
      if (!buf) { missing++; continue; }

      let text;
      try {
        text = gunzipSync(buf).toString("utf8");
      } catch (e) {
        // A bad object should not kill the whole range.
        log(`skipping ${day}: ${e.message}`);
        corrupt.push(day);
        continue;
      }

      for (const line of text.split("\n")) {
        if (!line) continue;
        const [i, p, v] = line.split(",");
        const id = Number(i), price = Number(p);
        if (!Number.isFinite(id) || !Number.isFinite(price)) continue;
        rows.push({ i: id, d: day, p: price, v: v === "" || v == null ? null : Number(v) });
      }
      if (rows.length >= BATCH) await flush();
    }
    await flush();

    log(`restored ${restored} rows, ${missing} days had no archive, ${corrupt.length} unreadable`);
    return new Response(JSON.stringify({ ok: true, restored, missing, corrupt }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    log("RESTORE FAILED:", e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

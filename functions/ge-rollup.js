// Weekly. Collapses daily rows into weekly OHLC bars kept forever, then prunes
// daily rows older than the cutoff. Full-detail history stays in the Storage
// archive and can be pulled back with ge-restore.

import { requireEnv, rpc, log } from "./_lib.js";

const CUTOFF_DAYS = Number(process.env.HOT_RETENTION_DAYS || 120);

export default async (req) => {
  try {
    requireEnv();
    const pruned = await rpc("rollup_weekly", { cutoff_days: CUTOFF_DAYS });
    log(`rollup done, pruned ${pruned} daily rows older than ${CUTOFF_DAYS}d`);
    return new Response(JSON.stringify({ ok: true, pruned, cutoff: CUTOFF_DAYS }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    log("ROLLUP FAILED:", e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

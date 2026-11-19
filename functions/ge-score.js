// Grades every call whose 7-day horizon has elapsed.
//
// This is the function that keeps the project honest. Without it you have a
// machine that produces confident opinions forever and never learns it is
// wrong. It runs on its own schedule so a broken emit never stops grading.
//
// Scoring uses the first snapshot on or after run_date + horizon_days, so a
// missing day shifts the exit slightly rather than stranding the call.

import { requireEnv, rpc, log } from "./_lib.js";

export default async (req) => {
  try {
    requireEnv();
    const scored = await rpc("score_due_signals", {});
    log(`scored ${scored} due call(s)`);

    // Pull the running record back so it lands in the function log - handy
    // when you want the track record without opening the site.
    let record = null;
    try {
      const res = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/v_signal_performance?select=call,scored,hit_rate,avg_outcome_pct,open_calls`,
        {
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      if (res.ok) {
        record = await res.json();
        for (const r of record) {
          log(`  ${r.call}: ${r.scored} scored, ${r.hit_rate ?? "-"}% hit, ` +
              `${r.avg_outcome_pct ?? "-"}% avg, ${r.open_calls} open`);
        }
      }
    } catch { /* logging only */ }

    return new Response(JSON.stringify({ ok: true, scored, record }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    log("SCORING FAILED:", e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

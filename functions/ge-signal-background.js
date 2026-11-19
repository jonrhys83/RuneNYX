// Writes today's calls into ge_signals.
//
// Runs after the daily ingest. The whole decision lives in SQL (emit_signals),
// so this function is a trigger, not a brain - the rule stays in one place and
// stays identical to the backtest that measured it.
//
// Idempotent: a second run on the same snapshot inserts nothing.
//
//   curl -X POST https://runenyx.netlify.app/.netlify/functions/ge-signal-background

import { requireEnv, rpc, log } from "./_lib.js";

export default async (req) => {
  const started = Date.now();
  try {
    requireEnv();

    // emit_signals() returns one row: { emitted, run }
    const res = await rpc("emit_signals", {});
    const row = Array.isArray(res) ? res[0] : res;
    const emitted = row?.emitted ?? 0;
    const runDate = row?.run ?? null;

    log(`signals: ${emitted} new call(s) for snapshot ${runDate}`);

    // Grading is cheap and must not depend on the emit succeeding, but when
    // both run fine it is tidier to settle due calls in the same pass.
    let scored = 0;
    try {
      scored = await rpc("score_due_signals", {});
      log(`scored ${scored} due call(s)`);
    } catch (e) {
      log(`scoring skipped: ${e.message}`);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        run_date: runDate,
        emitted,
        scored,
        seconds: +((Date.now() - started) / 1000).toFixed(1),
      }),
      { headers: { "content-type": "application/json" } }
    );
  } catch (e) {
    log("SIGNAL EMIT FAILED:", e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

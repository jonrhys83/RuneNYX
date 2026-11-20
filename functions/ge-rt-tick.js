// Hourly trigger for ge-rt.
//
// Exists only because Netlify will not serve a scheduled function over public
// HTTP - it returns 403. Putting the schedule here keeps ge-rt reachable by
// hand, which matters for verifying a change and for filling a missed hour.

import { log } from "./_lib.js";

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_URL;
  if (!base) return new Response("no site URL in env", { status: 500 });

  try {
    const res = await fetch(`${base}/.netlify/functions/ge-rt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trigger: "scheduled" }),
    });
    const text = await res.text();
    log(`fired ge-rt -> ${res.status} ${text.slice(0, 200)}`);
    return new Response(JSON.stringify({ fired: res.status }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    log(`failed to fire ge-rt: ${e.message}`);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

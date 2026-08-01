// Scheduled trigger. Scheduled functions get 30 seconds; the ingest needs more
// than that, so this only fires the background worker and returns.
// Schedule lives in netlify.toml.

import { log } from "./_lib.js";

export default async (req) => {
  const base = process.env.URL || process.env.DEPLOY_URL;
  if (!base) return new Response("no site URL in env", { status: 500 });

  const targets = ["ge-ingest-background", "ge-news"];
  const fired = [];

  for (const fn of targets) {
    try {
      const res = await fetch(`${base}/.netlify/functions/${fn}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trigger: "scheduled" }),
      });
      log(`fired ${fn} -> ${res.status}`);
      fired.push({ fn, status: res.status });
    } catch (e) {
      log(`failed to fire ${fn}: ${e.message}`);
      fired.push({ fn, error: e.message });
    }
  }

  return new Response(JSON.stringify({ fired }), {
    headers: { "content-type": "application/json" },
  });
};

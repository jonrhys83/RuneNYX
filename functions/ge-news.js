// Pulls the official RuneScape news feed. Patch notes move prices, so this is
// the layer that makes the analyzer more than a chart reader.

import { requireEnv, insert, log, UA } from "./_lib.js";

const RSS = "https://secure.runescape.com/m=news/latest_news.rss";

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : null;
}

export default async (req) => {
  try {
    requireEnv();

    const res = await fetch(RSS, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`rss ${res.status}`);
    const xml = await res.text();

    const rows = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
      const b = m[1];
      const link = tag(b, "link");
      const title = tag(b, "title");
      const pub = tag(b, "pubDate");
      const guid = tag(b, "guid") || link;
      if (!guid || !title) continue;

      const when = pub ? new Date(pub) : new Date();
      rows.push({
        guid,
        title,
        body: tag(b, "description"),
        url: link,
        category: tag(b, "category"),
        published_at: isNaN(when) ? new Date().toISOString() : when.toISOString(),
      });
    }

    // ignore-duplicates: already-seen posts stay as first recorded
    await insert("ge_news", rows, { onConflict: "guid", ignoreDuplicates: true });
    log(`news: ${rows.length} items seen`);

    return new Response(JSON.stringify({ ok: true, items: rows.length }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    log("NEWS FAILED:", e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

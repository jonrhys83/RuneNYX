// Shared helpers. No npm dependencies on purpose - this deploys without a build step.

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const UA = "RuneNYX GE tracker (contact: runenyx.netlify.app)";

export function requireEnv() {
  const missing = [];
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SERVICE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) throw new Error(`missing env: ${missing.join(", ")}`);
}

// Call a Postgres function through PostgREST using the service role key.
export async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${fn} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// Plain table insert / upsert.
export async function insert(table, rows, { onConflict, ignoreDuplicates } = {}) {
  if (!rows.length) return 0;
  const params = onConflict ? `?on_conflict=${onConflict}` : "";
  const resolution = ignoreDuplicates ? "ignore-duplicates" : "merge-duplicates";
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: `resolution=${resolution},return=minimal`,
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`insert ${table} -> ${res.status}: ${t.slice(0, 400)}`);
  }
  return rows.length;
}

// Upload bytes to a Storage bucket. upsert=true overwrites an existing object.
export async function putObject(bucket, path, body, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`storage put ${path} -> ${res.status}: ${t.slice(0, 400)}`);
  }
  return true;
}

export async function getObject(bucket, path) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    headers: { Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

export function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

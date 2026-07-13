import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type Entry = { d: string; p: string; ts?: number; [k: string]: unknown };
type Db = { entries: Record<string, Entry>; deleted: Record<string, number> };

const emptyDb = (): Db => ({ entries: {}, deleted: {} });

// newer ts wins per entry; tombstones remove entries older than the deletion
function merge(a: Db, b: Db): Db {
  const entries: Record<string, Entry> = { ...a.entries };
  const deleted: Record<string, number> = { ...a.deleted };
  for (const k in b.deleted || {}) {
    deleted[k] = Math.max(deleted[k] || 0, b.deleted[k]);
  }
  for (const k in b.entries || {}) {
    const e = b.entries[k];
    if (!e || !e.d || !e.p) continue;
    if (!entries[k] || (e.ts || 0) > (entries[k].ts || 0)) entries[k] = e;
  }
  for (const k in deleted) {
    if (entries[k]) {
      if ((entries[k].ts || 0) <= deleted[k]) delete entries[k];
      else delete deleted[k];
    }
  }
  return { entries, deleted };
}

export default async (req: Request, context: Context) => {
  const secret = Netlify.env.get("SYNC_KEY");
  if (!secret || req.headers.get("x-sync-key") !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const store = getStore({ name: "verkjadagbok", consistency: "strong" });
  const current: Db = (await store.get("db", { type: "json" })) || emptyDb();

  if (req.method === "GET") {
    return Response.json(current);
  }

  if (req.method === "POST") {
    let body: Db;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }
    const merged = merge(current, {
      entries: body.entries || {},
      deleted: body.deleted || {},
    });
    await store.setJSON("db", merged);
    return Response.json(merged);
  }

  return Response.json({ error: "method not allowed" }, { status: 405 });
};

export const config: Config = {
  path: "/api/sync",
};

import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type Entry = { d: string; p: string; ts?: number; [k: string]: unknown };
type Ev = { id: string; type: string; d: string; ts?: number; [k: string]: unknown };
type Db = {
  entries: Record<string, Entry>;
  deleted: Record<string, number>;
  events: Record<string, Ev>;
  eventsDeleted: Record<string, number>;
};

const emptyDb = (): Db => ({ entries: {}, deleted: {}, events: {}, eventsDeleted: {} });

// generic last-write-wins + tombstone merge for one keyed collection
function mergeColl<T extends { ts?: number }>(
  aItems: Record<string, T>,
  aDel: Record<string, number>,
  bItems: Record<string, T>,
  bDel: Record<string, number>,
  valid: (x: T) => boolean
): { items: Record<string, T>; deleted: Record<string, number> } {
  const items: Record<string, T> = { ...(aItems || {}) };
  const deleted: Record<string, number> = { ...(aDel || {}) };
  for (const k in bDel || {}) {
    deleted[k] = Math.max(deleted[k] || 0, bDel[k]);
  }
  for (const k in bItems || {}) {
    const e = bItems[k];
    if (!e || !valid(e)) continue;
    if (!items[k] || (e.ts || 0) > (items[k].ts || 0)) items[k] = e;
  }
  for (const k in deleted) {
    if (items[k]) {
      if ((items[k].ts || 0) <= deleted[k]) delete items[k];
      else delete deleted[k];
    }
  }
  return { items, deleted };
}

// newer ts wins per record; tombstones remove records older than the deletion
function merge(a: Db, b: Db): Db {
  const ent = mergeColl<Entry>(
    a.entries, a.deleted, b.entries || {}, b.deleted || {},
    (e) => !!e.d && !!e.p
  );
  const ev = mergeColl<Ev>(
    a.events || {}, a.eventsDeleted || {}, b.events || {}, b.eventsDeleted || {},
    (e) => !!e.id && !!e.type && !!e.d
  );
  return {
    entries: ent.items,
    deleted: ent.deleted,
    events: ev.items,
    eventsDeleted: ev.deleted,
  };
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
      events: body.events || {},
      eventsDeleted: body.eventsDeleted || {},
    });
    await store.setJSON("db", merged);
    return Response.json(merged);
  }

  return Response.json({ error: "method not allowed" }, { status: 405 });
};

export const config: Config = {
  path: "/api/sync",
};

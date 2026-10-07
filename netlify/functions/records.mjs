/* Lab records, stored server-side so one history follows you across devices.

   One blob per record rather than a single array blob: the phone and the PC
   both hold a local copy, and a whole-array write from a stale client would
   silently drop records written on the other device. Per-record keys make a
   concurrent write at worst a no-op, never a loss.

   Access control is the site's own: team protection gates every path under
   this domain, functions included (verified: an uncookied request to
   /api/* returns 401 without the function running). */

import { getStore } from "@netlify/blobs";

const PREFIX = "rec/";
const MAX_BODY = 200 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8",
               "cache-control": "no-store" }
  });

export default async (req) => {
  let store;
  try {
    store = getStore({ name: "peiye-records", consistency: "strong" });
  } catch (e) {
    return json({ error: "存储未就绪：" + e.message }, 503);
  }

  try {
    if (req.method === "GET") {
      const { blobs } = await store.list({ prefix: PREFIX });
      const recs = await Promise.all(blobs.map(async b => {
        try { return await store.get(b.key, { type: "json" }); }
        catch (e) { return null; }
      }));
      const out = recs.filter(Boolean).sort((a, b) => (a.t || 0) - (b.t || 0));
      return json({ ok: true, records: out });
    }

    if (req.method === "POST") {
      const raw = await req.text();
      if (raw.length > MAX_BODY) return json({ error: "数据过大" }, 413);
      const body = JSON.parse(raw);
      const list = Array.isArray(body.records) ? body.records : [];
      if (!list.length) return json({ error: "没有要保存的记录" }, 400);
      let saved = 0;
      for (const r of list) {
        if (!r || !r.id) continue;
        await store.setJSON(PREFIX + String(r.id), r);
        saved++;
      }
      return json({ ok: true, saved });
    }

    if (req.method === "DELETE") {
      const url = new URL(req.url);
      const id = url.searchParams.get("id");
      if (id === "__all__") {
        const { blobs } = await store.list({ prefix: PREFIX });
        await Promise.all(blobs.map(b => store.delete(b.key)));
        return json({ ok: true, deleted: blobs.length });
      }
      if (!id) return json({ error: "缺少 id" }, 400);
      await store.delete(PREFIX + id);
      return json({ ok: true, deleted: 1 });
    }

    return json({ error: "只支持 GET / POST / DELETE" }, 405);
  } catch (e) {
    return json({ error: "存储操作失败：" + e.message }, 500);
  }
};

export const config = { path: "/api/records" };

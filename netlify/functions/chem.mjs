/* Reagent lookup against PubChem, plus a small cloud-side reagent cache.

   PubChem (PUG REST) is free, public, documented and needs no key — the right
   source for formula / molar mass / CAS. It has no Chinese name index, so a
   CJK query is translated to an English name first (via the same DeepSeek key
   the parser uses) and only then resolved.

   Supplier catalogue data (price, pack sizes, lot purity) is deliberately NOT
   fetched: Sigma/Macklin/Aladdin have no public API, their site endpoints
   require a login and sit behind bot protection, and scraping them would be
   both fragile and against their terms. The UI links to their search pages
   instead, which costs one click and never breaks.                          */

import { getStore } from "@netlify/blobs";

const PUG = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
const CACHE_PREFIX = "chem/";
const CAS_RE = /^\d{2,7}-\d{2}-\d$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8",
               "cache-control": "no-store" }
  });

const hasCJK = s => /[一-鿿]/.test(s);

async function pubchem(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(PUG + path, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally { clearTimeout(timer); }
}

/** Ask the model only for an English name — never for any number. */
async function toEnglish(name) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content:
            "把用户给的化学试剂中文名翻译成 PubChem 能检索到的英文通用名。" +
            '只输出 JSON：{"en":"...","cas":"..."}。cas 不确定就省略。' +
            "不要输出分子量、分子式或任何数字性质。" },
          { role: "user", content: name }
        ],
        response_format: { type: "json_object" },
        temperature: 0, max_tokens: 100
      })
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    const c = d?.choices?.[0]?.message?.content;
    if (!c) return null;
    const parsed = JSON.parse(c);
    return { en: parsed.en || null, cas: parsed.cas || null };
  } catch (e) { return null; }
}

async function lookup(query) {
  const q = String(query || "").trim();
  if (!q) return { error: "没有收到试剂名" };

  let term = q, via = "原文", translated = null;
  if (hasCJK(q)) {
    translated = await toEnglish(q);
    if (translated?.cas && CAS_RE.test(translated.cas)) { term = translated.cas; via = "AI 译名 → CAS"; }
    else if (translated?.en) { term = translated.en; via = "AI 译名"; }
    else return { error: "PubChem 没有中文索引，而译名失败。请改用英文名或 CAS 号。" };
  }

  const enc = encodeURIComponent(term);
  const props = await pubchem(
    `/compound/name/${enc}/property/MolecularFormula,MolecularWeight,IUPACName/JSON`);
  const p = props?.PropertyTable?.Properties?.[0];
  if (!p) {
    return { error: `PubChem 查不到「${term}」。` +
      (hasCJK(q) ? `（由「${q}」译出）` : "") +
      "聚合物（壳聚糖、Nafion 等）本来就没有确定分子量，属正常。" };
  }

  let cas = translated?.cas && CAS_RE.test(translated.cas) ? translated.cas : null;
  if (!cas) {
    const syn = await pubchem(`/compound/cid/${p.CID}/synonyms/JSON`);
    const list = syn?.InformationList?.Information?.[0]?.Synonym || [];
    cas = list.find(x => CAS_RE.test(x)) || null;
  }

  return {
    query: q, term, via,
    cid: p.CID, formula: p.MolecularFormula,
    mass: parseFloat(p.MolecularWeight),
    iupac: p.IUPACName || null, cas,
    source: `PubChem CID ${p.CID}`
  };
}

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const q = url.searchParams.get("q");
    if (q) {
      const r = await lookup(q);
      return r.error ? json({ ok: false, ...r }, 404) : json({ ok: true, ...r });
    }
    // no query: return the saved reagents
    try {
      const store = getStore({ name: "peiye-records", consistency: "strong" });
      const { blobs } = await store.list({ prefix: CACHE_PREFIX });
      const items = await Promise.all(blobs.map(b =>
        store.get(b.key, { type: "json" }).catch(() => null)));
      return json({ ok: true, saved: items.filter(Boolean) });
    } catch (e) { return json({ ok: true, saved: [] }); }
  }

  if (req.method === "POST") {
    try {
      const body = await req.json();
      const r = body?.reagent;
      if (!r || !r.name) return json({ error: "缺少试剂名" }, 400);
      const store = getStore({ name: "peiye-records", consistency: "strong" });
      await store.setJSON(CACHE_PREFIX + encodeURIComponent(r.name), r);
      return json({ ok: true });
    } catch (e) { return json({ error: "保存失败：" + e.message }, 500); }
  }

  if (req.method === "DELETE") {
    const name = url.searchParams.get("name");
    if (!name) return json({ error: "缺少 name" }, 400);
    try {
      const store = getStore({ name: "peiye-records", consistency: "strong" });
      await store.delete(CACHE_PREFIX + encodeURIComponent(name));
      return json({ ok: true });
    } catch (e) { return json({ error: "删除失败：" + e.message }, 500); }
  }

  return json({ error: "只支持 GET / POST / DELETE" }, 405);
};

export const config = { path: "/api/chem" };

/* ============================================================================
   UI layer. CORE (above) holds every calculation; nothing here does maths
   beyond formatting and assembling the worked lines.
   ========================================================================== */
(function () {
"use strict";
const C = CORE;
const $ = id => document.getElementById(id);

function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === "class") n.className = attrs[k];
    else if (k === "html") n.innerHTML = attrs[k];
    else if (k.startsWith("on")) n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
    else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return n;
}
const num = v => {
  const s = String(v == null ? "" : v).replace(/[，,\s]/g, "").trim();
  if (!s) return NaN;
  const x = Number(s);
  return isFinite(x) ? x : NaN;
};
/** Na2HPO4·12H2O → Na₂HPO₄·12H₂O (digits after a letter become subscripts) */
const SUBS = "₀₁₂₃₄₅₆₇₈₉";
function pretty(f) {
  if (!f) return "";
  return f.replace(/([A-Za-z\)\]])(\d+)/g,
    (_, a, d) => a + d.split("").map(c => SUBS[+c]).join(""));
}
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" }[c]));

/* ---------- reagent drawer ----------------------------------------------- */
let libTarget = null;
const LIB = C.REAGENTS.map(r => {
  let M = null;
  if (r.f) { try { M = C.molarMass(r.f).mass; } catch (e) { M = null; } }
  return Object.assign({}, r, { M });
});
function openLib(cb) {
  libTarget = cb;
  $("scrim").classList.add("on");
  $("drawer").classList.add("on");
  $("libSearch").value = "";
  renderLib("");
  $("libSearch").focus();
}
function closeLib() {
  libTarget = null;
  $("scrim").classList.remove("on");
  $("drawer").classList.remove("on");
}
function renderLib(q) {
  const list = $("libList");
  list.innerHTML = "";
  const needle = q.trim().toLowerCase();
  const hits = LIB.filter(r => !needle ||
    (r.n + " " + r.en + " " + (r.f || "") + " " + r.g).toLowerCase().includes(needle));
  if (!hits.length) { list.appendChild(h("div", { class: "lib-group" }, "没有匹配的试剂")); return; }
  let group = null;
  for (const r of hits) {
    if (r.g !== group) { group = r.g; list.appendChild(h("div", { class: "lib-group" }, group)); }
    const meta = [];
    if (r.f) meta.push(h("span", null, pretty(r.f)));
    if (r.M) meta.push(h("span", { class: "mw" }, "M " + C.sig(r.M, 6) + " g/mol"));
    if (r.rho) meta.push(h("span", null, "ρ " + r.rho + " g/mL · " + Math.round(r.w * 1000) / 10 + "%"));
    list.appendChild(h("button", { class: "lib-item", type: "button",
      onclick: () => { if (libTarget) libTarget(r); closeLib(); } },
      h("div", { class: "nm" }, r.n + "  " + r.en),
      meta.length ? h("div", { class: "fm" }, meta) : null,
      r.note ? h("div", { class: "no" }, r.note) : null));
  }
}
$("libSearch").addEventListener("input", e => renderLib(e.target.value));
$("drawerClose").addEventListener("click", closeLib);
$("scrim").addEventListener("click", closeLib);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeLib(); });

/* ---------- field -------------------------------------------------------- */
function mkField(spec) {
  const input = h("input", { type: "text", inputmode: "decimal", autocomplete: "off",
    placeholder: spec.placeholder || "", value: spec.value != null ? spec.value : "" });
  let sel = null;
  const row = h("div", { class: "inrow" }, input);
  const units = spec.dim ? C.DIMS[spec.dim].units : null;
  if (units && units.length > 1) {
    sel = h("select", null, units.map(u => h("option", { value: u[0] }, u[0])));
    sel.value = spec.unit || C.baseUnitName(spec.dim);
    row.appendChild(sel);
  } else {
    input.classList.add("solo");
    if (spec.suffix) {
      sel = h("select", null, [h("option", { value: spec.suffix }, spec.suffix)]);
      input.classList.remove("solo"); row.appendChild(sel);
    }
  }
  const node = h("label", { class: "field" },
    h("span", { class: "lab" },
      h("span", null, spec.label),
      spec.sym ? h("span", { class: "sym" }, spec.sym) : null,
      spec.side || null),
    row,
    spec.hint ? h("span", { class: "hint", html: spec.hint }) : null);

  const api = {
    key: spec.key, dim: spec.dim, node, input, sel, spec,
    getBase() {
      const v = num(input.value);
      if (!isFinite(v)) return NaN;
      return spec.dim ? C.toBase(v, spec.dim, sel ? sel.value : C.baseUnitName(spec.dim)) : v;
    },
    getRaw() { return num(input.value); },
    unit() { return sel ? sel.value : (spec.dim ? C.baseUnitName(spec.dim) : (spec.suffix || "")); },
    text() {
      const v = input.value.trim();
      return v ? v + (api.unit() ? " " + api.unit() : "") : "—";
    },
    setBase(v) {
      if (!isFinite(v)) { input.value = ""; return; }
      if (spec.dim) {
        const u = C.pickUnit(v, spec.dim);
        if (sel) sel.value = u;
        input.value = C.sig(C.fromBase(v, spec.dim, u), 5);
      } else input.value = C.sig(v, 5);
    },
    setSolved(on) {
      node.classList.toggle("solved", !!on);
      input.readOnly = !!on;
      input.tabIndex = on ? -1 : 0;
      if (on) input.value = "";
    },
    clear() { input.value = ""; }
  };
  const fire = () => spec.onchange && spec.onchange();
  input.addEventListener("input", fire);
  if (sel) sel.addEventListener("change", fire);
  return api;
}

/* ---------- result card -------------------------------------------------- */
function mkResult(moduleName) {
  const host = h("div", { class: "result" });
  const api = {
    node: host,
    moduleName: moduleName || "",
    last: null,
    show(o) {
      api.last = o && !o.error ? o : null;
      host.innerHTML = "";
      if (o.error) {
        host.appendChild(h("div", { class: "cap" }, "结果"));
        host.appendChild(h("div", { class: "err", style: "margin-top:8px" }, o.error));
        (o.notes || []).forEach(n => host.appendChild(mkNote(n)));
        return;
      }
      host.appendChild(h("div", { class: "cap" }, o.cap || "结果"));
      if (o.big) {
        const a = o.dim ? C.auto(o.base, o.dim, 4) : null;
        host.appendChild(h("div", { class: "big" },
          a ? C.sig(a.value, 4) : o.big,
          a ? h("span", { class: "u" }, a.unit) : null));
      }
      if (o.say) host.appendChild(h("div", { class: "say", html: o.say }));
      if (o.expr) {
        host.appendChild(h("div", { class: "work" },
          h("span", { class: "eq" }, o.expr),
          o.subs ? h("span", { class: "sb" }, o.subs) : null,
          o.tail ? h("span", { class: "sb" }, o.tail) : null));
      }
      if (o.dim && o.base != null && isFinite(o.base) && o.equiv !== false) {
        host.appendChild(h("div", { class: "equiv" },
          h("table", null, h("tbody", null,
            C.allUnits(o.base, o.dim, 5).map(e =>
              h("tr", null, h("td", null, e.unit), h("td", null, e.text)))))));
      }
      (o.notes || []).forEach(n => host.appendChild(mkNote(n)));
      (o.extra || []).forEach(n => host.appendChild(n));
      if (api.onRecord) {
        host.appendChild(h("div", { class: "rec-row" }, recButton(api.onRecord)));
      }
    }
  };
  return api;
}
function mkNote(n) {
  if (typeof n === "string") n = { text: n };
  return h("div", { class: "note " + (n.kind || ""), html: n.text });
}
function segmented(label, opts, current, onPick) {
  const wrap = h("div", { class: "seg" }, h("span", { class: "seg-lab" }, label));
  opts.forEach(o => {
    const b = h("button", { type: "button", "aria-pressed": String(o.key === current) },
      o.label);
    b.addEventListener("click", () => onPick(o.key));
    wrap.appendChild(b);
  });
  return wrap;
}
/** CORE throws "请填写 C2"; swap the bare key for the field's own label. */
function humanize(msg, F) {
  return String(msg).replace(/(请填写|不能为负|不能为 0)?\s*([A-Za-z_]\w*)/g, (whole, pre, key) => {
    const f = F && F[key];
    if (!f) return whole;
    const name = (f.spec.sym ? f.spec.sym + " " : "") + f.spec.label;
    return (pre ? pre + " " : "") + name;
  });
}
function libButton(onPick) {
  return h("button", { class: "lib-btn", type: "button", style: "margin-left:auto",
    onclick: e => { e.preventDefault(); openLib(onPick); } }, "试剂库");
}


/* ---------- record store -------------------------------------------------
   Lab records accumulate across calculations and survive reload. Every
   browser-storage access is wrapped: private windows and thumbnailers throw. */
const REC_KEY = "peiye.records";
let RECORDS = [];
try {
  const raw = localStorage.getItem(REC_KEY);
  if (raw) RECORDS = JSON.parse(raw) || [];
} catch (e) { RECORDS = []; }
if (!Array.isArray(RECORDS)) RECORDS = [];

const recListeners = [];
function recSave() {
  try { localStorage.setItem(REC_KEY, JSON.stringify(RECORDS)); } catch (e) {}
  recListeners.forEach(fn => { try { fn(); } catch (e) {} });
}
function recAdd(rec) {
  rec.id = String(Date.now()) + Math.random().toString(36).slice(2, 7);
  rec.t = Date.now();
  RECORDS.push(rec);
  recSave();
}
function recRemove(id) {
  const i = RECORDS.findIndex(r => r.id === id);
  if (i >= 0) { RECORDS.splice(i, 1); recSave(); }
}
function recClear() { RECORDS = []; recSave(); }

/** innerHTML in a note/say → plain text for the record. */
function plain(html) {
  if (html == null) return "";
  const d = document.createElement("div");
  d.innerHTML = String(html);
  return (d.textContent || "").replace(/\s+/g, " ").trim();
}

/** A "记一笔" button bound to a function that builds the record object. */
function recButton(build, label) {
  const b = h("button", { class: "lib-btn rec-btn", type: "button" }, label || "记一笔");
  b.addEventListener("click", () => {
    let rec;
    try { rec = build(); } catch (e) { rec = null; }
    if (!rec) { flash(b, "没有可记录的结果", true); return; }
    recAdd(rec);
    flash(b, "已记录 ✓");
    bumpRailBadge();
  });
  return b;
}
function flash(btn, text, bad) {
  const old = btn.textContent;
  btn.textContent = text;
  btn.classList.toggle("bad", !!bad);
  setTimeout(() => { btn.textContent = old; btn.classList.remove("bad"); }, 1400);
}

/** Build a record from whatever the result card last rendered. */
function stdRecord(res, moduleName, inputsFn) {
  return () => {
    const last = res.last;
    if (!last) return null;
    const result = (last.dim != null && isFinite(last.base))
      ? C.auto(last.base, last.dim).text
      : (typeof last.big === "string" ? last.big : "");
    return {
      module: moduleName,
      inputs: inputsFn ? inputsFn() : [],
      formula: last.expr || "",
      formulaSubs: [last.subs, last.tail].filter(Boolean).join("\n    "),
      result: result,
      say: plain(last.say),
      notes: (last.notes || [])
        .map(n => plain(typeof n === "string" ? n : (n && n.text)))
        .filter(Boolean)
    };
  };
}
/** Read a DOM table back out as {head, rows} for the record. */
function grabTable(tbl) {
  if (!tbl) return null;
  const head = Array.from(tbl.querySelectorAll("thead th")).map(t => t.innerText.trim());
  const rows = Array.from(tbl.querySelectorAll("tbody tr"))
    .map(tr => Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim()));
  return (head.length && rows.length) ? { head, rows } : null;
}

/* ---------- copy / download ---------------------------------------------- */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // clipboard API needs a secure context and permission; fall back
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e2) { return false; }
  }
}
function downloadText(text, filename) {
  try {
    const blob = new Blob(["﻿" + text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch (e) { return false; }
}
function stampFile() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/* ===========================================================================
   MODULES
   ========================================================================= */
const MODULES = [];
function mod(def) { MODULES.push(def); }


/* ---- 0. 文字输入 --------------------------------------------------------- */
mod({ id: "ask", group: "文字输入", name: "说一句话", title: "直接说你要配什么",
  desc: "用一句话描述需求，自动匹配计算。这是本地规则解析，不是 AI —— 认得出的句式会把公式写给你核对，认不出就明说缺什么，不会编数字。",
  build(root) {
    const ta = h("textarea", { class: "ask-input", rows: "3", spellcheck: "false",
      placeholder: "例如：配 20 mL 1% 壳聚糖，溶在 1% 乙酸里" });
    const out = h("div");
    let last = null, mode = "local", busy = false;
    try { mode = localStorage.getItem("peiye.askmode") || "local"; } catch (e) {}

    const modeBox = h("div");
    function drawMode() {
      modeBox.innerHTML = "";
      modeBox.appendChild(segmented("解析", [
        { key: "local", label: "本地规则" }, { key: "ai", label: "AI (DeepSeek)" }
      ], mode, k => {
        mode = k;
        try { localStorage.setItem("peiye.askmode", k); } catch (e) {}
        drawMode(); render();
      }));
    }

    /** AI path: the model only reads the sentence, CORE still does the maths. */
    async function askAI(text) {
      busy = true; render();
      let r;
      try {
        const resp = await fetch("/api/ask", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ text })
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data || !data.ok) {
          busy = false;
          showError((data && data.error) || `服务端返回 ${resp.status}`);
          return;
        }
        r = C.solveFromLLM(data.params);
      } catch (e) {
        busy = false;
        showError("连不上解析服务：" + e.message + "（离线时请切回「本地规则」）");
        return;
      }
      busy = false;
      last = r;
      paint(r, text);
    }
    function showError(msg) {
      out.innerHTML = "";
      out.appendChild(h("div", { class: "card" },
        h("h3", null, "AI 解析没成功"),
        h("div", { class: "note danger", html: esc(msg) }),
        h("div", { class: "tiny", style: "margin-top:9px" },
          "可以切到「本地规则」试试 —— 常见句式本地就能认。")));
    }

    const EXAMPLES = [
      "配 20 mL 1% 壳聚糖，在 1% 乙酸中",
      "配 50 mL 10 mM NaCl",
      "用 K3[Fe(CN)6] 配 100 mL 5 mM",
      "从 1 M 母液配 50 mL 10 mM，取多少",
      "配 500 mL 0.1 M PBS pH 7.4",
      "配 100 mL 5 mg/mL BSA"
    ];

    let timer = null;
    function render() {
      const text = ta.value.trim();
      if (!text) { out.innerHTML = ""; last = null; return; }
      if (mode === "ai") {
        out.innerHTML = "";
        out.appendChild(h("div", { class: "card" },
          h("div", { class: "tiny" }, busy ? "正在问 DeepSeek…" : "改完后点下面的按钮发给 AI 解析。"),
          busy ? null : (() => {
            const b = h("button", { class: "chip", type: "button", style: "margin-top:10px" },
              "用 AI 解析这句话");
            b.addEventListener("click", () => askAI(text));
            return b;
          })()));
        return;
      }
      out.innerHTML = "";
      let r;
      try { r = C.askText(text); }
      catch (e) { out.appendChild(h("div", { class: "err" }, "解析出错：" + e.message)); return; }
      last = r;
      paint(r, text);
    }

    function paint(r, text) {
      out.innerHTML = "";

      // what it understood — shown first so a misread is caught before the numbers
      const seen = [];
      for (const k in (r.echo || {})) {
        const v = r.echo[k];
        if (v == null || (Array.isArray(v) && !v.length)) continue;
        seen.push(h("div", { class: "echo-row" },
          h("span", { class: "echo-k" }, k),
          h("span", { class: "echo-v" }, Array.isArray(v) ? v.join("、") : String(v))));
      }
      out.appendChild(h("div", { class: "card" },
        h("h3", null, "它听懂的内容"),
        seen.length ? h("div", { class: "echo" }, seen)
                    : h("div", { class: "tiny" }, "没抽取到任何数量"),
        h("div", { class: "tiny", style: "margin-top:9px" },
          "对不上就说明句子被误读了 —— 改写一下，或者直接用左边对应的模块。")));

      if (!r.ok) {
        out.appendChild(h("div", { class: "card" },
          h("h3", null, "还差什么"),
          h("div", { class: "fields" },
            (r.missing || []).map(m => h("div", { class: "note warn", html: m })))));
        return;
      }

      const body = h("div", { class: "card" }, h("div", { class: "card-head" },
        h("h3", null, r.title || "结果"),
        recButton(() => last && last.ok ? {
          module: "文字输入 · " + (last.title || ""),
          inputs: [["原始描述", text]],
          tableTitle: "配制",
          table: { head: ["操作", "物质", "用量"],
                   rows: last.items.map(i => [i.how, i.what, i.amount]) },
          notes: (last.warnings || []).concat(last.notes || []).map(plain)
        } : null)));
      const tbl = h("table", { class: "data" },
        h("thead", null, h("tr", null, ["操作", "物质", "用量", "依据"].map(t => h("th", null, t)))),
        h("tbody", null, r.items.map(i => h("tr", null,
          h("td", null, i.how),
          h("td", { style: "color:var(--ink)" }, i.what),
          h("td", { class: "em" }, i.amount),
          h("td", null, i.formula || "")))));
      body.appendChild(h("div", { class: "tablewrap" }, tbl));
      r.items.filter(i => i.note).forEach(i =>
        body.appendChild(mkNote({ kind: "", text: "<b>" + i.what + "</b>：" + i.note })));
      (r.warnings || []).forEach(w => body.appendChild(mkNote({ kind: "warn", text: w })));
      (r.notes || []).forEach(n => body.appendChild(mkNote({ kind: "", text: n })));
      out.appendChild(body);
    }

    drawMode();
    ta.addEventListener("input", () => {
      // in AI mode typing must not fire a request per keystroke
      if (mode === "ai") { render(); return; }
      render();
    });
    const chips = h("div", { class: "chiprow" }, EXAMPLES.map(e => {
      const b = h("button", { class: "chip", type: "button" }, e);
      b.addEventListener("click", () => { ta.value = e; render(); ta.focus(); });
      return b;
    }));

    root.appendChild(h("div", null,
      h("div", { class: "card" },
        modeBox,
        ta,
        h("div", { class: "tiny", style: "margin-top:10px", html:
          "能认的：体积（µL/mL/L）、摩尔浓度（<b>大写 M</b>：nM/µM/mM/M）、百分比（%、%(w/v)、%(v/v)）、" +
          "质量浓度（mg/mL、µg/mL、g/L、ppm）、摩尔质量（g/mol、Da、kDa）、pH、化学式、试剂库里的名字。" }),
        h("div", { class: "tiny", style: "margin-top:6px", html:
          "小写 <code>mm</code> / <code>nm</code> 当作长度不当作浓度 —— 浓度请写大写 M。" }),
        chips),
      out));
    render();
  }});

/* ---- 1. 配制（固体 → 溶液） ------------------------------------------- */
mod({ id: "prep", group: "配液", name: "配制", title: "配制溶液 · 称取质量",
  desc: "m = M · C · V。填三个，第四个自动算。摩尔质量可以从试剂库一键取，也可以在「分子量」页用化学式算。",
  build(root) {
    let unknown = "m";
    const res = mkResult("配制溶液 · 称取质量");
    const recalc = () => run();
    const F = {
      M: mkField({ key:"M", label:"摩尔质量", sym:"M", dim:"molar", unit:"g/mol",
                   placeholder:"58.44", value:"58.44", onchange:recalc,
                   side: libButton(r => {
                     if (!r.M) { alert(r.n + "：" + (r.note || "没有摩尔质量")); return; }
                     F.M.input.value = C.sig(r.M, 6); recalc();
                   }) }),
      C: mkField({ key:"C", label:"目标浓度", sym:"C", dim:"conc", unit:"mM",
                   placeholder:"10", value:"10", onchange:recalc }),
      V: mkField({ key:"V", label:"配制体积", sym:"V", dim:"volume", unit:"mL",
                   placeholder:"50", value:"50", onchange:recalc }),
      m: mkField({ key:"m", label:"称取质量", sym:"m", dim:"mass", unit:"mg",
                   placeholder:"—", onchange:recalc })
    };
    const dBal = mkField({ key:"d", label:"天平分度值", dim:null, suffix:"mg",
                           value:"0.1", onchange:recalc });
    const seg = h("div");
    const fieldsBox = h("div", { class: "fields" }, F.M.node, F.C.node, F.V.node, F.m.node);

    function drawSeg() {
      seg.innerHTML = "";
      seg.appendChild(segmented("求解", [
        { key:"m", label:"m 质量" }, { key:"C", label:"C 浓度" },
        { key:"V", label:"V 体积" }, { key:"M", label:"M 分子量" }
      ], unknown, k => { unknown = k; drawSeg(); sync(); run(); }));
    }
    function sync() { for (const k in F) F[k].setSolved(k === unknown); }

    function run() {
      const vals = {}; for (const k in F) vals[k] = F[k].getBase();
      try {
        const r = C.prep(vals, unknown);
        F[unknown].setBase(r.value);
        const used = { m:["M","C","V"], C:["M","V","m"], V:["M","C","m"], M:["C","V","m"] }[unknown];
        const notes = [];
        const mBase = unknown === "m" ? r.value : vals.m;
        if (isFinite(mBase) && mBase > 0) {
          const d = num(dBal.input.value);
          const we = C.weighError(mBase, isFinite(d) ? d : 0.1);
          if (we) {
            const pct = we.relative;
            const txt = `按 ${we.d_mg} mg 分度值，称 <b>${C.auto(mBase,"mass").text}</b> 的相对误差约 <b>${C.sig(pct,2)} %</b>。`;
            if (pct > 5) notes.push({ kind:"danger", text: txt +
              " 这个量太小，天平读数误差就有 5 % 以上 —— 先配高浓度母液，再按倍数稀释。" });
            else if (pct > 1) notes.push({ kind:"warn", text: txt +
              " 已经接近常规分析天平的可靠下限，建议配母液再稀释。" });
            else notes.push({ kind:"", text: txt });
          }
        }
        const sayMap = {
          m: () => `称 <b>${C.auto(r.value,"mass").text}</b>，溶解后定容到 <b>${C.auto(vals.V,"volume").text}</b>。`,
          C: () => `${C.auto(vals.m,"mass").text} 溶于 ${C.auto(vals.V,"volume").text}，浓度是 <b>${C.auto(r.value,"conc").text}</b>。`,
          V: () => `把 ${C.auto(vals.m,"mass").text} 定容到 <b>${C.auto(r.value,"volume").text}</b> 才是 ${C.auto(vals.C,"conc").text}。`,
          M: () => `反推出的摩尔质量是 <b>${C.sig(r.value,5)} g/mol</b>。`
        };
        res.show({ base: r.value, dim: r.dim, big: true, expr: r.expr,
          subs: used.map(k => `${F[k].spec.sym} ${F[k].text()}`).join("   ·   "),
          say: sayMap[unknown](), notes });
      } catch (e) {
        F[unknown].clear();
        res.show({ error: humanize(e.message, F) });
      }
    }
    res.onRecord = stdRecord(res, "配制溶液 · 称取质量",
      () => ["M","C","V","m"].map(k =>
        [F[k].spec.label + (F[k].spec.sym ? " " + F[k].spec.sym : ""), F[k].text()]));
    drawSeg(); sync();
    root.appendChild(h("div", { class: "cols" },
      h("div", null,
        h("div", { class: "card" }, seg, fieldsBox),
        h("div", { class: "card" },
          h("h3", null, "称量可行性"),
          h("div", { class: "fields" }, dBal.node),
          h("div", { class: "tiny", style:"margin-top:8px" },
            "相对误差 = 分度值 ÷ 称取质量。常规分析天平 0.1 mg，十万分之一天平 0.01 mg。"))),
      res.node));
    run();
  }});

/* ---- 2. 稀释 ------------------------------------------------------------ */
mod({ id: "dilute", group: "配液", name: "稀释", title: "稀释 · C₁V₁ = C₂V₂",
  desc: "母液和目标液四个量，填三个算第四个。单位随便填 µL / mL / L、µM / mM / M，不用先换算。",
  build(root) {
    let unknown = "V1";
    const res = mkResult("稀释 · C1V1 = C2V2");
    const recalc = () => run();
    const F = {
      C1: mkField({ key:"C1", label:"母液浓度", sym:"C₁", dim:"conc", unit:"M",
                    placeholder:"11.75", value:"11.75", onchange:recalc }),
      V1: mkField({ key:"V1", label:"取母液体积", sym:"V₁", dim:"volume", unit:"µL",
                    placeholder:"—", onchange:recalc }),
      C2: mkField({ key:"C2", label:"目标浓度", sym:"C₂", dim:"conc", unit:"mM",
                    placeholder:"8", value:"8", onchange:recalc }),
      V2: mkField({ key:"V2", label:"目标总体积", sym:"V₂", dim:"volume", unit:"mL",
                    placeholder:"50", value:"50", onchange:recalc })
    };
    const seg = h("div");
    function drawSeg() {
      seg.innerHTML = "";
      seg.appendChild(segmented("求解", [
        { key:"V1", label:"V₁ 取多少" }, { key:"C2", label:"C₂ 稀释后" },
        { key:"C1", label:"C₁ 母液" }, { key:"V2", label:"V₂ 定容到" }
      ], unknown, k => { unknown = k; drawSeg(); sync(); run(); }));
    }
    function sync() { for (const k in F) F[k].setSolved(k === unknown); }

    function run() {
      const vals = {}; for (const k in F) vals[k] = F[k].getBase();
      try {
        const r = C.dilution(vals, unknown);
        F[unknown].setBase(r.value);
        const all = Object.assign({}, vals); all[unknown] = r.value;
        const used = { C2:["C1","V1","V2"], V2:["C1","V1","C2"],
                       C1:["C2","V2","V1"], V1:["C2","V2","C1"] }[unknown];
        const notes = [];
        const add = all.V2 - all.V1;
        if (isFinite(add)) {
          if (add < 0) notes.push({ kind:"danger",
            text:"取样体积比目标总体积还大 —— 检查一下浓度是不是填反了。" });
          else notes.push({ kind:"info", text:
            `稀释倍数 <b>${C.sig(all.C1 / all.C2, 4)} ×</b>，需补稀释液 <b>${C.auto(add,"volume").text}</b>。` });
        }
        if (isFinite(all.V1) && all.V1 > 0 && all.V1 < 5e-6) notes.push({ kind:"warn",
          text:`取样量只有 ${C.auto(all.V1,"volume").text}，低于常规移液器可靠下限（约 5 µL），` +
               `移液误差会直接变成浓度误差。建议先把母液稀释 10–100 倍再取。` });
        const say = (isFinite(all.V1) && isFinite(all.V2) && add >= 0)
          ? `取母液 <b>${C.auto(all.V1,"volume").text}</b>，加稀释液至 <b>${C.auto(all.V2,"volume").text}</b>（补 ${C.auto(add,"volume").text}）。`
          : null;
        res.show({ base: r.value, dim: r.dim, big: true, expr: r.expr,
          subs: used.map(k => `${F[k].spec.sym} ${F[k].text()}`).join("   ·   "),
          say, notes });
      } catch (e) {
        F[unknown].clear();
        res.show({ error: humanize(e.message, F) });
      }
    }
    res.onRecord = stdRecord(res, "稀释 · C1V1 = C2V2",
      () => ["C1","V1","C2","V2"].map(k =>
        [F[k].spec.label + " " + F[k].spec.sym, F[k].text()]));
    drawSeg(); sync();
    root.appendChild(h("div", { class: "cols" },
      h("div", { class: "card" }, seg, h("div", { class: "fields" },
        F.C1.node, F.V1.node, F.C2.node, F.V2.node)),
      res.node));
    run();
  }});

/* ---- 3. 梯度稀释 / 标准曲线 -------------------------------------------- */
mod({ id: "series", group: "配液", name: "标准曲线", title: "梯度稀释 · 标准曲线系列",
  desc: "从一个母液配一整套标准品。直接稀释每点各自从母液取；逐级稀释每点从上一级取，适合跨度大的浓度范围。",
  build(root) {
    let mode = "direct";
    const out = h("div");
    const recalc = () => run();
    const Cs = mkField({ key:"Cs", label:"母液浓度", dim:"conc", unit:"mM",
                         placeholder:"100", value:"100", onchange:recalc });
    const Vf = mkField({ key:"Vf", label:"每点终体积", dim:"volume", unit:"mL",
                         placeholder:"10", value:"10", onchange:recalc });
    const targets = mkField({ key:"t", label:"目标浓度（逗号或空格分隔，可含 0 做空白）",
                              dim:"conc", unit:"mM", value:"0, 0.1, 0.25, 0.5, 1, 2.5, 5",
                              onchange:recalc });
    targets.input.setAttribute("inputmode", "text");
    const gLo = mkField({ key:"lo", label:"最低", dim:null, value:"0.1", onchange:null });
    const gHi = mkField({ key:"hi", label:"最高", dim:null, value:"10", onchange:null });
    const gN  = mkField({ key:"n",  label:"点数", dim:null, value:"6", onchange:null });
    let gKind = "log";
    const gBox = h("div");
    function drawGen() {
      gBox.innerHTML = "";
      gBox.appendChild(h("div", { class: "row" }, gLo.node, gHi.node, gN.node));
      gBox.appendChild(h("div", { class: "chiprow" },
        ["log","linear"].map(k => {
          const b = h("button", { class:"chip", type:"button", "aria-pressed":String(k===gKind) },
            k === "log" ? "等比" : "等差");
          b.addEventListener("click", () => { gKind = k; drawGen(); });
          return b;
        }),
        h("button", { class:"chip", type:"button", style:"margin-left:auto",
          onclick: () => {
            try {
              const s = C.series({ lo:num(gLo.input.value), hi:num(gHi.input.value),
                                   n:num(gN.input.value), kind:gKind });
              targets.input.value = s.map(v => C.sig(v, 3)).join(", ");
              run();
            } catch (e) { alert(e.message); }
          } }, "生成 →")));
    }
    const modeBox = h("div");
    function drawMode() {
      modeBox.innerHTML = "";
      modeBox.appendChild(segmented("方式", [
        { key:"direct", label:"直接稀释" }, { key:"serial", label:"逐级稀释" }
      ], mode, k => { mode = k; drawMode(); run(); }));
    }

    function run() {
      out.innerHTML = "";
      const unit = targets.unit();
      const list = targets.input.value.split(/[,，;；\s]+/).filter(Boolean)
        .map(s => num(s)).filter(v => isFinite(v));
      try {
        const rows = C.ladder({
          Cstock: Cs.getBase(), Vfinal: Vf.getBase(),
          targets: list.map(v => C.toBase(v, "conc", unit)), mode });
        const serial = mode === "serial";
        const tbl = h("table", { class: "data" },
          h("thead", null, h("tr", null,
            ["#","目标浓度","取自","取样体积","加稀释液","配制总量","倍数"]
              .map(t => h("th", null, t)))),
          h("tbody", null, rows.map(r => {
            const thin = !r.blank && r.Vtransfer < 5e-6;
            return h("tr", { class: r.blank ? "blankrow" : (thin ? "flag" : "") },
              h("td", null, String(r.index)),
              h("td", { class: r.blank ? "" : "em" },
                r.blank ? "空白 0" : C.auto(r.target, "conc").text),
              h("td", null, r.from),
              h("td", null, r.blank ? "—" : C.auto(r.Vtransfer, "volume").text),
              h("td", null, C.auto(r.Vdiluent, "volume").text),
              h("td", null, C.auto(r.Vneeded, "volume").text),
              h("td", null, r.blank ? "—" : C.sig(r.fold, 3) + "×"));
          })));
        out.appendChild(h("div", { class: "tablewrap" }, tbl));
        const thin = rows.filter(r => !r.blank && r.Vtransfer < 5e-6);
        if (thin.length) out.appendChild(mkNote({ kind:"warn", text:
          `有 ${thin.length} 个点的取样量低于 5 µL（表中标黄），常规移液器在这个量程误差大。` +
          `改用逐级稀释，或把每点终体积放大。` }));
        if (serial) out.appendChild(mkNote({ kind:"info", text:
          `逐级稀释里每一级都要配够「配制总量」—— 它等于自己的终体积加上下一级要取走的量。` +
          `每取一级务必先涡旋混匀，否则误差会一级一级累积。` }));
        else out.appendChild(mkNote({ kind:"", text:
          `直接稀释每点都从母液取，误差互相独立，不会累积；代价是最低点的取样量可能很小。` }));
      } catch (e) {
        out.appendChild(h("div", { class: "err" }, e.message));
      }
    }
    drawGen(); drawMode();
    root.appendChild(h("div", null,
      h("div", { class: "card" },
        modeBox,
        h("div", { class: "fields" },
          h("div", { class: "row" }, Cs.node, Vf.node),
          targets.node)),
      h("div", { class: "card" },
        h("h3", null, "按范围生成目标浓度"),
        gBox,
        h("div", { class:"tiny", style:"margin-top:9px" },
          "等比适合跨几个数量级的标定（检出限到饱和）；等差适合窄范围线性段。生成后仍可手动改。")),
      h("div", { class: "card" },
        h("div", { class:"card-head" },
          h("h3", null, "配制表"),
          recButton(() => {
            const t = grabTable(out.querySelector("table.data"));
            if (!t) return null;
            return { module: "梯度稀释 · 标准曲线", tableTitle: "配制表", table: t,
              inputs: [["母液浓度", Cs.text()], ["每点终体积", Vf.text()],
                       ["方式", mode === "serial" ? "逐级稀释" : "直接稀释"]],
              notes: Array.from(out.querySelectorAll(".note")).map(n => plain(n.innerHTML)) };
          })),
        out)));
    run();
  }});

/* ---- 4. 液体试剂（浓酸等） --------------------------------------------- */
mod({ id: "liquid", group: "配液", name: "液体试剂", title: "浓酸 / 液体试剂",
  desc: "瓶子上只有密度和质量分数，先换算成 mol/L，再算要取多少。质量分数按 w/w（主流标法），和密度是配套的。",
  build(root) {
    const resA = mkResult("液体试剂 · 原瓶浓度"), resB = mkResult("液体试剂 · 配制取量");
    const recalc = () => { runA(); runB(); };
    let isAcid = true, pickedName = "浓硫酸";   // the prefilled rho/w/M
    const rho = mkField({ key:"rho", label:"密度", sym:"ρ", dim:null, suffix:"g/mL",
                          placeholder:"1.84", value:"1.84", onchange:recalc,
      side: libButton(r => {
        if (!r.rho) { alert(r.n + " 不是液体试剂，没有密度/质量分数。"); return; }
        rho.input.value = r.rho; w.input.value = C.sig(r.w * 100, 4);
        try { Mm.input.value = C.sig(C.molarMass(r.f).mass, 6); } catch (e) {}
        isAcid = !!r.acid; pickedName = r.n; recalc();
      }) });
    const w  = mkField({ key:"w", label:"质量分数", sym:"w", dim:null, suffix:"%",
                         placeholder:"98", value:"98", onchange:recalc });
    const Mm = mkField({ key:"M", label:"摩尔质量", sym:"M", dim:"molar", unit:"g/mol",
                         placeholder:"98.078", value:"98.078", onchange:recalc });
    const C2 = mkField({ key:"C2", label:"目标浓度", sym:"C₂", dim:"conc", unit:"M",
                         placeholder:"0.5", value:"0.5", onchange:recalc });
    const V2 = mkField({ key:"V2", label:"目标体积", sym:"V₂", dim:"volume", unit:"mL",
                         placeholder:"100", value:"100", onchange:recalc });
    let stock = NaN;

    function runA() {
      try {
        const r = C.stockFromLiquid({ rho:num(rho.input.value), w:num(w.input.value)/100,
                                      M:Mm.getBase() });
        stock = r.value;
        resA.show({ base:r.value, dim:"conc", big:true, expr:r.expr,
          subs:`ρ ${rho.input.value} g/mL   ·   w ${w.input.value} %   ·   M ${Mm.input.value} g/mol`,
          say:`原瓶试剂${pickedName ? "（" + pickedName + "）" : ""}的摩尔浓度是 <b>${C.auto(r.value,"conc").text}</b>。`,
          notes:[{ kind:"", text:
            "1000 是 L→mL 的换算：1 L 原液重 1000·ρ 克，其中 w% 是溶质，再除摩尔质量得物质的量。" }] });
      } catch (e) { stock = NaN; resA.show({ error:e.message }); }
    }
    function runB() {
      try {
        if (!isFinite(stock) || stock <= 0) throw new Error("先把左边的密度 / 质量分数 / 摩尔质量填完整");
        const r = C.dilution({ C1:stock, C2:C2.getBase(), V2:V2.getBase() }, "V1");
        const add = V2.getBase() - r.value;
        const notes = [];
        if (r.value > V2.getBase()) notes.push({ kind:"danger",
          text:"目标浓度高于原瓶浓度，稀释做不到。" });
        else if (r.value < 5e-6) notes.push({ kind:"warn",
          text:`只需取 ${C.auto(r.value,"volume").text}，低于移液器可靠下限，先配中间母液再稀释。` });
        notes.push({ kind: isAcid ? "danger" : "info", text: isAcid
          ? "<b>酸入水，绝不可水入酸。</b>先在容量瓶里加约 2/3 体积的水，再沿壁缓慢加入浓酸，边加边摇散热，冷却到室温后再定容。"
          : "先加约 2/3 体积稀释液，再加入原液，混匀冷却后定容到刻度。" });
        resB.show({ base:r.value, dim:"volume", big:true, expr:"V₁ = C₂V₂ / C₁",
          subs:`C₂ ${C2.text()}   ·   V₂ ${V2.text()}   ·   C₁ ${C.auto(stock,"conc").text}（原瓶）`,
          say: add >= 0 ? `量取原液 <b>${C.auto(r.value,"volume").text}</b>，加水定容到 <b>${C.auto(V2.getBase(),"volume").text}</b>。` : null,
          notes });
      } catch (e) { resB.show({ error:e.message }); }
    }
    resA.onRecord = stdRecord(resA, "液体试剂 · 原瓶浓度", () => [
      ["试剂", pickedName || "（未从试剂库选取）"],
      ["密度 ρ", rho.input.value + " g/mL"],
      ["质量分数 w", w.input.value + " %"],
      ["摩尔质量 M", Mm.text()]]);
    resB.onRecord = stdRecord(resB, "液体试剂 · 配制取量", () => [
      ["试剂", pickedName || "（未从试剂库选取）"],
      ["原瓶浓度 C1", isFinite(stock) ? C.auto(stock,"conc").text : "—"],
      ["目标浓度 C2", C2.text()],
      ["目标体积 V2", V2.text()]]);
    root.appendChild(h("div", null,
      h("div", { class:"cols" },
        h("div", { class:"card" },
          h("h3", null, "① 原瓶试剂有多浓"),
          h("div", { class:"fields" }, rho.node, w.node, Mm.node)),
        resA.node),
      h("div", { class:"cols", style:"margin-top:14px" },
        h("div", { class:"card" },
          h("h3", null, "② 配指定浓度要取多少"),
          h("div", { class:"fields" }, C2.node, V2.node)),
        resB.node)));
    recalc();
  }});

/* ---- 5. 称量回算 -------------------------------------------------------- */
mod({ id: "weigh", group: "配液", name: "称量回算", title: "称量回算",
  desc: "天平上很难刚好停在目标值。填实际称到的质量，马上知道按原体积定容浓度变成多少，或者要定容到多少才正好。",
  build(root) {
    const res = mkResult("称量回算");
    const recalc = () => run();
    const Mm = mkField({ key:"M", label:"摩尔质量", sym:"M", dim:"molar", unit:"g/mol",
      placeholder:"58.44", value:"58.44", onchange:recalc,
      side: libButton(r => { if (r.M) { Mm.input.value = C.sig(r.M,6); recalc(); }
                             else alert(r.n + "：" + (r.note || "没有摩尔质量")); }) });
    const Ct = mkField({ key:"C", label:"目标浓度", sym:"C_目标", dim:"conc", unit:"mM",
                         placeholder:"100", value:"100", onchange:recalc });
    const Vt = mkField({ key:"V", label:"计划定容体积", sym:"V_目标", dim:"volume", unit:"mL",
                         placeholder:"50", value:"50", onchange:recalc });
    const ma = mkField({ key:"ma", label:"实际称到的质量", sym:"m_实际", dim:"mass", unit:"mg",
                         placeholder:"296.5", value:"296.5", onchange:recalc });
    function run() {
      try {
        const M = Mm.getBase(), Ctg = Ct.getBase(), Vtg = Vt.getBase(), m = ma.getBase();
        if (!isFinite(M) || !isFinite(Ctg) || !isFinite(Vtg) || !isFinite(m))
          throw new Error("把四个值都填上");
        const wbk = C.weighBack({ M, m_actual:m, V_target:Vtg, C_target:Ctg });
        const mT = M * Ctg * Vtg;
        const dev = wbk.deviation;
        const kind = Math.abs(dev) < 1 ? "info" : (Math.abs(dev) < 5 ? "warn" : "danger");
        res.show({
          cap:"方案 A — 还是定容到计划体积",
          base:wbk.C_actual, dim:"conc", big:true, expr:"C_实际 = m_实际 / (M · V_目标)",
          subs:`m_实际 ${ma.text()}   ·   M ${Mm.text()}   ·   V ${Vt.text()}`,
          say:`目标要称 <b>${C.auto(mT,"mass").text}</b>，实际称了 <b>${C.auto(m,"mass").text}</b>。` +
              `定容到 ${C.auto(Vtg,"volume").text} 的话，真实浓度是 <b>${C.auto(wbk.C_actual,"conc").text}</b>。`,
          notes:[
            { kind, text:`相对目标浓度偏差 <b>${dev >= 0 ? "+" : ""}${C.sig(dev,3)} %</b>。` +
              (Math.abs(dev) < 1 ? "在常规标定可接受范围内，记下真实浓度直接用即可。"
                : "做标准曲线时请按真实浓度记录，不要按目标值记。") },
            { kind:"info", text:`<b>方案 B — 想正好命中目标浓度：</b>改成定容到 ` +
              `<b>${C.auto(wbk.V_needed,"volume").text}</b>（而不是 ${C.auto(Vtg,"volume").text}）。` +
              `<br><span class="mono" style="font-size:12px">V = m_实际 / (M · C_目标)</span>` }
          ]});
      } catch (e) { res.show({ error:e.message }); }
    }
    res.onRecord = stdRecord(res, "称量回算", () => [
      ["摩尔质量 M", Mm.text()], ["目标浓度 C_目标", Ct.text()],
      ["计划定容体积 V_目标", Vt.text()], ["实际称到 m_实际", ma.text()]]);
    root.appendChild(h("div", { class:"cols" },
      h("div", { class:"card" }, h("div", { class:"fields" },
        Mm.node, Ct.node, Vt.node, ma.node)),
      res.node));
    run();
  }});

/* ---- 6. 缓冲液 ---------------------------------------------------------- */
mod({ id: "buffer", group: "配液", name: "缓冲液", title: "缓冲液 · 按 pH 配",
  desc: "按目标 pH 直接给出两种盐各称多少。已按 Davies 式做离子强度活度校正 —— 不校正的话 0.1 M PBS 会偏 0.3–0.6 个 pH 单位。",
  build(root) {
    let sysKey = "phosphate_na", acidKey = null, baseKey = null, davies = true;
    const res = mkResult();
    const out = h("div");
    const recalc = () => run();
    const pH = mkField({ key:"pH", label:"目标 pH", dim:null, value:"7.40", onchange:recalc });
    const Ct = mkField({ key:"Ct", label:"缓冲总浓度", dim:"conc", unit:"mM",
                         value:"100", onchange:recalc });
    const Vf = mkField({ key:"Vf", label:"配制体积", dim:"volume", unit:"mL",
                         value:"500", onchange:recalc });
    const T  = mkField({ key:"T", label:"使用温度", dim:null, suffix:"°C",
                         value:"25", onchange:recalc });
    const nacl = mkField({ key:"nacl", label:"另加 NaCl", dim:"conc", unit:"mM",
                           value:"0", onchange:recalc });
    const kcl  = mkField({ key:"kcl", label:"另加 KCl", dim:"conc", unit:"mM",
                           value:"0", onchange:recalc });
    const sysSel = h("select");
    for (const k in C.BUFFERS) sysSel.appendChild(h("option", { value:k }, C.BUFFERS[k].name));
    sysSel.value = sysKey;
    const acidSel = h("select"), baseSel = h("select");
    [sysSel, acidSel, baseSel].forEach(s => { s.className = ""; });

    function fillReagents() {
      const sys = C.BUFFERS[sysKey];
      acidSel.innerHTML = ""; baseSel.innerHTML = "";
      sys.reagents.forEach(r => {
        acidSel.appendChild(h("option", { value:r.key }, r.label));
        baseSel.appendChild(h("option", { value:r.key }, r.label));
      });
      acidSel.value = acidKey && sys.reagents.some(r => r.key === acidKey) ? acidKey : sys.defaultAcid;
      baseSel.value = baseKey && sys.reagents.some(r => r.key === baseKey) ? baseKey : sys.defaultBase;
      acidKey = acidSel.value; baseKey = baseSel.value;
    }
    sysSel.addEventListener("change", () => {
      sysKey = sysSel.value; acidKey = null; baseKey = null;
      fillReagents();
      const s = C.BUFFERS[sysKey];
      pH.input.value = ((s.range[0] + s.range[1]) / 2).toFixed(2);
      run();
    });
    acidSel.addEventListener("change", () => { acidKey = acidSel.value; run(); });
    baseSel.addEventListener("change", () => { baseKey = baseSel.value; run(); });
    const dav = h("input", { type:"checkbox", checked:"checked" });
    dav.addEventListener("change", () => { davies = dav.checked; run(); });

    function wrapSel(label, sel) {
      return h("label", { class:"field" },
        h("span", { class:"lab" }, h("span", null, label)),
        h("div", { class:"inrow" }, (sel.classList.add("solo"), sel)));
    }

    function run() {
      out.innerHTML = "";
      try {
        const r = C.buffer({
          system:sysKey, pH:num(pH.input.value), Ctotal:Ct.getBase(), Vfinal:Vf.getBase(),
          acidKey, baseKey, T:num(T.input.value),
          addNaCl:nacl.getBase() || 0, addKCl:kcl.getBase() || 0, davies });

        const tbl = h("table", { class:"data" },
          h("thead", null, h("tr", null,
            ["试剂","摩尔质量","配成浓度","称取 / 量取"].map(t => h("th", null, t)))),
          h("tbody", null, r.items.map(it => h("tr", null,
            h("td", { style:"color:var(--ink)" }, it.reagent.label),
            h("td", null, C.sig(it.M, 6) + " g/mol"),
            h("td", null, C.auto(it.conc, "conc").text),
            h("td", { class:"em" }, it.volume
              ? C.auto(it.volume, "volume").text + "（液体）"
              : C.auto(it.mass, "mass").text)))));
        out.appendChild(h("div", { class:"tablewrap" }, tbl));
        out.appendChild(h("div", { class:"tiny", style:"margin-top:10px" },
          `溶于约 2/3 体积的水，完全溶解后定容到 ${C.auto(r.Vfinal,"volume").text}。`));

        const idealPKa = r.pKaIdeal[r.nearestIndex], appPKa = r.pKaApp[r.nearestIndex];
        const dT = num(T.input.value) - 25;
        res.show({
          cap:"有效 pKa 与配比", big:false,
          expr:"pH = pKa' + log([A⁻]/[HA])",
          subs:`pKa (热力学, 25 °C) ${C.sig(r.pKaThermo[r.nearestIndex],4)}` +
               (Math.abs(dT) > 0.01 ? `   →   温度校正后 ${C.sig(idealPKa,4)}` : ""),
          tail:davies
            ? `pKa' (I = ${C.sig(r.I,3)} M, Davies) ${C.sig(appPKa,4)}   ·   偏移 ${r.shift >= 0 ? "+" : ""}${C.sig(r.shift,2)}`
            : "未启用活度校正",
          equiv:false,
          say:`离子强度 <b>${C.sig(r.I,3)} M</b>　·　酸式 : 碱式 = <b>${C.sig(r.ratio,4)} : 1</b>`,
          notes:[
            ...r.warnings.map(w => ({ kind:"warn", text:w })),
            davies
              ? { kind:"info", text:"<b>已做 Davies 活度校正。</b>离子强度会把表观 pKa 拉偏（磷酸盐这种 1→2 价跃迁拉得最多），" +
                  "不校正算出的配比实测会明显偏碱。" }
              : { kind:"danger", text:"<b>活度校正已关闭。</b>这是教科书里的裸 Henderson-Hasselbalch 式，" +
                  "在 0.1 M 以上离子强度下，磷酸盐体系算出的配比实测能偏 0.3–0.6 个 pH 单位。" },
            { kind:"warn", text:"<b>这是理论配比，残余误差仍有 ±0.1–0.2 pH。</b>" +
                "配好以后一定要用 pH 计实测，再用稀 HCl / NaOH 滴到目标值。" }
          ]});
      } catch (e) {
        out.appendChild(h("div", { class:"err" }, e.message));
        res.show({ error:e.message });
      }
    }
    fillReagents();
    root.appendChild(h("div", null,
      h("div", { class:"cols" },
        h("div", null,
          h("div", { class:"card" },
            h("div", { class:"fields" },
              wrapSel("缓冲体系", sysSel),
              h("div", { class:"row" }, pH.node, T.node),
              h("div", { class:"row" }, Ct.node, Vf.node),
              wrapSel("酸式试剂（质子多的一侧）", acidSel),
              wrapSel("碱式试剂（质子少的一侧）", baseSel))),
          h("div", { class:"card" },
            h("h3", null, "可选：补充背景电解质"),
            h("div", { class:"fields" },
              h("div", { class:"row" }, nacl.node, kcl.node),
              h("label", { class:"check" }, dav,
                h("span", null, "启用 Davies 活度校正（强烈建议开）")),
              h("div", { class:"tiny" },
                "标准 1× PBS 是 10 mM 磷酸盐 + 137 mM NaCl + 2.7 mM KCl。" +
                "背景盐会显著拉高离子强度，进而改变表观 pKa，所以填了才算得准。"))),
          // the recipe is the primary output — keep it ahead of the pKa card
          // in source order so it comes first when the grid collapses to one column
          h("div", { class:"card" },
            h("div", { class:"card-head" },
              h("h3", null, "配制表"),
              recButton(() => {
                const t = grabTable(out.querySelector("table.data"));
                if (!t) return null;
                const last = res.last;
                return { module: "缓冲液 · " + C.BUFFERS[sysKey].name,
                  tableTitle: "配制表", table: t,
                  inputs: [["目标 pH", pH.input.value], ["使用温度", T.input.value + " °C"],
                           ["缓冲总浓度", Ct.text()], ["配制体积", Vf.text()],
                           ["另加 NaCl", nacl.text()], ["另加 KCl", kcl.text()],
                           ["活度校正", davies ? "Davies（已开）" : "关闭"]],
                  formula: last ? last.expr : "",
                  formulaSubs: last
                    ? [last.subs, last.tail].filter(Boolean).join("\n    ") : "",
                  say: last ? plain(last.say) : "",
                  notes: (last && last.notes ? last.notes : [])
                    .map(n => plain(typeof n === "string" ? n : (n && n.text))).filter(Boolean) };
              })),
            out)),
        res.node)));
    run();
  }});

/* ---- 7. 分子量 / 试剂库 ------------------------------------------------- */
mod({ id: "mass", group: "工具", name: "分子量", title: "分子量 · 试剂库",
  desc: "支持嵌套括号和结晶水：CuSO4·5H2O、K3[Fe(CN)6]、Na2HPO4·12H2O。结晶水会算进去 —— 这是配液最常见的坑。",
  build(root) {
    const res = mkResult("分子量");
    const bd = h("div");
    const f = mkField({ key:"f", label:"化学式", dim:null, value:"CuSO4·5H2O",
      placeholder:"K3[Fe(CN)6]", onchange:() => run(),
      side: libButton(r => {
        if (!r.f) { alert(r.n + "：" + (r.note || "没有确定的化学式")); return; }
        f.input.value = r.f; run();
      }) });
    f.input.setAttribute("inputmode", "text");
    const chips = h("div", { class:"chiprow" },
      ["NaCl","KCl","K3[Fe(CN)6]","K4[Fe(CN)6]·3H2O","Na2HPO4·12H2O","KH2PO4",
       "CuSO4·5H2O","C6H12O6","FeCl3·6H2O"].map(s => {
        const b = h("button", { class:"chip", type:"button" }, pretty(s));
        b.addEventListener("click", () => { f.input.value = s; run(); });
        return b;
      }));

    function run() {
      bd.innerHTML = "";
      try {
        const r = C.molarMass(f.input.value);
        res.show({ cap:"摩尔质量", big:C.sig(r.mass, 6), equiv:false,
          say:`<b>${pretty(f.input.value.trim())}</b>　M = <b>${C.sig(r.mass,6)} g/mol</b>`,
          expr:"M = Σ (原子量 × 原子数)",
          notes:/[·]/.test(f.input.value) ? [{ kind:"info", text:
            "结晶水已计入。按无水式称量水合盐会使浓度系统性偏低 —— " +
            "例如 CuSO₄·5H₂O 用 159.6 而不是 249.68，实际只配出 64 % 的浓度。" }] : [] });
        const tb = h("table", { class:"breakdown" }, h("tbody", null,
          r.rows.map(row => h("tr", null,
            h("td", null, row.element + (row.count !== 1 ? " ×" + C.sig(row.count,4) : "")),
            h("td", null, C.sig(row.atomic, 6)),
            h("td", null, C.sig(row.subtotal, 6)),
            h("td", null, C.sig(row.percent, 3) + "%")))));
        bd.appendChild(tb);
        bd.appendChild(h("div", { class:"tiny", style:"margin-top:9px" },
          "列：元素与个数 · 标准原子量 · 小计 g/mol · 质量百分比"));
      } catch (e) {
        bd.appendChild(h("div", { class:"err" }, e.message));
        res.show({ error:e.message });
      }
    }
    res.onRecord = stdRecord(res, "分子量", () => [["化学式", f.input.value.trim()]]);
    root.appendChild(h("div", { class:"cols" },
      h("div", null,
        h("div", { class:"card" }, h("div", { class:"fields" }, f.node), chips),
        h("div", { class:"card" }, h("h3", null, "组成"), bd)),
      res.node));
    run();
  }});

/* ---- 8. 单位换算 -------------------------------------------------------- */
mod({ id: "units", group: "工具", name: "单位换算", title: "单位换算",
  desc: "填一个值，所有同量纲单位一次列全。摩尔浓度和质量浓度（mg/mL、ppm、%w/v）之间互转需要摩尔质量。",
  build(root) {
    const DIMLIST = [
      ["mass","质量"],["volume","体积"],["amount","物质的量"],["conc","摩尔浓度"],
      ["massconc","质量浓度"],["area","面积"],["length","长度"],["current","电流"],
      ["charge","电量"],["rate","扫速"],["time","时间"],["surfconc","表面覆盖度"]
    ];
    let dim = "volume";
    const host = h("div"), bridge = h("div");
    const Mm = mkField({ key:"M", label:"摩尔质量（摩尔 ⇄ 质量浓度 换算用）", sym:"M",
      dim:"molar", unit:"g/mol", value:"180.16", onchange:() => run(),
      side: libButton(r => { if (r.M) { Mm.input.value = C.sig(r.M,6); run(); }
                             else alert(r.n + "：" + (r.note || "没有摩尔质量")); }) });
    let fld = null;
    const sel = h("select", null, DIMLIST.map(d => h("option", { value:d[0] }, d[1])));
    sel.value = dim; sel.classList.add("solo");
    sel.addEventListener("change", () => { dim = sel.value; build(); });

    function build() {
      host.innerHTML = "";
      fld = mkField({ key:"v", label:"数值", dim, unit:C.baseUnitName(dim),
                      value:"1", onchange:() => run() });
      host.appendChild(h("div", { class:"fields" }, fld.node));
      run();
    }
    function run() {
      bridge.innerHTML = "";
      const base = fld.getBase();
      const table = h("table", null, h("tbody", null,
        C.DIMS[dim].units.map(u => h("tr", null,
          h("td", null, u[0]),
          h("td", null, isFinite(base) ? C.sig(base / u[1], 6) : "—")))));
      bridge.appendChild(h("div", { class:"equiv", style:"margin-top:0;border-top:0;padding-top:0" }, table));

      if ((dim === "conc" || dim === "massconc") && isFinite(base)) {
        const M = Mm.getBase();
        if (isFinite(M) && M > 0) {
          const other = dim === "conc" ? "massconc" : "conc";
          const val = dim === "conc" ? base * M : base / M;
          bridge.appendChild(h("div", { class:"note info", html:
            `换算到${other === "conc" ? "摩尔浓度" : "质量浓度"}（M = ${C.sig(M,6)} g/mol）：` +
            `<br><b>${C.auto(val, other).text}</b>` +
            `<br><span class="mono" style="font-size:12px">` +
            (dim === "conc" ? "c[g/L] = C[mol/L] × M" : "C[mol/L] = c[g/L] / M") + "</span>" }));
          bridge.appendChild(h("div", { class:"equiv" }, h("table", null, h("tbody", null,
            C.DIMS[other].units.map(u => h("tr", null,
              h("td", null, u[0]), h("td", null, C.sig(val / u[1], 6))))))));
        } else {
          bridge.appendChild(h("div", { class:"note warn", html:
            "填上摩尔质量就能同时给出" + (dim === "conc" ? "质量浓度（mg/mL、ppm、%w/v）" : "摩尔浓度（mM、µM）") + "。" }));
        }
      }
    }
    root.appendChild(h("div", { class:"cols" },
      h("div", null,
        h("div", { class:"card" },
          h("div", { class:"fields" },
            h("label", { class:"field" },
              h("span", { class:"lab" }, h("span", null, "量纲")),
              h("div", { class:"inrow" }, sel))),
          host),
        h("div", { class:"card" }, h("div", { class:"fields" }, Mm.node),
          h("div", { class:"tiny", style:"margin-top:8px" },
            "ppm 按水溶液近似当作 mg/L；%(w/v) 按 1 g / 100 mL。两者都是质量浓度，和摩尔浓度之间必须过摩尔质量。"))),
      h("div", { class:"card" }, h("h3", null, "等价值"), bridge)));
    build();
  }});

/* ---- 9. 电化学 ---------------------------------------------------------- */
mod({ id: "echem", group: "工具", name: "电化学", title: "电化学计算",
  desc: "电极面积、电流密度、Randles-Ševčík、Cottrell、表面覆盖度、检出限。面积一处算好，下面几块直接复用。",
  build(root) {
    let Acm2 = Math.PI * 0.3 * 0.3 / 4;   // Ø3 mm default, cm²

    /* --- electrode area --- */
    let shape = "disc";
    const areaOut = h("div"), shapeBox = h("div"), dimBox = h("div");
    const d  = mkField({ key:"d", label:"直径", dim:"length", unit:"mm", value:"3", onchange:()=>areaRun() });
    const wq = mkField({ key:"w", label:"宽", dim:"length", unit:"mm", value:"2", onchange:()=>areaRun() });
    const hq = mkField({ key:"h", label:"高", dim:"length", unit:"mm", value:"5", onchange:()=>areaRun() });
    const dO = mkField({ key:"dO", label:"外径", dim:"length", unit:"mm", value:"4", onchange:()=>areaRun() });
    const dI = mkField({ key:"dI", label:"内径", dim:"length", unit:"mm", value:"2", onchange:()=>areaRun() });
    function drawShape() {
      shapeBox.innerHTML = "";
      shapeBox.appendChild(segmented("形状", [
        { key:"disc", label:"圆盘" }, { key:"rect", label:"矩形" }, { key:"ring", label:"环状" }
      ], shape, k => { shape = k; drawShape(); drawDims(); areaRun(); }));
    }
    function drawDims() {
      dimBox.innerHTML = "";
      const f = shape === "disc" ? [d.node] : shape === "rect" ? [wq.node, hq.node] : [dO.node, dI.node];
      dimBox.appendChild(h("div", { class:"row" }, f));
    }
    function areaRun() {
      areaOut.innerHTML = "";
      try {
        const dims = shape === "disc" ? { d:d.getBase() }
                   : shape === "rect" ? { w:wq.getBase(), h:hq.getBase() }
                   : { dOut:dO.getBase(), dIn:dI.getBase() };
        const r = C.electrodeArea(shape, dims);
        Acm2 = r.value;
        areaOut.appendChild(h("div", { class:"big", style:"font-size:24px;margin:0" },
          C.sig(r.value, 4), h("span", { class:"u" }, "cm²")));
        areaOut.appendChild(h("div", { class:"work", style:"margin-top:9px" },
          h("span", { class:"eq" }, r.expr),
          h("span", { class:"sb" }, C.sig(r.value * 100, 4) + " mm²  ·  下面几块都用这个面积")));
        rsRun(); jRun(); covRun(); cotRun();
      } catch (e) {
        Acm2 = NaN;
        areaOut.appendChild(h("div", { class:"err" }, e.message));
      }
    }

    /* --- current density --- */
    const jOut = h("div");
    const iIn = mkField({ key:"i", label:"电流", dim:"current", unit:"µA", value:"58.6", onchange:()=>jRun() });
    function jRun() {
      jOut.innerHTML = "";
      try {
        const r = C.currentDensity({ i:iIn.getBase(), A:Acm2 });
        const uA = r.value * 1e6;
        jOut.appendChild(h("div", { class:"big", style:"font-size:24px;margin:0" },
          C.sig(Math.abs(uA) >= 1000 ? uA/1000 : uA, 4),
          h("span", { class:"u" }, Math.abs(uA) >= 1000 ? "mA/cm²" : "µA/cm²")));
        jOut.appendChild(h("div", { class:"work", style:"margin-top:9px" },
          h("span", { class:"eq" }, "j = i / A"),
          h("span", { class:"sb" }, `i ${iIn.text()}   ·   A ${C.sig(Acm2,4)} cm²`)));
      } catch (e) { jOut.appendChild(h("div", { class:"err" }, e.message)); }
    }

    /* --- Randles-Sevcik --- */
    let rsUnknown = "ip";
    const rsSeg = h("div"), rsOut = h("div");
    const rsN = mkField({ key:"n", label:"电子数", sym:"n", dim:null, value:"1", onchange:()=>rsRun() });
    const rsD = mkField({ key:"D", label:"扩散系数", sym:"D", dim:"diff", unit:"cm²/s",
                          value:"7.6e-6", onchange:()=>rsRun() });
    const rsC = mkField({ key:"C", label:"体相浓度", sym:"C", dim:"conc", unit:"mM",
                          value:"5", onchange:()=>rsRun() });
    const rsV = mkField({ key:"v", label:"扫速", sym:"v", dim:"rate", unit:"mV/s",
                          value:"50", onchange:()=>rsRun() });
    const rsI = mkField({ key:"ip", label:"峰电流", sym:"iₚ", dim:"current", unit:"µA",
                          placeholder:"—", onchange:()=>rsRun() });
    const RSF = { ip:rsI, D:rsD, C:rsC };
    function drawRs() {
      rsSeg.innerHTML = "";
      rsSeg.appendChild(segmented("求解", [
        { key:"ip", label:"iₚ 峰电流" }, { key:"D", label:"D 扩散系数" },
        { key:"A", label:"A 有效面积" }, { key:"C", label:"C 浓度" }
      ], rsUnknown, k => {
        rsUnknown = k; drawRs();
        [rsI, rsD, rsC].forEach(f => f.setSolved(false));
        if (RSF[k]) RSF[k].setSolved(true);
        rsRun();
      }));
    }
    function rsRun() {
      rsOut.innerHTML = "";
      try {
        const p = { n:rsN.getRaw(), A:Acm2, D:rsD.getBase(), C:rsC.getBase(),
                    v:rsV.getBase(), ip:rsI.getBase() };
        const r = C.randlesSevcik(p, rsUnknown);
        if (RSF[rsUnknown]) RSF[rsUnknown].setBase(r.value);
        const a = C.auto(r.value, r.dim, 4);
        rsOut.appendChild(h("div", { class:"big", style:"font-size:24px;margin:0" },
          C.sig(a.value, 4), h("span", { class:"u" }, a.unit)));
        rsOut.appendChild(h("div", { class:"work", style:"margin-top:9px" },
          h("span", { class:"eq" }, r.expr),
          h("span", { class:"sb" },
            `n ${rsN.input.value}  ·  A ${C.sig(Acm2,4)} cm²  ·  D ${rsD.text()}  ·  ` +
            `C ${rsUnknown === "C" ? C.auto(r.value,"conc").text : rsC.text()}  ·  v ${rsV.text()}`),
          h("span", { class:"sb" },
            `式中 C 取 ${C.sig((rsUnknown === "C" ? r.value : p.C)/1000, 4)} mol/cm³（= 浓度 ÷ 1000）`)));
      } catch (e) { rsOut.appendChild(h("div", { class:"err" }, e.message)); }
    }

    /* --- Cottrell --- */
    const cotOut = h("div");
    const cotT = mkField({ key:"t", label:"取样时间", sym:"t", dim:"time", unit:"s",
                           value:"1", onchange:()=>cotRun() });
    function cotRun() {
      cotOut.innerHTML = "";
      try {
        const r = C.cottrell({ n:rsN.getRaw(), A:Acm2, D:rsD.getBase(),
                               C:rsC.getBase(), t:cotT.getBase() });
        const a = C.auto(r.value, "current", 4);
        cotOut.appendChild(h("div", { class:"big", style:"font-size:24px;margin:0" },
          C.sig(a.value,4), h("span", { class:"u" }, a.unit)));
        cotOut.appendChild(h("div", { class:"work", style:"margin-top:9px" },
          h("span", { class:"eq" }, r.expr),
          h("span", { class:"sb" }, `复用上面的 n / A / D / C，t ${cotT.text()}`)));
      } catch (e) { cotOut.appendChild(h("div", { class:"err" }, e.message)); }
    }

    /* --- coverage + charge --- */
    const covOut = h("div");
    const covQ = mkField({ key:"Q", label:"积分电量", sym:"Q", dim:"charge", unit:"µC",
                           value:"1", onchange:()=>covRun() });
    const covN = mkField({ key:"z", label:"转移电子数", sym:"n", dim:null,
                           value:"1", onchange:()=>covRun() });
    function covRun() {
      covOut.innerHTML = "";
      try {
        const r = C.coverage({ Q:covQ.getBase(), n:covN.getRaw(), A:Acm2 });
        const mol = C.chargeToMoles({ Q:covQ.getBase(), z:covN.getRaw() });
        const a = C.auto(r.value, "surfconc", 4);
        covOut.appendChild(h("div", { class:"big", style:"font-size:24px;margin:0" },
          C.sig(a.value,4), h("span", { class:"u" }, a.unit)));
        covOut.appendChild(h("div", { class:"work", style:"margin-top:9px" },
          h("span", { class:"eq" }, "Γ = Q / (nFA)"),
          h("span", { class:"sb" }, `Q ${covQ.text()}  ·  n ${covN.input.value}  ·  A ${C.sig(Acm2,4)} cm²`),
          h("span", { class:"sb" }, `对应物质的量 n = Q/(nF) = ${C.auto(mol.value,"amount").text}`)));
      } catch (e) { covOut.appendChild(h("div", { class:"err" }, e.message)); }
    }

    /* --- LOD --- */
    const lodOut = h("div");
    const lodS = mkField({ key:"S", label:"灵敏度（标定曲线斜率）", dim:null, suffix:"µA/mM",
                           value:"1.2", onchange:()=>lodRun() });
    const lodSig = mkField({ key:"sig", label:"空白信号标准差 σ", dim:"current", unit:"nA",
                             value:"2", onchange:()=>lodRun() });
    function lodRun() {
      lodOut.innerHTML = "";
      try {
        const S_A_per_M = num(lodS.input.value) * 1e-6 / 1e-3;    // µA/mM → A/(mol/L)
        const r3 = C.detectionLimit({ S:S_A_per_M, sigma:lodSig.getBase(), k:3 });
        const r10 = C.detectionLimit({ S:S_A_per_M, sigma:lodSig.getBase(), k:10 });
        lodOut.appendChild(h("div", { class:"big", style:"font-size:24px;margin:0" },
          C.sig(C.auto(r3.value,"conc").value, 4),
          h("span", { class:"u" }, C.auto(r3.value,"conc").unit)));
        lodOut.appendChild(h("div", { class:"work", style:"margin-top:9px" },
          h("span", { class:"eq" }, "LOD = 3σ / S　　LOQ = 10σ / S"),
          h("span", { class:"sb" }, `σ ${lodSig.text()}  ·  S ${lodS.input.value} µA/mM`),
          h("span", { class:"sb" }, `LOQ = ${C.auto(r10.value,"conc").text}`),
          h("span", { class:"sb" }, `归一化灵敏度 ${C.sig(num(lodS.input.value)/Acm2, 4)} µA·mM⁻¹·cm⁻²`)));
        lodOut.appendChild(mkNote({ kind:"warn", text:
          "<b>σ 取哪个要说清楚。</b>空白溶液重复测量的信号标准差（n ≥ 10）和标定曲线的拟合残差标准误 " +
          "不是一回事，算出的 LOD 可以差一倍以上。报数据时必须注明用的是哪一种。" }));
      } catch (e) { lodOut.appendChild(h("div", { class:"err" }, e.message)); }
    }

    drawShape(); drawDims(); drawRs();
    root.appendChild(h("div", null,
      h("div", { class:"card" }, h("h3", null, "电极面积"), shapeBox, dimBox,
        h("div", { style:"margin-top:12px" }, areaOut),
        mkNote({ kind:"", text:"这是<b>几何面积</b>。粗糙或多孔修饰电极的电化学活性面积可能大几倍，" +
          "要用下面的 Randles-Ševčík 反解「A 有效面积」来测。" })),
      h("div", { class:"cols" },
        h("div", { class:"card" }, h("h3", null, "电流密度"),
          h("div", { class:"fields" }, iIn.node), h("div", { style:"margin-top:12px" }, jOut)),
        h("div", { class:"card" }, h("h3", null, "Cottrell（计时电流）"),
          h("div", { class:"fields" }, cotT.node), h("div", { style:"margin-top:12px" }, cotOut))),
      h("div", { class:"card" }, h("h3", null, "Randles-Ševčík（可逆，25 °C）"),
        rsSeg,
        h("div", { class:"fields" },
          h("div", { class:"row" }, rsN.node, rsV.node),
          h("div", { class:"row" }, rsD.node, rsC.node),
          rsI.node),
        h("div", { style:"margin-top:12px" }, rsOut),
        mkNote({ kind:"warn", text:"<b>原式里的 C 单位是 mol/cm³，不是 mol/L，差 1000 倍。</b>" +
          "这里按 mM 收，内部自动 ÷1000 —— 上面的推导行会把真正代进去的 mol/cm³ 值写出来，可以对照检查。" })),
      h("div", { class:"cols" },
        h("div", { class:"card" }, h("h3", null, "表面覆盖度 Γ"),
          h("div", { class:"fields" }, h("div", { class:"row" }, covQ.node, covN.node)),
          h("div", { style:"margin-top:12px" }, covOut)),
        h("div", { class:"card" }, h("h3", null, "灵敏度与检出限"),
          h("div", { class:"fields" }, lodS.node, lodSig.node),
          h("div", { style:"margin-top:12px" }, lodOut))),
      h("div", { class:"card" },
        h("div", { class:"card-head" },
          h("h3", null, "把这一屏电化学结果记一笔"),
          recButton(() => {
            // .big renders the number and the unit as adjacent spans with no
            // whitespace between them; rejoin them with a real space
            const grab = el => {
              const b = el.querySelector(".big");
              if (!b) return null;
              const u = b.querySelector(".u");
              if (!u) return b.innerText.replace(/\s+/g, " ").trim();
              const num = Array.from(b.childNodes).filter(n => n !== u)
                .map(n => n.textContent).join("").replace(/\s+/g, " ").trim();
              return (num + " " + u.textContent.trim()).trim();
            };
            const rows = [
              ["电极面积 A", C.sig(Acm2, 4) + " cm²"],
              ["电流密度 j", grab(jOut)],
              ["Cottrell i(t)", grab(cotOut)],
              ["Randles-Sevcik", grab(rsOut)],
              ["表面覆盖度 Γ", grab(covOut)],
              ["检出限 LOD", grab(lodOut)]
            ].filter(r => r[1]);
            if (!rows.length) return null;
            return { module: "电化学计算",
              inputs: [["电极形状", shape === "disc" ? "圆盘" : shape === "rect" ? "矩形" : "环状"],
                       ["电子数 n", rsN.input.value], ["扫速 v", rsV.text()],
                       ["扩散系数 D", rsD.text()], ["体相浓度 C", rsC.text()]],
              tableTitle: "结果", table: { head: ["项目", "数值"], rows: rows },
              notes: ["Randles-Sevcik 式中 C 已按 mol/cm3 代入（= 浓度 / 1000）。",
                      "电极面积为几何面积，粗糙/多孔电极的活性面积需另行标定。"] };
          })))));
    areaRun(); lodRun();
  }});


/* ---- 10. 实验记录 -------------------------------------------------------- */
mod({ id: "records", group: "记录", name: "实验记录", title: "实验记录",
  desc: "每个模块的结果卡下面都有「记一笔」。攒好之后在这里一次性复制或导出成 .txt，直接贴进实验记录本。记录存在这台设备的浏览器里，刷新和关页面都不会丢。",
  build(root) {
    const list = h("div");
    const bar = h("div", { class: "chiprow", style: "margin-bottom:14px" });
    const preview = h("pre", { class: "rec-pre" });

    const copyBtn = h("button", { class: "chip", type: "button" }, "复制全部");
    copyBtn.addEventListener("click", async () => {
      if (!RECORDS.length) { flash(copyBtn, "还没有记录", true); return; }
      const ok = await copyText(C.formatRecords(RECORDS, Date.now()));
      flash(copyBtn, ok ? "已复制 ✓" : "复制失败，请手动选中下方文本", !ok);
    });
    const dlBtn = h("button", { class: "chip", type: "button" }, "下载 .txt");
    dlBtn.addEventListener("click", () => {
      if (!RECORDS.length) { flash(dlBtn, "还没有记录", true); return; }
      const ok = downloadText(C.formatRecords(RECORDS, Date.now()),
                              "配液记录-" + stampFile() + ".txt");
      flash(dlBtn, ok ? "已下载 ✓" : "此环境不允许下载，请用「复制全部」", !ok);
    });
    const clrBtn = h("button", { class: "chip", type: "button" }, "清空");
    let armed = false;
    clrBtn.addEventListener("click", () => {
      if (!RECORDS.length) { flash(clrBtn, "本来就是空的", true); return; }
      if (!armed) { armed = true; flash(clrBtn, "再点一次确认清空", true);
                    setTimeout(() => { armed = false; }, 2000); return; }
      recClear(); armed = false; render();
    });
    bar.appendChild(copyBtn); bar.appendChild(dlBtn); bar.appendChild(clrBtn);

    function render() {
      list.innerHTML = "";
      if (!RECORDS.length) {
        list.appendChild(h("div", { class: "note" },
          "还没有记录。去任一模块算一次，点结果下面的「记一笔」。"));
        preview.textContent = "";
        return;
      }
      RECORDS.forEach((r, i) => {
        const del = h("button", { class: "lib-btn", type: "button" }, "删除");
        del.addEventListener("click", () => { recRemove(r.id); render(); });
        list.appendChild(h("div", { class: "rec-item" },
          h("div", { class: "rec-item-head" },
            h("span", { class: "rec-n" }, String(i + 1)),
            h("span", { class: "rec-mod" }, r.module),
            h("span", { class: "rec-t" }, C.stamp(r.t)),
            del),
          h("pre", { class: "rec-body" }, C.formatRecord(r, i + 1))));
      });
      preview.textContent = C.formatRecords(RECORDS, Date.now());
    }
    recListeners.push(render);
    root.appendChild(h("div", null,
      h("div", { class: "card" }, bar,
        h("div", { class: "tiny" },
          "「复制全部」在任何环境都能用；「下载 .txt」在 peiyetai.netlify.app 上可用，" +
          "在 claude.ai 的 Artifact 链接里会被沙箱挡掉（那里请用复制）。" +
          "表格用 | 分隔而不是空格对齐 —— 中英文宽度比在各种字体下都不是整数，" +
          "空格对齐必然错位；| 在任何字体下都成立，也能用 Excel 的「分列」按 | 拆开。")),
      h("div", { class: "card" }, h("h3", null, "记录条目"), list),
      h("div", { class: "card" }, h("h3", null, "导出预览"), preview)));
    render();
  }});

/* ===========================================================================
   shell wiring
   ========================================================================= */
const main = $("main"), rail = $("rail");
const built = {};
let current = null;

const groups = [];
MODULES.forEach(m => {
  let g = groups.find(x => x.name === m.group);
  if (!g) { g = { name: m.group, items: [] }; groups.push(g); }
  g.items.push(m);
});
groups.forEach(g => {
  rail.appendChild(h("div", { class: "rail-group" }, g.name));
  g.items.forEach(m => {
    const b = h("button", { type: "button", "data-id": m.id }, m.name);
    b.addEventListener("click", () => show(m.id));
    rail.appendChild(b);
  });
});

MODULES.forEach(m => {
  const panel = h("section", { class: "panel", id: "panel-" + m.id },
    h("div", { class: "panel-head" }, h("h2", null, m.title), h("p", null, m.desc)));
  main.appendChild(panel);
});

function bumpRailBadge() {
  const b = rail.querySelector('button[data-id="records"]');
  if (!b) return;
  let dot = b.querySelector(".badge");
  if (!RECORDS.length) { if (dot) dot.remove(); return; }
  if (!dot) { dot = h("span", { class: "badge" }); b.appendChild(dot); }
  dot.textContent = String(RECORDS.length);
}

function show(id) {
  current = id;
  MODULES.forEach(m => {
    const p = $("panel-" + m.id);
    p.classList.toggle("on", m.id === id);
  });
  rail.querySelectorAll("button[data-id]").forEach(b =>
    b.setAttribute("aria-current", String(b.getAttribute("data-id") === id)));
  if (!built[id]) {
    built[id] = true;
    const m = MODULES.find(x => x.id === id);
    const holder = h("div");
    $("panel-" + id).appendChild(holder);
    m.build(holder);
  }
  try { localStorage.setItem("peiye.tab", id); } catch (e) {}
}

/* theme */
function applyTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  $("themeBtn").textContent = t === "auto" ? "主题 自动" : (t === "dark" ? "主题 深色" : "主题 浅色");
  try { localStorage.setItem("peiye.theme", t); } catch (e) {}
}
let theme = "auto";
try { theme = localStorage.getItem("peiye.theme") || "auto"; } catch (e) {}
applyTheme(theme);
$("themeBtn").addEventListener("click", () => {
  theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
  applyTheme(theme);
});

bumpRailBadge();
recListeners.push(bumpRailBadge);

let start = "ask";
try { const s = localStorage.getItem("peiye.tab"); if (s && MODULES.some(m => m.id === s)) start = s; } catch (e) {}
show(start);
})();

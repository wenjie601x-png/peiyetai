/* ============================================================================
   Natural-language request parser.

   Deliberately rule-based, not an LLM: this runs offline on a static page, the
   numbers it produces go onto a bench, and a wrong answer that *looks*
   confident is worse than "没看懂". So it extracts what it can recognise,
   echoes that back for the user to check, and names what is missing instead of
   guessing.
   ========================================================================== */

/* ---------- normalisation ------------------------------------------------ */
/** Full-width → half-width, unify the several micro/mu signs, strip noise. */
function normalizeQuery(s) {
  return String(s == null ? "" : s)
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, " ")
    .replace(/[μμµ]/g, "µ")
    .replace(/[，、]/g, ",")
    .replace(/[：]/g, ":")
    .replace(/[（）]/g, m => m === "（" ? "(" : ")")
    .replace(/[–—~～]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------- quantity extraction ------------------------------------------
   Ordered longest-first so "mg/mL" wins over "mg", and "mM" over "M".
   Molarity requires a capital M: lower-case "mm"/"nm" are far more likely to
   be millimetre/nanometre than millimolar, and silently reading a length as a
   concentration is exactly the kind of confident-but-wrong answer to avoid. */
const UNIT_PATTERNS = [
  // mass concentration
  ["µg/mL", "massconc", /^(?:µg|ug)\s*\/\s*(?:ml|mL)/],
  ["mg/mL", "massconc", /^mg\s*\/\s*(?:ml|mL)/],
  ["mg/L",  "massconc", /^mg\s*\/\s*[lL]/],
  ["g/L",   "massconc", /^g\s*\/\s*[lL]/],
  ["ppm",   "massconc", /^ppm/i],
  // molar mass
  ["g/mol", "molar",    /^(?:g\s*\/\s*mol|Da|dalton)/i],
  ["kg/mol","molar",    /^(?:kDa|kg\s*\/\s*mol)/i],
  // molar concentration — capital M only
  ["nM",    "conc",     /^nM\b/],
  ["µM",    "conc",     /^(?:µM|uM)\b/],
  ["mM",    "conc",     /^mM\b/],
  ["M",     "conc",     /^(?:M\b|mol\s*\/\s*[lL]|摩尔每升|摩尔\/升)/],
  // volume
  ["µL",    "volume",   /^(?:µl|ul|µL|uL|微升)/],
  ["mL",    "volume",   /^(?:ml|mL|毫升)/],
  ["L",     "volume",   /^(?:[lL]\b|升)/],
  // mass
  ["ng",    "mass",     /^ng\b/],
  ["µg",    "mass",     /^(?:µg|ug|微克)/],
  ["mg",    "mass",     /^(?:mg|毫克)/],
  ["kg",    "mass",     /^(?:kg|千克|公斤)/],
  ["g",     "mass",     /^(?:g\b|克)/]
];

/** Every number in the text, tagged with the unit that follows it. */
function extractQuantities(text) {
  const out = [];
  const re = /(-?\d+(?:[,，]\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = parseFloat(m[1].replace(/[,，]/g, ""));
    if (!isFinite(value)) continue;
    const rest = text.slice(re.lastIndex);
    // percent first: "%" never collides with anything else
    const pm = /^%\s*\(?\s*(w\s*\/\s*v|v\s*\/\s*v|w\s*\/\s*w)?\s*\)?/i.exec(rest);
    if (pm) {
      out.push({ value, dim: "percent", unit: "%", at: m.index,
                 basis: pm[1] ? pm[1].replace(/\s/g, "").toLowerCase() : null,
                 len: pm[0].length });
      continue;
    }
    let hit = null;
    for (const [unit, dim, pat] of UNIT_PATTERNS) {
      const um = pat.exec(rest);
      if (um) { hit = { unit, dim, len: um[0].length }; break; }
    }
    if (hit) out.push({ value, dim: hit.dim, unit: hit.unit, at: m.index, len: hit.len });
    else out.push({ value, dim: null, unit: null, at: m.index, len: 0 });
  }
  return out;
}

/** A "50,000-190,000 Da" style range means the molar mass is not a number. */
function findMolarMassRange(text) {
  const re = /(\d[\d,]*(?:\.\d+)?)\s*-\s*(\d[\d,]*(?:\.\d+)?)\s*(kDa|Da|g\s*\/\s*mol)/i;
  const m = re.exec(text);
  if (!m) return null;
  const f = s => parseFloat(s.replace(/,/g, ""));
  const k = /kDa/i.test(m[3]) ? 1000 : 1;
  return { lo: f(m[1]) * k, hi: f(m[2]) * k, raw: m[0] };
}

/* ---------- reagent matching --------------------------------------------- */
/** Longest-first so "醋酸钠" beats "醋酸" and "乙酸" maps to acetic acid. */
const NAME_ALIASES = [
  ["乙酸", "冰醋酸"], ["醋酸", "冰醋酸"], ["acetic", "冰醋酸"],
  ["盐酸", "浓盐酸"], ["硫酸", "浓硫酸"], ["硝酸", "浓硝酸"],
  ["氢氧化钠", "氢氧化钠"], ["烧碱", "氢氧化钠"],
  ["食盐", "氯化钠"], ["氯化钾", "氯化钾"],
  ["葡萄糖", "D-葡萄糖 (无水)"], ["glucose", "D-葡萄糖 (无水)"],
  ["铁氰化钾", "铁氰化钾 (赤血盐)"], ["赤血盐", "铁氰化钾 (赤血盐)"],
  ["亚铁氰化钾", "亚铁氰化钾 三水"], ["黄血盐", "亚铁氰化钾 三水"],
  ["壳聚糖", "壳聚糖"], ["chitosan", "壳聚糖"],
  ["乳酸钠", "L-乳酸钠"], ["丙酮酸钠", "丙酮酸钠"],
  ["抗坏血酸", "抗坏血酸 (VC)"], ["维生素c", "抗坏血酸 (VC)"],
  ["多巴胺", "多巴胺 盐酸盐"], ["尿酸", "尿酸"], ["尿素", "尿素"],
  ["双氧水", "过氧化氢 30%"], ["过氧化氢", "过氧化氢 30%"],
  ["戊二醛", "戊二醛 25%"], ["nafion", "Nafion 5% 分散液"],
  ["bsa", "牛血清白蛋白"], ["牛血清白蛋白", "牛血清白蛋白"]
];

function matchReagents(text, REAGENTS) {
  const low = text.toLowerCase();
  const found = [];
  const push = (r, at, via) => {
    if (r && !found.some(f => f.r.n === r.n)) found.push({ r, at, via });
  };
  // explicit library names / english / formulas, longest first
  const cands = [];
  REAGENTS.forEach(r => {
    [r.n, r.en, r.f].forEach(k => { if (k) cands.push([k, r]); });
  });
  cands.sort((a, b) => b[0].length - a[0].length);
  for (const [key, r] of cands) {
    const i = low.indexOf(key.toLowerCase());
    if (i >= 0) push(r, i, key);
  }
  // colloquial aliases
  for (const [alias, canonical] of NAME_ALIASES) {
    const i = low.indexOf(alias.toLowerCase());
    if (i < 0) continue;
    const r = REAGENTS.find(x => x.n === canonical);
    if (r) push(r, i, alias);
  }
  found.sort((a, b) => a.at - b.at);
  return found;
}

/* ---------- intent ------------------------------------------------------- */
const BUFFER_HINTS = [
  [/pbs|磷酸盐|磷酸缓冲/i, "phosphate_na"], [/tris/i, "tris"],
  [/hepes/i, "hepes"], [/\bmes\b/i, "mes"],
  [/醋酸盐缓冲|乙酸盐缓冲|acetate buffer/i, "acetate"],
  [/柠檬酸盐|citrate/i, "citrate"], [/碳酸盐|carbonate/i, "carbonate"]
];

function detectIntent(text, q) {
  const has = d => q.some(x => x.dim === d);
  const pH = /\bpH\s*=?\s*(\d+(?:\.\d+)?)/i.exec(text);
  const bufferSys = BUFFER_HINTS.find(([re]) => re.test(text));
  if (pH && (bufferSys || /缓冲/i.test(text)))
    return { intent: "buffer", pH: parseFloat(pH[1]),
             system: bufferSys ? bufferSys[1] : "phosphate_na" };
  if (/稀释|母液|stock|原液|取多少|吸取/i.test(text) && has("conc"))
    return { intent: "dilute" };
  if (has("percent")) return { intent: "percent" };
  if (has("conc")) return { intent: "molar" };
  if (has("massconc")) return { intent: "massconc" };
  return { intent: null };
}

/* ---------- the interpreter ---------------------------------------------- */
/**
 * Turn a sentence into a plan. Always returns an object; `ok:false` carries
 * `missing` so the UI can say exactly what to add rather than failing silently.
 */
function interpret(rawText, deps) {
  const REAGENTS = deps.REAGENTS, BUFFERS = deps.BUFFERS;
  const text = normalizeQuery(rawText);
  if (!text) return { ok: false, missing: ["请先描述你要配什么"], echo: {}, text };

  const q = extractQuantities(text);
  const reagents = matchReagents(text, REAGENTS);
  const mwRange = findMolarMassRange(text);
  const det = detectIntent(text, q);
  const pick = d => q.filter(x => x.dim === d);
  const vols = pick("volume"), concs = pick("conc"),
        pcts = pick("percent"), masses = pick("mass"),
        mcs = pick("massconc"), mws = pick("molar");

  const echo = {
    体积: vols.map(v => v.value + " " + v.unit),
    浓度: concs.map(v => v.value + " " + v.unit),
    百分比: pcts.map(v => v.value + "%" + (v.basis ? " (" + v.basis + ")" : "")),
    质量浓度: mcs.map(v => v.value + " " + v.unit),
    摩尔质量: mws.map(v => v.value + " " + v.unit),
    识别到的试剂: reagents.map(f => f.r.n),
    分子量范围: mwRange ? mwRange.raw : null
  };

  const base = { echo, text, intent: det.intent };
  const missing = [];
  if (!det.intent) {
    return Object.assign(base, { ok: false, missing: [
      "没认出要做哪种计算。试试写成：「配 20 mL 1% 壳聚糖」、" +
      "「配 50 mL 10 mM NaCl」、「从 1 M 母液配 50 mL 10 mM」、" +
      "「配 500 mL 0.1 M PBS pH 7.4」。"] });
  }

  const totalV = vols.length ? vols[0] : null;
  const Vbase = totalV ? totalV.value * unitFactor(totalV.unit, "volume", deps) : NaN;

  /* ---- buffer ---- */
  if (det.intent === "buffer") {
    if (!totalV) missing.push("配制体积（例如 500 mL）");
    const Ct = concs.length ? concs[0] : null;
    if (!Ct) missing.push("缓冲总浓度（例如 0.1 M 或 100 mM）");
    if (missing.length) return Object.assign(base, { ok: false, missing });
    return Object.assign(base, { ok: true, route: "buffer",
      params: { system: det.system, pH: det.pH,
                Ctotal: Ct.value * unitFactor(Ct.unit, "conc", deps),
                Vfinal: Vbase },
      summary: `配 ${totalV.value} ${totalV.unit} 的 ${Ct.value} ${Ct.unit} ` +
               `${BUFFERS[det.system].name} 缓冲液，pH ${det.pH}` });
  }

  /* ---- dilution ---- */
  if (det.intent === "dilute") {
    if (concs.length < 2) missing.push("母液浓度和目标浓度两个值（例如「从 1 M 配 10 mM」）");
    if (!totalV) missing.push("要配多少体积（例如 50 mL）");
    if (missing.length) return Object.assign(base, { ok: false, missing });
    const vals = concs.map(c => c.value * unitFactor(c.unit, "conc", deps));
    const C1 = Math.max.apply(null, vals), C2 = Math.min.apply(null, vals);
    return Object.assign(base, { ok: true, route: "dilute",
      params: { C1, C2, V2: Vbase },
      summary: `从母液稀释配 ${totalV.value} ${totalV.unit}` });
  }

  /* ---- percent ---- */
  if (det.intent === "percent") {
    if (!totalV) missing.push("配制体积（例如 20 mL）");
    if (!pcts.length) missing.push("百分浓度（例如 1%）");
    if (missing.length) return Object.assign(base, { ok: false, missing });
    // pair each percentage with the nearest reagent mentioned before/after it
    const comps = pcts.map(p => {
      let best = null, bestD = Infinity;
      reagents.forEach(f => {
        const d = Math.abs(f.at - p.at);
        if (d < bestD) { bestD = d; best = f.r; }
      });
      const isLiquid = !!(best && best.rho);
      return {
        reagent: best, percent: p.value,
        basis: p.basis || (isLiquid ? "v/v" : "w/v"),
        basisAssumed: !p.basis
      };
    });
    return Object.assign(base, { ok: true, route: "percent",
      params: { Vfinal: Vbase, components: comps, mwRange },
      summary: `配 ${totalV.value} ${totalV.unit}，` +
               comps.map(c => `${c.percent}% ${c.reagent ? c.reagent.n : "（未识别试剂）"}`).join(" + ") });
  }

  /* ---- mass concentration (mg/mL etc.) ---- */
  if (det.intent === "massconc") {
    if (!totalV) missing.push("配制体积");
    if (missing.length) return Object.assign(base, { ok: false, missing });
    const c = mcs[0];
    return Object.assign(base, { ok: true, route: "massconc",
      params: { Vfinal: Vbase, c: c.value * unitFactor(c.unit, "massconc", deps),
                reagent: reagents.length ? reagents[0].r : null },
      summary: `配 ${totalV.value} ${totalV.unit} 的 ${c.value} ${c.unit}` });
  }

  /* ---- molar ---- */
  if (!totalV) missing.push("配制体积（例如 50 mL）");
  if (!concs.length) missing.push("目标浓度（例如 10 mM）");
  let M = mws.length ? mws[0].value * unitFactor(mws[0].unit, "molar", deps) : null;
  let Msource = M ? "你给的摩尔质量" : null;
  const reag = reagents.length ? reagents[0].r : null;
  if (M == null && reag && reag.f) {
    try { M = deps.molarMass(reag.f).mass; Msource = reag.n + " 的化学式 " + reag.f; }
    catch (e) { M = null; }
  }
  if (M == null && mwRange) {
    return Object.assign(base, { ok: false, missing: [
      `给的是摩尔质量范围（${mwRange.raw}），跨 ${deps.sig(mwRange.hi / mwRange.lo, 2)} 倍，` +
      `按它算摩尔浓度结果同样会差这么多倍，没有意义。` +
      `聚合物请改用质量百分比，例如「配 20 mL 1% 壳聚糖」，或用 mg/mL。`] });
  }
  if (M == null) missing.push("摩尔质量（例如 M=180.16 g/mol），或用化学式/试剂库里的名字");
  if (missing.length) return Object.assign(base, { ok: false, missing });
  const c = concs[0];
  return Object.assign(base, { ok: true, route: "molar",
    params: { M, Msource, C: c.value * unitFactor(c.unit, "conc", deps),
              V: Vbase, reagent: reag },
    summary: `配 ${totalV.value} ${totalV.unit} 的 ${c.value} ${c.unit}` +
             (reag ? " " + reag.n : "") });
}

function unitFactor(unit, dim, deps) { return deps.factorOf(dim, unit); }

/* ---------- solving ------------------------------------------------------
   Each route returns the same shape so the UI renders one way:
     { title, items:[{what, how, amount, formula, note}], notes, warnings }  */
function solveRequest(plan, deps) {
  if (!plan.ok) return plan;
  const sig = deps.sig, auto = deps.auto;
  const out = { ok: true, route: plan.route, echo: plan.echo,
                summary: plan.summary, items: [], notes: [], warnings: [] };

  if (plan.route === "percent") {
    const V = plan.params.Vfinal;                       // L
    plan.params.components.forEach(c => {
      const name = c.reagent ? c.reagent.n : "（未识别的物质）";
      if (c.basis === "v/v") {
        const vol = c.percent / 100 * V;                // L of neat liquid
        const item = { what: name, how: "量取",
          amount: auto(vol, "volume").text,
          formula: `V = ${c.percent}% × ${auto(V,"volume").text} = ${auto(vol,"volume").text}` };
        if (c.reagent && c.reagent.rho && c.reagent.w < 0.999)
          item.note = `按原瓶液体体积计。瓶子是 ${Math.round(c.reagent.w*1000)/10}% 纯度，` +
                      `若要 ${c.percent}% 的是纯${name}，需 ${auto(vol/c.reagent.w,"volume").text}。`;
        out.items.push(item);
      } else if (c.basis === "w/w") {
        const mass = c.percent / 100 * V * 1000;        // g, assuming ρ≈1 g/mL
        out.items.push({ what: name, how: "称取", amount: auto(mass, "mass").text,
          formula: `m = ${c.percent}% × ${auto(V,"volume").text} × 1 g/mL = ${auto(mass,"mass").text}`,
          note: "w/w 需要溶液密度；稀水溶液按 ρ ≈ 1 g/mL 近似，浓溶液请改用 w/v。" });
      } else {
        const mass = c.percent * V * 10;                // g  (= pct/100 × V_mL)
        out.items.push({ what: name, how: "称取", amount: auto(mass, "mass").text,
          formula: `m = ${c.percent} g/100 mL × ${auto(V,"volume").text} = ${auto(mass,"mass").text}` });
      }
      if (c.basisAssumed)
        out.warnings.push(`${name} 的 ${c.percent}% 按 <b>${c.basis}</b> 理解` +
          (c.basis === "v/v" ? "（液体试剂的惯例）" : "（固体的惯例：1 g / 100 mL）") +
          `。要用另一种请写明，例如「${c.percent}%(w/v)」。`);
    });
    if (plan.params.mwRange)
      out.notes.push(`你给了分子量 ${plan.params.mwRange.raw} —— 质量百分比配制<b>用不到摩尔质量</b>，` +
        `这个范围只影响粘度和溶解性，不进入计算。`);
    out.notes.push("先把溶剂加到约 2/3 体积，溶解完全后再定容到刻度。");
    out.title = plan.summary;
    return out;
  }

  if (plan.route === "molar") {
    const p = plan.params;
    const m = p.M * p.C * p.V;
    out.title = plan.summary;
    out.items.push({ what: p.reagent ? p.reagent.n : "溶质", how: "称取",
      amount: auto(m, "mass").text,
      formula: `m = M · C · V = ${sig(p.M,6)} × ${sig(p.C,4)} mol/L × ${auto(p.V,"volume").text}` });
    out.notes.push(`摩尔质量 ${sig(p.M,6)} g/mol，来自${p.Msource}。`);
    const we = deps.weighError(m, 0.1);
    if (we && we.relative > 1)
      out.warnings.push(`按 0.1 mg 分度值，称 ${auto(m,"mass").text} 的相对误差约 ` +
        `<b>${sig(we.relative,2)} %</b>，建议先配高浓度母液再稀释。`);
    return out;
  }

  if (plan.route === "massconc") {
    const p = plan.params;
    const m = p.c * p.V;                                 // g/L × L = g
    out.title = plan.summary;
    out.items.push({ what: p.reagent ? p.reagent.n : "溶质", how: "称取",
      amount: auto(m, "mass").text,
      formula: `m = c · V = ${sig(p.c,4)} g/L × ${auto(p.V,"volume").text}` });
    return out;
  }

  if (plan.route === "dilute") {
    const p = plan.params;
    const V1 = p.C2 * p.V2 / p.C1;
    out.title = plan.summary;
    out.items.push({ what: `母液 ${auto(p.C1,"conc").text}`, how: "量取",
      amount: auto(V1, "volume").text,
      formula: `V₁ = C₂V₂/C₁ = ${auto(p.C2,"conc").text} × ${auto(p.V2,"volume").text} / ${auto(p.C1,"conc").text}` });
    out.items.push({ what: "稀释液", how: "补至", amount: auto(p.V2, "volume").text,
      formula: `需补 ${auto(p.V2 - V1, "volume").text}` });
    if (V1 < 5e-6)
      out.warnings.push(`取样只有 ${auto(V1,"volume").text}，低于移液器可靠下限（约 5 µL），` +
        `建议先做一级中间稀释。`);
    return out;
  }

  if (plan.route === "buffer") {
    let r;
    try { r = deps.buffer(plan.params); }
    catch (e) { return { ok: false, echo: plan.echo, missing: [e.message] }; }
    out.title = plan.summary;
    r.items.forEach(it => out.items.push({
      what: it.reagent.label, how: it.volume ? "量取" : "称取",
      amount: it.volume ? auto(it.volume, "volume").text : auto(it.mass, "mass").text,
      formula: `配成 ${auto(it.conc, "conc").text}（M ${sig(it.M, 6)} g/mol）` }));
    out.notes.push(`离子强度 ${sig(r.I,3)} M，表观 pKa' ${sig(r.pKaApp[r.nearestIndex],4)}` +
      `（理想值 ${sig(r.pKaIdeal[r.nearestIndex],4)}，Davies 校正偏移 ${sig(r.shift,2)}）。`);
    r.warnings.forEach(w => out.warnings.push(w));
    out.warnings.push("<b>这是理论配比，残余误差 ±0.1–0.2 pH。</b>配好必须用 pH 计实测，" +
      "再用稀 HCl / NaOH 微调。");
    return out;
  }
  return { ok: false, echo: plan.echo, missing: ["内部错误：未知的计算类型"] };
}

/** One call: text in, renderable answer out. */
function ask(text, deps) {
  const plan = interpret(text, deps);
  return plan.ok ? solveRequest(plan, deps) : plan;
}

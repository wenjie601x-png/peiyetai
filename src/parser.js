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
  // never treat a leading "-" as a sign: volumes/concentrations/masses are all
  // positive here, so a dash is always a range separator ("50,000-190,000 Da")
  const re = /(\d+(?:[,，]\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*/g;
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


/* ---------- telling a target concentration from a bottle spec -------------
   A sentence like
     "含 1% (w/v) 壳聚糖、2% (v/v) 醋酸，用冰醋酸 (99.7%, 密度 1.04 g/mL)，
      壳聚糖 (Mv 50,000-190,000 Da, 脱乙酰度 75-85%)"
   carries four percent signs but only two of them are things to prepare. The
   other two describe the bottle and the material. Treating all four as targets
   produced "量取 冰醋酸 9.97 mL" — confidently wrong, which is the one outcome
   this parser is supposed to make impossible.                               */
function parenDepth(text) {
  const d = new Array(text.length).fill(0);
  let k = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") k++;
    d[i] = k;
    if (text[i] === ")") k = Math.max(0, k - 1);
  }
  return d;
}
const SPEC_WORDS = /(纯度|含量|assay|purity|脱乙酰度|deacetyl|水解度|取代度)\s*[:：]?\s*$/i;

/** Mark each percent quantity as a preparation target or a descriptive spec. */
function classifyPercents(text, pcts) {
  const depth = parenDepth(text);
  return pcts.map(p => {
    const before = text.slice(0, p.at);
    // the trailing half of a range ("75-85%") describes a property, not a target
    const isRangeTail = /\d\s*-\s*$/.test(before);
    // parenthetical content is supplementary: "(99.7%, 密度 1.04 g/mL)".
    // note "1% (w/v)" puts the paren AFTER the percent, so it stays a target
    const inParen = depth[p.at] > 0;
    const afterSpecWord = SPEC_WORDS.test(before.slice(-12));
    return Object.assign({}, p,
      { role: (isRangeTail || inParen || afterSpecWord) ? "spec" : "target" });
  });
}

/** Pull "(99.7%, 密度 1.04 g/mL)" off the reagent it follows. */
function bottleSpecs(text, reagents) {
  const out = new Map();
  reagents.forEach(f => {
    const tail = text.slice(f.at, f.at + 80);
    const grp = /\(([^)]*)\)/.exec(tail);
    if (!grp) return;
    const inner = grp[1];
    const pct = /(\d+(?:\.\d+)?)\s*%/.exec(inner);
    const rho = /(?:密度|ρ|density)?\s*(\d+(?:\.\d+)?)\s*g\s*\/\s*(?:ml|mL|cm3|cm³)/i.exec(inner);
    if (!pct && !rho) return;
    out.set(f.r.n, { w: pct ? parseFloat(pct[1]) / 100 : null,
                     rho: rho ? parseFloat(rho[1]) : null });
  });
  return out;
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
    分子量范围: mwRange ? mwRange.raw : null,
    pH: det.intent === "buffer" ? String(det.pH) : null,
    缓冲体系: det.intent === "buffer" ? BUFFERS[det.system].name : null
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
    const classed = classifyPercents(text, pcts);
    const targets = classed.filter(x => x.role === "target");
    const specs = classed.filter(x => x.role === "spec");
    if (!targets.length) missing.push("要配的百分浓度（例如 1%）");
    if (missing.length) return Object.assign(base, { ok: false, missing });

    // Guessing which reagent each percent belongs to is only safe when the
    // counts line up. Otherwise refuse — a mis-paired percent silently becomes
    // a wrong mass on the balance.
    if (reagents.length && targets.length !== reagents.length) {
      return Object.assign(base, { ok: false, missing: [
        `句子里有 ${targets.length} 个要配的百分浓度，却识别到 ${reagents.length} 个试剂` +
        `（${reagents.map(f => f.r.n).join("、")}），配不对号。` +
        `请一个物质一句话写清楚，或者切到 AI 解析。`] });
    }
    const bottles = bottleSpecs(text, reagents);
    const comps = targets.map((p, i) => {
      // counts match, so pair in the order they appear
      const best = reagents.length ? reagents[i].r : null;
      let reagent = best;
      let specSource = "library";
      if (best && bottles.has(best.n)) {
        const b = bottles.get(best.n);
        reagent = Object.assign({}, best,
          b.w != null ? { w: b.w } : {}, b.rho != null ? { rho: b.rho } : {});
        specSource = "user";
      }
      const isLiquid = !!(reagent && reagent.rho);
      return {
        reagent, percent: p.value,
        basis: p.basis || (isLiquid ? "v/v" : "w/v"),
        basisAssumed: !p.basis, specSource
      };
    });
    if (specs.length) {
      base.echo["已忽略的描述性百分数"] =
        specs.map(x => x.value + "%（纯度/物性，不是要配的浓度）");
    }
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
  // A "50,000-190,000 Da" range tokenises as a bare number plus "190,000 Da";
  // taking that upper bound as a definite molar mass is exactly the
  // confidently-wrong answer this parser exists to avoid. Refuse outright.
  if (mwRange) {
    return Object.assign(base, { ok: false, missing: [
      `给的是摩尔质量范围（${mwRange.raw}），上下限差 ` +
      `${deps.sig(mwRange.hi / mwRange.lo, 2)} 倍 —— 按摩尔浓度配，称出来的量也会差这么多倍，` +
      `这个数没有意义。聚合物请改用质量百分比（「配 20 mL 1% 壳聚糖」）或 mg/mL。`] });
  }
  let M = mws.length ? mws[0].value * unitFactor(mws[0].unit, "molar", deps) : null;
  let Msource = M ? "你给的摩尔质量" : null;
  const reag = reagents.length ? reagents[0].r : null;
  if (M == null && reag && reag.f) {
    try { M = deps.molarMass(reag.f).mass; Msource = reag.n + " 的化学式 " + reag.f; }
    catch (e) { M = null; }
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
        if (c.reagent && c.reagent.rho && c.reagent.w < 0.999) {
          const src = c.specSource === "user" ? "按你给的" : "按试剂库默认";
          item.note = `按原瓶液体体积计。${src} ${Math.round(c.reagent.w*10000)/100}% 纯度` +
                      (c.reagent.rho ? `、ρ ${c.reagent.rho} g/mL` : "") +
                      `，若要 ${c.percent}% 的是纯${name}，需 ${auto(vol/c.reagent.w,"volume").text}。` +
                      (c.specSource === "user" ? "" : "　瓶子规格不同的话在描述里写出来。");
        }
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

/* ---------- LLM output → the same plan shape -----------------------------
   The model only reads the sentence; it never does arithmetic. Its JSON is
   funnelled through the identical validation the local parser uses, so the
   refusals (molar-mass ranges, missing volume) and the percent-basis defaults
   behave the same whichever front end produced the numbers.                */

/** Map whatever unit spelling the model emitted onto a canonical one. */
function resolveUnit(raw, dim, deps) {
  const s = String(raw == null ? "" : raw).trim().replace(/[μμµ]/g, "µ");
  if (!s) return null;
  const list = deps.DIMS[dim] ? deps.DIMS[dim].units : [];
  for (const [u] of list) if (u === s) return u;
  for (const [u] of list) if (u.toLowerCase() === s.toLowerCase()) return u;
  for (const [unit, d, pat] of UNIT_PATTERNS) {
    if (d !== dim) continue;
    if (pat.test(s)) return unit;
  }
  return null;
}

function qty(obj, dim, deps) {
  if (!obj || typeof obj.value !== "number" || !isFinite(obj.value)) return null;
  const unit = resolveUnit(obj.unit, dim, deps);
  if (!unit) return null;
  return { value: obj.value, unit, base: obj.value * deps.factorOf(dim, unit) };
}

function findReagentByName(name, deps) {
  if (!name) return null;
  const hits = matchReagents(String(name), deps.REAGENTS);
  return hits.length ? hits[0].r : null;
}

function planFromLLM(p, deps, originalText) {
  p = p || {};
  // The model always fills `basis`, inferring it when the user did not say.
  // Only the user's own words count as "stated" — otherwise the assumption
  // notice would silently disappear on the AI path, hiding the single most
  // consequential guess (w/v vs v/v differ by a density factor).
  const userStatedBasis = /w\s*\/\s*v|v\s*\/\s*v|w\s*\/\s*w/i.test(String(originalText || ""));
  const echo = {
    "AI 的理解": p.understood || null,
    体积: p.volume ? [p.volume.value + " " + p.volume.unit] : [],
    浓度: p.concentration ? [p.concentration.value + " " + p.concentration.unit] : [],
    母液: p.stock ? [p.stock.value + " " + p.stock.unit] : [],
    百分比: (p.components || []).map(c =>
      c.percent + "% " + (c.name || "") + (c.basis ? " (" + c.basis + ")" : "")),
    摩尔质量: p.molarMass ? [p.molarMass.value + " " + p.molarMass.unit] : [],
    分子量范围: p.molarMassRange
      ? `${p.molarMassRange.lo}-${p.molarMassRange.hi} ${p.molarMassRange.unit || "Da"}` : null,
    pH: p.pH != null ? String(p.pH) : null,
    化学式: p.formula || null,
    来源: "DeepSeek 解析"
  };
  const base = { echo, intent: p.intent, viaLLM: true };
  const missing = [];
  const V = qty(p.volume, "volume", deps);
  const mwRange = p.molarMassRange && isFinite(p.molarMassRange.lo) && isFinite(p.molarMassRange.hi)
    ? { lo: p.molarMassRange.lo, hi: p.molarMassRange.hi,
        raw: `${p.molarMassRange.lo}-${p.molarMassRange.hi} ${p.molarMassRange.unit || "Da"}` }
    : null;

  if (!p.intent || p.intent === "unknown")
    return Object.assign(base, { ok: false, missing: [
      "AI 也没看懂这句话要做哪种计算。" + (p.understood ? "它的理解是：" + p.understood : "")] });

  if (p.intent === "buffer") {
    const Ct = qty(p.concentration, "conc", deps);
    if (!V) missing.push("配制体积");
    if (!Ct) missing.push("缓冲总浓度");
    if (p.pH == null) missing.push("目标 pH");
    const sys = deps.BUFFERS[p.bufferSystem] ? p.bufferSystem : "phosphate_na";
    if (missing.length) return Object.assign(base, { ok: false, missing });
    return Object.assign(base, { ok: true, route: "buffer",
      params: { system: sys, pH: Number(p.pH), Ctotal: Ct.base, Vfinal: V.base },
      summary: `配 ${V.value} ${V.unit} 的 ${Ct.value} ${Ct.unit} ` +
               `${deps.BUFFERS[sys].name} 缓冲液，pH ${p.pH}` });
  }

  if (p.intent === "dilute") {
    const C2 = qty(p.concentration, "conc", deps), C1 = qty(p.stock, "conc", deps);
    if (!V) missing.push("配制体积");
    if (!C1) missing.push("母液浓度");
    if (!C2) missing.push("目标浓度");
    if (missing.length) return Object.assign(base, { ok: false, missing });
    return Object.assign(base, { ok: true, route: "dilute",
      params: { C1: C1.base, C2: C2.base, V2: V.base },
      summary: `从 ${C1.value} ${C1.unit} 母液配 ${V.value} ${V.unit} 的 ${C2.value} ${C2.unit}` });
  }

  if (p.intent === "percent") {
    if (!V) missing.push("配制体积");
    const comps = (p.components || []).filter(c => isFinite(c && c.percent));
    if (!comps.length) missing.push("百分浓度和对应的物质");
    if (missing.length) return Object.assign(base, { ok: false, missing });
    return Object.assign(base, { ok: true, route: "percent",
      params: { Vfinal: V.base, mwRange,
        components: comps.map(c => {
          const reagent = findReagentByName(c.name, deps);
          const liquid = !!(reagent && reagent.rho);
          const basis = /^(w\/v|v\/v|w\/w)$/.test(c.basis || "")
            ? c.basis : (liquid ? "v/v" : "w/v");
          // a bottle spec the user actually stated overrides the library,
          // and we record which one was used so the note can say so — a
          // number that contradicts the echo above it destroys trust faster
          // than a small numerical error does
          let r = reagent || { n: c.name || "（未识别）" };
          const userPurity = isFinite(c.purity) ? Number(c.purity) / 100 : null;
          const userRho = isFinite(c.density) ? Number(c.density) : null;
          let specSource = "library";
          if (userPurity != null || userRho != null) {
            r = Object.assign({}, r, {
              w: userPurity != null ? userPurity : r.w,
              rho: userRho != null ? userRho : r.rho
            });
            specSource = "user";
          }
          return { reagent: r, percent: c.percent, basis,
                   basisAssumed: !userStatedBasis, specSource };
        }) },
      summary: `配 ${V.value} ${V.unit}，` +
        comps.map(c => `${c.percent}% ${c.name || "（未识别）"}`).join(" + ") });
  }

  if (p.intent === "massconc") {
    const c = qty(p.concentration, "massconc", deps);
    if (!V) missing.push("配制体积");
    if (!c) missing.push("质量浓度（如 5 mg/mL）");
    if (missing.length) return Object.assign(base, { ok: false, missing });
    return Object.assign(base, { ok: true, route: "massconc",
      params: { Vfinal: V.base, c: c.base, reagent: findReagentByName(p.components &&
        p.components[0] && p.components[0].name || p.formula, deps) },
      summary: `配 ${V.value} ${V.unit} 的 ${c.value} ${c.unit}` });
  }

  // molar — the same refusal as the local parser, applied to the model's output
  if (mwRange) {
    return Object.assign(base, { ok: false, missing: [
      `给的是摩尔质量范围（${mwRange.raw}），上下限差 ` +
      `${deps.sig(mwRange.hi / mwRange.lo, 2)} 倍 —— 按摩尔浓度配，称出来的量也会差这么多倍，` +
      `这个数没有意义。聚合物请改用质量百分比或 mg/mL。`] });
  }
  const C = qty(p.concentration, "conc", deps);
  if (!V) missing.push("配制体积");
  if (!C) missing.push("目标浓度");
  let M = null, Msource = null;
  const mm = qty(p.molarMass, "molar", deps);
  if (mm) { M = mm.base; Msource = "你给的摩尔质量"; }
  let reagent = findReagentByName(
    (p.components && p.components[0] && p.components[0].name) || p.formula, deps);
  if (M == null && p.formula) {
    try { M = deps.molarMass(p.formula).mass; Msource = "化学式 " + p.formula; } catch (e) {}
  }
  if (M == null && reagent && reagent.f) {
    try { M = deps.molarMass(reagent.f).mass; Msource = reagent.n + " 的化学式 " + reagent.f; }
    catch (e) {}
  }
  if (M == null) missing.push("摩尔质量（或给出化学式）");
  if (missing.length) return Object.assign(base, { ok: false, missing });
  return Object.assign(base, { ok: true, route: "molar",
    params: { M, Msource, C: C.base, V: V.base, reagent },
    summary: `配 ${V.value} ${V.unit} 的 ${C.value} ${C.unit}` +
             (reagent ? " " + reagent.n : (p.formula ? " " + p.formula : "")) });
}

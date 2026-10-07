/* ============================================================================
   CORE — pure calculation layer for the electrochemistry solution calculator.
   No DOM access. Tested headlessly under node (see test.mjs), then inlined
   verbatim into the single-file HTML artifact.
   ========================================================================== */
const CORE = (() => {
"use strict";

/* ---------- 1. atomic weights --------------------------------------------
   IUPAC 2021 standard atomic weights; conventional values for the elements
   given as intervals, and the longest-lived-isotope mass number for those
   with no stable nuclide.                                                   */
const ATOMIC = {
  H:1.008, He:4.002602, Li:6.94, Be:9.0121831, B:10.81, C:12.011, N:14.007,
  O:15.999, F:18.998403162, Ne:20.1797, Na:22.98976928, Mg:24.305,
  Al:26.9815384, Si:28.085, P:30.973761998, S:32.06, Cl:35.45, Ar:39.95,
  K:39.0983, Ca:40.078, Sc:44.955907, Ti:47.867, V:50.9415, Cr:51.9961,
  Mn:54.938043, Fe:55.845, Co:58.933194, Ni:58.6934, Cu:63.546, Zn:65.38,
  Ga:69.723, Ge:72.630, As:74.921595, Se:78.971, Br:79.904, Kr:83.798,
  Rb:85.4678, Sr:87.62, Y:88.905838, Zr:91.224, Nb:92.90637, Mo:95.95, Tc:98,
  Ru:101.07, Rh:102.90549, Pd:106.42, Ag:107.8682, Cd:112.414, In:114.818,
  Sn:118.710, Sb:121.760, Te:127.60, I:126.90447, Xe:131.293, Cs:132.90545196,
  Ba:137.327, La:138.90547, Ce:140.116, Pr:140.90766, Nd:144.242, Pm:145,
  Sm:150.36, Eu:151.964, Gd:157.249, Tb:158.925354, Dy:162.500, Ho:164.930329,
  Er:167.259, Tm:168.934219, Yb:173.045, Lu:174.9668, Hf:178.486, Ta:180.94788,
  W:183.84, Re:186.207, Os:190.23, Ir:192.217, Pt:195.084, Au:196.966570,
  Hg:200.592, Tl:204.38, Pb:207.2, Bi:208.98040, Po:209, At:210, Rn:222,
  Fr:223, Ra:226, Ac:227, Th:232.0377, Pa:231.03588, U:238.02891, Np:237,
  Pu:244, Am:243, Cm:247, Bk:247, Cf:251, Es:252, Fm:257, Md:258, No:259,
  Lr:266, Rf:267, Db:268, Sg:269, Bh:270, Hs:269, Mt:278, Ds:281, Rg:282,
  Cn:285, Nh:286, Fl:289, Mc:290, Lv:293, Ts:294, Og:294
};

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";

/* ---------- 2. formula parser --------------------------------------------
   Handles nested ()/[]/{}, unicode subscripts, leading stoichiometric
   coefficients, and hydrate dots (·, *, •, and a bare "." when it is clearly
   a hydrate separator rather than a decimal point).                         */
function parseFormula(raw) {
  if (typeof raw !== "string") throw new Error("请输入化学式");
  let s = raw.trim();
  if (!s) throw new Error("请输入化学式");

  s = s.replace(/\s+/g, "")
       .replace(/[₀-₉]/g, d => String(SUBSCRIPTS.indexOf(d)))
       .replace(/[•·・．。*xX×]/g, c =>
          (c === "x" || c === "X") ? "x" : "·")
       // a bare "." only separates a hydrate when digits+uppercase follow
       .replace(/\.(?=\d*[A-Z])/g, "·")
       // "CuSO4x5H2O" style written with a literal x
       .replace(/x(?=\d*H2O)/g, "·");

  const parts = s.split("·").filter(p => p !== "");
  if (!parts.length) throw new Error("请输入化学式");

  const counts = {};
  for (const part of parts) {
    const m = /^(\d+(?:\.\d+)?)?([\s\S]*)$/.exec(part);
    const coef = m[1] ? parseFloat(m[1]) : 1;
    const body = m[2];
    if (!body) throw new Error("化学式不完整：" + part);
    const sub = parseGroup(body);
    for (const k in sub) counts[k] = (counts[k] || 0) + sub[k] * coef;
  }
  return counts;
}

function parseGroup(str) {
  let i = 0;
  const OPEN = { "(": ")", "[": "]", "{": "}" };
  const CLOSE = { ")": 1, "]": 1, "}": 1 };

  function readNumber() {
    const m = /^\d+(?:\.\d+)?/.exec(str.slice(i));
    if (!m) return 1;
    i += m[0].length;
    return parseFloat(m[0]);
  }

  function atoms(expectClose) {
    const res = {};
    while (i < str.length) {
      const ch = str[i];
      if (OPEN[ch]) {
        const close = OPEN[ch];
        i++;
        const inner = atoms(close);
        if (str[i] !== close) throw new Error("括号不匹配，缺少 " + close);
        i++;
        const n = readNumber();
        for (const k in inner) res[k] = (res[k] || 0) + inner[k] * n;
      } else if (CLOSE[ch]) {
        if (expectClose) return res;
        throw new Error("多余的右括号 " + ch);
      } else if (/[A-Z]/.test(ch)) {
        let sym = (/^[A-Z][a-z]{0,2}/.exec(str.slice(i)) || [""])[0];
        while (sym.length > 1 && !(sym in ATOMIC)) sym = sym.slice(0, -1);
        if (!(sym in ATOMIC)) throw new Error("未知元素：" + str.slice(i, i + 2));
        i += sym.length;
        const n = readNumber();
        res[sym] = (res[sym] || 0) + n;
      } else {
        throw new Error("无法识别的字符：" + ch);
      }
    }
    if (expectClose) throw new Error("括号不匹配，缺少 " + expectClose);
    return res;
  }

  const out = atoms(null);
  if (!Object.keys(out).length) throw new Error("化学式为空");
  return out;
}

/** Molar mass in g/mol, plus the per-element breakdown used by the UI. */
function molarMass(formula) {
  const counts = parseFormula(formula);
  let total = 0;
  const rows = [];
  for (const el in counts) {
    const sub = ATOMIC[el] * counts[el];
    total += sub;
    rows.push({ element: el, count: counts[el], atomic: ATOMIC[el], subtotal: sub });
  }
  rows.sort((a, b) => b.subtotal - a.subtotal);
  rows.forEach(r => { r.percent = total > 0 ? (r.subtotal / total) * 100 : 0; });
  return { mass: total, rows, counts };
}

/* ---------- 3. units ------------------------------------------------------
   Everything is stored internally in SI-ish base units:
     mass g · volume L · concentration mol/L · amount mol · area cm²         */
const U = "µ";                       // micro sign
const DIMS = {
  mass:     { base: "g",     units: [["ng",1e-9],[U+"g",1e-6],["mg",1e-3],["g",1],["kg",1e3]] },
  volume:   { base: "L",     units: [["nL",1e-9],[U+"L",1e-6],["mL",1e-3],["L",1]] },
  conc:     { base: "mol/L", units: [["nM",1e-9],[U+"M",1e-6],["mM",1e-3],["M",1]] },
  amount:   { base: "mol",   units: [["nmol",1e-9],[U+"mol",1e-6],["mmol",1e-3],["mol",1]] },
  molar:    { base: "g/mol", units: [["g/mol",1],["kg/mol",1e3]] },
  massconc: { base: "g/L",   units: [[U+"g/L",1e-6],["mg/L",1e-3],["ppm",1e-3],[U+"g/mL",1e-3],["mg/mL",1],["g/L",1],["%(w/v)",10]] },
  area:     { base: "cm²", units: [[U+"m²",1e-8],["mm²",1e-2],["cm²",1],["m²",1e4]] },
  length:   { base: "cm",    units: [[U+"m",1e-4],["mm",0.1],["cm",1],["m",100]] },
  current:  { base: "A",     units: [["pA",1e-12],["nA",1e-9],[U+"A",1e-6],["mA",1e-3],["A",1]] },
  charge:   { base: "C",     units: [["nC",1e-9],[U+"C",1e-6],["mC",1e-3],["C",1]] },
  rate:     { base: "V/s",   units: [["mV/s",1e-3],["V/s",1]] },
  time:     { base: "s",     units: [["ms",1e-3],["s",1],["min",60],["h",3600]] },
  density:  { base: "g/mL",  units: [["g/mL",1],["kg/m³",1e-3],["g/cm³",1]] },
  diff:     { base: "cm²/s", units: [["cm²/s",1],["m²/s",1e4]] },
  surfconc: { base: "mol/cm²", units: [["fmol/cm²",1e-15],["pmol/cm²",1e-12],["nmol/cm²",1e-9],[U+"mol/cm²",1e-6],["mol/cm²",1]] }
};

function factorOf(dim, unit) {
  const d = DIMS[dim];
  if (!d) throw new Error("未知量纲 " + dim);
  const hit = d.units.find(u => u[0] === unit);
  if (!hit) throw new Error("未知单位 " + unit + "（" + dim + "）");
  return hit[1];
}
/** value in `unit` → base unit */
const toBase = (v, dim, unit) => v * factorOf(dim, unit);
/** base-unit value → `unit` */
const fromBase = (v, dim, unit) => v / factorOf(dim, unit);

/** The list entry with factor 1 — the canonical selectable unit for a dim.
    Distinct from DIMS[dim].base, which is only a display label and may not
    appear in the list at all (conc's base is "mol/L", its list has "M"). */
function baseUnitName(dim) {
  const list = DIMS[dim].units;
  const one = list.find(u => u[1] === 1);
  return one ? one[0] : list[list.length - 1][0];
}

/** Pick the unit that puts the magnitude in a readable range (≥1 preferred). */
function pickUnit(baseValue, dim) {
  const list = DIMS[dim].units
    .filter(u => !/ppm|%|\(/.test(u[0]))          // skip aliases when auto-picking
    .slice().sort((a, b) => b[1] - a[1]);
  const av = Math.abs(baseValue);
  if (!isFinite(av) || av === 0) return baseUnitName(dim);
  for (const [name, f] of list) if (av / f >= 1) return name;
  return list[list.length - 1][0];
}

/* ---------- 4. number formatting ----------------------------------------- */
const SUPER = { "-":"⁻", "0":"⁰", "1":"¹", "2":"²", "3":"³",
  "4":"⁴", "5":"⁵", "6":"⁶", "7":"⁷", "8":"⁸", "9":"⁹" };

/** Round to `sig` significant figures and render without exponent noise. */
function sig(x, n = 4) {
  if (!isFinite(x)) return "—";
  if (x === 0) return "0";
  const av = Math.abs(x);
  if (av >= 1e6 || av < 1e-4) {
    const exp = Math.floor(Math.log10(av));
    const mant = x / Math.pow(10, exp);
    const e = String(exp).split("").map(c => SUPER[c] || c).join("");
    return trimZeros(mant.toPrecision(n)) + "×10" + e;
  }
  const digits = Math.max(0, n - 1 - Math.floor(Math.log10(av)));
  return trimZeros(x.toFixed(Math.min(digits, 12)));
}
function trimZeros(s) {
  if (s.indexOf(".") < 0) return s;
  return s.replace(/\.?0+$/, "");
}
/** "34.04 µL" — auto unit, for the headline result. */
function auto(baseValue, dim, n = 4) {
  const unit = pickUnit(baseValue, dim);
  return { value: fromBase(baseValue, dim, unit), unit, text: sig(fromBase(baseValue, dim, unit), n) + " " + unit };
}
/** Every equivalent unit, for the strip under the headline. */
function allUnits(baseValue, dim, n = 4) {
  return DIMS[dim].units.map(([name, f]) => ({ unit: name, text: sig(baseValue / f, n) }));
}

/* ---------- 5. solvers ----------------------------------------------------
   Each returns { value (base units), dim, expr } where expr is the formula
   with the user's own numbers substituted — the auditable "worked line".    */
function need(obj, keys) {
  for (const k of keys) {
    if (obj[k] === null || obj[k] === undefined || !isFinite(obj[k]))
      throw new Error("请填写 " + k);
    if (obj[k] < 0) throw new Error(k + " 不能为负");
  }
}
function nonZero(obj, keys) {
  for (const k of keys) if (obj[k] === 0) throw new Error(k + " 不能为 0");
}

/** C₁V₁ = C₂V₂ — solve for whichever of the four is unknown. */
function dilution(p, unknown) {
  const { C1, V1, C2, V2 } = p;
  switch (unknown) {
    case "C2": need(p, ["C1","V1","V2"]); nonZero(p, ["V2"]);
      return { value: C1*V1/V2, dim: "conc",
               expr: `C₂ = C₁V₁ / V₂` };
    case "V2": need(p, ["C1","V1","C2"]); nonZero(p, ["C2"]);
      return { value: C1*V1/C2, dim: "volume",
               expr: `V₂ = C₁V₁ / C₂` };
    case "C1": need(p, ["C2","V2","V1"]); nonZero(p, ["V1"]);
      return { value: C2*V2/V1, dim: "conc",
               expr: `C₁ = C₂V₂ / V₁` };
    case "V1": need(p, ["C2","V2","C1"]); nonZero(p, ["C1"]);
      return { value: C2*V2/C1, dim: "volume",
               expr: `V₁ = C₂V₂ / C₁` };
    default: throw new Error("未知求解目标 " + unknown);
  }
}

/** m = M·C·V — solve for whichever of the four is unknown. */
function prep(p, unknown) {
  const { M, C, V, m } = p;
  switch (unknown) {
    case "m": need(p, ["M","C","V"]);
      return { value: M*C*V, dim: "mass", expr: "m = M · C · V" };
    case "C": need(p, ["M","V","m"]); nonZero(p, ["M","V"]);
      return { value: m/(M*V), dim: "conc", expr: "C = m / (M · V)" };
    case "V": need(p, ["M","C","m"]); nonZero(p, ["M","C"]);
      return { value: m/(M*C), dim: "volume", expr: "V = m / (M · C)" };
    case "M": need(p, ["C","V","m"]); nonZero(p, ["C","V"]);
      return { value: m/(C*V), dim: "molar", expr: "M = m / (C · V)" };
    default: throw new Error("未知求解目标 " + unknown);
  }
}

/** n = m / M */
function moles(p, unknown) {
  const { m, M, n } = p;
  switch (unknown) {
    case "n": need(p, ["m","M"]); nonZero(p, ["M"]);
      return { value: m/M, dim: "amount", expr: "n = m / M" };
    case "m": need(p, ["n","M"]);
      return { value: n*M, dim: "mass", expr: "m = n · M" };
    case "M": need(p, ["m","n"]); nonZero(p, ["n"]);
      return { value: m/n, dim: "molar", expr: "M = m / n" };
    default: throw new Error("未知求解目标 " + unknown);
  }
}

/** Neat concentration of a liquid reagent: C = 1000·ρ·w / M  (ρ g/mL, w frac) */
function stockFromLiquid({ rho, w, M }) {
  need({ rho, w, M }, ["rho","w","M"]); nonZero({ M }, ["M"]);
  if (w > 1) throw new Error("质量分数请填 0–100 %");
  return { value: 1000*rho*w/M, dim: "conc",
           expr: "C = 1000 · ρ · w% / M" };
}

/** Weigh-back: you weighed m_actual instead of the target. */
function weighBack({ M, m_actual, V_target, C_target }) {
  need({ M, m_actual }, ["M","m_actual"]); nonZero({ M }, ["M"]);
  const out = {};
  if (isFinite(V_target) && V_target > 0) {
    out.C_actual = m_actual/(M*V_target);
    if (isFinite(C_target) && C_target > 0) {
      out.deviation = (out.C_actual - C_target)/C_target*100;
      out.m_target  = M*C_target*V_target;
    }
  }
  if (isFinite(C_target) && C_target > 0) out.V_needed = m_actual/(M*C_target);
  return out;
}

/** Balance readability: absolute error d on a mass m. */
function weighError(m_base_g, d_mg) {
  const d = d_mg*1e-3;
  if (!(m_base_g > 0)) return null;
  return { relative: d/m_base_g*100, d_mg };
}

/** Serial / direct dilution ladder for a calibration series. */
function ladder({ Cstock, targets, Vfinal, mode }) {
  if (!(Cstock > 0)) throw new Error("母液浓度必须大于 0");
  if (!(Vfinal > 0)) throw new Error("每点终体积必须大于 0");
  // a 0 point is a legitimate calibration blank — keep it, but it is pure
  // diluent and never a link in a serial chain, so it always sorts last
  const all = targets.filter(t => isFinite(t) && t >= 0).slice().sort((a,b) => b-a);
  if (!all.length) throw new Error("请至少填一个目标浓度");
  const list = all.filter(t => t > 0);
  const hasBlank = all.length > list.length;
  if (list.length && list[0] > Cstock)
    throw new Error("最高目标浓度 (" + sig(list[0]*1000) + " mM) 超过母液浓度 ("
                    + sig(Cstock*1000) + " mM)");

  const rows = [];
  if (mode === "serial") {
    let from = Cstock, fromLabel = "母液";
    for (let i = 0; i < list.length; i++) {
      const Ci = list[i];
      const Vtransfer = Ci*Vfinal/from;
      rows.push({ index: i+1, target: Ci, from: fromLabel, fromC: from,
                  Vtransfer, Vdiluent: Vfinal - Vtransfer, Vtotal: Vfinal,
                  fold: from/Ci });
      from = Ci; fromLabel = "第 " + (i+1) + " 级";
    }
    // each intermediate must hold its own final volume *plus* whatever the
    // next stage draws off it
    for (let i = 0; i < rows.length-1; i++) rows[i].Vneeded = Vfinal + rows[i+1].Vtransfer;
    if (rows.length) rows[rows.length-1].Vneeded = Vfinal;
  } else {
    for (let i = 0; i < list.length; i++) {
      const Ci = list[i];
      const Vtransfer = Ci*Vfinal/Cstock;
      rows.push({ index: i+1, target: Ci, from: "母液", fromC: Cstock,
                  Vtransfer, Vdiluent: Vfinal - Vtransfer, Vtotal: Vfinal,
                  Vneeded: Vfinal, fold: Cstock/Ci });
    }
  }
  if (hasBlank)
    rows.push({ index: rows.length+1, target: 0, from: "—", fromC: 0, blank: true,
                Vtransfer: 0, Vdiluent: Vfinal, Vtotal: Vfinal, Vneeded: Vfinal, fold: Infinity });
  return rows;
}

/** Equally spaced / log spaced target series. 0 is allowed as a linear blank. */
function series({ lo, hi, n, kind }) {
  if (!(n >= 2)) throw new Error("点数至少 2");
  if (!(hi > 0)) throw new Error("最高浓度必须大于 0");
  if (kind === "log" && !(lo > 0)) throw new Error("等比序列的最低浓度必须大于 0（0 点请用等差）");
  if (!(lo >= 0)) throw new Error("浓度不能为负");
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i/(n-1);
    out.push(kind === "log" ? lo*Math.pow(hi/lo, t) : lo + (hi-lo)*t);
  }
  return out;
}

/* ---------- 6. buffers ----------------------------------------------------
   General polyprotic treatment with Davies activity correction. pH is an
   activity scale, so pairing the measured pH with concentration-based
   apparent Ka' is the self-consistent combination.                          */
const DAVIES_A = 0.509;                   // 25 °C, water
function logGamma(z, I) {
  if (!z) return 0;                       // neutral species: γ ≈ 1
  const r = Math.sqrt(I);
  return -DAVIES_A * z * z * (r/(1+r) - 0.3*I);
}

/**
 * systems: fully protonated form carries `zmax`, `pKa` lists each successive
 * deprotonation. Species j (j protons removed) has charge zmax − j.
 */
const BUFFERS = {
  phosphate_na: {
    name: "磷酸盐 (Na)", short: "PBS",
    pKa: [2.15, 7.20, 12.35], dpKadT: [0, -0.0028, 0], zmax: 0, nH: 3,
    range: [5.8, 8.0],
    reagents: [
      { key:"nah2po4",    label:"NaH₂PO₄ (无水)",        formula:"NaH2PO4",       j:1, counter:"Na⁺" },
      { key:"nah2po4_2h", label:"NaH₂PO₄·2H₂O", formula:"NaH2PO4·2H2O",  j:1, counter:"Na⁺" },
      { key:"na2hpo4",    label:"Na₂HPO₄ (无水)",        formula:"Na2HPO4",       j:2, counter:"Na⁺" },
      { key:"na2hpo4_12h",label:"Na₂HPO₄·12H₂O",formula:"Na2HPO4·12H2O", j:2, counter:"Na⁺" },
      { key:"na2hpo4_7h", label:"Na₂HPO₄·7H₂O", formula:"Na2HPO4·7H2O",  j:2, counter:"Na⁺" }
    ],
    defaultAcid: "nah2po4", defaultBase: "na2hpo4"
  },
  phosphate_k: {
    name: "磷酸盐 (K)", short: "KPB",
    pKa: [2.15, 7.20, 12.35], dpKadT: [0, -0.0028, 0], zmax: 0, nH: 3,
    range: [5.8, 8.0],
    reagents: [
      { key:"kh2po4", label:"KH₂PO₄",  formula:"KH2PO4", j:1, counter:"K⁺" },
      { key:"k2hpo4", label:"K₂HPO₄",  formula:"K2HPO4", j:2, counter:"K⁺" },
      { key:"k2hpo4_3h", label:"K₂HPO₄·3H₂O", formula:"K2HPO4·3H2O", j:2, counter:"K⁺" }
    ],
    defaultAcid: "kh2po4", defaultBase: "k2hpo4"
  },
  tris: {
    name: "Tris-HCl", short: "Tris",
    pKa: [8.06], dpKadT: [-0.028], zmax: 1, nH: 1, range: [7.0, 9.0],
    reagents: [
      { key:"trishcl", label:"Tris·HCl",    formula:"C4H11NO3·HCl", j:0, counter:"Cl⁻" },
      { key:"trisbase",label:"Tris base (游离碱)", formula:"C4H11NO3",     j:1, counter:null }
    ],
    defaultAcid: "trishcl", defaultBase: "trisbase",
    titrant: { label:"HCl", direction:"acid" }
  },
  acetate: {
    name: "醋酸盐", short: "AcO",
    pKa: [4.76], dpKadT: [-0.0002], zmax: 0, nH: 1, range: [3.7, 5.8],
    reagents: [
      { key:"hac",     label:"醋酸 (冰醋酸)",            formula:"C2H4O2",       j:0, counter:null, liquid:{ rho:1.049, w:0.995 } },
      { key:"naac",    label:"CH₃COONa (无水)",      formula:"C2H3O2Na",     j:1, counter:"Na⁺" },
      { key:"naac_3h", label:"CH₃COONa·3H₂O", formula:"C2H3O2Na·3H2O", j:1, counter:"Na⁺" }
    ],
    defaultAcid: "hac", defaultBase: "naac_3h"
  },
  citrate: {
    name: "柠檬酸盐", short: "Cit",
    pKa: [3.13, 4.76, 6.40], dpKadT: [0, 0, 0], zmax: 0, nH: 3, range: [2.6, 7.4],
    reagents: [
      { key:"citric_h2o", label:"柠檬酸·H₂O",        formula:"C6H8O7·H2O",   j:0, counter:null },
      { key:"citric",     label:"柠檬酸 (无水)",               formula:"C6H8O7",       j:0, counter:null },
      { key:"nacit_2h",   label:"柠檬酸三钠·2H₂O",   formula:"C6H5O7Na3·2H2O", j:3, counter:"Na⁺" },
      { key:"nacit",      label:"柠檬酸三钠 (无水)",           formula:"C6H5O7Na3",    j:3, counter:"Na⁺" }
    ],
    defaultAcid: "citric_h2o", defaultBase: "nacit_2h"
  },
  hepes: {
    name: "HEPES", short: "HEPES",
    pKa: [7.48], dpKadT: [-0.014], zmax: 0, nH: 1, range: [6.8, 8.2],
    reagents: [
      { key:"hepes_acid", label:"HEPES 游离酸", formula:"C8H18N2O4S",    j:0, counter:null },
      { key:"hepes_na",   label:"HEPES 钠盐",   formula:"C8H17N2O4SNa",  j:1, counter:"Na⁺" }
    ],
    defaultAcid: "hepes_acid", defaultBase: "hepes_na",
    titrant: { label:"NaOH", direction:"base" }
  },
  mes: {
    name: "MES", short: "MES",
    pKa: [6.15], dpKadT: [-0.011], zmax: 0, nH: 1, range: [5.5, 6.9],
    reagents: [
      { key:"mes_acid", label:"MES 游离酸",  formula:"C6H13NO4S",     j:0, counter:null },
      { key:"mes_na",   label:"MES 钠盐",    formula:"C6H12NO4SNa",   j:1, counter:"Na⁺" }
    ],
    defaultAcid: "mes_acid", defaultBase: "mes_na",
    titrant: { label:"NaOH", direction:"base" }
  },
  carbonate: {
    name: "碳酸盐", short: "CO₃",
    pKa: [6.35, 10.33], dpKadT: [-0.009, -0.009], zmax: 0, nH: 2, range: [9.2, 10.8],
    reagents: [
      { key:"nahco3", label:"NaHCO₃",        formula:"NaHCO3",  j:1, counter:"Na⁺" },
      { key:"na2co3", label:"Na₂CO₃ (无水)", formula:"Na2CO3", j:2, counter:"Na⁺" }
    ],
    defaultAcid: "nahco3", defaultBase: "na2co3"
  },
  ammonia: {
    name: "氨/铵", short: "NH₄",
    pKa: [9.25], dpKadT: [-0.031], zmax: 1, nH: 1, range: [8.2, 10.2],
    reagents: [
      { key:"nh4cl", label:"NH₄Cl",      formula:"NH4Cl", j:0, counter:"Cl⁻" },
      { key:"nh3",   label:"氨水 (NH₃)", formula:"NH3",   j:1, counter:null, liquid:{ rho:0.90, w:0.25 } }
    ],
    defaultAcid: "nh4cl", defaultBase: "nh3"
  }
};

/** Species distribution at a given pH for one buffer system. */
function speciate(sys, pH, I, T) {
  const H = Math.pow(10, -pH);
  const pKa = sys.pKa.map((p, k) =>
    p + (sys.dpKadT[k] || 0) * (T - 25));
  // activity-corrected: pKa'_k = pKa_k + log γ(z_k) − log γ(z_{k−1})
  const pKaApp = pKa.map((p, k) => {
    const zBefore = sys.zmax - k;         // species with k protons removed
    const zAfter  = sys.zmax - (k + 1);
    return p + logGamma(zAfter, I) - logGamma(zBefore, I);
  });
  const Ka = pKaApp.map(p => Math.pow(10, -p));

  const n = sys.nH;
  const terms = [];
  let prod = 1;
  for (let j = 0; j <= n; j++) {
    if (j > 0) prod *= Ka[j-1];
    terms.push(Math.pow(H, n-j) * prod);
  }
  const D = terms.reduce((a, b) => a + b, 0);
  const f = terms.map(t => t / D);
  let nbar = 0;
  for (let j = 0; j <= n; j++) nbar += (n - j) * f[j];
  return { f, nbar, pKaApp, pKa };
}

/**
 * Recipe for a two-reagent buffer. Iterates ionic strength to self-consistency
 * because pKa' depends on I, which depends on the speciation it produces.
 */
function buffer({ system, pH, Ctotal, Vfinal, acidKey, baseKey, T = 25,
                  addNaCl = 0, addKCl = 0, davies = true }) {
  const sys = BUFFERS[system];
  if (!sys) throw new Error("未知缓冲体系 " + system);
  if (!(Ctotal > 0)) throw new Error("总浓度必须大于 0");
  if (!(Vfinal > 0)) throw new Error("终体积必须大于 0");
  if (!isFinite(pH)) throw new Error("请填写目标 pH");

  const acid = sys.reagents.find(r => r.key === (acidKey || sys.defaultAcid));
  const base = sys.reagents.find(r => r.key === (baseKey || sys.defaultBase));
  if (!acid || !base) throw new Error("请选择两种试剂");
  const pA = sys.nH - acid.j, pB = sys.nH - base.j;   // protons each supplies
  if (pA === pB) throw new Error("两种试剂必须处在不同质子化状态");

  let I = davies ? 0.05 : 0, sp = null, x = 0, y = 0;
  for (let iter = 0; iter < 60; iter++) {
    sp = speciate(sys, pH, davies ? I : 0, T);
    x = Ctotal * (sp.nbar - pB) / (pA - pB);          // mol/L of the acid form
    y = Ctotal - x;
    let Inew = 0;
    for (let j = 0; j <= sys.nH; j++) {
      const z = sys.zmax - j;
      Inew += Ctotal * sp.f[j] * z * z;
    }
    const zA = sys.zmax - acid.j, zB = sys.zmax - base.j;
    Inew += Math.max(x, 0) * Math.abs(zA) + Math.max(y, 0) * Math.abs(zB);
    Inew = Inew / 2 + addNaCl + addKCl;
    if (Math.abs(Inew - I) < 1e-9) { I = Inew; break; }
    I = Inew;
  }

  // Which deprotonation steps does this reagent pair actually bracket? Those
  // pKa' values set the usable window; outside pKa'±1 it is not a buffer.
  const span = usableSpan(sys, acid, base, sp.pKaApp);
  const warnings = [];
  if (pH < span.lo - 2 || pH > span.hi + 2 || x < -1e-12 || y < -1e-12) {
    throw new Error(
      `${acid.label} / ${base.label} 配不出 pH ${sig(pH,3)}。这对试剂的有效范围约 ` +
      `pH ${sig(span.lo - 2, 3)}–${sig(span.hi + 2, 3)}（pKa' ${span.list.map(v => sig(v,3)).join(" / ")}）。` +
      `请换一对试剂或换缓冲体系。`);
  }
  if (pH < span.lo - 1 || pH > span.hi + 1)
    warnings.push(`目标 pH 已接近该体系可用边界（pKa' ${span.list.map(v => sig(v,3)).join(" / ")}），` +
                  `缓冲容量弱，少量酸碱污染就会让 pH 明显漂移。`);
  if (davies && I > 0.2)
    warnings.push(`离子强度算出来是 ${sig(I,3)} M，已超出 Davies 式标称的可靠区间（≲0.1 M，勉强可用到 ~0.5 M）。` +
                  `校正方向仍然对，但数值误差会大于 ±0.1 pH。`);

  const mkMass = (r, c) => {
    const M = molarMass(r.formula).mass;
    const mass = M * c * Vfinal;
    const item = { reagent: r, M, conc: c, mass, moles: c * Vfinal };
    // liquid reagents (glacial acetic acid, ammonia) get pipetted, not weighed
    if (r.liquid) item.volume = mass / (r.liquid.rho * r.liquid.w) / 1000;   // L
    return item;
  };
  const items = [mkMass(acid, x), mkMass(base, y)];
  if (addNaCl > 0) items.push({ reagent:{ label:"NaCl", formula:"NaCl", extra:true },
                                M: molarMass("NaCl").mass, conc: addNaCl,
                                mass: molarMass("NaCl").mass*addNaCl*Vfinal, moles: addNaCl*Vfinal });
  if (addKCl > 0) items.push({ reagent:{ label:"KCl", formula:"KCl", extra:true },
                               M: molarMass("KCl").mass, conc: addKCl,
                               mass: molarMass("KCl").mass*addKCl*Vfinal, moles: addKCl*Vfinal });

  // the step this buffer actually rides on — the one whose pKa' is nearest pH
  const ideal = speciate(sys, pH, 0, T);
  const jLo = Math.min(acid.j, base.j), jHi = Math.max(acid.j, base.j);
  let kNear = jLo;
  for (let k = jLo; k < jHi; k++)
    if (Math.abs(sp.pKaApp[k] - pH) < Math.abs(sp.pKaApp[kNear] - pH)) kNear = k;
  kNear = Math.min(kNear, sp.pKaApp.length - 1);

  return {
    items, I, ratio: y > 0 ? x/y : Infinity, nbar: sp.nbar,
    pKaApp: sp.pKaApp, pKaIdeal: ideal.pKaApp, pKaThermo: sys.pKa,
    shift: sp.pKaApp[kNear] - ideal.pKaApp[kNear],
    nearestIndex: kNear, span, acid, base, warnings, sys, T, davies,
    fractions: sp.f, Ctotal, Vfinal, pH
  };
}

/**
 * The deprotonation steps a reagent pair brackets, and their apparent pKa.
 * Acid form supplies pA protons, base form pB; the steps between them are the
 * ones this pair can actually titrate, so their pKa' values bound the window.
 */
function usableSpan(sys, acid, base, pKaApp) {
  const jLo = Math.min(acid.j, base.j), jHi = Math.max(acid.j, base.j);
  const list = [];
  for (let k = jLo; k < jHi; k++) list.push(pKaApp[k]);
  if (!list.length) list.push(pKaApp[Math.min(jLo, pKaApp.length - 1)]);
  return { lo: Math.min.apply(null, list), hi: Math.max.apply(null, list), list };
}

/** Predict the pH a given molar ratio will actually give (the PBS back-test). */
function predictPH(system, { cAcid, cBase, acidKey, baseKey, T = 25,
                             addNaCl = 0, addKCl = 0, davies = true }) {
  const sys = BUFFERS[system];
  const acid = sys.reagents.find(r => r.key === acidKey);
  const base = sys.reagents.find(r => r.key === baseKey);
  const Ctotal = cAcid + cBase;
  const pA = sys.nH - acid.j, pB = sys.nH - base.j;
  const targetNbar = (cAcid*pA + cBase*pB)/Ctotal;

  let I = davies ? 0.05 : 0, pH = 7;
  for (let iter = 0; iter < 80; iter++) {
    let lo = 0, hi = 14;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi)/2;
      if (speciate(sys, mid, davies ? I : 0, T).nbar > targetNbar) lo = mid; else hi = mid;
    }
    pH = (lo + hi)/2;
    const sp = speciate(sys, pH, davies ? I : 0, T);
    let Inew = 0;
    for (let j = 0; j <= sys.nH; j++) { const z = sys.zmax - j; Inew += Ctotal*sp.f[j]*z*z; }
    Inew += cAcid*Math.abs(sys.zmax - acid.j) + cBase*Math.abs(sys.zmax - base.j);
    Inew = Inew/2 + addNaCl + addKCl;
    if (Math.abs(Inew - I) < 1e-10) { I = Inew; break; }
    I = Inew;
  }
  return { pH, I };
}

/* ---------- 7. electrochemistry ------------------------------------------ */
const F_CONST = 96485.332;                // C/mol
const RS_CONST = 2.69e5;                  // Randles-Ševčík, 25 °C

/** Disc / rectangle / ring geometric area, in cm². */
function electrodeArea(shape, dims) {
  switch (shape) {
    case "disc": {
      const d = dims.d;                   // cm
      if (!(d > 0)) throw new Error("直径必须大于 0");
      return { value: Math.PI*d*d/4, expr: "A = πd²/4" };
    }
    case "rect": {
      const { w, h } = dims;
      if (!(w > 0) || !(h > 0)) throw new Error("长宽必须大于 0");
      return { value: w*h, expr: "A = w · h" };
    }
    case "ring": {
      const { dOut, dIn } = dims;
      if (!(dOut > 0) || !(dIn >= 0)) throw new Error("直径必须大于 0");
      if (dIn >= dOut) throw new Error("内径必须小于外径");
      return { value: Math.PI*(dOut*dOut - dIn*dIn)/4, expr: "A = π(dₒ² − dᵢ²)/4" };
    }
    default: throw new Error("未知电极形状");
  }
}

/**
 * Randles-Ševčík, reversible, 25 °C:
 *   i_p = 2.69×10⁵ · n^1.5 · A · D^0.5 · C · v^0.5
 * C MUST be mol/cm³ here, not mol/L — the factor-1000 trap. Callers pass C in
 * mol/L (the app's base unit) and this converts internally.
 */
function randlesSevcik(p, unknown) {
  const n = p.n, A = p.A, D = p.D, v = p.v;
  const C = p.C !== undefined && p.C !== null ? p.C/1000 : null;  // mol/L → mol/cm³
  const ip = p.ip;
  const K = RS_CONST;
  switch (unknown) {
    case "ip": need({n,A,D,C,v},["n","A","D","C","v"]);
      return { value: K*Math.pow(n,1.5)*A*Math.sqrt(D)*C*Math.sqrt(v), dim:"current",
               expr: "iₚ = 2.69×10⁵ · n³ᐟ² · A · D¹ᐟ² · C · v¹ᐟ²" };
    case "D": need({n,A,C,v,ip},["n","A","C","v","ip"]);
      { const r = ip/(K*Math.pow(n,1.5)*A*C*Math.sqrt(v));
        return { value: r*r, dim:"diff", expr: "D = [ iₚ / (2.69×10⁵ n³ᐟ² A C v¹ᐟ²) ]²" }; }
    case "A": need({n,D,C,v,ip},["n","D","C","v","ip"]);
      return { value: ip/(K*Math.pow(n,1.5)*Math.sqrt(D)*C*Math.sqrt(v)), dim:"area",
               expr: "A = iₚ / (2.69×10⁵ n³ᐟ² D¹ᐟ² C v¹ᐟ²)" };
    case "C": need({n,A,D,v,ip},["n","A","D","v","ip"]);
      return { value: 1000*ip/(K*Math.pow(n,1.5)*A*Math.sqrt(D)*Math.sqrt(v)), dim:"conc",
               expr: "C = iₚ / (2.69×10⁵ n³ᐟ² A D¹ᐟ² v¹ᐟ²)" };
    default: throw new Error("未知求解目标 " + unknown);
  }
}

/** Cottrell: i(t) = nFAD^½C / (π^½ t^½), C in mol/L → mol/cm³ internally. */
function cottrell({ n, A, D, C, t }) {
  need({ n, A, D, C, t }, ["n","A","D","C","t"]); nonZero({ t }, ["t"]);
  const Ccm = C/1000;
  return { value: n*F_CONST*A*Math.sqrt(D)*Ccm/(Math.sqrt(Math.PI)*Math.sqrt(t)),
           dim: "current", expr: "i(t) = nFAD¹ᐟ²C / (π¹ᐟ² t¹ᐟ²)" };
}

/** Surface coverage Γ = Q / (nFA), mol/cm². */
function coverage({ Q, n, A }) {
  need({ Q, n, A }, ["Q","n","A"]); nonZero({ n, A }, ["n","A"]);
  return { value: Q/(n*F_CONST*A), dim: "surfconc", expr: "Γ = Q / (nFA)" };
}

/** Faraday: n = Q / (zF). */
function chargeToMoles({ Q, z }) {
  need({ Q, z }, ["Q","z"]); nonZero({ z }, ["z"]);
  return { value: Q/(z*F_CONST), dim: "amount", expr: "n = Q / (zF)" };
}

/** Current density j = i / A. */
function currentDensity({ i, A }) {
  need({ i, A }, ["i","A"]); nonZero({ A }, ["A"]);
  return { value: i/A, expr: "j = i / A" };     // A/cm², formatted by caller
}

/** LOD = kσ/S. S in A per (mol/L); σ in A. Returns mol/L. */
function detectionLimit({ S, sigma, k = 3 }) {
  need({ S, sigma }, ["S","sigma"]); nonZero({ S }, ["S"]);
  return { value: k*sigma/S, dim: "conc", expr: `LOD = ${k}σ / S` };
}

/* ---------- 8. reagent library ------------------------------------------- */
const REAGENTS = [
  // 支持电解质 / 缓冲盐
  { g:"电解质 / 缓冲盐", n:"氯化钾", en:"KCl", f:"KCl" },
  { g:"电解质 / 缓冲盐", n:"氯化钠", en:"NaCl", f:"NaCl" },
  { g:"电解质 / 缓冲盐", n:"磷酸氢二钠 (无水)", en:"Na2HPO4", f:"Na2HPO4" },
  { g:"电解质 / 缓冲盐", n:"磷酸氢二钠 十二水", en:"Na2HPO4·12H2O", f:"Na2HPO4·12H2O" },
  { g:"电解质 / 缓冲盐", n:"磷酸二氢钠 (无水)", en:"NaH2PO4", f:"NaH2PO4" },
  { g:"电解质 / 缓冲盐", n:"磷酸二氢钠 二水", en:"NaH2PO4·2H2O", f:"NaH2PO4·2H2O" },
  { g:"电解质 / 缓冲盐", n:"磷酸二氢钾", en:"KH2PO4", f:"KH2PO4" },
  { g:"电解质 / 缓冲盐", n:"磷酸氢二钾", en:"K2HPO4", f:"K2HPO4" },
  { g:"电解质 / 缓冲盐", n:"Tris 游离碱", en:"Tris base", f:"C4H11NO3" },
  { g:"电解质 / 缓冲盐", n:"Tris 盐酸盐", en:"Tris·HCl", f:"C4H11NO3·HCl" },
  { g:"电解质 / 缓冲盐", n:"醋酸钠 三水", en:"CH3COONa·3H2O", f:"C2H3O2Na·3H2O" },
  { g:"电解质 / 缓冲盐", n:"醋酸钠 (无水)", en:"CH3COONa", f:"C2H3O2Na" },
  { g:"电解质 / 缓冲盐", n:"柠檬酸 一水", en:"Citric acid·H2O", f:"C6H8O7·H2O" },
  { g:"电解质 / 缓冲盐", n:"柠檬酸三钠 二水", en:"Na3citrate·2H2O", f:"C6H5O7Na3·2H2O" },
  { g:"电解质 / 缓冲盐", n:"HEPES 游离酸", en:"HEPES", f:"C8H18N2O4S" },
  { g:"电解质 / 缓冲盐", n:"MES 游离酸", en:"MES", f:"C6H13NO4S" },
  { g:"电解质 / 缓冲盐", n:"硫酸钠", en:"Na2SO4", f:"Na2SO4" },
  { g:"电解质 / 缓冲盐", n:"硝酸钾", en:"KNO3", f:"KNO3" },
  { g:"电解质 / 缓冲盐", n:"碳酸氢钠", en:"NaHCO3", f:"NaHCO3" },
  { g:"电解质 / 缓冲盐", n:"氢氧化钠", en:"NaOH", f:"NaOH" },
  { g:"电解质 / 缓冲盐", n:"氢氧化钾", en:"KOH", f:"KOH" },

  // 氧化还原探针
  { g:"氧化还原探针", n:"铁氰化钾 (赤血盐)", en:"K3[Fe(CN)6]", f:"K3[Fe(CN)6]" },
  { g:"氧化还原探针", n:"亚铁氰化钾 三水", en:"K4[Fe(CN)6]·3H2O", f:"K4[Fe(CN)6]·3H2O" },
  { g:"氧化还原探针", n:"六氨合氯化钌(III)", en:"Ru(NH3)6Cl3", f:"Ru(NH3)6Cl3" },
  { g:"氧化还原探针", n:"二茂铁甲醇", en:"FcMeOH", f:"C11H12FeO" },
  { g:"氧化还原探针", n:"对苯二酚", en:"Hydroquinone", f:"C6H6O2" },
  { g:"氧化还原探针", n:"氯化铁 六水 (PB 前体)", en:"FeCl3·6H2O", f:"FeCl3·6H2O" },

  // 浓液体试剂
  { g:"浓液体试剂", n:"浓硫酸", en:"H2SO4", f:"H2SO4", rho:1.84, w:0.98, acid:true },
  { g:"浓液体试剂", n:"浓盐酸", en:"HCl", f:"HCl", rho:1.18, w:0.37, acid:true },
  { g:"浓液体试剂", n:"浓硝酸", en:"HNO3", f:"HNO3", rho:1.40, w:0.68, acid:true },
  { g:"浓液体试剂", n:"高氯酸", en:"HClO4", f:"HClO4", rho:1.67, w:0.70, acid:true },
  { g:"浓液体试剂", n:"磷酸", en:"H3PO4", f:"H3PO4", rho:1.69, w:0.85, acid:true },
  { g:"浓液体试剂", n:"冰醋酸", en:"CH3COOH", f:"C2H4O2", rho:1.049, w:0.995, acid:true },
  { g:"浓液体试剂", n:"过氧化氢 30%", en:"H2O2", f:"H2O2", rho:1.11, w:0.30 },
  { g:"浓液体试剂", n:"戊二醛 25%", en:"Glutaraldehyde", f:"C5H8O2", rho:1.06, w:0.25 },
  { g:"浓液体试剂", n:"氨水 25%", en:"NH3·H2O", f:"NH3", rho:0.90, w:0.25 },

  // 分析物 / 干扰物
  { g:"分析物 / 干扰物", n:"D-葡萄糖 (无水)", en:"D-Glucose", f:"C6H12O6" },
  { g:"分析物 / 干扰物", n:"D-葡萄糖 一水", en:"D-Glucose·H2O", f:"C6H12O6·H2O" },
  { g:"分析物 / 干扰物", n:"L-乳酸钠", en:"Sodium L-lactate", f:"C3H5O3Na" },
  { g:"分析物 / 干扰物", n:"L-乳酸", en:"L-Lactic acid", f:"C3H6O3" },
  { g:"分析物 / 干扰物", n:"丙酮酸钠", en:"Sodium pyruvate", f:"C3H3O3Na" },
  { g:"分析物 / 干扰物", n:"L-谷氨酸钠 一水", en:"MSG·H2O", f:"C5H8NO4Na·H2O" },
  { g:"分析物 / 干扰物", n:"L-谷氨酸", en:"L-Glutamic acid", f:"C5H9NO4" },
  { g:"分析物 / 干扰物", n:"尿酸", en:"Uric acid", f:"C5H4N4O3" },
  { g:"分析物 / 干扰物", n:"抗坏血酸 (VC)", en:"Ascorbic acid", f:"C6H8O6" },
  { g:"分析物 / 干扰物", n:"多巴胺 盐酸盐", en:"Dopamine·HCl", f:"C8H11NO2·HCl" },
  { g:"分析物 / 干扰物", n:"对乙酰氨基酚", en:"Acetaminophen", f:"C8H9NO2" },
  { g:"分析物 / 干扰物", n:"尿素", en:"Urea", f:"CH4N2O" },

  // 修饰材料 / 酶
  { g:"修饰材料 / 酶", n:"牛血清白蛋白", en:"BSA", f:null, note:"≈66.5 kDa，按 mg/mL 配，不走摩尔质量" },
  { g:"修饰材料 / 酶", n:"壳聚糖", en:"Chitosan", f:null, note:"聚合物，分子量按批次标，按 %(w/v) 配" },
  { g:"修饰材料 / 酶", n:"Nafion 5% 分散液", en:"Nafion", f:null, note:"按 %(w/v) 稀释，不走摩尔质量" },
  { g:"修饰材料 / 酶", n:"葡萄糖氧化酶", en:"GOx", f:null, note:"按活性 U/mg 配，不走摩尔质量" },
  { g:"修饰材料 / 酶", n:"乳酸氧化酶", en:"LOx", f:null, note:"按活性 U/mg 配，不走摩尔质量" }
];

/* ---------- 10. plain-text record formatting -----------------------------
   Records are what the user exports to their lab notebook. Alignment has to
   account for CJK glyphs being two columns wide in a monospace font,
   otherwise the columns shear apart in Notepad.                            */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s == null ? "" : s)) w += WIDE.test(ch) ? 2 : 1;
  return w;
}
function padTo(s, n) {
  s = String(s == null ? "" : s);
  const gap = n - dispWidth(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}
function rule(ch, n) { return ch.repeat(Math.max(0, n)); }

function stamp(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()) + " " +
         p(d.getHours()) + ":" + p(d.getMinutes());
}

/* Characters that must never begin a line (CJK 行首禁则). Breaking before a
   closing bracket or a full stop is what makes wrapped Chinese look broken. */
const NO_LINE_START = "。，、；：？！…·）】》」』〉｝”’%,.;:?!)]}>";
/** Wrap a long string at `cols` display columns, respecting 行首禁则. */
function wrapCols(t, cols) {
  const out = [];
  let cur = "";
  for (const ch of String(t)) {
    const over = cur && dispWidth(cur + ch) > cols;
    // let a forbidden-at-start char overhang rather than orphan it on the next line
    if (over && NO_LINE_START.indexOf(ch) < 0) { out.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) out.push(cur);
  // continuation lines never keep the space the break landed on
  return (out.length ? out : [""]).map((seg, i) => i ? seg.replace(/^ +/, "") : seg);
}

/* Why there is no column padding below.
   Aligning mixed CJK/Latin text with spaces requires the CJK advance width to
   be an exact integer multiple of the space width. Measured in this app's own
   font stack it is 1.667x (IBM Plex Mono advances 0.6em, the CJK fallback
   1.0em); Notepad's Consolas + YaHei pairing gives 1.818x. Neither is an
   integer, so no amount of padding can line the columns up -- and Word's
   proportional default makes it hopeless regardless. Delimiters survive every
   font, and "|" additionally lets the table paste into Excel via
   Data > Text to Columns.                                                   */
const CELL = "  |  ";

/** One record as plain text. `n` is its 1-based position in the export. */
function formatRecord(rec, n) {
  const L = [];
  L.push("[" + n + "] " + rec.module + "    " + stamp(rec.t));

  if (rec.inputs && rec.inputs.length) {
    L.push("");
    L.push("  输入");
    rec.inputs.forEach(r => L.push("    " + r[0] + "：" + r[1]));
  }
  if (rec.formula) {
    L.push("");
    L.push("  计算");
    L.push("    " + rec.formula);
    if (rec.formulaSubs) L.push("    " + rec.formulaSubs);
    if (rec.result) L.push("    = " + rec.result);
  } else if (rec.result) {
    L.push("");
    L.push("  结果：" + rec.result);
  }
  if (rec.table && rec.table.head && rec.table.rows && rec.table.rows.length) {
    L.push("");
    L.push("  " + (rec.tableTitle || "表格"));
    const cell = v => String(v == null ? "" : v).trim();
    L.push("    " + rec.table.head.map(cell).join(CELL));
    L.push("    " + rule("-", 46));
    rec.table.rows.forEach(r => L.push("    " + r.map(cell).join(CELL)));
  }
  if (rec.say) {
    L.push("");
    L.push("  说明");
    wrapCols(rec.say, 56).forEach(seg => L.push("    " + seg));
  }
  if (rec.notes && rec.notes.length) {
    L.push("");
    L.push("  提示");
    rec.notes.forEach(t => wrapCols(t, 56).forEach((seg, i) =>
      L.push("    " + (i === 0 ? "- " : "  ") + seg)));
  }
  return L.join("\n");
}

/** The whole export document. */
function formatRecords(recs, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const head = [
    rule("=", 58),
    "  配液台 · 实验记录",
    "  导出于 " + stamp(now) + "    共 " + recs.length + " 条",
    rule("=", 58),
    ""
  ];
  if (!recs.length) return head.concat(["  （还没有记录）", ""]).join("\n");
  const foot = [
    "",
    rule("-", 58),
    "表格用 | 分隔：不同字体下中英文宽度比不是整数，空格对齐必然错位；",
    "分隔符在任何字体下都成立，也能用 Excel 的「分列」按 | 拆开。",
    "",
    "摩尔质量按 IUPAC 2021 标准原子量。",
    "缓冲液配比为理论值（已含 Davies 活度校正），残余误差 ±0.1-0.2 pH，",
    "配好必须用 pH 计实测、用 HCl / NaOH 微调。浓酸稀释一律酸入水。",
    "由 配液台 生成  https://peiyetai.netlify.app"
  ];
  return head.concat([recs.map((r, i) => formatRecord(r, i + 1)).join("\n\n")])
             .concat(foot).join("\n");
}


/* ---------- 11. natural-language request parser --------------------------
   Spliced in from src/parser.js at assembly time (build.py and test.mjs both
   do it) so there is exactly one copy of the parser source.             */
/* @@PARSER@@ */

/* ---------- 9. exports ---------------------------------------------------- */
/** LLM params in, the same renderable answer out as the local path. */
function solveFromLLM(params) {
  const deps = {
    REAGENTS: REAGENTS, BUFFERS: BUFFERS, DIMS: DIMS, molarMass: molarMass,
    factorOf: factorOf, auto: auto, sig: sig, buffer: buffer, weighError: weighError
  };
  const plan = planFromLLM(params, deps);
  return plan.ok ? solveRequest(plan, deps) : plan;
}

/** One call: a sentence in, a renderable answer out. */
function askText(text) {
  return ask(text, {
    REAGENTS: REAGENTS, BUFFERS: BUFFERS, DIMS: DIMS, molarMass: molarMass,
    factorOf: factorOf, auto: auto, sig: sig, buffer: buffer,
    weighError: weighError
  });
}

return {
  ATOMIC, DIMS, REAGENTS, BUFFERS, F_CONST, RS_CONST, askText,
  parseFormula, molarMass,
  toBase, fromBase, factorOf, pickUnit, baseUnitName, sig, auto, allUnits,
  dilution, prep, moles, stockFromLiquid, weighBack, weighError,
  ladder, series,
  logGamma, speciate, buffer, predictPH,
  dispWidth, padTo, stamp, wrapCols, formatRecord, formatRecords,
  normalizeQuery, extractQuantities, matchReagents, interpret, solveRequest,
  planFromLLM, resolveUnit, solveFromLLM,
  electrodeArea, randlesSevcik, cottrell, coverage, chargeToMoles,
  currentDensity, detectionLimit
};
})();

if (typeof module !== "undefined" && module.exports) module.exports = CORE;

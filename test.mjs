import { readFileSync } from "node:fs";
// assemble exactly as build.py does, so the tests exercise the shipped code
const coreSrc = readFileSync(new URL("./src/core.js", import.meta.url), "utf8");
const parserSrc = readFileSync(new URL("./src/parser.js", import.meta.url), "utf8");
if (!coreSrc.includes("/* @@PARSER@@ */")) throw new Error("core.js 丢了 @@PARSER@@ 标记");
const src = coreSrc.replace("/* @@PARSER@@ */", parserSrc);
const CORE = new Function(src + "\nreturn CORE;")();

let pass = 0, fail = 0;
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
function ok(name, got, want, tol) {
  const good = typeof want === "number" ? near(got, want, tol ?? 2e-3) : got === want;
  if (good) { pass++; console.log(`  ok   ${name}  = ${typeof got === "number" ? got.toPrecision(6) : got}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want}`); }
}
function section(t) { console.log("\n" + t); }

const { dilution, prep, moles, stockFromLiquid, molarMass, auto, sig,
        electrodeArea, randlesSevcik, cottrell, coverage, chargeToMoles,
        detectionLimit, buffer, predictPH, speciate, logGamma, ladder,
        series, weighBack, weighError, toBase, fromBase, DIMS } = CORE;

/* ---- 1. the spreadsheet's own numbers (must reproduce exactly) ---------- */
section("1. 对齐原表格 计算表格.xlsx");
ok("稀释解 C₂ (mol/L)",  dilution({C1:0.4, V1:1e-5, V2:2e-4}, "C2").value, 0.02);
ok("  → mM",             fromBase(dilution({C1:0.4,V1:1e-5,V2:2e-4},"C2").value,"conc","mM"), 20);
ok("  → µM",             fromBase(dilution({C1:0.4,V1:1e-5,V2:2e-4},"C2").value,"conc","µM"), 20000);
ok("稀释解 V₁ (L)",      dilution({C1:11.75, V2:0.05, C2:0.008}, "V1").value, 3.40425531914894e-5);
ok("  → µL",             fromBase(dilution({C1:11.75,V2:0.05,C2:0.008},"V1").value,"volume","µL"), 34.0425531914894);
ok("稀释解 C₁ (mol/L)",  dilution({V1:0.003, V2:0.026, C2:0.1}, "C1").value, 0.866666666666667);
ok("稀释解 V₂ (L)",      dilution({V1:0.001, C1:9.79, C2:0.5}, "V2").value, 0.01958);
ok("  → mL",             fromBase(dilution({V1:0.001,C1:9.79,C2:0.5},"V2").value,"volume","mL"), 19.58);
ok("称量 m=M·C·V (g)",   prep({M:58.44, C:0.866666666667, V:0.05}, "m").value, 2.53240000000097);
ok("n = m/M (mol)",      moles({m:0.132, M:133.1}, "n").value, 0.000991735537190083);
ok("C = m/(M·V) (mol/L)",prep({m:0.264, M:133.1, V:0.02}, "C").value, 0.0991735537190083);
ok("浓硫酸 1000ρw/M",     stockFromLiquid({rho:1.84, w:0.98, M:98.078}).value, 18.3853667489141);

/* ---- 2. formula parser -------------------------------------------------- */
section("2. 化学式解析 / 摩尔质量");
const mm = f => molarMass(f).mass;
ok("NaCl",                mm("NaCl"), 58.44, 2e-4);
ok("K3[Fe(CN)6]",         mm("K3[Fe(CN)6]"), 329.25, 5e-4);
ok("CuSO4·5H2O",          mm("CuSO4·5H2O"), 249.68, 5e-4);
ok("Na2HPO4",             mm("Na2HPO4"), 141.96, 5e-4);
ok("KH2PO4",              mm("KH2PO4"), 136.08, 5e-4);
ok("K4[Fe(CN)6]·3H2O",    mm("K4[Fe(CN)6]·3H2O"), 422.39, 5e-4);
ok("H2SO4",               mm("H2SO4"), 98.07, 5e-4);
ok("C6H12O6 葡萄糖",       mm("C6H12O6"), 180.16, 5e-4);
ok("Na2HPO4·12H2O",       mm("Na2HPO4·12H2O"), 358.14, 5e-4);
ok("C2H3O2Na·3H2O 醋酸钠", mm("C2H3O2Na·3H2O"), 136.08, 5e-4);
ok("Ru(NH3)6Cl3",         mm("Ru(NH3)6Cl3"), 309.61, 1e-3);
// alternate hydrate spellings must agree
ok("CuSO4*5H2O 同值",     mm("CuSO4*5H2O"), mm("CuSO4·5H2O"), 1e-12);
ok("CuSO4.5H2O 同值",     mm("CuSO4.5H2O"), mm("CuSO4·5H2O"), 1e-12);
ok("CuSO4·5H₂O 下标",     mm("CuSO4·5H₂O"), mm("CuSO4·5H2O"), 1e-12);
ok("结晶水不被忽略",       mm("CuSO4·5H2O") > mm("CuSO4") + 89, true);
// error paths
const throws = f => { try { molarMass(f); return false; } catch { return true; } };
ok("Xx 未知元素报错",      throws("Xx2O"), true);
ok("括号不匹配报错",       throws("K3[Fe(CN)6"), true);

/* ---- 3. units ----------------------------------------------------------- */
section("3. 单位引擎");
ok("自动单位 3.404e-5 L", auto(3.40425531914894e-5, "volume").text, "34.04 µL");
ok("自动单位 0.02 mol/L", auto(0.02, "conc").text, "20 mM");
ok("自动单位 2.5324 g",   auto(2.53240000000097, "mass").text, "2.532 g");
ok("自动单位 9.917e-4 mol", auto(0.000991735537190083, "amount").text, "991.7 µmol");
ok("自动单位 0.5 L",      auto(0.5, "volume").text, "500 mL");
let roundTripFail = 0;
for (const dim of Object.keys(DIMS))
  for (const [u] of DIMS[dim].units)
    for (const v of [1, 7.3, 1234.5, 0.00042]) {
      const back = fromBase(toBase(v, dim, u), dim, u);
      if (Math.abs(back - v) / v > 1e-12) roundTripFail++;
    }
ok("全单位往返误差 < 1e-12", roundTripFail, 0);
ok("mg/mL = g/L",         toBase(1, "massconc", "mg/mL"), toBase(1, "massconc", "g/L"), 1e-12);
ok("µg/mL = mg/L",        toBase(1, "massconc", "µg/mL"), toBase(1, "massconc", "mg/L"), 1e-12);
ok("%(w/v) = 10 g/L",     toBase(1, "massconc", "%(w/v)"), 10, 1e-12);
ok("有效数字 sig(0.0991735,4)", sig(0.0991735537, 4), "0.09917");
// every dim's canonical unit must actually exist in its own list, and
// auto-formatting 0 must not fall back to a label that isn't selectable
let badBase = [], badZero = [];
for (const dim of Object.keys(DIMS)) {
  const bu = CORE.baseUnitName(dim);
  if (!DIMS[dim].units.some(u => u[0] === bu)) badBase.push(dim + ":" + bu);
  try { CORE.auto(0, dim); } catch (e) { badZero.push(dim + " → " + e.message); }
  try { fromBase(1, dim, CORE.pickUnit(0, dim)); } catch (e) { badZero.push(dim + " pickUnit(0)"); }
}
ok("每个量纲的基准单位都在列表里", badBase.join(",") || "none", "none");
ok("零值自动格式化不抛错", badZero.join(",") || "none", "none");
ok("conc 基准单位是 M 而非 mol/L", CORE.baseUnitName("conc"), "M");

/* ---- 4. electrochemistry ------------------------------------------------ */
section("4. 电化学");
const A3mm = electrodeArea("disc", { d: 0.3 }).value;      // Ø3 mm in cm
ok("Ø3 mm 圆盘面积 cm²",  A3mm, 0.0706858, 1e-4);
ok("矩形 2×5 mm",         electrodeArea("rect", { w:0.2, h:0.5 }).value, 0.1, 1e-12);
ok("环状 do4 di2 mm",     electrodeArea("ring", { dOut:0.4, dIn:0.2 }).value, Math.PI*(0.16-0.04)/4, 1e-12);
const ip = randlesSevcik({ n:1, A:A3mm, D:7.6e-6, C:5e-3, v:0.05 }, "ip").value;
ok("Randles-Ševčík iₚ (A)", ip, 5.863e-5, 3e-3);
ok("  → µA",              fromBase(ip, "current", "µA"), 58.63, 3e-3);
ok("  C 单位陷阱：非 58.6 mA", fromBase(ip, "current", "mA") < 1, true);
ok("RS 反解 D",           randlesSevcik({ n:1, A:A3mm, C:5e-3, v:0.05, ip }, "D").value, 7.6e-6, 1e-6);
ok("RS 反解 A",           randlesSevcik({ n:1, D:7.6e-6, C:5e-3, v:0.05, ip }, "A").value, A3mm, 1e-6);
ok("RS 反解 C (mol/L)",   randlesSevcik({ n:1, A:A3mm, D:7.6e-6, v:0.05, ip }, "C").value, 5e-3, 1e-6);
ok("Cottrell i(1s)",      cottrell({ n:1, A:A3mm, D:7.6e-6, C:5e-3, t:1 }).value,
                          1*96485.332*A3mm*Math.sqrt(7.6e-6)*5e-6/Math.sqrt(Math.PI), 1e-9);
ok("Γ = Q/nFA (mol/cm²)", coverage({ Q:1e-6, n:1, A:A3mm }).value, 1e-6/(96485.332*A3mm), 1e-9);
ok("  → pmol/cm²",        fromBase(coverage({Q:1e-6,n:1,A:A3mm}).value,"surfconc","pmol/cm²"), 146.6, 2e-3);
ok("n = Q/zF",            chargeToMoles({ Q:96485.332, z:1 }).value, 1, 1e-9);
ok("LOD = 3σ/S",          detectionLimit({ S:1e-3, sigma:2e-9 }).value, 6e-6, 1e-9);

/* ---- 5. buffers --------------------------------------------------------- */
section("5. 缓冲液 + Davies 活度校正");
ok("logγ(z=1, I=0.15)",  logGamma(1, 0.15), -0.1193, 5e-3);
ok("logγ(z=2, I=0.15)",  logGamma(2, 0.15), -0.4773, 5e-3);
// phosphate pKa2' at I = 0.15 should land near 6.84 (plan's derivation)
const spI = speciate(CORE.BUFFERS.phosphate_na, 7.4, 0.15, 25);
ok("磷酸盐 pKa₂' @I=0.15", spI.pKaApp[1], 6.84, 2e-3);
ok("理想 pKa₂ @I=0",       speciate(CORE.BUFFERS.phosphate_na, 7.4, 0, 25).pKaApp[1], 7.20, 1e-3);

// back-test: the standard 1× PBS recipe (Na2HPO4 1.44 g/L + KH2PO4 0.24 g/L
// + 137 mM NaCl + 2.7 mM KCl) measures ~7.4.
const cB = 1.44 / molarMass("Na2HPO4").mass;      // mol/L
const cA = 0.24 / molarMass("KH2PO4").mass;
ok("PBS 配方 Na₂HPO₄ mM", cB * 1000, 10.14, 3e-3);
ok("PBS 配方 KH₂PO₄ mM",  cA * 1000, 1.764, 3e-3);
ok("PBS 盐比值",          cB / cA, 5.75, 5e-3);
const naive = predictPH("phosphate_na", { cAcid:cA, cBase:cB, acidKey:"nah2po4",
  baseKey:"na2hpo4", addNaCl:0.137, addKCl:0.0027, davies:false });
const corr  = predictPH("phosphate_na", { cAcid:cA, cBase:cB, acidKey:"nah2po4",
  baseKey:"na2hpo4", addNaCl:0.137, addKCl:0.0027, davies:true });
console.log(`       裸 H-H → pH ${naive.pH.toFixed(2)}   Davies → pH ${corr.pH.toFixed(2)}   I = ${corr.I.toFixed(3)} M`);
ok("裸 H-H 预测 ≈ 7.96",   naive.pH, 7.96, 3e-3);
ok("Davies 预测 ≈ 7.59",   corr.pH, 7.59, 3e-3);
ok("Davies 把误差从 0.56 降到 ~0.19",
   Math.abs(corr.pH - 7.4) < Math.abs(naive.pH - 7.4) - 0.3, true);
ok("离子强度 ≈ 0.172 M",   corr.I, 0.172, 2e-2);

// recipe round-trip: buffer() masses must reproduce the requested pH
const rec = buffer({ system:"phosphate_na", pH:7.40, Ctotal:0.1, Vfinal:1,
                     acidKey:"nah2po4", baseKey:"na2hpo4", T:25 });
console.log(`       0.1 M pH 7.4 PBS/L → ${rec.items.map(i=>i.reagent.label+" "+sig(i.mass,4)+" g").join("  +  ")}  (I=${sig(rec.I,3)} M)`);
const rt = predictPH("phosphate_na", { cAcid:rec.items[0].conc, cBase:rec.items[1].conc,
  acidKey:"nah2po4", baseKey:"na2hpo4", davies:true });
ok("配方回代 pH 自洽",     rt.pH, 7.40, 2e-3);
ok("两盐浓度加和 = C_tot", rec.items[0].conc + rec.items[1].conc, 0.1, 1e-9);
ok("质量为正",             rec.items.every(i => i.mass > 0), true);

// Tris temperature coefficient: pKa 8.06 @25 °C → 7.72 @37 °C
const tris25 = speciate(CORE.BUFFERS.tris, 8, 0, 25).pKaApp[0];
const tris37 = speciate(CORE.BUFFERS.tris, 8, 0, 37).pKaApp[0];
ok("Tris pKa @25 °C",     tris25, 8.06, 1e-3);
ok("Tris pKa @37 °C",     tris37, 7.724, 2e-3);
ok("Tris 温度偏移 0.34",   tris25 - tris37, 0.336, 1e-2);
// acetate: 1→0 charge pair shifts the other way from phosphate
ok("醋酸 pKa' @I=0.15",   speciate(CORE.BUFFERS.acetate, 4.8, 0.15, 25).pKaApp[0], 4.641, 3e-3);
ok("Tris pKa' @I=0.15",   speciate(CORE.BUFFERS.tris, 8, 0.15, 25).pKaApp[0], 8.179, 3e-3);
// out-of-range pair must refuse rather than return a negative mass
let refused = false, refusedMsg = "";
try { buffer({ system:"acetate", pH:9.0, Ctotal:0.1, Vfinal:1,
               acidKey:"hac", baseKey:"naac_3h" }); }
catch (e) { refused = true; refusedMsg = e.message; }
ok("醋酸盐 @pH 9 被拒绝",  refused, true);
console.log("       拒绝信息：" + refusedMsg);
let refused2 = false;
try { buffer({ system:"tris", pH:5.0, Ctotal:0.1, Vfinal:1 }); } catch { refused2 = true; }
ok("Tris @pH 5 被拒绝",    refused2, true);
// ...but a pH just outside the pKa±1 core must still work, with a warning
const edge = buffer({ system:"acetate", pH:5.6, Ctotal:0.1, Vfinal:1 });
ok("醋酸盐 @pH 5.6 仍可配", edge.items.every(i => i.mass > 0), true);
// glacial acetic acid is pipetted, not weighed
ok("冰醋酸给出体积而非只给质量", edge.items[0].volume > 0, true);
ok("冰醋酸体积 = m/(ρ·w)",  edge.items[0].volume,
   edge.items[0].mass/(1.049*0.995)/1000, 1e-9);
// every system must produce a self-consistent recipe mid-range
for (const key of Object.keys(CORE.BUFFERS)) {
  const s = CORE.BUFFERS[key];
  const mid = (s.range[0] + s.range[1]) / 2;
  const r = buffer({ system:key, pH:mid, Ctotal:0.05, Vfinal:0.5 });
  const b = predictPH(key, { cAcid:r.items[0].conc, cBase:r.items[1].conc,
            acidKey:r.items[0].reagent.key, baseKey:r.items[1].reagent.key, davies:true });
  ok(`${s.name} pH ${mid} 回代`, b.pH, mid, 2e-3);
}

/* ---- 6. ladders & weigh-back ------------------------------------------- */
section("6. 梯度稀释 / 称量回算");
const lad = ladder({ Cstock:0.1, targets:[1e-3, 2e-3, 5e-3], Vfinal:0.01, mode:"direct" });
ok("直接稀释 5 mM 取 µL", fromBase(lad[0].Vtransfer, "volume", "µL"), 500, 1e-9);
ok("直接稀释 1 mM 取 µL", fromBase(lad[2].Vtransfer, "volume", "µL"), 100, 1e-9);
ok("补稀释液 = 终体积−取样", lad[0].Vdiluent, 0.01 - lad[0].Vtransfer, 1e-12);
const ser = ladder({ Cstock:0.1, targets:[1e-3, 1e-2], Vfinal:0.01, mode:"serial" });
ok("逐级：第1级 10 mM 取 µL", fromBase(ser[0].Vtransfer,"volume","µL"), 1000, 1e-9);
ok("逐级：第2级从第1级取",    ser[1].fromC, 1e-2, 1e-12);
ok("逐级：第2级 1 mM 取 µL",  fromBase(ser[1].Vtransfer,"volume","µL"), 1000, 1e-9);
ok("等比序列 6 点",        series({ lo:1e-4, hi:1e-2, n:6, kind:"log" }).length, 6);
ok("等比首尾",             series({ lo:1e-4, hi:1e-2, n:6, kind:"log" })[5], 1e-2, 1e-9);
ok("等差中点",             series({ lo:0, hi:10, n:3, kind:"linear" })[1], 5, 1e-9);
ok("等差可含 0 空白点",     series({ lo:0, hi:10, n:3, kind:"linear" })[0], 0, 1e-12);
let logZero = false;
try { series({ lo:0, hi:10, n:3, kind:"log" }); } catch { logZero = true; }
ok("等比拒绝 0 起点",       logZero, true);
const ladBlank = ladder({ Cstock:0.1, targets:[0, 1e-3, 5e-3], Vfinal:0.01, mode:"direct" });
ok("空白点保留为一行",      ladBlank.length, 3);
ok("空白点取样 0",          ladBlank[2].Vtransfer, 0, 1e-12);
ok("空白点全是稀释液",      ladBlank[2].Vdiluent, 0.01, 1e-12);
ok("空白点排在最后",        ladBlank[2].blank, true);
let overshoot = false;
try { ladder({ Cstock:1e-3, targets:[1e-2], Vfinal:0.01, mode:"direct" }); } catch { overshoot = true; }
ok("目标超过母液时报错",   overshoot, true);

const wb = weighBack({ M:58.44, m_actual:2.5400, V_target:0.05, C_target:0.866666666667 });
ok("回算实际浓度",         wb.C_actual, 2.54/(58.44*0.05), 1e-9);
ok("回算偏差 %",           wb.deviation, (2.54/2.53240000000097 - 1)*100, 2e-3);
ok("回算该定容到 (L)",     wb.V_needed, 2.54/(58.44*0.866666666667), 1e-9);
ok("天平 0.1 mg 在 10 mg 上 = 1 %", weighError(0.010, 0.1).relative, 1, 1e-9);
ok("天平 0.1 mg 在 1 mg 上 = 10 %", weighError(0.001, 0.1).relative, 10, 1e-9);

/* ---- 7. record formatting ---------------------------------------------- */
section("7. 实验记录文本格式");
const NL = String.fromCharCode(10);
const { dispWidth, padTo, formatRecord, formatRecords, wrapCols } = CORE;
ok("CJK 宽度 = 2",        dispWidth("配制"), 4, 1e-12);
ok("ASCII 宽度 = 1",      dispWidth("mM"), 2, 1e-12);
ok("混排宽度",            dispWidth("体积V"), 5, 1e-12);
ok("padTo 按显示宽度对齐", dispWidth(padTo("摩尔质量", 12)), 12, 1e-12);
ok("padTo 不截断超长",     padTo("摩尔质量ABC", 4), "摩尔质量ABC");
ok("wrapCols 不丢字符",
   wrapCols("甲乙丙丁戊己庚辛壬癸", 6).join("").length, 10, 1e-12);
// 行首禁则：标点不能被甩到下一行开头
const wrapped = wrapCols("定容到 50 mL 的话，真实浓度是 101.5 mM。", 18);
ok("wrapCols 标点不落行首",
   wrapped.slice(1).every(l => "。，、；：？！）".indexOf(l[0]) < 0), true);
ok("wrapCols 续行无前导空格",
   wrapped.slice(1).every(l => !/^ /.test(l)), true);
ok("wrapCols 内容无损",
   wrapped.join("").replace(/ /g, ""),
   "定容到50mL的话，真实浓度是101.5mM。");

const r1 = { t: new Date(2026,9,6,16,20).getTime(), module: "配制溶液 · 称取质量",
  inputs: [["摩尔质量 M","58.44 g/mol"],["目标浓度 C","10 mM"],["配制体积 V","50 mL"]],
  formula: "m = M · C · V", formulaSubs: "M 58.44 g/mol · C 10 mM · V 50 mL",
  result: "29.22 mg", say: "称 29.22 mg，溶解后定容到 50 mL。",
  notes: ["按 0.1 mg 分度值，称 29.22 mg 的相对误差约 0.34 %。"] };
const r2 = { t: new Date(2026,9,6,16,22).getTime(), module: "梯度稀释",
  tableTitle: "配制表",
  table: { head: ["#","目标浓度","取样体积","加稀释液"],
           rows: [["1","5 mM","500 µL","9.5 mL"],["2","1 mM","100 µL","9.9 mL"]] } };

const one = formatRecord(r1, 1);
ok("单条含模块名",   one.includes("[1] 配制溶液 · 称取质量"), true);
ok("单条含公式",     one.includes("m = M · C · V"), true);
ok("单条含结果",     one.includes("= 29.22 mg"), true);
ok("单条含提示",     one.includes("- 按 0.1 mg"), true);
ok("输入用冒号不用补空格", one.includes("摩尔质量 M：58.44 g/mol"), true);
// no run of 2+ spaces may appear inside an input line: that would be padding,
// which cannot align when CJK advance width is not an integer multiple
const inpLines2 = one.split(NL).filter(l => l.includes("："));
ok("输入块有 3 行",  inpLines2.length, 3, 1e-12);
ok("输入行无补齐空格",
   inpLines2.every(l => !/\S {2,}\S/.test(l)), true);

const tbl = formatRecord(r2, 2);
ok("表格含表头",     tbl.includes("目标浓度"), true);
ok("表格含数据行",   tbl.includes("500 µL"), true);
ok("表格用 | 分隔",  tbl.includes("1  |  5 mM  |  500 µL  |  9.5 mL"), true);
const tblRows = tbl.split(NL).filter(l => l.includes("|"));
ok("表头+2 数据行",  tblRows.length, 3, 1e-12);
ok("单元格无补齐空格",
   tblRows.every(l => l.split("|").every(c => !/\S {2,}\S/.test(c))), true);

const doc = formatRecords([r1, r2], new Date(2026,9,6,16,45).getTime());
ok("导出含标题",     doc.includes("配液台 · 实验记录"), true);
ok("导出含条数",     doc.includes("共 2 条"), true);
ok("导出含两条记录", doc.includes("[1] 配制溶液") && doc.includes("[2] 梯度稀释"), true);
ok("导出含安全声明", doc.includes("pH 计实测"), true);
ok("空记录不报错",   formatRecords([], Date.now()).includes("还没有记录"), true);

/* ---- 8. 自然语言解析 ---------------------------------------------------- */
section("8. 文字输入解析");
const A = t => CORE.askText(t);

// the user's own sentence, verbatim
const chi = A("配20ml的1%壳聚糖，在乙酸中，乙酸1%，壳聚糖 mol wt 50,000-190,000 Da");
ok("壳聚糖例子可解析",     chi.ok, true);
ok("  识别两个组分",       chi.items.length, 2, 1e-12);
ok("  壳聚糖 1% w/v→200mg", chi.items[0].amount, "200 mg");
ok("  乙酸 1% v/v→200µL",   chi.items[1].amount, "200 µL");
ok("  固体默认 w/v",        /按 <b>w\/v<\/b>/.test(chi.warnings.join("")), true);
ok("  液体默认 v/v",        /按 <b>v\/v<\/b>/.test(chi.warnings.join("")), true);
ok("  指出分子量不参与计算", /用不到摩尔质量/.test(chi.notes.join("")), true);

// %(w/v) is 1 g per 100 mL — check the arithmetic independently
ok("1% w/v 的 20 mL = 0.2 g", 1 / 100 * 20, 0.2, 1e-12);

const na = A("配 50 mL 10 mM NaCl");
ok("摩尔浓度例子",         na.ok, true);
ok("  NaCl 10 mM/50 mL",   na.items[0].amount, "29.22 mg");
ok("  自动查到摩尔质量",    /58\.4/.test(na.notes.join("")), true);

const fe = A("用K3[Fe(CN)6]配100mL 5mM");
ok("化学式直接识别",       fe.items[0].amount, "164.6 mg");

const dil = A("从 1 M 母液配 50 mL 10 mM，取多少");
ok("稀释例子",             dil.items[0].amount, "500 µL");
ok("  给出补液量",         /49\.5 mL/.test(dil.items[1].formula), true);

const buf = A("配 500 mL 0.1 M PBS pH 7.4");
ok("缓冲液例子",           buf.ok, true);
ok("  两种盐",             buf.items.length, 2, 1e-12);
ok("  NaH2PO4 1.212 g",    buf.items[0].amount, "1.212 g");
ok("  必须实测 pH 的警告",  /pH 计实测/.test(buf.warnings.join("")), true);

// refusing is a feature: these must NOT invent an answer
const vague = A("帮我配点东西");
ok("看不懂时不瞎猜",       vague.ok, false);
ok("  并说明怎么写",       /试试写成/.test(vague.missing.join("")), true);
const noVol = A("配 10 mM NaCl");
ok("缺体积时报缺",         noVol.ok, false);
ok("  点名缺体积",         /体积/.test(noVol.missing.join("")), true);
const polyMolar = A("配 20 mL 1 mM 壳聚糖，mol wt 50,000-190,000 Da");
ok("聚合物按摩尔浓度被拒绝", polyMolar.ok, false);
ok("  说明范围跨多少倍",    /倍/.test(polyMolar.missing.join("")), true);

// unit-case discipline: lower-case "mm" is millimetre, not millimolar
const mmLower = A("配 50 mL 10 mm NaCl");
ok("小写 mm 不当作 mM",    mmLower.ok, false);

// echo must report what was understood, so a misread is catchable
ok("回显体积",             chi.echo.体积[0], "20 mL");
ok("回显试剂",             chi.echo.识别到的试剂.join(","), "壳聚糖,冰醋酸");
ok("回显不出现负摩尔质量",  chi.echo.摩尔质量.every(x => !/^-/.test(x)), true);
ok("缓冲液回显 pH",         buf.echo.pH, "7.4");
ok("缓冲液回显体系",        buf.echo.缓冲体系, "磷酸盐 (Na)");

/* ---- 9. LLM 参数桥接 ----------------------------------------------------- */
section("9. AI 解析结果走同一套校验");
const L = p => CORE.solveFromLLM(p);

// the model reads the sentence; CORE still does every bit of the arithmetic
const lm = L({ intent:"molar", volume:{value:50,unit:"mL"},
               concentration:{value:10,unit:"mM"}, formula:"NaCl" });
ok("AI→摩尔路线可解",      lm.ok, true);
ok("  结果与本地一致",      lm.items[0].amount, "29.22 mg");

const lp = L({ intent:"percent", volume:{value:20,unit:"mL"},
  components:[{name:"壳聚糖",percent:1,basis:"w/v"},{name:"乙酸",percent:1,basis:"v/v"}] });
ok("AI→百分比路线",        lp.items.length, 2, 1e-12);
ok("  壳聚糖 200 mg",       lp.items[0].amount, "200 mg");
ok("  乙酸 200 µL",         lp.items[1].amount, "200 µL");

const lb = L({ intent:"buffer", volume:{value:500,unit:"mL"},
  concentration:{value:0.1,unit:"M"}, pH:7.4, bufferSystem:"phosphate_na" });
ok("AI→缓冲液路线",        lb.items[0].amount, "1.212 g");
ok("  仍带实测 pH 警告",    /pH 计实测/.test(lb.warnings.join("")), true);

// the safety refusals must survive the LLM path too
const lr = L({ intent:"molar", volume:{value:20,unit:"mL"},
  concentration:{value:1,unit:"mM"},
  molarMassRange:{lo:50000,hi:190000,unit:"Da"} });
ok("AI 给范围时同样被拒绝",  lr.ok, false);
ok("  说明差多少倍",        /3\.8 倍/.test(lr.missing.join("")), true);

const lu = L({ intent:"unknown", understood:"没看懂" });
ok("AI 说不懂就不算",       lu.ok, false);
const lmissing = L({ intent:"molar", concentration:{value:10,unit:"mM"}, formula:"NaCl" });
ok("AI 漏了体积也报缺",      lmissing.ok, false);
ok("  点名缺体积",          /体积/.test(lmissing.missing.join("")), true);

// unit spellings the model might emit
ok("resolveUnit 认 ml",     CORE.resolveUnit("ml", "volume", { DIMS: CORE.DIMS }), "mL");
ok("resolveUnit 认 uL",     CORE.resolveUnit("uL", "volume", { DIMS: CORE.DIMS }), "µL");
ok("resolveUnit 认 mol/L",  CORE.resolveUnit("mol/L", "conc", { DIMS: CORE.DIMS }), "M");
ok("resolveUnit 拒绝乱填",   CORE.resolveUnit("banana", "volume", { DIMS: CORE.DIMS }), null);

/* ---- summary ------------------------------------------------------------ */
console.log(`\n${"─".repeat(60)}\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

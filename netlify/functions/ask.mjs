/* Natural-language → structured parameters, via DeepSeek.

   The model is used ONLY to read the sentence. Every number it returns is fed
   back into the same tested CORE solver the local parser uses, so the
   arithmetic, the unit handling, and the safety refusals (molar-mass ranges,
   percent-basis defaults, pH warnings) stay deterministic. An LLM that is
   merely wrong about which field a number belongs to produces a visible
   mismatch in the echo; an LLM doing the arithmetic would produce a confident
   wrong mass with no way to catch it.

   The API key lives only in the Netlify environment, never in the repo or the
   page. */

const SYSTEM = `你是化学实验配液助手的解析器。把用户的中文或英文描述解析成 JSON 参数。

**只输出 JSON，不要任何解释文字，不要 markdown 代码块。**
**绝对不要做任何算术**——不要计算质量、体积、浓度。只抽取用户说出来的数字和单位。

JSON 结构（只填你能确定的字段，其余省略）：
{
  "intent": "percent" | "molar" | "dilute" | "buffer" | "massconc" | "unknown",
  "volume": {"value": 20, "unit": "mL"},
  "components": [{"name": "壳聚糖", "percent": 1, "basis": "w/v"}],
  "concentration": {"value": 10, "unit": "mM"},
  "stock": {"value": 1, "unit": "M"},
  "molarMass": {"value": 180.16, "unit": "g/mol"},
  "molarMassRange": {"lo": 50000, "hi": 190000, "unit": "Da"},
  "pH": 7.4,
  "bufferSystem": "phosphate_na",
  "formula": "NaCl",
  "understood": "一句话复述你的理解"
}

规则：
- intent 判断：出现百分比→percent；出现 pH 且提到缓冲液/PBS/Tris→buffer；
  提到母液/稀释/取多少→dilute；只有摩尔浓度→molar；mg/mL 这类→massconc。
- basis：固体默认 "w/v"，液体试剂（乙酸、盐酸等）默认 "v/v"，用户写明就按用户的。
- 单位原样保留用户写的（mL、µL、L、mM、µM、M、nM、g/mol、Da、kDa、mg/mL、g/L）。
- 用户给的是分子量**范围**（如 50,000-190,000 Da）时，填 molarMassRange，不要填 molarMass，
  也不要自己取中值或上下限。
- bufferSystem 只能是：phosphate_na, phosphate_k, tris, acetate, citrate, hepes, mes,
  carbonate, ammonia。
- formula 填用户给出的化学式（如 NaCl、K3[Fe(CN)6]），没给就省略。
- 完全看不懂就 {"intent":"unknown","understood":"..."}。`;

const MAX_INPUT = 500;

export default async (req) => {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8",
                 "cache-control": "no-store" }
    });

  if (req.method !== "POST") return json({ error: "只接受 POST" }, 405);

  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return json({ error: "服务端还没配置 DEEPSEEK_API_KEY" }, 503);

  let text;
  try {
    const body = await req.json();
    text = String(body && body.text || "").trim();
  } catch (e) {
    return json({ error: "请求体不是合法 JSON" }, 400);
  }
  if (!text) return json({ error: "没有收到文字" }, 400);
  if (text.length > MAX_INPUT)
    return json({ error: `描述太长（${text.length} 字），请压到 ${MAX_INPUT} 字以内` }, 413);

  let r;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json",
                 authorization: "Bearer " + key },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "system", content: SYSTEM },
                   { role: "user", content: text }],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 600
      })
    });
    clearTimeout(timer);
  } catch (e) {
    return json({ error: "调用 DeepSeek 失败：" + (e.name === "AbortError" ? "超时" : e.message) }, 502);
  }

  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    // never echo the key back, and keep upstream errors short
    return json({ error: `DeepSeek 返回 ${r.status}`, detail: detail.slice(0, 200) }, 502);
  }

  let parsed;
  try {
    const data = await r.json();
    const content = data && data.choices && data.choices[0] &&
                    data.choices[0].message && data.choices[0].message.content;
    if (!content) return json({ error: "DeepSeek 返回了空内容" }, 502);
    parsed = JSON.parse(stripFence(content));
  } catch (e) {
    return json({ error: "DeepSeek 返回的不是合法 JSON" }, 502);
  }

  return json({ ok: true, params: parsed });
};

/** The model is told not to use code fences, but strip them if it does. */
function stripFence(s) {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  return (m ? m[1] : s).trim();
}

export const config = { path: "/api/ask" };

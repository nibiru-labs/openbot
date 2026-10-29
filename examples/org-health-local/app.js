const $ = (selector) => document.querySelector(selector);
const safe = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const fmt = (value, digits = 2) =>
  value == null
    ? "数据未提供"
    : Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: digits });
const valueFor = (series, label) => series?.[label] ?? null;
function metricCard(title, unit, series, delta, options = {}) {
  const points = [
    ["2026-01实际", "01 实际", "actual"],
    ["2026-05H1参考", "05 H1 参考", "frozen"],
    ["2026-09实际", "09 实际", "actual"],
    [options.forecastKey || "年末测算", options.forecastLabel || "年末测算", "forecast"],
  ];
  // Three columns with May retained as an explicit unavailable anchor, and forecast visually separated.
  return `<article class="metric-card"><div class="metric-name">${title}</div><div class="metric-unit">${unit}</div><div class="metric-values">${points
    .map(([key, label, type]) => {
      const v = valueFor(series, key);
      const missing = v == null;
      return `<div><div class="metric-value-label">${label}</div><div class="metric-value ${type === "forecast" ? "forecast" : ""} ${missing ? "unavailable" : ""}">${missing ? "未提供" : safe(options.format ? options.format(v) : fmt(v, options.digits ?? 2))}</div></div>`;
    })
    .join("")}</div><div class="metric-delta ${options.warn ? "warn" : ""}">${delta}</div></article>`;
}
function render(data) {
  const expected = ["整体技术人力成本", "整体折算人头", "营收业务（含共享平台）技术人力成本与折算人头", "收入与成本率"];
  if (data.scope?.["schema版本"] !== 4 || expected.some((title, i) => data.metrics?.[i]?.["标题"] !== title)) {
    throw new Error("诊断数据结构或指标顺序已变化，请重新生成和核对页面。");
  }
  const scope = data.scope;
  $("#conclusion").textContent = data.conclusion;
  $("#asof-short").textContent = `数据截止 ${scope["数据截止"]}`;
  $("#scope-month").textContent = scope["观察月份"];
  $("#scope-date").textContent = scope["数据截止"];
  $("#scope-source").textContent = `${scope["来源"]} · schema v${scope["schema版本"]}`;
  $("#footer-source").textContent = `本机数据 · ${data.origin} · 不发送网络请求`;
  const m = data.metrics;
  const overallCost = m[0].数值;
  const overallHeads = m[1].数值;
  const revenueOps = m[2].数值;
  const revenue = m[3].数值["收入万美元每月"];
  const costRates = m[3].数值["整体技术人力成本率"];
  const revRates = m[3].数值["营收业务技术人力成本率"];
  const fullRates = m[3].数值["全口径技术成本率含运维设施"];
  const asPercent = (x) => (x == null ? null : safe(x));
  const difference = (series, digits = 2) => {
    const start = series["2026-01实际"],
      end = series["2026-09实际"];
    if (start == null || end == null) return "未提供";
    const change = Number(end) - Number(start);
    return `${change > 0 ? "+" : ""}${fmt(change, digits)}`;
  };
  const percentChange = (series) => {
    const start = series["2026-01实际"],
      end = series["2026-09实际"];
    if (start == null || end == null || !Number(start)) return "未提供";
    const change = (Number(end) / Number(start) - 1) * 100;
    return `${change > 0 ? "+" : ""}${fmt(change, 1)}%`;
  };
  $("#metric-grid").innerHTML = [
    metricCard(
      "整体技术人力成本",
      "万元 / 月 · 不含运维与设施",
      overallCost,
      `1—9 月变化 <strong>${difference(overallCost)} 万元 / 月 · ${percentChange(overallCost)}</strong>`,
      { digits: 1 },
    ),
    metricCard(
      "整体折算人头",
      "折算值 · 非自然人数",
      overallHeads,
      `1—9 月变化 <strong>${difference(overallHeads, 1)} · ${percentChange(overallHeads)}</strong>`,
      { digits: 1 },
    ),
    metricCard(
      "营收业务技术人力成本",
      "含共享平台 · 万元 / 月",
      revenueOps.成本,
      `1—9 月变化 <strong>${difference(revenueOps.成本)} 万元 / 月</strong>`,
      { digits: 1 },
    ),
    metricCard(
      "营收业务折算人头",
      "含共享平台 · 折算值",
      revenueOps.折算人头,
      `1—9 月变化 <strong>${difference(revenueOps.折算人头)}</strong>`,
      { digits: 1 },
    ),
    metricCard(
      "营收业务收入",
      "万美元 / 月",
      revenue,
      `9 月较 1 月 <strong>${percentChange(revenue)}</strong> · 年末为收入目标`,
      { digits: 0, forecastKey: "年末目标", forecastLabel: "年末目标" },
    ),
    metricCard(
      "整体技术人力成本率",
      "不含运维 / 设施 · 成本 ÷ 收入折人民币",
      costRates,
      `营收业务技术人力率 ${asPercent(revRates["2026-01实际"])} → ${asPercent(revRates["2026-09实际"])}；全口径整体率（含运维 / 设施）${asPercent(fullRates["整体2026-01实际"])} → ${asPercent(fullRates["整体2026-09实际"])}，分摊流程待确认。`,
      { format: asPercent, warn: true },
    ),
  ].join("");
  $("#insight-grid").innerHTML = data.insights
    .map((item) => {
      const type = String(item["类型"] ?? "");
      const tagClass = type.includes("推断")
        ? "inference"
        : type.includes("边界")
          ? "boundary"
          : type.includes("事实")
            ? "fact"
            : "inference";
      const label = type.includes("推断")
        ? "推断 · 待验证"
        : type.includes("边界")
          ? "事实与边界"
          : type.includes("事实")
            ? "事实"
            : "待核实";
      return `<article class="insight-card"><span class="tag ${tagClass}">${label}</span><h3>${safe(item["标题"])}</h3><p>${safe(item["内容"])}</p></article>`;
    })
    .join("");
  $("#definitions-grid").innerHTML = data.definitions
    .map(
      (text, index) =>
        `<div class="definition"><span class="definition-no">${String(index + 1).padStart(2, "0")}</span><p>${safe(text)}</p></div>`,
    )
    .join("");
  $("#risk-grid").innerHTML = data.risks
    .map(
      (item) =>
        `<article class="risk-card"><h3><span class="risk-mark">!</span>${safe(item["标题"])}</h3><p>${safe(item["内容"])}</p><span class="missing">待补证据</span></article>`,
    )
    .join("");
  $("#recommendations").innerHTML = data.recommendations
    .map(
      (item) =>
        `<article class="recommendation"><div><span class="priority ${safe(item["优先级"])}">${safe(item["优先级"])}</span></div><div><h3>${safe(item["标题"])}</h3><span class="rec-label">建议</span></div><div><span class="rec-label">依据与缺失</span><p>${safe(item["依据"])} ${safe(item["缺失证据"])}</p></div><div><span class="rec-label">核实方式</span><p>${safe(item["验证方式"])}</p></div></article>`,
    )
    .join("");
}
fetch("./data/diagnosis.json", { cache: "no-store" })
  .then((response) => {
    if (!response.ok) throw new Error("本地数据加载失败");
    return response.json();
  })
  .then(render)
  .catch((error) => {
    $("#conclusion").textContent = error.message || "无法加载本地诊断数据，请检查本机服务。";
  });

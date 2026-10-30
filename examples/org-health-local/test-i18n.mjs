import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const code = readFileSync(new URL("./app.bundle.js", import.meta.url), "utf8");
const fixture = JSON.parse(readFileSync(new URL("./data/diagnosis.json", import.meta.url), "utf8"));
async function check(locale, invalid) {
  const data = structuredClone(fixture);
  if (invalid) delete data.metrics[3].数值["收入万美元每月"]["年末目标"];
  const nodes = new Map();
  const node = (key) => {
    if (!nodes.has(key))
      nodes.set(key, {
        textContent: "",
        innerHTML: "",
        replaceChildren() {
          this.innerHTML = "";
        },
      });
    return nodes.get(key);
  };
  const document = {
    documentElement: {},
    querySelector: (s) => node(s.slice(1)),
    querySelectorAll: () => [],
    getElementById: node,
  };
  runInNewContext(code, {
    document,
    location: { search: `?lang=${locale}` },
    URLSearchParams,
    fetch: async () => ({ ok: true, json: async () => data }),
    console,
    setTimeout,
    clearTimeout,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const failed = node("asof-short").textContent === (locale === "zh" ? "加载失败" : "Loading failed");
  const expected = locale === "zh" ? "整体技术人力成本" : "Total technical labor cost";
  if (
    failed !== invalid ||
    (invalid
      ? node("scope-month").textContent !== "—" || node("metric-grid").innerHTML
      : !node("metric-grid").innerHTML.includes(expected))
  )
    throw new Error(`${locale}: ${invalid ? "invalid" : "valid"} fixture failed`);
  console.log(`${locale} ${invalid ? "invalid" : "valid"}: pass`);
}
for (const locale of ["zh", "en", "fr"]) {
  await check(locale, false);
  await check(locale, true);
}

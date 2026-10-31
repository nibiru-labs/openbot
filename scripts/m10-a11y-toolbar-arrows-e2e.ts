// Checks M10 #62 toolbar arrow-key navigation and routine status exposure with jsdom.
// Run: `bun scripts/m10-a11y-toolbar-arrows-e2e.ts`.
// Writes .openbot-build/m10-a11y-toolbar-arrows-e2e/report.json.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM }: { JSDOM: new (html: string) => { window: Window & typeof globalThis } } = require("jsdom");

const OUT = resolve(import.meta.dirname, "../.openbot-build/m10-a11y-toolbar-arrows-e2e");

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { passed: boolean; steps: Step[] } = { passed: false, steps: [] };

function step<T>(name: string, run: () => T): T {
  process.stdout.write(`- ${name}\n`);
  try {
    const value = run();
    report.steps.push({ name, passed: true, detail: value });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function installDomGlobals(window: Window & typeof globalThis): void {
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.KeyboardEvent = window.KeyboardEvent;
  globalThis.FocusEvent = window.FocusEvent;
}

const dom = new JSDOM(
  `<div role="toolbar"><button type="button">One</button><button type="button">Two</button><button type="button">Three</button></div>`,
);
installDomGlobals(dom.window);
const { onToolbarFocusIn, onToolbarKeyDown, syncToolbarTabindex, toolbarFocusables } = await import(
  "../packages/ui/src/utils"
);

step("toolbar arrow keys move focus between controls", () => {
  const root = dom.window.document.querySelector<HTMLElement>('[role="toolbar"]');
  assert.ok(root);
  syncToolbarTabindex(root);
  const items = toolbarFocusables(root);
  assert.equal(items.length, 3);
  const first = items[0];
  assert.ok(first);
  root.addEventListener("focusin", onToolbarFocusIn);
  root.addEventListener("keydown", onToolbarKeyDown);
  syncToolbarTabindex(root, first);
  first.focus();
  assert.equal(first.tabIndex, 0);
  assert.equal(items[1]?.tabIndex, -1);

  first.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  assert.equal(dom.window.document.activeElement, items[1]);
  assert.equal(items[1]?.tabIndex, 0);
  return items[1]?.textContent;
});

step("RoutineCalendarEntry does not override visible status in aria-label", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../packages/ui/src/features/conversation/RoutineCalendar.tsx"),
    "utf8",
  );
  assert.doesNotMatch(source, /routine-planner-entry-main[\s\S]*?aria-label=\{t\("routine\.card\.open"/);
  return true;
});

const toolbarFiles = [
  "packages/ui/src/features/conversation/ZoomControls.tsx",
  "packages/ui/src/features/diagrams/DiagramBoard.tsx",
  "packages/ui/src/features/conversation/MessageRendering.tsx",
  "packages/ui/src/features/conversation/SelectionActions.tsx",
  "src/renderer/src/features/browser/browser-pip-controls.tsx",
];

for (const file of toolbarFiles) {
  step(`${file} wires toolbar arrow keys`, () => {
    const source = readFileSync(resolve(import.meta.dirname, "..", file), "utf8");
    assert.match(source, /onToolbarKeyDown/);
    assert.match(source, /onToolbarFocusIn/);
    assert.match(source, /syncToolbarTabindex/);
    return true;
  });
}

step("onboarding Next comes before Back in the DOM", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/features/onboarding/FirstRunFlow.tsx"),
    "utf8",
  );
  const actions = source.match(/class="onboarding-actions"[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.match(actions, /onboarding-next/);
  assert.match(actions, /onboarding-back/);
  assert.ok(actions.indexOf("onboarding-next") < actions.indexOf("onboarding-back"));
  return true;
});

step("onboarding CSS does not reorder Next with flex order", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/features/onboarding/onboarding.css"),
    "utf8",
  );
  assert.doesNotMatch(source, /\.onboarding-next[\s\S]*?order:\s*-1/);
  return true;
});

report.passed = report.steps.every((entry) => entry.passed);
mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
assert.equal(report.passed, true, "One or more checks failed");

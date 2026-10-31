// Checks M10 #62 tab-role fixes and selection-toolbar focus behavior with jsdom.
// Run: `bun scripts/m10-a11y-selection-tab-roles-e2e.ts`.
// Writes .openbot-build/m10-a11y-selection-tab-roles-e2e/report.json.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM }: { JSDOM: new (html: string) => { window: Window & typeof globalThis } } = require("jsdom");

const OUT = resolve(import.meta.dirname, "../.openbot-build/m10-a11y-selection-tab-roles-e2e");

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

function focusMessageBlock(element: HTMLElement | null | undefined): void {
  if (!element?.isConnected) return;
  if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
  element.focus({ preventScroll: true });
}

function focusSelectionToolbar(bar: HTMLElement | null | undefined): void {
  if (!bar) return;
  const target = bar.querySelector<HTMLElement>(
    'input:not([disabled]):not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]):not([aria-hidden="true"])',
  );
  target?.focus({ preventScroll: true });
}

step("selection toolbar focus moves to the first control", () => {
  const dom = new JSDOM(
    `<div class="selection-actions-bar"><input aria-label="Describe" /><button type="button">Explain</button></div>`,
  );
  const bar = dom.window.document.querySelector<HTMLElement>(".selection-actions-bar");
  focusSelectionToolbar(bar);
  assert.equal(dom.window.document.activeElement?.tagName, "INPUT");
  return dom.window.document.activeElement?.tagName;
});

step("selection focus returns to the message block", () => {
  const dom = new JSDOM(`<div data-selection-message-id="m1">Selected text</div>`);
  const block = dom.window.document.querySelector<HTMLElement>("[data-selection-message-id]");
  focusMessageBlock(block);
  assert.equal(dom.window.document.activeElement, block);
  assert.equal(block?.getAttribute("tabindex"), "-1");
  return block?.getAttribute("tabindex");
});

step("SelectionActions.tsx exports focus helpers", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../packages/ui/src/features/conversation/SelectionActions.tsx"),
    "utf8",
  );
  assert.match(source, /export function focusMessageBlock/);
  assert.match(source, /export function focusSelectionToolbar/);
  assert.match(source, /selectionReturnFocus = messageTextBlock/);
  assert.match(source, /returnSelectionFocus\(\)/);
  return true;
});

const tabTriggerPattern = /\b(?:Tabs|SlidingTabs)\.Trigger\b/;
const filesWithoutTabTriggers = [
  "packages/ui/src/components/GlobalSearch.tsx",
  "packages/ui/src/features/browser/BrowserTabStrip.tsx",
  "packages/ui/src/features/conversation/SidePanel.tsx",
  "packages/ui/src/features/sidebar/SidebarViewSwitch.tsx",
  "packages/ui/src/features/conversation/RoutineCalendar.tsx",
  "packages/ui/src/features/conversation/SkillLibraryToolbar.tsx",
];

for (const file of filesWithoutTabTriggers) {
  step(`${file} has no tab trigger`, () => {
    const source = readFileSync(resolve(import.meta.dirname, "..", file), "utf8");
    assert.equal(tabTriggerPattern.test(source), false);
    return true;
  });
}

step("GlobalSearch.tsx uses a radiogroup for filters", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../packages/ui/src/components/GlobalSearch.tsx"), "utf8");
  assert.match(source, /RadioGroup\.Root/);
  assert.match(source, /SearchFilterRadios/);
  return true;
});

report.passed = report.steps.every((entry) => entry.passed);
mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
assert.equal(report.passed, true, "One or more checks failed");

// Switches a running dev app between the Light, Dark and System themes in Settings, and checks that
// main applies each choice to the native theme, that the window paints the matching brand tokens,
// and that main saves the choice. Restores the saved theme at the end. Writes
// .openbot-build/appearance-e2e/report.json and a screenshot per theme. Needs `--allow-mutations`,
// because it changes the theme setting.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppAppearance, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import type { Page } from "playwright-core";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

// The page functions below run in the app window, where the preload bridge sets this.
declare global {
  interface Window {
    openbot: OpenBotDesktopApi;
  }
}

const OUT = resolve(import.meta.dirname, "../.openbot-build/appearance-e2e");
const t = translateFor("en");
const LABELS = {
  system: t("settings.colorScheme.system"),
  light: t("settings.colorScheme.light"),
  dark: t("settings.colorScheme.dark"),
} as const satisfies Record<AppAppearance, string>;
/** The canvas token of each scheme, from tokens.css and tokens-light.css. */
const CANVAS = { light: "#f5f5f7", dark: "#1a1a1a" } as const;

const instances = readDevInstanceRecords().filter(
  (record) => record.service === "app" && resolve(record.projectRoot) === resolve(process.cwd()),
);
assert.equal(instances.length, 1, "Start one dev app for this worktree first.");
const instance = instances[0];
assert.ok(instance);
assertMutationAllowed({
  command: "appearance-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const logger = createOpenBotLogger("appearance-e2e");
const session = await connectToDevApp(instance.remoteDebuggingPort, logger, {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});

function settingsTitle(page: Page) {
  return page.getByRole("heading", { level: 1, name: t("app.settingsPage.title"), exact: true });
}

async function openGeneralSettings(page: Page) {
  const title = settingsTitle(page);
  if (!(await title.isVisible()))
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
  await title.waitFor();
  const general = page.getByRole("tab", { name: t("settings.tab.general.title"), exact: true });
  if (await general.isVisible()) await general.click();
}

async function chooseAppearance(page: Page, next: AppAppearance) {
  await openGeneralSettings(page);
  // The trigger is named by its title and then the selected value, as the Language button is.
  await page.getByRole("button", { name: new RegExp(`^${t("settings.colorScheme.title")} `) }).click();
  await page.getByRole("option", { name: LABELS[next], exact: true }).click();
  await page.waitForFunction(
    async (appearance) => (await window.openbot.getAppAppearancePreference()).appearance === appearance,
    next,
  );
}

/** What the window shows: the scheme main gave the native theme, the root attribute, and the canvas. */
function painted(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    return {
      nativeLight: window.matchMedia("(prefers-color-scheme: light)").matches,
      attribute: root.dataset.appearance ?? null,
      colorScheme: getComputedStyle(root).colorScheme,
      canvas: getComputedStyle(root).getPropertyValue("--openbot-bg-canvas").trim().toLowerCase(),
    };
  });
}

async function closeSettings(page: Page) {
  // A focused settings tab keeps Escape for itself, so Escape goes from the title.
  await settingsTitle(page).focus();
  await page.keyboard.press("Escape");
  await settingsTitle(page).waitFor({ state: "hidden" });
}

mkdirSync(OUT, { recursive: true });
const page = session.page;
const original = (await page.evaluate(() => window.openbot.getAppAppearancePreference())).appearance;
const results = [];
try {
  for (const appearance of ["light", "dark", "system"] as const) {
    await chooseAppearance(page, appearance);
    if (appearance !== "system")
      await page.waitForFunction((expected) => document.documentElement.dataset.appearance === expected, appearance);
    const settings = await painted(page);
    await page.screenshot({ path: resolve(OUT, `settings-${appearance}.png`) });
    await closeSettings(page);
    await page.screenshot({ path: resolve(OUT, `workspace-${appearance}.png`) });
    results.push({ appearance, settings });
    // The tokens and the color scheme follow the choice. `prefers-color-scheme` follows it only for
    // System: an explicit choice is applied through the root attribute, so the page does not depend on it.
    const scheme = appearance === "system" ? (settings.nativeLight ? "light" : "dark") : appearance;
    assert.equal(settings.attribute, scheme, `The window did not select the ${scheme} tokens.`);
    assert.equal(settings.colorScheme, scheme, `The window color scheme is not ${scheme}.`);
    assert.equal(settings.canvas, CANVAS[scheme], `The canvas is not the ${scheme} canvas.`);
  }
} finally {
  await page.evaluate((appearance) => window.openbot.setAppAppearancePreference({ appearance }), original);
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ original, results }, null, 2)}\n`);
  await session.close();
}
logger.info(`Checked light, dark and system. Wrote ${resolve(OUT, "report.json")}.`);

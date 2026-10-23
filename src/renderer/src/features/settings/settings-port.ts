import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * What the settings context reaches in main: the app-wide preferences and the switches for
 * updates, notifications and the Dynamic Island.
 */
export interface SettingsPort {
  getAgentMemoryLimitPreference: OpenBotDesktopApi["getAgentMemoryLimitPreference"];
  getAnalyticsPreference: OpenBotDesktopApi["getAnalyticsPreference"];
  getAppBehaviorPreference: OpenBotDesktopApi["getAppBehaviorPreference"];
  getApprovalAutomation: OpenBotDesktopApi["getApprovalAutomation"];
  getBusyMessageModePreference: OpenBotDesktopApi["getBusyMessageModePreference"];
  getLocalScriptsNewAgentPreference: OpenBotDesktopApi["getLocalScriptsNewAgentPreference"];
  getRemoteSessionReusePreference: OpenBotDesktopApi["getRemoteSessionReusePreference"];
  onAgentMemoryLimitPreference: OpenBotDesktopApi["onAgentMemoryLimitPreference"];
  onApprovalAutomation: OpenBotDesktopApi["onApprovalAutomation"];
  onOpenSettings: OpenBotDesktopApi["onOpenSettings"];
  setAnalyticsPreference: OpenBotDesktopApi["setAnalyticsPreference"];
  setAppBehaviorPreference: OpenBotDesktopApi["setAppBehaviorPreference"];
  setBusyMessageModePreference: OpenBotDesktopApi["setBusyMessageModePreference"];
  setLocalScriptsNewAgentPreference: OpenBotDesktopApi["setLocalScriptsNewAgentPreference"];
  setRemoteSessionReusePreference: OpenBotDesktopApi["setRemoteSessionReusePreference"];
  dynamicIsland: Pick<
    OpenBotDesktopApi["dynamicIsland"],
    "getBuiltInDisplayGeometry" | "getPreference" | "setPreference"
  >;
  notifications: Pick<OpenBotDesktopApi["notifications"], "getPreference" | "openSettings" | "setPreference" | "test">;
  update: Pick<OpenBotDesktopApi["update"], "getPreference" | "onPreference" | "setPreference">;
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function settingsPort(): SettingsPort {
  return window.openbot;
}

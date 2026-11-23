import { createContext, useContext } from "react";

export type AppLanguage = "en" | "zh";
export type DebugBotView = "chat" | "diagnostics" | "settings";

export interface AppShellContextValue {
  language: AppLanguage;
  setLanguage: (lang: AppLanguage) => void;
  debugBotView: DebugBotView;
  setDebugBotView: (view: DebugBotView) => void;
  dbHealthy: boolean | null;
}

export const AppShellContext = createContext<AppShellContextValue>({
  language: "en",
  setLanguage: () => undefined,
  debugBotView: "chat",
  setDebugBotView: () => undefined,
  dbHealthy: null,
});

export function useAppShell() {
  return useContext(AppShellContext);
}

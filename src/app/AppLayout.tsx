import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import brandIcon from "../assets/brand-icon.png";
import {
  AppShellContext,
  type AppLanguage,
  type DebugBotView,
} from "./appShellContext";

type Asset = "MIP" | "ENI" | "MIE";

const downloadsUrl =
  "https://www.festo.com/de/en/p/ax-motion-insights-pneumatic-id_GASA_MIP/?tab=SUPPORT_PORTAL&documentTypeGroup=EXPERT_KNOWLEDGE&supportPortalTab=18";

function DatabaseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
    </svg>
  );
}

function BotIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="8" width="18" height="12" rx="3" />
      <path d="M12 8V4H8" />
      <circle cx="9" cy="14" r="1" fill="currentColor" />
      <circle cx="15" cy="14" r="1" fill="currentColor" />
    </svg>
  );
}

export function UnifiedAppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [debugBotView, setDebugBotView] = useState<DebugBotView>("chat");
  const [dbHealthy, setDbHealthy] = useState<boolean | null>(null);
  const [language, setLanguageState] = useState<AppLanguage>(() => {
    try {
      const saved = localStorage.getItem("festo-language");
      if (saved === "zh" || saved === "en") return saved;
    } catch {
      // Ignore storage access errors.
    }
    return "en";
  });

  const zh = language === "zh";
  const isDebugBot = pathname === "/debug-bot";

  const setLanguage = (next: AppLanguage) => {
    setLanguageState(next);
    try {
      localStorage.setItem("festo-language", next);
    } catch {
      // Ignore storage access errors.
    }
  };

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.title = isDebugBot ? "Connector · Debug Bot" : "Connector";
  }, [language, isDebugBot]);

  useEffect(() => {
    let cancelled = false;
    async function checkHealth() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          database?: boolean;
        } | null;
        if (!cancelled) setDbHealthy(Boolean(res.ok && data?.database));
      } catch {
        if (!cancelled) setDbHealthy(false);
      }
    }
    void checkHealth();
    const timer = window.setInterval(() => void checkHealth(), 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const currentConnectorGroup =
    pathname === "/import"
      ? "Import"
      : pathname === "/mqtt"
        ? "MQTT"
        : pathname.startsWith("/add") ||
            ["/siemens", "/rockwell", "/opcua", "/beckhoff", "/modbus"].includes(pathname)
          ? "Add"
          : "Status";

  return (
    <AppShellContext.Provider
      value={{ language, setLanguage, debugBotView, setDebugBotView, dbHealthy }}
    >
      <div className="unified-app-shell">
        {/* Unified Top Application Bar */}
        <header className="unified-topbar">
          <div className="unified-topbar-inner">
            <div className="unified-brand-area">
              <button
                type="button"
                className="unified-brand-button"
                aria-label="Connector Home"
                onClick={() => navigate("/dashboard")}
              >
                <span className="unified-brand-mark">
                  <img src={brandIcon} alt="Connector logo" className="brand-icon" />
                </span>
                <span className="unified-brand-title">
                  <strong>Connector</strong>
                </span>
              </button>
            </div>

            {/* Center Contextual Module Navigation Pill Bar */}
            <nav
              className="unified-topbar-nav"
              aria-label={zh ? "当前模块导航" : "Module navigation"}
            >
              {!isDebugBot ? (
                <>
                  {(
                    [
                      ["/dashboard", zh ? "连接状态" : "Status", "Status"],
                      ["/add", zh ? "添加 PLC" : "Add PLC", "Add"],
                      ["/mqtt", zh ? "MQTT 配置" : "MQTT Broker", "MQTT"],
                      ["/import", zh ? "导入配置" : "Import", "Import"],
                    ] as const
                  ).map(([path, label, group]) => (
                    <button
                      key={path}
                      type="button"
                      className={`unified-topbar-nav-item ${currentConnectorGroup === group ? "is-active" : ""}`}
                      onClick={() => navigate(path)}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="unified-topbar-nav-item"
                    onClick={() => window.open(downloadsUrl, "_blank", "noopener,noreferrer")}
                  >
                    {zh ? "资料下载 ↗" : "Downloads ↗"}
                  </button>
                </>
              ) : (
                (
                  [
                    ["chat", zh ? "对话诊断" : "Chat"],
                    ["diagnostics", zh ? "实时巡检" : "Quick Diagnostics"],
                    ["settings", zh ? "模型配置" : "Model Settings"],
                  ] as const
                ).map(([view, label]) => (
                  <button
                    key={view}
                    type="button"
                    className={`unified-topbar-nav-item ${debugBotView === view ? "is-active" : ""}`}
                    onClick={() => setDebugBotView(view)}
                  >
                    {label}
                  </button>
                ))
              )}
            </nav>

            <div className="unified-topbar-right">
              <span
                className={`unified-db-badge ${dbHealthy ? "is-healthy" : ""}`}
                title={
                  dbHealthy
                    ? zh
                      ? "PostgreSQL 数据库与后端服务运行正常"
                      : "PostgreSQL database and backend are online"
                    : zh
                      ? "PostgreSQL 数据库未就绪"
                      : "PostgreSQL database unavailable"
                }
              >
                <DatabaseIcon size={13} />
                <span>
                  {dbHealthy
                    ? zh
                      ? "PostgreSQL 已就绪"
                      : "PostgreSQL Ready"
                    : zh
                      ? "PostgreSQL 待机"
                      : "PostgreSQL Standby"}
                </span>
              </span>

              <div className="unified-lang-switch" role="group" aria-label="Language / 语言">
                <button
                  type="button"
                  className={`unified-lang-btn ${language === "en" ? "is-active" : ""}`}
                  onClick={() => setLanguage("en")}
                >
                  EN
                </button>
                <button
                  type="button"
                  className={`unified-lang-btn ${language === "zh" ? "is-active" : ""}`}
                  onClick={() => setLanguage("zh")}
                >
                  中文
                </button>
              </div>

              <span className="unified-topbar-divider" aria-hidden="true" />

              <button
                type="button"
                className={`unified-agent-trigger ${isDebugBot ? "is-active" : ""}`}
                aria-pressed={isDebugBot}
                onClick={() => navigate(isDebugBot ? "/dashboard" : "/debug-bot")}
              >
                <BotIcon size={16} />
                <span>Debug Bot</span>
              </button>
            </div>
          </div>
        </header>

        {/* Active Module View */}
        <div className="unified-module-section" key={isDebugBot ? "debug-bot" : "connector"}>
          {children}
        </div>

        {/* Unified Application Footer */}
        <footer className="unified-app-footer">
          <div className="unified-app-footer-links">
            <span>Version 24.0.6</span>
            <a href={downloadsUrl} target="_blank" rel="noreferrer">
              {zh ? "Festo 技术支持 ↗" : "Support Portal ↗"}
            </a>
          </div>
        </footer>
      </div>
    </AppShellContext.Provider>
  );
}

export function AppHeader(props: {
  asset?: Asset;
  onAssetChange?: (asset: Asset) => void;
}) {
  void props;
  return null;
}

export function AppFooter(props: { onVersionClick?: () => void }) {
  void props;
  return null;
}

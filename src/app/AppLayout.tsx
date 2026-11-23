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

function CpuIcon({ size = 19 }: { size?: number }) {
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
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
    </svg>
  );
}

function CloseIcon({ size = 18 }: { size?: number }) {
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
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function UnifiedAppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
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

  useEffect(() => {
    if (!sidebarOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sidebarOpen]);

  const currentConnectorGroup =
    pathname === "/import"
      ? "Import"
      : pathname === "/mqtt"
        ? "MQTT"
        : pathname.startsWith("/add") ||
            ["/siemens", "/rockwell", "/opcua", "/beckhoff", "/modbus"].includes(pathname)
          ? "Add"
          : "Status";

  const openModule = (target: "connector" | "debug-bot") => {
    setSidebarOpen(false);
    navigate(target === "debug-bot" ? "/debug-bot" : "/dashboard");
  };

  return (
    <AppShellContext.Provider
      value={{ language, setLanguage, debugBotView, setDebugBotView, dbHealthy }}
    >
      <div className="unified-app-shell">
        {/* Slide-out Workspace Switcher Sidebar Drawer */}
        <div
          className={`unified-sidebar-backdrop ${sidebarOpen ? "is-open" : ""}`}
          aria-hidden={!sidebarOpen}
          onClick={() => setSidebarOpen(false)}
        />
        <aside
          className={`unified-sidebar ${sidebarOpen ? "is-open" : ""}`}
          aria-label={zh ? "应用模块切换侧边栏" : "Application switcher sidebar"}
          aria-hidden={!sidebarOpen}
        >
          <div className="unified-sidebar-header">
            <div className="unified-sidebar-brand">
              <img src={brandIcon} alt="Connector" className="brand-icon" />
              <div>
                <strong className="unified-sidebar-title">Connector</strong>
                <span className="unified-sidebar-subtitle">
                  {zh ? "选择工作区模块" : "Workspace Modules"}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="unified-sidebar-close"
              aria-label={zh ? "关闭侧边栏" : "Close sidebar"}
              onClick={() => setSidebarOpen(false)}
            >
              <CloseIcon size={18} />
            </button>
          </div>

          <nav
            className="unified-sidebar-nav"
            aria-label={zh ? "应用模块导航" : "Application modules"}
          >
            <div className="unified-sidebar-section-label">
              {zh ? "应用模块" : "APPLICATIONS"}
            </div>
            {(
              [
                {
                  id: "connector" as const,
                  title: "Connector",
                  subtitle: zh
                    ? "Modbus / S7 / OPC UA 采集与 MQTT 发布"
                    : "Modbus / S7 / OPC UA & MQTT Publisher",
                  icon: <CpuIcon size={19} />,
                  selected: !isDebugBot,
                },
                {
                  id: "debug-bot" as const,
                  title: "Debug Bot",
                  subtitle: zh
                    ? "AI 诊断对话、66 气缸分析与 MQTT 实时巡检"
                    : "AI Diagnostics, 66-Cylinder & Live MQTT Checks",
                  icon: <BotIcon size={19} />,
                  selected: isDebugBot,
                },
              ] as const
            ).map((item, idx) => (
              <button
                key={item.id}
                type="button"
                style={{ transitionDelay: sidebarOpen ? `${idx * 40}ms` : "0ms" }}
                className={`unified-sidebar-item ${item.selected ? "is-selected" : ""}`}
                onClick={() => openModule(item.id)}
              >
                <span className="unified-sidebar-item-icon">{item.icon}</span>
                <span className="unified-sidebar-item-text">
                  <strong>{item.title}</strong>
                  <small>{item.subtitle}</small>
                </span>
                <span className="unified-sidebar-item-check" aria-hidden="true">
                  ✓
                </span>
              </button>
            ))}
          </nav>

          <div className="unified-sidebar-footer">
            <div className={`unified-sidebar-db ${dbHealthy ? "is-healthy" : ""}`}>
              <DatabaseIcon size={15} />
              <span>
                {dbHealthy
                  ? zh
                    ? "PostgreSQL 数据库在线"
                    : "PostgreSQL Online"
                  : zh
                    ? "PostgreSQL 待机中"
                    : "PostgreSQL Standby"}
              </span>
            </div>
          </div>
        </aside>

        {/* Unified Top Application Bar */}
        <header className="unified-topbar">
          <div className="unified-topbar-inner">
            <div className="unified-brand-area">
              <button
                className={`project-switcher-trigger ${sidebarOpen ? "is-open" : ""}`}
                type="button"
                aria-label={zh ? "打开应用切换侧边栏" : "Open application sidebar"}
                aria-expanded={sidebarOpen}
                onClick={() => setSidebarOpen((open) => !open)}
              >
                <span />
                <span />
                <span />
              </button>
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

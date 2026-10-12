import { useState } from "react";
import { IconMenu } from "@festo-ui/react-icons";
import { useLocation, useNavigate } from "react-router-dom";
import dashboardIcon from "../assets/dashboards-icon.png";

type Asset = "MIP" | "ENI" | "MIE";
const downloadsUrl =
  "https://www.festo.com/de/en/p/ax-motion-insights-pneumatic-id_GASA_MIP/?tab=SUPPORT_PORTAL&documentTypeGroup=EXPERT_KNOWLEDGE&supportPortalTab=18";

export function AppHeader({
  asset,
  onAssetChange,
}: {
  asset?: Asset;
  onAssetChange?: (asset: Asset) => void;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [selectedAsset, setSelectedAsset] = useState<Asset>("MIP");
  const [assetsOpen, setAssetsOpen] = useState(false);
  const activeAsset = asset ?? selectedAsset;
  const page = pathname === "/import" ? "Import" : "Status";

  return (
    <>
      <header className="fwe-fixed-header">
        <nav className="fwe-navbar">
          <div className="fwe-navbar-inner">
            <nav className="fwe-navlist" aria-label="Main navigation">
              <div className="fwe-assets-menu">
                <button
                  className="fwe-dashboard-link"
                  type="button"
                  aria-label="Go to Dashboard"
                  onClick={() => navigate("/dashboard")}
                >
                  <img src={dashboardIcon} alt="Dashboard" />
                </button>
                <button
                  className="fwe-assets-trigger"
                  type="button"
                  aria-expanded={assetsOpen}
                  aria-label="Open asset menu"
                  onClick={() => setAssetsOpen(!assetsOpen)}
                >
                  <IconMenu aria-hidden="true" />
                </button>
                {assetsOpen && (
                  <div className="fwe-assets-dropdown" role="menu">
                    <div className="fwe-assets-dropdown-title">Select asset</div>
                    {(["MIP", "ENI", "MIE"] as const).map((item) => (
                      <button
                        key={item}
                        type="button"
                        role="menuitem"
                        className={activeAsset === item ? "is-selected" : ""}
                        onClick={() => {
                          setSelectedAsset(item);
                          setAssetsOpen(false);
                          if (onAssetChange) onAssetChange(item);
                          else if (item === "MIP") navigate("/dashboard");
                        }}
                      >
                        <span>{item}</span>
                        {activeAsset === item && (
                          <span className="fwe-selected-mark">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {(["Status", "Import", "Downloads"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={page === item ? "fwe-active" : ""}
                  onClick={() => {
                    if (item === "Downloads") window.location.assign(downloadsUrl);
                    else navigate(item === "Import" ? "/import" : "/dashboard");
                  }}
                >
                  {item}
                </button>
              ))}
            </nav>
            <div className="fwe-logo-container">
              <div className="fwe-festo-logo" aria-label="Festo" />
            </div>
          </div>
        </nav>
      </header>
      <div className="fwe-navbar-spacer" />
    </>
  );
}

export function AppFooter({ onVersionClick }: { onVersionClick?: () => void }) {
  return (
    <footer className="fwe-footer">
      <div>
        <button type="button" onClick={onVersionClick}>Version 24.0.6</button>
        <button type="button">Privacy Policy</button>
        <button type="button">Imprint</button>
      </div>
    </footer>
  );
}

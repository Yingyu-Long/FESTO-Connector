import { useState } from "react";
import dashboardIcon from "../../assets/dashboards-icon.png";
import { useNavigate } from "react-router-dom";
type Page = "Status" | "Import" | "Downloads";
type Asset = "MIP" | "ENI" | "MIE";
const downloadsUrl = "https://www.festo.com/de/en/p/ax-motion-insights-pneumatic-id_GASA_MIP/?tab=SUPPORT_PORTAL&documentTypeGroup=EXPERT_KNOWLEDGE&supportPortalTab=18";
import { IconMenu } from "@festo-ui/react-icons";

export default function Add() {
  const navigate = useNavigate();
  const [page, setPage] = useState<Page>("Status");
  const [asset, setAsset] = useState<Asset>("MIP");
  const [assetsOpen, setAssetsOpen] = useState(false);

  return (
    <div className="fwe-app">
      <header className="fwe-fixed-header">
        <nav className="fwe-navbar">
          <div className="fwe-navbar-inner">
            <nav className="fwe-navlist" aria-label="Main navigation">
              <div className="fwe-assets-menu">
                <button
                  className="fwe-assets-trigger"
                  type="button"
                  aria-expanded={assetsOpen}
                  aria-label="Open asset menu"
                  onClick={() => setAssetsOpen(!assetsOpen)}
                >
                  <img src={dashboardIcon} alt="" />
                  <IconMenu aria-hidden="true" />
                </button>
                {assetsOpen && (
                  <div className="fwe-assets-dropdown" role="menu">
                    <div className="fwe-assets-dropdown-title">
                      Select asset
                    </div>
                    {(["MIP", "ENI", "MIE"] as Asset[]).map((item) => (
                      <button
                        key={item}
                        type="button"
                        role="menuitem"
                        className={asset === item ? "is-selected" : ""}
                        onClick={() => {
                          setAsset(item);
                          setAssetsOpen(false);
                        }}
                      >
                        <span>{item}</span>
                        {asset === item && (
                          <span className="fwe-selected-mark">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {(["Status", "Import", "Downloads"] as Page[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={page === item ? "fwe-active" : ""}
                  onClick={() => {
                    if (item === "Downloads") {
                      window.location.assign(downloadsUrl);
                      return;
                    }
                    setPage(item);
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
      <main className="fwe-add-page">
        <section className="fwe-add-card">
          <div className="fwe-add-form">
            <h1>Add PLC</h1>
            <label htmlFor="plc-type">PLC type *</label>
            <select
              id="plc-type"
              defaultValue=""
              onChange={(event) => {
                const route = event.currentTarget.value;
                if (route) navigate(route);
              }}
            >
              <option value="" disabled>
                Select a PLC type to continue
              </option>
              <option value="/add/siemens">Siemens</option>
              <option value="/add/rockwell">Rockwell</option>
              <option value="/add/opcua">OPC UA</option>
              <option value="/add/beckhoff">Beckhoff</option>
            </select>
            <p>Select a PLC type to continue</p>
          </div>
          <div className="fwe-add-actions">
            <button type="button" className="fwe-save-button" disabled>
              Save
            </button>
            <button type="button" onClick={() => navigate("/")}>
              Cancel
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

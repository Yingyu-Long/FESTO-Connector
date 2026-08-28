import { useState } from "react";
import { IconMenu } from "@festo-ui/react-icons";
import { useNavigate } from "react-router-dom";
import dashboardIcon from "../../assets/dashboards-icon.png";

type Page = "Status" | "Import" | "Downloads";
type Asset = "MIP" | "ENI" | "MIE";
const downloadsUrl =
  "https://www.festo.com/de/en/p/ax-motion-insights-pneumatic-id_GASA_MIP/?tab=SUPPORT_PORTAL&documentTypeGroup=EXPERT_KNOWLEDGE&supportPortalTab=18";

export function PlcShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [page, setPage] = useState<Page>("Status");
  const [asset, setAsset] = useState<Asset>("MIP");
  const [assetsOpen, setAssetsOpen] = useState(false);
  const chooseAsset = (item: Asset) => {
    setAsset(item);
    setAssetsOpen(false);
    if (item === "MIP") navigate("/dashboard");
  };
  const goToPage = (item: Page) => {
    if (item === "Downloads") {
      window.location.assign(downloadsUrl);
      return;
    }
    setPage(item);
    if (item === "Status") navigate("/dashboard");
  };

  return (
    <div className="fwe-app">
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
                    <div className="fwe-assets-dropdown-title">
                      Select asset
                    </div>
                    {(["MIP", "ENI", "MIE"] as Asset[]).map((item) => (
                      <button
                        key={item}
                        type="button"
                        role="menuitem"
                        className={asset === item ? "is-selected" : ""}
                        onClick={() => chooseAsset(item)}
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
                  onClick={() => goToPage(item)}
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
      <main className="fwe-main-content">{children}</main>
      <footer className="fwe-footer">
        <div>
          <button type="button">Version 24.0.6</button>
          <button type="button">Privacy Policy</button>
          <button type="button">Imprint</button>
        </div>
      </footer>
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = "text",
  required = true,
  invalid = false,
  help,
  suffix,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  invalid?: boolean;
  help?: string;
  suffix?: string;
  className?: string;
}) {
  return (
    <label className={`fwe-field ${className ?? ""} ${invalid ? "is-invalid" : ""}`}>
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      <span className="fwe-input-wrap">
        <input
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {suffix && <b>{suffix}</b>}
      </span>
      {help && <small>{help}</small>}
      {invalid && <em>Required</em>}
    </label>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  required = true,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  required?: boolean;
  className?: string;
}) {
  return (
    <label className={`fwe-field ${className ?? ""}`}>
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

export function FormActions({
  valid,
  onSave,
  onCancel,
}: {
  valid: boolean;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const handleSave = async () => {
    if (saving) return;
    setSaveError("");
    setSaving(true);
    try {
      await onSave();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save configuration");
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="fwe-siemens-actions">
      <button
        type="button"
        className={`fwe-save-button ${valid ? "is-ready" : ""}`}
        onClick={() => void handleSave()}
        disabled={saving}
      >
        {saving ? "Saving..." : "Save"}
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {saveError && (
        <div className="fwe-save-error" role="alert">
          {saveError}
        </div>
      )}
    </aside>
  );
}

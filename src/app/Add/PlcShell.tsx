import { useState } from "react";
import { AppFooter, AppHeader } from "../AppLayout";

export function PlcShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fwe-app">
      <AppHeader />
      <main className="fwe-main-content">{children}</main>
      <AppFooter />
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
  placeholder,
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
  placeholder?: string;
}) {
  return (
    <label
      className={`fwe-field ${className ?? ""} ${invalid ? "is-invalid" : ""}`}
    >
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      <span className="fwe-input-wrap">
        <input
          type={type}
          value={value}
          placeholder={placeholder}
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
  invalid = false,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  required?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  return (
    <label
      className={`fwe-field ${className ?? ""} ${invalid ? "is-invalid" : ""}`}
    >
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
      {invalid && <em>Required</em>}
    </label>
  );
}

export function FormActions({
  valid,
  disabled = false,
  onSave,
  onCancel,
}: {
  valid: boolean;
  disabled?: boolean;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const handleSave = async () => {
    if (saving || disabled) return;
    setSaveError("");
    setSaving(true);
    try {
      await onSave();
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Unable to save configuration",
      );
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
        disabled={saving || disabled}
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

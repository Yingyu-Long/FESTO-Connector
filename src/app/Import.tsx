import { useRef, useState } from "react";
import { IconFailure, IconImport } from "@festo-ui/react-icons";
import { saveCurrentConfiguration } from "./configurationApi";
import {
  prepareConfiguration,
  storeConfiguration,
} from "./configurationImport";
import type { PreparedConfiguration } from "./configurationImport";

type ImportPageProps = {
  onImported: () => void;
  onCancel: () => void;
};

export default function Import({ onImported, onCancel }: ImportPageProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [pendingConfiguration, setPendingConfiguration] =
    useState<PreparedConfiguration | null>(null);

  const readFile = async (file: File) => {
    setFileName(file.name);
    setError("");
    try {
      if (!file.name.toLowerCase().endsWith(".json")) {
        throw new Error("Only .json files are supported");
      }
      setPendingConfiguration(prepareConfiguration(JSON.parse(await file.text())));
    } catch (reason) {
      setPendingConfiguration(null);
      setError(reason instanceof Error ? reason.message : "Unable to import configuration");
    }
  };

  const confirmImport = async () => {
    if (!pendingConfiguration) return;
    storeConfiguration(pendingConfiguration);
    try {
      await saveCurrentConfiguration();
      onImported();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save configuration");
    }
  };

  return (
    <section className="fwe-import-page">
      <h1>Import configuration</h1>
      <div className="fwe-import-container">
        <div className="fwe-import-main">
          <button
            type="button"
            className={`fwe-import-dropzone ${dragging ? "is-dragging" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) void readFile(file);
            }}
          >
            <IconImport className="fwe-import-icon" aria-hidden="true" />
            <strong>Drag &amp; drop file here</strong>
            <span>or</span>
            <span className="fwe-import-browse">Browse</span>
            <input
              ref={inputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file);
              }}
            />
          </button>
          <p className="fwe-import-hint">Supported file format: *.json</p>
          {fileName && !error && pendingConfiguration && (
            <p className="fwe-import-selected">Selected: {fileName}</p>
          )}
          {error && (
            <div className="fwe-import-error" role="alert">
              <IconFailure aria-hidden="true" />
              {error}
            </div>
          )}
        </div>
        <aside className="fwe-import-info">
          <strong>Import a JSON configuration file</strong>
          <p>
            The file must contain the connector configuration, including
            message sources and the MQTT message handler.
          </p>
          <p>Imported PLC connections will replace the current PLC list.</p>
        </aside>
      </div>
      <div className="fwe-import-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="fwe-import-confirm"
          disabled={!pendingConfiguration}
          onClick={() => void confirmImport()}
        >
          Import
        </button>
      </div>
    </section>
  );
}

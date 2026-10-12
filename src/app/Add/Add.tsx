import { useNavigate } from "react-router-dom";
import { AppHeader } from "../AppLayout";

export default function Add() {
  const navigate = useNavigate();

  return (
    <div className="fwe-app">
      <AppHeader />
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
              <option value="/add/modbus">Modbus TCP</option>
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

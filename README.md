# FESTO Connector

A web application that reads data from **Modbus TCP**, **Siemens S7**, and **OPC UA** PLCs and publishes it to an **MQTT** broker, with a built-in **Debug Bot** for live PLC and MQTT diagnostics.

## Key Features

- **PLC Connectors**:
  - **Modbus TCP**: Read by registers or Read by Datablocks (**Standard 58-register FB** and **Custom layout**, Big/Little-Endian, shared TCP connection pool, Excel template import/export).
  - **Siemens S7**: MIP data blocks with auto-generated or custom MQTT topics.
  - **OPC UA**: Live node browsing and grouped datablock subscriptions.
- **Reliable MQTT Publishing**: Cycle-consistency gating for cylinder datablocks, optional **Test mode** (publish every polling round), and automatic poller restore on startup.
- **Embedded Debug Bot** (`/debug-bot`): AI-assisted troubleshooting plus a no-key **Quick Diagnostics** workbench (cylinder update freshness monitor, live MQTT sampler, broker backlog & PUBACK backpressure check, config audit & runtime health).

## Quick Start

### Prerequisites

- Node.js 20.19+ or 22.12+
- PostgreSQL
- An MQTT broker (e.g. Mosquitto)

### 1. Install dependencies

```bash
npm install
```

### 2. Initialize PostgreSQL

Create a database named `festo_connector` and run:

```sql
CREATE TABLE IF NOT EXISTS connector_configurations (
  id TEXT PRIMARY KEY,
  configuration JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

> The `debug_bot_configurations` table is created automatically when Debug Bot settings are used.

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your PostgreSQL connection:

```env
PORT=3001
DATABASE_URL=postgresql://postgres:your_password@127.0.0.1:5432/festo_connector
```

### 4. Start the app

Run backend and frontend in two terminals:

```bash
npm run server
```

```bash
npm run dev
```

Open `http://localhost:5173` in your browser, configure your MQTT broker and PLC connections on the Dashboard, and click **Save**.

## Modbus TCP Datablocks Notes

- **Standard FB** reads 58 holding registers per block (`8 × ULINT timestamps`, `cycle_counter`, `part_number`) in zero-based Modbus addressing (max address `65535`). Normal mode publishes only complete, consistent cycles when timestamps advance; enable **Test mode** to publish every polling round.
- **Custom layout** lets you define field names, types, bit/byte widths, and word order (`Big-Endian` / `Little-Endian`), up to `125` registers per block.
- Both layouts support **Download template** / **Import Excel** (`.xlsx`) for bulk topic and field configuration.

## Scripts & Project Layout

```bash
npm run dev                                                    # Start Vite frontend
npm run server                                                 # Start Express backend
npm run build                                                  # Type-check & build frontend
npm run lint                                                   # Run ESLint
node --experimental-test-module-mocks --test tests/*.test.mjs  # Run unit tests
```

- `src/` — React frontend (Dashboard, PLC/MQTT editors, Debug Bot UI)
- `server/` — Express API, PostgreSQL store, MQTT publisher
- `server/plc/` — Modbus, Siemens S7, and OPC UA clients & pollers
- `server/debugBot/` — Debug Bot agent engine, diagnostic skills, and config store
- `shared/` — Shared Modbus datablock layouts and MQTT topic validators
- `tests/` — Unit and regression tests

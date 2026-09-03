# FESTO Connector

FESTO Connector is a web application for configuring an industrial data gateway. It runs on a computer in the production network, connects to PLCs, and publishes collected data to an MQTT broker.

The browser is only used to configure and monitor connections. The Node.js backend is the component that connects to PLCs, PostgreSQL, and MQTT, so the computer running the backend must have access to all three.

## What it does

- Stores connector configuration in PostgreSQL.
- Connects to Siemens S7 PLCs and reads configured data blocks.
- Connects to OPC UA servers and subscribes to selected variable NodeIds.
- Publishes PLC data to MQTT topics such as `festo/plc/<PLC_ID>`.
- Lets users test, save, rescan, import, and export PLC and MQTT configurations from a web dashboard.

Siemens S7 and OPC UA have active backend connection support. Beckhoff ADS and Rockwell EIP can be configured in the UI, but their backend drivers are not implemented yet.

## Architecture

```text
Browser
  |
  | HTTPS / REST API
  v
Web server + Node.js backend
  |             |
  |             +--> PostgreSQL: saved connector configuration
  |
  +--> Siemens S7 PLC or OPC UA server
  |
  +--> MQTT broker: festo/plc/<PLC_ID>
```

## Deploy on a new computer

The following steps assume a Linux server or industrial PC. The same application commands work on Windows and macOS; only the service and web-server setup differ.

### 1. Prepare the machine

Install the following software:

- Node.js 20 or later
- PostgreSQL 14 or later
- Nginx or another web server for production access
- An MQTT broker reachable from this machine

Before continuing, verify network access from the new machine to:

- PostgreSQL on TCP `5432` (or its configured port)
- The MQTT broker on its configured port, commonly TCP `1883`
- Siemens S7 PLCs on TCP `102`
- OPC UA servers on TCP `4840` or their configured port

### 2. Copy the application and install dependencies

Copy or clone this repository to the target computer, then run:

```bash
cd /opt/FESTO-Connector
npm ci
```

### 3. Create the PostgreSQL database

Create a PostgreSQL database and user, then connect to the new database and create the table:

```sql
CREATE TABLE IF NOT EXISTS connector_configurations (
  id TEXT PRIMARY KEY,
  configuration JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4. Configure environment variables

Create `/opt/FESTO-Connector/.env`:

```env
PORT=3001
DATABASE_URL=postgresql://connector_user:your_password@127.0.0.1:5432/festo_connector
```

Replace the user, password, host, port, and database name with the values for the target environment. Do not commit `.env` to source control.

### 5. Build and start the application

Build the frontend and start the backend:

```bash
npm run build
npm run server
```

Verify that the backend can reach PostgreSQL:

```bash
curl http://127.0.0.1:3001/api/health
```

Expected response:

```json
{"ok":true,"database":true}
```

For a production installation, run `npm run server` under a service manager such as `systemd` or PM2 so it restarts automatically after a reboot or failure.

### 6. Serve the frontend with Nginx

Create an Nginx server configuration and update the paths and hostname as needed:

```nginx
server {
    listen 80;
    server_name connector.example.local;

    root /opt/FESTO-Connector/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Reload Nginx, then open `http://connector.example.local` from a browser. Add TLS/HTTPS before exposing the application outside a trusted internal network.

### 7. Configure the connector

1. Open the dashboard in a browser.
2. Configure and test the MQTT broker.
3. Add a Siemens S7 or OPC UA PLC connection.
4. Test the connection, select S7 data blocks or OPC UA nodes, then save it.
5. Confirm that the dashboard status is `Connected` and that MQTT messages arrive on `festo/plc/<PLC_ID>`.

For many S7-1200/1500 installations, the initial values are port `102`, rack `0`, and slot `1`. The actual values depend on the PLC model and TIA Portal configuration. The PLC must allow the required external S7 communication.

## Local development

Use two terminals in the project directory:

```bash
npm run server:dev
```

```bash
npm run dev
```

During development, Vite proxies `/api` requests to `http://localhost:3001`.

## MQTT payloads

Siemens data is published as raw Base64 data. OPC UA messages contain the selected NodeId, value, data type, timestamp, and status code.

Subscribe to all PLC topics with Mosquitto:

```bash
mosquitto_sub -h localhost -p 1883 -t 'festo/plc/#' -v
```

## API overview

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Check PostgreSQL connectivity. |
| `GET` | `/api/configuration` | Load the most recently saved connector configuration. |
| `PUT` | `/api/configuration` | Save connector configuration. |
| `POST` | `/api/mqtt/connect` | Test MQTT broker connectivity. |
| `POST` | `/api/plcs/siemens/connect` | Connect to a Siemens PLC and start polling. |
| `POST` | `/api/plcs/opcua/test` | Test an OPC UA connection. |
| `POST` | `/api/plcs/opcua/browse` | Browse OPC UA nodes. |
| `POST` | `/api/plcs/opcua/connect` | Start an OPC UA subscription. |

## Current limitations

- PLC pollers are kept in memory and are not restored automatically after a backend restart.
- Beckhoff ADS and Rockwell EIP backend drivers are not implemented.
- OPC UA currently supports anonymous connections with no security mode or security policy.
- The Siemens backend reads raw data blocks; it does not decode bytes into named tags or data types.
- The Siemens backend uses Snap7 `ConnectTo(host, rack, slot)`; the port field is saved for configuration but is not passed to Snap7.
- Protect the API and database because saved configuration can contain MQTT credentials.

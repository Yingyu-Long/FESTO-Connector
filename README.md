# FESTO Connector

FESTO Connector is a web-based industrial gateway configuration tool. It stores connector settings in PostgreSQL, reads Siemens S7 PLC data blocks through Snap7, and publishes the raw data to an MQTT broker.

> The current runtime PLC implementation supports **Siemens S7**. The UI can save configurations for other protocols, but Beckhoff, Rockwell, and OPC UA do not yet have corresponding backend pollers.

## Architecture

```text
Browser (React / Vite)
        |
        | REST API: /api/*
        v
Node.js / Express backend
   |             |
   |             +--> PostgreSQL: connector configuration JSON
   |
   +--> Siemens S7 PLC (Snap7 / TCP 102)
                     |
                     v
               MQTT Broker
                     |
                     v
          festo/plc/<PLC_ID>
```

The backend publishes a JSON payload for every PLC polling cycle. Data block bytes are sent as Base64 in `rawData`; the gateway does not currently decode DB bytes into named tags or data types.

## Prerequisites

- Node.js LTS (Node 20 or later recommended)
- PostgreSQL 14 or later
- An MQTT broker reachable from the computer running the Node.js backend
- For live Siemens testing: a reachable Siemens S7 PLC with S7 communication enabled

Install project dependencies:

```bash
npm ci
```

## Database setup

Create a database and run the following SQL once:

```sql
CREATE TABLE IF NOT EXISTS connector_configurations (
  id TEXT PRIMARY KEY,
  configuration JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Create `.env` in the project root:

```env
PORT=3001
DATABASE_URL=postgresql://connector_user:your_password@127.0.0.1:5432/festo_connector
```

`MQTT_URL` appears in `.env.example` for reference but is not used by the current backend. MQTT connection details are entered in the web UI and passed to the backend as part of the PLC connection request.

## Run locally

Use two terminals in the project directory.

Start the API server:

```bash
npm run server:dev
```

Start the frontend development server:

```bash
npm run dev
```

Vite proxies `/api` requests to `http://localhost:3001` during development. Confirm that the backend can reach PostgreSQL:

```bash
curl http://localhost:3001/api/health
```

Expected response:

```json
{"ok":true,"database":true}
```

## Configure and test a Siemens PLC

1. Open the web UI and configure the MQTT broker first.
2. Add a Siemens connection with a PLC ID, IP/hostname, rack, slot, data-block range, and polling interval.
3. Click **Test connection** or **Save**.

For many S7-1200/1500 configurations the connection values are:

```text
Port: 102
Rack: 0
Slot: 1
```

These values depend on the PLC model and its TIA Portal configuration. The PLC must allow S7 external communication (for example, PUT/GET where applicable), and the backend host must be able to reach TCP port 102.

Data-block ranges may be entered as `1`, `DB1`, `1-20`, or `DB1-DB20`. A range is capped at 200 blocks. The backend reads each configured DB from offset `0`; a configured `size` is used when present, otherwise the DB size is obtained from the PLC.

Clicking **Test connection** starts the polling loop in the current implementation; it is not a connect-and-immediately-disconnect check.

## View MQTT payloads and raw PLC data

Siemens data is published to:

```text
festo/plc/<PLC_ID>
```

For example, PLC ID `plc-test` publishes to `festo/plc/plc-test`.

If the Mosquitto CLI is installed, subscribe to every connector PLC topic:

```bash
mosquitto_sub -h localhost -p 1883 -t 'festo/plc/#' -v
```

Alternatively, because this project already includes the `mqtt` package, run this from the project directory without installing Mosquitto tools:

```bash
node --input-type=module -e "import mqtt from 'mqtt'; const client = mqtt.connect('mqtt://localhost:1883'); client.on('connect', () => { console.log('Subscribed to festo/plc/#'); client.subscribe('festo/plc/#'); }); client.on('message', (topic, message) => console.log(topic, message.toString())); client.on('error', console.error);"
```

Example payload:

```json
{
  "plcId": "plc-test",
  "timestamp": 1788190000000,
  "dataBlocks": [
    {
      "dataBlock": 1,
      "start": 0,
      "size": 20,
      "encoding": "base64",
      "rawData": "AAECAwQ..."
    }
  ],
  "quality": "good",
  "errors": []
}
```

`rawData` is a Base64-encoded byte buffer. Decode and interpret it according to your PLC DB layout, offsets, and Siemens data types. A `quality` value of `good`, `partial`, or `bad` indicates whether all, some, or none of the requested DB reads succeeded.

## MQTT broker in Docker

The application can run directly on the host while the MQTT broker runs in Docker. Expose the broker port to the host:

```yaml
ports:
  - "1883:1883"
```

Then configure the UI and the subscription client to use `localhost:1883`. If the broker is on another host, use that host's reachable IP address and port. Do not use a Docker container name from the host unless DNS/networking has been configured explicitly.

## Production deployment

Build the frontend:

```bash
npm run build
```

Run the Node backend with a process manager such as systemd, PM2, or a container. Serve the `dist/` directory through a web server and proxy `/api/` to the backend. Example Nginx configuration:

```nginx
server {
    listen 80;
    server_name connector.example.local;

    root /path/to/FESTO-Connector/dist;
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

The backend machine—not the browser—must have network access to PostgreSQL, the MQTT broker, and all configured PLCs.

## API overview

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Check PostgreSQL connectivity. |
| `GET` | `/api/configuration` | Load the most recently updated connector configuration. |
| `PUT` | `/api/configuration` | Create or update the configuration JSON. |
| `DELETE` | `/api/configuration/message-sources/:uniqueKey` | Remove one saved message source. |
| `POST` | `/api/mqtt/connect` | Test MQTT broker connectivity. |
| `POST` | `/api/plcs/siemens/connect` | Connect to a Siemens PLC and start its poller. |
| `DELETE` | `/api/plcs/siemens/:id` | Stop an active Siemens PLC poller. |

## Current limitations

- Pollers are in memory and are not automatically restored after a backend restart.
- Removing a PLC configuration in the dashboard does not currently call the poller stop endpoint.
- Per-data-block polling intervals are accepted by the UI, but the backend currently uses the first block's interval as the PLC-wide polling interval.
- The Siemens backend currently connects through Snap7's `ConnectTo(host, rack, slot)` flow; the UI port field is not passed to that call.
- MQTT certificate authentication is displayed in the UI but TLS certificate options are not implemented by the backend.
- Configuration JSON can contain MQTT credentials. Protect database access, restrict API access in production, and avoid committing `.env` files.

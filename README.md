# FESTO Connector

## Description

FESTO Connector is a web application that connects Siemens S7, OPC UA, and Modbus TCP devices to an MQTT broker. Use the dashboard to configure PLC connections, select data to read, and send the collected values through MQTT.

## Run on a New Computer

### 1. Install the required software

Install:

- Node.js 20 or newer
- PostgreSQL
- An MQTT broker, such as Mosquitto

The computer must be able to reach the PLCs and MQTT broker over the network.

### 2. Copy the project and install packages

Open a terminal in the project folder and run:

```bash
npm install
```

### 3. Create the database

Create a PostgreSQL database named `festo_connector`, then run this SQL inside it:

```sql
CREATE TABLE IF NOT EXISTS connector_configurations (
  id TEXT PRIMARY KEY,
  configuration JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4. Configure the application

Create `.env` from the example file:

```bash
cp .env.example .env
```

Open `.env` and enter your PostgreSQL settings:

```env
PORT=3001
DATABASE_URL=postgresql://postgres:your_password@127.0.0.1:5432/festo_connector
```

Replace `your_password` with your PostgreSQL password. The MQTT address is configured later in the web dashboard.

### 5. Start the application

Open two terminals in the project folder.

Terminal 1:

```bash
npm run server
```

Terminal 2:

```bash
npm run dev
```

Open this address in Chrome:

```text
http://localhost:5173
```

Keep both terminals running while using the application.

### 6. Configure the connector

1. Configure and save the MQTT connection.
2. Add a Siemens S7, OPC UA, or Modbus TCP device.
3. Click **Test connection**.
4. Configure the data to read and click **Save**.
5. Check the dashboard status and subscribe to the MQTT topic to verify the output.

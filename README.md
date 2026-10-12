# FESTO Connector

## Description

FESTO Connector is a web application that connects Siemens S7, OPC UA, and Modbus TCP devices to an MQTT broker. Use the dashboard to configure PLC connections, select data to read, and send the collected values through MQTT.

## Run on a New Computer

### 1. Install the required software

Install:

- Node.js 20.19+ or 22.12+
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

## Modbus TCP Datablocks

Select **Read by Datablocks**, enter the block count and **Start address**
(default **0**), and assign one MQTT publish topic to each FB. Each block
contains **58 holding registers / 116 bytes**:

| Variables | Register offsets | Registers |
| --- | --- | --- |
| Eight `timestamp_*` ULINT values, in the order shown in the configuration page | 0–31 | 32 |
| `udiCycleCounter` (UDINT) | 32–33 | 2 |
| `sPartnumber` (STRING[48]) | 34–57 | 24 |

Blocks are consecutive: two blocks starting at 0 read 0–57 and
58–115. The start address is sent directly as the zero-based Modbus
protocol address, matching **Read by registers**; no 40000/40001 reference-number
conversion is applied. The final address must be at most 65535. See the
[Modbus specification, section 6.3](https://www.modbus.org/docs/Modbus_Application_Protocol_V1_1b3.pdf)
for holding-register request addressing and limits.

### Import datablocks from Excel

Under **Read by Datablocks**, enter **Number of Datablocks**, then click
**Download template**. The `.xlsx` file contains exactly that many FB/topic rows,
the current start address and polling interval, and any topics already entered.
Empty topics receive example values such as `test/fb01`. The workbook contains
only configuration fields and FB/topic rows, with no explanatory notes.
Edit the workbook, then click **Import Excel** to load it into the form.
Keep the worksheet name **Datablocks** and the following layout:

| Excel row | Column A | Column B |
| --- | --- | --- |
| 1 | Start address | 0 |
| 2 | Polling interval (ms) | 500 |
| 3 | Number of Datablocks | 80 |
| 4 | FB | MQTT topic |
| 5 | 1 | test/fb01 |
| 6 | 2 | test/fb02 |
| … | … | … |
| 84 | 80 | test/fb80 |

Replace the example topics with the exact MQTT publish topics you need.
Add or remove FB rows to match your PLC. FB numbers must be unique and
consecutive from 1; import orders topics by FB number, even if rows are sorted.
The count in **B3** must match the number of FB/topic rows. To change the count
in Excel, update B3 and add or remove the matching FB/topic rows. Entirely blank
FB rows are ignored. Older templates with an empty third row remain supported;
their count comes from the FB rows. FB N starts at
`Start address + (N - 1) * 58`; individual FB addresses
are not entered in Excel. The final register must not exceed 65535.

Enter topics as text without `+`, `#`, or null characters. Leading and trailing
whitespace is trimmed; no prefix is added. Use saved cell values; if you use
Excel formulas, calculate and save the workbook in Excel before importing.
The importer reads their saved results. Files must be `.xlsx` and at most 10 MB.
Connection fields such as PLC ID, host and port stay in the form.

Import validates all rows before replacing the form's block count, start
address, topics and polling interval. An invalid workbook leaves those values
unchanged. Review the imported settings and click **Save** to apply them.

### Reading and publishing

Up to two consecutive blocks are read per holding-register request: 116 registers
(232 bytes), within the protocol limit of 125 registers per request. An unpaired
final block uses a 58-register request. Requests run sequentially on the same
connection, so N blocks need ceil(N / 2) requests per polling round. Each response
is split into 58-register blocks for decoding and publication to each block's
configured MQTT topic. Decoding uses the high word and high byte first.
The supplied string layout is interpreted as 48 bytes without a
length header, ending at the first zero byte or the end of the field. MQTT
messages contain only the ten decoded variables as top-level JSON properties,
without `fields` or connection metadata. ULINT timestamps are decimal strings
so all 64 bits are preserved. Each block is published to its configured topic.
**Test connection**, **Save**, and dashboard **Rescan** all
support this mode.

**Polling interval** accepts whole milliseconds from **10 to 3,600,000**
(default **500 ms**). This is the wait after a complete round of reads and MQTT
publishes; the actual refresh period also includes the time spent reading and
publishing. For example, 80 FBs require 40 sequential Modbus requests per round.

When the host, port, Unit ID, and timeout match an active Modbus poller,
**Test connection** reuses its TCP connection and reads the current form's
registers between polling operations. This supports devices that accept only
one TCP client. Testing does not save the edited configuration or publish MQTT
messages. A different connection configuration is tested with a new connection.

**Save** and **Rescan** also reuse the current connection when those connection
parameters match. Saving applies the new register, polling, and MQTT settings
with a fresh read. PLC settings are saved whether the connection succeeds or
fails, and the editor returns to the dashboard. Failed connections show
Disconnected, with the error available in the expanded PLC row. The Connection
details table column is currently left blank. A failed Modbus update keeps
the new polling configuration and retries it on subsequent polling rounds.
Dashboard Modbus status is refreshed from the backend every second. Cancelling
an existing PLC edit returns directly to the dashboard; cancelling a new PLC
returns to the PLC type selection page. Invalid forms and database save errors
remain in the editor for correction.

## Project structure

- `src/app/AppLayout.tsx`: shared header, navigation, and footer.
- `src/app/storage.ts`: local configuration storage, connection identity, and deduplication.
- `src/app/Add/`: PLC/MQTT editors and Modbus Excel import/template generation.
- `src/app/Dashboard/`: dashboard view, connection details, reconnection, and live status.
- `src/app/configuration*.ts`: configuration serialization, import, and backend API calls.
- `server/`: HTTP API, PostgreSQL access, and MQTT publishing.
- `server/plc/`: protocol clients, decoding, and polling.
- `shared/modbusDatablock.js`: the 58-register layout shared by the frontend and backend.

Run `npm run lint` to check frontend and backend code, and `npm run build` to
check TypeScript and build the frontend. Beckhoff and Rockwell settings can be
saved, but their backend connections are not implemented yet. Their connection
buttons report this directly without simulating a network request.

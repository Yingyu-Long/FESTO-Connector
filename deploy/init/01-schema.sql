-- Schema only: customer deployments start without saved PLC/MQTT configurations.
CREATE TABLE IF NOT EXISTS public.connector_configurations (
  id TEXT PRIMARY KEY,
  configuration JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.debug_bot_configurations (
  id TEXT PRIMARY KEY,
  configuration JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

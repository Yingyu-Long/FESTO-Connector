import { useState } from "react";
import { IconConnected, IconFailure } from "@festo-ui/react-icons";
import { useNavigate } from "react-router-dom";
import { Field, FormActions, PlcShell, SelectField } from "./PlcShell";

type MqttConfig = {
  host: string;
  port: string;
  clientId: string;
  username: string;
  password: string;
  qos: string;
  authType: string;
};

const defaultMqttConfig: MqttConfig = {
  host: "",
  port: "1883",
  clientId: "",
  username: "",
  password: "",
  qos: "1",
  authType: "None",
};

function readMqttConfig(): MqttConfig {
  try {
    const saved = JSON.parse(
      localStorage.getItem("festo-mqtt-config") ?? "null",
    ) as Partial<MqttConfig> | null;
    return {
      host: typeof saved?.host === "string" ? saved.host : defaultMqttConfig.host,
      port: typeof saved?.port === "string" ? saved.port : defaultMqttConfig.port,
      clientId: typeof saved?.clientId === "string" ? saved.clientId : defaultMqttConfig.clientId,
      username: typeof saved?.username === "string" ? saved.username : defaultMqttConfig.username,
      password: typeof saved?.password === "string" ? saved.password : defaultMqttConfig.password,
      qos: typeof saved?.qos === "string" ? saved.qos : defaultMqttConfig.qos,
      authType: typeof saved?.authType === "string" ? saved.authType : defaultMqttConfig.authType,
    };
  } catch {
    return defaultMqttConfig;
  }
}

export default function Mqtt() {
  const navigate = useNavigate();
  const savedConfig = readMqttConfig();
  const [values, setValues] = useState({
    host: savedConfig.host,
    port: savedConfig.port,
    clientId: savedConfig.clientId,
    username: savedConfig.username,
    password: savedConfig.password,
  });
  const [qos, setQos] = useState(savedConfig.qos);
  const [authType, setAuthType] = useState(savedConfig.authType);
  const [submitted, setSubmitted] = useState(false);
  const [tested, setTested] = useState(false);
  const [connectionState, setConnectionState] = useState<
    "idle" | "checking" | "connected" | "disconnected"
  >("idle");
  const [connectionMessage, setConnectionMessage] = useState("");
  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const valid = Boolean(
    values.host &&
    values.port &&
    (authType === "None" || (values.username && values.password)),
  );
  const checkConnection = async () => {
    if (!valid) {
      setSubmitted(true);
      setConnectionState("disconnected");
      return false;
    }

    setConnectionState("checking");
    setConnectionMessage("");
    try {
      const response = await fetch("/api/mqtt/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
          protocol: "tcp://",
          port: Number(values.port),
          qos,
          authType,
        }),
      });
      const result = (await response.json()) as {
        connected?: boolean;
        error?: string;
      };
      const connected = response.ok && result.connected === true;
      setConnectionState(connected ? "connected" : "disconnected");
      setConnectionMessage(
        connected
          ? ""
          : result.error ?? "The MQTT broker rejected the connection.",
      );
      return connected;
    } catch (error) {
      setConnectionState("disconnected");
      setConnectionMessage(
        error instanceof TypeError
          ? "The backend is not running. Start it with npm run server:dev."
          : "Unable to reach the MQTT connection service.",
      );
      return false;
    }
  };

  const save = async () => {
    setSubmitted(true);
    if (!valid) return;
    const connected = await checkConnection();
    localStorage.setItem(
      "festo-mqtt-config",
      JSON.stringify({
        ...values,
        protocol: "tcp://",
        qos,
        authType,
        status: connected ? "connected" : "disconnected",
      }),
    );
    navigate("/dashboard");
  };

  return (
    <PlcShell>
      <div className="fwe-add-layout fwe-mqtt-layout">
        <section className="fwe-siemens-card">
          <form onSubmit={(event) => event.preventDefault()}>
            <div className="fwe-form-title">
              <h1>MQTT Connection</h1>
            </div>
            <div className="fwe-mqtt-fields">
              <SelectField
                className="fwe-protocol-field"
                label="Protocol"
                value="tcp://"
                onChange={() => undefined}
                options={["tcp://"]}
              />
              <Field
                className="fwe-host-field"
                label="Host"
                value={values.host}
                onChange={set("host")}
                invalid={submitted && !values.host}
              />
              <Field
                className="fwe-port-field"
                label="Port"
                value={values.port}
                onChange={set("port")}
                invalid={submitted && !values.port}
              />
            </div>
            <div className="fwe-mqtt-fields fwe-mqtt-secondary-fields">
              <Field
                className="fwe-field-id"
                label="Client Id"
                required={false}
                value={values.clientId}
                onChange={set("clientId")}
                help="Optional custom client id"
              />
              <SelectField
                className="fwe-port-field"
                label="Quality of service"
                required={false}
                value={qos}
                onChange={setQos}
                options={["0", "1", "2"]}
              />
            </div>
            <fieldset className="fwe-mqtt-auth">
              <legend>Authentication</legend>
              <div
                className="fwe-mqtt-radio-group"
                role="radiogroup"
                aria-label="Authentication"
              >
                {["Basic Authentication", "Certificates", "None"].map(
                  (option) => (
                    <label key={option}>
                      <input
                        type="radio"
                        name="mqtt-authentication"
                        value={option}
                        checked={authType === option}
                        onChange={(event) => setAuthType(event.target.value)}
                      />
                      {option}
                    </label>
                  ),
                )}
              </div>
              {authType === "Basic Authentication" && (
                <div className="fwe-mqtt-fields fwe-mqtt-credentials">
                  <Field
                    className="fwe-field-id"
                    label="User"
                    value={values.username}
                    onChange={set("username")}
                    invalid={submitted && !values.username}
                  />
                  <Field
                    className="fwe-field-id"
                    label="Password"
                    type="password"
                    value={values.password}
                    onChange={set("password")}
                    invalid={submitted && !values.password}
                  />
                </div>
              )}
            </fieldset>
            <div className="fwe-test-row">
              <button
                type="button"
                className="fwe-test-button"
                onClick={async () => {
                  setTested(true);
                  await checkConnection();
                }}
                disabled={connectionState === "checking"}
              >
                <IconConnected />
                {connectionState === "checking" ? "Testing connection..." : "Test connection"}
              </button>
              {tested && !valid && (
                <div className="fwe-connection-error">
                  <IconFailure />
                  Please fill out all required fields correctly.
                </div>
              )}
              {tested && valid && connectionState === "connected" && (
                <div className="fwe-connection-success">
                  <IconConnected />
                  Connected
                </div>
              )}
              {tested && valid && connectionState === "disconnected" && (
                <div className="fwe-connection-error">
                  <IconFailure />
                  {connectionMessage || "Unable to connect. Check the server and broker settings."}
                </div>
              )}
            </div>
          </form>
        </section>
        <FormActions
          valid={valid}
          onSave={save}
          onCancel={() => navigate("/dashboard")}
        />
      </div>
    </PlcShell>
  );
}

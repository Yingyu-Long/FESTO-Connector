export function isValidMqttPublishTopic(topic) {
  return (
    typeof topic === "string" &&
    Boolean(topic.trim()) &&
    !/[+#\0]/.test(topic) &&
    new TextEncoder().encode(topic.trim()).length <= 65535
  );
}

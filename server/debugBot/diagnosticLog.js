const MAX_EVENTS = 120;
const events = [];

export function recordDiagnosticEvent({
  level = "info",
  component = "connector",
  plcId = null,
  message,
  details = null,
}) {
  if (!message) return;
  events.push({
    timestamp: new Date().toISOString(),
    level,
    component,
    plcId: plcId ? String(plcId) : null,
    message: String(message),
    ...(details ? { details } : {}),
  });
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
}

export function getRecentDiagnosticEvents({ limit = 30, level = null, component = null } = {}) {
  const numericLimit = Math.min(Math.max(Number(limit) || 30, 1), MAX_EVENTS);
  const filtered = events.filter((event) => {
    if (level && event.level !== level) return false;
    if (component && event.component !== component) return false;
    return true;
  });
  return filtered.slice(-numericLimit).reverse();
}

export function clearDiagnosticEvents() {
  events.length = 0;
}

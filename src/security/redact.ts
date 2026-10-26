const SECRET_KEYS = /^(authorization|x-api-key|api[-_]?key|cookie|set-cookie|proxy-authorization|x-auth-token|anthropic-api-key|factory[-_]?api[-_]?key)$/i;
const SECRET_VALUE = /(?:sk-|fk-|ant-|claude-|Bearer\s+)[A-Za-z0-9._\-]{8,}/g;

export function redactValue(value: string): string {
  return value.replace(SECRET_VALUE, "[redacted]")
    .replace(/[A-Za-z0-9._%+*-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\[factory-cc-session:[a-f0-9]{64}\]/g, "[factory-cc-session:redacted]");
}

export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(headers)) {
    const value = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
    out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redactValue(value);
  }
  return out;
}

export function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[truncated]";
  if (typeof value === "string") return redactValue(value);
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => redactJson(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redactJson(child, depth + 1);
    }
    return out;
  }
  return value;
}

export function summarizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const keys = Object.keys(env).sort();
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (/key|token|secret|password|authorization|credential/i.test(key)) {
      out[key] = env[key] ? "[set]" : "[empty]";
    }
  }
  return out;
}

import { createHash } from "node:crypto";

/**
 * Keys whose values must never reach a log line or an audit row.
 * Matched case-insensitively on the key name, at any depth.
 */
const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|bearer|credential|cookie|signature|private[-_]?key)/i;

/** Keys that carry personal data. Redacted in logs; never stored in the audit log. */
const PII_KEY = /(^|_)(email|phone|mobile|name|address|street|postcode|zip|dob|birth|photo|note|notes|message)($|_)/i;

export const REDACTED = "[redacted]";

/**
 * Deep-redact a value for logging.
 *
 * This is a backstop, not the primary control. The primary control is that
 * PII and credentials are not put into log calls in the first place. This
 * catches the cases someone forgot.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) || PII_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

/**
 * Stable hash of a request payload, for idempotency comparison and audit rows.
 *
 * Object keys are sorted so that two logically identical payloads hash the
 * same regardless of property order. The hash is what the audit log stores —
 * never the payload itself, which would contain personal data and would then
 * be subject to deletion under Connector Terms section 4.3(f).
 */
export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

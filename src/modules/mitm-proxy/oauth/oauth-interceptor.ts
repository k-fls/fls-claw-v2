/**
 * OAuth body helpers for token swapping.
 *
 * `ParsedBody` is a format-agnostic abstraction over JSON and
 * form-encoded request/response bodies. Read-only field access plus
 * order-preserving in-place field replacement. Used by the
 * token-exchange handler to swap refresh_token / access_token values
 * without rewriting the surrounding body byte-for-byte.
 *
 * Direct port from the v1 snapshot. Pure — no I/O, no module-level
 * state, no dependencies on the proxy.
 */

export interface ParsedBody {
  /** Read-only field access (string values). */
  readonly fields: Record<string, string>;
  /** Replace a field value in-place, preserving format and field order. */
  set(key: string, value: string): void;
  /** Serialize back to the original format (JSON or form-encoded). */
  serialize(): string;
}

/**
 * Parse a token request/response body into a ParsedBody.
 * Auto-detects JSON vs form-encoded from the body content.
 * Returns null if the body can't be parsed as either format.
 */
export function parseBody(raw: string): ParsedBody | null {
  const trimmed = raw.trimStart();

  // JSON
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        fields[k] = String(v);
      }
      let current = raw;
      return {
        fields,
        set(key, value) {
          current = replaceJsonStringValue(current, key, value);
          fields[key] = value;
        },
        serialize() {
          return current;
        },
      };
    } catch {
      return null;
    }
  }

  // Form-encoded (key=value&...)
  if (trimmed.includes('=')) {
    const params = new URLSearchParams(raw);
    const fields: Record<string, string> = {};
    for (const [k, v] of params) {
      fields[k] = v;
    }
    return {
      fields,
      set(key, value) {
        params.set(key, value);
        fields[key] = value;
      },
      serialize() {
        return params.toString();
      },
    };
  }

  return null;
}

/**
 * Replace a string value for a given key in a JSON string, preserving
 * all other content byte-for-byte (field order, whitespace, other fields).
 *
 * Only handles simple string values — not nested objects, arrays, or numbers.
 * Sufficient for OAuth token fields (access_token, refresh_token, etc).
 */
export function replaceJsonStringValue(json: string, key: string, newValue: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`("${escaped}"\\s*:\\s*)"((?:[^"\\\\]|\\\\.)*)"`);
  const match = re.exec(json);
  if (!match) return json;
  const jsonEscaped = newValue
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return json.slice(0, match.index) + match[1] + '"' + jsonEscaped + '"' + json.slice(match.index + match[0].length);
}

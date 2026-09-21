/**
 * Provider-supplied text is data. It is never an instruction.
 *
 * Business names, descriptions, service notes and messages all arrive from
 * third-party systems that Porter does not control. A booking platform's
 * "business name" field is user-editable by the business, so it is an
 * injection surface.
 *
 * The Muse Connector Policies make this a compliance matter as well as a
 * security one: building "exfiltration or prompt-injection vectors" is an
 * explicit prohibited practice.
 *
 * `UntrustedText` is nominal, so a raw provider string cannot be assigned
 * where sanitised output is expected. The only way out is `sanitize()`.
 */
declare const untrustedBrand: unique symbol;
export type UntrustedText = string & { readonly [untrustedBrand]: "UntrustedText" };

/** Mark a string as having come from outside Porter's trust boundary. */
export const untrusted = (v: string): UntrustedText => v as UntrustedText;

export interface SanitizeOptions {
  /** Hard cap on output length, before the delimiter is added. */
  readonly maxLength?: number;
  /** Wrap the value so a model reading it sees an explicit data boundary. */
  readonly delimit?: boolean;
  /** Label used in the delimiter, e.g. "business name". */
  readonly label?: string;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Bidi and zero-width characters can hide text from a human reviewer while a
// model still reads it. Strip them.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * Neutralise provider text for inclusion in a tool response.
 *
 * This does four things:
 *   1. strips control, bidi and zero-width characters
 *   2. collapses runs of whitespace, so ASCII-art framing cannot be built
 *   3. defuses markup that could restructure the response — fenced blocks,
 *      headings, HTML tags, and the delimiter sequence itself
 *   4. caps length, then optionally wraps the value in an explicit data fence
 */
export function sanitize(value: UntrustedText | string, options: SanitizeOptions = {}): string {
  const { maxLength = 400, delimit = false, label = "provider text" } = options;

  let out = String(value)
    .replace(CONTROL_CHARS, " ")
    .replace(INVISIBLE, "")
    .replace(/\r\n?/g, "\n");

  // Markup that could change how the response is parsed or displayed.
  out = out
    .replace(/[`]{3,}/g, "'''")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/<\|[^|]*\|>/g, "");

  // Our own fence markers, so provider text cannot forge a boundary.
  out = out.replace(/\[\/?PROVIDER_DATA[^\]]*\]/gi, "");

  out = out.replace(/[ \t ]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  if (out.length > maxLength) out = `${out.slice(0, maxLength - 1).trimEnd()}…`;

  if (!delimit) return out;
  return `[PROVIDER_DATA ${label}]${out}[/PROVIDER_DATA]`;
}

/** Sanitise every string in a record of provider-supplied fields. */
export function sanitizeRecord<K extends string>(
  record: Readonly<Record<K, UntrustedText | string | undefined>>,
  options?: SanitizeOptions,
): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const key of Object.keys(record) as K[]) {
    const v = record[key];
    out[key] = v === undefined ? "" : sanitize(v, { ...options, label: options?.label ?? key });
  }
  return out;
}

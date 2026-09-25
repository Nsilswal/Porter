import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { defaultTreeAdapter, parse, type DefaultTreeAdapterTypes } from "parse5";
import { sanitize } from "@porter/shared";

/** Website fields are descriptive suggestions, never authoritative booking terms. */
export interface WebsitePreview {
  readonly submittedUrl: string;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly name?: string;
  readonly description?: string;
  readonly address?: string;
  readonly phone?: string;
  readonly bookingProvider: "square" | "unknown";
  readonly bookingUrl?: string;
  readonly services: readonly ImportedService[];
  readonly warnings: readonly string[];
}

export interface ImportedService {
  readonly name: string;
  readonly description?: string;
  readonly priceText?: string;
  readonly durationText?: string;
  readonly sourceUrl: string;
}

export interface ResolvedAddress { readonly address: string; readonly family: 4 | 6 }
export interface ImportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Raw wire bytes; decoding and size checks also run on injected transports. */
  readonly body: Buffer;
}

export interface ImportOptions {
  readonly signal?: AbortSignal;
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  /** Trusted dependency injection only. Must connect to address without resolving again. */
  readonly transport?: (url: URL, address: ResolvedAddress, signal: AbortSignal, maxBytes: number) => Promise<ImportResponse>;
}

const USER_AGENT = "PorterBot/1.0";
const MAX_URL = 2_048;
const MAX_REDIRECTS = 4;
const MAX_WIRE = 1_048_576;
const MAX_HTML = 2_097_152;
const MAX_ROBOTS = 131_072;
// Parsing is synchronous. Bound its input and tree construction separately
// from network limits; an AbortSignal cannot interrupt parse5's CPU work.
const MAX_PARSE_BYTES = 262_144;
const MAX_MARKUP_MARKERS = 2_000;
const MAX_MARKUP_LENGTH = 4_096;
const MAX_PARSE_DEPTH = 128;
const MAX_PARSE_ELEMENTS = 4_000;
const MAX_PREVIEW_BYTES = 60 * 1_024;
const TIMEOUT_MS = 15_000;
const IMPORT_WARNING = "Imported website details need owner review. Square supplies bookable services, prices, availability and booking rules.";
const PREVIEW_WARNING = "Some descriptive details or services were omitted to keep this preview within its size limit. Review the full catalog in Square.";
const FAILURE_MESSAGES = {
  invalid_url: "Use a public HTTP or HTTPS website URL without a password or a custom port.",
  unsafe_destination: "The website address is not a public internet destination.",
  unavailable: "The website could not be read. You can review details manually and connect Square.",
  timeout: "The website took too long to respond. You can retry or review details manually.",
  too_large: "The website response exceeded the import size limit. Review details manually.",
  robots: "The website's robots policy does not permit this import, or could not be verified. Review details manually.",
  content_type: "This URL did not return a readable HTML page. Review details manually.",
  redirects: "The website redirected too many times. Try its final public website URL.",
  complex: "The website is too complex to import safely. Review details manually and connect Square.",
} as const;
class ImportFailure extends Error {
  constructor(readonly code: keyof typeof FAILURE_MESSAGES) { super(FAILURE_MESSAGES[code]); }
}

/**
 * One HTML document, no scripts, subresources, authentication or cookies.
 * DNS is checked for EVERY request and the selected address is pinned through
 * node's lookup hook. Redirects repeat URL/DNS/robots checks. An import failure
 * yields an honest empty preview so onboarding can preserve its draft.
 */
export async function importWebsite(input: string, options: ImportOptions = {}): Promise<WebsitePreview> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let submittedUrl = "";
  let sourceUrl = "";
  try {
    let target = publicUrl(input);
    submittedUrl = target.href;
    sourceUrl = submittedUrl;
    const policies = new Map<string, RobotsPolicy>();
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      let policy = policies.get(target.origin);
      if (!policy) {
        policy = await readRobots(target, signal, options);
        policies.set(target.origin, policy);
      }
      if (!policy.allows(target.pathname + target.search)) throw new ImportFailure("robots");
      const response = await readResponse(target, signal, options, MAX_WIRE, MAX_HTML);
      if (isRedirect(response.status)) {
        if (redirects === MAX_REDIRECTS) throw new ImportFailure("redirects");
        target = redirectTarget(response, target);
        sourceUrl = target.href;
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new ImportFailure("unavailable");
      const contentType = header(response, "content-type").split(";")[0]?.trim().toLowerCase();
      if (contentType !== "text/html" && contentType !== "application/xhtml+xml") throw new ImportFailure("content_type");
      // TextDecoder replaces invalid code units; executable markup is never returned.
      const html = new TextDecoder("utf-8").decode(response.body);
      const extracted = extractPage(html, target);
      return boundPreview({ submittedUrl, sourceUrl: target.href, fetchedAt: new Date().toISOString(), ...extracted });
    }
    throw new ImportFailure("redirects");
  } catch (error) {
    const message = signal.aborted ? FAILURE_MESSAGES.timeout : error instanceof ImportFailure ? error.message : FAILURE_MESSAGES.unavailable;
    return { submittedUrl, sourceUrl, fetchedAt: new Date().toISOString(), bookingProvider: "unknown", services: [], warnings: [message] };
  } finally { clearTimeout(timer); }
}

function publicUrl(input: string, base?: URL): URL {
  if (input.length > MAX_URL || /[\u0000-\u0020\u007f]/u.test(input)) throw new ImportFailure("invalid_url");
  let url: URL;
  try { url = base ? new URL(input, base) : new URL(input); } catch { throw new ImportFailure("invalid_url"); }
  const hasUserInfo = Boolean(url.username) || Boolean(url.password);
  if (!['http:', 'https:'].includes(url.protocol) || hasUserInfo || url.port) throw new ImportFailure("invalid_url");
  const hostname = host(url);
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new ImportFailure("unsafe_destination");
  } else if (!hostname.includes(".") || /(^|\.)(localhost|local|internal|invalid|test|example|onion)$/i.test(hostname) || hostname.endsWith(".home.arpa") || hostname === "home.arpa") {
    throw new ImportFailure("unsafe_destination");
  }
  url.hash = "";
  if (url.href.length > MAX_URL) throw new ImportFailure("invalid_url");
  return url;
}

function host(url: URL): string { return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase(); }

/** Conservative global-unicast allowlist; special-purpose ranges fail closed. */
function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    // Azure's platform virtual address is publicly numbered but reaches host
    // services from a VM. Treat it like link-local metadata, never a website.
    if (address === "168.63.129.16") return false;
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 ||
        (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  // IPv4-mapped, translation, local, multicast and unspecified addresses all
  // fall outside 2000::/3. Reject tunnelling/documentation/other special ranges.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  const first = Number.parseInt(normalized.split(":")[0] ?? "0", 16);
  const second = Number.parseInt(normalized.split(":")[1] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    !(first === 0x3fff && second < 0x1000);
}

async function pinnedAddress(url: URL, signal: AbortSignal, options: ImportOptions): Promise<ResolvedAddress> {
  const hostname = host(url);
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family: family as 4 | 6 }] : await abortable(
    options.resolve ? options.resolve(hostname) : lookup(hostname, { all: true, verbatim: true }) as Promise<ResolvedAddress[]>, signal,
  );
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address) || isIP(a.address) !== a.family)) throw new ImportFailure("unsafe_destination");
  return addresses[0]!;
}

async function readResponse(url: URL, signal: AbortSignal, options: ImportOptions, maxWire: number, maxDecoded: number): Promise<ImportResponse> {
  signal.throwIfAborted();
  const address = await pinnedAddress(url, signal, options);
  signal.throwIfAborted();
  const response = await abortable((options.transport ?? nativeTransport)(url, address, signal, maxWire), signal);
  if (response.body.length > maxWire) throw new ImportFailure("too_large");
  const encoding = header(response, "content-encoding").trim().toLowerCase();
  let body = response.body;
  try {
    const settings = { maxOutputLength: maxDecoded };
    if (encoding === "gzip") body = gunzipSync(body, settings);
    else if (encoding === "deflate") body = inflateSync(body, settings);
    else if (encoding === "br") body = brotliDecompressSync(body, settings);
    else if (encoding && encoding !== "identity") throw new ImportFailure("content_type");
  } catch (error) {
    if (error instanceof ImportFailure) throw error;
    throw new ImportFailure("too_large");
  }
  if (body.length > maxDecoded) throw new ImportFailure("too_large");
  return { ...response, body };
}

/** Exported only as a testable transport boundary; callers normally use importWebsite. */
export function nativeTransport(url: URL, address: ResolvedAddress, signal: AbortSignal, maxBytes: number): Promise<ImportResponse> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      method: "GET", agent: false, signal, maxHeaderSize: 16_384,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain;q=0.5", "Accept-Encoding": "gzip,deflate,br" },
      // Keep the URL's Host header and TLS verification/SNI. Only DNS is replaced.
      family: address.family,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const declaredLength = Number(res.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) { res.destroy(new ImportFailure("too_large")); }
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { res.destroy(new ImportFailure("too_large")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(res.headers)) headers[name] = Array.isArray(value) ? value.join(",") : value;
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ImportFailure("timeout"));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new ImportFailure("timeout"));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function header(response: ImportResponse, name: string): string {
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? "";
}
function isRedirect(status: number): boolean { return [301, 302, 303, 307, 308].includes(status); }
function redirectTarget(response: ImportResponse, base: URL): URL {
  const location = header(response, "location");
  if (!location) throw new ImportFailure("unavailable");
  const target = publicUrl(location, base);
  if (base.protocol === "https:" && target.protocol !== "https:") throw new ImportFailure("unsafe_destination");
  return target;
}

interface RobotsRule { readonly allow: boolean; readonly pattern: string; readonly specificity: number }
interface RobotsPolicy { allows(path: string): boolean }

async function readRobots(target: URL, signal: AbortSignal, options: ImportOptions): Promise<RobotsPolicy> {
  try {
    let url = new URL("/robots.txt", target);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await readResponse(url, signal, options, MAX_ROBOTS, MAX_ROBOTS);
      if (isRedirect(response.status)) {
        if (redirects === MAX_REDIRECTS) break;
        url = redirectTarget(response, url);
        continue;
      }
      if (response.status === 404 || response.status === 410) return { allows: () => true };
      if (response.status !== 200) break;
      // HTML challenge/error pages must not accidentally become an allow-all policy.
      if (!header(response, "content-type").toLowerCase().startsWith("text/plain")) break;
      return parseRobots(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
    }
  } catch { /* Fail closed: never fetch a page when source restrictions are unknown. */ }
  throw new ImportFailure("robots");
}

/**
 * Conservative RFC 9309 subset: combine matching PorterBot groups, otherwise
 * wildcard groups; longest matching rule wins, allow wins ties. Supports '*',
 * terminal '$', comments and normalized percent octets. Unknown records are
 * ignored; malformed rules and resource limits block import. Only 404/410
 * count as absent policy. Limits are deliberately stricter than a web crawler.
 */
function parseRobots(source: string): RobotsPolicy {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let group: { agents: string[]; rules: RobotsRule[] } | undefined;
  let rulesStarted = false;
  let totalRules = 0;
  for (const raw of source.replace(/^\uFEFF/, "").split(/\r?\n|\r/)) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) throw new ImportFailure("robots");
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (!/^(?:\*|[a-z_-]+)$/i.test(value)) throw new ImportFailure("robots");
      if (!group || rulesStarted) { group = { agents: [], rules: [] }; groups.push(group); rulesStarted = false; }
      group.agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      rulesStarted = true;
      if (!group || !value) continue;
      if (!value.startsWith("/") || value.length > 512 || (value.match(/\*/g)?.length ?? 0) > 32 || ++totalRules > 1_000) throw new ImportFailure("robots");
      const pattern = normalizePath(value);
      group.rules.push({ allow: key === "allow", pattern, specificity: Buffer.byteLength(pattern.replace(/[\*$]/g, "")) });
    }
  }
  const exact = groups.filter((g) => g.agents.includes("porterbot"));
  const rules = (exact.length ? exact : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  return { allows(path) {
    const normalized = normalizePath(path);
    let selected: RobotsRule | undefined;
    for (const rule of rules) {
      if (wildcardMatch(rule.pattern, normalized) && (!selected || rule.specificity > selected.specificity || (rule.specificity === selected.specificity && rule.allow))) selected = rule;
    }
    return selected?.allow ?? true;
  } };
}

function normalizePath(value: string): string {
  return value.replace(/[^\x21-\x7e]/gu, (char) => encodeURIComponent(char)).replace(/%([0-9a-f]{2})/gi, (_, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return /[a-z0-9_.~-]/i.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

function wildcardMatch(rule: string, path: string): boolean {
  const pattern = rule.endsWith("$") ? rule.slice(0, -1) : `${rule}*`;
  let p = 0; let t = 0; let star = -1; let retry = 0;
  while (t < path.length) {
    if (pattern[p] === "*") { star = p++; retry = t; }
    else if (pattern[p] === path[t]) { p++; t++; }
    else if (star >= 0) { p = star + 1; t = ++retry; }
    else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type RecordValue = Record<string, unknown>;
const BUSINESS_TYPES = new Set(["LocalBusiness", "Organization", "HealthAndBeautyBusiness", "HairSalon", "BeautySalon", "DaySpa", "NailSalon"]);
const HIDDEN_TAGS = new Set(["script", "style", "template", "noscript", "svg"]);

function extractPage(html: string, url: URL): Omit<WebsitePreview, "submittedUrl" | "sourceUrl" | "fetchedAt"> {
  const document = parseBoundedHtml(html);
  const elements: Element[] = [];
  const stack: Node[] = [document];
  let visited = 0;
  while (stack.length && visited++ < 30_000) {
    const node = stack.pop()!;
    if ("tagName" in node) elements.push(node);
    if ("childNodes" in node) stack.push(...node.childNodes.slice().reverse());
  }
  const warnings = [IMPORT_WARNING];
  if (stack.length) warnings.push("The page is complex; only part of its descriptive content was imported.");
  const meta = (key: string) => elements.find((e) => e.tagName === "meta" && (attr(e, "property") ?? attr(e, "name"))?.toLowerCase() === key);
  const nodes: RecordValue[] = [];
  let malformed = false;
  for (const element of elements.filter((e) => e.tagName === "script" && attr(e, "type")?.toLowerCase() === "application/ld+json").slice(0, 20)) {
    try { collectJsonNodes(JSON.parse(rawText(element)), nodes); } catch { malformed = true; }
  }
  if (malformed) warnings.push("Some structured website data could not be read.");
  const businesses = nodes.filter((node) => types(node).some((type) => BUSINESS_TYPES.has(type)));
  const business = businesses.find((node) => types(node).some((type) => type !== "Organization" && BUSINESS_TYPES.has(type))) ?? businesses[0];
  if (businesses.length > 1) warnings.push("The page describes multiple organizations. Confirm the imported business belongs to this salon.");
  const title = elements.find((e) => e.tagName === "title");
  const heading = elements.find((e) => e.tagName === "h1" && visible(e));
  const name = text(business?.name, 160) ?? text(attr(meta("og:site_name"), "content"), 160) ?? text(heading && visibleText(heading), 160) ?? text(title && rawText(title), 160);
  const description = text(business?.description, 1_000) ?? text(attr(meta("description"), "content"), 1_000) ?? text(attr(meta("og:description"), "content"), 1_000);
  const address = addressText(business?.address);
  const telephoneLink = elements.find((e) => e.tagName === "a" && attr(e, "href")?.toLowerCase().startsWith("tel:"));
  const phone = text(business?.telephone, 80) ?? text(attr(telephoneLink, "href")?.slice(4), 80);
  const serviceNodes = nodes.filter((node) => types(node).includes("Service"));
  const services = extractServices(business, serviceNodes, url.href);
  const candidates: unknown[] = [];
  const action = record(business?.potentialAction);
  candidates.push(record(action?.target)?.urlTemplate, action?.target, action?.url);
  for (const element of elements) {
    if (element.tagName !== "a" || !visible(element)) continue;
    const href = attr(element, "href");
    if (href && (/book|appointment|reserve/i.test(visibleText(element)) || isSquareUrl(href, url))) candidates.push(href);
  }
  let bookingUrl: string | undefined;
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try { const safe = publicUrl(candidate, url); if (!bookingUrl || isSquareUrl(safe.href, url)) bookingUrl = safe.href; } catch { /* Ignore unsafe outbound links. */ }
    if (bookingUrl && isSquareUrl(bookingUrl, url)) break;
  }
  const square = isSquareUrl(url.href, url) || Boolean(bookingUrl && isSquareUrl(bookingUrl, url));
  if (!name || (!description && services.length === 0)) warnings.push("This page provides limited readable information and may require JavaScript. Review missing details manually; Porter does not execute website scripts.");
  if (!services.length) warnings.push("No structured services were found. Connect Square to import its authoritative services.");
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), ...(address ? { address } : {}), ...(phone ? { phone } : {}), bookingProvider: square ? "square" : "unknown", ...(bookingUrl ? { bookingUrl } : {}), services, warnings };
}

function parseBoundedHtml(html: string): DefaultTreeAdapterTypes.Document {
  if (Buffer.byteLength(html, "utf8") > MAX_PARSE_BYTES) throw new ImportFailure("complex");
  // Count every marker, including those in comments, scripts and attributes.
  // This intentionally rejects some complex pages rather than trying to parse
  // HTML a second time with a regex or allowing malformed markup past the cap.
  let markers = 0;
  let words = 0;
  let inWord = false;
  let markupStart = -1;
  let quote = "";
  for (let index = 0; index < html.length; index++) {
    const character = html[index];
    // This global bound is independent of HTML comment/raw-text/quote state.
    // Valid attributes need HTML whitespace separation; malformed separators
    // abort through onParseError below. Bound total attributes before parse5's
    // duplicate-attribute scan can accumulate quadratic work.
    const whitespace = character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
    if (!whitespace && !inWord && ++words > 4_000) throw new ImportFailure("complex");
    inWord = !whitespace;
    if (character === "<") {
      if (++markers > MAX_MARKUP_MARKERS) throw new ImportFailure("complex");
      if (markupStart === -1) markupStart = index;
    }
    if (markupStart === -1) continue;
    // Very large attribute lists can also make tokenization quadratic. Quotes
    // cannot hide a long tag by placing an apparent closing '>' inside a value.
    if (index - markupStart > MAX_MARKUP_LENGTH) throw new ImportFailure("complex");
    if (quote) { if (character === quote) quote = ""; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === ">") markupStart = -1;
  }
  let elements = 0;
  function checkDepth(parent: DefaultTreeAdapterTypes.ParentNode): void {
    let node: Node | null = parent;
    for (let depth = 0; node; depth++) {
      if (depth >= MAX_PARSE_DEPTH) throw new ImportFailure("complex");
      node = "parentNode" in node ? node.parentNode : null;
    }
  }
  return parse(html, {
    // Malformed attribute syntax can disagree with the conservative quote scan
    // above. Stop at the parser's first error, before a long attribute list can
    // accumulate quadratic work. A missing doctype is harmless for extraction.
    onParseError(error) { if (error.code !== "missing-doctype") throw new ImportFailure("complex"); },
    treeAdapter: {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      if (++elements > MAX_PARSE_ELEMENTS) throw new ImportFailure("complex");
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    appendChild(parent, child) {
      checkDepth(parent);
      defaultTreeAdapter.appendChild(parent, child);
    },
    insertBefore(parent, child, reference) {
      checkDepth(parent);
      defaultTreeAdapter.insertBefore(parent, child, reference);
    },
  } });
}

/** All callers receive a snapshot that fits beneath the database's 64 KiB cap. */
function boundPreview(preview: WebsitePreview): WebsitePreview {
  const size = (value: WebsitePreview) => Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size(preview) <= MAX_PREVIEW_BYTES) return preview;
  const bounded = { ...preview, services: preview.services.map((service) => ({ ...service })), warnings: [...preview.warnings, PREVIEW_WARNING] };
  for (let index = bounded.services.length - 1; index >= 0 && size(bounded) > MAX_PREVIEW_BYTES; index--) {
    delete bounded.services[index]!.description;
  }
  while (bounded.services.length && size(bounded) > MAX_PREVIEW_BYTES) bounded.services.pop();
  // Scalar fields have individual limits. Keep this fallback so a future field
  // cannot turn an import into a failed draft write instead of manual review.
  if (size(bounded) > MAX_PREVIEW_BYTES) {
    return { submittedUrl: preview.submittedUrl, sourceUrl: preview.sourceUrl, fetchedAt: preview.fetchedAt,
      bookingProvider: "unknown", services: [], warnings: [IMPORT_WARNING, PREVIEW_WARNING] };
  }
  return bounded;
}

function attr(element: Element | undefined, name: string): string | undefined { return element?.attrs.find((a) => a.name === name)?.value; }
function rawText(element: Element): string { return element.childNodes.filter((n): n is DefaultTreeAdapterTypes.TextNode => n.nodeName === "#text").map((n) => n.value).join(""); }
function visible(element: Element): boolean {
  let node: Node | null = element;
  for (let depth = 0; node && depth < 100; depth++) {
    if ("tagName" in node && (HIDDEN_TAGS.has(node.tagName) || attr(node, "hidden") !== undefined || attr(node, "aria-hidden") === "true" || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attr(node, "style") ?? ""))) return false;
    node = "parentNode" in node ? node.parentNode : null;
  }
  return node === null;
}
function visibleText(element: Element): string {
  const stack: Node[] = [element]; const chunks: string[] = [];
  let count = 0;
  while (stack.length && count++ < 500) {
    const node = stack.pop()!;
    if ("tagName" in node && !visible(node)) continue;
    if (node.nodeName === "#text") chunks.push((node as DefaultTreeAdapterTypes.TextNode).value);
    if ("childNodes" in node) stack.push(...node.childNodes.slice().reverse());
  }
  return chunks.join(" ");
}
function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitize(value, { maxLength: limit }).replace(/\s+/g, " ").trim() || undefined;
}
function record(value: unknown): RecordValue | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined; }
function types(value: RecordValue): string[] { const type = value["@type"]; return typeof type === "string" ? [type] : Array.isArray(type) ? type.filter((t): t is string => typeof t === "string") : []; }
function collectJsonNodes(value: unknown, out: RecordValue[]): void {
  const pending = [{ value, depth: 0 }]; let count = 0;
  while (pending.length && count++ < 500 && out.length < 500) {
    const item = pending.pop()!;
    if (item.depth > 12) continue;
    if (Array.isArray(item.value)) { for (const entry of item.value.slice(0, 100)) pending.push({ value: entry, depth: item.depth + 1 }); }
    else {
      const object = record(item.value);
      if (!object) continue;
      out.push(object);
      for (const nested of Object.values(object).slice(0, 50)) if (nested && typeof nested === "object") pending.push({ value: nested, depth: item.depth + 1 });
    }
  }
}
function addressText(value: unknown): string | undefined {
  if (typeof value === "string") return text(value, 400);
  const address = record(value);
  if (!address) return undefined;
  const parts = [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode, address.addressCountry].map((p) => text(p, 120)).filter(Boolean);
  return parts.length ? text(parts.join(", "), 400) : undefined;
}
function extractServices(business: RecordValue | undefined, standalone: RecordValue[], sourceUrl: string): ImportedService[] {
  const catalog = record(business?.hasOfferCatalog);
  const offers = catalog?.itemListElement ?? business?.makesOffer;
  const pending: unknown[] = [...(Array.isArray(offers) ? offers.slice(0, 100) : []), ...standalone];
  const services: ImportedService[] = []; const seen = new Set<string>();
  let count = 0;
  while (pending.length && count++ < 200 && services.length < 50) {
    const entry = record(pending.shift()); if (!entry) continue;
    if (Array.isArray(entry.itemListElement)) { pending.push(...entry.itemListElement.slice(0, 100)); continue; }
    const offered = record(entry.itemOffered) ?? entry;
    const name = text(offered.name ?? entry.name, 160); if (!name || seen.has(name)) continue;
    seen.add(name);
    const offer = record(offered.offers) ?? entry;
    const price = offer.price ?? record(offer.priceSpecification)?.price;
    const currency = text(offer.priceCurrency ?? record(offer.priceSpecification)?.priceCurrency, 12);
    const priceText = typeof price === "string" || (typeof price === "number" && Number.isFinite(price)) ? text(`${price}${currency ? ` ${currency}` : ""}`, 100) : undefined;
    const description = text(offered.description, 600);
    const durationText = text(offered.duration ?? entry.duration, 80);
    services.push({ name, ...(description ? { description } : {}), ...(priceText ? { priceText } : {}), ...(durationText ? { durationText } : {}), sourceUrl });
  }
  return services;
}
function isSquareUrl(value: string, base: URL): boolean {
  try { const hostname = host(publicUrl(value, base)); return hostname === "square.site" || hostname.endsWith(".square.site") || hostname === "squareup.com" || hostname.endsWith(".squareup.com"); } catch { return false; }
}

import { PorterError } from "./errors.js";

/**
 * The HTTP port every remote adapter talks through.
 *
 * Adapters depend on this interface, never on `fetch` directly. That is what
 * lets the conformance suite run an adapter against a wire-level fake of the
 * real platform: same request construction, same response parsing, same
 * mapping, no network.
 */
export interface HttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export interface FetchHttpClientOptions {
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly userAgent?: string;
  readonly fetchImpl?: typeof fetch;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Real client.
 *
 * Retries only on transport failures and the status codes where a retry is
 * actually safe. It honours `Retry-After`, and it never retries a 4xx other
 * than 408 and 429 — a rejected booking must not be silently resent.
 */
export function createFetchHttpClient(options: FetchHttpClientOptions = {}): HttpClient {
  const { timeoutMs = 12_000, maxRetries = 2, userAgent = "Porter/0.1 (+https://github.com/porter)" } = options;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async send(request) {
      let lastError: unknown;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        request.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await doFetch(request.url, {
            method: request.method,
            headers: {
              accept: "application/json",
              "user-agent": userAgent,
              ...(request.body === undefined ? {} : { "content-type": "application/json" }),
              ...request.headers,
            },
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            signal: controller.signal,
          });

          const text = await response.text();
          let body: unknown = null;
          if (text) {
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
          }

          if (RETRYABLE.has(response.status) && attempt < maxRetries) {
            const retryAfter = Number(response.headers.get("retry-after") ?? 0);
            await delay(retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt), request.signal);
            continue;
          }

          const headers: Record<string, string> = {};
          response.headers.forEach((v, k) => {
            headers[k.toLowerCase()] = v;
          });
          return { status: response.status, headers, body };
        } catch (error) {
          lastError = error;
          if (request.signal?.aborted) {
            throw new PorterError("ADAPTER_DOWN", "That request was cancelled.", { cause: error });
          }
          if (attempt >= maxRetries) break;
          await delay(backoffMs(attempt), request.signal);
        } finally {
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
        }
      }

      throw new PorterError("ADAPTER_DOWN", "That booking system is not responding right now. Try again in a moment.", {
        cause: lastError,
      });
    },
  };
}

function backoffMs(attempt: number): number {
  // Exponential with jitter, so a platform outage does not produce a
  // synchronised retry storm from every Porter instance at once.
  return Math.min(2000, 200 * 2 ** attempt) + Math.floor(Math.random() * 100);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new PorterError("ADAPTER_DOWN", "That request was cancelled."));
      },
      { once: true },
    );
  });
}

/** Guard every adapter entry point, so an aborted call fails the same way. */
export function assertNotAborted(signal: AbortSignal, adapterId: string): void {
  if (signal.aborted) {
    throw new PorterError("ADAPTER_DOWN", "That request was cancelled.", { details: { adapter: adapterId } });
  }
}

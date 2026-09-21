import type { HttpClient, HttpRequest, HttpResponse } from "@porter/shared";
import fixture from "../fixtures/green-room.json" with { type: "json" };

/**
 * Serves a Square booking page built from a real one.
 *
 * `green-room.json` was captured from a live public booking page on
 * 2026-09-21 and trimmed to three services: one fixed-price, one with
 * variations and a price range in free text, and one carrying a per-variation
 * no-show fee. The shapes are real, not invented.
 */
export function renderWidgetPage(widget: unknown = fixture): string {
  const json = JSON.stringify(widget)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><html><head><title>Book Appointments</title>
<meta name="widget" content="${json}" />
</head><body><div id="root"></div></body></html>`;
}

export interface FakeSquarePageOptions {
  readonly pages?: Readonly<Record<string, { status?: number; html: string }>>;
}

export class FakeSquarePage implements HttpClient {
  readonly requests: string[] = [];
  readonly #pages: Readonly<Record<string, { status?: number; html: string }>>;

  constructor(options: FakeSquarePageOptions = {}) {
    this.#pages = options.pages ?? {};
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    if (request.signal?.aborted) throw new Error("aborted");
    this.requests.push(request.url);
    const page = this.#pages[request.url];
    if (!page) return { status: 404, headers: {}, body: "<html><body>Not found</body></html>" };
    return { status: page.status ?? 200, headers: { "content-type": "text/html" }, body: page.html };
  }
}

export const GREEN_ROOM = fixture as Record<string, unknown>;

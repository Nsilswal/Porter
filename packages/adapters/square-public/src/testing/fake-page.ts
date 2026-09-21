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
  /** When true, the buyer availability call returns one open slot. Otherwise it returns none. */
  readonly openSlots?: boolean;
  /** When true, holding a time is rejected the way a taken slot is. */
  readonly slotTaken?: boolean;
}

export class FakeSquarePage implements HttpClient {
  readonly requests: string[] = [];
  readonly bodies: unknown[] = [];
  openSlots: boolean;
  slotTaken: boolean;
  readonly #pages: Readonly<Record<string, { status?: number; html: string }>>;

  constructor(options: FakeSquarePageOptions = {}) {
    this.#pages = options.pages ?? {};
    this.openSlots = options.openSlots ?? false;
    this.slotTaken = options.slotTaken ?? false;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    if (request.signal?.aborted) throw new Error("aborted");
    this.requests.push(request.url);
    this.bodies.push(request.body);
    if (request.url.startsWith("https://app.squareup.com/appointments/api/buyer/")) return this.#buyer(request);

    const page = this.#pages[request.url];
    if (!page) return { status: 404, headers: {}, body: "<html><body>Not found</body></html>" };
    return { status: page.status ?? 200, headers: { "content-type": "text/html" }, body: page.html };
  }

  #buyer(request: HttpRequest): HttpResponse {
    const url = request.url;
    const body = (request.body ?? {}) as {
      id?: string;
      date_start?: string;
      date_end?: string;
      unit_token?: string;
      current_buyer?: { email?: string };
      search_availability_request?: {
        query?: { filter?: { start_at_range?: { start_at?: string }; segment_filters?: readonly { team_member_id_filter?: { any?: readonly string[] } }[] } };
      };
    };
    const json = (status: number, payload: unknown): HttpResponse => ({ status, headers: { "content-type": "application/json" }, body: payload });

    if (url.endsWith("/availability")) {
      if (!this.openSlots) return json(200, { availability: [] });
      const startAt = body.search_availability_request?.query?.filter?.start_at_range?.start_at;
      const start = Math.floor(Date.parse(startAt ?? "") / 1000);
      const staff = body.search_availability_request?.query?.filter?.segment_filters?.[0]?.team_member_id_filter?.any?.[0] ?? null;
      return json(200, {
        availability: [{ start, end: start + 2700, available: true, staff_id: "staff", segments: [{ employee_token: staff, start, end: start + 2700 }] }],
      });
    }
    if (url.endsWith("/reserved_times")) {
      if (this.slotTaken) return json(422, { errors: { base: ["That time is no longer available"] } });
      return json(201, { id: "hold1", date_start: body.date_start, date_end: body.date_end, order: { id: "order1" } });
    }
    if (url.includes("/current_buyer/")) {
      if (body.current_buyer?.email?.endsWith("@example.com")) return json(422, { errors: { email: ["is invalid"] } });
      return json(200, { current_buyer: { contact_token: "contact1", unit_token: body.unit_token } });
    }
    if (url.endsWith("/reservations/cancel")) {
      return json(200, { id: body.id, status: "cancelled_by_buyer", is_cancelled: true, date_start: body.date_start, date_end: body.date_end });
    }
    if (url.endsWith("/reservations")) {
      return json(201, { id: body.id, status: "accepted", is_cancelled: false, date_start: body.date_start, date_end: body.date_end });
    }
    return json(404, {});
  }
}

export const GREEN_ROOM = fixture as Record<string, unknown>;

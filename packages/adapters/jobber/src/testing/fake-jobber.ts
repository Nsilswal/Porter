import type { HttpClient, HttpRequest, HttpResponse } from "@porter/shared";
import type { JobberRequest } from "../api.js";

/**
 * A GraphQL-level fake of Jobber.
 *
 * It routes on operation name, returns Jobber's response envelope including
 * `userErrors` and `extensions.cost`, and holds enough state for a request to
 * be created, edited and archived.
 *
 * Same caveat as the Square fake, and it matters more here: Jobber's full
 * schema is behind a developer login, so the mutation inputs this fake accepts
 * are inferred rather than verified. See the header of ../api.ts. This adapter
 * must not be pointed at a real Jobber account until those are confirmed
 * against a sandbox.
 */
export interface FakeJobberOptions {
  readonly failWith?: { status: number; message: string; code?: string };
  /** Force a userErrors response from the named mutation. */
  readonly userErrorOn?: string;
  readonly accessToken?: string;
  /** Report a nearly exhausted query budget, to exercise the warning path. */
  readonly lowBudget?: boolean;
}

export class FakeJobber implements HttpClient {
  readonly requests = new Map<string, JobberRequest>();
  readonly clients = new Map<string, unknown>();
  readonly properties = new Map<string, unknown>();
  readonly operations: { name: string; variables: Record<string, unknown> }[] = [];
  readonly #options: FakeJobberOptions;
  #counter = 0;

  constructor(options: FakeJobberOptions = {}) {
    this.#options = options;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    if (request.signal?.aborted) throw new Error("aborted");

    const auth = request.headers?.authorization ?? "";
    const expected = this.#options.accessToken ?? "sandbox-token";
    if (auth !== `Bearer ${expected}`) {
      return this.#json(401, { errors: [{ message: "Unauthenticated", extensions: { code: "UNAUTHENTICATED" } }] });
    }
    // Jobber rejects a request that does not pin an API version.
    if (!request.headers?.["x-jobber-graphql-version"]) {
      return this.#json(400, { errors: [{ message: "Missing X-JOBBER-GRAPHQL-VERSION", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] });
    }

    const fail = this.#options.failWith;
    if (fail) {
      return this.#json(fail.status, { errors: [{ message: fail.message, extensions: { code: fail.code ?? "INTERNAL" } }] });
    }

    const body = request.body as { query: string; variables: Record<string, unknown> };
    const name = operationName(body.query);
    this.operations.push({ name, variables: body.variables ?? {} });

    switch (name) {
      case "PorterAccount":
        return this.#json(200, { data: { account: { id: "ACC_JOBBER_1", name: "Bayside Plumbing Co." } } });

      case "PorterClientCreate": {
        if (this.#options.userErrorOn === "clientCreate") {
          return this.#json(200, { data: { clientCreate: { client: null, userErrors: [{ message: "Email is invalid", path: ["input", "emails"] }] } } });
        }
        const id = `CLI_${++this.#counter}`;
        this.clients.set(id, body.variables.input);
        return this.#json(200, { data: { clientCreate: { client: { id, firstName: "Sam" }, userErrors: [] } } });
      }

      case "PorterPropertyCreate": {
        const id = `PROP_${++this.#counter}`;
        this.properties.set(id, body.variables.input);
        return this.#json(200, { data: { propertyCreate: { property: { id }, userErrors: [] } } });
      }

      case "PorterRequestCreate": {
        if (this.#options.userErrorOn === "requestCreate") {
          return this.#json(200, { data: { requestCreate: { request: null, userErrors: [{ message: "Property required", path: ["input", "propertyId"] }] } } });
        }
        const input = body.variables.input as { title?: string; arrivalWindow?: { startAt: string; endAt: string } };
        const id = `REQ_${++this.#counter}`;
        const now = new Date().toISOString();
        const created: JobberRequest = {
          id,
          requestStatus: "requires_scheduling",
          createdAt: now,
          updatedAt: now,
          ...(input.title ? { title: input.title } : {}),
          ...(input.arrivalWindow ? { arrivalWindow: input.arrivalWindow } : {}),
        };
        this.requests.set(id, created);
        return this.#json(200, { data: { requestCreate: { request: created, userErrors: [] } } });
      }

      case "PorterRequest": {
        const id = body.variables.id as string;
        const found = this.requests.get(id);
        return this.#json(200, { data: { request: found ?? null } });
      }

      case "PorterRequests":
        return this.#json(200, {
          data: {
            requests: {
              nodes: [...this.requests.values()],
              pageInfo: { endCursor: null, hasNextPage: false },
              totalCount: this.requests.size,
            },
          },
        });

      case "PorterRequestEdit": {
        const id = body.variables.id as string;
        const existing = this.requests.get(id);
        if (!existing) return this.#json(200, { errors: [{ message: "Request not found", extensions: { code: "NOT_FOUND" } }] });
        const input = body.variables.input as { arrivalWindow?: { startAt: string; endAt: string } };
        const updated: JobberRequest = { ...existing, updatedAt: new Date().toISOString(), ...(input.arrivalWindow ? { arrivalWindow: input.arrivalWindow } : {}) };
        this.requests.set(id, updated);
        return this.#json(200, { data: { requestEdit: { request: updated, userErrors: [] } } });
      }

      case "PorterRequestArchive": {
        const id = body.variables.id as string;
        const existing = this.requests.get(id);
        if (!existing) return this.#json(200, { errors: [{ message: "Request not found", extensions: { code: "NOT_FOUND" } }] });
        const updated: JobberRequest = { ...existing, requestStatus: "archived", updatedAt: new Date().toISOString() };
        this.requests.set(id, updated);
        return this.#json(200, { data: { requestArchive: { request: updated, userErrors: [] } } });
      }

      default:
        return this.#json(200, { errors: [{ message: `Unknown operation ${name}`, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] });
    }
  }

  #json(status: number, body: Record<string, unknown>): HttpResponse {
    const maximumAvailable = 10_000;
    const currentlyAvailable = this.#options.lowBudget ? 500 : 9_000;
    return {
      status,
      headers: { "content-type": "application/json" },
      body: {
        ...body,
        extensions: { cost: { requestedQueryCost: 10, actualQueryCost: 8, throttleStatus: { maximumAvailable, currentlyAvailable, restoreRate: 100 } } },
      },
    };
  }
}

function operationName(query: string): string {
  const match = /\b(?:query|mutation)\s+(\w+)/.exec(query);
  return match?.[1] ?? "unknown";
}

export const JOBBER_TEST_TOKEN = "sandbox-token";

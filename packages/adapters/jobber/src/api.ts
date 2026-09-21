/**
 * Jobber GraphQL documents and wire types.
 *
 * ---------------------------------------------------------------------------
 * VERIFICATION STATUS — read before trusting anything in this file.
 * ---------------------------------------------------------------------------
 * Jobber publishes its full schema only behind a developer login, so these
 * documents are split by how well they are corroborated. Everything is in one
 * file so there is exactly one place to reconcile against the real schema once
 * sandbox access exists.
 *
 * VERIFIED from Jobber's own published material:
 *   - endpoint https://api.getjobber.com/api/graphql
 *   - required header X-JOBBER-GRAPHQL-VERSION (dated, e.g. 2023-11-15)
 *   - Bearer token auth via OAuth 2.0
 *   - Relay connections: nodes / pageInfo { endCursor hasNextPage } / totalCount
 *   - mutations return the entity plus userErrors { message path }
 *   - clientCreate(input:) with firstName, lastName, companyName and
 *     emails: [{ description: MAIN, primary: true, address }]
 *   - query cost accounting in extensions.cost, leaky-bucket throttling, and
 *     a separate 2500-requests-per-5-minutes limit
 *
 * UNVERIFIED — shapes inferred from Jobber's documented domain model. These
 * are the ones to check first:
 *   - propertyCreate, requestCreate, requestEdit input field names
 *   - Request.arrivalWindow structure
 *   - the exact enum for request status
 *
 * Until they are confirmed against a Jobber sandbox, this adapter is tested
 * only against the fake in ./testing/fake-jobber.ts. It must not be pointed at
 * a real Jobber account. See docs/plan.md, milestone 3.
 */

export const JOBBER_ENDPOINT = "https://api.getjobber.com/api/graphql";
export const JOBBER_API_VERSION = "2023-11-15";

export interface GraphQLError {
  readonly message: string;
  readonly extensions?: { readonly code?: string };
}

export interface UserError {
  readonly message: string;
  readonly path?: readonly string[];
}

export interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: readonly GraphQLError[];
  readonly extensions?: {
    readonly cost?: {
      readonly requestedQueryCost?: number;
      readonly actualQueryCost?: number;
      readonly throttleStatus?: {
        readonly maximumAvailable?: number;
        readonly currentlyAvailable?: number;
        readonly restoreRate?: number;
      };
    };
  };
}

export interface JobberAccount {
  readonly id: string;
  readonly name?: string;
}

export interface JobberClient {
  readonly id: string;
  readonly firstName?: string;
  readonly lastName?: string;
}

export interface JobberProperty {
  readonly id: string;
  readonly address?: {
    readonly street1?: string;
    readonly street2?: string;
    readonly city?: string;
    readonly province?: string;
    readonly postalCode?: string;
    readonly country?: string;
  };
}

export interface JobberArrivalWindow {
  readonly startAt: string;
  readonly endAt: string;
}

export type JobberRequestStatus = "requires_scheduling" | "scheduled" | "converted" | "archived" | "completed";

export interface JobberRequest {
  readonly id: string;
  readonly title?: string;
  readonly requestStatus?: JobberRequestStatus;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly arrivalWindow?: JobberArrivalWindow;
  readonly client?: JobberClient;
  readonly property?: JobberProperty;
}

export interface JobberQuote {
  readonly id: string;
  readonly quoteNumber?: number;
  readonly amounts?: { readonly total?: number; readonly subtotal?: number };
  readonly message?: string;
  readonly createdAt?: string;
}

// --------------------------------------------------------------- documents

export const ACCOUNT_QUERY = /* GraphQL */ `
  query PorterAccount {
    account {
      id
      name
    }
  }
`;

export const REQUESTS_QUERY = /* GraphQL */ `
  query PorterRequests($first: Int!, $after: String) {
    requests(first: $first, after: $after) {
      nodes {
        id
        title
        requestStatus
        createdAt
        updatedAt
        arrivalWindow {
          startAt
          endAt
        }
        property {
          id
        }
      }
      pageInfo {
        endCursor
        hasNextPage
      }
      totalCount
    }
  }
`;

export const REQUEST_QUERY = /* GraphQL */ `
  query PorterRequest($id: EncodedId!) {
    request(id: $id) {
      id
      title
      requestStatus
      createdAt
      updatedAt
      arrivalWindow {
        startAt
        endAt
      }
    }
  }
`;

export const CLIENT_CREATE = /* GraphQL */ `
  mutation PorterClientCreate($input: ClientCreateInput!) {
    clientCreate(input: $input) {
      client {
        id
        firstName
        lastName
      }
      userErrors {
        message
        path
      }
    }
  }
`;

export const PROPERTY_CREATE = /* GraphQL */ `
  mutation PorterPropertyCreate($clientId: EncodedId!, $input: PropertyCreateInput!) {
    propertyCreate(clientId: $clientId, input: $input) {
      property {
        id
      }
      userErrors {
        message
        path
      }
    }
  }
`;

export const REQUEST_CREATE = /* GraphQL */ `
  mutation PorterRequestCreate($input: RequestCreateInput!) {
    requestCreate(input: $input) {
      request {
        id
        title
        requestStatus
        createdAt
        updatedAt
        arrivalWindow {
          startAt
          endAt
        }
      }
      userErrors {
        message
        path
      }
    }
  }
`;

export const REQUEST_EDIT = /* GraphQL */ `
  mutation PorterRequestEdit($id: EncodedId!, $input: RequestEditInput!) {
    requestEdit(id: $id, input: $input) {
      request {
        id
        requestStatus
        updatedAt
        arrivalWindow {
          startAt
          endAt
        }
      }
      userErrors {
        message
        path
      }
    }
  }
`;

export const REQUEST_ARCHIVE = /* GraphQL */ `
  mutation PorterRequestArchive($id: EncodedId!) {
    requestArchive(id: $id) {
      request {
        id
        requestStatus
        updatedAt
      }
      userErrors {
        message
        path
      }
    }
  }
`;

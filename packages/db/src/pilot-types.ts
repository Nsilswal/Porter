export type SquareEnvironment = "sandbox" | "production";
export type BusinessStatus = "draft" | "active" | "paused";
export type ConnectionStatus = "connected" | "reconnect_required" | "disconnecting" | "disconnected";

export interface EmailIdentity {
  readonly userId: string;
  readonly email: string;
  readonly createdAt: Date;
}

export interface PilotSession {
  readonly userId: string;
  readonly sessionHash: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

export interface ConnectorCredential {
  readonly id: string;
  readonly userId: string;
  readonly label: string;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

export interface PilotBusiness {
  readonly id: string;
  readonly ownerId: string;
  readonly websiteUrl: string;
  readonly name: string;
  readonly status: BusinessStatus;
  readonly selectedLocationId: string | null;
  readonly profile: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SquareOAuthState {
  readonly stateHash: string;
  readonly userId: string;
  readonly sessionHash: string;
  readonly businessId: string;
  readonly environment: SquareEnvironment;
  readonly expiresAt: Date;
  readonly connectionVersion: number | null;
}

/** Safe for owner responses. Tokens are available only through readCredentials. */
export interface MerchantConnection {
  readonly businessId: string;
  readonly environment: SquareEnvironment;
  readonly merchantId: string;
  readonly status: ConnectionStatus;
  readonly version: number;
  readonly expiresAt: Date;
  readonly scopes: string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly refreshedAt: Date;
}

export interface MerchantCredentials extends MerchantConnection {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface NewMerchantCredentials {
  readonly businessId: string;
  readonly environment: SquareEnvironment;
  readonly merchantId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  readonly scopes: string[];
}

/** Server-only durable identity and merchant storage; no in-memory fallback. */
export interface PilotStore {
  health(): Promise<void>;
  close(): Promise<void>;
  readonly rateLimits: {
    /** Fixed windows shared by all processes. Only the namespace/key hash is persisted. */
    take(input: { keyHash: string; limit: number; windowMs: number; now: Date }): Promise<boolean>;
  };
  readonly identities: {
    getOrCreate(email: string): Promise<EmailIdentity>;
    get(userId: string): Promise<EmailIdentity | null>;
  };
  readonly loginTokens: {
    issue(input: { tokenHash: string; browserNonceHash: string; userId: string; expiresAt: Date }): Promise<void>;
    /** A wrong browser never spends the token. Session insertion and spending are atomic. */
    consume(input: { tokenHash: string; browserNonceHash: string; sessionHash: string; sessionExpiresAt: Date; now: Date }): Promise<PilotSession | null>;
  };
  readonly sessions: {
    lookup(sessionHash: string, now: Date): Promise<PilotSession | null>;
    revoke(userId: string, sessionHash: string): Promise<boolean>;
  };
  readonly connectors: {
    issue(input: { id: string; userId: string; tokenHash: string; label: string }): Promise<ConnectorCredential>;
    list(userId: string): Promise<ConnectorCredential[]>;
    lookup(tokenHash: string): Promise<ConnectorCredential | null>;
    revoke(userId: string, id: string): Promise<boolean>;
  };
  readonly businesses: {
    create(input: { id: string; ownerId: string; websiteUrl: string; name: string; profile?: Record<string, unknown> }): Promise<PilotBusiness>;
    get(ownerId: string, businessId: string): Promise<PilotBusiness | null>;
    /** Server-only access for booking routing and existing booking management. */
    getById(businessId: string): Promise<PilotBusiness | null>;
    list(ownerId: string): Promise<PilotBusiness[]>;
    /** The first selected location is permanent for this business, including reconnects. */
    update(ownerId: string, businessId: string, input: { name?: string; profile?: Record<string, unknown>; status?: BusinessStatus; selectedLocationId?: string }): Promise<PilotBusiness | null>;
    /** Server-only routing; exposes active businesses, never merchant credentials. */
    listActive(): Promise<PilotBusiness[]>;
  };
  readonly oauthStates: {
    issue(input: SquareOAuthState): Promise<void>;
    consume(input: { stateHash: string; userId: string; sessionHash: string; environment: SquareEnvironment; now: Date }): Promise<SquareOAuthState | null>;
  };
  readonly connections: {
    get(ownerId: string, businessId: string, environment: SquareEnvironment): Promise<MerchantConnection | null>;
    /** Initial connect or reauthorization. Merchant identity can never change. */
    connect(ownerId: string, input: NewMerchantCredentials, expectedVersion: number | null, sessionHash: string): Promise<MerchantConnection>;
    /** Explicit server-only access. Disconnected/reconnect-required credentials are unavailable. */
    readCredentials(businessId: string, environment: SquareEnvironment): Promise<MerchantCredentials | null>;
    /** Compare-and-swap stops refresh/reconnect/disconnect races from resurrecting tokens. */
    replaceCredentials(input: NewMerchantCredentials, expectedVersion: number): Promise<MerchantConnection | null>;
    markReconnect(businessId: string, environment: SquareEnvironment, expectedVersion: number): Promise<boolean>;
    /**
     * Disables use and gives credentials only to the first revocation claimant.
     * Null means already claimed, disconnected, absent, or not owned. An uncertain
     * remote revocation retains its claim until explicit operator reconciliation.
     */
    beginDisconnect(ownerId: string, businessId: string, environment: SquareEnvironment): Promise<MerchantCredentials | null>;
    finishDisconnect(ownerId: string, businessId: string, environment: SquareEnvironment, expectedVersion: number): Promise<boolean>;
    /** Server-only operator reconciliation list. It does not authorize retrying revocation. */
    listPendingRevocations(): Promise<MerchantConnection[]>;
  };
}

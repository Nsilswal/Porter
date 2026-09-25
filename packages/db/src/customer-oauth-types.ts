/** Public OAuth clients have registered redirect URIs and no client secret. */
export interface OAuthClient {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: string[];
  readonly createdAt: Date;
}

/** Safe to render after the caller proves possession of the initiating browser nonce. */
export interface OAuthAuthorizationRequest {
  readonly requestHash: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly scopes: string[];
  readonly codeChallenge: string;
  readonly state: string | null;
  readonly expiresAt: Date;
}

/** One consent grant is also one refresh-token family; its expiry never slides. */
export interface OAuthGrant {
  readonly id: string;
  readonly userId: string;
  readonly clientId: string;
  readonly resource: string;
  readonly scopes: string[];
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

interface ConsentInput {
  requestHash: string;
  browserNonceHash: string;
  userId: string;
  sessionHash: string;
  now: Date;
}

/** Server-only durable OAuth storage. All bearer material arrives already SHA-256 hashed. */
export interface CustomerOAuthStore {
  health(): Promise<void>;
  close(): Promise<void>;
  readonly clients: {
    /** Registrations are immutable. Redirect and resource policy is additionally enforced by the protocol layer. */
    register(input: { id: string; name: string; redirectUris: string[]; now: Date }): Promise<OAuthClient>;
    get(id: string): Promise<OAuthClient | null>;
  };
  readonly requests: {
    issue(input: OAuthAuthorizationRequest & { browserNonceHash: string; now: Date }): Promise<void>;
    get(requestHash: string, browserNonceHash: string, now: Date): Promise<OAuthAuthorizationRequest | null>;
    /** Consent, request spending, and code insertion are one transaction with a live user/session check. */
    approve(input: ConsentInput & { codeHash: string; codeExpiresAt: Date }): Promise<OAuthAuthorizationRequest | null>;
    deny(input: ConsentInput): Promise<OAuthAuthorizationRequest | null>;
  };
  readonly tokens: {
    /** Compare the S256 verifier digest and all bindings before spending. Correctly bound code replay revokes its grant. */
    exchangeCode(input: {
      codeHash: string; clientId: string; redirectUri: string; resource: string; codeChallenge: string;
      grantId: string; accessTokenHash: string; accessExpiresAt: Date; refreshTokenHash: string; refreshExpiresAt: Date; now: Date;
    }): Promise<OAuthGrant | null>;
    /** Serial rotation; reuse of any spent refresh hash revokes the whole family. Expiry never extends. */
    refresh(input: {
      refreshTokenHash: string; clientId: string; resource: string; accessTokenHash: string;
      accessExpiresAt: Date; newRefreshTokenHash: string; scopes?: readonly string[]; now: Date;
    }): Promise<OAuthGrant | null>;
    lookupAccess(accessTokenHash: string, resource: string, now: Date): Promise<OAuthGrant | null>;
    /** RFC 7009-style idempotent revocation, bound to the registered public client. Revokes the token's family. */
    revoke(input: { tokenHash: string; clientId: string; now: Date }): Promise<void>;
  };
  readonly grants: {
    list(userId: string, now: Date): Promise<OAuthGrant[]>;
    revoke(input: { userId: string; sessionHash: string; grantId: string; now: Date }): Promise<boolean>;
  };
}

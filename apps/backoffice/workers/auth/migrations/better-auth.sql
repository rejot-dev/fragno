CREATE TABLE "user" (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" integer NOT NULL,
  "image" text,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL,
  "role" text,
  "banned" integer,
  "banReason" text,
  "banExpires" date
);

CREATE TABLE "session" (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" date NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "impersonatedBy" text,
  "activeOrganizationId" text
);

CREATE TABLE "account" (
  "id" text NOT NULL PRIMARY KEY,
  "issuer" text NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" date,
  "refreshTokenExpiresAt" date,
  "scope" text,
  "password" text,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);

CREATE TABLE "verification" (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" date NOT NULL,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);

CREATE TABLE "organization" (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "logo" text,
  "createdAt" date NOT NULL,
  "metadata" text,
  "createdBy" text NOT NULL
);

CREATE TABLE "member" (
  "id" text NOT NULL PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "createdAt" date NOT NULL
);

CREATE TABLE "invitation" (
  "id" text NOT NULL PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" text,
  "status" text NOT NULL,
  "expiresAt" date NOT NULL,
  "createdAt" date NOT NULL,
  "inviterId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE "jwks" (
  "id" text NOT NULL PRIMARY KEY,
  "publicKey" text NOT NULL,
  "privateKey" text NOT NULL,
  "createdAt" date NOT NULL,
  "expiresAt" date,
  "alg" text,
  "crv" text
);

CREATE TABLE "oauthClient" (
  "id" text NOT NULL PRIMARY KEY,
  "clientId" text NOT NULL UNIQUE,
  "clientSecret" text,
  "clientDiscoveryId" text,
  "disabled" integer,
  "skipConsent" integer,
  "enableEndSession" integer,
  "subjectType" text,
  "scopes" text,
  "clientCredentialsScopes" text,
  "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
  "createdAt" date,
  "updatedAt" date,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" text,
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" text NOT NULL,
  "postLogoutRedirectUris" text,
  "backchannelLogoutUri" text,
  "backchannelLogoutSessionRequired" integer,
  "tokenEndpointAuthMethod" text,
  "applicationType" text,
  "jwks" text,
  "jwksUri" text,
  "grantTypes" text,
  "responseTypes" text,
  "requirePKCE" integer,
  "dpopBoundAccessTokens" integer,
  "referenceId" text,
  "metadata" text
);

CREATE TABLE "oauthResource" (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" text,
  "customClaims" text,
  "dpopBoundAccessTokensRequired" integer,
  "disabled" integer,
  "createdAt" date,
  "updatedAt" date,
  "policyVersion" integer,
  "metadata" text
);

CREATE TABLE "oauthClientResource" (
  "id" text NOT NULL PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "resourceId" text NOT NULL REFERENCES "oauthResource" ("identifier") ON DELETE CASCADE,
  "metadata" text,
  "createdAt" date
);

CREATE TABLE "oauthRefreshToken" (
  "id" text NOT NULL PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" text,
  "requestedUserInfoClaims" text,
  "expiresAt" date NOT NULL,
  "createdAt" date NOT NULL,
  "revoked" date,
  "rotatedAt" date,
  "rotationReplayResponse" text,
  "rotationReplayExpiresAt" date,
  "authTime" date,
  "confirmation" text,
  "scopes" text NOT NULL
);

CREATE TABLE "oauthAccessToken" (
  "id" text NOT NULL PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" text,
  "requestedUserInfoClaims" text,
  "refreshId" text REFERENCES "oauthRefreshToken" ("id") ON DELETE CASCADE,
  "expiresAt" date NOT NULL,
  "createdAt" date NOT NULL,
  "revoked" date,
  "confirmation" text,
  "scopes" text NOT NULL
);

CREATE TABLE "oauthConsent" (
  "id" text NOT NULL PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "resources" text,
  "requestedUserInfoClaims" text,
  "scopes" text NOT NULL,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);

CREATE TABLE "oauthClientAssertion" (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" date NOT NULL
);

CREATE TABLE "deviceCode" (
  "id" text NOT NULL PRIMARY KEY,
  "deviceCode" text NOT NULL,
  "userCode" text NOT NULL,
  "userId" text,
  "expiresAt" date NOT NULL,
  "status" text NOT NULL,
  "lastPolledAt" date,
  "pollingInterval" integer,
  "clientId" text,
  "scope" text,
  "resources" text,
  "oauthClientId" text
);

CREATE INDEX "session_userId_idx" ON "session" ("userId");

CREATE INDEX "account_userId_idx" ON "account" ("userId");

CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

CREATE INDEX "member_organizationId_idx" ON "member" ("organizationId");

CREATE INDEX "member_userId_idx" ON "member" ("userId");

CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organizationId");

CREATE INDEX "invitation_email_idx" ON "invitation" ("email");

CREATE INDEX "oauthClient_userId_idx" ON "oauthClient" ("userId");

CREATE INDEX "oauthClientResource_clientId_idx" ON "oauthClientResource" ("clientId");

CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauthClientResource" ("resourceId");

CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken" ("clientId");

CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken" ("sessionId");

CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauthRefreshToken" ("userId");

CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken" ("authorizationCodeId");

CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");

CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauthAccessToken" ("sessionId");

CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");

CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken" ("authorizationCodeId");

CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauthAccessToken" ("refreshId");

CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");

CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent" ("userId");

CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId");

CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON "oauthClientResource" ("clientId", "resourceId");

CREATE UNIQUE INDEX "deviceCode_deviceCode_uidx" ON "deviceCode" ("deviceCode");

CREATE UNIQUE INDEX "deviceCode_userCode_uidx" ON "deviceCode" ("userCode");

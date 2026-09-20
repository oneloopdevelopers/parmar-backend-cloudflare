import { importPKCS8, SignJWT } from 'jose';
import { BadGatewayError, UnauthorizedError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface ServiceAccountCredentials {
  project_id: string;
  client_email: string;
  private_key: string;
  type?: string;
  [key: string]: unknown;
}

export interface CachedToken {
  accessToken: string;
  expiresAt: number; // Unix timestamp in ms
}

// In-memory cache for access tokens: key is client_email
const tokenCache = new Map<string, CachedToken>();
// In-memory cache for imported crypto keys: key is client_email
const keyCache = new Map<string, CryptoKey | Uint8Array>();

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const GOOGLE_DRIVE_WRITE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const GOOGLE_DRIVE_SCOPE = GOOGLE_DRIVE_READ_SCOPE;
export const FCM_MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/datastore',
  'https://www.googleapis.com/auth/drive'
].join(' ');

/**
 * Normalizes a space-delimited OAuth scopes string into a sorted, unique string.
 */
export function normalizeScopes(scopes: string): string {
  if (!scopes || typeof scopes !== 'string') {
    return '';
  }
  return scopes.trim().split(/\s+/).filter(Boolean).sort().join(' ');
}

/**
 * Parses and validates the service account JSON string.
 * Strictly verifies project_id, client_email, and private_key exist.
 */
export function parseServiceAccountJson(rawJson: string): ServiceAccountCredentials {
  if (!rawJson || typeof rawJson !== 'string' || !rawJson.trim()) {
    throw new UnauthorizedError(
      'Service account credentials are missing. FIREBASE_SERVICE_ACCOUNT_JSON is required.'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new UnauthorizedError(
      'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.'
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UnauthorizedError('FIREBASE_SERVICE_ACCOUNT_JSON must be a JSON object.');
  }

  const record = parsed as Record<string, unknown>;

  const projectId = typeof record.project_id === 'string' ? record.project_id.trim() : '';
  if (!projectId) {
    throw new UnauthorizedError("Service account JSON is missing the required 'project_id' field.");
  }

  const clientEmail = typeof record.client_email === 'string' ? record.client_email.trim() : '';
  if (!clientEmail) {
    throw new UnauthorizedError("Service account JSON is missing the required 'client_email' field.");
  }

  const rawKey = typeof record.private_key === 'string' ? record.private_key.trim() : '';
  if (!rawKey) {
    throw new UnauthorizedError("Service account JSON is missing the required 'private_key' field.");
  }

  // Normalize literal escaped newlines
  const privateKey = rawKey.replace(/\\n/g, '\n');

  return {
    ...record,
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey
  };
}

/**
 * Retrieves an imported CryptoKey from memory or imports it using Web Crypto.
 */
async function getOrImportPrivateKey(clientEmail: string, privateKeyPem: string): Promise<CryptoKey | Uint8Array> {
  const cached = keyCache.get(clientEmail);
  if (cached) {
    return cached;
  }

  try {
    const key = await importPKCS8(privateKeyPem, 'RS256');
    keyCache.set(clientEmail, key);
    return key;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to import service account private key via Web Crypto:', msg);
    throw new BadGatewayError('Failed to parse and import service account private key.');
  }
}

/**
 * Creates a signed RS256 JWT assertion for Google OAuth2 token exchange.
 */
export async function createServiceAccountAssertion(
  credentials: ServiceAccountCredentials,
  scopes: string = DEFAULT_SCOPES
): Promise<string> {
  const cryptoKey = await getOrImportPrivateKey(credentials.client_email, credentials.private_key);

  const now = Math.floor(Date.now() / 1000);

  const jwt = await new SignJWT({
    scope: scopes
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(credentials.client_email)
    .setSubject(credentials.client_email)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600) // 1 hour
    .sign(cryptoKey);

  return jwt;
}

/**
 * Obtains a Google OAuth2 access token using the service account JSON.
 * Caches valid tokens to prevent redundant network calls and token rate limits.
 */
export async function getGoogleAccessToken(
  rawServiceAccountJson: string,
  options?: { forceRefresh?: boolean; scopes?: string; customFetch?: typeof fetch }
): Promise<{ accessToken: string; projectId: string }> {
  const creds = parseServiceAccountJson(rawServiceAccountJson);
  const requestedScopes = options?.scopes || DEFAULT_SCOPES;
  const normalized = normalizeScopes(requestedScopes);
  const cacheKey = `${creds.client_email}:::${normalized}`;

  // Check cache (expire with 5-minute margin of safety)
  if (!options?.forceRefresh) {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
      return {
        accessToken: cached.accessToken,
        projectId: creds.project_id
      };
    }
  }

  const assertion = await createServiceAccountAssertion(creds, requestedScopes);

  const bodyParams = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: assertion
  });

  const fetchFn = options?.customFetch || fetch;

  try {
    const response = await fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: bodyParams.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Google OAuth token exchange failed with status ${response.status}:`, errorText);
      throw new BadGatewayError(
        `Failed to obtain Google access token: Upstream authentication returned HTTP ${response.status}`
      );
    }

    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    if (!data.access_token) {
      throw new BadGatewayError('Google OAuth token endpoint response did not include access_token.');
    }

    const expiresInMs = (data.expires_in || 3600) * 1000;
    const expiresAt = Date.now() + expiresInMs;

    tokenCache.set(cacheKey, {
      accessToken: data.access_token,
      expiresAt: expiresAt
    });

    return {
      accessToken: data.access_token,
      projectId: creds.project_id
    };
  } catch (err) {
    if (err instanceof BadGatewayError || err instanceof UnauthorizedError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Network error during Google OAuth token exchange:', msg);
    throw new BadGatewayError(`Upstream Google OAuth network failure: ${msg}`);
  }
}

/**
 * Resets the in-memory token and key caches (used for testing).
 */
export function clearTokenCache(): void {
  tokenCache.clear();
  keyCache.clear();
}

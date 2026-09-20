import { Env, KVNamespace, KVNamespaceLike } from '../types/worker.types';
import { BadRequestError, BadGatewayError } from '../utils/errors';
import { logger } from '../utils/logger';
import { firestoreRestService } from './firestoreRestService';

export const GOOGLE_DRIVE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive';
export const DEFAULT_REDIRECT_URI =
  'https://parmar-backend-cloudflare.oneloopdevelopers.workers.dev/api/oauth/google/callback';

/**
 * Resolves and strictly validates the Google OAuth redirect URI:
 * - Supports GOOGLE_OAUTH_REDIRECT_URI as an optional environment configuration.
 * - If absent, uses the exact registered production redirect URI as the default.
 * - If present, validates that it is an absolute HTTPS URL.
 * - Never allows a redirect URI supplied by an arbitrary client request.
 * - Used identically by /start and /callback authorization-code exchange.
 */
export function resolveOAuthRedirectUri(env?: Env): string {
  const envUri =
    (env?.GOOGLE_OAUTH_REDIRECT_URI as string) ||
    (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_REDIRECT_URI : undefined);

  if (!envUri || !envUri.trim()) {
    return DEFAULT_REDIRECT_URI;
  }

  const trimmed = envUri.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      logger.warn(`GOOGLE_OAUTH_REDIRECT_URI is not HTTPS ('${trimmed}').`);
      throw new BadRequestError('GOOGLE_OAUTH_REDIRECT_URI must be an absolute HTTPS URL.');
    }
    return trimmed;
  } catch (err) {
    if (err instanceof BadRequestError) {
      throw err;
    }
    throw new BadRequestError(`Invalid GOOGLE_OAUTH_REDIRECT_URI: '${trimmed}' is not a valid absolute URL.`);
  }
}

/**
 * In-memory fallback state store for unit testing or when KV is not bound.
 */
const inMemoryStateStore = new Map<string, number>();

/**
 * In-memory cached OAuth token entry.
 */
let cachedOAuthToken: { accessToken: string; expiresAt: number } | null = null;

/**
 * Resets the in-memory access token cache. Useful for testing or after re-authorization.
 */
export function clearOAuthTokenCache(): void {
  cachedOAuthToken = null;
}

/**
 * Allows setting a cached token for testing cache hit and expiration behavior.
 */
export function setCachedOAuthTokenForTesting(token: string, expiresInMs: number): void {
  cachedOAuthToken = {
    accessToken: token,
    expiresAt: Date.now() + expiresInMs
  };
}

/**
 * Converts a Uint8Array to a standard base64 string.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts a base64 or base64url string to a Uint8Array.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Performs a constant-time comparison of two strings to prevent timing attacks.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBytes.byteLength; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

/**
 * Imports a 32-byte AES-GCM key from a strict Base64 string into Web Crypto API.
 * Rejects missing keys, invalid Base64, and decoded keys whose length is not exactly 32 bytes (256 bits).
 * No passphrase derivation or silent fallback is allowed.
 */
export async function importAesKey(base64Key: string): Promise<CryptoKey> {
  if (!base64Key || typeof base64Key !== 'string' || !base64Key.trim()) {
    throw new BadRequestError('Encryption key must be a non-empty Base64 string.');
  }

  const trimmed = base64Key.trim();

  // Validate Base64 characters (standard or URL-safe, with optional padding)
  const isBase64 = /^[A-Za-z0-9+/=]+$/.test(trimmed) || /^[A-Za-z0-9_-]+={0,2}$/.test(trimmed);
  if (!isBase64) {
    throw new BadRequestError('Encryption key is not valid Base64.');
  }

  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(trimmed);
  } catch {
    throw new BadRequestError('Encryption key is not valid Base64.');
  }

  if (keyBytes.byteLength !== 32) {
    throw new BadRequestError(
      `Encryption key must represent exactly 32 random bytes (256 bits) for AES-256-GCM. Got ${keyBytes.byteLength} bytes.`
    );
  }

  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Computes an HMAC-SHA256 signature for a message given a key.
 */
async function computeHmacSha256(keyString: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyString),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return bytesToBase64(new Uint8Array(signatureBuffer)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generates a cryptographically signed, short-lived setup token for initiating Google Drive OAuth.
 * Format: `${timestamp}.${nonce}.${hmacSignature}`
 * - Derived from GOOGLE_OAUTH_SETUP_KEY
 * - Valid for approximately 10 minutes (default 600,000 ms)
 * - Single-use enforced upon consumption via KV / in-memory tracking
 * - Does NOT contain or expose the raw setup key
 */
export async function generateSignedSetupToken(
  setupKey: string,
  ttlMs: number = 600_000
): Promise<string> {
  if (!setupKey || typeof setupKey !== 'string' || !setupKey.trim()) {
    throw new BadRequestError('Setup key is required to generate setup token.');
  }
  const timestamp = Date.now().toString();
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = bytesToBase64(nonceBytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = `${timestamp}.${nonce}`;
  const signature = await computeHmacSha256(setupKey.trim(), payload);
  return `${payload}.${signature}`;
}

/**
 * Creates a short-lived administrative setup session.
 * Stores the token in KV (or in-memory store) and returns the browser-friendly setup URL path.
 */
export async function createSetupSession(
  setupKey: string,
  kv?: KVNamespace,
  ttlSeconds: number = 600
): Promise<{ setupToken: string; setupUrlPath: string; expiresInSeconds: number }> {
  const token = await generateSignedSetupToken(setupKey, ttlSeconds * 1000);
  const key = `oauth_setup:${token}`;
  if (kv) {
    await kv.put(key, JSON.stringify({ createdAt: Date.now() }), { expirationTtl: ttlSeconds });
  } else {
    inMemoryStateStore.set(key, Date.now() + ttlSeconds * 1000);
  }
  return {
    setupToken: token,
    setupUrlPath: `/api/oauth/google/start?setup=${encodeURIComponent(token)}`,
    expiresInSeconds: ttlSeconds
  };
}

/**
 * Validates a setup token from `GET /api/oauth/google/start?setup=<token>` and consumes it.
 * Requirements:
 * - Must be cryptographically valid (HMAC signature matching setupKey)
 * - Must not be expired (within approximately 10 minutes)
 * - Must be strictly single-use (replay rejected)
 */
export async function validateAndConsumeSetupToken(
  token: string,
  setupKey: string,
  kv?: KVNamespace
): Promise<boolean> {
  if (!token || typeof token !== 'string' || !token.trim() || !setupKey || !setupKey.trim()) {
    return false;
  }

  const trimmed = token.trim();
  const parts = trimmed.split('.');

  // If token is in signed format: timestamp.nonce.signature
  if (parts.length === 3) {
    const [timestampStr, nonce, signature] = parts;
    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      return false;
    }

    const now = Date.now();
    // Allow up to 10 minutes (600,000 ms) validity and 60 seconds clock skew
    if (now < timestamp - 60_000 || now > timestamp + 600_000) {
      return false;
    }

    const payload = `${timestampStr}.${nonce}`;
    let expectedSignature: string;
    try {
      expectedSignature = await computeHmacSha256(setupKey.trim(), payload);
    } catch {
      return false;
    }

    if (!timingSafeEqual(signature, expectedSignature)) {
      return false;
    }

    // Check single-use replay protection
    const replayKey = `oauth_setup_consumed:${signature}`;
    if (kv) {
      const alreadyConsumed = await kv.get(replayKey);
      if (alreadyConsumed) {
        return false; // Replay attempt
      }
      const remainingTtlSeconds = Math.max(60, Math.ceil((timestamp + 600_000 - now) / 1000));
      await kv.put(replayKey, '1', { expirationTtl: remainingTtlSeconds });
      await kv.delete(`oauth_setup:${trimmed}`);
      return true;
    } else {
      const alreadyConsumed = inMemoryStateStore.get(replayKey);
      if (alreadyConsumed) {
        return false;
      }
      const remainingMs = Math.max(60_000, timestamp + 600_000 - now);
      inMemoryStateStore.set(replayKey, now + remainingMs);
      inMemoryStateStore.delete(`oauth_setup:${trimmed}`);
      return true;
    }
  }

  // Fallback for simple KV-stored setup token (if generated without dot format)
  const kvKey = `oauth_setup:${trimmed}`;
  if (kv) {
    const val = await kv.get(kvKey);
    if (!val) return false;
    await kv.delete(kvKey);
    return true;
  } else {
    const expiry = inMemoryStateStore.get(kvKey);
    if (!expiry) return false;
    inMemoryStateStore.delete(kvKey);
    return Date.now() <= expiry;
  }
}

/**
 * Encrypts a plaintext refresh token using AES-256-GCM with a fresh 12-byte IV.
 * Returns a safe representation combining IV and ciphertext in base64 format: `iv:ciphertext`.
 */
export async function encryptRefreshToken(
  plaintextToken: string,
  base64Key: string
): Promise<string> {
  if (!plaintextToken || typeof plaintextToken !== 'string') {
    throw new BadRequestError('Plaintext token must be a non-empty string.');
  }

  const key = await importAesKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedPlaintext = new TextEncoder().encode(plaintextToken);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    key,
    encodedPlaintext
  );

  const ciphertextBytes = new Uint8Array(ciphertextBuffer);
  return `${bytesToBase64(iv)}:${bytesToBase64(ciphertextBytes)}`;
}

/**
 * Decrypts an AES-256-GCM encrypted refresh token payload (`iv:ciphertext`).
 */
export async function decryptRefreshToken(
  payload: string,
  base64Key: string
): Promise<string> {
  if (!payload || typeof payload !== 'string') {
    throw new BadRequestError('Encrypted payload must be a non-empty string.');
  }

  const parts = payload.split(':');
  if (parts.length !== 2) {
    throw new BadRequestError('Invalid encrypted payload format: expected iv:ciphertext.');
  }

  let iv: Uint8Array;
  let ciphertextBytes: Uint8Array;
  try {
    iv = base64ToBytes(parts[0]);
    ciphertextBytes = base64ToBytes(parts[1]);
  } catch {
    throw new BadRequestError('Invalid base64 encoding in encrypted payload.');
  }

  if (iv.byteLength !== 12) {
    throw new BadRequestError(
      `Invalid IV length for AES-GCM: expected 12 bytes, got ${iv.byteLength} bytes.`
    );
  }

  const key = await importAesKey(base64Key);

  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv
      },
      key,
      ciphertextBytes
    );
    return new TextDecoder().decode(decryptedBuffer);
  } catch {
    throw new BadRequestError('Decryption failed: corrupted ciphertext or invalid key.');
  }
}

/**
 * Generates a cryptographically random OAuth state string.
 */
export function generateOAuthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Stores OAuth state temporarily in Cloudflare KV (or in-memory fallback for tests).
 * State expires automatically after the specified TTL (default 600s / 10 minutes).
 */
export async function storeOAuthState(
  state: string,
  kv?: KVNamespaceLike,
  ttlSeconds: number = 600
): Promise<void> {
  const key = `oauth_state:${state}`;
  if (kv) {
    await kv.put(key, JSON.stringify({ createdAt: Date.now() }), { expirationTtl: ttlSeconds });
  } else {
    inMemoryStateStore.set(key, Date.now() + ttlSeconds * 1000);
  }
}

/**
 * Validates the state parameter and deletes it immediately so it cannot be reused.
 */
export async function validateAndConsumeOAuthState(
  state: string,
  kv?: KVNamespaceLike
): Promise<boolean> {
  if (!state || typeof state !== 'string' || !state.trim()) {
    return false;
  }
  const key = `oauth_state:${state.trim()}`;
  if (kv) {
    const value = await kv.get(key);
    if (!value) {
      return false;
    }
    await kv.delete(key);
    return true;
  } else {
    const expiry = inMemoryStateStore.get(key);
    if (!expiry) {
      return false;
    }
    inMemoryStateStore.delete(key);
    if (Date.now() > expiry) {
      return false;
    }
    return true;
  }
}

/**
 * Clears the in-memory state store. Used for testing.
 */
export function clearInMemoryStateStore(): void {
  inMemoryStateStore.clear();
}

export interface BuildAuthUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}

/**
 * Constructs the Google OAuth 2.0 authorization URL.
 */
export function buildGoogleOAuthUrl(params: BuildAuthUrlParams): string {
  if (!params.clientId || !params.clientId.trim()) {
    throw new BadRequestError('Client ID is required to build authorization URL.');
  }
  if (!params.redirectUri || !params.redirectUri.trim()) {
    throw new BadRequestError('Redirect URI is required to build authorization URL.');
  }
  if (!params.state || !params.state.trim()) {
    throw new BadRequestError('State parameter is required to build authorization URL.');
  }

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', params.clientId.trim());
  url.searchParams.set('redirect_uri', params.redirectUri.trim());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('scope', params.scope || GOOGLE_DRIVE_OAUTH_SCOPE);
  url.searchParams.set('state', params.state.trim());
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'consent');

  return url.toString();
}

export interface ExchangeCodeParams {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  customFetch?: typeof fetch;
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  scope?: string;
  idToken?: string;
}

/**
 * Exchanges the OAuth authorization code for Google access and refresh tokens.
 * Requires a refresh_token in the response.
 */
export async function exchangeAuthorizationCode(
  params: ExchangeCodeParams
): Promise<TokenExchangeResult> {
  if (!params.clientId || !params.clientId.trim()) {
    throw new BadRequestError('Missing GOOGLE_OAUTH_CLIENT_ID configuration.');
  }
  if (!params.clientSecret || !params.clientSecret.trim()) {
    throw new BadRequestError('Missing GOOGLE_OAUTH_CLIENT_SECRET configuration.');
  }
  if (!params.code || !params.code.trim()) {
    throw new BadRequestError('Authorization code is required.');
  }
  if (!params.redirectUri || !params.redirectUri.trim()) {
    throw new BadRequestError('Redirect URI is required.');
  }

  const fetchImpl = params.customFetch || fetch;
  const body = new URLSearchParams({
    client_id: params.clientId.trim(),
    client_secret: params.clientSecret.trim(),
    code: params.code.trim(),
    redirect_uri: params.redirectUri.trim(),
    grant_type: 'authorization_code'
  });

  let response: Response;
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: body.toString()
    });
  } catch (err) {
    logger.error('Network error during Google OAuth token exchange:', err instanceof Error ? err.message : String(err));
    throw new BadGatewayError('Failed to communicate with Google OAuth token service.');
  }

  if (!response.ok) {
    logger.error(`Google OAuth token exchange failed with HTTP status ${response.status}`);
    throw new BadGatewayError('Failed to exchange authorization code with Google.');
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    id_token?: string;
  };

  if (!data.refresh_token) {
    logger.warn('Google OAuth token response did not include a refresh token.');
    throw new BadRequestError(
      'Google did not return a refresh token. Please revoke application permissions in your Google account and restart authorization with prompt=consent.'
    );
  }

  if (!data.access_token) {
    logger.error('Google OAuth token response did not include an access token.');
    throw new BadGatewayError('Google OAuth response did not contain an access token.');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600,
    tokenType: data.token_type || 'Bearer',
    scope: data.scope,
    idToken: data.id_token
  };
}

export interface RefreshAccessTokenParams {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customFetch?: typeof fetch;
}

/**
 * Exchanges a decrypted Google OAuth refresh token for a fresh short-lived access token.
 */
export async function refreshGoogleDriveAccessToken(
  params: RefreshAccessTokenParams
): Promise<{ accessToken: string; expiresIn: number }> {
  if (!params.clientId || !params.clientId.trim()) {
    throw new BadRequestError('Missing GOOGLE_OAUTH_CLIENT_ID configuration.');
  }
  if (!params.clientSecret || !params.clientSecret.trim()) {
    throw new BadRequestError('Missing GOOGLE_OAUTH_CLIENT_SECRET configuration.');
  }
  if (!params.refreshToken || !params.refreshToken.trim()) {
    throw new BadRequestError('Refresh token is required.');
  }

  const fetchImpl = params.customFetch || fetch;
  const body = new URLSearchParams({
    client_id: params.clientId.trim(),
    client_secret: params.clientSecret.trim(),
    refresh_token: params.refreshToken.trim(),
    grant_type: 'refresh_token'
  });

  let response: Response;
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: body.toString()
    });
  } catch (err) {
    logger.error('Network error during Google OAuth token refresh:', err instanceof Error ? err.message : String(err));
    throw new BadGatewayError('Failed to communicate with Google OAuth token service.');
  }

  if (!response.ok) {
    let googleErrorCode = 'unknown_error';
    let googleErrorDescription = '';
    try {
      const rawText = await response.text();
      try {
        const errorData = JSON.parse(rawText) as { error?: string; error_description?: string };
        googleErrorCode = typeof errorData?.error === 'string' ? errorData.error : 'unknown_error';
        googleErrorDescription = typeof errorData?.error_description === 'string' ? errorData.error_description : '';
      } catch {
        googleErrorDescription = rawText.slice(0, 200);
      }
    } catch {
      // ignore parse error
    }

    logger.error(
      `Google OAuth refresh token exchange failed: HTTP ${response.status}, error='${googleErrorCode}', description='${googleErrorDescription}'`
    );
    throw new BadGatewayError(
      `Google Drive OAuth token refresh failed (HTTP ${response.status}: ${googleErrorCode}${googleErrorDescription ? ` - ${googleErrorDescription}` : ''}). Google Drive authorization must be re-authorized.`
    );
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    logger.error('Google OAuth refresh response did not include an access token.');
    throw new BadGatewayError('Google Drive OAuth token response did not contain an access token.');
  }

  return {
    accessToken: data.access_token,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600
  };
}

/**
 * Safely fetches the account email for the authorized Google Drive account using the access token.
 */
export async function getGoogleDriveAccountEmail(
  accessToken: string,
  customFetch?: typeof fetch
): Promise<string | null> {
  try {
    const fetchImpl = customFetch || fetch;
    const response = await fetchImpl('https://www.googleapis.com/drive/v3/about?fields=user', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      user?: {
        emailAddress?: string;
      };
    };

    return data?.user?.emailAddress || null;
  } catch {
    return null;
  }
}

/**
 * Checks whether Google OAuth is configured in the environment.
 * Requires client ID, client secret, and token encryption key.
 */
export function isGoogleOAuthConfigured(env?: Env): boolean {
  const clientId =
    env?.GOOGLE_OAUTH_CLIENT_ID ||
    (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_CLIENT_ID : undefined);
  const clientSecret =
    env?.GOOGLE_OAUTH_CLIENT_SECRET ||
    (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_CLIENT_SECRET : undefined);
  const encryptionKey =
    env?.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY ||
    (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY : undefined);

  return Boolean(
    clientId && clientId.trim() &&
    clientSecret && clientSecret.trim() &&
    encryptionKey && encryptionKey.trim()
  );
}

/**
 * Retrieves a valid Google Drive OAuth access token for backend Drive operations.
 * - When OAuth is configured:
 *     - If in-memory cached token is valid, returns it.
 *     - Fetches encrypted refresh token from Firestore document `oauth/googleDrive`.
 *     - Decrypts refresh token using strict 32-byte Base64 AES-256-GCM key.
 *     - Refreshes access token with Google.
 *     - Caches token in memory.
 *     - If token cannot be retrieved or refreshed, throws a controlled BadGatewayError.
 *       (NEVER returns null when OAuth is configured, ensuring no silent fallback occurs).
 * - When OAuth is NOT configured:
 *     - Returns null so caller may use explicit service account fallback if available.
 */
export async function getGoogleDriveOAuthAccessToken(
  env: Env,
  options?: {
    customFetch?: typeof fetch;
    skipCache?: boolean;
  }
): Promise<string | null> {
  const configured = isGoogleOAuthConfigured(env);
  if (!configured) {
    return null;
  }

  // 1. Check in-memory cache with a 5-minute safety margin
  if (!options?.skipCache && cachedOAuthToken && cachedOAuthToken.expiresAt > Date.now() + 300_000) {
    return cachedOAuthToken.accessToken;
  }

  const clientId =
    env?.GOOGLE_OAUTH_CLIENT_ID ||
    (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_CLIENT_ID : undefined)!;
  const clientSecret =
    env?.GOOGLE_OAUTH_CLIENT_SECRET ||
    (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_CLIENT_SECRET : undefined)!;
  const encryptionKey =
    env?.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY ||
    (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY : undefined)!;

  const projectId =
    (env?.FIREBASE_PROJECT_ID as string) ||
    (typeof process !== 'undefined' ? process.env?.FIREBASE_PROJECT_ID : undefined) ||
    'document-portal-d2b6d';

  const serviceAccountJson =
    env?.FIREBASE_SERVICE_ACCOUNT_JSON ||
    (typeof process !== 'undefined' ? process.env?.FIREBASE_SERVICE_ACCOUNT_JSON : undefined);

  if (!serviceAccountJson) {
    logger.error('OAuth is configured, but FIREBASE_SERVICE_ACCOUNT_JSON is missing to load stored credentials.');
    throw new BadGatewayError(
      'Google Drive OAuth is configured, but server Firebase configuration is missing to read stored token.'
    );
  }

  // 2. Load oauth/googleDrive from Firestore
  let doc: Record<string, unknown> | null;
  try {
    doc = await firestoreRestService.getDocument('oauth', 'googleDrive', {
      projectId,
      serviceAccountJson,
      customFetch: options?.customFetch
    });
  } catch (err) {
    logger.error('Failed to load oauth/googleDrive from Firestore:', err instanceof Error ? err.message : String(err));
    throw new BadGatewayError(
      'Google Drive OAuth is configured, but failed to load authorized credentials from storage.'
    );
  }

  if (!doc || !doc.refreshTokenCiphertext || typeof doc.refreshTokenCiphertext !== 'string') {
    throw new BadGatewayError(
      'Google Drive OAuth is configured, but authorization has not been completed. Please authorize Google Drive via /api/oauth/google/start?setup=<setup-token>.'
    );
  }

  // 3. Decrypt refreshTokenCiphertext
  let refreshToken: string;
  try {
    refreshToken = await decryptRefreshToken(doc.refreshTokenCiphertext, encryptionKey);
  } catch (err) {
    logger.error('Failed to decrypt stored Google Drive refresh token:', err instanceof Error ? err.message : String(err));
    throw new BadGatewayError(
      'Google Drive OAuth decryption failed. Stored refresh token could not be decrypted with current key.'
    );
  }

  // 4. Exchange refresh token for fresh access token
  const result = await refreshGoogleDriveAccessToken({
    clientId,
    clientSecret,
    refreshToken,
    customFetch: options?.customFetch
  });

  // 5. Cache access token
  cachedOAuthToken = {
    accessToken: result.accessToken,
    expiresAt: Date.now() + result.expiresIn * 1000
  };

  return result.accessToken;
}

export interface GoogleOAuthDiagnosticResult {
  success: boolean;
  googleHttpStatus?: number;
  googleErrorCode?: string;
  googleErrorDescription?: string;
  oauthStorageExists: boolean;
  decryptionSucceeded: boolean;
  message?: string;
}

/**
 * Performs a safe, non-mutating diagnosis of the stored Google Drive OAuth refresh token.
 * - Confirms whether oauth/googleDrive document exists.
 * - Attempts decryption of refreshTokenCiphertext without exposing raw plaintext.
 * - Attempts a single refresh token request to https://oauth2.googleapis.com/token.
 * - Does NOT update, delete, or re-authorize OAuth credentials.
 * - Does NOT store or return the newly obtained access token.
 * - Does NOT expose client_secret, refresh_token, access_token, or encryption keys.
 */
export async function diagnoseGoogleDriveOAuthRefresh(
  env: Env,
  options?: {
    customFetch?: typeof fetch;
  }
): Promise<GoogleOAuthDiagnosticResult> {
  const configured = isGoogleOAuthConfigured(env);
  if (!configured) {
    return {
      success: false,
      oauthStorageExists: false,
      decryptionSucceeded: false,
      message: 'Google OAuth is not configured in server environment secrets.'
    };
  }

  const clientId =
    env?.GOOGLE_OAUTH_CLIENT_ID ||
    (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_CLIENT_ID : undefined)!;
  const clientSecret =
    env?.GOOGLE_OAUTH_CLIENT_SECRET ||
    (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_CLIENT_SECRET : undefined)!;
  const encryptionKey =
    env?.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY ||
    (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY : undefined)!;

  const projectId =
    (env?.FIREBASE_PROJECT_ID as string) ||
    (typeof process !== 'undefined' ? process.env?.FIREBASE_PROJECT_ID : undefined) ||
    'document-portal-d2b6d';

  const serviceAccountJson =
    env?.FIREBASE_SERVICE_ACCOUNT_JSON ||
    (typeof process !== 'undefined' ? process.env?.FIREBASE_SERVICE_ACCOUNT_JSON : undefined);

  if (!serviceAccountJson) {
    return {
      success: false,
      oauthStorageExists: false,
      decryptionSucceeded: false,
      message: 'FIREBASE_SERVICE_ACCOUNT_JSON is missing from server configuration.'
    };
  }

  // 1. Fetch oauth/googleDrive from Firestore
  let doc: Record<string, unknown> | null;
  try {
    doc = await firestoreRestService.getDocument('oauth', 'googleDrive', {
      projectId,
      serviceAccountJson,
      customFetch: options?.customFetch
    });
  } catch (err) {
    logger.error('Diagnostic failed to load oauth/googleDrive from Firestore:', err instanceof Error ? err.message : String(err));
    return {
      success: false,
      oauthStorageExists: false,
      decryptionSucceeded: false,
      message: 'Failed to read oauth/googleDrive document from Firestore storage.'
    };
  }

  if (!doc || !doc.refreshTokenCiphertext || typeof doc.refreshTokenCiphertext !== 'string') {
    return {
      success: false,
      oauthStorageExists: false,
      decryptionSucceeded: false,
      message: 'Google Drive OAuth record not found in Firestore.'
    };
  }

  // 2. Decrypt refreshTokenCiphertext
  let refreshToken: string;
  try {
    refreshToken = await decryptRefreshToken(doc.refreshTokenCiphertext, encryptionKey);
  } catch (err) {
    logger.error('Diagnostic decryption failed:', err instanceof Error ? err.message : String(err));
    return {
      success: false,
      oauthStorageExists: true,
      decryptionSucceeded: false,
      message: 'Stored refresh token could not be decrypted with current encryption key.'
    };
  }

  // 3. Attempt ONE refresh request to Google's token endpoint
  const fetchImpl = options?.customFetch || fetch;
  const body = new URLSearchParams({
    client_id: clientId.trim(),
    client_secret: clientSecret.trim(),
    refresh_token: refreshToken.trim(),
    grant_type: 'refresh_token'
  });

  let response: Response;
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: body.toString()
    });
  } catch (err) {
    logger.error('Diagnostic network error communicating with Google OAuth token service:', err instanceof Error ? err.message : String(err));
    return {
      success: false,
      oauthStorageExists: true,
      decryptionSucceeded: true,
      message: 'Network failure communicating with Google OAuth token endpoint.'
    };
  }

  if (!response.ok) {
    let googleErrorCode = 'unknown_error';
    let googleErrorDescription = '';
    try {
      const rawText = await response.text();
      try {
        const errorData = JSON.parse(rawText) as { error?: string; error_description?: string };
        googleErrorCode = typeof errorData?.error === 'string' ? errorData.error : 'unknown_error';
        googleErrorDescription = typeof errorData?.error_description === 'string' ? errorData.error_description : '';
      } catch {
        googleErrorDescription = rawText.slice(0, 200);
      }
    } catch {
      // ignore parse errors
    }

    logger.error(
      `Google OAuth diagnostic refresh failed: HTTP ${response.status}, error='${googleErrorCode}', description='${googleErrorDescription}'`
    );

    return {
      success: false,
      googleHttpStatus: response.status,
      googleErrorCode,
      googleErrorDescription,
      oauthStorageExists: true,
      decryptionSucceeded: true
    };
  }

  return {
    success: true,
    googleHttpStatus: 200,
    oauthStorageExists: true,
    decryptionSucceeded: true,
    message: 'Google OAuth refresh succeeded.'
  };
}


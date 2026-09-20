import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, ExecutionContext } from './types/worker.types';
import { AppError, BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError, BadGatewayError, ConflictError, PayloadTooLargeError } from './utils/errors';
import { maskPanNumber } from './utils/clientProfileUtils';
import { verifyFirebaseIdToken } from './services/firebaseTokenVerifier';
import { firestoreRestService } from './services/firestoreRestService';
import { googleDriveRestService, DriveRestOptions } from './services/googleDriveRestService';
import { validateUploadedFile, MAX_UPLOAD_FILE_SIZE_BYTES } from './utils/fileValidationUtils';
import { logger } from './utils/logger';
import { validateCreateClientInput } from './utils/adminValidation';
import { adminClientService } from './services/adminClientService';
import {
  generateOAuthState,
  storeOAuthState,
  validateAndConsumeOAuthState,
  buildGoogleOAuthUrl,
  exchangeAuthorizationCode,
  encryptRefreshToken,
  getGoogleDriveAccountEmail,
  clearOAuthTokenCache,
  getGoogleDriveOAuthAccessToken,
  timingSafeEqual,
  DEFAULT_REDIRECT_URI,
  resolveOAuthRedirectUri,
  isGoogleOAuthConfigured,
  createSetupSession,
  validateAndConsumeSetupToken
} from './services/googleOAuthService';
import {
  encryptDocumentPassword,
  decryptDocumentPassword
} from './services/documentPasswordCrypto';
import { notificationService } from './services/notificationService';
import { fcmService } from './services/fcmService';

export interface WorkerVariables {
  verifiedUid: string;
  verifiedEmail?: string;
  tokenClaims: Record<string, unknown>;
}

const FORBIDDEN_CLIENT_IDENTITY_KEYS = [
  'uid',
  'firebaseuid',
  'firebase_uid',
  'pannumber',
  'pan_number',
  'pan',
  'drivefolderid',
  'drive_folder_id',
  'folderid',
  'folder_id',
  'destinationfolderid',
  'destination_folder_id',
  'destinationfolder',
  'destination_folder',
  'clientid',
  'client_id',
  'recipientuid',
  'recipient_uid',
  'recipient',
  'targetuid',
  'target_uid',
  'uploadertype',
  'uploader_type',
  'uploadername',
  'uploader_name'
];

/**
 * Extracts DOCUMENT_PASSWORD_ENCRYPTION_KEY safely from Worker env bindings or process.env.
 */
export function getDocumentPasswordEncryptionKey(env?: Env): string | undefined {
  const fromEnv = env?.DOCUMENT_PASSWORD_ENCRYPTION_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim();
  }
  if (typeof process !== 'undefined' && process.env?.DOCUMENT_PASSWORD_ENCRYPTION_KEY) {
    const fromProc = process.env.DOCUMENT_PASSWORD_ENCRYPTION_KEY;
    if (typeof fromProc === 'string' && fromProc.trim()) {
      return fromProc.trim();
    }
  }
  return undefined;
}

/**
 * Extracts FIREBASE_SERVICE_ACCOUNT_JSON safely from Worker env bindings or process.env.
 */
export function getServiceAccountJsonFromEnv(env?: Env): string {
  const fromEnv = env?.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim();
  }
  if (typeof process !== 'undefined' && process.env?.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const fromProc = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (typeof fromProc === 'string' && fromProc.trim()) {
      return fromProc.trim();
    }
  }
  return '';
}

/**
 * Resolves Google Drive authorization options.
 * If Google OAuth is configured, Google Drive operations MUST use the storage-owner OAuth access token.
 * If OAuth token acquisition fails, throws a controlled backend error and NEVER silently falls back.
 * The service account remains available only when Google OAuth is NOT configured.
 */
export async function resolveDriveAuthOptions(
  env?: Env,
  serviceAccountJson?: string
): Promise<DriveRestOptions> {
  const oauthConfigured = isGoogleOAuthConfigured(env);

  if (oauthConfigured) {
    // OAuth is configured: Google Drive operations MUST use the storage-owner OAuth access token.
    // If token acquisition fails, getGoogleDriveOAuthAccessToken throws a controlled error.
    // We do NOT silently fall back to the service account or hide OAuth authentication failures.
    const oauthAccessToken = await getGoogleDriveOAuthAccessToken(env!);
    if (!oauthAccessToken) {
      throw new BadGatewayError(
        'Google Drive OAuth is configured but access token is unavailable. Please complete authorization.'
      );
    }
    return {
      accessToken: oauthAccessToken
    };
  }

  // OAuth is not configured: existing service-account behavior remains temporarily available
  if (serviceAccountJson && serviceAccountJson.trim()) {
    return {
      serviceAccountJson
    };
  }

  throw new BadRequestError('Google Drive authentication is not configured.');
}

/**
 * Sanitizes a filename for use in HTTP Content-Disposition headers.
 * Strictly prevents CRLF, header injection, control characters, null bytes,
 * path traversal, and quote escaping issues.
 * Implements RFC 6266 / RFC 5987 with ASCII fallback and UTF-8 encoded parameter.
 */
export function sanitizeFilename(
  rawName?: string | null,
  fallback = 'document.bin'
): { asciiFilename: string; encodedFilename: string; contentDisposition: string } {
  const safeFallback = fallback && typeof fallback === 'string' && fallback.trim()
    ? fallback.trim().replace(/[^a-zA-Z0-9._-]/g, '_')
    : 'document.bin';

  if (!rawName || typeof rawName !== 'string') {
    return {
      asciiFilename: safeFallback,
      encodedFilename: encodeURIComponent(safeFallback),
      contentDisposition: `attachment; filename="${safeFallback}"`
    };
  }

  // 1. Strip path components (directory traversal)
  let name = rawName.replace(/^.*[\\\/]/, '').trim();

  // 2. Strip CRLF, control characters (0x00-0x1F, 0x7F) and null bytes
  name = name.replace(/[\r\n\0\x00-\x1f\x7f]/g, '');

  if (!name) {
    return {
      asciiFilename: safeFallback,
      encodedFilename: encodeURIComponent(safeFallback),
      contentDisposition: `attachment; filename="${safeFallback}"`
    };
  }

  // 3. Prepare ASCII-safe filename for standard filename="..." parameter:
  // Replace quotes, backslashes, semicolons, and non-printable/non-ASCII characters with underscores.
  let ascii = name.replace(/["\\;]/g, '_').replace(/[^\x20-\x7E]/g, '_').trim();
  if (!ascii) {
    ascii = safeFallback;
  }

  // 4. Prepare RFC 5987 / RFC 6266 UTF-8 encoded filename for filename*=UTF-8''...
  const encoded = encodeURIComponent(name)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');

  return {
    asciiFilename: ascii,
    encodedFilename: encoded,
    contentDisposition: `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
  };
}

export interface WorkerAppOptions {
  tokenVerifier?: (token: string, options?: { projectId?: string }) => Promise<{
    uid: string;
    email?: string;
    claims: Record<string, unknown>;
  }>;
}

/**
 * Creates the Hono Cloudflare Worker application instance.
 */
export function createWorkerApp(options?: WorkerAppOptions) {
  const app = new Hono<{ Bindings: Env; Variables: WorkerVariables }>();
  const tokenVerifier = options?.tokenVerifier || verifyFirebaseIdToken;

  // Enable CORS
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With']
  }));

  // Zero-Trust Identity Guard
  // The backend NEVER trusts a Firebase UID, PAN number, client ID, or Google Drive folder ID
  // supplied by the client in query parameters, headers, or URL parameters.
  app.use('*', async (c, next) => {
    // 1. Check Query Parameters
    const queries = c.req.query();
    for (const key of Object.keys(queries)) {
      const normalized = key.toLowerCase().replace(/[-_]/g, '');
      if (FORBIDDEN_CLIENT_IDENTITY_KEYS.includes(normalized)) {
        logger.warn(`Security violation: Client attempted to supply forbidden identity field '${key}' in query`);
        throw new BadRequestError(
          `Security violation: Field '${key}' cannot be supplied by client request data. Identity, PAN, and Google Drive folder associations are strictly authoritative and derived by the server from verified Firebase tokens and Firestore records.`
        );
      }
    }

    // 2. Check Custom Request Headers
    const headers = c.req.header();
    for (const headerKey of Object.keys(headers)) {
      const normalized = headerKey.toLowerCase().replace(/^(x-)?/g, '').replace(/[-_]/g, '');
      if (FORBIDDEN_CLIENT_IDENTITY_KEYS.includes(normalized)) {
        logger.warn(`Security violation: Client attempted to supply forbidden identity header '${headerKey}'`);
        throw new BadRequestError(
          `Security violation: Header '${headerKey}' cannot be supplied by client. Identity and Google Drive folder associations are strictly authoritative and derived by the server.`
        );
      }
    }

    await next();
  });

  // Protected Auth Middleware helper
  const requireAuth = async (c: any, next: () => Promise<void>) => {
    const authHeader = c.req.header('authorization') || c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Authentication required. Provide a valid Bearer token.');
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      throw new UnauthorizedError('Authentication required. Bearer token is empty.');
    }

    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    let verified;
    try {
      verified = await tokenVerifier(token, { projectId });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new UnauthorizedError(`Invalid or rejected Firebase ID token: ${msg}`);
    }

    c.set('verifiedUid', verified.uid);
    c.set('verifiedEmail', verified.email);
    c.set('tokenClaims', verified.claims);

    await next();
  };

  // Protected Admin Auth Middleware
  // Verifies the Firebase ID token AND validates that the Firestore record users/{uid} has role === 'admin' and status === 'active'
  const requireAdminAuth = async (c: any, next: () => Promise<void>) => {
    const authHeader = c.req.header('authorization') || c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Administrator authentication required. Provide a valid Bearer token.');
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      throw new UnauthorizedError('Administrator authentication required. Bearer token is empty.');
    }

    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    let verified;
    try {
      verified = await tokenVerifier(token, { projectId });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new UnauthorizedError(`Invalid or rejected Firebase ID token: ${msg}`);
    }

    const uid = verified.uid;
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);
    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    // Authoritative verification of admin role from Firestore users/{uid}
    const adminDoc = await firestoreRestService.getDocument('users', uid, {
      projectId,
      serviceAccountJson
    });

    if (!adminDoc) {
      logger.warn(`Admin access denied: No Firestore profile exists for UID '${uid}'`);
      throw new ForbiddenError('Access denied: Administrator profile not found.');
    }

    if (adminDoc.role !== 'admin') {
      logger.warn(`Admin access denied: UID '${uid}' has role '${adminDoc.role}', expected 'admin'`);
      throw new ForbiddenError('Access denied: Insufficient privileges. Administrator role required.');
    }

    if (adminDoc.status !== 'active') {
      logger.warn(`Admin access denied: UID '${uid}' is inactive`);
      throw new ForbiddenError('Access denied: Administrator account is inactive.');
    }

    c.set('verifiedUid', verified.uid);
    c.set('verifiedEmail', verified.email);
    c.set('tokenClaims', verified.claims);

    await next();
  };

  // ==========================================
  // ROUTE 1: GET /api/health (Public)
  // ==========================================
  app.get('/api/health', (c) => {
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const envName = (c.env?.NODE_ENV as string) || 'production';

    const healthData = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: envName,
      service: 'Backend API Service',
      version: '1.0.0',
      runtime: 'cloudflare-workers',
      firebase: {
        initialized: true,
        targetProjectId: projectId,
        authMethod: 'RS256 Web Crypto JWKS'
      },
      endpoints: {
        health: 'GET /api/health',
        firebaseHealth: 'GET /api/health/firebase',
        profile: 'GET /api/profile (Protected - Requires Bearer <Firebase ID Token>)',
        documents: 'GET /api/documents (Protected - Requires Bearer <Firebase ID Token>)',
        documentDownload: 'GET /api/documents/:documentId/download (Protected - Requires Bearer <Firebase ID Token>)',
        documentUpload: 'POST /api/documents/upload (Protected - Requires Bearer <Firebase ID Token>)',
        driveTest: 'GET /api/drive/test (Protected - Requires Bearer <Firebase ID Token>)',
        adminClientsList: 'GET /api/admin/clients (Protected - Requires Admin Bearer <Firebase ID Token>)',
        adminClientsCreate: 'POST /api/admin/clients (Protected - Requires Admin Bearer <Firebase ID Token>)',
        adminClientDocumentsList: 'GET /api/admin/clients/:clientId/documents (Protected - Requires Admin Bearer <Firebase ID Token>)',
        adminClientDocumentDownload: 'GET /api/admin/clients/:clientId/documents/:documentId/download (Protected - Requires Admin Bearer <Firebase ID Token>)',
        adminClientDocumentUpload: 'POST /api/admin/clients/:clientId/documents/upload (Protected - Requires Admin Bearer <Firebase ID Token>)',
        notificationsList: 'GET /api/notifications (Protected - Requires Bearer <Firebase ID Token>)',
        notificationsUnreadCount: 'GET /api/notifications/unread-count (Protected - Requires Bearer <Firebase ID Token>)',
        notificationMarkRead: 'PATCH /api/notifications/:notificationId/read (Protected - Requires Bearer <Firebase ID Token>)',
        notificationsMarkAllRead: 'POST /api/notifications/mark-all-read (Protected - Requires Bearer <Firebase ID Token>)',
        notificationDismiss: 'DELETE /api/notifications/:notificationId (Protected - Requires Bearer <Firebase ID Token>)',
        adminNotificationCreate: 'POST /api/admin/notifications (Protected - Requires Admin Bearer <Firebase ID Token>)',
        fcmTokenRegister: 'POST /api/profile/fcm-token (Protected - Requires Bearer <Firebase ID Token>)',
        fcmTokenUnregister: 'DELETE /api/profile/fcm-token (Protected - Requires Bearer <Firebase ID Token>)'
      }
    };

    return c.json({
      success: true,
      message: 'API service is operational',
      data: healthData,
      timestamp: new Date().toISOString()
    }, 200);
  });

  // ==========================================
  // ROUTE 2: GET /api/health/firebase
  // ==========================================
  app.get('/api/health/firebase', async (c) => {
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    let firestoreStatus: {
      connected: boolean;
      projectId: string;
      latencyMs?: number;
      error?: string;
    };

    if (!serviceAccountJson) {
      firestoreStatus = {
        connected: false,
        projectId,
        error: 'FIREBASE_SERVICE_ACCOUNT_JSON secret is not configured in Worker environment.'
      };
    } else {
      const conn = await firestoreRestService.testConnectivity({
        projectId,
        serviceAccountJson
      });
      firestoreStatus = {
        connected: conn.connected,
        projectId: conn.projectId,
        latencyMs: conn.latencyMs,
        ...(conn.error ? { error: conn.error } : {})
      };
    }

    // Optional verification of client if token present
    let authenticatedClient: { uid: string; email: string | null; tokenVerified: boolean } | null = null;
    const authHeader = c.req.header('authorization') || c.req.header('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      if (token) {
        try {
          const verified = await verifyFirebaseIdToken(token, { projectId });
          authenticatedClient = {
            uid: verified.uid,
            email: verified.email || null,
            tokenVerified: true
          };
        } catch {
          authenticatedClient = {
            uid: 'unverified',
            email: null,
            tokenVerified: false
          };
        }
      }
    }

    const diagnosticReport = {
      firebaseAdmin: {
        initialized: Boolean(serviceAccountJson),
        projectId,
        authMethod: 'RS256 Web Crypto / Cloud Firestore REST',
        message: serviceAccountJson ? 'Configured' : 'Missing FIREBASE_SERVICE_ACCOUNT_JSON secret'
      },
      firestore: {
        connected: firestoreStatus.connected,
        projectId: firestoreStatus.projectId,
        latencyMs: firestoreStatus.latencyMs,
        testedCollection: 'users',
        ...(firestoreStatus.error ? { error: firestoreStatus.error } : {})
      },
      authenticatedClient,
      timestamp: new Date().toISOString()
    };

    return c.json({
      success: true,
      message: firestoreStatus.connected
        ? 'Firebase Authentication and Cloud Firestore REST connectivity verified successfully.'
        : 'Firebase service is degraded: check service account configuration.',
      data: diagnosticReport,
      timestamp: new Date().toISOString()
    }, firestoreStatus.connected ? 200 : 503);
  });

  // ==========================================================
  // ROUTE: POST & GET /api/oauth/google/init-setup (Admin Setup Initiation)
  // Generates a short-lived single-use setup token for browser navigation.
  // Requires X-Google-OAuth-Setup-Key header with the permanent secret.
  // ==========================================================
  const handleInitSetup = async (c: any) => {
    const expectedSetupKey =
      (c.env?.GOOGLE_OAUTH_SETUP_KEY as string) ||
      (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_SETUP_KEY : undefined);

    if (!expectedSetupKey || !expectedSetupKey.trim()) {
      logger.error('OAuth setup rejected: GOOGLE_OAUTH_SETUP_KEY is not configured in Worker secrets.');
      throw new AppError(
        500,
        'Server configuration error: GOOGLE_OAUTH_SETUP_KEY secret is missing.',
        'SERVER_CONFIG_ERROR'
      );
    }

    const providedKey =
      c.req.header('x-google-oauth-setup-key') ||
      c.req.header('X-Google-OAuth-Setup-Key');

    if (!providedKey || !timingSafeEqual(providedKey.trim(), expectedSetupKey.trim())) {
      logger.warn('Unauthorized attempt to access /api/oauth/google/init-setup with missing or invalid setup key.');
      throw new UnauthorizedError('Unauthorized: Missing or invalid X-Google-OAuth-Setup-Key header.');
    }

    // Generate single-use signed setup session (expires in 10 minutes / 600s)
    const session = await createSetupSession(expectedSetupKey.trim(), c.env?.GOOGLE_OAUTH_STATE, 600);
    const reqUrl = new URL(c.req.url);
    const setupUrl = `${reqUrl.origin}${session.setupUrlPath}`;

    return c.json({
      success: true,
      setupUrl,
      expiresInSeconds: session.expiresInSeconds,
      message: 'Open setupUrl in your browser to authorize Google Drive. This one-time link expires in 10 minutes.'
    }, 200);
  };

  app.post('/api/oauth/google/init-setup', handleInitSetup);
  app.get('/api/oauth/google/init-setup', handleInitSetup);

  // ==========================================================
  // ROUTE: GET /api/oauth/google/start (Browser OAuth Initiation)
  // Validates short-lived, single-use ?setup=<token> and redirects to Google consent screen.
  // Does NOT require HTTP headers so it can be opened directly in standard web browsers.
  // ==========================================================
  app.get('/api/oauth/google/start', async (c) => {
    const setupToken = c.req.query('setup');
    const expectedSetupKey =
      (c.env?.GOOGLE_OAUTH_SETUP_KEY as string) ||
      (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_SETUP_KEY : undefined);

    if (!expectedSetupKey || !expectedSetupKey.trim()) {
      logger.error('OAuth setup rejected: GOOGLE_OAUTH_SETUP_KEY is not configured in Worker secrets.');
      throw new AppError(
        500,
        'Server configuration error: GOOGLE_OAUTH_SETUP_KEY secret is missing.',
        'SERVER_CONFIG_ERROR'
      );
    }

    const failureHtml = (title: string, message: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background-color: #f8fafc;
      color: #0f172a;
    }
    .card {
      background: #ffffff;
      padding: 2.5rem;
      border-radius: 12px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      max-width: 440px;
      text-align: center;
      border: 1px solid #e2e8f0;
    }
    h1 {
      font-size: 1.35rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      color: #dc2626;
    }
    p {
      font-size: 0.95rem;
      line-height: 1.5;
      color: #475569;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;

    if (!setupToken || !setupToken.trim()) {
      logger.warn('OAuth start rejected: missing setup token in query parameter.');
      return c.html(
        failureHtml(
          'Setup Authorization Required',
          'A valid, short-lived setup authorization token is required to start Google Drive authorization. Please generate a setup link via /api/oauth/google/init-setup.'
        ),
        401
      );
    }

    // Validate and consume setup token (single-use, expires in ~10m)
    const isValidSetup = await validateAndConsumeSetupToken(
      setupToken.trim(),
      expectedSetupKey.trim(),
      c.env?.GOOGLE_OAUTH_STATE
    );

    if (!isValidSetup) {
      logger.warn('OAuth start rejected: invalid, expired, or replayed setup token.');
      return c.html(
        failureHtml(
          'Setup Authorization Failed',
          'The setup authorization link is invalid, has expired, or has already been used. Please request a new setup link.'
        ),
        401
      );
    }

    // Validate required OAuth credentials
    const clientId =
      (c.env?.GOOGLE_OAUTH_CLIENT_ID as string) ||
      (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_CLIENT_ID : undefined);
    const clientSecret =
      (c.env?.GOOGLE_OAUTH_CLIENT_SECRET as string) ||
      (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_CLIENT_SECRET : undefined);
    const encryptionKey =
      (c.env?.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY as string) ||
      (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY : undefined);

    if (!clientId || !clientId.trim()) {
      throw new AppError(
        500,
        'Server configuration error: GOOGLE_OAUTH_CLIENT_ID secret is missing.',
        'SERVER_CONFIG_ERROR'
      );
    }
    if (!clientSecret || !clientSecret.trim()) {
      throw new AppError(
        500,
        'Server configuration error: GOOGLE_OAUTH_CLIENT_SECRET secret is missing.',
        'SERVER_CONFIG_ERROR'
      );
    }
    if (!encryptionKey || !encryptionKey.trim()) {
      throw new AppError(
        500,
        'Server configuration error: GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY secret is missing.',
        'SERVER_CONFIG_ERROR'
      );
    }

    // Generate cryptographically random OAuth state
    const state = generateOAuthState();

    // Store state in Cloudflare KV (expires in 10 minutes / 600s)
    await storeOAuthState(state, c.env?.GOOGLE_OAUTH_STATE, 600);

    // Construct Google OAuth authorization URL
    const redirectUri = resolveOAuthRedirectUri(c.env);

    const authUrl = buildGoogleOAuthUrl({
      clientId,
      redirectUri,
      state
    });

    logger.info('OAuth flow initiated: redirecting administrator to Google authorization endpoint.');

    // Redirect browser to Google's consent screen
    return c.redirect(authUrl, 302);
  });

  // ==========================================================
  // ROUTE: GET /api/oauth/google/callback (OAuth Callback)
  // Handles Google's authorization callback, exchanges code for tokens,
  // encrypts refresh token, stores it in Firestore oauth/googleDrive,
  // and renders a clean HTML status page.
  // ==========================================================
  app.get('/api/oauth/google/callback', async (c) => {
    const successHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Google Drive Authorization</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background-color: #f8fafc;
      color: #0f172a;
    }
    .card {
      background: #ffffff;
      padding: 2.5rem;
      border-radius: 12px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      max-width: 440px;
      text-align: center;
      border: 1px solid #e2e8f0;
    }
    h1 {
      font-size: 1.35rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      color: #15803d;
    }
    p {
      font-size: 0.95rem;
      line-height: 1.5;
      color: #475569;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorization Complete</h1>
    <p>Google Drive authorization completed successfully.<br>You may close this window.</p>
  </div>
</body>
</html>`;

    const failureHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Google Drive Authorization Failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background-color: #f8fafc;
      color: #0f172a;
    }
    .card {
      background: #ffffff;
      padding: 2.5rem;
      border-radius: 12px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      max-width: 440px;
      text-align: center;
      border: 1px solid #e2e8f0;
    }
    h1 {
      font-size: 1.35rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      color: #dc2626;
    }
    p {
      font-size: 0.95rem;
      line-height: 1.5;
      color: #475569;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorization Failed</h1>
    <p>Google Drive authorization failed.<br>Please contact the administrator.</p>
  </div>
</body>
</html>`;

    try {
      const error = c.req.query('error');
      if (error) {
        logger.warn(`Google OAuth callback received error parameter: ${error}`);
        return c.html(failureHtml, 400);
      }

      const code = c.req.query('code');
      const state = c.req.query('state');

      if (!code || !code.trim() || !state || !state.trim()) {
        logger.warn('OAuth callback missing code or state.');
        return c.html(failureHtml, 400);
      }

      // 1. Validate and immediately consume state from KV (prevents replay attacks)
      const isValidState = await validateAndConsumeOAuthState(state.trim(), c.env?.GOOGLE_OAUTH_STATE);
      if (!isValidState) {
        logger.warn('OAuth callback rejected: Invalid or expired state parameter.');
        return c.html(failureHtml, 400);
      }

      // 2. Load required OAuth configuration
      const clientId =
        (c.env?.GOOGLE_OAUTH_CLIENT_ID as string) ||
        (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_CLIENT_ID : undefined);
      const clientSecret =
        (c.env?.GOOGLE_OAUTH_CLIENT_SECRET as string) ||
        (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_CLIENT_SECRET : undefined);
      const encryptionKey =
        (c.env?.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY as string) ||
        (typeof process !== 'undefined' ? process.env?.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY : undefined);
      const projectId =
        (c.env?.FIREBASE_PROJECT_ID as string) ||
        (typeof process !== 'undefined' ? process.env?.FIREBASE_PROJECT_ID : undefined) ||
        'document-portal-d2b6d';
      const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

      if (!clientId || !clientSecret || !encryptionKey || !serviceAccountJson) {
        logger.error('OAuth callback missing server secrets configuration.');
        return c.html(failureHtml, 500);
      }

      const redirectUri = resolveOAuthRedirectUri(c.env);

      // 3. Exchange authorization code for tokens
      const tokenResult = await exchangeAuthorizationCode({
        clientId,
        clientSecret,
        code: code.trim(),
        redirectUri
      });

      // 4. Encrypt refresh token using AES-256-GCM
      const encryptedRefreshToken = await encryptRefreshToken(
        tokenResult.refreshToken,
        encryptionKey
      );

      // 5. Retrieve storage-owner account email safely (optional metadata)
      const accountEmail = await getGoogleDriveAccountEmail(tokenResult.accessToken);

      // 6. Store encrypted refresh token in dedicated Firestore document: oauth/googleDrive
      await firestoreRestService.setDocument(
        'oauth',
        'googleDrive',
        {
          provider: 'google-drive',
          accountEmail: accountEmail || null,
          refreshTokenCiphertext: encryptedRefreshToken,
          updatedAt: new Date().toISOString()
        },
        {
          projectId,
          serviceAccountJson
        }
      );

      // 7. Clear in-memory token cache so fresh token will be used immediately
      clearOAuthTokenCache();

      logger.info(`Google Drive OAuth setup completed successfully for account: ${accountEmail || 'unknown'}`);

      return c.html(successHtml, 200);
    } catch (err) {
      logger.error('Google OAuth callback failed:', err instanceof Error ? err.message : String(err));
      return c.html(failureHtml, 400);
    }
  });

  // ==========================================
  // ROUTE 3: GET /api/profile (Protected)
  // ==========================================
  app.get('/api/profile', requireAuth, async (c) => {
    const uid = c.get('verifiedUid');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    logger.info(`Worker: Processing GET /api/profile for verified UID: ${uid}`);

    const clientProfile = await firestoreRestService.getClientProfile(uid, {
      projectId,
      serviceAccountJson
    });

    // 403 if inactive
    if (clientProfile.status !== 'active') {
      throw new ForbiddenError('User is inactive. Active status is required to access profile.');
    }

    // Return strictly only the permitted profile fields:
    // { name, email, phone, maskedPanNumber, panNumber, role, status }
    // Never expose driveFolderId or internal service account information.
    return c.json({
      name: clientProfile.name,
      email: clientProfile.email,
      phone: clientProfile.phone,
      maskedPanNumber: maskPanNumber(clientProfile.panNumber),
      panNumber: clientProfile.panNumber,
      role: clientProfile.role,
      status: clientProfile.status
    }, 200);
  });

  // ==========================================
  // ROUTE 3B: POST /api/profile/fcm-token (Client Protected)
  // Registers or updates device FCM token in users/{verifiedUid}/fcmTokens/{sha256(token)}
  // Strictly derives client UID from verified auth token and rejects forbidden identity keys.
  // ==========================================
  app.post('/api/profile/fcm-token', requireAuth, async (c) => {
    const callerUid = c.get('verifiedUid');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError('Request body must be a valid JSON object.');
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestError('Request body must be a valid JSON object.');
    }

    // Zero-Trust Guard: Reject any attempt to supply UID or ownership keys
    for (const key of Object.keys(body)) {
      const normalized = key.toLowerCase().replace(/[-_]/g, '');
      if (FORBIDDEN_CLIENT_IDENTITY_KEYS.includes(normalized)) {
        logger.warn(`Security violation: Client supplied forbidden field '${key}' in FCM token registration body`);
        throw new BadRequestError(
          `Security violation: Field '${key}' cannot be supplied in body. Identity is strictly authoritative.`
        );
      }
    }

    const result = await fcmService.registerFcmToken(callerUid, body, {
      projectId,
      serviceAccountJson
    });

    return c.json({
      success: true,
      message: result.message,
      timestamp: new Date().toISOString()
    }, 200);
  });

  // ==========================================
  // ROUTE 3C: DELETE /api/profile/fcm-token (Client Protected)
  // Unregisters/removes device FCM token from users/{verifiedUid}/fcmTokens/{sha256(token)}
  // Idempotent and strictly scoped to caller's verified UID.
  // ==========================================
  app.delete('/api/profile/fcm-token', requireAuth, async (c) => {
    const callerUid = c.get('verifiedUid');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError('Request body must be a valid JSON object.');
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestError('Request body must be a valid JSON object.');
    }

    // Zero-Trust Guard: Reject any attempt to supply UID or ownership keys
    for (const key of Object.keys(body)) {
      const normalized = key.toLowerCase().replace(/[-_]/g, '');
      if (FORBIDDEN_CLIENT_IDENTITY_KEYS.includes(normalized)) {
        logger.warn(`Security violation: Client supplied forbidden field '${key}' in FCM token deletion body`);
        throw new BadRequestError(
          `Security violation: Field '${key}' cannot be supplied in body. Identity is strictly authoritative.`
        );
      }
    }

    const result = await fcmService.unregisterFcmToken(callerUid, body, {
      projectId,
      serviceAccountJson
    });

    return c.json({
      success: true,
      message: result.message,
      timestamp: new Date().toISOString()
    }, 200);
  });

  // ==========================================
  // ROUTE 4: GET /api/drive/test (Protected)
  // ==========================================
  app.get('/api/drive/test', requireAuth, async (c) => {
    const uid = c.get('verifiedUid');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    logger.info(`Worker: Processing GET /api/drive/test for verified UID: ${uid}`);

    const clientProfile = await firestoreRestService.getClientProfile(uid, {
      projectId,
      serviceAccountJson
    });

    if (clientProfile.status !== 'active') {
      throw new ForbiddenError('User is inactive. Active status is required to access Google Drive documents.');
    }

    const driveFolderId = clientProfile.driveFolderId;
    if (!driveFolderId || !driveFolderId.trim()) {
      throw new BadRequestError('driveFolderId is missing from the authenticated user\'s Firestore profile.');
    }

    const cleanFolderId = driveFolderId.trim();

    // Resolve Drive authorization options (prefers OAuth, falls back to service account)
    const driveAuthOptions = await resolveDriveAuthOptions(c.env, serviceAccountJson);

    // Retrieve safe metadata and file list via Drive REST API
    const folderMetadata = await googleDriveRestService.getDriveFolderMetadata(cleanFolderId, driveAuthOptions);
    const files = await googleDriveRestService.listFilesInFolder(cleanFolderId, driveAuthOptions);

    logger.info(`Worker: Retrieved Drive folder '${folderMetadata.name}' and ${files.length} files for UID: ${uid}`);

    // Return strictly and only the safe folder and files representation with authoritative attribution
    // Never return driveFolderId or service-account information
    return c.json({
      success: true,
      folder: {
        name: folderMetadata.name,
        mimeType: folderMetadata.mimeType
      },
      files: (files || []).map((file) => ({
        ...file,
        uploaderType: 'administrator' as const,
        uploaderName: 'Administrator'
      }))
    }, 200);
  });

  // ==========================================
  // ROUTE 5: GET /api/documents (Protected)
  // ==========================================
  app.get('/api/documents', requireAuth, async (c) => {
    const uid = c.get('verifiedUid');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    logger.info(`Worker: Processing GET /api/documents for verified UID: ${uid}`);

    const clientProfile = await firestoreRestService.getClientProfile(uid, {
      projectId,
      serviceAccountJson
    });

    if (clientProfile.status !== 'active') {
      throw new ForbiddenError('User is inactive. Active status is required to access documents.');
    }

    const driveFolderId = clientProfile.driveFolderId;
    if (!driveFolderId || !driveFolderId.trim()) {
      throw new BadRequestError('driveFolderId is missing from the authenticated user\'s Firestore profile.');
    }

    const authoritativePanFolderId = driveFolderId.trim();
    const authoritativeClientName = (clientProfile.name && clientProfile.name.trim()) ? clientProfile.name.trim() : 'Client';

    // Resolve Drive authorization options (prefers OAuth, falls back to service account)
    const driveAuthOptions = await resolveDriveAuthOptions(c.env, serviceAccountJson);

    // 1. List files directly inside authoritative PAN folder (Administrator documents)
    const panFiles = await googleDriveRestService.listFilesInFolder(authoritativePanFolderId, driveAuthOptions);

    // 2. Search for direct-child 'upload' subfolder
    const uploadFolderId = await googleDriveRestService.getClientUploadFolderId(
      authoritativePanFolderId,
      driveAuthOptions,
      false // Do NOT create folder during listing if missing
    );

    // 3. If upload folder exists, list files inside upload folder (Client documents)
    let uploadFiles: any[] = [];
    if (uploadFolderId) {
      try {
        uploadFiles = await googleDriveRestService.listFilesInFolder(uploadFolderId, driveAuthOptions);
      } catch (err) {
        logger.warn(`Failed to list upload folder for UID ${uid}, continuing with PAN files:`, err);
      }
    }

    // 4. Merge results with authoritative uploader attribution
    // Exclude folders, shortcuts, and inappropriate objects; deduplicate by file id
    const seenIds = new Set<string>();
    const mergedDocuments = [];

    // First: Direct children of PAN root -> Administrator
    for (const file of panFiles) {
      if (
        file &&
        file.id &&
        file.name &&
        file.mimeType !== 'application/vnd.google-apps.folder' &&
        file.mimeType !== 'application/vnd.google-apps.shortcut' &&
        !file.mimeType.startsWith('application/vnd.google-apps.')
      ) {
        if (!seenIds.has(file.id)) {
          seenIds.add(file.id);
          mergedDocuments.push({
            ...file,
            uploaderType: 'administrator' as const,
            uploaderName: 'Administrator'
          });
        }
      }
    }

    // Second: Direct children of PAN/upload subfolder -> Authenticated Client
    for (const file of uploadFiles) {
      if (
        file &&
        file.id &&
        file.name &&
        file.mimeType !== 'application/vnd.google-apps.folder' &&
        file.mimeType !== 'application/vnd.google-apps.shortcut' &&
        !file.mimeType.startsWith('application/vnd.google-apps.')
      ) {
        if (!seenIds.has(file.id)) {
          seenIds.add(file.id);
          mergedDocuments.push({
            ...file,
            uploaderType: 'client' as const,
            uploaderName: authoritativeClientName
          });
        }
      }
    }

    logger.info(`Worker: Retrieved ${mergedDocuments.length} document(s) (PAN + upload) for UID: ${uid}`);

    // Authoritative password-protection status enrichment
    const documentsWithProtection = await Promise.all(
      mergedDocuments.map(async (doc) => {
        try {
          const pwMeta = await firestoreRestService.getDocument('documentPasswords', doc.id, {
            projectId,
            serviceAccountJson
          });
          return {
            ...doc,
            isPasswordProtected: Boolean(pwMeta && pwMeta.isPasswordProtected === true)
          };
        } catch {
          return {
            ...doc,
            isPasswordProtected: false
          };
        }
      })
    );

    return c.json({
      success: true,
      documents: documentsWithProtection
    }, 200);
  });

  // ==========================================================
  // ROUTE 6: GET /api/documents/:documentId/download (Protected)
  // ==========================================================
  app.get('/api/documents/:documentId/download', requireAuth, async (c) => {
    const rawDocId = c.req.param('documentId');
    if (!rawDocId || typeof rawDocId !== 'string' || !rawDocId.trim()) {
      throw new BadRequestError('A valid Google Drive document ID is required.');
    }

    const documentId = rawDocId.trim();

    // Prevent path traversal, directory separators, null bytes, and malformed characters.
    // Google Drive file IDs typically consist of alphanumeric characters, hyphens, and underscores.
    if (!/^[a-zA-Z0-9_-]{5,100}$/.test(documentId)) {
      throw new BadRequestError('Invalid document ID format. Malformed identifiers and path traversal are strictly prohibited.');
    }

    // Identity MUST come exclusively from verified Firebase token
    const uid = c.get('verifiedUid');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    logger.info(`Worker: Processing GET /api/documents/${documentId}/download for verified UID: ${uid}`);

    // Load authoritative user profile from Firestore
    const clientProfile = await firestoreRestService.getClientProfile(uid, {
      projectId,
      serviceAccountJson
    });

    // Enforce active status
    if (clientProfile.status !== 'active') {
      throw new ForbiddenError('User is inactive. Active status is required to download documents.');
    }

    // Authoritative driveFolderId read ONLY from Firestore
    const driveFolderId = clientProfile.driveFolderId;
    if (!driveFolderId || !driveFolderId.trim()) {
      throw new BadRequestError('driveFolderId is missing from the authenticated user\'s Firestore profile.');
    }

    const authoritativeDriveFolderId = driveFolderId.trim();

    // Resolve Drive authorization options (prefers OAuth, falls back to service account)
    const driveAuthOptions = await resolveDriveAuthOptions(c.env, serviceAccountJson);

    // 1. Retrieve file metadata from Google Drive v3 REST API
    let fileMetadata;
    try {
      fileMetadata = await googleDriveRestService.getFileMetadata(documentId, driveAuthOptions);
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError('Document not found or inaccessible.');
      }
      throw err;
    }

    // 2. Validate file.id matches requested documentId
    if (fileMetadata.id !== documentId) {
      throw new NotFoundError('Document not found or inaccessible.');
    }

    // 3. Reject trashed files
    if (fileMetadata.trashed) {
      logger.warn(`Download rejected: Document ${documentId} is trashed.`);
      throw new NotFoundError('Document not found or inaccessible.');
    }

    // 4. File Type Security: Reject folders, shortcuts, and Google Workspace internal editor types
    if (
      fileMetadata.mimeType === 'application/vnd.google-apps.folder' ||
      fileMetadata.mimeType === 'application/vnd.google-apps.shortcut' ||
      fileMetadata.mimeType.startsWith('application/vnd.google-apps.')
    ) {
      logger.warn(`Download rejected: Unsupported mimeType '${fileMetadata.mimeType}' for document ${documentId}`);
      throw new NotFoundError('Document not found or inaccessible.');
    }

    // 5. CRITICAL IDOR PROTECTION:
    // File must be directly inside the authoritative PAN folder OR inside the client's direct-child 'upload' folder.
    let isAuthorized = Boolean(
      fileMetadata.parents && fileMetadata.parents.includes(authoritativeDriveFolderId)
    );

    if (!isAuthorized) {
      // Check if file is in client's direct-child upload folder
      const uploadFolderId = await googleDriveRestService.getClientUploadFolderId(
        authoritativeDriveFolderId,
        driveAuthOptions,
        false // Do NOT create folder during download check
      );

      if (uploadFolderId && fileMetadata.parents && fileMetadata.parents.includes(uploadFolderId)) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      logger.warn(`IDOR Prevention: UID ${uid} attempted to download file ${documentId} belonging to another folder or client.`);
      // Return 404 to prevent cross-tenant enumeration
      throw new NotFoundError('Document not found or inaccessible.');
    }

    // 6. Retrieve file content stream from Google Drive using alt=media
    const downloadResult = await googleDriveRestService.downloadFileStream(documentId, driveAuthOptions);

    if (!downloadResult.stream) {
      throw new BadGatewayError('Unable to retrieve file stream from Google Drive.');
    }

    // 7. Sanitize filename and prepare safe response headers
    const { contentDisposition } = sanitizeFilename(fileMetadata.name, `document_${documentId}.bin`);

    const headers = new Headers();
    headers.set('Content-Type', fileMetadata.mimeType || 'application/octet-stream');
    headers.set('Content-Disposition', contentDisposition);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');

    const contentLength = fileMetadata.size || downloadResult.contentLength;
    if (contentLength && /^\d+$/.test(contentLength)) {
      headers.set('Content-Length', contentLength);
    }

    // Return the response stream safely to the client
    return new Response(downloadResult.stream, {
      status: 200,
      headers
    });
  });

  // ==========================================================
  // ROUTE 7: POST /api/documents/upload (Protected)
  // ==========================================================
  app.post('/api/documents/upload', requireAuth, async (c) => {
    const uid = c.get('verifiedUid');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    logger.info(`Worker: Processing POST /api/documents/upload for verified UID: ${uid}`);

    // Verify Content-Type is multipart/form-data
    const contentType = c.req.header('content-type') || '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      throw new BadRequestError('Content-Type must be multipart/form-data for document upload.');
    }

    // 1. Authoritative Firestore Profile Resolution
    const clientProfile = await firestoreRestService.getClientProfile(uid, {
      projectId,
      serviceAccountJson
    });

    if (clientProfile.status !== 'active') {
      throw new ForbiddenError('User is inactive. Active status is required to upload documents.');
    }

    const driveFolderId = clientProfile.driveFolderId;
    if (!driveFolderId || !driveFolderId.trim()) {
      throw new BadRequestError('driveFolderId is missing from the authenticated user\'s Firestore profile.');
    }

    const authoritativeDriveFolderId = driveFolderId.trim();
    const authoritativeClientName = (clientProfile.name && clientProfile.name.trim()) ? clientProfile.name.trim() : 'Client';

    // Resolve Drive authorization options (prefers OAuth, falls back to service account)
    const driveAuthOptions = await resolveDriveAuthOptions(c.env, serviceAccountJson);

    // 2. Ensure target authoritative PAN Drive folder exists and is usable
    await googleDriveRestService.getDriveFolderMetadata(authoritativeDriveFolderId, driveAuthOptions);

    // 3. Resolve or create direct-child 'upload' subfolder under authoritative PAN folder
    const uploadFolderId = await googleDriveRestService.getClientUploadFolderId(
      authoritativeDriveFolderId,
      driveAuthOptions,
      true // Create if missing
    );

    if (!uploadFolderId) {
      throw new BadGatewayError('Failed to resolve or create upload destination folder.');
    }

    // 4. Parse Multipart Form Data
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch (err) {
      logger.error('Failed to parse multipart form data:', err);
      throw new BadRequestError('Invalid multipart form data.');
    }

    // 5. Zero-Trust check on multipart fields:
    // Reject any client-supplied identity or destination folder fields
    for (const key of formData.keys()) {
      const normalized = key.toLowerCase().replace(/[-_]/g, '');
      if (FORBIDDEN_CLIENT_IDENTITY_KEYS.includes(normalized)) {
        logger.warn(`Security violation: Client supplied forbidden field '${key}' in upload form data`);
        throw new BadRequestError(
          `Security violation: Field '${key}' cannot be supplied in multipart form data. Identity and destination folder associations are strictly authoritative.`
        );
      }
    }

    // 6. Extract and validate file field
    const file = formData.get('file');
    if (!file) {
      throw new BadRequestError('Missing required multipart file field \'file\'.');
    }

    // Strict multi-layer file validation (size, MIME type, extension, signature, sanitization)
    const validatedFile = await validateUploadedFile(file);

    // Validate optional documentPassword
    const rawDocumentPassword = formData.get('documentPassword') ?? formData.get('password');
    let documentPassword: string | undefined;

    if (rawDocumentPassword !== null && rawDocumentPassword !== undefined) {
      if (typeof rawDocumentPassword !== 'string') {
        throw new BadRequestError('documentPassword must be a string.');
      }
      const trimmed = rawDocumentPassword.trim();
      if (trimmed.length === 0) {
        throw new BadRequestError('Document password cannot be empty or whitespace-only.');
      }
      if (trimmed.length > 128) {
        throw new BadRequestError('Document password must not exceed 128 characters.');
      }
      documentPassword = rawDocumentPassword;
    }

    const isPasswordProtected = Boolean(documentPassword);

    // Validate that DOCUMENT_PASSWORD_ENCRYPTION_KEY exists BEFORE uploading to Google Drive
    let passwordEncryptionKey: string | undefined;
    if (isPasswordProtected) {
      passwordEncryptionKey = getDocumentPasswordEncryptionKey(c.env);
      if (!passwordEncryptionKey) {
        throw new AppError(
          500,
          'Server configuration error: DOCUMENT_PASSWORD_ENCRYPTION_KEY is missing.',
          'SERVER_CONFIG_ERROR'
        );
      }
    }

    // 7. Upload directly to Google Drive into the client's authoritative 'upload' subfolder
    // Exactly one destination parent: the resolved upload folder ID.
    const uploadedDocument = await googleDriveRestService.uploadFileMultipart(
      {
        name: validatedFile.sanitizedFilename,
        mimeType: validatedFile.mimeType,
        parents: [uploadFolderId],
        content: validatedFile.buffer
      },
      driveAuthOptions
    );

    logger.info(
      `Worker: Document uploaded successfully: ID ${uploadedDocument.id}, name '${uploadedDocument.name}' to upload subfolder for UID: ${uid} (passwordProtected: ${isPasswordProtected})`
    );

    // 8. If password protected, encrypt and store metadata in documentPasswords/{driveFileId}
    if (isPasswordProtected && documentPassword && passwordEncryptionKey) {
      try {
        const encrypted = await encryptDocumentPassword(documentPassword, passwordEncryptionKey);
        const nowIso = new Date().toISOString();
        await firestoreRestService.setDocument(
          'documentPasswords',
          uploadedDocument.id,
          {
            driveFileId: uploadedDocument.id,
            clientId: uid,
            isPasswordProtected: true,
            encryptedPassword: encrypted.encryptedPassword,
            iv: encrypted.iv,
            algorithm: encrypted.algorithm,
            keyVersion: encrypted.keyVersion,
            createdAt: nowIso,
            updatedAt: nowIso
          },
          {
            projectId,
            serviceAccountJson
          }
        );
      } catch (err) {
        logger.error('Failed to persist document password metadata after upload:', err instanceof Error ? err.message : String(err));
        // Safe cleanup / rollback of uploaded file from Google Drive
        try {
          await googleDriveRestService.deleteFile(uploadedDocument.id, driveAuthOptions);
          logger.info(`Rolled back Google Drive file ${uploadedDocument.id} due to password metadata persistence failure.`);
        } catch (cleanupErr) {
          logger.error(`Failed to clean up Google Drive file ${uploadedDocument.id} during rollback:`, cleanupErr);
        }
        throw new AppError(500, 'Failed to store document security metadata. Upload was aborted.', 'METADATA_PERSISTENCE_ERROR');
      }
    }

    // 9. Return safe metadata response
    // Never expose driveFolderId, uploadFolderId, service account info, UID, password, IV, or encryption key
    const docResponse = {
      id: uploadedDocument.id,
      name: uploadedDocument.name,
      mimeType: uploadedDocument.mimeType,
      size: uploadedDocument.size || String(validatedFile.sizeBytes),
      createdTime: uploadedDocument.createdTime || new Date().toISOString(),
      uploaderType: 'client' as const,
      uploaderName: authoritativeClientName,
      isPasswordProtected
    };

    return c.json({
      success: true,
      message: 'Document uploaded successfully.',
      data: {
        document: docResponse
      },
      document: docResponse
    }, 200);
  });

  // ==========================================
  // ROUTE 7: GET /api/admin/clients (Protected - Admin Only)
  // Returns all registered client profiles.
  // ==========================================
  app.get('/api/admin/clients', requireAdminAuth, async (c) => {
    const adminUid = c.get('verifiedUid');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    logger.info(`Worker: Processing GET /api/admin/clients for admin UID: ${adminUid}`);

    const driveAuthOptions = await resolveDriveAuthOptions(c.env, serviceAccountJson);
    const clients = await adminClientService.listClients({
      projectId,
      serviceAccountJson,
      driveAuthOptions
    });

    return c.json({
      success: true,
      data: {
        clients,
        total: clients.length
      },
      timestamp: new Date().toISOString()
    }, 200);
  });

  // ==========================================
  // ROUTE 8: POST /api/admin/clients (Protected - Admin Only)
  // Provisions a new client: Auth user, Drive folders, Firestore profile, PAN index.
  // ==========================================
  app.post('/api/admin/clients', requireAdminAuth, async (c) => {
    const adminUid = c.get('verifiedUid');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError('Invalid JSON request body.');
    }

    // Strict validation of input and zero-trust prohibition of identity/role overrides
    const validatedInput = validateCreateClientInput(body);

    logger.info(`Worker: Processing POST /api/admin/clients for PAN: ${validatedInput.panNumber} by admin UID: ${adminUid}`);

    const driveAuthOptions = await resolveDriveAuthOptions(c.env, serviceAccountJson);
    const result = await adminClientService.createClient(validatedInput, {
      projectId,
      serviceAccountJson,
      driveAuthOptions
    });

    return c.json({
      success: true,
      message: 'Client provisioned successfully.',
      data: {
        client: result
      },
      timestamp: new Date().toISOString()
    }, 201);
  });

  // ==========================================
  // ROUTE 9: GET /api/admin/clients/:clientId/documents (Protected - Admin Only)
  // Returns complete document repository for selected client (PAN root files, upload folder, upload folder files)
  // ==========================================
  app.get('/api/admin/clients/:clientId/documents', requireAdminAuth, async (c) => {
    const adminUid = c.get('verifiedUid');
    const rawClientId = c.req.param('clientId');

    if (!rawClientId || typeof rawClientId !== 'string' || !rawClientId.trim()) {
      throw new BadRequestError('A valid client UID parameter is required.');
    }

    const clientId = rawClientId.trim();
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    logger.info(`Worker: Processing GET /api/admin/clients/${clientId}/documents by admin UID: ${adminUid}`);

    const driveAuthOptions = await resolveDriveAuthOptions(c.env, serviceAccountJson);
    const repository = await adminClientService.getClientDocumentRepository(clientId, {
      projectId,
      serviceAccountJson,
      driveAuthOptions
    });

    return c.json({
      success: true,
      data: repository,
      timestamp: new Date().toISOString()
    }, 200);
  });

  // ==========================================
  // ROUTE 10: GET /api/admin/clients/:clientId/documents/:documentId/download (Protected - Admin Only)
  // Streams file from selected client's authorized repository (PAN root OR upload folder)
  // ==========================================
  app.get('/api/admin/clients/:clientId/documents/:documentId/download', requireAdminAuth, async (c) => {
    const adminUid = c.get('verifiedUid');
    const rawClientId = c.req.param('clientId');
    const rawDocId = c.req.param('documentId');

    if (!rawClientId || typeof rawClientId !== 'string' || !rawClientId.trim()) {
      throw new BadRequestError('A valid client UID parameter is required.');
    }
    if (!rawDocId || typeof rawDocId !== 'string' || !rawDocId.trim()) {
      throw new BadRequestError('A valid Google Drive document ID is required.');
    }

    const clientId = rawClientId.trim();
    const documentId = rawDocId.trim();

    // Prevent path traversal, directory separators, null bytes, and malformed characters
    if (!/^[a-zA-Z0-9_-]{5,100}$/.test(documentId)) {
      throw new BadRequestError('Invalid document ID format. Malformed identifiers and path traversal are strictly prohibited.');
    }

    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    logger.info(`Worker: Processing admin download for client ${clientId}, doc ${documentId} by admin UID: ${adminUid}`);

    const driveAuthOptions = await resolveDriveAuthOptions(c.env, serviceAccountJson);

    // Verify document belongs to selected client's repository (PAN folder or upload folder)
    const { fileMetadata } = await adminClientService.verifyClientDocumentAccess(clientId, documentId, {
      projectId,
      serviceAccountJson,
      driveAuthOptions
    });

    // Retrieve file content stream from Google Drive using alt=media
    const downloadResult = await googleDriveRestService.downloadFileStream(documentId, driveAuthOptions);

    if (!downloadResult.stream) {
      throw new BadGatewayError('Unable to retrieve file stream from Google Drive.');
    }

    // Sanitize filename and prepare safe response headers
    const { contentDisposition } = sanitizeFilename(fileMetadata.name, `document_${documentId}.bin`);

    const headers = new Headers();
    headers.set('Content-Type', fileMetadata.mimeType || 'application/octet-stream');
    headers.set('Content-Disposition', contentDisposition);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');

    const contentLength = fileMetadata.size || downloadResult.contentLength;
    if (contentLength && /^\d+$/.test(contentLength)) {
      headers.set('Content-Length', contentLength);
    }

    return new Response(downloadResult.stream, {
      status: 200,
      headers
    });
  });

  // ==========================================
  // ROUTE 10B: GET /api/admin/clients/:clientId/documents/:documentId/password (Protected - Admin Only)
  // Authoritatively retrieves and decrypts the password for a client's document.
  // ==========================================
  app.get('/api/admin/clients/:clientId/documents/:documentId/password', requireAdminAuth, async (c) => {
    const adminUid = c.get('verifiedUid');
    const rawClientId = c.req.param('clientId');
    const rawDocId = c.req.param('documentId');

    if (!rawClientId || typeof rawClientId !== 'string' || !rawClientId.trim()) {
      throw new BadRequestError('A valid client UID parameter is required.');
    }
    if (!rawDocId || typeof rawDocId !== 'string' || !rawDocId.trim()) {
      throw new BadRequestError('A valid Google Drive document ID is required.');
    }

    const clientId = rawClientId.trim();
    const documentId = rawDocId.trim();

    // Prevent path traversal, directory separators, null bytes, and malformed characters
    if (!/^[a-zA-Z0-9_-]{5,100}$/.test(documentId)) {
      throw new BadRequestError('Invalid document ID format. Malformed identifiers and path traversal are strictly prohibited.');
    }

    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    const driveAuthOptions = await resolveDriveAuthOptions(c.env, serviceAccountJson);

    // Verify client exists, active, and document belongs to selected client's repository (PAN folder or upload folder)
    // IDOR / cross-client access throws NotFoundError (safe 404 response)
    await adminClientService.verifyClientDocumentAccess(clientId, documentId, {
      projectId,
      serviceAccountJson,
      driveAuthOptions
    });

    // Look up documentPasswords/{documentId}
    const passwordRecord = await firestoreRestService.getDocument('documentPasswords', documentId, {
      projectId,
      serviceAccountJson
    });

    // If no password metadata exists or not password protected, return safe response
    if (!passwordRecord || !passwordRecord.isPasswordProtected || !passwordRecord.encryptedPassword) {
      return c.json({
        success: true,
        data: {
          documentId,
          isPasswordProtected: false,
          password: null
        }
      }, 200);
    }

    // Retrieve DOCUMENT_PASSWORD_ENCRYPTION_KEY
    const encryptionKey = getDocumentPasswordEncryptionKey(c.env);
    if (!encryptionKey) {
      throw new AppError(
        500,
        'Server configuration error: DOCUMENT_PASSWORD_ENCRYPTION_KEY is missing.',
        'SERVER_CONFIG_ERROR'
      );
    }

    // Decrypt the password
    const decryptedPassword = await decryptDocumentPassword(
      {
        encryptedPassword: String(passwordRecord.encryptedPassword),
        iv: String(passwordRecord.iv),
        algorithm: passwordRecord.algorithm ? String(passwordRecord.algorithm) : undefined,
        keyVersion: passwordRecord.keyVersion ? String(passwordRecord.keyVersion) : undefined
      },
      encryptionKey
    );

    // Audit logging: log only safe metadata (Admin UID, client ID, document ID, action, timestamp). Never log the password.
    logger.info(
      `Admin accessed document password: adminUid='${adminUid}', clientId='${clientId}', documentId='${documentId}', action='RETRIEVE_DOCUMENT_PASSWORD', timestamp='${new Date().toISOString()}'`
    );

    return c.json({
      success: true,
      data: {
        documentId,
        isPasswordProtected: true,
        password: decryptedPassword
      }
    }, 200);
  });

  // ==========================================
  // ROUTE 10C: DELETE /api/admin/clients/:clientId/documents/:documentId (Protected - Admin Only)
  // Authoritatively deletes client document from Google Drive and cleans up password metadata
  // ==========================================
  app.delete('/api/admin/clients/:clientId/documents/:documentId', requireAdminAuth, async (c) => {
    const adminUid = c.get('verifiedUid');
    const rawClientId = c.req.param('clientId');
    const rawDocId = c.req.param('documentId');

    if (!rawClientId || typeof rawClientId !== 'string' || !rawClientId.trim()) {
      throw new BadRequestError('A valid client UID parameter is required.');
    }
    const clientId = rawClientId.trim();
    if (clientId.includes('/') || clientId.includes('\\') || clientId.includes('..') || !/^[a-zA-Z0-9_-]{1,128}$/.test(clientId)) {
      throw new BadRequestError('Security violation: Invalid client UID format. Path traversal and malformed identifiers are strictly prohibited.');
    }

    if (!rawDocId || typeof rawDocId !== 'string' || !rawDocId.trim()) {
      throw new BadRequestError('A valid Google Drive document ID is required.');
    }
    const documentId = rawDocId.trim();

    // Prevent path traversal, directory separators, null bytes, and malformed characters
    if (!/^[a-zA-Z0-9_-]{5,100}$/.test(documentId)) {
      throw new BadRequestError('Invalid document ID format. Malformed identifiers and path traversal are strictly prohibited.');
    }

    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    const driveAuthOptions = await resolveDriveAuthOptions(c.env, serviceAccountJson);

    // Verify client exists, is active, and document belongs to selected client's repository (PAN folder or upload folder)
    // IDOR / cross-client access / trashed / folder / shortcut throws NotFoundError (safe 404 response)
    const { fileMetadata } = await adminClientService.verifyClientDocumentAccess(clientId, documentId, {
      projectId,
      serviceAccountJson,
      driveAuthOptions
    });

    // 1. Delete the actual Google Drive file (stops immediately if Drive deletion fails)
    await googleDriveRestService.deleteFile(documentId, {
      ...driveAuthOptions,
      throwOnError: true
    });

    // 2. Clean up corresponding documentPasswords/{documentId} Firestore metadata if present
    try {
      await firestoreRestService.deleteDocument('documentPasswords', documentId, {
        projectId,
        serviceAccountJson,
        customFetch: driveAuthOptions.customFetch,
        throwOnError: true
      });
    } catch (err) {
      logger.error(`Failed to clean up password metadata for deleted document ${documentId}:`, err instanceof Error ? err.message : String(err));
      throw new AppError(500, 'Document was deleted from Google Drive, but metadata cleanup failed.', 'METADATA_CLEANUP_ERROR');
    }

    // 3. Audit logging with safe metadata only (never log passwords, keys, or tokens)
    logger.info(
      `Admin deleted document: adminUid='${adminUid}', clientId='${clientId}', documentId='${documentId}', filename='${fileMetadata.name}', action='DOCUMENT_DELETED', timestamp='${new Date().toISOString()}'`
    );

    // 4. Return safe success response with no-store cache headers
    c.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    return c.json({
      success: true,
      message: 'Document deleted successfully.'
    }, 200);
  });

  // ==========================================
  // ROUTE 11: POST /api/admin/clients/:clientId/documents/upload (Protected - Admin Only)
  // Uploads document directly into target client's authoritative PAN root folder
  // ==========================================
  app.post('/api/admin/clients/:clientId/documents/upload', requireAdminAuth, async (c) => {
    const adminUid = c.get('verifiedUid');
    const rawClientId = c.req.param('clientId');

    if (!rawClientId || typeof rawClientId !== 'string' || !rawClientId.trim()) {
      throw new BadRequestError('A valid client UID parameter is required.');
    }

    const clientId = rawClientId.trim();

    // Verify Content-Type is multipart/form-data
    const contentType = c.req.header('content-type') || '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      throw new BadRequestError('Content-Type must be multipart/form-data for document upload.');
    }

    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    logger.info(`Worker: Processing POST /api/admin/clients/${clientId}/documents/upload by admin UID: ${adminUid}`);

    // Parse Multipart Form Data
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch (err) {
      logger.error('Failed to parse multipart form data:', err);
      throw new BadRequestError('Invalid multipart form data.');
    }

    // Zero-Trust check on multipart fields:
    // Reject any client-supplied identity, PAN, or destination folder fields
    for (const key of formData.keys()) {
      const normalized = key.toLowerCase().replace(/[-_]/g, '');
      if (FORBIDDEN_CLIENT_IDENTITY_KEYS.includes(normalized)) {
        logger.warn(`Security violation: Admin supplied forbidden field '${key}' in upload form data`);
        throw new BadRequestError(
          `Security violation: Field '${key}' cannot be supplied in multipart form data. Identity and destination folder associations are strictly authoritative.`
        );
      }
    }

    // Extract and validate file field
    const file = formData.get('file');
    if (!file) {
      throw new BadRequestError('Missing required multipart file field \'file\'.');
    }

    // Reject files larger than 15 MB with 413 Payload Too Large
    if (typeof file === 'object' && file !== null) {
      const candidate = file as { size?: number };
      if (typeof candidate.size === 'number' && candidate.size > MAX_UPLOAD_FILE_SIZE_BYTES) {
        throw new PayloadTooLargeError('File size exceeds the maximum allowed limit of 15 MB.');
      }
    }

    // Perform multi-layer validation (size, MIME type whitelist, extension match, binary magic bytes, filename sanitization)
    const validatedFile = await validateUploadedFile(file);

    // Double check binary size against 15 MB limit
    if (validatedFile.sizeBytes > MAX_UPLOAD_FILE_SIZE_BYTES) {
      throw new PayloadTooLargeError('File size exceeds the maximum allowed limit of 15 MB.');
    }

    const driveAuthOptions = await resolveDriveAuthOptions(c.env, serviceAccountJson);

    // Perform authoritative upload via AdminClientService
    const documentItem = await adminClientService.uploadAdminDocument(
      clientId,
      {
        name: validatedFile.sanitizedFilename,
        mimeType: validatedFile.mimeType,
        buffer: validatedFile.buffer,
        sizeBytes: validatedFile.sizeBytes
      },
      {
        projectId,
        serviceAccountJson,
        driveAuthOptions
      }
    );

    logger.info(
      `Worker: Document uploaded successfully by admin: ID ${documentItem.documentId}, name '${documentItem.name}' to PAN root for client UID: ${clientId}`
    );

    const docResponse = {
      id: documentItem.documentId,
      name: documentItem.name,
      mimeType: documentItem.mimeType,
      size: documentItem.size,
      createdTime: documentItem.createdTime,
      modifiedTime: documentItem.modifiedTime,
      uploaderType: 'administrator' as const,
      uploaderName: 'Administrator',
      folderType: 'pan_root' as const
    };

    return c.json({
      success: true,
      message: 'Document uploaded successfully by administrator.',
      data: {
        document: docResponse
      },
      document: docResponse,
      timestamp: new Date().toISOString()
    }, 200);
  });

  // =========================================================================
  // NOTIFICATION CENTRE - CLIENT ENDPOINTS
  // =========================================================================

  // ROUTE 12: GET /api/notifications (Client Protected)
  app.get('/api/notifications', requireAuth, async (c) => {
    const callerUid = c.get('verifiedUid');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    const limit = c.req.query('limit');
    const includeDismissed = c.req.query('includeDismissed');

    const result = await notificationService.listClientNotifications(
      callerUid,
      { limit, includeDismissed },
      { projectId, serviceAccountJson }
    );

    return c.json({
      success: true,
      message: 'Notifications retrieved successfully.',
      data: {
        notifications: result.notifications,
        unreadCount: result.unreadCount
      },
      notifications: result.notifications,
      unreadCount: result.unreadCount,
      timestamp: new Date().toISOString()
    }, 200);
  });

  // ROUTE 13: GET /api/notifications/unread-count (Client Protected)
  app.get('/api/notifications/unread-count', requireAuth, async (c) => {
    const callerUid = c.get('verifiedUid');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    const result = await notificationService.getClientUnreadCount(callerUid, {
      projectId,
      serviceAccountJson
    });

    return c.json({
      success: true,
      data: {
        unreadCount: result.unreadCount
      },
      unreadCount: result.unreadCount,
      timestamp: new Date().toISOString()
    }, 200);
  });

  // ROUTE 14: PATCH /api/notifications/:notificationId/read (Client Protected)
  app.patch('/api/notifications/:notificationId/read', requireAuth, async (c) => {
    const callerUid = c.get('verifiedUid');
    const notificationId = c.req.param('notificationId');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    const result = await notificationService.markNotificationAsRead(
      callerUid,
      notificationId,
      { projectId, serviceAccountJson }
    );

    return c.json({
      success: true,
      message: 'Notification marked as read.',
      data: {
        notification: result.notification,
        unreadCount: result.unreadCount
      },
      notification: result.notification,
      unreadCount: result.unreadCount,
      timestamp: new Date().toISOString()
    }, 200);
  });

  // ROUTE 15: POST /api/notifications/mark-all-read (Client Protected)
  app.post('/api/notifications/mark-all-read', requireAuth, async (c) => {
    const callerUid = c.get('verifiedUid');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    const result = await notificationService.markAllNotificationsAsRead(callerUid, {
      projectId,
      serviceAccountJson
    });

    return c.json({
      success: true,
      message: 'All notifications marked as read.',
      data: {
        updatedCount: result.updatedCount,
        unreadCount: 0
      },
      updatedCount: result.updatedCount,
      unreadCount: 0,
      timestamp: new Date().toISOString()
    }, 200);
  });

  // ROUTE 16: DELETE /api/notifications/:notificationId (Client Protected Dismissal)
  app.delete('/api/notifications/:notificationId', requireAuth, async (c) => {
    const callerUid = c.get('verifiedUid');
    const notificationId = c.req.param('notificationId');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    const result = await notificationService.dismissNotification(
      callerUid,
      notificationId,
      { projectId, serviceAccountJson }
    );

    return c.json({
      success: true,
      message: result.message,
      data: {
        unreadCount: result.unreadCount
      },
      unreadCount: result.unreadCount,
      timestamp: new Date().toISOString()
    }, 200);
  });

  // =========================================================================
  // NOTIFICATION CENTRE - ADMIN ENDPOINT
  // =========================================================================

  // ROUTE 17: POST /api/admin/notifications (Admin Protected)
  app.post('/api/admin/notifications', requireAdminAuth, async (c) => {
    const adminUid = c.get('verifiedUid');
    const projectId = (c.env?.FIREBASE_PROJECT_ID as string) || 'document-portal-d2b6d';
    const serviceAccountJson = getServiceAccountJsonFromEnv(c.env);

    if (!serviceAccountJson) {
      throw new AppError(500, 'Server configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing.', 'SERVER_CONFIG_ERROR');
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError('Request body must be a valid JSON object.');
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestError('Request body must be a valid JSON object.');
    }

    const result = await notificationService.createNotification(
      adminUid,
      body,
      { projectId, serviceAccountJson }
    );

    if (result.target === 'INDIVIDUAL') {
      return c.json({
        success: true,
        message: 'Notification sent successfully.',
        data: {
          target: 'INDIVIDUAL',
          notification: result.notification,
          delivery: result.delivery
        },
        notification: result.notification,
        delivery: result.delivery,
        timestamp: new Date().toISOString()
      }, 201);
    }

    return c.json({
      success: true,
      message: `Broadcast notification sent to ${result.recipientCount} active client(s).`,
      data: {
        target: 'ALL_ACTIVE',
        broadcastId: result.broadcastId,
        recipientCount: result.recipientCount,
        delivery: result.delivery
      },
      broadcastId: result.broadcastId,
      recipientCount: result.recipientCount,
      delivery: result.delivery,
      timestamp: new Date().toISOString()
    }, 201);
  });

  // Global Error Handler
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {})
        },
        timestamp: new Date().toISOString()
      }, err.statusCode as any);
    }

    const message = err instanceof Error ? err.message : 'An unexpected internal error occurred.';
    logger.error('Unhandled Worker error:', err);

    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message
      },
      timestamp: new Date().toISOString()
    }, 500);
  });

  // 404 Handler
  app.notFound((c) => {
    return c.json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Route '${c.req.method} ${c.req.path}' not found.`
      },
      timestamp: new Date().toISOString()
    }, 404);
  });

  return app;
}

// Instantiate default Worker app
const workerApp = createWorkerApp();

/**
 * Standard Cloudflare Worker Module Export
 */
export default {
  fetch(request: Request, env: Env, ctx?: any): Promise<Response> | Response {
    return workerApp.fetch(request, env, ctx);
  }
};

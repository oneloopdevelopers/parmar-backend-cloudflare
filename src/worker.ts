import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, ExecutionContext } from './types/worker.types';
import { AppError, BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError, BadGatewayError } from './utils/errors';
import { maskPanNumber } from './utils/clientProfileUtils';
import { verifyFirebaseIdToken } from './services/firebaseTokenVerifier';
import { firestoreRestService } from './services/firestoreRestService';
import { googleDriveRestService } from './services/googleDriveRestService';
import { validateUploadedFile } from './utils/fileValidationUtils';
import { logger } from './utils/logger';

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
  'clientid',
  'client_id'
];

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
        driveTest: 'GET /api/drive/test (Protected - Requires Bearer <Firebase ID Token>)'
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
    // { name, email, phone, maskedPanNumber, role, status }
    // Never expose driveFolderId or internal service account information.
    return c.json({
      name: clientProfile.name,
      email: clientProfile.email,
      phone: clientProfile.phone,
      maskedPanNumber: maskPanNumber(clientProfile.panNumber),
      role: clientProfile.role,
      status: clientProfile.status
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

    // Retrieve safe metadata and file list via Drive REST API
    const folderMetadata = await googleDriveRestService.getDriveFolderMetadata(cleanFolderId, {
      serviceAccountJson
    });
    const files = await googleDriveRestService.listFilesInFolder(cleanFolderId, {
      serviceAccountJson
    });

    logger.info(`Worker: Retrieved Drive folder '${folderMetadata.name}' and ${files.length} files for UID: ${uid}`);

    // Return strictly and only the safe folder and files representation
    // Never return driveFolderId or service-account information
    return c.json({
      success: true,
      folder: {
        name: folderMetadata.name,
        mimeType: folderMetadata.mimeType
      },
      files: files || []
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

    const cleanFolderId = driveFolderId.trim();

    // Query Google Drive via REST
    const files = await googleDriveRestService.listFilesInFolder(cleanFolderId, {
      serviceAccountJson
    });

    logger.info(`Worker: Retrieved ${files.length} document(s) for UID: ${uid}`);

    return c.json({
      success: true,
      documents: files || []
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

    // 1. Retrieve file metadata from Google Drive v3 REST API
    let fileMetadata;
    try {
      fileMetadata = await googleDriveRestService.getFileMetadata(documentId, {
        serviceAccountJson
      });
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
    // Verify file.parents includes the user's authoritative driveFolderId
    if (!fileMetadata.parents || !fileMetadata.parents.includes(authoritativeDriveFolderId)) {
      logger.warn(`IDOR Prevention: UID ${uid} attempted to download file ${documentId} belonging to another folder.`);
      // Return 404 to prevent cross-tenant enumeration
      throw new NotFoundError('Document not found or inaccessible.');
    }

    // 6. Retrieve file content stream from Google Drive using alt=media
    const downloadResult = await googleDriveRestService.downloadFileStream(documentId, {
      serviceAccountJson
    });

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

    // 2. Ensure target Drive folder exists and is usable
    await googleDriveRestService.getDriveFolderMetadata(authoritativeDriveFolderId, {
      serviceAccountJson
    });

    // 3. Parse Multipart Form Data
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch (err) {
      logger.error('Failed to parse multipart form data:', err);
      throw new BadRequestError('Invalid multipart form data.');
    }

    // 4. Zero-Trust check on multipart fields:
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

    // 5. Extract and validate file field
    const file = formData.get('file');
    if (!file) {
      throw new BadRequestError('Missing required multipart file field \'file\'.');
    }

    // Strict multi-layer file validation (size, MIME type, extension, signature, sanitization)
    const validatedFile = await validateUploadedFile(file);

    // 6. Upload directly to Google Drive into the client's authoritative folder
    const uploadedDocument = await googleDriveRestService.uploadFileMultipart(
      {
        name: validatedFile.sanitizedFilename,
        mimeType: validatedFile.mimeType,
        parents: [authoritativeDriveFolderId],
        content: validatedFile.buffer
      },
      {
        serviceAccountJson
      }
    );

    logger.info(
      `Worker: Document uploaded successfully: ID ${uploadedDocument.id}, name '${uploadedDocument.name}' for UID: ${uid}`
    );

    // 7. Return safe metadata response
    // Never expose driveFolderId, service account info, or UID
    return c.json({
      success: true,
      message: 'Document uploaded successfully.',
      data: {
        document: {
          id: uploadedDocument.id,
          name: uploadedDocument.name,
          mimeType: uploadedDocument.mimeType,
          size: uploadedDocument.size || String(validatedFile.sizeBytes),
          createdTime: uploadedDocument.createdTime || new Date().toISOString()
        }
      }
    }, 200);
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

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, ExecutionContext } from './types/worker.types';
import { AppError, BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from './utils/errors';
import { maskPanNumber } from './utils/clientProfileUtils';
import { verifyFirebaseIdToken } from './services/firebaseTokenVerifier';
import { firestoreRestService } from './services/firestoreRestService';
import { googleDriveRestService } from './services/googleDriveRestService';
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
    const verified = await tokenVerifier(token, { projectId });

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

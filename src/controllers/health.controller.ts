import { Request, Response, NextFunction } from 'express';
import { 
  getFirebaseAdminStatus, 
  testFirestoreConnectivity, 
  TARGET_FIREBASE_PROJECT_ID, 
  getAuthInstance 
} from '../config/firebaseAdmin';
import { config } from '../config/environment';
import { sendSuccess } from '../utils/response';
import { AuthenticatedRequest } from '../types';

/**
 * Public health status check
 * GET /api/health
 */
export function getHealthStatus(req: Request, res: Response): Response {
  const firebaseStatus = getFirebaseAdminStatus();

  const healthData = {
    status: 'healthy',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    service: 'Backend API Service',
    version: '1.0.0',
    firebase: {
      initialized: firebaseStatus.isInitialized,
      targetProjectId: TARGET_FIREBASE_PROJECT_ID,
      authMethod: firebaseStatus.authMethod,
      message: firebaseStatus.message
    },
    endpoints: {
      health: 'GET /api/health',
      firebaseHealth: 'GET /api/health/firebase',
      profile: 'GET /api/profile (Protected - Requires Bearer <Firebase ID Token>)',
      documents: 'GET /api/documents (Protected - Requires Bearer <Firebase ID Token>)',
      driveTest: 'GET /api/drive/test (Protected - Requires Bearer <Firebase ID Token>)',
      adminClientsList: 'GET /api/admin/clients (Protected - Requires Admin Bearer <Firebase ID Token>)',
      adminClientsCreate: 'POST /api/admin/clients (Protected - Requires Admin Bearer <Firebase ID Token>)',
      adminClientDocumentsList: 'GET /api/admin/clients/:clientId/documents (Protected - Requires Admin Bearer <Firebase ID Token>)',
      adminClientDocumentDownload: 'GET /api/admin/clients/:clientId/documents/:documentId/download (Protected - Requires Admin Bearer <Firebase ID Token>)',
      adminClientDocumentUpload: 'POST /api/admin/clients/:clientId/documents/upload (Protected - Requires Admin Bearer <Firebase ID Token>)'
    }
  };

  return sendSuccess(res, healthData, 'API service is operational');
}

/**
 * Firebase health endpoint
 * GET /api/health/firebase
 * Verifies that the Firebase Admin SDK is initialized and that Firestore can be accessed.
 * Optionally reports authenticated client identity if an Authorization Bearer header is present.
 */
export async function getFirebaseHealthStatus(
  req: Request | AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const adminStatus = getFirebaseAdminStatus();
    const firestoreCheck = await testFirestoreConnectivity();

    let authenticatedClient: { uid: string; email: string | null; tokenVerified: boolean } | null = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token) {
        try {
          const auth = getAuthInstance();
          const decoded = await auth.verifyIdToken(token);
          authenticatedClient = {
            uid: decoded.uid,
            email: decoded.email || null,
            tokenVerified: true
          };
        } catch {
          // Token present but invalid; recorded as unverified without failing health diagnostic
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
        initialized: adminStatus.isInitialized,
        projectId: adminStatus.projectId,
        authMethod: adminStatus.authMethod,
        message: adminStatus.message
      },
      firestore: {
        connected: firestoreCheck.connected,
        projectId: firestoreCheck.projectId,
        latencyMs: firestoreCheck.latencyMs,
        testedCollection: 'users',
        ...(firestoreCheck.error ? { error: firestoreCheck.error } : {})
      },
      authenticatedClient,
      timestamp: new Date().toISOString()
    };

    sendSuccess(
      res, 
      diagnosticReport, 
      firestoreCheck.connected 
        ? 'Firebase Admin SDK and Cloud Firestore connectivity verified successfully.' 
        : 'Firebase Admin SDK is initialized; Firestore check returned a notice.'
    );
  } catch (error) {
    next(error);
  }
}

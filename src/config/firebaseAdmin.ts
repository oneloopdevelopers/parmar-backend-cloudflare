import { initializeApp, getApps, getApp, cert, applicationDefault, App } from 'firebase-admin/app';
import { getAuth, Auth } from 'firebase-admin/auth';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { config } from './environment';
import { logger } from '../utils/logger';

export const TARGET_FIREBASE_PROJECT_ID = config.firebase.projectId || 'document-portal-d2b6d';

export interface FirebaseAdminStatus {
  isInitialized: boolean;
  projectId: string;
  authMethod: 'application_default' | 'service_account_json' | 'env_credentials' | 'project_id_fallback' | 'unconfigured';
  message: string;
  error?: string;
}

export interface ServiceAccountParsed {
  project_id: string;
  client_email: string;
  private_key: string;
  type?: string;
  [key: string]: unknown;
}

let appInstance: App | null = null;
let authInstance: Auth | null = null;
let firestoreInstance: Firestore | null = null;

let adminStatus: FirebaseAdminStatus = {
  isInitialized: false,
  projectId: TARGET_FIREBASE_PROJECT_ID,
  authMethod: 'unconfigured',
  message: 'Firebase Admin SDK initialization pending.'
};

/**
 * Validates and parses the FIREBASE_SERVICE_ACCOUNT_JSON server-side secret.
 * 
 * Strict Security Rules:
 * 1. Parsed only on the server runtime; never sent to clients or browser.
 * 2. Never prints or logs credential contents, tokens, or private keys.
 * 3. Enforces that the service account's project_id matches TARGET_FIREBASE_PROJECT_ID ('document-portal-d2b6d').
 * 4. Rejects malformed JSON, missing fields, or cross-project keys.
 */
export function validateAndParseServiceAccountJson(
  rawJson: string,
  expectedProjectId: string = TARGET_FIREBASE_PROJECT_ID
): ServiceAccountParsed {
  if (!rawJson || !rawJson.trim()) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is empty.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    // Crucial: do not log or re-throw the raw string to prevent accidental key exposure in error streams
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Ensure the secret contains the exact raw JSON content of your downloaded service account key without truncation or wrapping quotes.'
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must be a valid JSON object.');
  }

  const record = parsed as Record<string, unknown>;

  const projectId = typeof record.project_id === 'string' ? record.project_id.trim() : '';
  if (!projectId) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing the required 'project_id' field.");
  }

  // Strict project matching: Must match target project 'document-portal-d2b6d'
  if (projectId !== expectedProjectId) {
    throw new Error(
      `Project ID mismatch: Service account project_id '${projectId}' does not match authorized target project '${expectedProjectId}'. Only project '${expectedProjectId}' is allowed.`
    );
  }

  const clientEmail = typeof record.client_email === 'string' ? record.client_email.trim() : '';
  if (!clientEmail) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing the required 'client_email' field.");
  }

  const privateKey = typeof record.private_key === 'string' ? record.private_key.trim() : '';
  if (!privateKey) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing the required 'private_key' field.");
  }

  return {
    ...record,
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, '\n')
  };
}

/**
 * Initializes Firebase Admin SDK safely for existing Firebase project 'document-portal-d2b6d'.
 * 
 * Order of Precedence:
 * 1. FIREBASE_SERVICE_ACCOUNT_JSON server-side secret (primary for AI Studio development/testing).
 * 2. Individual server environment credentials (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).
 * 3. Google Application Default Credentials (ADC) - Preferred method for future Cloud Run deployment.
 * 4. Target project ID fallback (allows app to boot with clear configuration guidance).
 */
export function initializeFirebaseAdmin(): {
  app: App | null;
  auth: Auth | null;
  db: Firestore | null;
  status: FirebaseAdminStatus;
} {
  const existingApps = getApps();
  if (existingApps.length > 0) {
    appInstance = getApp();
    adminStatus = {
      isInitialized: true,
      projectId: appInstance.options.projectId || TARGET_FIREBASE_PROJECT_ID,
      authMethod: adminStatus.authMethod,
      message: `Firebase Admin SDK connected to existing project: ${TARGET_FIREBASE_PROJECT_ID}`
    };
    authInstance = getAuth(appInstance);
    firestoreInstance = getFirestore(appInstance);
    return { app: appInstance, auth: authInstance, db: firestoreInstance, status: adminStatus };
  }

  try {
    // Strategy 1: FIREBASE_SERVICE_ACCOUNT_JSON as a server-side secret (primary for AI Studio development/testing)
    if (config.firebase.serviceAccountJson && config.firebase.serviceAccountJson.trim()) {
      try {
        const parsed = validateAndParseServiceAccountJson(
          config.firebase.serviceAccountJson,
          TARGET_FIREBASE_PROJECT_ID
        );

        appInstance = initializeApp({
          credential: cert(parsed as Record<string, string>),
          projectId: TARGET_FIREBASE_PROJECT_ID
        });

        adminStatus = {
          isInitialized: true,
          projectId: TARGET_FIREBASE_PROJECT_ID,
          authMethod: 'service_account_json',
          message: `Firebase Admin SDK initialized via FIREBASE_SERVICE_ACCOUNT_JSON secret for project: ${TARGET_FIREBASE_PROJECT_ID}`
        };
        logger.info(`[FIREBASE ADMIN] Initialized via FIREBASE_SERVICE_ACCOUNT_JSON for project: ${TARGET_FIREBASE_PROJECT_ID}`);
      } catch (jsonErr) {
        const errorMsg = jsonErr instanceof Error ? jsonErr.message : 'Invalid FIREBASE_SERVICE_ACCOUNT_JSON secret';
        // Log clean error message WITHOUT exposing any credential contents
        logger.error(`[FIREBASE ADMIN] Secret Configuration Error: ${errorMsg}`);
        adminStatus = {
          isInitialized: false,
          projectId: TARGET_FIREBASE_PROJECT_ID,
          authMethod: 'unconfigured',
          message: `FIREBASE_SERVICE_ACCOUNT_JSON configuration error: ${errorMsg}`,
          error: errorMsg
        };
        return { app: null, auth: null, db: null, status: adminStatus };
      }
    }

    // Strategy 2: Individual environment credentials (FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY)
    if (!appInstance && config.firebase.clientEmail && config.firebase.privateKey) {
      try {
        appInstance = initializeApp({
          credential: cert({
            projectId: TARGET_FIREBASE_PROJECT_ID,
            clientEmail: config.firebase.clientEmail,
            privateKey: config.firebase.privateKey,
          }),
          projectId: TARGET_FIREBASE_PROJECT_ID,
        });
        adminStatus = {
          isInitialized: true,
          projectId: TARGET_FIREBASE_PROJECT_ID,
          authMethod: 'env_credentials',
          message: `Firebase Admin initialized via environment credentials for project: ${TARGET_FIREBASE_PROJECT_ID}`
        };
      } catch (certErr) {
        logger.warn('[FIREBASE ADMIN] Failed to initialize via individual credentials, attempting ADC.');
      }
    }

    // Strategy 3: Google Application Default Credentials (ADC) - Preferred method for Cloud Run deployment
    if (!appInstance) {
      try {
        appInstance = initializeApp({
          credential: applicationDefault(),
          projectId: TARGET_FIREBASE_PROJECT_ID,
        });
        adminStatus = {
          isInitialized: true,
          projectId: TARGET_FIREBASE_PROJECT_ID,
          authMethod: 'application_default',
          message: `Firebase Admin initialized via Google Application Default Credentials (ADC) for project: ${TARGET_FIREBASE_PROJECT_ID}`
        };
      } catch (adcErr) {
        // Strategy 4: Project ID fallback with clear configuration notice
        const missingSecretNotice = `FIREBASE_SERVICE_ACCOUNT_JSON secret is not configured in this environment. For development and testing in Google AI Studio, please add the server-side secret named 'FIREBASE_SERVICE_ACCOUNT_JSON' with your service account key for project '${TARGET_FIREBASE_PROJECT_ID}' via Settings > Secrets. When deployed to Cloud Run in Google Cloud, Google Application Default Credentials (ADC) will be used automatically.`;
        
        try {
          appInstance = initializeApp({
            projectId: TARGET_FIREBASE_PROJECT_ID,
          });
          adminStatus = {
            isInitialized: true,
            projectId: TARGET_FIREBASE_PROJECT_ID,
            authMethod: 'project_id_fallback',
            message: missingSecretNotice
          };
        } catch (fallbackErr) {
          const errMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          adminStatus = {
            isInitialized: false,
            projectId: TARGET_FIREBASE_PROJECT_ID,
            authMethod: 'unconfigured',
            message: missingSecretNotice,
            error: errMsg
          };
          return { app: null, auth: null, db: null, status: adminStatus };
        }
      }
    }

    if (appInstance) {
      authInstance = getAuth(appInstance);
      firestoreInstance = getFirestore(appInstance);
    }

    return { app: appInstance, auth: authInstance, db: firestoreInstance, status: adminStatus };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown initialization error';
    adminStatus = {
      isInitialized: false,
      projectId: TARGET_FIREBASE_PROJECT_ID,
      authMethod: 'unconfigured',
      message: `Firebase Admin error: ${errorMsg}`,
      error: errorMsg
    };
    return { app: null, auth: null, db: null, status: adminStatus };
  }
}

/**
 * Startup validation routine: Clearly reports initialization status to console.
 */
export function validateFirebaseAdminStartup(): FirebaseAdminStatus {
  const { status } = initializeFirebaseAdmin();
  logger.info('====================================================');
  if (status.authMethod === 'service_account_json') {
    logger.info(`[FIREBASE ADMIN] Initialization SUCCESS`);
    logger.info(`[FIREBASE ADMIN] Target Project ID : ${status.projectId}`);
    logger.info(`[FIREBASE ADMIN] Auth Strategy     : FIREBASE_SERVICE_ACCOUNT_JSON`);
    logger.info(`[FIREBASE ADMIN] Status            : Ready for authenticated Firestore & Auth calls.`);
  } else if (status.authMethod === 'application_default') {
    logger.info(`[FIREBASE ADMIN] Initialized via Application Default Credentials (ADC)`);
    logger.info(`[FIREBASE ADMIN] Target Project ID : ${status.projectId}`);
    logger.info(`[FIREBASE ADMIN] Notice: If running in AI Studio, configure 'FIREBASE_SERVICE_ACCOUNT_JSON' secret in Settings > Secrets if ADC lacks permissions to '${status.projectId}'. In production Cloud Run, ADC will authenticate automatically.`);
  } else {
    logger.warn(`[FIREBASE ADMIN] Notice: Operating without service account secret.`);
    logger.warn(`[FIREBASE ADMIN] Target Project ID : ${status.projectId}`);
    logger.warn(`[FIREBASE ADMIN] Action Needed     : For development/testing in AI Studio, add 'FIREBASE_SERVICE_ACCOUNT_JSON' in Settings > Secrets.`);
  }
  logger.info('====================================================');
  return status;
}

export function getFirebaseAdminStatus(): FirebaseAdminStatus {
  if (!adminStatus.isInitialized && getApps().length > 0) {
    adminStatus.isInitialized = true;
    adminStatus.projectId = getApp().options.projectId || TARGET_FIREBASE_PROJECT_ID;
  }
  return adminStatus;
}

export function getAuthInstance(): Auth {
  if (!authInstance) {
    const { auth } = initializeFirebaseAdmin();
    if (!auth) {
      throw new Error(`Firebase Auth instance is unavailable. ${adminStatus.message}`);
    }
    return auth;
  }
  return authInstance;
}

export function getFirestoreInstance(): Firestore {
  if (!firestoreInstance) {
    const { db } = initializeFirebaseAdmin();
    if (!db) {
      throw new Error(`Cloud Firestore instance is unavailable. ${adminStatus.message}`);
    }
    return db;
  }
  return firestoreInstance;
}

/**
 * Tests communication with Cloud Firestore.
 * Used by GET /api/health/firebase to verify live connectivity.
 * Reads from the existing 'users' collection with a limit of 1.
 */
export async function testFirestoreConnectivity(): Promise<{
  connected: boolean;
  projectId: string;
  latencyMs?: number;
  error?: string;
}> {
  const startTime = Date.now();
  try {
    const db = getFirestoreInstance();
    // Query existing 'users' collection with limit(1) to test read connectivity
    await db.collection('users').limit(1).get();
    const latencyMs = Date.now() - startTime;
    return {
      connected: true,
      projectId: TARGET_FIREBASE_PROJECT_ID,
      latencyMs
    };
  } catch (err) {
    // Fallback attempt: listCollections or handle error
    try {
      const db = getFirestoreInstance();
      await db.listCollections();
      const latencyMs = Date.now() - startTime;
      return {
        connected: true,
        projectId: TARGET_FIREBASE_PROJECT_ID,
        latencyMs
      };
    } catch {
      // Return detailed error from original query
      const latencyMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        connected: false,
        projectId: TARGET_FIREBASE_PROJECT_ID,
        latencyMs,
        error: errorMessage
      };
    }
  }
}

// Exports aliases for easy modular imports
export const auth = {
  get instance() { return getAuthInstance(); },
  verifyIdToken: (token: string) => getAuthInstance().verifyIdToken(token)
};

export const db = {
  get instance() { return getFirestoreInstance(); },
  collection: (name: string) => getFirestoreInstance().collection(name)
};

import { Response, NextFunction } from 'express';
import { getAuthInstance, getFirestoreInstance, getFirebaseAdminStatus, FirebaseAdminStatus } from '../config/firebaseAdmin';
import { AuthenticatedRequest, UserProfile } from '../types';
import { 
  UnauthorizedError, 
  ForbiddenError, 
  NotFoundError, 
  ServiceUnavailableError 
} from '../utils/errors';
import { logger } from '../utils/logger';

export interface AuthenticateFirebaseUserDependencies {
  getAuth?: () => {
    verifyIdToken: (token: string) => Promise<any>;
    getUser: (uid: string) => Promise<any>;
  };
  getDb?: () => {
    collection: (name: string) => {
      doc: (id: string) => {
        get: () => Promise<{ exists: boolean; data: () => any }>;
      };
    };
  };
  getStatus?: () => FirebaseAdminStatus;
}

/**
 * Creates the authenticateFirebaseUser middleware with optional injected dependencies.
 * Default instance is used in production; custom dependencies can be injected for automated testing.
 */
export function createAuthenticateFirebaseUser(deps?: AuthenticateFirebaseUserDependencies) {
  const getAuth = deps?.getAuth || getAuthInstance;
  const getDb = deps?.getDb || getFirestoreInstance;
  const getStatus = deps?.getStatus || getFirebaseAdminStatus;

  return async function authenticateFirebaseUser(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // 1. Read Authorization header
    const authHeader = req.headers.authorization;

    // 6a. Reject if Authorization header is missing (401)
    if (!authHeader) {
      return next(
        new UnauthorizedError(
          'Missing Authorization header. Expected format: Authorization: Bearer <Firebase ID Token>'
        )
      );
    }

    // 6b. Reject if token is malformed (does not start with 'Bearer ') (401)
    if (!authHeader.startsWith('Bearer ')) {
      return next(
        new UnauthorizedError(
          'Malformed Authorization header. Format must be "Bearer <Firebase ID Token>".'
        )
      );
    }

    const token = authHeader.slice(7).trim();

    // 6c. Reject if token payload is empty (401)
    if (!token) {
      return next(
        new UnauthorizedError(
          'Malformed Authorization header. Bearer token value cannot be empty.'
        )
      );
    }

    // Check Firebase Admin SDK initialization status
    const adminStatus = getStatus();
    if (!adminStatus.isInitialized) {
      logger.warn('Token verification attempted but Firebase Admin SDK is unconfigured.');
      return next(
        new ServiceUnavailableError(
          'Firebase Admin SDK is not initialized. Please ensure credentials or Google Application Default Credentials are configured.'
        )
      );
    }

    try {
      const auth = getAuth();
      const db = getDb();

      // 3. Verify the token using Firebase Admin SDK
      let decodedToken: any;
      try {
        decodedToken = await auth.verifyIdToken(token);
      } catch (verifyError: unknown) {
        const err = verifyError as { code?: string; message?: string };
        logger.warn(`Firebase token verification failed: ${err.message || err}`);

        // 6d. Reject if token is expired (401)
        if (err.code === 'auth/id-token-expired') {
          return next(
            new UnauthorizedError(
              'Firebase ID token has expired. Please refresh the authentication token on the Android client.'
            )
          );
        }

        // 6e. Reject if token is invalid or malformed (401)
        if (
          err.code === 'auth/argument-error' ||
          err.code === 'auth/invalid-id-token' ||
          err.code === 'auth/invalid-argument'
        ) {
          return next(
            new UnauthorizedError(
              `Invalid Firebase ID token: ${err.message || 'Token format or signature is invalid.'}`
            )
          );
        }

        return next(
          new UnauthorizedError(`Invalid or unrecognized Firebase ID token: ${err.message || 'Verification rejected.'}`)
        );
      }

      // 4. Extract the Firebase UID
      const firebaseUid = decodedToken?.uid;
      if (!firebaseUid) {
        return next(
          new UnauthorizedError('Verified token did not contain a valid Firebase UID.')
        );
      }

      // 6f. Verify Firebase user exists in Firebase Authentication
      try {
        const userRecord = await auth.getUser(firebaseUid);
        if (!userRecord) {
          return next(
            new UnauthorizedError('Firebase user does not exist in Firebase Authentication.')
          );
        }

        if (userRecord.disabled) {
          return next(
            new ForbiddenError('User account has been disabled in Firebase Authentication.')
          );
        }
      } catch (userRecordErr: unknown) {
        const err = userRecordErr as { code?: string; message?: string };
        if (err.code === 'auth/user-not-found') {
          return next(
            new UnauthorizedError(`Firebase user does not exist for UID: ${firebaseUid}`)
          );
        }
        logger.warn(`Warning checking user in Firebase Auth: ${err.message || err}`);
      }

      // 5. Retrieve the user profile from Firestore using: users/{firebaseUid}
      let userDoc: any;
      try {
        const docRef = db.collection('users').doc(firebaseUid);
        userDoc = await docRef.get();
      } catch (firestoreErr: unknown) {
        const err = firestoreErr as { message?: string };
        logger.error(`Error querying Firestore for users/${firebaseUid}: ${err.message || err}`);
        return next(
          new ServiceUnavailableError('Failed to communicate with Cloud Firestore while fetching client profile.')
        );
      }

      // 6g. Reject if Firestore client profile does not exist (404)
      if (!userDoc || !userDoc.exists) {
        logger.warn(`Firestore profile document missing for UID: ${firebaseUid}`);
        return next(
          new NotFoundError(
            `Client profile not found in Firestore. Expected document path: users/${firebaseUid}`
          )
        );
      }

      const rawProfile = (typeof userDoc.data === 'function' ? userDoc.data() : userDoc.data) as Partial<UserProfile> | undefined;
      if (!rawProfile) {
        return next(
          new NotFoundError(`Firestore client profile document is empty for UID: ${firebaseUid}`)
        );
      }

      // 6h. Reject if client status is inactive/disabled (403)
      const profileStatus = (rawProfile.status || 'active').toLowerCase().trim();
      if (['inactive', 'disabled', 'suspended'].includes(profileStatus)) {
        logger.warn(`Access denied: Client ${firebaseUid} has status '${profileStatus}'`);
        return next(
          new ForbiddenError(`Client account is ${profileStatus}. Access to the backend API is restricted.`)
        );
      }

      // 7. Attach authenticated user details and profile to the request
      req.user = {
        uid: firebaseUid,
        email: decodedToken.email || rawProfile.email,
        emailVerified: decodedToken.email_verified,
        tokenClaims: decodedToken
      };

      req.clientProfile = {
        name: rawProfile.name || '',
        email: rawProfile.email || decodedToken.email || '',
        phone: rawProfile.phone,
        panNumber: rawProfile.panNumber,
        driveFolderId: rawProfile.driveFolderId,
        role: rawProfile.role || 'client',
        status: rawProfile.status || 'active',
        createdAt: rawProfile.createdAt,
        updatedAt: rawProfile.updatedAt
      };

      logger.debug(`User authenticated successfully: UID=${firebaseUid}, status=${profileStatus}`);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Standard production middleware instance.
 */
export const authenticateFirebaseUser = createAuthenticateFirebaseUser();

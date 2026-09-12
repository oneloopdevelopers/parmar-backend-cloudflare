import { Response, NextFunction } from 'express';
import { getFirestoreInstance } from '../config/firebaseAdmin';
import { googleDriveService, GoogleDriveService } from '../services/googleDriveService';
import { AuthenticatedRequest, DriveFileSafeMetadata } from '../types';
import { 
  UnauthorizedError, 
  ForbiddenError, 
  NotFoundError, 
  BadRequestError 
} from '../utils/errors';
import { logger } from '../utils/logger';

export interface DocumentControllerDependencies {
  getDb?: () => any;
  driveService?: {
    listFilesInFolder: (folderId: string, maxPages?: number) => Promise<DriveFileSafeMetadata[]>;
  };
}

/**
 * Creates the listDocuments controller with optional dependency injection for unit testing.
 * 
 * SECURITY FLOW:
 * 1. Require the existing authenticateFirebaseUser middleware.
 * 2. Obtain the Firebase UID ONLY from the verified Firebase ID token (req.user.uid).
 * 3. Read users/{verifiedFirebaseUid} from Firestore.
 * 4. Require status === "active" (403 otherwise).
 * 5. Read driveFolderId from the Firestore user document (400 if missing).
 * 6. Never accept driveFolderId from query parameters, URL parameters, request body, or custom headers.
 * 7. Never accept PAN number or UID from the client.
 * 8. Use the Firestore driveFolderId to query Google Drive.
 * 9. List only non-trashed files directly inside that folder.
 */
export function createListDocumentsController(deps?: DocumentControllerDependencies) {
  const getDb = deps?.getDb || getFirestoreInstance;
  const driveService = deps?.driveService || googleDriveService;

  return async function listDocuments(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      // 1 & 2. Obtain Firebase UID ONLY from the verified Firebase ID token
      const uid = req.user?.uid;
      if (!uid || typeof uid !== 'string' || !uid.trim()) {
        throw new UnauthorizedError('Authentication required. Missing verified Firebase UID.');
      }

      logger.info(`Processing GET /api/documents for verified UID: ${uid}`);

      // 3. Read users/{verifiedFirebaseUid} from Firestore
      const db = getDb();
      const docRef = db.collection('users').doc(uid.trim());
      const docSnap = await docRef.get();

      // 404: Authenticated user's Firestore profile does not exist
      if (!docSnap || !docSnap.exists) {
        logger.warn(`Document listing failed: Firestore profile does not exist for UID: ${uid}`);
        throw new NotFoundError(`Firestore user profile does not exist for UID: ${uid}`);
      }

      const userData = typeof docSnap.data === 'function' ? docSnap.data() : docSnap.data;
      if (!userData) {
        throw new NotFoundError(`Firestore user profile is empty for UID: ${uid}`);
      }

      // 4. Require status === "active"
      const status = (userData.status || '').toLowerCase().trim();
      if (status !== 'active') {
        logger.warn(`Document listing access denied: Client ${uid} status is '${status}'`);
        throw new ForbiddenError('User is inactive. Active status is required to access documents.');
      }

      // 5. Read driveFolderId from the Firestore user document
      const driveFolderId = userData.driveFolderId;
      if (!driveFolderId || typeof driveFolderId !== 'string' || !driveFolderId.trim()) {
        logger.warn(`Document listing failed: Missing driveFolderId in Firestore profile for UID: ${uid}`);
        throw new BadRequestError('driveFolderId is missing from the authenticated user\'s Firestore profile.');
      }

      const cleanFolderId = driveFolderId.trim();

      // 8 & 9. Use the Firestore driveFolderId to query Google Drive (list non-trashed files)
      const files = await driveService.listFilesInFolder(cleanFolderId);

      logger.info(`Retrieved ${files.length} document(s) for UID: ${uid}`);

      // Return safe document metadata only
      // Do not return: driveFolderId, Firebase UID, service-account email, credentials, access tokens, private keys
      res.status(200).json({
        success: true,
        documents: files || [],
      });
    } catch (error) {
      next(error);
    }
  };
}

export const listDocuments = createListDocumentsController();

export async function downloadDocument(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    res.status(501).json({
      success: false,
      message: 'Document download is not yet implemented.',
    });
  } catch (error) {
    next(error);
  }
}

export async function uploadDocument(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    res.status(501).json({
      success: false,
      message: 'Document upload is not yet implemented.',
    });
  } catch (error) {
    next(error);
  }
}

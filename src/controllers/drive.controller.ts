import { Response, NextFunction } from 'express';
import { getFirestoreInstance } from '../config/firebaseAdmin';
import { googleDriveService } from '../services/googleDriveService';
import { AuthenticatedRequest } from '../types';
import { UnauthorizedError, ForbiddenError, NotFoundError, BadRequestError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * GET /api/drive/test
 * Protected endpoint to test Google Drive access for the authenticated client.
 * 
 * Strict Security Guarantees:
 * - Requires verified Firebase ID Token via Bearer authentication middleware.
 * - Obtains Firebase UID ONLY from the cryptographically verified token.
 * - Reads users/{verifiedFirebaseUid} from Firestore.
 * - Requires status === "active" (403 otherwise).
 * - Reads driveFolderId ONLY from that Firestore document.
 * - NEVER accepts driveFolderId from query, params, body, or client headers.
 * - Retrieves folder metadata and lists files directly inside that folder.
 * - NEVER returns driveFolderId in the response.
 * - NEVER exposes service account credentials or tokens.
 */
export async function testDriveAccess(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // 1. Obtain Firebase UID ONLY from verified Firebase ID token
    const uid = req.user?.uid;
    if (!uid) {
      throw new UnauthorizedError('Authentication required. Missing verified Firebase UID.');
    }

    logger.info(`Processing GET /api/drive/test for verified UID: ${uid}`);

    // 2. Read users/{verifiedFirebaseUid} from Firestore
    const db = getFirestoreInstance();
    const docRef = db.collection('users').doc(uid);
    const docSnap = await docRef.get();

    // 404: Firestore user profile does not exist
    if (!docSnap.exists) {
      logger.warn(`Drive test failed: User profile not found in Firestore for UID: ${uid}`);
      throw new NotFoundError(`Firestore user profile does not exist for UID: ${uid}`);
    }

    const userData = docSnap.data();
    if (!userData) {
      throw new NotFoundError(`Firestore user profile is empty for UID: ${uid}`);
    }

    // 403: Require status === "active"
    const status = (userData.status || '').toLowerCase().trim();
    if (status !== 'active') {
      logger.warn(`Drive test access denied: Client ${uid} status is '${status}'`);
      throw new ForbiddenError(
        `User is inactive. Active status is required to access Google Drive documents.`
      );
    }

    // 400: driveFolderId is missing from the authenticated user's Firestore profile
    const driveFolderId = userData.driveFolderId;
    if (!driveFolderId || typeof driveFolderId !== 'string' || !driveFolderId.trim()) {
      logger.warn(`Drive test failed: Missing driveFolderId in Firestore profile for UID: ${uid}`);
      throw new BadRequestError(
        `driveFolderId is missing from the authenticated user's Firestore profile.`
      );
    }

    const cleanFolderId = driveFolderId.trim();

    // 3. Use Firestore driveFolderId to access Google Drive API
    const folderMetadata = await googleDriveService.getDriveFolderMetadata(cleanFolderId);
    const files = await googleDriveService.listFilesInFolder(cleanFolderId);

    logger.info(`Successfully retrieved Drive folder '${folderMetadata.name}' and ${files.length} files for UID: ${uid}`);

    // 4. Return strictly and only the safe folder and files representation
    // Never return driveFolderId or service-account information
    res.status(200).json({
      success: true,
      folder: {
        name: folderMetadata.name,
        mimeType: folderMetadata.mimeType,
      },
      files: files || [],
    });
  } catch (error) {
    next(error);
  }
}

import { Router } from 'express';
import { testDriveAccess } from '../controllers/drive.controller';
import { authenticateFirebaseUser } from '../middleware/authenticateFirebaseUser';
import { enforceZeroTrustIdentity } from '../middleware/validation.middleware';

const router = Router();

/**
 * GET /api/drive/test
 * Protected route to test Google Drive access for the authenticated client.
 * Strictly uses Firebase ID token verification and Firestore driveFolderId.
 */
router.get('/test', enforceZeroTrustIdentity, authenticateFirebaseUser, testDriveAccess);

export default router;

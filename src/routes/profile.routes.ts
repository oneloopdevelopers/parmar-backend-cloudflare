import { Router } from 'express';
import { getUserProfile } from '../controllers/user.controller';
import { authenticateFirebaseUser } from '../middleware/authenticateFirebaseUser';
import { enforceZeroTrustIdentity } from '../middleware/validation.middleware';

const router = Router();

/**
 * GET /api/profile
 * Requires valid Firebase ID token in Authorization: Bearer <token>
 * Strictly retrieves Firestore profile matching the verified UID.
 */
router.get('/', enforceZeroTrustIdentity, authenticateFirebaseUser, getUserProfile);

export default router;

import { Router } from 'express';
import { getHealthStatus, getFirebaseHealthStatus } from '../controllers/health.controller';
import { enforceZeroTrustIdentity } from '../middleware/validation.middleware';

const router = Router();

// Public health check: GET /api/health
router.get('/', getHealthStatus);

// Firebase Admin & Firestore connectivity health check: GET /api/health/firebase
router.get('/firebase', enforceZeroTrustIdentity, getFirebaseHealthStatus);

export default router;

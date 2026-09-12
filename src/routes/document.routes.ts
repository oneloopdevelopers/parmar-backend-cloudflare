import { Router } from 'express';
import { listDocuments, downloadDocument, uploadDocument } from '../controllers/document.controller';
import { authenticateFirebaseUser } from '../middleware/authenticateFirebaseUser';
import { enforceZeroTrustIdentity } from '../middleware/validation.middleware';

const router = Router();

/**
 * GET /api/documents
 * Lists user documents scoped strictly to their Firestore driveFolderId.
 */
router.get('/', enforceZeroTrustIdentity, authenticateFirebaseUser, listDocuments);

/**
 * GET /api/documents/:documentId/download
 * Downloads a document scoped strictly to their Firestore driveFolderId.
 */
router.get('/:documentId/download', enforceZeroTrustIdentity, authenticateFirebaseUser, downloadDocument);

/**
 * POST /api/documents/upload
 * Uploads a document to their Firestore driveFolderId.
 * Rejects any client attempt to supply an arbitrary driveFolderId.
 */
router.post('/upload', enforceZeroTrustIdentity, authenticateFirebaseUser, uploadDocument);

export default router;

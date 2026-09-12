import { Response, NextFunction } from 'express';
import { AuthenticatedRequest, ClientProfileResponse } from '../types';
import { clientRepository } from '../repositories/clientRepository';
import { UnauthorizedError, BadRequestError } from '../utils/errors';

/**
 * Controller: GET /api/profile
 * 
 * Returns the authenticated client's profile.
 * - Extracts UID strictly from the verified Firebase token (req.user.uid).
 * - Never accepts firebaseUid or arbitrary UID from client request body, query, or params.
 * - Validates missing or malformed client profile records in Firestore.
 * - Returns: { name, email, phone, maskedPanNumber, role, status }.
 * - Strictly omits driveFolderId (server-side authorization value that must remain private).
 */
export async function getUserProfile(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // 1. Strict identity validation: Identity must come from verified token
    if (!req.user || !req.user.uid) {
      throw new UnauthorizedError('Authenticated identity not found on request context. Valid Bearer token required.');
    }

    // 2. Reject if client attempted to supply an arbitrary UID in body/params/query
    if (req.body && (req.body.uid || req.body.firebaseUid || req.body.userId || req.body.clientId)) {
      throw new BadRequestError(
        'Security Violation: Supplying client UID in request payload is forbidden. Identity is determined by the server.'
      );
    }

    if (req.query && (req.query.uid || req.query.firebaseUid || req.query.userId || req.query.clientId)) {
      throw new BadRequestError(
        'Security Violation: Supplying client UID in query parameters is forbidden. Identity is determined by the server.'
      );
    }

    if (req.params && (req.params.uid || req.params.firebaseUid || req.params.userId || req.params.clientId)) {
      throw new BadRequestError(
        'Security Violation: Supplying client UID in route parameters is forbidden. Identity is determined by the server.'
      );
    }

    const authenticatedUid = req.user.uid;

    // 3. Obtain client profile using clientRepository
    // This method validates the profile in Firestore, masks panNumber, and omits driveFolderId.
    const clientProfile = await clientRepository.getClientProfileByUid(authenticatedUid);

    // 4. Return strictly only the permitted profile fields:
    // { name, email, phone, maskedPanNumber, role, status }
    res.status(200).json({
      name: clientProfile.name,
      email: clientProfile.email,
      phone: clientProfile.phone,
      maskedPanNumber: clientProfile.maskedPanNumber,
      role: clientProfile.role,
      status: clientProfile.status
    });
  } catch (error) {
    next(error);
  }
}

import { getFirestoreInstance } from '../config/firebaseAdmin';
import { ClientDocument, ClientProfileResponse, ClientRole, ClientStatus } from '../types';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../utils/errors';
import { logger } from '../utils/logger';
import { maskPanNumber, validateUid, validateClientProfile } from '../utils/clientProfileUtils';

export { maskPanNumber, validateUid, validateClientProfile };

/**
 * Firestore Client Repository
 * Manages access to Firestore collection `users/{firebaseUid}`.
 * 
 * Rules:
 * - The repository must never allow a client to query another client's document.
 * - The UID must come from the authenticated Firebase ID token.
 * - Do not accept an arbitrary UID from the Android application for client document access.
 * - Validates against missing or malformed client profiles.
 * - Keeps driveFolderId private (never returned to the Android client in profile DTOs).
 */
export class ClientRepository {
  private collectionName = 'users';
  private getDb: () => any;

  constructor(getDb?: () => any) {
    this.getDb = getDb || getFirestoreInstance;
  }

  /**
   * Retrieves full client document from Firestore `users/{firebaseUid}`.
   * Internal method: includes driveFolderId for server-side authorization.
   * Validates against missing or malformed records.
   * Returns null if document does not exist.
   */
  async getClientByUid(uid: string): Promise<ClientDocument | null> {
    const validUid = validateUid(uid);

    try {
      const db = this.getDb();
      const docRef = db.collection(this.collectionName).doc(validUid);
      const docSnap = await docRef.get();

      if (!docSnap || !docSnap.exists) {
        logger.info(`No client document found in Firestore for UID: ${validUid}`);
        return null;
      }

      const rawData = typeof docSnap.data === 'function' ? docSnap.data() : docSnap.data;
      if (!rawData) {
        logger.warn(`Client document data is empty for UID: ${validUid}`);
        throw new BadRequestError(`Client profile document in Firestore is empty for UID: ${validUid}`);
      }

      return validateClientProfile(rawData, validUid);
    } catch (error) {
      if (error instanceof BadRequestError || error instanceof UnauthorizedError) {
        throw error;
      }
      logger.error(`Error querying Firestore for client UID ${validUid}:`, error);
      throw error;
    }
  }

  /**
   * Retrieves client profile for the authenticated client.
   * - Validates profile structure and throws if missing or malformed.
   * - Masks panNumber (e.g., 'XXXXXX234F').
   * - Strictly omits driveFolderId (must remain a private server-side authorization value).
   * - Returns: { name, email, phone, maskedPanNumber, role, status }
   */
  async getClientProfileByUid(uid: string): Promise<ClientProfileResponse> {
    const validUid = validateUid(uid);

    const client = await this.getClientByUid(validUid);
    if (!client) {
      throw new NotFoundError(
        `Client profile not found in Firestore collection '${this.collectionName}/${validUid}'.`
      );
    }

    const maskedPan = maskPanNumber(client.panNumber);

    // Explicit projection: driveFolderId is strictly excluded
    return {
      name: client.name,
      email: client.email,
      phone: client.phone,
      maskedPanNumber: maskedPan,
      role: client.role,
      status: client.status
    };
  }

  /**
   * Checks whether a client is active.
   * Returns false if client does not exist or status is not 'active'.
   */
  async isClientActive(uid: string): Promise<boolean> {
    const validUid = validateUid(uid);

    try {
      const client = await this.getClientByUid(validUid);
      if (!client) {
        return false;
      }
      return client.status === 'active';
    } catch (error) {
      logger.warn(`Failed checking active status for client ${validUid}:`, error);
      return false;
    }
  }
}

// Default singleton instance
export const clientRepository = new ClientRepository();

// Helper functional exports
export const getClientByUid = (uid: string) => clientRepository.getClientByUid(uid);
export const getClientProfileByUid = (uid: string) => clientRepository.getClientProfileByUid(uid);
export const isClientActive = (uid: string) => clientRepository.isClientActive(uid);

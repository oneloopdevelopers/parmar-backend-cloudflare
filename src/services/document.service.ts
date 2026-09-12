import { userService } from './user.service';
import { documentRepository } from '../repositories/document.repository';
import { DocumentItem, DocumentUploadPayload } from '../types';
import { BadRequestError } from '../utils/errors';
import { logger } from '../utils/logger';

export class DocumentService {
  /**
   * Lists documents scoped strictly to the authenticated user's Firestore driveFolderId.
   */
  async listUserDocuments(uid: string): Promise<{ driveFolderId: string; documents: DocumentItem[]; note: string }> {
    const driveFolderId = await userService.getVerifiedDriveFolderId(uid);
    logger.info(`Listing documents for UID ${uid} bound to driveFolderId ${driveFolderId}`);

    const documents = await documentRepository.findByFolderId(driveFolderId);
    return {
      driveFolderId,
      documents,
      note: 'Google Drive file listing will connect to this verified folder in the next phase.'
    };
  }

  /**
   * Prepares document download strictly within the user's verified driveFolderId.
   */
  async getDocumentDownloadUrl(uid: string, documentId: string): Promise<{ documentId: string; driveFolderId: string; status: string }> {
    if (!documentId || typeof documentId !== 'string') {
      throw new BadRequestError('Valid documentId is required.');
    }

    const driveFolderId = await userService.getVerifiedDriveFolderId(uid);
    logger.info(`Authorizing download for document ${documentId} in driveFolderId ${driveFolderId}`);

    return {
      documentId,
      driveFolderId,
      status: 'Ready for Google Drive API file stream attachment.'
    };
  }

  /**
   * Handles document upload metadata, enforcing the Firestore-stored driveFolderId.
   */
  async uploadDocument(uid: string, payload: DocumentUploadPayload): Promise<{
    message: string;
    fileName: string;
    driveFolderId: string;
    targetLocation: string;
  }> {
    if (!payload.fileName || typeof payload.fileName !== 'string' || !payload.fileName.trim()) {
      throw new BadRequestError('fileName parameter is required for upload.');
    }

    const driveFolderId = await userService.getVerifiedDriveFolderId(uid);
    logger.info(`Authorizing document upload '${payload.fileName}' to driveFolderId ${driveFolderId} for user ${uid}`);

    return {
      message: 'Upload payload validated and routed to client authoritative Google Drive folder.',
      fileName: payload.fileName.trim(),
      driveFolderId,
      targetLocation: `google-drive://${driveFolderId}/${payload.fileName.trim()}`
    };
  }
}

export const documentService = new DocumentService();

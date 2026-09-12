import { DocumentItem } from '../types';
import { logger } from '../utils/logger';

export class DocumentRepository {
  /**
   * Stubs or tracks document records scoped strictly by the user's verified driveFolderId.
   * Direct arbitrary folder IDs from client payloads are never accepted.
   */
  async findByFolderId(driveFolderId: string): Promise<DocumentItem[]> {
    logger.info(`Listing documents scoped to verified driveFolderId: ${driveFolderId}`);
    // Google Drive integration is intentionally reserved for the next phase.
    // Returns an empty list or folder metadata for now.
    return [];
  }

  async findDocumentById(documentId: string, driveFolderId: string): Promise<DocumentItem | null> {
    logger.info(`Searching for document ${documentId} strictly within folder ${driveFolderId}`);
    return null;
  }
}

export const documentRepository = new DocumentRepository();

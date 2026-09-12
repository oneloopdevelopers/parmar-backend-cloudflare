import { DocumentItem } from '../types';

export class DocumentModel {
  public static createDocumentItem(
    id: string,
    name: string,
    driveFolderId: string,
    mimeType = 'application/octet-stream',
    size = 0
  ): DocumentItem {
    return {
      id,
      name,
      mimeType,
      size,
      driveFolderId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }
}

import { google, drive_v3 } from 'googleapis';
import { config } from '../config/environment';
import { validateAndParseServiceAccountJson, TARGET_FIREBASE_PROJECT_ID } from '../config/firebaseAdmin';
import { DriveFolderSafeMetadata, DriveFileSafeMetadata } from '../types';
import { BadRequestError, NotFoundError, BadGatewayError } from '../utils/errors';
import { logger } from '../utils/logger';

const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

export class GoogleDriveService {
  private driveClient: drive_v3.Drive | null = null;

  /**
   * Initializes or returns the cached Google Drive API v3 client.
   * Uses server-side service account credentials from FIREBASE_SERVICE_ACCOUNT_JSON
   * or Google Application Default Credentials in production Cloud Run.
   */
  public createDriveClient(): drive_v3.Drive {
    if (this.driveClient) {
      return this.driveClient;
    }

    try {
      let auth: any;

      if (config.firebase.serviceAccountJson && config.firebase.serviceAccountJson.trim()) {
        const parsed = validateAndParseServiceAccountJson(config.firebase.serviceAccountJson);
        auth = new google.auth.GoogleAuth({
          credentials: {
            client_email: parsed.client_email,
            private_key: parsed.private_key,
            project_id: parsed.project_id || TARGET_FIREBASE_PROJECT_ID,
          },
          scopes: [GOOGLE_DRIVE_SCOPE],
        });
        logger.info(`Google Drive API client initialized via service account credentials (${parsed.client_email})`);
      } else {
        // Fallback to Google Application Default Credentials (e.g. Cloud Run identity)
        auth = new google.auth.GoogleAuth({
          scopes: [GOOGLE_DRIVE_SCOPE],
        });
        logger.info('Google Drive API client initialized via Application Default Credentials (ADC)');
      }

      this.driveClient = google.drive({ version: 'v3', auth });
      return this.driveClient;
    } catch (error: unknown) {
      const err = error as { message?: string };
      logger.error('Failed to initialize Google Drive API client:', err.message || error);
      throw new BadGatewayError(
        'Failed to initialize Google Drive API service. Please verify server-side credentials configuration.'
      );
    }
  }

  /**
   * Retrieves safe folder metadata (id, name, mimeType) for the given folderId.
   * @param folderId The authoritative Google Drive folder ID from Firestore
   */
  public async getDriveFolderMetadata(folderId: string): Promise<DriveFolderSafeMetadata> {
    if (!folderId || typeof folderId !== 'string' || !folderId.trim()) {
      throw new BadRequestError('A valid Google Drive folder ID is required.');
    }

    const drive = this.createDriveClient();

    try {
      const response = await drive.files.get({
        fileId: folderId.trim(),
        fields: 'id, name, mimeType, trashed',
        supportsAllDrives: true,
      });

      const data = response.data;
      if (!data || data.trashed) {
        throw new NotFoundError('The specified Google Drive folder was not found or is in the trash.');
      }

      return {
        id: data.id || folderId.trim(),
        name: data.name || '',
        mimeType: data.mimeType || 'application/vnd.google-apps.folder',
      };
    } catch (error: unknown) {
      const err = error as { code?: number | string; message?: string; status?: number };
      logger.error(`Error retrieving Google Drive folder metadata:`, err.message || error);

      if (err.code === 404 || err.status === 404) {
        throw new NotFoundError('Google Drive folder does not exist or has not been shared with the backend service account.');
      }

      if (err.code === 403 || err.status === 403) {
        throw new BadGatewayError('Permission denied when accessing Google Drive folder. Ensure the backend service account has editor access.');
      }

      throw new BadGatewayError(
        `Unable to access Google Drive folder: ${err.message || 'Upstream Google Drive API error'}`
      );
    }
  }

  /**
   * Lists files directly inside the specified folder.
   * Applies the Drive query: `'<folderId>' in parents and trashed = false`
   * Retrieves only: id, name, mimeType, size, createdTime, modifiedTime.
   * Handles Google Drive pagination across multiple pages with safe server-side limits.
   */
  public async listFilesInFolder(folderId: string, maxPages: number = 10): Promise<DriveFileSafeMetadata[]> {
    if (!folderId || typeof folderId !== 'string' || !folderId.trim()) {
      throw new BadRequestError('A valid Google Drive folder ID is required.');
    }

    const cleanFolderId = folderId.trim().replace(/'/g, "\\'");
    const drive = this.createDriveClient();

    try {
      const allFiles: DriveFileSafeMetadata[] = [];
      let pageToken: string | undefined = undefined;
      let pageCount = 0;
      // Safe server-side limit to prevent infinite loops or memory exhaustion (up to 5,000 files)
      const MAX_PAGES = Math.min(Math.max(1, maxPages), 50);

      do {
        const response: any = await drive.files.list({
          q: `'${cleanFolderId}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          pageSize: 100,
          orderBy: 'createdTime desc',
          pageToken: pageToken,
        });

        const rawFiles = response.data?.files || [];

        for (const f of rawFiles) {
          allFiles.push({
            id: f.id || '',
            name: f.name || '',
            mimeType: f.mimeType || '',
            size: f.size || '0',
            createdTime: f.createdTime || '',
            modifiedTime: f.modifiedTime || '',
          });
        }

        pageToken = response.data?.nextPageToken || undefined;
        pageCount++;
      } while (pageToken && pageCount < MAX_PAGES);

      return allFiles;
    } catch (error: unknown) {
      if (error instanceof BadRequestError || error instanceof NotFoundError || error instanceof BadGatewayError) {
        throw error;
      }
      const err = error as { code?: number | string; message?: string; status?: number };
      logger.error('Error listing files in Google Drive folder:', err.message || error);

      throw new BadGatewayError(
        `Unable to access Google Drive API: ${err.message || 'Upstream Google Drive service failure'}`
      );
    }
  }
}

export const googleDriveService = new GoogleDriveService();

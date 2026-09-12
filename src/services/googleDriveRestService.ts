import { getGoogleAccessToken, GOOGLE_DRIVE_SCOPE } from './googleServiceAccountAuth';
import { DriveFolderSafeMetadata, DriveFileSafeMetadata } from '../types';
import { BadRequestError, NotFoundError, BadGatewayError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface DriveRestOptions {
  serviceAccountJson: string;
  customFetch?: typeof fetch;
  maxPages?: number;
}

export class GoogleDriveRestService {
  /**
   * Retrieves safe metadata for the given folderId using the Google Drive v3 REST API.
   */
  public async getDriveFolderMetadata(
    folderId: string,
    options: DriveRestOptions
  ): Promise<DriveFolderSafeMetadata> {
    if (!folderId || typeof folderId !== 'string' || !folderId.trim()) {
      throw new BadRequestError('A valid Google Drive folder ID is required.');
    }

    const cleanFolderId = encodeURIComponent(folderId.trim());
    const fetchImpl = options.customFetch || fetch;
    const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
      scopes: GOOGLE_DRIVE_SCOPE,
      customFetch: options.customFetch
    });

    const url = `https://www.googleapis.com/drive/v3/files/${cleanFolderId}?fields=id,name,mimeType,trashed&supportsAllDrives=true`;

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });

      if (response.status === 404) {
        throw new NotFoundError(
          'Google Drive folder does not exist or has not been shared with the backend service account.'
        );
      }

      if (response.status === 403) {
        throw new BadGatewayError(
          'Permission denied when accessing Google Drive folder. Ensure the backend service account has editor access.'
        );
      }

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Drive REST files.get failed with status ${response.status}:`, errorText);
        throw new BadGatewayError(`Google Drive API error: HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        id?: string;
        name?: string;
        mimeType?: string;
        trashed?: boolean;
      };

      if (!data || data.trashed) {
        throw new NotFoundError('The specified Google Drive folder was not found or is in the trash.');
      }

      return {
        id: data.id || folderId.trim(),
        name: data.name || '',
        mimeType: data.mimeType || 'application/vnd.google-apps.folder'
      };
    } catch (err) {
      if (err instanceof BadRequestError || err instanceof NotFoundError || err instanceof BadGatewayError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Error retrieving Google Drive folder metadata via REST:', msg);
      throw new BadGatewayError(`Unable to access Google Drive folder: ${msg}`);
    }
  }

  /**
   * Lists non-trashed files directly inside the specified folderId using the Google Drive v3 REST API.
   * Handles pagination with safe server-side bounds.
   */
  public async listFilesInFolder(
    folderId: string,
    options: DriveRestOptions
  ): Promise<DriveFileSafeMetadata[]> {
    if (!folderId || typeof folderId !== 'string' || !folderId.trim()) {
      throw new BadRequestError('A valid Google Drive folder ID is required.');
    }

    const safeFolderId = folderId.trim().replace(/'/g, "\\'");
    const query = `'${safeFolderId}' in parents and trashed = false`;
    const fetchImpl = options.customFetch || fetch;
    const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
      scopes: GOOGLE_DRIVE_SCOPE,
      customFetch: options.customFetch
    });

    const maxPages = Math.min(Math.max(1, options.maxPages || 10), 50);
    const allFiles: DriveFileSafeMetadata[] = [];
    let pageToken: string | undefined = undefined;
    let pageCount = 0;

    try {
      do {
        const urlParams = new URLSearchParams({
          q: query,
          fields: 'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime)',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          pageSize: '100',
          orderBy: 'createdTime desc'
        });

        if (pageToken) {
          urlParams.set('pageToken', pageToken);
        }

        const url = `https://www.googleapis.com/drive/v3/files?${urlParams.toString()}`;

        const response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          }
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error(`Drive REST files.list failed with status ${response.status}:`, errorText);
          throw new BadGatewayError(
            `Unable to access Google Drive API: Upstream returned HTTP ${response.status}`
          );
        }

        const data = (await response.json()) as {
          nextPageToken?: string;
          files?: Array<{
            id?: string;
            name?: string;
            mimeType?: string;
            size?: string;
            createdTime?: string;
            modifiedTime?: string;
          }>;
        };

        const rawFiles = data.files || [];
        for (const f of rawFiles) {
          allFiles.push({
            id: f.id || '',
            name: f.name || '',
            mimeType: f.mimeType || '',
            size: f.size || '0',
            createdTime: f.createdTime || '',
            modifiedTime: f.modifiedTime || ''
          });
        }

        pageToken = data.nextPageToken;
        pageCount++;
      } while (pageToken && pageCount < maxPages);

      return allFiles;
    } catch (err) {
      if (err instanceof BadRequestError || err instanceof NotFoundError || err instanceof BadGatewayError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Error listing files in Google Drive folder via REST:', msg);
      throw new BadGatewayError(`Unable to access Google Drive API: ${msg}`);
    }
  }
}

export const googleDriveRestService = new GoogleDriveRestService();

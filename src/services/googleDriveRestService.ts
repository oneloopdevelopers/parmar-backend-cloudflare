import { getGoogleAccessToken, GOOGLE_DRIVE_SCOPE } from './googleServiceAccountAuth';
import {
  DriveFolderSafeMetadata,
  DriveFileSafeMetadata,
  DriveFileDetails,
  DriveFileDownloadResult,
  DriveFileUploadResult,
  UploadFileParams
} from '../types';
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

  /**
   * Retrieves file metadata for a specific fileId using the Google Drive v3 REST API.
   * Requests id, name, mimeType, parents, size, and trashed fields.
   */
  public async getFileMetadata(
    fileId: string,
    options: DriveRestOptions
  ): Promise<DriveFileDetails> {
    if (!fileId || typeof fileId !== 'string' || !fileId.trim()) {
      throw new BadRequestError('A valid Google Drive file ID is required.');
    }

    const cleanFileId = encodeURIComponent(fileId.trim());
    const fetchImpl = options.customFetch || fetch;
    const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
      scopes: GOOGLE_DRIVE_SCOPE,
      customFetch: options.customFetch
    });

    const url = `https://www.googleapis.com/drive/v3/files/${cleanFileId}?fields=id,name,mimeType,parents,size,trashed&supportsAllDrives=true`;

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
          'The requested document was not found or has not been shared with the backend service account.'
        );
      }

      if (response.status === 403) {
        throw new BadGatewayError(
          'Permission denied when accessing Google Drive file. Ensure the backend service account has access.'
        );
      }

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Drive REST files.get metadata failed with status ${response.status}:`, errorText);
        throw new BadGatewayError(`Google Drive API error: HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        id?: string;
        name?: string;
        mimeType?: string;
        parents?: string[];
        size?: string | number;
        trashed?: boolean;
      };

      return {
        id: data.id || fileId.trim(),
        name: data.name || '',
        mimeType: data.mimeType || 'application/octet-stream',
        parents: Array.isArray(data.parents) ? data.parents : [],
        size: data.size !== undefined && data.size !== null ? String(data.size) : undefined,
        trashed: Boolean(data.trashed)
      };
    } catch (err) {
      if (err instanceof BadRequestError || err instanceof NotFoundError || err instanceof BadGatewayError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Error retrieving Google Drive file metadata via REST:', msg);
      throw new BadGatewayError(`Unable to retrieve file metadata: ${msg}`);
    }
  }

  /**
   * Downloads a file as a stream from Google Drive v3 REST API using alt=media.
   * Keeps credentials and access tokens strictly server-side.
   */
  public async downloadFileStream(
    fileId: string,
    options: DriveRestOptions
  ): Promise<DriveFileDownloadResult> {
    if (!fileId || typeof fileId !== 'string' || !fileId.trim()) {
      throw new BadRequestError('A valid Google Drive file ID is required.');
    }

    const cleanFileId = encodeURIComponent(fileId.trim());
    const fetchImpl = options.customFetch || fetch;
    const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
      scopes: GOOGLE_DRIVE_SCOPE,
      customFetch: options.customFetch
    });

    const url = `https://www.googleapis.com/drive/v3/files/${cleanFileId}?alt=media&supportsAllDrives=true`;

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (response.status === 404) {
        throw new NotFoundError(
          'The requested document was not found or has not been shared with the backend service account.'
        );
      }

      if (response.status === 403) {
        throw new BadGatewayError(
          'Permission denied when downloading from Google Drive. Ensure the backend service account has access.'
        );
      }

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Drive REST files.get alt=media failed with status ${response.status}:`, errorText);
        throw new BadGatewayError(`Google Drive download error: HTTP ${response.status}`);
      }

      return {
        stream: response.body,
        contentLength: response.headers.get('content-length') || undefined,
        contentType: response.headers.get('content-type') || undefined
      };
    } catch (err) {
      if (err instanceof BadRequestError || err instanceof NotFoundError || err instanceof BadGatewayError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Error downloading Google Drive file stream via REST:', msg);
      throw new BadGatewayError(`Unable to download Google Drive document: ${msg}`);
    }
  }

  /**
   * Uploads a file using Google Drive v3 multipart upload.
   * Places the file strictly into the specified authoritative parents folder.
   * Returns safe metadata: id, name, mimeType, size, createdTime.
   */
  public async uploadFileMultipart(
    params: UploadFileParams,
    options: DriveRestOptions
  ): Promise<DriveFileUploadResult> {
    if (!params.name || typeof params.name !== 'string' || !params.name.trim()) {
      throw new BadRequestError('A valid file name is required for upload.');
    }
    if (!params.mimeType || typeof params.mimeType !== 'string' || !params.mimeType.trim()) {
      throw new BadRequestError('A valid MIME type is required for upload.');
    }
    if (!params.parents || !Array.isArray(params.parents) || params.parents.length === 0) {
      throw new BadRequestError('A valid parent folder ID is required for upload.');
    }
    if (!params.content || !(params.content instanceof Uint8Array)) {
      throw new BadRequestError('A valid file binary content is required for upload.');
    }

    const fetchImpl = options.customFetch || fetch;
    const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
      scopes: GOOGLE_DRIVE_SCOPE,
      customFetch: options.customFetch
    });

    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,createdTime';

    const encoder = new TextEncoder();
    const metadataPart = JSON.stringify({
      name: params.name.trim(),
      parents: params.parents
    });

    const headerChunk = encoder.encode(
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadataPart}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${params.mimeType.trim()}\r\n\r\n`
    );

    const footerChunk = encoder.encode(`\r\n--${boundary}--\r\n`);

    const totalLength = headerChunk.length + params.content.length + footerChunk.length;
    const bodyBuffer = new Uint8Array(totalLength);
    bodyBuffer.set(headerChunk, 0);
    bodyBuffer.set(params.content, headerChunk.length);
    bodyBuffer.set(footerChunk, headerChunk.length + params.content.length);

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Accept': 'application/json'
        },
        body: bodyBuffer
      });

      if (response.status === 404) {
        throw new NotFoundError(
          'The target Google Drive folder was not found or has not been shared with the backend service account.'
        );
      }

      if (response.status === 403) {
        throw new BadGatewayError(
          'Permission denied when uploading to Google Drive folder. Ensure the service account has editor access.'
        );
      }

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Drive REST files.create uploadType=multipart failed with status ${response.status}:`, errorText);
        throw new BadGatewayError(`Google Drive upload error: HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        id?: string;
        name?: string;
        mimeType?: string;
        size?: string;
        createdTime?: string;
      };

      if (!data || !data.id) {
        throw new BadGatewayError('Invalid upstream response from Google Drive: missing file id.');
      }

      return {
        id: data.id,
        name: data.name || params.name.trim(),
        mimeType: data.mimeType || params.mimeType.trim(),
        size: data.size || String(params.content.length),
        createdTime: data.createdTime || new Date().toISOString()
      };
    } catch (err) {
      if (err instanceof BadRequestError || err instanceof NotFoundError || err instanceof BadGatewayError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Error uploading file to Google Drive via REST:', msg);
      throw new BadGatewayError(`Unable to upload file to Google Drive: ${msg}`);
    }
  }
}


export const googleDriveRestService = new GoogleDriveRestService();

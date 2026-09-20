import { getGoogleAccessToken } from './googleServiceAccountAuth';
import { validateClientProfile, validateUid } from '../utils/clientProfileUtils';
import { ClientDocument, ClientProfileResponse } from '../types';
import { BadRequestError, NotFoundError, BadGatewayError, AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface FirestoreField {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string | number;
  doubleValue?: number;
  timestampValue?: string;
  nullValue?: null;
  mapValue?: { fields?: Record<string, FirestoreField> };
  arrayValue?: { values?: FirestoreField[] };
  bytesValue?: string;
  referenceValue?: string;
  geoPointValue?: { latitude: number; longitude: number };
}

export interface FirestoreRestDocument {
  name: string;
  fields?: Record<string, FirestoreField>;
  createTime?: string;
  updateTime?: string;
}

/**
 * Recursively decodes a Firestore REST field value to a standard JavaScript primitive/object.
 */
export function decodeFirestoreValue(field: FirestoreField | null | undefined): unknown {
  if (!field || typeof field !== 'object') {
    return null;
  }

  if ('stringValue' in field && field.stringValue !== undefined) {
    return field.stringValue;
  }
  if ('booleanValue' in field && field.booleanValue !== undefined) {
    return field.booleanValue;
  }
  if ('integerValue' in field && field.integerValue !== undefined) {
    const parsed = parseInt(String(field.integerValue), 10);
    return isNaN(parsed) ? field.integerValue : parsed;
  }
  if ('doubleValue' in field && field.doubleValue !== undefined) {
    return Number(field.doubleValue);
  }
  if ('timestampValue' in field && field.timestampValue !== undefined) {
    return field.timestampValue;
  }
  if ('nullValue' in field) {
    return null;
  }
  if ('mapValue' in field && field.mapValue) {
    return decodeFirestoreFields(field.mapValue.fields || {});
  }
  if ('arrayValue' in field && field.arrayValue) {
    const items = field.arrayValue.values || [];
    return items.map((item) => decodeFirestoreValue(item));
  }
  if ('bytesValue' in field) {
    return field.bytesValue;
  }
  if ('referenceValue' in field) {
    return field.referenceValue;
  }
  if ('geoPointValue' in field) {
    return field.geoPointValue;
  }

  return null;
}

/**
 * Encodes a JavaScript primitive, array, or object into a Firestore REST field structure.
 */
export function encodeFirestoreValue(val: unknown): FirestoreField {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (typeof val === 'string') {
    return { stringValue: val };
  }
  if (typeof val === 'boolean') {
    return { booleanValue: val };
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  if (val instanceof Date) {
    return { timestampValue: val.toISOString() };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(encodeFirestoreValue) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, FirestoreField> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      fields[k] = encodeFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

/**
 * Decodes all fields of a Firestore REST document into a flat JavaScript record.
 */
export function decodeFirestoreFields(fields: Record<string, FirestoreField>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    result[key] = decodeFirestoreValue(field);
  }
  return result;
}

export class FirestoreRestService {
  /**
   * Creates or updates a document in Firestore using the Google Cloud Firestore REST API v1.
   * Path format: `{collection}/{docId}`
   */
  public async setDocument(
    collection: string,
    docId: string,
    data: Record<string, unknown>,
    options: {
      projectId: string;
      serviceAccountJson: string;
      customFetch?: typeof fetch;
    }
  ): Promise<void> {
    const fetchImpl = options.customFetch || fetch;
    const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
      customFetch: options.customFetch
    });

    const cleanDocId = encodeURIComponent(docId.trim());
    const url = `https://firestore.googleapis.com/v1/projects/${options.projectId}/databases/(default)/documents/${collection}/${cleanDocId}`;

    const fields: Record<string, FirestoreField> = {};
    for (const [key, value] of Object.entries(data)) {
      fields[key] = encodeFirestoreValue(value);
    }

    try {
      const response = await fetchImpl(url, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ fields })
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(`Firestore REST setDocument failed with ${response.status} for ${collection}/${docId}:`, errorBody);
        throw new BadGatewayError(`Cloud Firestore REST write error: HTTP ${response.status}`);
      }
    } catch (err) {
      if (err instanceof BadRequestError || err instanceof NotFoundError || err instanceof BadGatewayError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to write document ${collection}/${docId} via Firestore REST:`, msg);
      throw new BadGatewayError(`Failed to communicate with Cloud Firestore REST API: ${msg}`);
    }
  }
  /**
   * Deletes a document from Firestore using the Google Cloud Firestore REST API v1.
   * Path format: `{collection}/{docId}`
   * When throwOnError is false (default), failures are logged without throwing.
   * When throwOnError is true, failures (other than 404) throw AppError.
   */
  public async deleteDocument(
    collection: string,
    docId: string,
    options: {
      projectId: string;
      serviceAccountJson: string;
      customFetch?: typeof fetch;
      throwOnError?: boolean;
    }
  ): Promise<void> {
    const throwOnError = options.throwOnError === true;
    const fetchImpl = options.customFetch || fetch;
    const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
      customFetch: options.customFetch
    });

    const cleanDocId = encodeURIComponent(docId.trim());
    const url = `https://firestore.googleapis.com/v1/projects/${options.projectId}/databases/(default)/documents/${collection}/${cleanDocId}`;

    try {
      const response = await fetchImpl(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });

      if (!response.ok && response.status !== 404) {
        const errorBody = await response.text();
        logger.warn(`Firestore REST deleteDocument returned status ${response.status} for ${collection}/${docId}:`, errorBody);
        if (throwOnError) {
          throw new AppError(500, 'Cloud Firestore REST delete error', 'FIRESTORE_DELETE_ERROR');
        }
      }
    } catch (err) {
      if (throwOnError) {
        if (err instanceof AppError) throw err;
        logger.error(`Failed to delete document ${collection}/${docId} via Firestore REST:`, err instanceof Error ? err.message : String(err));
        throw new AppError(500, 'Cloud Firestore REST delete error', 'FIRESTORE_DELETE_ERROR');
      }
      logger.error(`Failed to delete document ${collection}/${docId} via Firestore REST:`, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Lists documents in a Firestore collection using the Google Cloud Firestore REST API v1.
   */
  public async listDocuments(
    collection: string,
    options: {
      projectId: string;
      serviceAccountJson: string;
      pageSize?: number;
      pageToken?: string;
      customFetch?: typeof fetch;
    }
  ): Promise<{ documents: Array<{ id: string; data: Record<string, unknown> }>; nextPageToken?: string }> {
    const fetchImpl = options.customFetch || fetch;
    const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
      customFetch: options.customFetch
    });

    const pageSize = options.pageSize || 100;
    let url = `https://firestore.googleapis.com/v1/projects/${options.projectId}/databases/(default)/documents/${collection}?pageSize=${pageSize}`;
    if (options.pageToken) {
      url += `&pageToken=${encodeURIComponent(options.pageToken)}`;
    }

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });

      if (response.status === 404) {
        return { documents: [] };
      }

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(`Firestore REST listDocuments failed with status ${response.status} for collection ${collection}:`, errorBody);
        throw new BadGatewayError(`Cloud Firestore REST list error: HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        documents?: Array<{
          name: string;
          fields?: Record<string, FirestoreField>;
          createTime?: string;
          updateTime?: string;
        }>;
        nextPageToken?: string;
      };

      const results: Array<{ id: string; data: Record<string, unknown> }> = [];
      for (const doc of data.documents || []) {
        const parts = doc.name.split('/');
        const id = decodeURIComponent(parts[parts.length - 1]);
        const decoded = doc.fields ? decodeFirestoreFields(doc.fields) : {};
        if (doc.createTime && !decoded.createdAt) decoded.createdAt = doc.createTime;
        if (doc.updateTime && !decoded.updatedAt) decoded.updatedAt = doc.updateTime;
        results.push({ id, data: decoded });
      }

      return {
        documents: results,
        nextPageToken: data.nextPageToken
      };
    } catch (err) {
      if (err instanceof BadRequestError || err instanceof NotFoundError || err instanceof BadGatewayError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to list documents in ${collection} via Firestore REST:`, msg);
      throw new BadGatewayError(`Failed to communicate with Cloud Firestore REST API: ${msg}`);
    }
  }

  /**
   * Retrieves a document from Firestore using the Google Cloud Firestore REST API v1.
   * Path format: `users/{uid}`
   */
  public async getDocument(
    collection: string,
    docId: string,
    options: {
      projectId: string;
      serviceAccountJson: string;
      customFetch?: typeof fetch;
    }
  ): Promise<Record<string, unknown> | null> {
    const fetchImpl = options.customFetch || fetch;
    const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
      customFetch: options.customFetch
    });

    const cleanDocId = encodeURIComponent(docId.trim());
    const url = `https://firestore.googleapis.com/v1/projects/${options.projectId}/databases/(default)/documents/${collection}/${cleanDocId}`;

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(`Firestore REST API returned ${response.status} for ${collection}/${docId}:`, errorBody);

        if (response.status === 403) {
          throw new BadGatewayError('Permission denied when querying Cloud Firestore document.');
        }
        if (response.status === 401) {
          throw new BadGatewayError('Authentication failed with Cloud Firestore REST API.');
        }

        throw new BadGatewayError(`Cloud Firestore REST error: HTTP ${response.status}`);
      }

      const doc = (await response.json()) as FirestoreRestDocument;
      if (!doc.fields) {
        return {};
      }

      const decoded = decodeFirestoreFields(doc.fields);
      if (doc.createTime && !decoded.createdAt) decoded.createdAt = doc.createTime;
      if (doc.updateTime && !decoded.updatedAt) decoded.updatedAt = doc.updateTime;

      return decoded;
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof BadRequestError || err instanceof BadGatewayError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to fetch document ${collection}/${docId} via Firestore REST:`, msg);
      throw new BadGatewayError(`Failed to communicate with Cloud Firestore REST API: ${msg}`);
    }
  }

  /**
   * Commits multiple document writes in batches using Cloud Firestore REST API v1 :commit endpoint.
   * Chunks writes into safe batches of up to 400 (well below Firestore's 500-write limit).
   */
  public async commitBatchWrites(
    writes: Array<{
      collection: string;
      docId: string;
      data: Record<string, unknown>;
    }>,
    options: {
      projectId: string;
      serviceAccountJson: string;
      customFetch?: typeof fetch;
    }
  ): Promise<number> {
    if (!writes || writes.length === 0) return 0;

    const fetchImpl = options.customFetch || fetch;
    const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
      customFetch: options.customFetch
    });

    const CHUNK_SIZE = 400;
    let committedCount = 0;

    for (let i = 0; i < writes.length; i += CHUNK_SIZE) {
      const chunk = writes.slice(i, i + CHUNK_SIZE);
      const commitUrl = `https://firestore.googleapis.com/v1/projects/${options.projectId}/databases/(default)/documents:commit`;

      const firestoreWrites = chunk.map((w) => {
        const cleanDocId = encodeURIComponent(w.docId.trim());
        const fields: Record<string, FirestoreField> = {};
        for (const [key, value] of Object.entries(w.data)) {
          fields[key] = encodeFirestoreValue(value);
        }
        return {
          update: {
            name: `projects/${options.projectId}/databases/(default)/documents/${w.collection}/${cleanDocId}`,
            fields
          }
        };
      });

      try {
        const response = await fetchImpl(commitUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({ writes: firestoreWrites })
        });

        if (response.ok) {
          committedCount += chunk.length;
          continue;
        }

        // If :commit endpoint is not implemented or rejected by mock/proxy, fallback to individual setDocument
        if (response.status === 404 || response.status === 501) {
          logger.warn(`Firestore REST :commit returned ${response.status}. Executing batch writes via sequential fallback.`);
          for (const item of chunk) {
            await this.setDocument(item.collection, item.docId, item.data, options);
            committedCount++;
          }
          continue;
        }

        const errorBody = await response.text();
        logger.error(`Firestore REST commitBatchWrites failed with HTTP ${response.status}:`, errorBody);
        throw new BadGatewayError(`Cloud Firestore REST batch commit error: HTTP ${response.status}`);
      } catch (err) {
        if (err instanceof BadGatewayError) throw err;
        logger.warn(`Firestore commit error, attempting fallback to individual writes: ${err instanceof Error ? err.message : String(err)}`);
        for (const item of chunk) {
          await this.setDocument(item.collection, item.docId, item.data, options);
          committedCount++;
        }
      }
    }

    return committedCount;
  }

  /**
   * Loads and validates the client profile document `users/{uid}`.
   */
  public async getClientProfile(
    uid: string,
    options: {
      projectId: string;
      serviceAccountJson: string;
      customFetch?: typeof fetch;
    }
  ): Promise<ClientDocument> {
    const sanitizedUid = validateUid(uid);

    const data = await this.getDocument('users', sanitizedUid, options);
    if (!data) {
      throw new NotFoundError(`Firestore user profile does not exist for UID: ${sanitizedUid}`);
    }

    return validateClientProfile(data, sanitizedUid);
  }

  /**
   * Tests connectivity to Cloud Firestore via REST API for health checks.
   */
  public async testConnectivity(options: {
    projectId: string;
    serviceAccountJson: string;
    customFetch?: typeof fetch;
  }): Promise<{ connected: boolean; projectId: string; latencyMs: number; error?: string }> {
    const startTime = Date.now();
    const fetchImpl = options.customFetch || fetch;

    try {
      const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
        customFetch: options.customFetch
      });
      const url = `https://firestore.googleapis.com/v1/projects/${options.projectId}/databases/(default)/documents/users?pageSize=1`;

      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        return {
          connected: false,
          projectId: options.projectId,
          latencyMs,
          error: `Firestore REST returned HTTP ${response.status}: ${errorText}`
        };
      }

      return {
        connected: true,
        projectId: options.projectId,
        latencyMs
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        connected: false,
        projectId: options.projectId,
        latencyMs,
        error: msg
      };
    }
  }
}

export const firestoreRestService = new FirestoreRestService();

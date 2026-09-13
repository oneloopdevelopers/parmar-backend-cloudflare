import { getGoogleAccessToken } from './googleServiceAccountAuth';
import { validateClientProfile, validateUid } from '../utils/clientProfileUtils';
import { ClientDocument, ClientProfileResponse } from '../types';
import { BadRequestError, NotFoundError, BadGatewayError } from '../utils/errors';
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
      if (doc.createTime) decoded.createdAt = doc.createTime;
      if (doc.updateTime) decoded.updatedAt = doc.updateTime;

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

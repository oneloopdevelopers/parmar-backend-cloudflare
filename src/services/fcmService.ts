/**
 * Firebase Cloud Messaging (FCM) Service
 * Implements FCM HTTP v1 message delivery, device token registration,
 * multi-device support, IDOR prevention, and invalid token auto-cleanup.
 */

import { firestoreRestService } from './firestoreRestService';
import { getGoogleAccessToken, FCM_MESSAGING_SCOPE } from './googleServiceAccountAuth';
import {
  FcmTokenRecord,
  RegisterFcmTokenInput,
  DeleteFcmTokenInput,
  FcmPushPayload,
  FcmDeliveryStats
} from '../types/fcm.types';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  BadGatewayError
} from '../utils/errors';
import { validateUid } from '../utils/clientProfileUtils';
import { logger } from '../utils/logger';

export const CANONICAL_ANDROID_NOTIFICATION_CHANNEL_ID = 'client_portal_notifications';

export interface FcmServiceContext {
  projectId: string;
  serviceAccountJson: string;
  customFetch?: typeof fetch;
}

export interface FcmSendResult {
  success: boolean;
  isInvalidToken: boolean;
  statusCode: number;
  errorCode?: string;
  errorReason?: string;
}

/**
 * Computes a deterministic, collision-resistant, URL-safe SHA-256 document ID for an FCM token.
 * Prevents path encoding/traversal issues and avoids using raw tokens as Firestore document paths.
 */
export async function computeTokenRecordId(token: string): Promise<string> {
  const trimmed = token.trim();
  const buffer = new TextEncoder().encode(trimmed);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Validates the FCM token string format.
 */
export function validateFcmTokenString(token: unknown): string {
  if (!token || typeof token !== 'string' || !token.trim()) {
    throw new BadRequestError('FCM token is required and must be a non-empty string.');
  }
  const trimmed = token.trim();
  if (trimmed.length < 10 || trimmed.length > 4096) {
    throw new BadRequestError('FCM token length is invalid (must be between 10 and 4096 characters).');
  }
  // Standard FCM token format: alphanumeric, colons, hyphens, underscores, dots, slashes, plus, equals, percent
  if (!/^[a-zA-Z0-9_\-:%./+=]+$/.test(trimmed)) {
    throw new BadRequestError('FCM token contains invalid characters.');
  }
  return trimmed;
}

/**
 * Validates and sanitizes optional client device metadata.
 */
export function sanitizeDeviceMetadata(input: { platform?: unknown; appVersion?: unknown }): {
  platform: string;
  appVersion?: string;
} {
  let platform = 'android';
  if (typeof input.platform === 'string' && input.platform.trim()) {
    const p = input.platform.trim().toLowerCase();
    if (p.length > 32 || !/^[a-z0-9_-]+$/.test(p)) {
      throw new BadRequestError('Invalid platform metadata string.');
    }
    platform = p;
  }

  let appVersion: string | undefined = undefined;
  if (typeof input.appVersion === 'string' && input.appVersion.trim()) {
    const v = input.appVersion.trim();
    if (v.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(v)) {
      throw new BadRequestError('Invalid appVersion metadata string.');
    }
    appVersion = v;
  }

  return { platform, appVersion };
}

export class FcmService {
  /**
   * Verifies that the client profile exists, has role 'client', and status 'active'.
   * Prevents inactive, unverified, or non-client accounts from registering tokens.
   */
  public async assertActiveClientProfile(uid: string, ctx: FcmServiceContext): Promise<void> {
    const sanitizedUid = validateUid(uid);
    const profile = await firestoreRestService.getClientProfile(sanitizedUid, ctx);
    if (!profile) {
      throw new NotFoundError(`Client profile for UID '${sanitizedUid}' not found.`);
    }
    if (profile.role !== 'client') {
      throw new ForbiddenError(`Access denied: UID '${sanitizedUid}' is not a client account.`);
    }
    if (profile.status !== 'active') {
      throw new ForbiddenError(`Access denied: Client account '${sanitizedUid}' is inactive.`);
    }
  }

  /**
   * Registers or updates an FCM device token for the authenticated client.
   * Path: users/{verifiedUid}/fcmTokens/{sha256(token)}
   * Supports multiple devices per user without overwriting other device tokens.
   */
  public async registerFcmToken(
    callerUid: string,
    input: RegisterFcmTokenInput,
    ctx: FcmServiceContext
  ): Promise<{ success: boolean; message: string }> {
    const sanitizedUid = validateUid(callerUid);
    await this.assertActiveClientProfile(sanitizedUid, ctx);

    const token = validateFcmTokenString(input.token);
    const { platform, appVersion } = sanitizeDeviceMetadata(input);

    const tokenRecordId = await computeTokenRecordId(token);
    const collectionPath = `users/${sanitizedUid}/fcmTokens`;

    const nowIso = new Date().toISOString();

    // Check if token record already exists to preserve original createdAt
    const existingDoc = await firestoreRestService.getDocument(collectionPath, tokenRecordId, ctx);
    const createdAt = (existingDoc && typeof existingDoc.createdAt === 'string')
      ? existingDoc.createdAt
      : nowIso;

    const tokenRecord: FcmTokenRecord = {
      token,
      createdAt,
      updatedAt: nowIso,
      lastSeenAt: nowIso,
      platform
    };

    if (appVersion) {
      tokenRecord.appVersion = appVersion;
    }

    await firestoreRestService.setDocument(
      collectionPath,
      tokenRecordId,
      tokenRecord as unknown as Record<string, unknown>,
      ctx
    );

    logger.info(`FcmService: Registered/updated FCM device token record ${tokenRecordId.slice(0, 8)}... for client`);

    return {
      success: true,
      message: 'FCM token registered successfully.'
    };
  }

  /**
   * Unregisters/deletes an FCM device token for the authenticated client.
   * Path: users/{verifiedUid}/fcmTokens/{sha256(token)}
   * Strictly enforces IDOR prevention (only operates under caller's verified UID).
   * Operation is idempotent: returns success even if token was already removed.
   */
  public async unregisterFcmToken(
    callerUid: string,
    input: DeleteFcmTokenInput,
    ctx: FcmServiceContext
  ): Promise<{ success: boolean; message: string }> {
    const sanitizedUid = validateUid(callerUid);
    await this.assertActiveClientProfile(sanitizedUid, ctx);

    const token = validateFcmTokenString(input.token);
    const tokenRecordId = await computeTokenRecordId(token);
    const collectionPath = `users/${sanitizedUid}/fcmTokens`;

    await firestoreRestService.deleteDocument(collectionPath, tokenRecordId, {
      ...ctx,
      throwOnError: false
    });

    logger.info(`FcmService: Unregistered FCM device token record ${tokenRecordId.slice(0, 8)}... for client`);

    return {
      success: true,
      message: 'FCM token unregistered successfully.'
    };
  }

  /**
   * Retrieves all registered FCM device tokens for a given client UID.
   * Path: users/{uid}/fcmTokens
   */
  public async getUserFcmTokens(
    uid: string,
    ctx: FcmServiceContext
  ): Promise<Array<{ docId: string; token: string; record: FcmTokenRecord }>> {
    const sanitizedUid = validateUid(uid);
    const collectionPath = `users/${sanitizedUid}/fcmTokens`;

    const { documents } = await firestoreRestService.listDocuments(collectionPath, {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      pageSize: 100,
      customFetch: ctx.customFetch
    });

    const results: Array<{ docId: string; token: string; record: FcmTokenRecord }> = [];

    for (const doc of documents) {
      const data = doc.data;
      if (typeof data.token === 'string' && data.token.trim()) {
        const record: FcmTokenRecord = {
          token: data.token.trim(),
          createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
          updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
          platform: typeof data.platform === 'string' ? data.platform : 'android',
          appVersion: typeof data.appVersion === 'string' ? data.appVersion : undefined,
          lastSeenAt: typeof data.lastSeenAt === 'string' ? data.lastSeenAt : undefined
        };
        results.push({
          docId: doc.id,
          token: data.token.trim(),
          record
        });
      }
    }

    return results;
  }

  /**
   * Sends an FCM push notification to a single device token using Firebase Cloud Messaging HTTP v1 API.
   * Target endpoint: https://fcm.googleapis.com/v1/projects/{projectId}/messages:send
   * Scope: https://www.googleapis.com/auth/firebase.messaging
   *
   * Differentiates between permanently invalid tokens (UNREGISTERED, INVALID_ARGUMENT, 404)
   * and temporary server/network errors (500, 503, 429).
   */
  public async sendFcmMessage(
    token: string,
    payload: FcmPushPayload,
    ctx: FcmServiceContext
  ): Promise<FcmSendResult> {
    const fetchImpl = ctx.customFetch || fetch;

    try {
      const { accessToken, projectId: saProjectId } = await getGoogleAccessToken(ctx.serviceAccountJson, {
        scopes: FCM_MESSAGING_SCOPE,
        customFetch: ctx.customFetch
      });

      const targetProjectId = ctx.projectId || saProjectId || 'document-portal-d2b6d';
      const fcmUrl = `https://fcm.googleapis.com/v1/projects/${targetProjectId}/messages:send`;

      // Safe HTTP v1 message structure compliant with Android FcmPayloadParser
      const fcmMessage = {
        message: {
          token: token,
          notification: {
            title: payload.title,
            body: payload.message
          },
          data: {
            notificationId: payload.notificationId,
            category: payload.category
          },
          android: {
            priority: 'HIGH',
            notification: {
              channel_id: CANONICAL_ANDROID_NOTIFICATION_CHANNEL_ID,
              click_action: 'OPEN_NOTIFICATIONS'
            }
          }
        }
      };

      const response = await fetchImpl(fcmUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(fcmMessage)
      });

      if (response.ok) {
        return {
          success: true,
          isInvalidToken: false,
          statusCode: response.status
        };
      }

      // Handle FCM error response
      let errorBody: any = null;
      try {
        errorBody = await response.json();
      } catch {
        // Fallback if not json
      }

      const fcmErrorCode = errorBody?.error?.details?.[0]?.errorCode || errorBody?.error?.status || '';
      const fcmErrorMessage = errorBody?.error?.message || '';

      const isInvalidToken =
        response.status === 404 ||
        fcmErrorCode === 'UNREGISTERED' ||
        fcmErrorCode === 'INVALID_ARGUMENT' ||
        fcmErrorCode === 'SENDER_ID_MISMATCH' ||
        fcmErrorMessage.toLowerCase().includes('unregistered') ||
        fcmErrorMessage.toLowerCase().includes('registration-token-not-registered') ||
        fcmErrorMessage.toLowerCase().includes('requested entity was not found');

      logger.warn(
        `FcmService: FCM HTTP v1 push rejected: HTTP ${response.status}, code='${fcmErrorCode}', isInvalid=${isInvalidToken}`
      );

      return {
        success: false,
        isInvalidToken,
        statusCode: response.status,
        errorCode: fcmErrorCode,
        errorReason: fcmErrorMessage || `HTTP ${response.status}`
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('FcmService: Network or authentication exception during FCM push:', msg);

      return {
        success: false,
        isInvalidToken: false,
        statusCode: 0,
        errorReason: msg
      };
    }
  }

  /**
   * Dispatches FCM pushes to all registered tokens belonging to a specific client UID.
   * Automatically cleans up permanently invalid tokens from Firestore.
   */
  public async dispatchFcmToUserTokens(
    uid: string,
    payload: FcmPushPayload,
    ctx: FcmServiceContext
  ): Promise<FcmDeliveryStats> {
    const stats: FcmDeliveryStats = {
      tokensAttempted: 0,
      tokensDelivered: 0,
      tokensRemoved: 0
    };

    try {
      const userTokens = await this.getUserFcmTokens(uid, ctx);
      if (userTokens.length === 0) {
        return stats;
      }

      for (const item of userTokens) {
        stats.tokensAttempted++;
        const sendResult = await this.sendFcmMessage(item.token, payload, ctx);

        if (sendResult.success) {
          stats.tokensDelivered++;
        } else if (sendResult.isInvalidToken) {
          // Permanently invalid or unregistered token: clean up from Firestore
          logger.info(`FcmService: Auto-removing invalid FCM token record ${item.docId.slice(0, 8)}...`);
          await firestoreRestService.deleteDocument(`users/${uid}/fcmTokens`, item.docId, {
            ...ctx,
            throwOnError: false
          });
          stats.tokensRemoved++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('FcmService: Error during user FCM push dispatch:', msg);
    }

    return stats;
  }

  /**
   * Dispatches FCM pushes across multiple client UIDs for a broadcast notification.
   * Dispatches concurrently in controlled batches to stay within Worker subrequest limits.
   */
  public async dispatchBroadcastFcm(
    clientUids: string[],
    payload: FcmPushPayload,
    ctx: FcmServiceContext
  ): Promise<FcmDeliveryStats> {
    const totalStats: FcmDeliveryStats = {
      tokensAttempted: 0,
      tokensDelivered: 0,
      tokensRemoved: 0
    };

    if (clientUids.length === 0) {
      return totalStats;
    }

    // Process in batches of 10 clients to balance concurrency and Worker limits
    const BATCH_SIZE = 10;
    for (let i = 0; i < clientUids.length; i += BATCH_SIZE) {
      const batchUids = clientUids.slice(i, i + BATCH_SIZE);
      const batchPromises = batchUids.map((uid) => this.dispatchFcmToUserTokens(uid, payload, ctx));
      const results = await Promise.all(batchPromises);

      for (const res of results) {
        totalStats.tokensAttempted += res.tokensAttempted;
        totalStats.tokensDelivered += res.tokensDelivered;
        totalStats.tokensRemoved += res.tokensRemoved;
      }
    }

    logger.info(
      `FcmService: Broadcast FCM dispatch completed: attempted=${totalStats.tokensAttempted}, delivered=${totalStats.tokensDelivered}, removed=${totalStats.tokensRemoved}`
    );

    return totalStats;
  }
}

export const fcmService = new FcmService();

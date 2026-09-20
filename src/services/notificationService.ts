/**
 * Notification Service
 * Core business logic, validation, IDOR prevention, and Firestore persistence
 * for the Notification Centre backend foundation.
 */

import { firestoreRestService } from './firestoreRestService';
import { fcmService } from './fcmService';
import {
  NotificationCategory,
  NotificationTarget,
  NotificationRecord,
  CreateNotificationInput,
  BroadcastNotificationRecord,
  NotificationListResponse,
  UnreadCountResponse,
  AdminNotificationHistoryItem,
  AdminNotificationHistoryQuery,
  AdminNotificationHistoryResult
} from '../types/notification.types';
import { FcmDeliveryStats } from '../types/fcm.types';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  UnauthorizedError
} from '../utils/errors';
import { validateUid } from '../utils/clientProfileUtils';
import { logger } from '../utils/logger';

export interface NotificationServiceContext {
  projectId: string;
  serviceAccountJson: string;
  customFetch?: typeof fetch;
}

const ALLOWED_CATEGORIES: ReadonlySet<NotificationCategory> = new Set([
  'GENERAL',
  'DOCUMENT_UPDATE',
  'ALERT',
  'REMINDER'
]);

const EXACT_FORBIDDEN_METADATA_TOKENS = new Set([
  'password',
  'passwords',
  'token',
  'tokens',
  'secret',
  'secrets',
  'credential',
  'credentials',
  'auth',
  'bearer',
  'key',
  'keys',
  'pan',
  'iv',
  'privatekey'
]);

function isSensitiveMetadataKey(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/);

  for (const token of tokens) {
    if (EXACT_FORBIDDEN_METADATA_TOKENS.has(token)) {
      return true;
    }
  }

  const rawLower = key.toLowerCase();
  if (
    rawLower.includes('password') ||
    rawLower.includes('secret') ||
    rawLower.includes('credential') ||
    rawLower.includes('drivefolderid') ||
    rawLower.includes('bearer')
  ) {
    return true;
  }

  return false;
}

/**
 * Validates a Notification ID to prevent path traversal and injection.
 */
export function validateNotificationId(id: unknown): string {
  if (!id || typeof id !== 'string' || !id.trim()) {
    throw new BadRequestError('Notification ID is required and must be a non-empty string.');
  }
  const trimmed = id.trim();
  if (trimmed.length > 128) {
    throw new BadRequestError('Notification ID length exceeds maximum permitted limit (128 characters).');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new BadRequestError('Invalid Notification ID format: only alphanumeric, hyphens, and underscores are allowed.');
  }
  return trimmed;
}

/**
 * Validates a notification title.
 */
export function validateNotificationTitle(title: unknown): string {
  if (!title || typeof title !== 'string' || !title.trim()) {
    throw new BadRequestError('Notification title is required and must be a non-empty string.');
  }
  const trimmed = title.trim();
  if (trimmed.length > 200) {
    throw new BadRequestError('Notification title exceeds maximum length of 200 characters.');
  }
  return trimmed;
}

/**
 * Validates a notification message body.
 */
export function validateNotificationMessage(message: unknown): string {
  if (!message || typeof message !== 'string' || !message.trim()) {
    throw new BadRequestError('Notification message is required and must be a non-empty string.');
  }
  const trimmed = message.trim();
  if (trimmed.length > 2000) {
    throw new BadRequestError('Notification message exceeds maximum length of 2000 characters.');
  }
  return trimmed;
}

/**
 * Validates a notification category.
 */
export function validateNotificationCategory(category: unknown): NotificationCategory {
  if (!category || typeof category !== 'string') {
    throw new BadRequestError("Notification category is required. Allowed values: GENERAL, DOCUMENT_UPDATE, ALERT, REMINDER.");
  }
  const upper = category.trim().toUpperCase() as NotificationCategory;
  if (!ALLOWED_CATEGORIES.has(upper)) {
    throw new BadRequestError("Invalid notification category. Allowed values: GENERAL, DOCUMENT_UPDATE, ALERT, REMINDER.");
  }
  return upper;
}

/**
 * Validates a notification target.
 */
export function validateNotificationTarget(target: unknown): NotificationTarget {
  if (!target || typeof target !== 'string') {
    throw new BadRequestError("Notification target is required. Allowed values: 'INDIVIDUAL' or 'ALL_ACTIVE'.");
  }
  const upper = target.trim().toUpperCase() as NotificationTarget;
  if (upper !== 'INDIVIDUAL' && upper !== 'ALL_ACTIVE') {
    throw new BadRequestError("Invalid notification target. Must be either 'INDIVIDUAL' or 'ALL_ACTIVE'.");
  }
  return upper;
}

/**
 * Sanitizes metadata to strictly prevent storing secrets or sensitive auth data.
 */
export function sanitizeNotificationMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (metadata === undefined || metadata === null) {
    return undefined;
  }
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new BadRequestError('Notification metadata must be a JSON key-value object.');
  }

  const raw = metadata as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (isSensitiveMetadataKey(key)) {
      throw new BadRequestError(`Security violation: Metadata key '${key}' contains sensitive or forbidden keyword.`);
    }

    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (Array.isArray(value)) {
      sanitized[key] = value.filter(
        (item) => item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
      );
    } else if (typeof value === 'object') {
      sanitized[key] = sanitizeNotificationMetadata(value);
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export class NotificationService {
  /**
   * Verifies that the client profile exists, has role 'client', and status 'active'.
   * Throws ForbiddenError if the client is inactive or not a client.
   */
  public async assertActiveClient(uid: string, ctx: NotificationServiceContext): Promise<void> {
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
   * Lists notifications for the authenticated client.
   * Path: users/{verifiedUid}/notifications
   * Excludes dismissed notifications unless includeDismissed is true.
   * Computes accurate unreadCount.
   */
  public async listClientNotifications(
    callerUid: string,
    query: {
      limit?: number | string;
      includeDismissed?: boolean | string;
    },
    ctx: NotificationServiceContext
  ): Promise<NotificationListResponse> {
    const sanitizedUid = validateUid(callerUid);
    await this.assertActiveClient(sanitizedUid, ctx);

    const includeDismissed =
      query.includeDismissed === true || query.includeDismissed === 'true' || query.includeDismissed === '1';

    let limitNum = 50;
    if (query.limit !== undefined) {
      const parsed = Number(query.limit);
      if (Number.isInteger(parsed) && parsed > 0) {
        limitNum = Math.min(parsed, 100);
      } else {
        throw new BadRequestError('Query parameter limit must be a positive integer.');
      }
    }

    const collectionPath = `users/${sanitizedUid}/notifications`;
    const { documents } = await firestoreRestService.listDocuments(collectionPath, {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      pageSize: 300,
      customFetch: ctx.customFetch
    });

    const allRecords: NotificationRecord[] = [];
    let unreadCount = 0;

    for (const doc of documents) {
      const data = doc.data;
      const isRead = data.isRead === true;
      const isDismissed = data.isDismissed === true;

      if (!isRead && !isDismissed) {
        unreadCount++;
      }

      const record: NotificationRecord = {
        id: doc.id,
        recipientUid: sanitizedUid,
        title: typeof data.title === 'string' ? data.title : '',
        message: typeof data.message === 'string' ? data.message : '',
        category: (typeof data.category === 'string' && ALLOWED_CATEGORIES.has(data.category as NotificationCategory))
          ? (data.category as NotificationCategory)
          : 'GENERAL',
        isRead,
        isDismissed,
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
        readAt: typeof data.readAt === 'string' ? data.readAt : null,
        dismissedAt: typeof data.dismissedAt === 'string' ? data.dismissedAt : null,
        metadata: data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
          ? (data.metadata as Record<string, unknown>)
          : undefined
      };

      allRecords.push(record);
    }

    // Filter by dismissal preference
    const filtered = includeDismissed ? allRecords : allRecords.filter((r) => !r.isDismissed);

    // Sort newest first by createdAt
    filtered.sort((a, b) => {
      const timeA = new Date(a.createdAt).getTime() || 0;
      const timeB = new Date(b.createdAt).getTime() || 0;
      return timeB - timeA;
    });

    // Apply limit
    const paged = filtered.slice(0, limitNum);

    return {
      notifications: paged,
      unreadCount
    };
  }

  /**
   * Retrieves unread notification count for the authenticated client.
   */
  public async getClientUnreadCount(
    callerUid: string,
    ctx: NotificationServiceContext
  ): Promise<UnreadCountResponse> {
    const sanitizedUid = validateUid(callerUid);
    await this.assertActiveClient(sanitizedUid, ctx);

    const collectionPath = `users/${sanitizedUid}/notifications`;
    const { documents } = await firestoreRestService.listDocuments(collectionPath, {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      pageSize: 300,
      customFetch: ctx.customFetch
    });

    let unreadCount = 0;
    for (const doc of documents) {
      const data = doc.data;
      if (data.isRead !== true && data.isDismissed !== true) {
        unreadCount++;
      }
    }

    return { unreadCount };
  }

  /**
   * Marks a single notification as read for the authenticated client.
   * Enforces strict tenant isolation: rejects if notification does not exist in users/{verifiedUid}/notifications.
   */
  public async markNotificationAsRead(
    callerUid: string,
    notificationId: string,
    ctx: NotificationServiceContext
  ): Promise<{ notification: NotificationRecord; unreadCount: number }> {
    const sanitizedUid = validateUid(callerUid);
    const sanitizedNotifId = validateNotificationId(notificationId);
    await this.assertActiveClient(sanitizedUid, ctx);

    const collectionPath = `users/${sanitizedUid}/notifications`;
    const docData = await firestoreRestService.getDocument(collectionPath, sanitizedNotifId, {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      customFetch: ctx.customFetch
    });

    if (!docData) {
      throw new NotFoundError('Notification not found.');
    }

    const nowIso = new Date().toISOString();
    const updatedData: Record<string, unknown> = {
      ...docData,
      id: sanitizedNotifId,
      recipientUid: sanitizedUid,
      isRead: true,
      readAt: nowIso
    };

    await firestoreRestService.setDocument(collectionPath, sanitizedNotifId, updatedData, {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      customFetch: ctx.customFetch
    });

    const { unreadCount } = await this.getClientUnreadCount(sanitizedUid, ctx);

    const record: NotificationRecord = {
      id: sanitizedNotifId,
      recipientUid: sanitizedUid,
      title: typeof updatedData.title === 'string' ? updatedData.title : '',
      message: typeof updatedData.message === 'string' ? updatedData.message : '',
      category: (typeof updatedData.category === 'string' && ALLOWED_CATEGORIES.has(updatedData.category as NotificationCategory))
        ? (updatedData.category as NotificationCategory)
        : 'GENERAL',
      isRead: true,
      isDismissed: updatedData.isDismissed === true,
      createdAt: typeof updatedData.createdAt === 'string' ? updatedData.createdAt : nowIso,
      readAt: nowIso,
      dismissedAt: typeof updatedData.dismissedAt === 'string' ? updatedData.dismissedAt : null,
      metadata: updatedData.metadata && typeof updatedData.metadata === 'object' && !Array.isArray(updatedData.metadata)
        ? (updatedData.metadata as Record<string, unknown>)
        : undefined
    };

    return {
      notification: record,
      unreadCount
    };
  }

  /**
   * Marks all unread, non-dismissed notifications as read for the authenticated client.
   */
  public async markAllNotificationsAsRead(
    callerUid: string,
    ctx: NotificationServiceContext
  ): Promise<{ success: boolean; updatedCount: number; unreadCount: number }> {
    const sanitizedUid = validateUid(callerUid);
    await this.assertActiveClient(sanitizedUid, ctx);

    const collectionPath = `users/${sanitizedUid}/notifications`;
    const { documents } = await firestoreRestService.listDocuments(collectionPath, {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      pageSize: 300,
      customFetch: ctx.customFetch
    });

    const nowIso = new Date().toISOString();
    const writesToCommit: Array<{ collection: string; docId: string; data: Record<string, unknown> }> = [];

    for (const doc of documents) {
      const data = doc.data;
      if (data.isRead !== true && data.isDismissed !== true) {
        writesToCommit.push({
          collection: collectionPath,
          docId: doc.id,
          data: {
            ...data,
            id: doc.id,
            recipientUid: sanitizedUid,
            isRead: true,
            readAt: nowIso
          }
        });
      }
    }

    if (writesToCommit.length > 0) {
      await firestoreRestService.commitBatchWrites(writesToCommit, {
        projectId: ctx.projectId,
        serviceAccountJson: ctx.serviceAccountJson,
        customFetch: ctx.customFetch
      });
    }

    return {
      success: true,
      updatedCount: writesToCommit.length,
      unreadCount: 0
    };
  }

  /**
   * Dismisses a notification for the authenticated client.
   * Path: users/{verifiedUid}/notifications/{notificationId}
   * Sets isDismissed: true.
   */
  public async dismissNotification(
    callerUid: string,
    notificationId: string,
    ctx: NotificationServiceContext
  ): Promise<{ success: boolean; message: string; unreadCount: number }> {
    const sanitizedUid = validateUid(callerUid);
    const sanitizedNotifId = validateNotificationId(notificationId);
    await this.assertActiveClient(sanitizedUid, ctx);

    const collectionPath = `users/${sanitizedUid}/notifications`;
    const docData = await firestoreRestService.getDocument(collectionPath, sanitizedNotifId, {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      customFetch: ctx.customFetch
    });

    if (!docData) {
      throw new NotFoundError('Notification not found.');
    }

    const nowIso = new Date().toISOString();
    const updatedData: Record<string, unknown> = {
      ...docData,
      id: sanitizedNotifId,
      recipientUid: sanitizedUid,
      isDismissed: true,
      dismissedAt: nowIso
    };

    await firestoreRestService.setDocument(collectionPath, sanitizedNotifId, updatedData, {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      customFetch: ctx.customFetch
    });

    const { unreadCount } = await this.getClientUnreadCount(sanitizedUid, ctx);

    return {
      success: true,
      message: 'Notification dismissed successfully.',
      unreadCount
    };
  }

  /**
   * Admin Endpoint: Creates an individual notification or broadcasts to all active clients.
   * Validates target, category, title, message, and recipient status.
   */
  public async createNotification(
    adminUid: string,
    input: CreateNotificationInput,
    ctx: NotificationServiceContext
  ): Promise<
    | { target: 'INDIVIDUAL'; notification: NotificationRecord; delivery: FcmDeliveryStats }
    | { target: 'ALL_ACTIVE'; broadcastId: string; recipientCount: number; delivery: FcmDeliveryStats }
  > {
    const target = validateNotificationTarget(input.target);
    const title = validateNotificationTitle(input.title);
    const message = validateNotificationMessage(input.message);
    const category = validateNotificationCategory(input.category);
    const metadata = sanitizeNotificationMetadata(input.metadata);
    const nowIso = new Date().toISOString();

    if (target === 'INDIVIDUAL') {
      if (!input.recipientUid || typeof input.recipientUid !== 'string' || !input.recipientUid.trim()) {
        throw new BadRequestError("Recipient UID ('recipientUid') is required when target is 'INDIVIDUAL'.");
      }

      const recipientUid = validateUid(input.recipientUid);
      const clientProfile = await firestoreRestService.getClientProfile(recipientUid, ctx);

      if (!clientProfile) {
        throw new NotFoundError(`Recipient client profile for UID '${recipientUid}' not found.`);
      }
      if (clientProfile.role !== 'client') {
        throw new BadRequestError(`Recipient user '${recipientUid}' is not a client.`);
      }
      if (clientProfile.status !== 'active') {
        throw new BadRequestError(
          `Recipient client '${recipientUid}' is inactive. Notifications can only be sent to active clients.`
        );
      }

      const notifId = `notif_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const notifData: Record<string, unknown> = {
        id: notifId,
        recipientUid,
        title,
        message,
        category,
        isRead: false,
        isDismissed: false,
        createdAt: nowIso,
        readAt: null,
        dismissedAt: null,
        createdByUid: adminUid
      };

      if (metadata) {
        notifData.metadata = metadata;
      }

      await firestoreRestService.setDocument(`users/${recipientUid}/notifications`, notifId, notifData, {
        projectId: ctx.projectId,
        serviceAccountJson: ctx.serviceAccountJson,
        customFetch: ctx.customFetch
      });

      logger.info(`NotificationService: Created INDIVIDUAL notification ${notifId} for client ${recipientUid} by admin ${adminUid}`);

      // Persist administrative audit history document under admin_notifications/{historyId}
      try {
        const historyId = `ahist_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const historyRecord: Record<string, unknown> = {
          id: historyId,
          target: 'INDIVIDUAL',
          recipientUid,
          title,
          message,
          category,
          recipientCount: 1,
          status: 'COMPLETED',
          createdAt: nowIso,
          createdByUid: adminUid
        };

        await firestoreRestService.setDocument('admin_notifications', historyId, historyRecord, {
          projectId: ctx.projectId,
          serviceAccountJson: ctx.serviceAccountJson,
          customFetch: ctx.customFetch
        });
      } catch (histErr) {
        logger.error('NotificationService: Failed to persist admin history entry for individual notification:', histErr);
      }

      // Dispatch FCM Push Notifications to all active device tokens for the recipient
      let delivery: FcmDeliveryStats = {
        tokensAttempted: 0,
        tokensDelivered: 0,
        tokensRemoved: 0
      };

      try {
        delivery = await fcmService.dispatchFcmToUserTokens(
          recipientUid,
          {
            notificationId: notifId,
            category,
            title,
            message,
            metadata
          },
          ctx
        );
      } catch (fcmErr) {
        logger.error('NotificationService: Non-blocking FCM push failure for individual notification:', fcmErr);
      }

      const record: NotificationRecord = {
        id: notifId,
        recipientUid,
        title,
        message,
        category,
        isRead: false,
        isDismissed: false,
        createdAt: nowIso,
        readAt: null,
        metadata
      };

      return {
        target: 'INDIVIDUAL',
        notification: record,
        delivery
      };
    }

    // target === 'ALL_ACTIVE'
    // NOTE ON SCALING THRESHOLD & FUTURE CLOUDFLARE QUEUES:
    // The current synchronous fan-out implementation operates within Cloudflare Worker subrequest limits
    // and uses batched Firestore commit writes in chunks of 400.
    // Scaling threshold: For active client volumes exceeding 400-1,000 clients, or to prevent worker execution
    // timeouts during heavy write fan-outs, a decoupled Cloudflare Queues consumer worker should be introduced
    // to process batches asynchronously. As instructed, no Cloudflare Queues or external worker dependencies
    // are introduced in this step.

    const { documents: allUsers } = await firestoreRestService.listDocuments('users', {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      pageSize: 300,
      customFetch: ctx.customFetch
    });

    const activeClients = allUsers.filter((u) => {
      const data = u.data;
      return data.role === 'client' && data.status === 'active';
    });

    const broadcastId = `bcast_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

    // Prepare writes for all active clients
    const writes: Array<{ collection: string; docId: string; data: Record<string, unknown> }> = [];

    for (const client of activeClients) {
      const notifId = `notif_${broadcastId}_${client.id}`;
      const notifData: Record<string, unknown> = {
        id: notifId,
        recipientUid: client.id,
        broadcastId,
        title,
        message,
        category,
        isRead: false,
        isDismissed: false,
        createdAt: nowIso,
        readAt: null,
        dismissedAt: null,
        createdByUid: adminUid
      };

      if (metadata) {
        notifData.metadata = metadata;
      }

      writes.push({
        collection: `users/${client.id}/notifications`,
        docId: notifId,
        data: notifData
      });
    }

    if (writes.length > 0) {
      await firestoreRestService.commitBatchWrites(writes, {
        projectId: ctx.projectId,
        serviceAccountJson: ctx.serviceAccountJson,
        customFetch: ctx.customFetch
      });
    }

    // Create master broadcast record for audit and tracking
    const broadcastRecord: Record<string, unknown> = {
      id: broadcastId,
      title,
      message,
      category,
      target: 'ALL_ACTIVE',
      createdByUid: adminUid,
      createdAt: nowIso,
      status: 'COMPLETED',
      recipientCount: activeClients.length
    };

    if (metadata) {
      broadcastRecord.metadata = metadata;
    }

    await firestoreRestService.setDocument('broadcast_notifications', broadcastId, broadcastRecord, {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      customFetch: ctx.customFetch
    });

    logger.info(
      `NotificationService: Broadcast ${broadcastId} dispatched to ${activeClients.length} active client(s) by admin ${adminUid}`
    );

    // Dispatch FCM Push Notifications to all active clients' registered device tokens
    let delivery: FcmDeliveryStats = {
      tokensAttempted: 0,
      tokensDelivered: 0,
      tokensRemoved: 0
    };

    try {
      const clientUids = activeClients.map((c) => c.id);
      delivery = await fcmService.dispatchBroadcastFcm(
        clientUids,
        {
          notificationId: broadcastId,
          category,
          title,
          message,
          metadata
        },
        ctx
      );
    } catch (fcmErr) {
      logger.error('NotificationService: Non-blocking FCM push failure for broadcast notification:', fcmErr);
    }

    return {
      target: 'ALL_ACTIVE',
      broadcastId,
      recipientCount: activeClients.length,
      delivery
    };
  }

  /**
   * Retrieves notification history for the Admin Dashboard.
   * Merges existing broadcast_notifications and new admin_notifications (for individual notifications).
   * Sorted newest-first by createdAt.
   */
  public async getNotificationHistory(
    query: AdminNotificationHistoryQuery,
    ctx: NotificationServiceContext
  ): Promise<AdminNotificationHistoryResult> {
    let limitNum = 50;
    if (query.limit !== undefined) {
      const parsed = Number(query.limit);
      if (Number.isInteger(parsed) && parsed > 0) {
        limitNum = Math.min(parsed, 100);
      } else {
        throw new BadRequestError('Query parameter limit must be a positive integer.');
      }
    }

    // 1. Fetch broadcast records from broadcast_notifications
    const { documents: broadcastDocs } = await firestoreRestService.listDocuments('broadcast_notifications', {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      pageSize: 100,
      customFetch: ctx.customFetch
    });

    // 2. Fetch individual notifications from admin_notifications
    const { documents: adminDocs } = await firestoreRestService.listDocuments('admin_notifications', {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      pageSize: 100,
      customFetch: ctx.customFetch
    });

    const historyItems: AdminNotificationHistoryItem[] = [];

    // Map broadcast records
    for (const doc of broadcastDocs) {
      const data = doc.data;
      historyItems.push({
        id: String(data.id || doc.id),
        target: 'ALL_ACTIVE',
        recipientUid: null,
        title: typeof data.title === 'string' ? data.title : '',
        message: typeof data.message === 'string' ? data.message : '',
        category: (typeof data.category === 'string' && ALLOWED_CATEGORIES.has(data.category as NotificationCategory))
          ? (data.category as NotificationCategory)
          : 'GENERAL',
        recipientCount: typeof data.recipientCount === 'number' ? data.recipientCount : 0,
        status: typeof data.status === 'string' ? data.status : 'COMPLETED',
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
        createdByUid: typeof data.createdByUid === 'string' ? data.createdByUid : ''
      });
    }

    // Map individual admin_notifications records
    for (const doc of adminDocs) {
      const data = doc.data;
      historyItems.push({
        id: String(data.id || doc.id),
        target: 'INDIVIDUAL',
        recipientUid: typeof data.recipientUid === 'string' ? data.recipientUid : null,
        title: typeof data.title === 'string' ? data.title : '',
        message: typeof data.message === 'string' ? data.message : '',
        category: (typeof data.category === 'string' && ALLOWED_CATEGORIES.has(data.category as NotificationCategory))
          ? (data.category as NotificationCategory)
          : 'GENERAL',
        recipientCount: typeof data.recipientCount === 'number' ? data.recipientCount : 1,
        status: typeof data.status === 'string' ? data.status : 'COMPLETED',
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
        createdByUid: typeof data.createdByUid === 'string' ? data.createdByUid : ''
      });
    }

    // Sort newest first by createdAt
    historyItems.sort((a, b) => {
      const timeA = new Date(a.createdAt).getTime() || 0;
      const timeB = new Date(b.createdAt).getTime() || 0;
      return timeB - timeA;
    });

    const total = historyItems.length;
    const paginated = historyItems.slice(0, limitNum);

    return {
      history: paginated,
      total
    };
  }
}

export const notificationService = new NotificationService();

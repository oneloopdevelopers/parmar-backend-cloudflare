/**
 * Notification Centre Type Definitions
 * Strict contracts for client notifications and admin broadcasts.
 */

export type NotificationCategory = 'GENERAL' | 'DOCUMENT_UPDATE' | 'ALERT' | 'REMINDER';

export type NotificationTarget = 'INDIVIDUAL' | 'ALL_ACTIVE';

export interface NotificationRecord {
  id: string;
  recipientUid: string;
  title: string;
  message: string;
  category: NotificationCategory;
  isRead: boolean;
  isDismissed: boolean;
  createdAt: string;
  readAt: string | null;
  dismissedAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateNotificationInput {
  target: NotificationTarget;
  recipientUid?: string;
  title: string;
  message: string;
  category: NotificationCategory;
  metadata?: Record<string, unknown>;
}

export interface BroadcastNotificationRecord {
  id: string;
  title: string;
  message: string;
  category: NotificationCategory;
  target: 'ALL_ACTIVE';
  createdByUid: string;
  createdAt: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
  recipientCount: number;
  metadata?: Record<string, unknown>;
}

export interface NotificationListResponse {
  notifications: NotificationRecord[];
  unreadCount: number;
}

export interface UnreadCountResponse {
  unreadCount: number;
}

/**
 * Firebase Cloud Messaging (FCM) Type Definitions
 * Server-side contracts for FCM device token management and push dispatch.
 */

export interface FcmTokenRecord {
  token: string;
  createdAt: string;
  updatedAt: string;
  platform: 'android' | string;
  appVersion?: string;
  lastSeenAt?: string;
}

export interface RegisterFcmTokenInput {
  token: string;
  platform?: string;
  appVersion?: string;
}

export interface DeleteFcmTokenInput {
  token: string;
}

export interface FcmPushPayload {
  notificationId: string;
  category?: string;
  type?: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface FcmDeliveryStats {
  tokensAttempted: number;
  tokensDelivered: number;
  tokensRemoved: number;
}

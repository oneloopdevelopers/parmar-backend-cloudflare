import { Router, Response, NextFunction } from 'express';
import { authenticateFirebaseUser } from '../middleware/authenticateFirebaseUser';
import { enforceZeroTrustIdentity } from '../middleware/validation.middleware';
import { notificationService } from '../services/notificationService';
import { AuthenticatedRequest } from '../types';
import { config } from '../config/environment';
import { BadRequestError } from '../utils/errors';

const router = Router();

const getServiceContext = () => ({
  projectId: config.firebase.projectId || 'document-portal-d2b6d',
  serviceAccountJson: config.firebase.serviceAccountJson || ''
});

// 1. GET /api/notifications
router.get(
  '/',
  enforceZeroTrustIdentity,
  authenticateFirebaseUser,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const callerUid = req.user?.uid;
      const { limit, includeDismissed } = req.query;
      const result = await notificationService.listClientNotifications(
        callerUid!,
        {
          limit: limit as string,
          includeDismissed: includeDismissed as string
        },
        getServiceContext()
      );

      return res.status(200).json({
        success: true,
        message: 'Notifications retrieved successfully.',
        data: {
          notifications: result.notifications,
          unreadCount: result.unreadCount
        },
        notifications: result.notifications,
        unreadCount: result.unreadCount,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      next(err);
    }
  }
);

// 2. GET /api/notifications/unread-count
router.get(
  '/unread-count',
  enforceZeroTrustIdentity,
  authenticateFirebaseUser,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const callerUid = req.user?.uid;
      const result = await notificationService.getClientUnreadCount(
        callerUid!,
        getServiceContext()
      );

      return res.status(200).json({
        success: true,
        data: {
          unreadCount: result.unreadCount
        },
        unreadCount: result.unreadCount,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      next(err);
    }
  }
);

// 3. PATCH /api/notifications/:notificationId/read
router.patch(
  '/:notificationId/read',
  enforceZeroTrustIdentity,
  authenticateFirebaseUser,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const callerUid = req.user?.uid;
      const { notificationId } = req.params;
      const result = await notificationService.markNotificationAsRead(
        callerUid!,
        notificationId,
        getServiceContext()
      );

      return res.status(200).json({
        success: true,
        message: 'Notification marked as read.',
        data: {
          notification: result.notification,
          unreadCount: result.unreadCount
        },
        notification: result.notification,
        unreadCount: result.unreadCount,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      next(err);
    }
  }
);

// 4. POST /api/notifications/mark-all-read
router.post(
  '/mark-all-read',
  enforceZeroTrustIdentity,
  authenticateFirebaseUser,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const callerUid = req.user?.uid;
      const result = await notificationService.markAllNotificationsAsRead(
        callerUid!,
        getServiceContext()
      );

      return res.status(200).json({
        success: true,
        message: 'All notifications marked as read.',
        data: {
          updatedCount: result.updatedCount,
          unreadCount: 0
        },
        updatedCount: result.updatedCount,
        unreadCount: 0,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      next(err);
    }
  }
);

// 5. DELETE /api/notifications/:notificationId
router.delete(
  '/:notificationId',
  enforceZeroTrustIdentity,
  authenticateFirebaseUser,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const callerUid = req.user?.uid;
      const { notificationId } = req.params;
      const result = await notificationService.dismissNotification(
        callerUid!,
        notificationId,
        getServiceContext()
      );

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          unreadCount: result.unreadCount
        },
        unreadCount: result.unreadCount,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;

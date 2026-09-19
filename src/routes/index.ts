import { Router } from 'express';
import healthRoutes from './health.routes';
import profileRoutes from './profile.routes';
import documentRoutes from './document.routes';
import driveRoutes from './drive.routes';
import notificationRoutes from './notification.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/profile', profileRoutes);
router.use('/documents', documentRoutes);
router.use('/drive', driveRoutes);
router.use('/notifications', notificationRoutes);

export default router;

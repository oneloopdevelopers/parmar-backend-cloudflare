import express, { Express } from 'express';
import cors from 'cors';
import apiRoutes from './routes';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { validateFirebaseAdminStartup } from './config/firebaseAdmin';
import { logger } from './utils/logger';

export function createApp(): Express {
  const app = express();

  // Startup validation: clearly reports whether Firebase Admin initialization succeeded
  const status = validateFirebaseAdminStartup();
  logger.info(`Startup check complete for project: ${status.projectId}`);

  // Core middlewares
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Mount API routes
  app.use('/api', apiRoutes);

  // Fallback for unmatched /api routes
  app.use('/api/*', notFoundHandler);

  // Global Error Handler for API routes
  app.use(errorHandler);

  return app;
}

export const app = createApp();
export default app;

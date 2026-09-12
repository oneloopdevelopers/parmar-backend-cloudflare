import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { sendError } from '../utils/response';
import { logger } from '../utils/logger';

export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): Response {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error(`Handled server error [${err.statusCode}] on ${req.method} ${req.originalUrl}: ${err.message}`);
    } else {
      logger.info(`Handled client request [${err.statusCode}] on ${req.method} ${req.originalUrl}: ${err.message}`);
    }
    return sendError(res, err.message, err.statusCode, err.code, err.details);
  }

  // Handle standard JSON parsing errors from express.json()
  if ('type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    return sendError(res, 'Malformed JSON payload in request body.', 400, 'INVALID_JSON');
  }

  logger.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  return sendError(
    res,
    process.env.NODE_ENV === 'production' 
      ? 'An internal server error occurred.' 
      : err.message || 'Internal server error',
    500,
    'INTERNAL_SERVER_ERROR'
  );
}

export function notFoundHandler(req: Request, res: Response): Response {
  return sendError(
    res,
    `Route not found: [${req.method}] ${req.originalUrl}`,
    404,
    'ROUTE_NOT_FOUND'
  );
}

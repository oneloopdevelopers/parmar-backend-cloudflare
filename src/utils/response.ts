import { Response } from 'express';
import { ApiResponse, ApiErrorResponse, ApiErrorDetail } from '../types';

export function sendSuccess<T>(
  res: Response,
  data?: T,
  message?: string,
  statusCode = 200
): Response {
  const responseBody: ApiResponse<T> = {
    success: true,
    message,
    data,
    timestamp: new Date().toISOString()
  };
  return res.status(statusCode).json(responseBody);
}

export function sendError(
  res: Response,
  message: string,
  statusCode = 500,
  code = 'INTERNAL_ERROR',
  details?: ApiErrorDetail[]
): Response {
  const responseBody: ApiErrorResponse = {
    success: false,
    error: {
      code,
      message,
      details
    },
    timestamp: new Date().toISOString()
  };
  return res.status(statusCode).json(responseBody);
}

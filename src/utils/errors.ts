import { ApiErrorDetail } from '../types';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: ApiErrorDetail[];
  public readonly isOperational: boolean;

  constructor(statusCode: number, message: string, code = 'INTERNAL_ERROR', details?: ApiErrorDetail[]) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Invalid request parameters', details?: ApiErrorDetail[]) {
    super(400, message, 'BAD_REQUEST', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required. Provide a valid Bearer token.', details?: ApiErrorDetail[]) {
    super(401, message, 'UNAUTHORIZED', details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied. Insufficient permissions.', details?: ApiErrorDetail[]) {
    super(403, message, 'FORBIDDEN', details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Requested resource not found', details?: ApiErrorDetail[]) {
    super(404, message, 'NOT_FOUND', details);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', details?: ApiErrorDetail[]) {
    super(503, message, 'SERVICE_UNAVAILABLE', details);
  }
}

export class BadGatewayError extends AppError {
  constructor(message = 'Upstream gateway error accessing external service', details?: ApiErrorDetail[]) {
    super(502, message, 'BAD_GATEWAY', details);
  }
}

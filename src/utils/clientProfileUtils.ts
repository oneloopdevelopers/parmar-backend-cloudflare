import { ClientDocument, ClientRole, ClientStatus } from '../types';
import { BadRequestError, UnauthorizedError } from './errors';
import { logger } from './logger';

/**
 * Masks a Permanent Account Number (PAN).
 * Replaces all characters except the last 4 with 'X'.
 * For example, 'ABCDE1234F' becomes 'XXXXXX234F'.
 */
export function maskPanNumber(pan?: string | null): string {
  if (!pan || typeof pan !== 'string') return '';
  const trimmed = pan.trim().toUpperCase();
  if (trimmed.length > 4) {
    return 'X'.repeat(trimmed.length - 4) + trimmed.slice(-4);
  }
  return 'X'.repeat(trimmed.length);
}

/**
 * Validates a Firebase UID to prevent injection, path traversal, or empty values.
 */
export function validateUid(uid: unknown): string {
  if (!uid || typeof uid !== 'string' || !uid.trim()) {
    throw new UnauthorizedError(
      'Authenticated Firebase UID is required. Client document access without verified identity is forbidden.'
    );
  }

  const sanitized = uid.trim();
  if (sanitized.includes('/') || sanitized.includes('\\') || sanitized.includes('..')) {
    throw new BadRequestError(
      'Security violation: Invalid UID format. Path traversal characters are strictly forbidden.'
    );
  }

  if (sanitized.length > 128) {
    throw new BadRequestError('Invalid UID format: Length exceeds maximum permitted limit.');
  }

  return sanitized;
}

/**
 * Validates client profile fields from Firestore.
 * Ensures no missing or malformed fields exist in the client record.
 */
export function validateClientProfile(data: unknown, uid: string): ClientDocument {
  if (!data || typeof data !== 'object') {
    throw new BadRequestError(
      `Client profile for UID '${uid}' is malformed: expected a valid Firestore document object.`
    );
  }

  const record = data as Record<string, unknown>;
  const errors: string[] = [];

  // 1. name: string, non-empty
  if (typeof record.name !== 'string' || !record.name.trim()) {
    errors.push("Field 'name' is missing or not a non-empty string");
  }

  // 2. email: string, valid email format
  if (
    typeof record.email !== 'string' ||
    !record.email.trim() ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email.trim())
  ) {
    errors.push("Field 'email' is missing or not a valid email address");
  }

  // 3. phone: string, non-empty
  if (typeof record.phone !== 'string' || !record.phone.trim()) {
    errors.push("Field 'phone' is missing or not a non-empty string");
  }

  // 4. panNumber: string, non-empty
  if (typeof record.panNumber !== 'string' || !record.panNumber.trim()) {
    errors.push("Field 'panNumber' is missing or not a non-empty string");
  }

  // 5. driveFolderId: string, non-empty (server-side authorization value)
  if (typeof record.driveFolderId !== 'string' || !record.driveFolderId.trim()) {
    errors.push("Field 'driveFolderId' is missing or not a non-empty string");
  }

  // 6. role: 'client' | 'admin'
  if (record.role !== 'client' && record.role !== 'admin') {
    errors.push("Field 'role' must be either 'client' or 'admin'");
  }

  // 7. status: 'active' | 'inactive'
  if (record.status !== 'active' && record.status !== 'inactive') {
    errors.push("Field 'status' must be either 'active' or 'inactive'");
  }

  if (errors.length > 0) {
    logger.warn(`Malformed client profile for UID ${uid}: ${errors.join('; ')}`);
    throw new BadRequestError(
      `Client profile in Firestore for UID '${uid}' is malformed or missing required field(s): ${errors.join('; ')}`
    );
  }

  return {
    name: (record.name as string).trim(),
    email: (record.email as string).trim(),
    phone: (record.phone as string).trim(),
    panNumber: (record.panNumber as string).trim().toUpperCase(),
    driveFolderId: (record.driveFolderId as string).trim(),
    role: record.role as ClientRole,
    status: record.status as ClientStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

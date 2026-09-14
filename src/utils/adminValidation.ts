import { BadRequestError } from '../utils/errors';

export interface ValidatedClientInput {
  name: string;
  email: string;
  phone: string;
  panNumber: string;
  password?: string;
  status: 'active' | 'inactive';
}

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Standard E.164 phone or general phone with country code: +91 98765 43210, +919876543210, etc.
const PHONE_REGEX = /^\+?[0-9\s\-()]{7,20}$/;

export const FORBIDDEN_CLIENT_CREATION_KEYS = [
  'uid',
  'firebaseuid',
  'firebase_uid',
  'role',
  'isadmin',
  'is_admin',
  'admin',
  'drivefolderid',
  'drive_folder_id',
  'folderid',
  'folder_id',
  'destinationfolderid',
  'destination_folder_id',
  'destinationfolder',
  'destination_folder',
  'uploadertype',
  'uploader_type',
  'uploadername',
  'uploader_name',
  'clientid',
  'client_id'
];

/**
 * Validates request payload for creating a new client.
 * Strictly prevents any client-supplied identity/privilege overrides (uid, role, admin, driveFolderId).
 */
export function validateCreateClientInput(body: unknown): ValidatedClientInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestError('Request body must be a JSON object.');
  }

  const record = body as Record<string, unknown>;

  // Check for forbidden privilege/identity keys
  for (const key of Object.keys(record)) {
    const normalized = key.toLowerCase().replace(/[-_]/g, '');
    if (FORBIDDEN_CLIENT_CREATION_KEYS.includes(normalized)) {
      throw new BadRequestError(
        `Security violation: Field '${key}' cannot be specified in client creation payload. Identity, role, and storage folders are strictly server-managed.`
      );
    }
  }

  const errors: string[] = [];

  // 1. Name
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) {
    errors.push("Field 'name' is required and must be a non-empty string.");
  } else if (name.length < 2 || name.length > 100) {
    errors.push("Field 'name' must be between 2 and 100 characters.");
  }

  // 2. Email
  const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : '';
  if (!email) {
    errors.push("Field 'email' is required and must be a valid email address.");
  } else if (!EMAIL_REGEX.test(email)) {
    errors.push("Field 'email' must be a valid email address format.");
  }

  // 3. Phone
  const phone = typeof record.phone === 'string' ? record.phone.trim() : '';
  if (!phone) {
    errors.push("Field 'phone' is required and must be a valid phone number.");
  } else if (!PHONE_REGEX.test(phone)) {
    errors.push("Field 'phone' must be a valid phone number format.");
  }

  // 4. PAN Number (Permanent Account Number: exactly 5 letters, 4 digits, 1 letter)
  const rawPan = typeof record.panNumber === 'string' ? record.panNumber.trim().toUpperCase() : '';
  if (!rawPan) {
    errors.push("Field 'panNumber' is required.");
  } else if (!PAN_REGEX.test(rawPan)) {
    errors.push("Field 'panNumber' must be a valid 10-character Indian PAN (format: 5 uppercase letters, 4 digits, 1 uppercase letter, e.g. ABCDE1234F).");
  }

  // 5. Password (optional, minimum 6 chars if provided)
  let password: string | undefined = undefined;
  if (record.password !== undefined && record.password !== null) {
    if (typeof record.password !== 'string' || record.password.length < 6) {
      errors.push("Field 'password' if provided must be a string with at least 6 characters.");
    } else {
      password = record.password;
    }
  }

  // 6. Status (optional, default: 'active')
  let status: 'active' | 'inactive' = 'active';
  if (record.status !== undefined && record.status !== null) {
    if (record.status === 'active' || record.status === 'inactive') {
      status = record.status;
    } else {
      errors.push("Field 'status' if provided must be either 'active' or 'inactive'.");
    }
  }

  if (errors.length > 0) {
    throw new BadRequestError(`Validation failed: ${errors.join(' ')}`);
  }

  return {
    name,
    email,
    phone,
    panNumber: rawPan,
    password,
    status
  };
}

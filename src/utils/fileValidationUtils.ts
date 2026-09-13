import { BadRequestError } from './errors';
import { logger } from './logger';

export const MAX_UPLOAD_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png'
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export const ALLOWED_EXTENSIONS_BY_MIME: Record<AllowedMimeType, string[]> = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png']
};

/**
 * Validates the file's binary magic bytes against its declared MIME type.
 * Returns true if the file signature matches the declared format.
 */
export function validateFileSignature(buffer: Uint8Array, mimeType: AllowedMimeType): boolean {
  if (!buffer || buffer.length < 4) {
    return false;
  }

  switch (mimeType) {
    case 'application/pdf':
      // PDF specification: File must start with '%PDF-' (0x25, 0x50, 0x44, 0x46, 0x2D)
      return (
        buffer.length >= 5 &&
        buffer[0] === 0x25 && // %
        buffer[1] === 0x50 && // P
        buffer[2] === 0x44 && // D
        buffer[3] === 0x46 && // F
        buffer[4] === 0x2d    // -
      );

    case 'image/jpeg':
      // JPEG standard SOI (Start of Image) marker: 0xFF, 0xD8, 0xFF
      return (
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
      );

    case 'image/png':
      // PNG standard magic bytes: 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
      return (
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 && // P
        buffer[2] === 0x4e && // N
        buffer[3] === 0x47 && // G
        buffer[4] === 0x0d && // \r
        buffer[5] === 0x0a && // \n
        buffer[6] === 0x1a && // EOF
        buffer[7] === 0x0a    // \n
      );

    default:
      return false;
  }
}

/**
 * Sanitizes an upload filename:
 * - Strips path traversal sequences (..)
 * - Strips directory separators (/ and \)
 * - Strips null bytes (\0)
 * - Strips CR, LF, and non-printable control characters
 * - Normalizes quotes and problematic punctuation
 * - Truncates excessively long base filenames
 * - Preserves verified extension and falls back safely if base is empty
 */
export function sanitizeUploadFilename(
  rawFilename: string,
  declaredMimeType: AllowedMimeType
): string {
  const allowedExts = ALLOWED_EXTENSIONS_BY_MIME[declaredMimeType];
  const defaultExt = allowedExts[0];

  let cleaned = (rawFilename || '').trim();

  // Strip null bytes, CR, LF, and control characters
  cleaned = cleaned.replace(/[\0\r\n\x00-\x1F\x7F]/g, '');

  // Strip path traversal sequences and separators
  cleaned = cleaned.replace(/\\/g, '/');
  const pathParts = cleaned.split('/');
  cleaned = pathParts[pathParts.length - 1].trim();
  cleaned = cleaned.replace(/\.\./g, '');

  // Strip forbidden filename characters: < > : " / \ | ? * ;
  cleaned = cleaned.replace(/[<>:"/\\|?*;]/g, '_');

  // Find extension
  const lastDotIndex = cleaned.lastIndexOf('.');
  let baseName = '';
  let ext = '';

  if (lastDotIndex > 0) {
    baseName = cleaned.substring(0, lastDotIndex).trim();
    ext = cleaned.substring(lastDotIndex).toLowerCase().trim();
  } else {
    baseName = cleaned;
    ext = defaultExt;
  }

  // Ensure extension is in the allowed list for this MIME type
  if (!allowedExts.includes(ext)) {
    ext = defaultExt;
  }

  // Clean base name: remove leading/trailing dots and spaces
  baseName = baseName.replace(/^\.+|\.+$/g, '').trim();

  // If base name became empty after stripping malicious chars, create safe fallback
  if (!baseName || baseName.length === 0) {
    baseName = `document_${Date.now()}`;
  }

  // Cap base name length to 100 characters to prevent buffer issues
  if (baseName.length > 100) {
    baseName = baseName.substring(0, 100).trim();
  }

  return `${baseName}${ext}`;
}

export interface ValidatedUploadFile {
  sanitizedFilename: string;
  mimeType: AllowedMimeType;
  buffer: Uint8Array;
  sizeBytes: number;
}

/**
 * Performs strict, multi-layer validation on an incoming uploaded file:
 * 1. Checks file presence
 * 2. Checks file size bounds (empty 0-byte or > 15 MB)
 * 3. Validates declared MIME type against whitelist
 * 4. Validates filename extension matches declared MIME type
 * 5. Sanitizes filename against path traversal and injection
 * 6. Inspects binary magic bytes to prevent MIME spoofing
 */
export async function validateUploadedFile(
  file: unknown
): Promise<ValidatedUploadFile> {
  if (!file || typeof file !== 'object') {
    throw new BadRequestError('Missing required file. A valid multipart file is required.');
  }

  // Standard File/Blob interface check
  const candidate = file as {
    name?: string;
    type?: string;
    size?: number;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };

  if (typeof candidate.arrayBuffer !== 'function') {
    throw new BadRequestError('Invalid file payload: not a valid multipart file stream.');
  }

  // Check file size
  const size = typeof candidate.size === 'number' ? candidate.size : 0;
  if (size === 0) {
    throw new BadRequestError('Uploaded file is empty (0 bytes).');
  }

  if (size > MAX_UPLOAD_FILE_SIZE_BYTES) {
    throw new BadRequestError(
      `File size (${(size / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowed limit of 15 MB.`
    );
  }

  // Check MIME type
  const rawMime = (candidate.type || '').toLowerCase().trim();
  if (!rawMime) {
    throw new BadRequestError('Missing file MIME type. Only PDF, JPEG, and PNG files are accepted.');
  }

  const normalizedMime = rawMime.split(';')[0].trim();
  if (!ALLOWED_MIME_TYPES.includes(normalizedMime as AllowedMimeType)) {
    throw new BadRequestError(
      `Unsupported file type '${normalizedMime}'. Only PDF (application/pdf), JPEG (image/jpeg), and PNG (image/png) are allowed.`
    );
  }

  const mimeType = normalizedMime as AllowedMimeType;
  const allowedExtensions = ALLOWED_EXTENSIONS_BY_MIME[mimeType];

  // Check original filename and extension
  const rawName = (candidate.name || '').trim();
  if (!rawName) {
    throw new BadRequestError('Uploaded file has no filename.');
  }

  const lowerRawName = rawName.toLowerCase();
  const lastDot = lowerRawName.lastIndexOf('.');
  if (lastDot === -1 || lastDot === lowerRawName.length - 1) {
    throw new BadRequestError(
      `Filename has no extension. Must have a valid extension matching '${mimeType}' (${allowedExtensions.join(', ')}).`
    );
  }

  const declaredExt = lowerRawName.substring(lastDot);
  if (!allowedExtensions.includes(declaredExt)) {
    throw new BadRequestError(
      `Filename extension '${declaredExt}' does not match declared MIME type '${mimeType}'. Expected one of: ${allowedExtensions.join(', ')}.`
    );
  }

  // Read binary data
  let arrayBuf: ArrayBuffer;
  try {
    arrayBuf = await candidate.arrayBuffer();
  } catch (err) {
    logger.error('Failed to read uploaded file array buffer:', err);
    throw new BadRequestError('Failed to read uploaded file data.');
  }

  const buffer = new Uint8Array(arrayBuf);
  if (buffer.length === 0) {
    throw new BadRequestError('Uploaded file content is empty (0 bytes).');
  }

  // Double check buffer length against size limit
  if (buffer.length > MAX_UPLOAD_FILE_SIZE_BYTES) {
    throw new BadRequestError(
      `File size (${(buffer.length / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowed limit of 15 MB.`
    );
  }

  // Magic bytes / Content signature verification
  const isValidSignature = validateFileSignature(buffer, mimeType);
  if (!isValidSignature) {
    logger.warn(
      `File signature validation failed for file '${rawName}' with declared MIME '${mimeType}'. Content header bytes do not match expected signature.`
    );
    throw new BadRequestError(
      `File content signature does not match declared MIME type '${mimeType}'. The file appears corrupted or spoofed.`
    );
  }

  // Sanitize filename
  const sanitizedFilename = sanitizeUploadFilename(rawName, mimeType);

  return {
    sanitizedFilename,
    mimeType,
    buffer,
    sizeBytes: buffer.length
  };
}

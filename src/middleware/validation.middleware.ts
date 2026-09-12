import { Request, Response, NextFunction } from 'express';
import { BadRequestError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Enforces Zero-Trust Client Identity:
 * The backend NEVER trusts a Firebase UID, PAN number, client ID, or Google Drive folder ID
 * supplied as normal request data (body, query, or path params).
 */
const FORBIDDEN_CLIENT_IDENTITY_KEYS = [
  'uid',
  'firebaseuid',
  'firebase_uid',
  'pannumber',
  'pan_number',
  'pan',
  'drivefolderid',
  'drive_folder_id',
  'folderid',
  'folder_id',
  'clientid',
  'client_id'
];

export function enforceZeroTrustIdentity(req: Request, res: Response, next: NextFunction): void {
  const checkSource = (source: Record<string, unknown> | undefined, sourceName: string) => {
    if (!source || typeof source !== 'object') return;

    for (const key of Object.keys(source)) {
      const normalized = key.toLowerCase().replace(/[-_]/g, '');
      if (FORBIDDEN_CLIENT_IDENTITY_KEYS.includes(normalized)) {
        logger.warn(
          `Security violation: Client attempted to supply forbidden identity field '${key}' in ${sourceName}`
        );
        throw new BadRequestError(
          `Security violation: Field '${key}' cannot be supplied by client request data. Identity, PAN, and Google Drive folder associations are strictly authoritative and derived by the server from verified Firebase tokens and Firestore records.`
        );
      }
    }
  };

  try {
    checkSource(req.body as Record<string, unknown>, 'body');
    checkSource(req.query as Record<string, unknown>, 'query');
    checkSource(req.params as Record<string, unknown>, 'params');

    // Check custom request headers for forbidden client identity fields
    if (req.headers && typeof req.headers === 'object') {
      for (const headerKey of Object.keys(req.headers)) {
        const normalized = headerKey.toLowerCase().replace(/^(x-)?/g, '').replace(/[-_]/g, '');
        if (FORBIDDEN_CLIENT_IDENTITY_KEYS.includes(normalized)) {
          logger.warn(
            `Security violation: Client attempted to supply forbidden identity header '${headerKey}'`
          );
          throw new BadRequestError(
            `Security violation: Header '${headerKey}' cannot be supplied by client. Identity and Google Drive folder associations are strictly authoritative and derived by the server.`
          );
        }
      }
    }

    next();
  } catch (error) {
    next(error);
  }
}

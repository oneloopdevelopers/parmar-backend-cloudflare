import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from 'jose';
import { UnauthorizedError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface VerifiedFirebaseToken {
  uid: string;
  email?: string;
  email_verified?: boolean;
  claims: Record<string, unknown>;
}

export const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

// Singleton remote JWKS set with internal caching handled by jose
let remoteJwks: JWTVerifyGetKey | null = null;

function getRemoteJwks(): JWTVerifyGetKey {
  if (!remoteJwks) {
    remoteJwks = createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));
  }
  return remoteJwks;
}

export interface TokenVerifierOptions {
  keyResolver?: JWTVerifyGetKey;
  projectId?: string;
}

/**
 * Cryptographically verifies a Firebase Authentication ID token.
 * 
 * Rules:
 * 1. Token must be signed with RS256 algorithm.
 * 2. Signature verified against Google's public JWKS.
 * 3. Issuer must be 'https://securetoken.google.com/<projectId>'.
 * 4. Audience must equal '<projectId>'.
 * 5. Subject ('sub') must be a non-empty string and represents the verified Firebase UID.
 * 6. Expiration time ('exp') must be in the future.
 * 7. Issued-at time ('iat') must be in the past.
 */
export async function verifyFirebaseIdToken(
  token: string,
  options?: TokenVerifierOptions
): Promise<VerifiedFirebaseToken> {
  if (!token || typeof token !== 'string' || !token.trim()) {
    throw new UnauthorizedError('Authentication required: Firebase ID token is missing or empty.');
  }

  const cleanToken = token.trim();
  const projectId = options?.projectId || 'document-portal-d2b6d';
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  const keyResolver = options?.keyResolver || getRemoteJwks();

  try {
    const { payload, protectedHeader } = await jwtVerify(cleanToken, keyResolver, {
      issuer: expectedIssuer,
      audience: projectId,
      algorithms: ['RS256'],
    });

    if (protectedHeader.alg !== 'RS256') {
      throw new UnauthorizedError(`Invalid token header: Expected algorithm RS256, got '${protectedHeader.alg}'.`);
    }

    const uid = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!uid) {
      throw new UnauthorizedError('Invalid Firebase ID token: missing or empty subject (UID).');
    }

    if (uid.length > 128) {
      throw new UnauthorizedError('Invalid Firebase ID token: subject (UID) exceeds maximum permitted length.');
    }

    const email = typeof payload.email === 'string' ? payload.email.trim() : undefined;
    const emailVerified = typeof payload.email_verified === 'boolean' ? payload.email_verified : undefined;

    return {
      uid,
      email,
      email_verified: emailVerified,
      claims: payload as Record<string, unknown>
    };
  } catch (error: unknown) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }

    const err = error as { code?: string; message?: string; name?: string };
    const errMsg = err.message || String(error);

    logger.warn(`Firebase ID token verification failed: ${errMsg}`);

    if (err.code === 'ERR_JWT_EXPIRED') {
      throw new UnauthorizedError(
        'Firebase ID token has expired. Please refresh the authentication token on the Android client.'
      );
    }

    if (err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      throw new UnauthorizedError(`Firebase ID token claim validation failed: ${errMsg}`);
    }

    if (err.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
      throw new UnauthorizedError('Firebase ID token signature verification failed.');
    }

    throw new UnauthorizedError(`Invalid Firebase ID token: ${errMsg}`);
  }
}

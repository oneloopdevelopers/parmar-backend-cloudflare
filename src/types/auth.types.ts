import type { Request } from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import type { UserProfile } from './user.types';

/**
 * Represents the cryptographically verified user identity extracted from Firebase ID Token
 */
export interface AuthenticatedUser {
  /** The verified Firebase Authentication User ID (UID) */
  uid: string;
  /** The user's email address from token claims */
  email?: string;
  /** Whether the email has been verified */
  emailVerified?: boolean;
  /** Complete decoded JWT claims from Firebase Auth */
  tokenClaims: DecodedIdToken;
}

/**
 * Express Request enhanced with authenticated user context and Firestore client profile.
 */
export interface AuthenticatedRequest extends Request {
  /** Populated by authenticateFirebaseUser middleware upon successful token verification */
  user?: AuthenticatedUser;
  /** Populated by authenticateFirebaseUser middleware with verified data from users/{firebaseUid} */
  clientProfile?: UserProfile;
}

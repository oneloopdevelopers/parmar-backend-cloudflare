import { getGoogleAccessToken } from './googleServiceAccountAuth';
import { BadRequestError, BadGatewayError, NotFoundError, ConflictError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface FirebaseAdminAuthUser {
  localId: string;
  email?: string;
  displayName?: string;
  phoneNumber?: string;
  disabled?: boolean;
}

export interface CreateAuthUserParams {
  email: string;
  password?: string;
  displayName?: string;
  phoneNumber?: string;
  disabled?: boolean;
}

export class FirebaseAuthRestService {
  /**
   * Creates a user in Firebase Authentication via Google Identity Toolkit REST API v1.
   * Endpoint: POST https://identitytoolkit.googleapis.com/v1/projects/{projectId}/accounts
   * Uses OAuth access token with https://www.googleapis.com/auth/identitytoolkit scope.
   */
  public async createUser(
    params: CreateAuthUserParams,
    options: {
      projectId: string;
      serviceAccountJson: string;
      customFetch?: typeof fetch;
    }
  ): Promise<{ uid: string; email?: string }> {
    const fetchImpl = options.customFetch || fetch;
    const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
      customFetch: options.customFetch,
      scopes: 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform'
    });

    const url = `https://identitytoolkit.googleapis.com/v1/projects/${options.projectId}/accounts`;

    const requestBody: Record<string, unknown> = {
      email: params.email.trim().toLowerCase(),
      emailVerified: false
    };

    if (params.password) {
      requestBody.password = params.password;
    }
    if (params.displayName) {
      requestBody.displayName = params.displayName.trim();
    }
    if (params.phoneNumber) {
      requestBody.phoneNumber = params.phoneNumber.trim();
    }
    if (typeof params.disabled === 'boolean') {
      requestBody.disableUser = params.disabled;
    }

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMsg = `IdentityToolkit API returned HTTP ${response.status}`;
        let errorCode = '';

        try {
          const parsed = JSON.parse(errorBody);
          if (parsed?.error?.message) {
            errorCode = parsed.error.message;
            errorMsg = parsed.error.message;
          }
        } catch {
          // ignore parse error
        }

        logger.error(`IdentityToolkit createUser failed: status=${response.status}, error=${errorMsg}`);

        if (errorCode.includes('EMAIL_EXISTS')) {
          throw new ConflictError('A user account with this email address already exists in Firebase Authentication.');
        }
        if (errorCode.includes('PHONE_NUMBER_EXISTS')) {
          throw new ConflictError('A user account with this phone number already exists in Firebase Authentication.');
        }
        if (errorCode.includes('INVALID_PASSWORD')) {
          throw new BadRequestError('Password is invalid. Firebase requires a password with at least 6 characters.');
        }
        if (errorCode.includes('INVALID_PHONE_NUMBER')) {
          throw new BadRequestError('Invalid phone number format. Phone number must be in E.164 format (e.g. +919876543210).');
        }

        throw new BadGatewayError(`Firebase Authentication user creation failed: ${errorMsg}`);
      }

      const data = (await response.json()) as { localId?: string; email?: string };
      if (!data || !data.localId) {
        throw new BadGatewayError('IdentityToolkit user creation returned missing localId (UID).');
      }

      return {
        uid: data.localId,
        email: data.email || params.email
      };
    } catch (err) {
      if (err instanceof BadRequestError || err instanceof ConflictError || err instanceof BadGatewayError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Unexpected error in FirebaseAuthRestService.createUser:', msg);
      throw new BadGatewayError(`Failed to create Firebase Authentication user: ${msg}`);
    }
  }

  /**
   * Deletes a user from Firebase Authentication via Google Identity Toolkit REST API v1.
   * Endpoint: POST https://identitytoolkit.googleapis.com/v1/projects/{projectId}/accounts:delete
   * Used during rollback or administrative cleanup.
   */
  public async deleteUser(
    uid: string,
    options: {
      projectId: string;
      serviceAccountJson: string;
      customFetch?: typeof fetch;
    }
  ): Promise<void> {
    if (!uid || !uid.trim()) return;

    const fetchImpl = options.customFetch || fetch;
    try {
      const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
        customFetch: options.customFetch,
        scopes: 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform'
      });

      const url = `https://identitytoolkit.googleapis.com/v1/projects/${options.projectId}/accounts:delete`;

      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          localId: uid.trim()
        })
      });

      if (!response.ok && response.status !== 404) {
        const errorText = await response.text();
        logger.warn(`IdentityToolkit deleteUser failed for UID ${uid}: status=${response.status}, error=${errorText}`);
      } else {
        logger.info(`Successfully rolled back / deleted Auth user: ${uid}`);
      }
    } catch (err) {
      logger.error(`Error deleting user ${uid} during rollback:`, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Looks up a user account in Firebase Authentication by email address.
   * Endpoint: POST https://identitytoolkit.googleapis.com/v1/projects/{projectId}/accounts:lookup
   */
  public async getUserByEmail(
    email: string,
    options: {
      projectId: string;
      serviceAccountJson: string;
      customFetch?: typeof fetch;
    }
  ): Promise<FirebaseAdminAuthUser | null> {
    if (!email || !email.trim()) return null;

    const fetchImpl = options.customFetch || fetch;
    try {
      const { accessToken } = await getGoogleAccessToken(options.serviceAccountJson, {
        customFetch: options.customFetch,
        scopes: 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform'
      });

      const url = `https://identitytoolkit.googleapis.com/v1/projects/${options.projectId}/accounts:lookup`;

      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          email: [email.trim().toLowerCase()]
        })
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as {
        users?: Array<{
          localId: string;
          email?: string;
          displayName?: string;
          phoneNumber?: string;
          disabled?: boolean;
        }>;
      };

      if (!data.users || data.users.length === 0) {
        return null;
      }

      const u = data.users[0];
      return {
        localId: u.localId,
        email: u.email,
        displayName: u.displayName,
        phoneNumber: u.phoneNumber,
        disabled: u.disabled
      };
    } catch (err) {
      logger.error(`Error looking up user by email ${email}:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  }
}

export const firebaseAuthRestService = new FirebaseAuthRestService();

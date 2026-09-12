import { userRepository } from '../repositories/user.repository';
import { UserModel } from '../models/user.model';
import { UserProfileResponse, UserProfile } from '../types';
import { NotFoundError, BadRequestError } from '../utils/errors';
import { logger } from '../utils/logger';

export class UserService {
  /**
   * Retrieves user profile strictly by the verified Firebase UID.
   */
  async getUserProfile(uid: string): Promise<UserProfileResponse> {
    logger.info(`UserService: Fetching profile for verified UID: ${uid}`);
    const rawProfile = await userRepository.findByUid(uid);

    if (!rawProfile) {
      throw new NotFoundError(
        `User profile not found in Firestore collection 'users/${uid}'. Please ensure the profile document is initialized.`
      );
    }

    const sanitized = UserModel.sanitizeProfile(uid, rawProfile);
    if (!sanitized) {
      throw new NotFoundError(`User profile could not be formatted for UID: ${uid}`);
    }

    return sanitized;
  }

  /**
   * Retrieves the client's verified Google Drive folder ID from Firestore.
   * Ensures the client can NEVER supply or override the folder ID.
   */
  async getVerifiedDriveFolderId(uid: string): Promise<string> {
    const rawProfile = await userRepository.findByUid(uid);
    if (!rawProfile) {
      throw new NotFoundError(`User record not found in Firestore users/${uid}`);
    }

    if (!rawProfile.driveFolderId || typeof rawProfile.driveFolderId !== 'string' || !rawProfile.driveFolderId.trim()) {
      throw new BadRequestError(
        `No Google Drive folder ID is configured in Firestore for this account (users/${uid}). Please contact the administrator.`
      );
    }

    return rawProfile.driveFolderId.trim();
  }

  /**
   * Get raw profile object
   */
  async getRawProfile(uid: string): Promise<UserProfile | null> {
    return userRepository.findByUid(uid);
  }
}

export const userService = new UserService();

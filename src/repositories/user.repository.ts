import { getFirestoreInstance } from '../config/firebaseAdmin';
import { UserProfile } from '../types';
import { logger } from '../utils/logger';

export class UserRepository {
  private collectionName = 'users';

  /**
   * Retrieves user profile from Firestore strictly using the authenticated Firebase UID.
   * Path: users/{firebaseUid}
   * Never accepts or trusts client-supplied UIDs or parameters.
   */
  async findByUid(uid: string): Promise<UserProfile | null> {
    if (!uid) {
      throw new Error('Authenticated UID is required to query user profile.');
    }

    try {
      const db = getFirestoreInstance();
      const docRef = db.collection(this.collectionName).doc(uid);
      const docSnap = await docRef.get();

      if (!docSnap.exists) {
        logger.info(`No user profile found in Firestore for UID: ${uid}`);
        return null;
      }

      const data = docSnap.data() as UserProfile;
      return data;
    } catch (error) {
      logger.error(`Error fetching user profile from Firestore for UID ${uid}:`, error);
      throw error;
    }
  }

  /**
   * Updates or sets user profile document in Firestore.
   */
  async saveProfile(uid: string, profileData: Partial<UserProfile>): Promise<void> {
    const db = getFirestoreInstance();
    const docRef = db.collection(this.collectionName).doc(uid);
    await docRef.set(
      {
        ...profileData,
        updatedAt: new Date().toISOString()
      },
      { merge: true }
    );
  }
}

export const userRepository = new UserRepository();

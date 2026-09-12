import { UserProfile, UserProfileResponse } from '../types';

export class UserModel {
  public static sanitizeProfile(uid: string, data: Partial<UserProfile> | null): UserProfileResponse | null {
    if (!data) return null;

    let createdAtStr: string | null = null;
    if (data.createdAt) {
      if (typeof data.createdAt === 'string') {
        createdAtStr = data.createdAt;
      } else if (typeof data.createdAt === 'object' && 'toDate' in (data.createdAt as { toDate: () => Date })) {
        createdAtStr = (data.createdAt as { toDate: () => Date }).toDate().toISOString();
      } else {
        createdAtStr = String(data.createdAt);
      }
    }

    let updatedAtStr: string | null = null;
    if (data.updatedAt) {
      if (typeof data.updatedAt === 'string') {
        updatedAtStr = data.updatedAt;
      } else if (typeof data.updatedAt === 'object' && 'toDate' in (data.updatedAt as { toDate: () => Date })) {
        updatedAtStr = (data.updatedAt as { toDate: () => Date }).toDate().toISOString();
      } else {
        updatedAtStr = String(data.updatedAt);
      }
    }

    return {
      uid,
      name: data.name || '',
      email: data.email || '',
      phone: data.phone || null,
      panNumber: data.panNumber || null,
      driveFolderId: data.driveFolderId || null,
      role: data.role || 'client',
      status: data.status || 'active',
      createdAt: createdAtStr,
      updatedAt: updatedAtStr
    };
  }
}

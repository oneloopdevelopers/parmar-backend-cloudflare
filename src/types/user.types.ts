export type ClientRole = 'client' | 'admin';
export type ClientStatus = 'active' | 'inactive';

export type UserRole = ClientRole | 'staff' | string;
export type UserStatus = ClientStatus | 'pending' | 'suspended' | string;

/**
 * Firestore Client Document stored in users/{firebaseUid}
 */
export interface ClientDocument {
  name: string;
  email: string;
  phone: string;
  panNumber: string;
  driveFolderId: string;
  role: ClientRole;
  status: ClientStatus;
  createdAt?: unknown;
  updatedAt?: unknown;
}

/**
 * Client Profile Response DTO returned to Android client.
 * Note: driveFolderId is strictly omitted because it is a private server-side authorization value.
 */
export interface ClientProfileResponse {
  name: string;
  email: string;
  phone: string;
  maskedPanNumber: string;
  panNumber: string;
  role: ClientRole;
  status: ClientStatus;
}

export interface UserProfile {
  name: string;
  email: string;
  phone?: string;
  panNumber?: string;
  driveFolderId?: string;
  role?: UserRole;
  status?: UserStatus;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface UserProfileResponse {
  uid: string;
  name: string;
  email: string;
  phone: string | null;
  panNumber: string | null;
  driveFolderId: string | null;
  role: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
}

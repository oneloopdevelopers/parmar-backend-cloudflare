export * from './firebaseAdmin';
import { 
  initializeFirebaseAdmin, 
  getFirebaseAdminStatus, 
  getAuthInstance, 
  getFirestoreInstance, 
  FirebaseAdminStatus 
} from './firebaseAdmin';

export type FirebaseInitStatus = FirebaseAdminStatus;

export function initializeFirebase() {
  const result = initializeFirebaseAdmin();
  return {
    auth: result.auth,
    db: result.db,
    status: result.status
  };
}

export function getFirebaseStatus(): FirebaseInitStatus {
  return getFirebaseAdminStatus();
}

export function getFirebaseAuth() {
  return getAuthInstance();
}

export function getFirestoreDb() {
  return getFirestoreInstance();
}

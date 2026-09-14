import { firebaseAuthRestService } from './firebaseAuthRestService';
import { firestoreRestService } from './firestoreRestService';
import { logger } from '../utils/logger';
import { AppError, ConflictError, BadGatewayError } from '../utils/errors';

export interface BootstrapAdminOptions {
  projectId: string;
  serviceAccountJson: string;
  password?: string;
  customFetch?: typeof fetch;
}

export interface BootstrapAdminResult {
  status: 'created' | 'already_exists' | 'attention_required';
  uid: string;
  email: string;
  message: string;
}

export const BOOTSTRAP_ADMIN_EMAIL = 'support@oneloop.co.in';
export const BOOTSTRAP_ADMIN_NAME = 'Administrator';

/**
 * Executes a one-time bootstrap operation to provision the initial Administrator account.
 * 
 * Rules:
 * 1. Checks if the account support@oneloop.co.in already exists in Firebase Auth.
 * 2. If already exists:
 *    - Check users/{existingUid} in Firestore.
 *    - If role === 'admin' and status === 'active', reports 'already_exists'.
 *    - If role is not admin, returns 'attention_required' and DOES NOT automatically elevate without review.
 * 3. If does not exist:
 *    - Creates Firebase Authentication account (displayName: 'Administrator', email: support@oneloop.co.in).
 *    - Creates Firestore document users/{UID} with:
 *      name: 'Administrator', email: 'support@oneloop.co.in', phone: '', role: 'admin', status: 'active'.
 *    - Password is NEVER stored or written to Firestore.
 *    - No driveFolderId or panNumber is created.
 *    - Rollback safety: If Firestore profile creation fails, the newly created Firebase Auth user is deleted.
 */
export async function bootstrapFirstAdmin(
  options: BootstrapAdminOptions
): Promise<BootstrapAdminResult> {
  const { projectId, serviceAccountJson, password, customFetch } = options;
  const adminEmail = BOOTSTRAP_ADMIN_EMAIL.toLowerCase();

  logger.info(`Bootstrap: Checking if admin account ${adminEmail} already exists...`);

  // Step 1: Check if user exists in Firebase Auth
  const existingAuthUser = await firebaseAuthRestService.getUserByEmail(adminEmail, {
    projectId,
    serviceAccountJson,
    customFetch
  });

  if (existingAuthUser) {
    const existingUid = existingAuthUser.localId;
    logger.info(`Bootstrap: Auth account already exists for ${adminEmail} with UID: ${existingUid}`);

    // Check existing Firestore profile
    const existingDoc = await firestoreRestService.getDocument('users', existingUid, {
      projectId,
      serviceAccountJson,
      customFetch
    });

    if (existingDoc && existingDoc.role === 'admin' && existingDoc.status === 'active') {
      logger.info(`Bootstrap: Administrator account already exists with active admin role for UID: ${existingUid}`);
      return {
        status: 'already_exists',
        uid: existingUid,
        email: adminEmail,
        message: 'Administrator account already exists in Firebase Authentication and Firestore with active admin role.'
      };
    }

    // Existing account has non-admin role or missing profile
    logger.warn(`Bootstrap: Existing account for ${adminEmail} (UID: ${existingUid}) has role='${existingDoc?.role}', status='${existingDoc?.status}'`);
    return {
      status: 'attention_required',
      uid: existingUid,
      email: adminEmail,
      message: `Account '${adminEmail}' already exists in Firebase Authentication (UID: ${existingUid}), but its Firestore profile does not have an active 'admin' role. Manual review is required.`
    };
  }

  // Step 2: User does not exist, require password for new creation
  if (!password || typeof password !== 'string' || password.length < 6) {
    throw new AppError(400, 'A secure password of at least 6 characters is required to bootstrap the administrator account.', 'INVALID_PASSWORD');
  }

  logger.info(`Bootstrap: Creating Firebase Authentication user for ${adminEmail}...`);
  let createdUid: string | null = null;

  try {
    const createdAuthUser = await firebaseAuthRestService.createUser(
      {
        email: adminEmail,
        displayName: BOOTSTRAP_ADMIN_NAME,
        password,
        disabled: false
      },
      {
        projectId,
        serviceAccountJson,
        customFetch
      }
    );

    createdUid = createdAuthUser.uid;
    logger.info(`Bootstrap: Firebase Authentication user created with UID: ${createdUid}`);

    // Step 3: Create Firestore profile users/{UID}
    const nowIso = new Date().toISOString();
    const adminFirestoreProfile = {
      name: BOOTSTRAP_ADMIN_NAME,
      email: adminEmail,
      phone: '',
      role: 'admin',
      status: 'active',
      createdAt: nowIso,
      updatedAt: nowIso
    };

    logger.info(`Bootstrap: Creating Firestore profile users/${createdUid}...`);
    await firestoreRestService.setDocument(
      'users',
      createdUid,
      adminFirestoreProfile,
      {
        projectId,
        serviceAccountJson,
        customFetch
      }
    );

    logger.info(`Bootstrap: Administrator account successfully created with UID: ${createdUid}`);

    return {
      status: 'created',
      uid: createdUid,
      email: adminEmail,
      message: 'Administrator account created successfully in Firebase Authentication and Firestore.'
    };
  } catch (err) {
    logger.error(`Bootstrap: Failed to complete admin provisioning. Error:`, err instanceof Error ? err.message : String(err));

    // Rollback: If Firebase Auth account was created by THIS bootstrap operation, delete it
    if (createdUid) {
      logger.info(`Bootstrap: Initiating rollback to delete newly created Auth user ${createdUid}...`);
      try {
        await firebaseAuthRestService.deleteUser(createdUid, {
          projectId,
          serviceAccountJson,
          customFetch
        });
        logger.info(`Bootstrap: Rollback complete. Auth user ${createdUid} deleted.`);
      } catch (rbErr) {
        logger.error(`Bootstrap: Rollback failed for Auth user ${createdUid}:`, rbErr);
      }
    }

    throw err;
  }
}

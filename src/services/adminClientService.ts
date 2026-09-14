import { firestoreRestService } from './firestoreRestService';
import { googleDriveRestService, DriveRestOptions } from './googleDriveRestService';
import { firebaseAuthRestService } from './firebaseAuthRestService';
import { ValidatedClientInput } from '../utils/adminValidation';
import { AdminClientItem, CreateClientResponse } from '../types/admin.types';
import { ConflictError, BadGatewayError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface AdminClientServiceContext {
  projectId: string;
  serviceAccountJson: string;
  driveAuthOptions: DriveRestOptions;
  customFetch?: typeof fetch;
}

export class AdminClientService {
  /**
   * Lists all clients from Firestore users collection.
   * Returns sanitized client list without internal service-account or OAuth secrets.
   */
  public async listClients(ctx: AdminClientServiceContext): Promise<AdminClientItem[]> {
    const { documents } = await firestoreRestService.listDocuments('users', {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      pageSize: 300,
      customFetch: ctx.customFetch
    });

    const clients: AdminClientItem[] = [];

    for (const doc of documents) {
      const data = doc.data;
      // Exclude admin profiles from clients list or filter if role is client
      const role = data.role === 'admin' ? 'admin' : 'client';
      if (role === 'admin') {
        continue;
      }

      clients.push({
        uid: doc.id,
        name: typeof data.name === 'string' ? data.name : '',
        email: typeof data.email === 'string' ? data.email : '',
        phone: typeof data.phone === 'string' ? data.phone : '',
        panNumber: typeof data.panNumber === 'string' ? data.panNumber : '',
        role: 'client',
        status: data.status === 'inactive' ? 'inactive' : 'active',
        driveFolderId: typeof data.driveFolderId === 'string' ? data.driveFolderId : undefined,
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null
      });
    }

    // Sort clients by createdAt descending (newest first) or by name
    clients.sort((a, b) => {
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return timeB - timeA;
    });

    return clients;
  }

  /**
   * Provisions a brand new client with full transactional rollback safety:
   * 1. Check & Reserve PAN uniqueness in panIndex/{PAN}
   * 2. Create Firebase Auth user
   * 3. Create Google Drive folder structure: Client Documents/{PAN}/ and {PAN}/upload/
   * 4. Create Firestore profile users/{uid}
   * 5. Update panIndex/{PAN} with final uid & driveFolderId
   *
   * On ANY step failure, automatically rolls back created resources in reverse order.
   */
  public async createClient(
    input: ValidatedClientInput,
    ctx: AdminClientServiceContext
  ): Promise<CreateClientResponse> {
    const normalizedPan = input.panNumber.trim().toUpperCase();
    logger.info(`AdminClientService: Beginning provisioning for PAN ${normalizedPan} (${input.email})`);

    // Step 1: Check PAN Uniqueness via panIndex/{PAN}
    const existingPanIndex = await firestoreRestService.getDocument('panIndex', normalizedPan, {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      customFetch: ctx.customFetch
    });

    if (existingPanIndex && existingPanIndex.uid) {
      logger.warn(`AdminClientService: PAN ${normalizedPan} is already registered to UID ${existingPanIndex.uid}`);
      throw new ConflictError(`A client with PAN '${normalizedPan}' is already registered in the system.`);
    }

    // Temporary reservation marker to prevent concurrent duplicate PAN creation
    const reservationTimestamp = new Date().toISOString();
    let panReserved = false;
    let authUid: string | null = null;
    let panFolderId: string | null = null;
    let uploadFolderId: string | null = null;
    let firestoreCreated = false;

    try {
      // Step 1b: Reserve PAN index document
      await firestoreRestService.setDocument(
        'panIndex',
        normalizedPan,
        {
          panNumber: normalizedPan,
          status: 'reserved',
          createdAt: reservationTimestamp
        },
        {
          projectId: ctx.projectId,
          serviceAccountJson: ctx.serviceAccountJson,
          customFetch: ctx.customFetch
        }
      );
      panReserved = true;

      // Step 2: Create Firebase Authentication User
      logger.info(`AdminClientService: Creating Firebase Auth user for ${input.email}`);
      const authUser = await firebaseAuthRestService.createUser(
        {
          email: input.email,
          password: input.password,
          displayName: input.name,
          phoneNumber: input.phone,
          disabled: input.status === 'inactive'
        },
        {
          projectId: ctx.projectId,
          serviceAccountJson: ctx.serviceAccountJson,
          customFetch: ctx.customFetch
        }
      );
      authUid = authUser.uid;
      logger.info(`AdminClientService: Auth user created with UID: ${authUid}`);

      // Step 3: Provision Google Drive folders
      // 3a. Resolve or create root 'Client Documents' folder
      const rootFolderId = await googleDriveRestService.getOrCreateClientDocumentsRoot(
        ctx.driveAuthOptions
      );

      // 3b. Create PAN folder under 'Client Documents'
      logger.info(`AdminClientService: Creating PAN folder '${normalizedPan}' under root '${rootFolderId}'`);
      const panFolder = await googleDriveRestService.createFolder(
        normalizedPan,
        ctx.driveAuthOptions,
        rootFolderId
      );
      panFolderId = panFolder.id;

      // 3c. Create 'upload' subfolder under PAN folder
      logger.info(`AdminClientService: Creating 'upload' subfolder under PAN folder '${panFolderId}'`);
      const uploadFolder = await googleDriveRestService.createFolder(
        'upload',
        ctx.driveAuthOptions,
        panFolderId
      );
      uploadFolderId = uploadFolder.id;

      // Step 4: Create Firestore profile users/{uid}
      const nowIso = new Date().toISOString();
      const firestoreClientDoc = {
        name: input.name,
        email: input.email,
        phone: input.phone,
        panNumber: normalizedPan,
        driveFolderId: panFolderId,
        role: 'client' as const, // Strict non-admin role
        status: input.status,
        createdAt: nowIso,
        updatedAt: nowIso
      };

      logger.info(`AdminClientService: Creating Firestore profile users/${authUid}`);
      await firestoreRestService.setDocument(
        'users',
        authUid,
        firestoreClientDoc,
        {
          projectId: ctx.projectId,
          serviceAccountJson: ctx.serviceAccountJson,
          customFetch: ctx.customFetch
        }
      );
      firestoreCreated = true;

      // Step 5: Finalize panIndex/{PAN} with authoritative client UID and driveFolderId
      await firestoreRestService.setDocument(
        'panIndex',
        normalizedPan,
        {
          panNumber: normalizedPan,
          uid: authUid,
          driveFolderId: panFolderId,
          status: 'active',
          updatedAt: nowIso
        },
        {
          projectId: ctx.projectId,
          serviceAccountJson: ctx.serviceAccountJson,
          customFetch: ctx.customFetch
        }
      );

      logger.info(`AdminClientService: Successfully provisioned client ${authUid} for PAN ${normalizedPan}`);

      return {
        uid: authUid,
        name: input.name,
        email: input.email,
        phone: input.phone,
        panNumber: normalizedPan,
        role: 'client',
        status: input.status,
        driveFolderId: panFolderId,
        panUploadFolderId: uploadFolderId,
        createdAt: nowIso,
        updatedAt: nowIso
      };
    } catch (err) {
      logger.error(
        `AdminClientService: Provisioning failed for PAN ${normalizedPan}. Executing rollback... Error:`,
        err instanceof Error ? err.message : String(err)
      );

      // Rollback Step A: Delete Firestore users/{uid}
      if (firestoreCreated && authUid) {
        try {
          await firestoreRestService.deleteDocument('users', authUid, {
            projectId: ctx.projectId,
            serviceAccountJson: ctx.serviceAccountJson,
            customFetch: ctx.customFetch
          });
        } catch (rbErr) {
          logger.error('Rollback users collection failed:', rbErr);
        }
      }

      // Rollback Step B: Delete Drive folders (uploadFolder first, then panFolder)
      if (uploadFolderId) {
        try {
          await googleDriveRestService.deleteFile(uploadFolderId, ctx.driveAuthOptions);
        } catch (rbErr) {
          logger.error('Rollback uploadFolder failed:', rbErr);
        }
      }
      if (panFolderId) {
        try {
          await googleDriveRestService.deleteFile(panFolderId, ctx.driveAuthOptions);
        } catch (rbErr) {
          logger.error('Rollback panFolder failed:', rbErr);
        }
      }

      // Rollback Step C: Delete Firebase Auth user
      if (authUid) {
        try {
          await firebaseAuthRestService.deleteUser(authUid, {
            projectId: ctx.projectId,
            serviceAccountJson: ctx.serviceAccountJson,
            customFetch: ctx.customFetch
          });
        } catch (rbErr) {
          logger.error('Rollback auth user failed:', rbErr);
        }
      }

      // Rollback Step D: Release PAN reservation
      if (panReserved) {
        try {
          await firestoreRestService.deleteDocument('panIndex', normalizedPan, {
            projectId: ctx.projectId,
            serviceAccountJson: ctx.serviceAccountJson,
            customFetch: ctx.customFetch
          });
        } catch (rbErr) {
          logger.error('Rollback panIndex reservation failed:', rbErr);
        }
      }

      throw err;
    }
  }
}

export const adminClientService = new AdminClientService();

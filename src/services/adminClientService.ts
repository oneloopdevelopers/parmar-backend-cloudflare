import { firestoreRestService } from './firestoreRestService';
import { googleDriveRestService, DriveRestOptions } from './googleDriveRestService';
import { firebaseAuthRestService } from './firebaseAuthRestService';
import { ValidatedClientInput } from '../utils/adminValidation';
import {
  AdminClientItem,
  CreateClientResponse,
  AdminClientDocumentItem,
  AdminClientUploadFolderInfo,
  AdminClientDocumentsResponse
} from '../types/admin.types';
import { DriveFileDetails } from '../types';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ForbiddenError,
  BadGatewayError
} from '../utils/errors';
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

  /**
   * Helper: Validates that the target clientId exists in Firestore, has role === 'client',
   * is active, and possesses an authoritative driveFolderId.
   */
  public async getAuthoritativeClientProfile(
    clientId: string,
    ctx: AdminClientServiceContext
  ): Promise<{ clientUid: string; clientName: string; panNumber: string; driveFolderId: string }> {
    if (!clientId || typeof clientId !== 'string' || !clientId.trim()) {
      throw new BadRequestError('A valid client UID is required.');
    }

    const cleanClientId = clientId.trim();

    const userDoc = await firestoreRestService.getDocument('users', cleanClientId, {
      projectId: ctx.projectId,
      serviceAccountJson: ctx.serviceAccountJson,
      customFetch: ctx.customFetch
    });

    if (!userDoc) {
      logger.warn(`AdminClientService: Client profile not found for UID '${cleanClientId}'`);
      throw new NotFoundError(`Client with UID '${cleanClientId}' not found.`);
    }

    // Role check: Target must be a client (reject admin profiles)
    if (userDoc.role !== 'client') {
      logger.warn(`AdminClientService: User '${cleanClientId}' has non-client role '${userDoc.role}'`);
      throw new BadRequestError(`Target user '${cleanClientId}' is not a client.`);
    }

    // Status check: Client must be active
    if (userDoc.status !== 'active') {
      logger.warn(`AdminClientService: Client '${cleanClientId}' is not active (status: '${userDoc.status}')`);
      throw new ForbiddenError(`Client '${cleanClientId}' is inactive.`);
    }

    const driveFolderId = userDoc.driveFolderId;
    if (!driveFolderId || typeof driveFolderId !== 'string' || !driveFolderId.trim()) {
      logger.warn(`AdminClientService: Client '${cleanClientId}' does not have a configured driveFolderId`);
      throw new BadRequestError(`Client '${cleanClientId}' does not have an associated Google Drive folder.`);
    }

    const clientName = typeof userDoc.name === 'string' && userDoc.name.trim() ? userDoc.name.trim() : 'Client';
    const panNumber = typeof userDoc.panNumber === 'string' ? userDoc.panNumber.trim().toUpperCase() : '';

    return {
      clientUid: cleanClientId,
      clientName,
      panNumber,
      driveFolderId: driveFolderId.trim()
    };
  }

  /**
   * Lists the complete document repository for the selected client:
   * 1. Files directly inside the authoritative PAN folder (folderType: 'pan_root', uploaderType: 'administrator')
   * 2. The direct-child 'upload' folder itself (safe metadata)
   * 3. Files directly inside the 'upload' subfolder (folderType: 'upload_folder', uploaderType: 'client')
   */
  public async getClientDocumentRepository(
    clientId: string,
    ctx: AdminClientServiceContext
  ): Promise<AdminClientDocumentsResponse> {
    const client = await this.getAuthoritativeClientProfile(clientId, ctx);
    const panFolderId = client.driveFolderId;

    logger.info(`AdminClientService: Listing document repository for client UID ${client.clientUid} (PAN folder: ${panFolderId})`);

    // 1. List files directly inside the PAN folder
    const panFiles = await googleDriveRestService.listFilesInFolder(panFolderId, ctx.driveAuthOptions);

    // 2. Search for direct-child 'upload' folder (do NOT create if missing during list)
    const uploadFolderId = await googleDriveRestService.getClientUploadFolderId(
      panFolderId,
      ctx.driveAuthOptions,
      false
    );

    let uploadFolderInfo: AdminClientUploadFolderInfo | null = null;
    let uploadFiles: any[] = [];

    if (uploadFolderId) {
      uploadFolderInfo = {
        id: uploadFolderId,
        name: 'upload',
        mimeType: 'application/vnd.google-apps.folder',
        folderType: 'upload_folder'
      };

      try {
        uploadFiles = await googleDriveRestService.listFilesInFolder(uploadFolderId, ctx.driveAuthOptions);
      } catch (err) {
        logger.warn(`AdminClientService: Failed to list upload folder for client ${clientId}:`, err);
      }
    }

    const documents: AdminClientDocumentItem[] = [];
    const seenIds = new Set<string>();

    // Process files directly in PAN folder
    for (const f of panFiles) {
      if (!f || !f.id) continue;

      // Skip shortcuts, Google Docs/Sheets internal types, and skip the 'upload' folder itself from files
      if (
        f.mimeType === 'application/vnd.google-apps.shortcut' ||
        f.mimeType.startsWith('application/vnd.google-apps.')
      ) {
        // If it's a folder, do not treat as downloadable file
        continue;
      }

      if (!seenIds.has(f.id)) {
        seenIds.add(f.id);
        documents.push({
          documentId: f.id,
          name: f.name || 'Untitled',
          mimeType: f.mimeType || 'application/octet-stream',
          size: f.size || '0',
          createdTime: f.createdTime || '',
          modifiedTime: f.modifiedTime || '',
          folderType: 'pan_root',
          uploaderType: 'administrator',
          uploaderName: 'Administrator'
        });
      }
    }

    // Process files inside 'upload' folder
    for (const f of uploadFiles) {
      if (!f || !f.id) continue;

      if (
        f.mimeType === 'application/vnd.google-apps.folder' ||
        f.mimeType === 'application/vnd.google-apps.shortcut' ||
        f.mimeType.startsWith('application/vnd.google-apps.')
      ) {
        continue;
      }

      if (!seenIds.has(f.id)) {
        seenIds.add(f.id);
        documents.push({
          documentId: f.id,
          name: f.name || 'Untitled',
          mimeType: f.mimeType || 'application/octet-stream',
          size: f.size || '0',
          createdTime: f.createdTime || '',
          modifiedTime: f.modifiedTime || '',
          folderType: 'upload_folder',
          uploaderType: 'client',
          uploaderName: client.clientName
        });
      }
    }

    return {
      clientId: client.clientUid,
      panFolderId,
      uploadFolder: uploadFolderInfo,
      documents,
      total: documents.length
    };
  }

  /**
   * Verifies that the requested documentId belongs to the selected client's authorized repository.
   * Returns the verified file metadata and folderType ('pan_root' or 'upload_folder').
   * Throws NotFoundError if document is outside the client repository, trashed, shortcut, or folder.
   */
  public async verifyClientDocumentAccess(
    clientId: string,
    documentId: string,
    ctx: AdminClientServiceContext
  ): Promise<{ fileMetadata: DriveFileDetails; folderType: 'pan_root' | 'upload_folder' }> {
    const client = await this.getAuthoritativeClientProfile(clientId, ctx);
    const authoritativePanFolderId = client.driveFolderId;

    // Retrieve file metadata from Google Drive
    let fileMetadata: DriveFileDetails;
    try {
      fileMetadata = await googleDriveRestService.getFileMetadata(documentId, ctx.driveAuthOptions);
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError('Document not found or inaccessible in the client repository.');
      }
      throw err;
    }

    // 1. Verify file ID match
    if (fileMetadata.id !== documentId) {
      throw new NotFoundError('Document not found or inaccessible in the client repository.');
    }

    // 2. Reject trashed files
    if (fileMetadata.trashed) {
      logger.warn(`AdminClientService: Document ${documentId} is trashed.`);
      throw new NotFoundError('Document not found or inaccessible in the client repository.');
    }

    // 3. Reject folders, shortcuts, and Google internal types
    if (
      fileMetadata.mimeType === 'application/vnd.google-apps.folder' ||
      fileMetadata.mimeType === 'application/vnd.google-apps.shortcut' ||
      fileMetadata.mimeType.startsWith('application/vnd.google-apps.')
    ) {
      logger.warn(`AdminClientService: Unsupported mimeType '${fileMetadata.mimeType}' for document ${documentId}`);
      throw new NotFoundError('Document not found or inaccessible in the client repository.');
    }

    // 4. Strict parent containment check
    const parents = fileMetadata.parents || [];

    // Check Case A: File is directly inside client's PAN folder
    if (parents.includes(authoritativePanFolderId)) {
      return {
        fileMetadata,
        folderType: 'pan_root'
      };
    }

    // Check Case B: File is directly inside client's upload folder
    const uploadFolderId = await googleDriveRestService.getClientUploadFolderId(
      authoritativePanFolderId,
      ctx.driveAuthOptions,
      false
    );

    if (uploadFolderId && parents.includes(uploadFolderId)) {
      return {
        fileMetadata,
        folderType: 'upload_folder'
      };
    }

    // If file parents do not include PAN folder nor upload folder -> CROSS-CLIENT OR ARBITRARY DRIVE FILE
    logger.warn(
      `IDOR Prevention: File ${documentId} does not belong to client ${clientId} repository ` +
      `(PAN: ${authoritativePanFolderId}, Upload: ${uploadFolderId || 'none'}, actual parents: ${JSON.stringify(parents)})`
    );
    throw new NotFoundError('Document not found or inaccessible in the client repository.');
  }
}

export const adminClientService = new AdminClientService();

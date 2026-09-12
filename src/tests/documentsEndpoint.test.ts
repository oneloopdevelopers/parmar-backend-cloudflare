import assert from 'node:assert';
import { createListDocumentsController } from '../controllers/document.controller';
import { enforceZeroTrustIdentity } from '../middleware/validation.middleware';
import { AuthenticatedRequest, DriveFileSafeMetadata } from '../types';
import { AppError, BadGatewayError } from '../utils/errors';

// Helper mock Firestore builder
function createMockFirestore(documents: Record<string, any>) {
  return {
    collection: (colName: string) => {
      assert.strictEqual(colName, 'users');
      return {
        doc: (docId: string) => ({
          get: async () => {
            const docData = documents[docId];
            if (!docData) {
              return { exists: false, data: () => null };
            }
            return { exists: true, data: () => docData };
          }
        })
      };
    }
  };
}

// Helper mock Drive service builder
function createMockDriveService(
  folderFilesMap: Record<string, DriveFileSafeMetadata[]>,
  options?: { shouldFail?: boolean; errorMessage?: string }
) {
  return {
    listFilesInFolder: async (folderId: string, _maxPages?: number): Promise<DriveFileSafeMetadata[]> => {
      if (options?.shouldFail) {
        throw new BadGatewayError(options.errorMessage || 'Simulated Google Drive upstream failure');
      }
      return folderFilesMap[folderId] || [];
    }
  };
}

// Helper mock Express Response builder
function createMockResponse() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    }
  };
  return res;
}

async function runDocumentsEndpointTests() {
  console.log('\n--- Starting Tests for GET /api/documents & Document Controller ---');
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ FAIL: ${name}`);
      console.error(err);
      failed++;
    }
  }

  const sampleFiles: DriveFileSafeMetadata[] = [
    {
      id: 'drive_file_001',
      name: 'UDYAM-ONELOOP.pdf',
      mimeType: 'application/pdf',
      size: '201728',
      createdTime: '2026-09-10T12:00:00.000Z',
      modifiedTime: '2026-09-10T12:30:00.000Z'
    },
    {
      id: 'drive_file_002',
      name: 'GST_RETURN_Q1.pdf',
      mimeType: 'application/pdf',
      size: '512000',
      createdTime: '2026-09-11T09:00:00.000Z',
      modifiedTime: '2026-09-11T09:15:00.000Z'
    }
  ];

  const mockUsers: Record<string, any> = {
    active_client_1: {
      name: 'Rajesh Sharma',
      email: 'rajesh@example.com',
      status: 'active',
      driveFolderId: 'folder_client_active_123',
      role: 'client'
    },
    active_empty_folder_client: {
      name: 'Empty Folder Client',
      email: 'empty@example.com',
      status: 'active',
      driveFolderId: 'empty_folder_456',
      role: 'client'
    },
    inactive_client: {
      name: 'Inactive User',
      email: 'inactive@example.com',
      status: 'inactive',
      driveFolderId: 'folder_inactive_789',
      role: 'client'
    },
    suspended_client: {
      name: 'Suspended User',
      email: 'suspended@example.com',
      status: 'suspended',
      driveFolderId: 'folder_suspended_999',
      role: 'client'
    },
    client_missing_folder: {
      name: 'No Folder User',
      email: 'nofolder@example.com',
      status: 'active',
      driveFolderId: '',
      role: 'client'
    },
    client_null_folder: {
      name: 'Null Folder User',
      email: 'nullfolder@example.com',
      status: 'active',
      driveFolderId: null,
      role: 'client'
    },
    failing_drive_client: {
      name: 'Drive Error User',
      email: 'driveerror@example.com',
      status: 'active',
      driveFolderId: 'folder_failing_drive',
      role: 'client'
    }
  };

  const mockFolderFiles: Record<string, DriveFileSafeMetadata[]> = {
    folder_client_active_123: sampleFiles,
    empty_folder_456: []
  };

  const mockDb = createMockFirestore(mockUsers);
  const mockDrive = createMockDriveService(mockFolderFiles);
  const mockFailingDrive = createMockDriveService(mockFolderFiles, {
    shouldFail: true,
    errorMessage: 'Upstream Google Drive 500 error'
  });

  const listDocumentsController = createListDocumentsController({
    getDb: () => mockDb,
    driveService: mockDrive
  });

  const failingDocumentsController = createListDocumentsController({
    getDb: () => mockDb,
    driveService: mockFailingDrive
  });

  // TEST 1: Rejects missing verified UID (401 Unauthorized)
  await test('1. listDocuments rejects request when verified Firebase UID is missing (401)', async () => {
    const req = { user: undefined } as any;
    const res = createMockResponse();
    let error: any = null;
    await listDocumentsController(req, res, (err) => { error = err; });

    assert(error instanceof AppError, 'Expected AppError');
    assert.strictEqual(error.statusCode, 401);
    assert.strictEqual(error.code, 'UNAUTHORIZED');
  });

  // TEST 2: Rejects empty or whitespace-only UID (401 Unauthorized)
  await test('2. listDocuments rejects empty or whitespace-only UID (401)', async () => {
    const req = { user: { uid: '   ' } } as any;
    const res = createMockResponse();
    let error: any = null;
    await listDocumentsController(req, res, (err) => { error = err; });

    assert(error instanceof AppError, 'Expected AppError');
    assert.strictEqual(error.statusCode, 401);
  });

  // TEST 3: Rejects when Firestore profile users/{uid} does not exist (404 Not Found)
  await test('3. listDocuments rejects request when Firestore profile does not exist (404)', async () => {
    const req = { user: { uid: 'non_existent_uid' } } as any;
    const res = createMockResponse();
    let error: any = null;
    await listDocumentsController(req, res, (err) => { error = err; });

    assert(error instanceof AppError, 'Expected AppError');
    assert.strictEqual(error.statusCode, 404);
    assert.strictEqual(error.code, 'NOT_FOUND');
    assert(error.message.includes('Firestore user profile does not exist'));
  });

  // TEST 4: Rejects inactive user (403 Forbidden)
  await test('4. listDocuments rejects request when user status is inactive (403)', async () => {
    const req = { user: { uid: 'inactive_client' } } as any;
    const res = createMockResponse();
    let error: any = null;
    await listDocumentsController(req, res, (err) => { error = err; });

    assert(error instanceof AppError, 'Expected AppError');
    assert.strictEqual(error.statusCode, 403);
    assert.strictEqual(error.code, 'FORBIDDEN');
    assert(error.message.includes('User is inactive'));
  });

  // TEST 5: Rejects suspended user (403 Forbidden)
  await test('5. listDocuments rejects request when user status is suspended (403)', async () => {
    const req = { user: { uid: 'suspended_client' } } as any;
    const res = createMockResponse();
    let error: any = null;
    await listDocumentsController(req, res, (err) => { error = err; });

    assert(error instanceof AppError, 'Expected AppError');
    assert.strictEqual(error.statusCode, 403);
    assert.strictEqual(error.code, 'FORBIDDEN');
  });

  // TEST 6: Rejects missing driveFolderId in Firestore document (400 Bad Request)
  await test('6. listDocuments rejects request when driveFolderId is empty string (400)', async () => {
    const req = { user: { uid: 'client_missing_folder' } } as any;
    const res = createMockResponse();
    let error: any = null;
    await listDocumentsController(req, res, (err) => { error = err; });

    assert(error instanceof AppError, 'Expected AppError');
    assert.strictEqual(error.statusCode, 400);
    assert.strictEqual(error.code, 'BAD_REQUEST');
    assert(error.message.includes('driveFolderId is missing'));
  });

  // TEST 7: Rejects null driveFolderId in Firestore document (400 Bad Request)
  await test('7. listDocuments rejects request when driveFolderId is null (400)', async () => {
    const req = { user: { uid: 'client_null_folder' } } as any;
    const res = createMockResponse();
    let error: any = null;
    await listDocumentsController(req, res, (err) => { error = err; });

    assert(error instanceof AppError, 'Expected AppError');
    assert.strictEqual(error.statusCode, 400);
    assert.strictEqual(error.code, 'BAD_REQUEST');
  });

  // TEST 8: Zero-trust middleware rejects client-supplied driveFolderId in query params
  await test('8. enforceZeroTrustIdentity rejects client-supplied driveFolderId in query (400)', async () => {
    const req = {
      body: {},
      query: { driveFolderId: 'attacker_folder_id' },
      params: {},
      headers: {}
    } as any;
    let error: any = null;
    enforceZeroTrustIdentity(req, {} as any, (err) => { error = err; });

    assert(error instanceof AppError, 'Expected AppError');
    assert.strictEqual(error.statusCode, 400);
    assert(error.message.includes('Security violation'));
  });

  // TEST 9: Zero-trust middleware rejects client-supplied drive_folder_id in request body
  await test('9. enforceZeroTrustIdentity rejects client-supplied drive_folder_id in body (400)', async () => {
    const req = {
      body: { drive_folder_id: 'attacker_folder_id' },
      query: {},
      params: {},
      headers: {}
    } as any;
    let error: any = null;
    enforceZeroTrustIdentity(req, {} as any, (err) => { error = err; });

    assert(error instanceof AppError, 'Expected AppError');
    assert.strictEqual(error.statusCode, 400);
    assert(error.message.includes('Security violation'));
  });

  // TEST 10: Zero-trust middleware rejects client-supplied x-drive-folder-id header
  await test('10. enforceZeroTrustIdentity rejects client-supplied x-drive-folder-id in header (400)', async () => {
    const req = {
      body: {},
      query: {},
      params: {},
      headers: { 'x-drive-folder-id': 'attacker_folder_id' }
    } as any;
    let error: any = null;
    enforceZeroTrustIdentity(req, {} as any, (err) => { error = err; });

    assert(error instanceof AppError, 'Expected AppError');
    assert.strictEqual(error.statusCode, 400);
    assert(error.message.includes('Security violation'));
  });

  // TEST 11: Zero-trust middleware rejects client-supplied UID in query
  await test('11. enforceZeroTrustIdentity rejects client-supplied uid in query params (400)', async () => {
    const req = {
      body: {},
      query: { uid: 'attacker_uid' },
      params: {},
      headers: {}
    } as any;
    let error: any = null;
    enforceZeroTrustIdentity(req, {} as any, (err) => { error = err; });

    assert(error instanceof AppError, 'Expected AppError');
    assert.strictEqual(error.statusCode, 400);
  });

  // TEST 12: Zero-trust middleware rejects client-supplied PAN in body or query
  await test('12. enforceZeroTrustIdentity rejects client-supplied pan in query (400)', async () => {
    const req = {
      body: {},
      query: { panNumber: 'ABCDE1234F' },
      params: {},
      headers: {}
    } as any;
    let error: any = null;
    enforceZeroTrustIdentity(req, {} as any, (err) => { error = err; });

    assert(error instanceof AppError, 'Expected AppError');
    assert.strictEqual(error.statusCode, 400);
  });

  // TEST 13: Successful document listing for active user with documents
  await test('13. listDocuments successfully returns documents array for active client (200)', async () => {
    const req = { user: { uid: 'active_client_1' } } as any;
    const res = createMockResponse();
    let nextCalled = false;
    await listDocumentsController(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false, 'next() should not be called on success');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert(Array.isArray(res.body.documents), 'Response must contain documents array');
    assert.strictEqual(res.body.documents.length, 2);

    const doc0 = res.body.documents[0];
    assert.strictEqual(doc0.id, 'drive_file_001');
    assert.strictEqual(doc0.name, 'UDYAM-ONELOOP.pdf');
    assert.strictEqual(doc0.mimeType, 'application/pdf');
    assert.strictEqual(doc0.size, '201728');
    assert.strictEqual(doc0.createdTime, '2026-09-10T12:00:00.000Z');
    assert.strictEqual(doc0.modifiedTime, '2026-09-10T12:30:00.000Z');
  });

  // TEST 14: Successful listing for empty Drive folder returns { success: true, documents: [] }
  await test('14. listDocuments returns empty array for user with empty folder (200)', async () => {
    const req = { user: { uid: 'active_empty_folder_client' } } as any;
    const res = createMockResponse();
    let nextCalled = false;
    await listDocumentsController(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert(Array.isArray(res.body.documents));
    assert.strictEqual(res.body.documents.length, 0);
  });

  // TEST 15: Upstream Google Drive API failure returns 502 Bad Gateway
  await test('15. listDocuments maps upstream Google Drive error to 502 Bad Gateway', async () => {
    const req = { user: { uid: 'failing_drive_client' } } as any;
    const res = createMockResponse();
    let error: any = null;
    await failingDocumentsController(req, res, (err) => { error = err; });

    assert(error instanceof AppError, 'Expected AppError');
    assert.strictEqual(error.statusCode, 502);
    assert.strictEqual(error.code, 'BAD_GATEWAY');
  });

  // TEST 16: Zero Information Leakage Verification
  await test('16. listDocuments response strictly excludes sensitive identity and Drive internals', async () => {
    const req = { user: { uid: 'active_client_1' } } as any;
    const res = createMockResponse();
    await listDocumentsController(req, res, () => {});

    const responseKeys = Object.keys(res.body);
    assert.deepStrictEqual(responseKeys.sort(), ['documents', 'success'].sort());

    const jsonStr = JSON.stringify(res.body);
    // Never expose driveFolderId
    assert(!jsonStr.includes('folder_client_active_123'), 'Must not leak driveFolderId value');
    assert(!jsonStr.includes('driveFolderId'), 'Must not leak driveFolderId key');
    // Never expose Firebase UID
    assert(!jsonStr.includes('active_client_1'), 'Must not leak Firebase UID');
    // Never expose credentials or emails
    assert(!jsonStr.includes('gserviceaccount.com'), 'Must not leak service account email');
    assert(!jsonStr.includes('private_key'), 'Must not leak private keys');
    assert(!jsonStr.includes('client_email'), 'Must not leak client_email');
    assert(!jsonStr.includes('rajesh@example.com'), 'Must not leak user email');
  });

  console.log(`\n========================================`);
  console.log(`Documents Endpoint Tests Complete: ${passed} passed, ${failed} failed.`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runDocumentsEndpointTests().catch((err) => {
  console.error('Test suite execution failed:', err);
  process.exit(1);
});

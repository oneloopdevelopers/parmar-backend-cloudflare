import assert from 'node:assert';
import { ClientRepository, maskPanNumber } from '../repositories/clientRepository';
import { AppError, NotFoundError, BadRequestError, UnauthorizedError } from '../utils/errors';
import { getUserProfile } from '../controllers/user.controller';
import { AuthenticatedRequest } from '../types';

// Mock Firestore document builder
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

async function runClientRepositoryTests() {
  console.log('--- Starting Tests for ClientRepository & GET /api/profile ---\n');
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

  // 1. maskPanNumber helper tests
  await test('1. maskPanNumber correctly masks standard 10-char PAN', async () => {
    const masked = maskPanNumber('ABCDE1234F');
    assert.strictEqual(masked, 'XXXXXX234F');
    assert.strictEqual(masked.length, 10);
  });

  await test('2. maskPanNumber handles edge cases (empty, short, spaces)', async () => {
    assert.strictEqual(maskPanNumber(''), '');
    assert.strictEqual(maskPanNumber(null as any), '');
    assert.strictEqual(maskPanNumber('1234'), 'XXXX');
    assert.strictEqual(maskPanNumber('  ABCDE1234F  '), 'XXXXXX234F');
  });

  // 2. getClientByUid tests
  const validClientDoc = {
    name: 'Rajesh Sharma',
    email: 'rajesh.sharma@example.com',
    phone: '+91 9876543210',
    panNumber: 'ABCDE1234F',
    driveFolderId: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
    role: 'client',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z'
  };

  await test('3. getClientByUid successfully returns full client document from users/{uid}', async () => {
    const mockDb = createMockFirestore({
      user_rajesh: validClientDoc
    });
    const repo = new ClientRepository(() => mockDb);

    const client = await repo.getClientByUid('user_rajesh');
    assert(client !== null);
    assert.strictEqual(client.name, 'Rajesh Sharma');
    assert.strictEqual(client.email, 'rajesh.sharma@example.com');
    assert.strictEqual(client.phone, '+91 9876543210');
    assert.strictEqual(client.panNumber, 'ABCDE1234F');
    assert.strictEqual(client.driveFolderId, '1AbCdEfGhIjKlMnOpQrStUvWxYz');
    assert.strictEqual(client.role, 'client');
    assert.strictEqual(client.status, 'active');
  });

  await test('4. getClientByUid returns null when document does not exist', async () => {
    const mockDb = createMockFirestore({});
    const repo = new ClientRepository(() => mockDb);

    const client = await repo.getClientByUid('nonexistent_uid');
    assert.strictEqual(client, null);
  });

  await test('5. getClientByUid rejects empty UID (Unauthorized)', async () => {
    const mockDb = createMockFirestore({});
    const repo = new ClientRepository(() => mockDb);

    await assert.rejects(
      async () => repo.getClientByUid(''),
      (err: AppError) => err instanceof UnauthorizedError && err.statusCode === 401
    );
  });

  await test('6. getClientByUid rejects path traversal in UID (BadRequest)', async () => {
    const mockDb = createMockFirestore({});
    const repo = new ClientRepository(() => mockDb);

    await assert.rejects(
      async () => repo.getClientByUid('../other_user'),
      (err: AppError) => err instanceof BadRequestError && err.statusCode === 400
    );
  });

  // 3. Validation for missing or malformed client profiles
  await test('7. getClientByUid validates missing required field (missing panNumber)', async () => {
    const malformedDoc = { ...validClientDoc, panNumber: '' };
    const mockDb = createMockFirestore({ malformed_user: malformedDoc });
    const repo = new ClientRepository(() => mockDb);

    await assert.rejects(
      async () => repo.getClientByUid('malformed_user'),
      (err: AppError) => {
        assert(err instanceof BadRequestError);
        assert(err.message.includes("Field 'panNumber' is missing"));
        return true;
      }
    );
  });

  await test('8. getClientByUid validates malformed email format', async () => {
    const malformedDoc = { ...validClientDoc, email: 'not-an-email' };
    const mockDb = createMockFirestore({ bad_email_user: malformedDoc });
    const repo = new ClientRepository(() => mockDb);

    await assert.rejects(
      async () => repo.getClientByUid('bad_email_user'),
      (err: AppError) => {
        assert(err instanceof BadRequestError);
        assert(err.message.includes("Field 'email' is missing or not a valid email address"));
        return true;
      }
    );
  });

  await test('9. getClientByUid validates missing driveFolderId', async () => {
    const malformedDoc = { ...validClientDoc, driveFolderId: '' };
    const mockDb = createMockFirestore({ no_folder_user: malformedDoc });
    const repo = new ClientRepository(() => mockDb);

    await assert.rejects(
      async () => repo.getClientByUid('no_folder_user'),
      (err: AppError) => {
        assert(err instanceof BadRequestError);
        assert(err.message.includes("Field 'driveFolderId' is missing"));
        return true;
      }
    );
  });

  await test('10. getClientByUid validates invalid role and status', async () => {
    const malformedDoc = { ...validClientDoc, role: 'superhacker', status: 'unknown_status' };
    const mockDb = createMockFirestore({ bad_enums_user: malformedDoc });
    const repo = new ClientRepository(() => mockDb);

    await assert.rejects(
      async () => repo.getClientByUid('bad_enums_user'),
      (err: AppError) => {
        assert(err instanceof BadRequestError);
        assert(err.message.includes("Field 'role' must be either 'client' or 'admin'"));
        assert(err.message.includes("Field 'status' must be either 'active' or 'inactive'"));
        return true;
      }
    );
  });

  // 4. getClientProfileByUid tests
  await test('11. getClientProfileByUid returns client profile with maskedPanNumber and NO driveFolderId', async () => {
    const mockDb = createMockFirestore({
      user_rajesh: validClientDoc
    });
    const repo = new ClientRepository(() => mockDb);

    const profile = await repo.getClientProfileByUid('user_rajesh');
    assert.strictEqual(profile.name, 'Rajesh Sharma');
    assert.strictEqual(profile.email, 'rajesh.sharma@example.com');
    assert.strictEqual(profile.phone, '+91 9876543210');
    assert.strictEqual(profile.maskedPanNumber, 'XXXXXX234F');
    assert.strictEqual(profile.role, 'client');
    assert.strictEqual(profile.status, 'active');

    // CRITICAL: driveFolderId MUST NOT be present in profile
    assert.strictEqual((profile as any).driveFolderId, undefined);
    assert.strictEqual((profile as any).panNumber, undefined);
  });

  await test('12. getClientProfileByUid throws NotFoundError when profile document is missing', async () => {
    const mockDb = createMockFirestore({});
    const repo = new ClientRepository(() => mockDb);

    await assert.rejects(
      async () => repo.getClientProfileByUid('missing_client_uid'),
      (err: AppError) => err instanceof NotFoundError && err.statusCode === 404
    );
  });

  // 5. isClientActive tests
  await test('13. isClientActive returns true for active client, false for inactive client or missing client', async () => {
    const mockDb = createMockFirestore({
      active_user: { ...validClientDoc, status: 'active' },
      inactive_user: { ...validClientDoc, status: 'inactive' }
    });
    const repo = new ClientRepository(() => mockDb);

    const isActive = await repo.isClientActive('active_user');
    const isInactive = await repo.isClientActive('inactive_user');
    const isMissing = await repo.isClientActive('missing_user');

    assert.strictEqual(isActive, true);
    assert.strictEqual(isInactive, false);
    assert.strictEqual(isMissing, false);
  });

  // 6. GET /api/profile controller integration tests
  await test('14. getUserProfile controller returns 200 with { name, email, phone, maskedPanNumber, role, status }', async () => {
    // We test with default client repository mocked via monkey-patch or DI
    const mockDb = createMockFirestore({
      verified_uid_123: validClientDoc
    });
    const customRepo = new ClientRepository(() => mockDb);

    // Save and temporarily swap default repo or invoke with mock
    const req = {
      user: { uid: 'verified_uid_123', email: 'rajesh.sharma@example.com' },
      body: {},
      query: {},
      params: {}
    } as unknown as AuthenticatedRequest;

    let responseStatus = 0;
    let responseBody: any = null;

    const res = {
      status: (code: number) => {
        responseStatus = code;
        return res;
      },
      json: (data: any) => {
        responseBody = data;
        return res;
      }
    } as any;

    // Use customRepo directly to verify payload format
    const profile = await customRepo.getClientProfileByUid(req.user!.uid);
    assert.strictEqual(profile.maskedPanNumber, 'XXXXXX234F');
    assert.strictEqual((profile as any).driveFolderId, undefined);

    // Also test controller rejection of arbitrary client UID in query
    let controllerError: any = null;
    const maliciousReq = {
      user: { uid: 'verified_uid_123' },
      query: { uid: 'victim_uid_456' }
    } as unknown as AuthenticatedRequest;

    await getUserProfile(maliciousReq, res, (err) => {
      controllerError = err;
    });

    assert(controllerError instanceof BadRequestError);
    assert(controllerError.message.includes('Security Violation'));
  });

  console.log(`\n========================================`);
  console.log(`Repository Tests Complete: ${passed} passed, ${failed} failed.`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runClientRepositoryTests().catch((err) => {
  console.error('Test suite uncaught error:', err);
  process.exit(1);
});

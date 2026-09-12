import assert from 'node:assert';
import { createAuthenticateFirebaseUser } from '../middleware/authenticateFirebaseUser';
import { AuthenticatedRequest } from '../types';
import { AppError } from '../utils/errors';

// Helper mock request and response builder
function createMockContext(headers: Record<string, string> = {}) {
  const req = {
    headers,
    user: undefined,
    clientProfile: undefined
  } as unknown as AuthenticatedRequest;

  let statusCode = 200;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: () => res
  } as any;

  let nextCalledWith: any = null;
  let nextCalled = false;

  const next = (err?: any) => {
    nextCalled = true;
    nextCalledWith = err;
  };

  return { req, res, next, getNextError: () => nextCalledWith, wasNextCalled: () => nextCalled };
}

async function runTests() {
  console.log('--- Starting Automated Tests for authenticateFirebaseUser middleware ---\n');
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

  // 1. Missing Authorization header
  await test('1. Rejects request when Authorization header is missing (401)', async () => {
    const middleware = createAuthenticateFirebaseUser();
    const { req, res, next, getNextError } = createMockContext({});

    await middleware(req, res, next);
    const err = getNextError();
    assert(err instanceof AppError, 'Expected error to be AppError');
    assert.strictEqual(err.statusCode, 401);
    assert(err.message.includes('Missing Authorization header'));
  });

  // 2. Malformed token (missing 'Bearer ')
  await test('2. Rejects request when Authorization header is malformed (no Bearer prefix) (401)', async () => {
    const middleware = createAuthenticateFirebaseUser();
    const { req, res, next, getNextError } = createMockContext({ authorization: 'Basic 12345' });

    await middleware(req, res, next);
    const err = getNextError();
    assert(err instanceof AppError, 'Expected error to be AppError');
    assert.strictEqual(err.statusCode, 401);
    assert(err.message.includes('Malformed Authorization header'));
  });

  // 3. Empty Bearer token
  await test('3. Rejects request when Bearer token value is empty (401)', async () => {
    const middleware = createAuthenticateFirebaseUser();
    const { req, res, next, getNextError } = createMockContext({ authorization: 'Bearer   ' });

    await middleware(req, res, next);
    const err = getNextError();
    assert(err instanceof AppError, 'Expected error to be AppError');
    assert.strictEqual(err.statusCode, 401);
    assert(err.message.includes('token value cannot be empty'));
  });

  // 4. Token expired
  await test('4. Rejects request when Firebase ID token has expired (401)', async () => {
    const mockAuth = {
      verifyIdToken: async () => {
        const error = new Error('The Firebase ID token has expired.') as any;
        error.code = 'auth/id-token-expired';
        throw error;
      },
      getUser: async () => ({ uid: 'user_123', disabled: false })
    };

    const middleware = createAuthenticateFirebaseUser({
      getAuth: () => mockAuth,
      getStatus: () => ({ isInitialized: true, projectId: 'document-portal-d2b6d', authMethod: 'application_default', message: 'ok' })
    });

    const { req, res, next, getNextError } = createMockContext({ authorization: 'Bearer expired-jwt-token' });
    await middleware(req, res, next);

    const err = getNextError();
    assert(err instanceof AppError, 'Expected error to be AppError');
    assert.strictEqual(err.statusCode, 401);
    assert(err.message.includes('expired'));
  });

  // 5. Token invalid
  await test('5. Rejects request when Firebase ID token is invalid (401)', async () => {
    const mockAuth = {
      verifyIdToken: async () => {
        const error = new Error('Decoding Firebase ID token failed.') as any;
        error.code = 'auth/invalid-id-token';
        throw error;
      },
      getUser: async () => ({ uid: 'user_123', disabled: false })
    };

    const middleware = createAuthenticateFirebaseUser({
      getAuth: () => mockAuth,
      getStatus: () => ({ isInitialized: true, projectId: 'document-portal-d2b6d', authMethod: 'application_default', message: 'ok' })
    });

    const { req, res, next, getNextError } = createMockContext({ authorization: 'Bearer invalid-token' });
    await middleware(req, res, next);

    const err = getNextError();
    assert(err instanceof AppError, 'Expected error to be AppError');
    assert.strictEqual(err.statusCode, 401);
    assert(err.message.includes('Invalid Firebase ID token'));
  });

  // 6. Firebase user does not exist in Firebase Auth
  await test('6. Rejects request when Firebase user does not exist (401)', async () => {
    const mockAuth = {
      verifyIdToken: async () => ({ uid: 'nonexistent_uid', email: 'test@example.com' }),
      getUser: async () => {
        const error = new Error('No user record found for given identifier.') as any;
        error.code = 'auth/user-not-found';
        throw error;
      }
    };

    const middleware = createAuthenticateFirebaseUser({
      getAuth: () => mockAuth,
      getStatus: () => ({ isInitialized: true, projectId: 'document-portal-d2b6d', authMethod: 'application_default', message: 'ok' })
    });

    const { req, res, next, getNextError } = createMockContext({ authorization: 'Bearer valid-jwt-token' });
    await middleware(req, res, next);

    const err = getNextError();
    assert(err instanceof AppError, 'Expected error to be AppError');
    assert.strictEqual(err.statusCode, 401);
    assert(err.message.includes('does not exist'));
  });

  // 7. Firebase user is disabled in Firebase Auth
  await test('7. Rejects request when Firebase user is disabled (403)', async () => {
    const mockAuth = {
      verifyIdToken: async () => ({ uid: 'disabled_uid', email: 'disabled@example.com' }),
      getUser: async () => ({ uid: 'disabled_uid', disabled: true })
    };

    const middleware = createAuthenticateFirebaseUser({
      getAuth: () => mockAuth,
      getStatus: () => ({ isInitialized: true, projectId: 'document-portal-d2b6d', authMethod: 'application_default', message: 'ok' })
    });

    const { req, res, next, getNextError } = createMockContext({ authorization: 'Bearer valid-jwt-token' });
    await middleware(req, res, next);

    const err = getNextError();
    assert(err instanceof AppError, 'Expected error to be AppError');
    assert.strictEqual(err.statusCode, 403);
    assert(err.message.includes('disabled'));
  });

  // 8. Firestore client profile does not exist
  await test('8. Rejects request when Firestore profile users/{firebaseUid} does not exist (404)', async () => {
    const mockAuth = {
      verifyIdToken: async () => ({ uid: 'missing_profile_uid', email: 'user@example.com' }),
      getUser: async () => ({ uid: 'missing_profile_uid', disabled: false })
    };

    const mockDb = {
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: false, data: () => null })
        })
      })
    };

    const middleware = createAuthenticateFirebaseUser({
      getAuth: () => mockAuth,
      getDb: () => mockDb,
      getStatus: () => ({ isInitialized: true, projectId: 'document-portal-d2b6d', authMethod: 'application_default', message: 'ok' })
    });

    const { req, res, next, getNextError } = createMockContext({ authorization: 'Bearer valid-jwt-token' });
    await middleware(req, res, next);

    const err = getNextError();
    assert(err instanceof AppError, 'Expected error to be AppError');
    assert.strictEqual(err.statusCode, 404);
    assert(err.message.includes('Client profile not found in Firestore'));
  });

  // 9. Client profile status is inactive/disabled in Firestore
  await test('9. Rejects request when client status is inactive or disabled in Firestore (403)', async () => {
    const mockAuth = {
      verifyIdToken: async () => ({ uid: 'inactive_uid', email: 'inactive@example.com' }),
      getUser: async () => ({ uid: 'inactive_uid', disabled: false })
    };

    const mockDb = {
      collection: () => ({
        doc: () => ({
          get: async () => ({
            exists: true,
            data: () => ({
              name: 'Inactive Client',
              email: 'inactive@example.com',
              status: 'inactive'
            })
          })
        })
      })
    };

    const middleware = createAuthenticateFirebaseUser({
      getAuth: () => mockAuth,
      getDb: () => mockDb,
      getStatus: () => ({ isInitialized: true, projectId: 'document-portal-d2b6d', authMethod: 'application_default', message: 'ok' })
    });

    const { req, res, next, getNextError } = createMockContext({ authorization: 'Bearer valid-jwt-token' });
    await middleware(req, res, next);

    const err = getNextError();
    assert(err instanceof AppError, 'Expected error to be AppError');
    assert.strictEqual(err.statusCode, 403);
    assert(err.message.includes('inactive'));
  });

  // 10. Successful authentication: token valid, user active, Firestore profile active
  await test('10. Attaches verified req.user and req.clientProfile, calls next() upon success', async () => {
    const mockAuth = {
      verifyIdToken: async () => ({
        uid: 'valid_client_uid_123',
        email: 'client@example.com',
        email_verified: true,
        aud: 'document-portal-d2b6d'
      }),
      getUser: async () => ({ uid: 'valid_client_uid_123', disabled: false })
    };

    const mockDb = {
      collection: (colName: string) => {
        assert.strictEqual(colName, 'users');
        return {
          doc: (docId: string) => {
            assert.strictEqual(docId, 'valid_client_uid_123');
            return {
              get: async () => ({
                exists: true,
                data: () => ({
                  name: 'Alice Client',
                  email: 'client@example.com',
                  phone: '+15551234567',
                  panNumber: 'ABCDE1234F',
                  driveFolderId: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
                  role: 'client',
                  status: 'active'
                })
              })
            };
          }
        };
      }
    };

    const middleware = createAuthenticateFirebaseUser({
      getAuth: () => mockAuth,
      getDb: () => mockDb,
      getStatus: () => ({ isInitialized: true, projectId: 'document-portal-d2b6d', authMethod: 'application_default', message: 'ok' })
    });

    const { req, res, next, getNextError, wasNextCalled } = createMockContext({ authorization: 'Bearer valid-live-token' });
    await middleware(req, res, next);

    assert.strictEqual(getNextError(), undefined, 'Expected no error passed to next()');
    assert.strictEqual(wasNextCalled(), true, 'Expected next() to be called');
    assert.strictEqual(req.user?.uid, 'valid_client_uid_123');
    assert.strictEqual(req.user?.email, 'client@example.com');
    assert.strictEqual(req.clientProfile?.name, 'Alice Client');
    assert.strictEqual(req.clientProfile?.panNumber, 'ABCDE1234F');
    assert.strictEqual(req.clientProfile?.driveFolderId, '1AbCdEfGhIjKlMnOpQrStUvWxYz');
    assert.strictEqual(req.clientProfile?.status, 'active');
  });

  console.log(`\n========================================`);
  console.log(`Tests Complete: ${passed} passed, ${failed} failed.`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test suite uncaught error:', err);
  process.exit(1);
});

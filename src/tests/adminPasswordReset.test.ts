import assert from 'node:assert';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { createWorkerApp } from '../worker';
import { validateResetPasswordInput } from '../utils/adminValidation';
import { adminClientService } from '../services/adminClientService';
import { firebaseAuthRestService } from '../services/firebaseAuthRestService';
import { clearTokenCache } from '../services/googleServiceAccountAuth';
import { BadRequestError, NotFoundError, ForbiddenError, BadGatewayError } from '../utils/errors';

export async function runAdminPasswordResetTests() {
  console.log('\n--- Starting Tests for Admin Client Password Reset Feature ---');

  // Generate test RSA keys for service account mock
  const { privateKey: saPrivateKey } = await generateKeyPair('RS256', { extractable: true });
  const saPrivateKeyPem = await exportPKCS8(saPrivateKey);

  const projectId = 'parmar-consultancy';
  const testServiceAccountJson = JSON.stringify({
    project_id: projectId,
    private_key: saPrivateKeyPem,
    client_email: 'test-backend@parmar-consultancy.iam.gserviceaccount.com'
  });

  const workerEnv = {
    FIREBASE_PROJECT_ID: projectId,
    NODE_ENV: 'test',
    FIREBASE_SERVICE_ACCOUNT_JSON: testServiceAccountJson
  };

  // Test state stores
  const memoryUsers = new Map<string, any>();
  const memoryAuthAccounts = new Map<string, any>();

  // Seed default admin user
  memoryUsers.set('admin-pw-1', {
    name: 'Primary Administrator',
    email: 'admin@example.com',
    role: 'admin',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z'
  });

  // Seed active client
  memoryUsers.set('client-pw-1', {
    name: 'Aarav Sharma',
    email: 'aarav@example.com',
    phone: '+919876543210',
    panNumber: 'ABCDE1234F',
    role: 'client',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  memoryAuthAccounts.set('client-pw-1', {
    localId: 'client-pw-1',
    email: 'aarav@example.com',
    password: 'InitialPassword123'
  });

  // Seed inactive client
  memoryUsers.set('client-pw-inactive', {
    name: 'Inactive Client',
    email: 'inactive@example.com',
    phone: '+919876543299',
    panNumber: 'ABCDE9999Z',
    role: 'client',
    status: 'inactive',
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  memoryAuthAccounts.set('client-pw-inactive', {
    localId: 'client-pw-inactive',
    email: 'inactive@example.com',
    password: 'InactiveOldPassword123'
  });

  const mockTokenVerifier = async (token: string) => {
    if (token === 'token-admin-valid') {
      return {
        uid: 'admin-pw-1',
        email: 'admin@example.com',
        claims: { sub: 'admin-pw-1', email: 'admin@example.com' }
      };
    }
    if (token === 'token-client-nonadmin') {
      return {
        uid: 'client-pw-1',
        email: 'aarav@example.com',
        claims: { sub: 'client-pw-1', email: 'aarav@example.com' }
      };
    }
    throw new Error('Invalid token');
  };

  let simulateIdentityToolkitError: string | null = null;
  let simulateNetworkError = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (simulateNetworkError) {
      throw new Error('Simulated network drop');
    }

    // Google OAuth token
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'mock-google-access-token',
          expires_in: 3600,
          token_type: 'Bearer'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // IdentityToolkit accounts:update
    if (url.includes('identitytoolkit.googleapis.com/v1/projects') && url.includes('/accounts:update')) {
      if (simulateIdentityToolkitError === 'USER_NOT_FOUND') {
        return new Response(
          JSON.stringify({ error: { message: 'USER_NOT_FOUND', code: 404 } }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (simulateIdentityToolkitError === 'WEAK_PASSWORD') {
        return new Response(
          JSON.stringify({ error: { message: 'WEAK_PASSWORD : Password should be at least 6 characters', code: 400 } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (simulateIdentityToolkitError === 'USER_DISABLED') {
        return new Response(
          JSON.stringify({ error: { message: 'USER_DISABLED', code: 400 } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (simulateIdentityToolkitError === 'UPSTREAM_500') {
        return new Response(
          JSON.stringify({ error: { message: 'Internal upstream error', code: 500 } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const body = JSON.parse(init?.body as string);
      const acc = memoryAuthAccounts.get(body.localId);
      if (!acc) {
        return new Response(
          JSON.stringify({ error: { message: 'USER_NOT_FOUND', code: 404 } }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }
      acc.password = body.password;
      return new Response(
        JSON.stringify({ localId: body.localId, email: acc.email }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Firestore REST API
    if (url.includes('firestore.googleapis.com/v1/projects/') && url.includes('/databases/(default)/documents/')) {
      const matchDoc = url.match(/\/documents\/([^?]+)/);
      const docPath = matchDoc ? matchDoc[1] : '';
      const parts = docPath.split('/');
      const collection = parts[0];
      const docId = parts[1];

      if (collection === 'users') {
        if (init?.method === 'GET') {
          const user = memoryUsers.get(docId);
          if (!user) {
            return new Response(
              JSON.stringify({ error: { message: 'Document not found', code: 404 } }),
              { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
          }
          const fields: Record<string, any> = {};
          for (const [k, v] of Object.entries(user)) {
            if (typeof v === 'string') fields[k] = { stringValue: v };
            else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
            else if (typeof v === 'number') fields[k] = { integerValue: String(v) };
          }
          return new Response(
            JSON.stringify({ name: `projects/${projectId}/databases/(default)/documents/users/${docId}`, fields }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }) as typeof fetch;

  try {
    // -------------------------------------------------------------
    // SECTION 1: Input Validation Helper Tests
    // -------------------------------------------------------------
    console.log('--- Section 1: validateResetPasswordInput Unit Tests ---');

    // 1.1 Non-object body throws BadRequestError
    assert.throws(() => validateResetPasswordInput(null), BadRequestError);
    assert.throws(() => validateResetPasswordInput('not-an-object'), BadRequestError);
    assert.throws(() => validateResetPasswordInput([]), BadRequestError);
    console.log('✓ Test 1 Passed: Non-object body rejected with BadRequestError');

    // 1.2 Missing newPassword
    assert.throws(() => validateResetPasswordInput({}), BadRequestError);
    assert.throws(() => validateResetPasswordInput({ newPassword: null }), BadRequestError);
    console.log('✓ Test 2 Passed: Missing or null newPassword rejected with BadRequestError');

    // 1.3 Non-string newPassword
    assert.throws(() => validateResetPasswordInput({ newPassword: 123456 }), BadRequestError);
    assert.throws(() => validateResetPasswordInput({ newPassword: true }), BadRequestError);
    console.log('✓ Test 3 Passed: Non-string newPassword rejected with BadRequestError');

    // 1.4 Short password (<6 chars)
    assert.throws(() => validateResetPasswordInput({ newPassword: 'abc' }), BadRequestError);
    assert.throws(() => validateResetPasswordInput({ newPassword: '12345' }), BadRequestError);
    console.log('✓ Test 4 Passed: Short password (<6 chars) rejected with BadRequestError');

    // 1.5 Long password (>128 chars)
    assert.throws(() => validateResetPasswordInput({ newPassword: 'x'.repeat(129) }), BadRequestError);
    console.log('✓ Test 5 Passed: Long password (>128 chars) rejected with BadRequestError');

    // 1.6 Forbidden privilege/identity override attempts
    assert.throws(
      () => validateResetPasswordInput({ newPassword: 'ValidPass123', role: 'admin' }),
      BadRequestError
    );
    assert.throws(
      () => validateResetPasswordInput({ newPassword: 'ValidPass123', uid: 'attacker-uid' }),
      BadRequestError
    );
    assert.throws(
      () => validateResetPasswordInput({ newPassword: 'ValidPass123', client_id: 'override-uid' }),
      BadRequestError
    );
    console.log('✓ Test 6 Passed: Forbidden identity/role keys rejected with BadRequestError');

    // 1.7 Valid inputs at boundaries
    const val6 = validateResetPasswordInput({ newPassword: '123456' });
    assert.strictEqual(val6.newPassword, '123456');
    const val128 = validateResetPasswordInput({ newPassword: 'a'.repeat(128) });
    assert.strictEqual(val128.newPassword, 'a'.repeat(128));
    console.log('✓ Test 7 Passed: Valid 6-char and 128-char passwords accepted cleanly');

    // -------------------------------------------------------------
    // SECTION 2: FirebaseAuthRestService.updateUserPassword Tests
    // -------------------------------------------------------------
    console.log('\n--- Section 2: FirebaseAuthRestService.updateUserPassword Unit Tests ---');

    // 2.1 Missing client UID
    await assert.rejects(
      async () => firebaseAuthRestService.updateUserPassword('', 'ValidPass123', { projectId, serviceAccountJson: testServiceAccountJson }),
      BadRequestError
    );
    console.log('✓ Test 8 Passed: Empty UID rejected with BadRequestError');

    // 2.2 Invalid password boundaries
    await assert.rejects(
      async () => firebaseAuthRestService.updateUserPassword('client-pw-1', 'short', { projectId, serviceAccountJson: testServiceAccountJson }),
      BadRequestError
    );
    console.log('✓ Test 9 Passed: Invalid password in service rejected with BadRequestError');

    // 2.3 Successful password update via REST
    const updateRes = await firebaseAuthRestService.updateUserPassword('client-pw-1', 'NewSecurePass2026', {
      projectId,
      serviceAccountJson: testServiceAccountJson
    });
    assert.strictEqual(updateRes.uid, 'client-pw-1');
    assert.strictEqual(memoryAuthAccounts.get('client-pw-1').password, 'NewSecurePass2026');
    console.log('✓ Test 10 Passed: Successful password update via Google Identity Toolkit REST accounts:update');

    // 2.4 USER_NOT_FOUND mapping
    simulateIdentityToolkitError = 'USER_NOT_FOUND';
    await assert.rejects(
      async () => firebaseAuthRestService.updateUserPassword('client-pw-1', 'NewSecurePass2026', { projectId, serviceAccountJson: testServiceAccountJson }),
      NotFoundError
    );
    simulateIdentityToolkitError = null;
    console.log('✓ Test 11 Passed: USER_NOT_FOUND mapped to NotFoundError');

    // 2.5 WEAK_PASSWORD mapping
    simulateIdentityToolkitError = 'WEAK_PASSWORD';
    await assert.rejects(
      async () => firebaseAuthRestService.updateUserPassword('client-pw-1', 'NewSecurePass2026', { projectId, serviceAccountJson: testServiceAccountJson }),
      BadRequestError
    );
    simulateIdentityToolkitError = null;
    console.log('✓ Test 12 Passed: WEAK_PASSWORD mapped to BadRequestError');

    // 2.6 USER_DISABLED mapping
    simulateIdentityToolkitError = 'USER_DISABLED';
    await assert.rejects(
      async () => firebaseAuthRestService.updateUserPassword('client-pw-1', 'NewSecurePass2026', { projectId, serviceAccountJson: testServiceAccountJson }),
      ForbiddenError
    );
    simulateIdentityToolkitError = null;
    console.log('✓ Test 13 Passed: USER_DISABLED mapped to ForbiddenError');

    // 2.7 Upstream 500 error mapping
    simulateIdentityToolkitError = 'UPSTREAM_500';
    await assert.rejects(
      async () => firebaseAuthRestService.updateUserPassword('client-pw-1', 'NewSecurePass2026', { projectId, serviceAccountJson: testServiceAccountJson }),
      BadGatewayError
    );
    simulateIdentityToolkitError = null;
    console.log('✓ Test 14 Passed: Upstream error mapped to BadGatewayError');

    // 2.8 Network exception handling
    simulateNetworkError = true;
    await assert.rejects(
      async () => firebaseAuthRestService.updateUserPassword('client-pw-1', 'NewSecurePass2026', { projectId, serviceAccountJson: testServiceAccountJson }),
      BadGatewayError
    );
    simulateNetworkError = false;
    console.log('✓ Test 15 Passed: Network error caught and mapped to BadGatewayError');

    // -------------------------------------------------------------
    // SECTION 3: AdminClientService.resetClientPassword Tests
    // -------------------------------------------------------------
    console.log('\n--- Section 3: AdminClientService.resetClientPassword Unit Tests ---');

    // 3.1 Non-existent client returns NotFoundError
    await assert.rejects(
      async () => adminClientService.resetClientPassword('non-existent-user', 'NewPass123', { projectId, serviceAccountJson: testServiceAccountJson }),
      NotFoundError
    );
    console.log('✓ Test 16 Passed: Non-existent client profile throws NotFoundError');

    // 3.2 Target is admin returns BadRequestError
    await assert.rejects(
      async () => adminClientService.resetClientPassword('admin-pw-1', 'NewPass123', { projectId, serviceAccountJson: testServiceAccountJson }),
      BadRequestError
    );
    console.log('✓ Test 17 Passed: Admin target profile throws BadRequestError');

    // 3.3 Target is inactive client returns ForbiddenError
    await assert.rejects(
      async () => adminClientService.resetClientPassword('client-pw-inactive', 'NewPass123', { projectId, serviceAccountJson: testServiceAccountJson }),
      ForbiddenError
    );
    console.log('✓ Test 18 Passed: Inactive client target throws ForbiddenError');

    // 3.4 Valid client password reset succeeds
    const svcRes = await adminClientService.resetClientPassword('client-pw-1', 'ServiceResetPass456', {
      projectId,
      serviceAccountJson: testServiceAccountJson
    });
    assert.strictEqual(svcRes.success, true);
    assert.strictEqual(svcRes.clientId, 'client-pw-1');
    assert.strictEqual(svcRes.message, 'Client password reset successfully.');
    assert.strictEqual(memoryAuthAccounts.get('client-pw-1').password, 'ServiceResetPass456');

    // Verify Firestore user was NOT modified (no password stored, status still active)
    const fsUser = memoryUsers.get('client-pw-1');
    assert.strictEqual(fsUser.password, undefined);
    assert.strictEqual(fsUser.newPassword, undefined);
    assert.strictEqual(fsUser.status, 'active');
    console.log('✓ Test 19 Passed: Valid reset updates Auth, preserves Firestore, returns clean response');

    // -------------------------------------------------------------
    // SECTION 4: Worker Route Integration Tests
    // -------------------------------------------------------------
    console.log('\n--- Section 4: Cloudflare Worker Route Integration Tests ---');
    const app = createWorkerApp({ tokenVerifier: mockTokenVerifier });

    // 4.1 Missing token -> 401
    const resNoToken = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-pw-1/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: 'WorkerPass789' })
      }),
      workerEnv
    );
    assert.strictEqual(resNoToken.status, 401);
    console.log('✓ Test 20 Passed: Route without token returns 401');

    // 4.2 Non-admin token -> 403
    const resClientToken = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-pw-1/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-client-nonadmin' },
        body: JSON.stringify({ newPassword: 'WorkerPass789' })
      }),
      workerEnv
    );
    assert.strictEqual(resClientToken.status, 403);
    console.log('✓ Test 21 Passed: Route with client token returns 403');

    // 4.3 Successful password reset via Worker -> 200
    const resSuccess = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-pw-1/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-admin-valid' },
        body: JSON.stringify({ newPassword: 'WorkerResetSuccess2026' })
      }),
      workerEnv
    );
    assert.strictEqual(resSuccess.status, 200);
    const successJson = await resSuccess.json() as any;
    assert.strictEqual(successJson.success, true);
    assert.strictEqual(successJson.clientId, 'client-pw-1');
    assert.strictEqual(successJson.message, 'Client password reset successfully.');
    assert.strictEqual(successJson.newPassword, undefined);
    assert.strictEqual(memoryAuthAccounts.get('client-pw-1').password, 'WorkerResetSuccess2026');
    console.log('✓ Test 22 Passed: Worker route executes password reset with 200 OK and confidential response');

    console.log('\n--- All Admin Client Password Reset Tests Passed Successfully! ---\n');
  } finally {
    globalThis.fetch = originalFetch;
    clearTokenCache();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAdminPasswordResetTests().catch((err) => {
    console.error('Password reset test suite failed:', err);
    process.exit(1);
  });
}

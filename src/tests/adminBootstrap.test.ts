import assert from 'node:assert';
import { generateKeyPair, exportPKCS8 } from 'jose';
import {
  bootstrapFirstAdmin,
  BOOTSTRAP_ADMIN_EMAIL,
  BOOTSTRAP_ADMIN_NAME
} from '../services/adminBootstrapService';
import { clearTokenCache } from '../services/googleServiceAccountAuth';
import { createWorkerApp } from '../worker';

export async function runAdminBootstrapTests() {
  console.log('\n--- Starting Tests for STEP 26A-1 Admin Bootstrap Logic ---');

  // Generate test RSA keys for service account
  const { privateKey: saPrivateKey } = await generateKeyPair('RS256', { extractable: true });
  const saPrivateKeyPem = await exportPKCS8(saPrivateKey);

  const projectId = 'document-portal-d2b6d';
  const testServiceAccountJson = JSON.stringify({
    project_id: projectId,
    private_key: saPrivateKeyPem,
    client_email: 'test-backend@document-portal-d2b6d.iam.gserviceaccount.com'
  });

  // Test state stores
  const memoryUsers = new Map<string, any>();
  const memoryAuthAccounts = new Map<string, any>();

  let failFirestore = false;
  let failFirebaseAuth = false;
  let nextUidCounter = 1000;

  const mockCustomFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    // 1. Google OAuth token
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

    // 2. IdentityToolkit lookup: POST /accounts:lookup
    if (url.includes('/accounts:lookup')) {
      const body = JSON.parse(init?.body as string);
      const email = (body.email?.[0] || '').toLowerCase();
      for (const [uid, acc] of memoryAuthAccounts.entries()) {
        if (acc.email.toLowerCase() === email) {
          return new Response(
            JSON.stringify({
              users: [
                {
                  localId: uid,
                  email: acc.email,
                  displayName: acc.displayName,
                  disabled: acc.disabled || false
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
      return new Response(JSON.stringify({ users: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. IdentityToolkit delete: POST /accounts:delete
    if (url.includes('/accounts:delete')) {
      const body = JSON.parse(init?.body as string);
      memoryAuthAccounts.delete(body.localId);
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 4. IdentityToolkit create: POST /accounts
    if (url.includes('identitytoolkit.googleapis.com/v1/projects') && url.includes('/accounts')) {
      if (failFirebaseAuth) {
        return new Response(
          JSON.stringify({ error: { message: 'Internal auth service failure' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const body = JSON.parse(init?.body as string);
      const uid = `admin-uid-${nextUidCounter++}`;
      memoryAuthAccounts.set(uid, {
        localId: uid,
        email: body.email,
        displayName: body.displayName,
        password: body.password,
        disabled: body.disableUser || false
      });
      return new Response(
        JSON.stringify({ localId: uid, email: body.email }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 5. Firestore REST: GET users/{uid}
    if (url.includes('/databases/(default)/documents/users/')) {
      const parts = url.split('/documents/users/');
      const uid = decodeURIComponent(parts[1].split('?')[0]);

      if (init?.method === 'PATCH') {
        if (failFirestore) {
          return new Response(
            JSON.stringify({ error: { message: 'Simulated Firestore error' } }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const body = JSON.parse(init.body as string);
        const record: Record<string, any> = {};
        for (const [k, v] of Object.entries(body.fields || {})) {
          record[k] = (v as any).stringValue;
        }
        memoryUsers.set(uid, record);
        return new Response(
          JSON.stringify({ fields: body.fields }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (init?.method === 'DELETE') {
        memoryUsers.delete(uid);
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const data = memoryUsers.get(uid);
      if (!data) {
        return new Response(JSON.stringify({ error: { code: 404, message: 'Not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const fields: Record<string, any> = {};
      for (const [k, v] of Object.entries(data)) {
        fields[k] = { stringValue: String(v) };
      }
      return new Response(JSON.stringify({ fields }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }) as typeof fetch;

  try {
    // ==========================================
    // TEST 1: New Admin Firebase user and Firestore Profile Creation
    // ==========================================
    console.log('Test 1: Provisioning initial Administrator account');
    const result1 = await bootstrapFirstAdmin({
      projectId,
      serviceAccountJson: testServiceAccountJson,
      password: 'MockSecureAdminPassword123!',
      customFetch: mockCustomFetch
    });

    assert.strictEqual(result1.status, 'created');
    assert.strictEqual(result1.email, BOOTSTRAP_ADMIN_EMAIL.toLowerCase());
    assert.ok(result1.uid.startsWith('admin-uid-'));

    // Verify Auth user in mock state
    const authUser = memoryAuthAccounts.get(result1.uid);
    assert.ok(authUser, 'Firebase Auth account must exist');
    assert.strictEqual(authUser.email, BOOTSTRAP_ADMIN_EMAIL.toLowerCase());
    assert.strictEqual(authUser.displayName, BOOTSTRAP_ADMIN_NAME);
    assert.strictEqual(authUser.disabled, false);

    // Verify Firestore document
    const fsProfile = memoryUsers.get(result1.uid);
    assert.ok(fsProfile, 'Firestore users/{uid} document must exist');
    assert.strictEqual(fsProfile.name, BOOTSTRAP_ADMIN_NAME);
    assert.strictEqual(fsProfile.email, BOOTSTRAP_ADMIN_EMAIL.toLowerCase());
    assert.strictEqual(fsProfile.role, 'admin');
    assert.strictEqual(fsProfile.status, 'active');
    assert.strictEqual(fsProfile.phone, '');
    assert.strictEqual(fsProfile.driveFolderId, undefined, 'Admin must not have driveFolderId');
    assert.strictEqual(fsProfile.panNumber, undefined, 'Admin must not have panNumber');
    assert.strictEqual(fsProfile.password, undefined, 'Password must NEVER be written to Firestore');

    console.log('✓ Test 1 Passed: Initial Administrator created in Firebase Auth and Firestore with role="admin", status="active", no password or Drive folders in Firestore');

    // ==========================================
    // TEST 2: Duplicate Admin Detection
    // ==========================================
    console.log('Test 2: Duplicate Administrator Detection');
    const resultDup = await bootstrapFirstAdmin({
      projectId,
      serviceAccountJson: testServiceAccountJson,
      password: 'MockSecureAdminPassword123!',
      customFetch: mockCustomFetch
    });

    assert.strictEqual(resultDup.status, 'already_exists');
    assert.strictEqual(resultDup.uid, result1.uid);
    assert.strictEqual(resultDup.email, BOOTSTRAP_ADMIN_EMAIL.toLowerCase());
    assert.ok(resultDup.message.includes('already exists'));

    console.log('✓ Test 2 Passed: Existing admin correctly detected as already_exists without creating duplicate');

    // ==========================================
    // TEST 3: Existing Account with Non-Admin Role Requires Attention
    // ==========================================
    console.log('Test 3: Existing Account with Non-Admin Role');
    // Change profile to role 'client'
    memoryUsers.set(result1.uid, {
      ...memoryUsers.get(result1.uid),
      role: 'client'
    });

    const resultNonAdmin = await bootstrapFirstAdmin({
      projectId,
      serviceAccountJson: testServiceAccountJson,
      password: 'MockSecureAdminPassword123!',
      customFetch: mockCustomFetch
    });

    assert.strictEqual(resultNonAdmin.status, 'attention_required');
    assert.ok(resultNonAdmin.message.includes('Manual review is required'));

    // Restore admin role
    memoryUsers.set(result1.uid, {
      ...memoryUsers.get(result1.uid),
      role: 'admin'
    });
    console.log('✓ Test 3 Passed: Non-admin account prevents automatic privilege elevation and requires manual review');

    // ==========================================
    // TEST 4: Rollback Mechanism on Firestore Failure
    // ==========================================
    console.log('Test 4: Rollback when Firestore Write Fails');
    // Clear state
    memoryUsers.clear();
    memoryAuthAccounts.clear();

    failFirestore = true;

    await assert.rejects(
      async () => {
        await bootstrapFirstAdmin({
          projectId,
          serviceAccountJson: testServiceAccountJson,
          password: 'MockSecureAdminPassword123!',
          customFetch: mockCustomFetch
        });
      },
      /Cloud Firestore REST write error: HTTP 500/
    );

    // Verify rollback: Auth user should have been deleted
    assert.strictEqual(memoryAuthAccounts.size, 0, 'Newly created Auth user must be deleted on Firestore failure');
    assert.strictEqual(memoryUsers.size, 0, 'No Firestore record should exist');

    failFirestore = false;
    console.log('✓ Test 4 Passed: Newly created Firebase Auth user rolled back and deleted upon Firestore failure');

    // ==========================================
    // TEST 5: Password Validation
    // ==========================================
    console.log('Test 5: Password Validation');
    await assert.rejects(
      async () => {
        await bootstrapFirstAdmin({
          projectId,
          serviceAccountJson: testServiceAccountJson,
          password: '123', // less than 6 chars
          customFetch: mockCustomFetch
        });
      },
      /at least 6 characters/
    );

    console.log('✓ Test 5 Passed: Short password rejected');

    // ==========================================
    // TEST 6: Verify No Public Admin Bootstrap HTTP Endpoint Exists
    // ==========================================
    console.log('Test 6: Verify Absence of Public Admin Bootstrap Endpoint');
    const workerEnv = {
      FIREBASE_PROJECT_ID: projectId,
      NODE_ENV: 'test',
      FIREBASE_SERVICE_ACCOUNT_JSON: testServiceAccountJson
    };
    const app = createWorkerApp();

    const prohibitedRoutes = [
      '/api/create-admin',
      '/api/bootstrap-admin',
      '/api/admin/bootstrap',
      '/api/admin/create',
      '/api/bootstrap'
    ];

    for (const route of prohibitedRoutes) {
      const resPost = await app.fetch(new Request(`https://worker.local${route}`, { method: 'POST' }), workerEnv);
      assert.strictEqual(resPost.status, 404, `Prohibited route POST ${route} must return 404`);

      const resGet = await app.fetch(new Request(`https://worker.local${route}`, { method: 'GET' }), workerEnv);
      assert.strictEqual(resGet.status, 404, `Prohibited route GET ${route} must return 404`);
    }

    console.log('✓ Test 6 Passed: No public admin bootstrap endpoints exist on the worker');

    console.log('\n--- All STEP 26A-1 Admin Bootstrap Tests Passed Successfully! ---\n');
  } finally {
    clearTokenCache();
  }
}

// Run tests if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAdminBootstrapTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}

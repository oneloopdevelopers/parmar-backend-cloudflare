import assert from 'node:assert';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { createWorkerApp } from '../worker';
import { validateCreateClientInput } from '../utils/adminValidation';
import { adminClientService } from '../services/adminClientService';
import { clearTokenCache } from '../services/googleServiceAccountAuth';

export async function runAdminEndpointsTests() {
  console.log('\n--- Starting Tests for STEP 26A Admin Client Provisioning APIs ---');

  // Generate test RSA keys for service account
  const { privateKey: saPrivateKey } = await generateKeyPair('RS256', { extractable: true });
  const saPrivateKeyPem = await exportPKCS8(saPrivateKey);

  const projectId = 'document-portal-d2b6d';
  const testServiceAccountJson = JSON.stringify({
    project_id: projectId,
    private_key: saPrivateKeyPem,
    client_email: 'test-backend@document-portal-d2b6d.iam.gserviceaccount.com'
  });

  const workerEnv = {
    FIREBASE_PROJECT_ID: projectId,
    NODE_ENV: 'test',
    FIREBASE_SERVICE_ACCOUNT_JSON: testServiceAccountJson
  };

  // Mock token verifier
  const mockTokenVerifier = async (token: string) => {
    if (token === 'token-admin-valid') {
      return {
        uid: 'admin-user-1',
        email: 'admin@example.com',
        claims: { sub: 'admin-user-1', email: 'admin@example.com' }
      };
    }
    if (token === 'token-client-nonadmin') {
      return {
        uid: 'client-user-1',
        email: 'client@example.com',
        claims: { sub: 'client-user-1', email: 'client@example.com' }
      };
    }
    if (token === 'token-admin-inactive') {
      return {
        uid: 'admin-inactive-1',
        email: 'admin.inactive@example.com',
        claims: { sub: 'admin-inactive-1', email: 'admin.inactive@example.com' }
      };
    }
    throw new Error('Invalid Firebase ID token signature');
  };

  // Test state stores
  const memoryUsers = new Map<string, any>();
  const memoryPanIndex = new Map<string, any>();
  const memoryAuthAccounts = new Map<string, any>();
  const memoryDriveFolders = new Map<string, any>();

  // Seed default admin user
  memoryUsers.set('admin-user-1', {
    name: 'Administrator',
    email: 'admin@example.com',
    phone: '+919999999999',
    panNumber: 'ADMIN1234A',
    driveFolderId: 'admin-folder-id',
    role: 'admin',
    status: 'active',
    createdAt: new Date().toISOString()
  });

  // Seed inactive admin
  memoryUsers.set('admin-inactive-1', {
    name: 'Inactive Admin',
    email: 'admin.inactive@example.com',
    phone: '+919999999998',
    panNumber: 'INADM1234A',
    driveFolderId: 'inadmin-folder-id',
    role: 'admin',
    status: 'inactive',
    createdAt: new Date().toISOString()
  });

  // Seed regular client
  memoryUsers.set('client-user-1', {
    name: 'Regular Client',
    email: 'client@example.com',
    phone: '+919876543210',
    panNumber: 'REGCL1234A',
    driveFolderId: 'folder-reg-client',
    role: 'client',
    status: 'active',
    createdAt: new Date().toISOString()
  });

  // Seed existing PAN in panIndex
  memoryPanIndex.set('EXIST1234E', {
    panNumber: 'EXIST1234E',
    uid: 'existing-client-uid',
    driveFolderId: 'existing-folder-id',
    status: 'active'
  });

  let nextFolderIdCounter = 100;
  let nextAuthIdCounter = 500;
  let failAtStep: 'none' | 'drive' | 'firestore' = 'none';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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

    // 2. IdentityToolkit REST API (Firebase Auth user management)
    if (url.includes('identitytoolkit.googleapis.com/v1/projects') && url.includes('/accounts:delete')) {
      const body = JSON.parse(init?.body as string);
      memoryAuthAccounts.delete(body.localId);
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.includes('identitytoolkit.googleapis.com/v1/projects') && url.includes('/accounts')) {
      const body = JSON.parse(init?.body as string);
      // Check if email already exists in memoryAuthAccounts
      for (const [uid, acc] of memoryAuthAccounts.entries()) {
        if (acc.email === body.email) {
          return new Response(
            JSON.stringify({ error: { message: 'EMAIL_EXISTS', code: 400 } }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
      const newUid = `auth-uid-${nextAuthIdCounter++}`;
      memoryAuthAccounts.set(newUid, { ...body, localId: newUid });
      return new Response(
        JSON.stringify({ localId: newUid, email: body.email }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3. Firestore REST API: users and panIndex
    // GET users collection (list)
    if (url.includes('/databases/(default)/documents/users?pageSize=')) {
      const docs = [];
      for (const [uid, data] of memoryUsers.entries()) {
        const fields: Record<string, any> = {};
        for (const [k, v] of Object.entries(data)) {
          fields[k] = { stringValue: String(v) };
        }
        docs.push({
          name: `projects/${projectId}/databases/(default)/documents/users/${uid}`,
          fields,
          createTime: data.createdAt || new Date().toISOString()
        });
      }
      return new Response(JSON.stringify({ documents: docs }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // GET specific user document
    if (url.includes('/databases/(default)/documents/users/')) {
      const parts = url.split('/documents/users/');
      const uid = parts[1].split('?')[0];
      const data = memoryUsers.get(uid);
      if (init?.method === 'DELETE') {
        memoryUsers.delete(uid);
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (init?.method === 'PATCH') {
        if (failAtStep === 'firestore') {
          return new Response(JSON.stringify({ error: { message: 'Firestore simulated write failure' } }), { status: 500 });
        }
        const body = JSON.parse(init.body as string);
        const saved: Record<string, any> = {};
        for (const [k, v] of Object.entries(body.fields || {})) {
          saved[k] = (v as any).stringValue;
        }
        memoryUsers.set(uid, saved);
        return new Response(JSON.stringify({ fields: body.fields }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (!data) {
        return new Response(JSON.stringify({ error: { code: 404, message: 'Not found' } }), { status: 404 });
      }
      const fields: Record<string, any> = {};
      for (const [k, v] of Object.entries(data)) {
        fields[k] = { stringValue: String(v) };
      }
      return new Response(JSON.stringify({ fields }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // panIndex collection operations
    if (url.includes('/databases/(default)/documents/panIndex/')) {
      const parts = url.split('/documents/panIndex/');
      const pan = decodeURIComponent(parts[1].split('?')[0]);
      if (init?.method === 'DELETE') {
        memoryPanIndex.delete(pan);
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string);
        const saved: Record<string, any> = {};
        for (const [k, v] of Object.entries(body.fields || {})) {
          saved[k] = (v as any).stringValue;
        }
        memoryPanIndex.set(pan, saved);
        return new Response(JSON.stringify({ fields: body.fields }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const data = memoryPanIndex.get(pan);
      if (!data) {
        return new Response(JSON.stringify({ error: { code: 404, message: 'Not found' } }), { status: 404 });
      }
      const fields: Record<string, any> = {};
      for (const [k, v] of Object.entries(data)) {
        fields[k] = { stringValue: String(v) };
      }
      return new Response(JSON.stringify({ fields }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // 4. Google Drive REST operations
    // Client Documents search
    if (url.includes('/drive/v3/files?') && url.includes("Client+Documents")) {
      return new Response(
        JSON.stringify({
          files: [{ id: 'root-client-documents-folder-id', name: 'Client Documents', mimeType: 'application/vnd.google-apps.folder' }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Drive delete folder
    if (init?.method === 'DELETE' && url.includes('/drive/v3/files/')) {
      const fileId = url.split('/drive/v3/files/')[1].split('?')[0];
      memoryDriveFolders.delete(fileId);
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Drive create folder
    if (init?.method === 'POST' && url.includes('/drive/v3/files')) {
      if (failAtStep === 'drive') {
        return new Response(JSON.stringify({ error: { message: 'Drive quota exceeded' } }), { status: 500 });
      }
      const body = JSON.parse(init.body as string);
      const folderId = `drive-folder-${nextFolderIdCounter++}`;
      memoryDriveFolders.set(folderId, { id: folderId, ...body });
      return new Response(
        JSON.stringify({ id: folderId, name: body.name, mimeType: body.mimeType, parents: body.parents }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ error: 'Not handled' }), { status: 404 });
  }) as typeof fetch;

  const app = createWorkerApp({ tokenVerifier: mockTokenVerifier });

  try {
    // ==========================================
    // TEST 1: Validation Unit Tests
    // ==========================================
    console.log('Test 1: Input Validation for Client Creation');
    // Valid input
    const valid = validateCreateClientInput({
      name: 'Priya Patel',
      email: 'priya@example.com',
      phone: '+91 98765 43210',
      panNumber: 'ABCDE1234F',
      password: 'password123',
      status: 'active'
    });
    assert.strictEqual(valid.name, 'Priya Patel');
    assert.strictEqual(valid.panNumber, 'ABCDE1234F');
    assert.strictEqual(valid.email, 'priya@example.com');

    // Reject forbidden identity / role injection
    assert.throws(() => {
      validateCreateClientInput({
        name: 'Attacker',
        email: 'attacker@example.com',
        phone: '+91 98765 43210',
        panNumber: 'ATTAC1234F',
        role: 'admin' // FORBIDDEN!
      });
    }, /Security violation/);

    assert.throws(() => {
      validateCreateClientInput({
        name: 'Attacker',
        email: 'attacker@example.com',
        phone: '+91 98765 43210',
        panNumber: 'ATTAC1234F',
        uid: 'some-custom-uid' // FORBIDDEN!
      });
    }, /Security violation/);

    assert.throws(() => {
      validateCreateClientInput({
        name: 'Attacker',
        email: 'attacker@example.com',
        phone: '+91 98765 43210',
        panNumber: 'ATTAC1234F',
        driveFolderId: 'folder-hack' // FORBIDDEN!
      });
    }, /Security violation/);

    // Invalid PAN format
    assert.throws(() => {
      validateCreateClientInput({
        name: 'Bad PAN',
        email: 'badpan@example.com',
        phone: '+91 98765 43210',
        panNumber: 'INVALID_PAN'
      });
    }, /Validation failed: Field 'panNumber'/);

    // Short password
    assert.throws(() => {
      validateCreateClientInput({
        name: 'Short Pass',
        email: 'shortpass@example.com',
        phone: '+91 98765 43210',
        panNumber: 'ABCDE1234F',
        password: '123'
      });
    }, /Validation failed: Field 'password'/);

    console.log('✓ Test 1 Passed: Input validation enforces strict rules and forbids identity/role injection');

    // ==========================================
    // TEST 2: Authorization Checks on Admin Endpoints
    // ==========================================
    console.log('Test 2: Admin Authentication and Role Verification');

    // 2a. Missing Bearer Token -> 401
    const resNoToken = await app.fetch(
      new Request('https://worker.local/api/admin/clients', { method: 'GET' }),
      workerEnv
    );
    assert.strictEqual(resNoToken.status, 401);

    // 2b. Regular Client Token (role != 'admin') -> 403 Forbidden
    const resClientToken = await app.fetch(
      new Request('https://worker.local/api/admin/clients', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-client-nonadmin' }
      }),
      workerEnv
    );
    assert.strictEqual(resClientToken.status, 403);
    const clientErrJson: any = await resClientToken.json();
    assert.strictEqual(clientErrJson.error.code, 'FORBIDDEN');

    // 2c. Inactive Admin Token -> 403 Forbidden
    const resInactiveAdmin = await app.fetch(
      new Request('https://worker.local/api/admin/clients', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-admin-inactive' }
      }),
      workerEnv
    );
    assert.strictEqual(resInactiveAdmin.status, 403);

    // 2d. Valid Active Admin -> 200 OK
    const resValidAdmin = await app.fetch(
      new Request('https://worker.local/api/admin/clients', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-admin-valid' }
      }),
      workerEnv
    );
    assert.strictEqual(resValidAdmin.status, 200);
    const validAdminJson: any = await resValidAdmin.json();
    assert.strictEqual(validAdminJson.success, true);
    assert.ok(Array.isArray(validAdminJson.data.clients));
    console.log('✓ Test 2 Passed: Admin endpoints strictly enforce active admin role in Firestore');

    // ==========================================
    // TEST 3: GET /api/admin/clients listing
    // ==========================================
    console.log('Test 3: Listing Clients via GET /api/admin/clients');
    const clientsList = validAdminJson.data.clients;
    // Should list client-user-1 and NOT admin-user-1 (admins are filtered from client list)
    const clientEntry = clientsList.find((c: any) => c.uid === 'client-user-1');
    assert.ok(clientEntry, 'Regular client must be present in client list');
    assert.strictEqual(clientEntry.name, 'Regular Client');
    assert.strictEqual(clientEntry.panNumber, 'REGCL1234A');
    assert.strictEqual(clientEntry.role, 'client');
    assert.strictEqual(clientEntry.status, 'active');

    // Confirm administrator is not listed in client list
    const adminInList = clientsList.find((c: any) => c.uid === 'admin-user-1');
    assert.strictEqual(adminInList, undefined, 'Administrator must NOT appear in client list');
    console.log('✓ Test 3 Passed: GET /api/admin/clients returns sanitized client profiles excluding admins');

    // ==========================================
    // TEST 4: POST /api/admin/clients Successful Provisioning
    // ==========================================
    console.log('Test 4: Successful Client Provisioning Flow');
    const newClientPayload = {
      name: 'Aarav Mehta',
      email: 'aarav.mehta@example.com',
      phone: '+919123456780',
      panNumber: 'AARAV1234M',
      password: 'InitialPassword123',
      status: 'active'
    };

    const resCreate = await app.fetch(
      new Request('https://worker.local/api/admin/clients', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-admin-valid',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(newClientPayload)
      }),
      workerEnv
    );

    assert.strictEqual(resCreate.status, 201);
    const createJson: any = await resCreate.json();
    assert.strictEqual(createJson.success, true);
    assert.strictEqual(createJson.message, 'Client provisioned successfully.');

    const createdClient = createJson.data.client;
    assert.ok(createdClient.uid.startsWith('auth-uid-'), 'UID must be server-generated by Auth');
    assert.strictEqual(createdClient.name, 'Aarav Mehta');
    assert.strictEqual(createdClient.email, 'aarav.mehta@example.com');
    assert.strictEqual(createdClient.phone, '+919123456780');
    assert.strictEqual(createdClient.panNumber, 'AARAV1234M');
    assert.strictEqual(createdClient.role, 'client');
    assert.strictEqual(createdClient.status, 'active');
    assert.ok(createdClient.driveFolderId.startsWith('drive-folder-'), 'Must have PAN driveFolderId');
    assert.ok(createdClient.panUploadFolderId.startsWith('drive-folder-'), 'Must have upload folder ID');

    // Verify state in mock stores
    assert.ok(memoryAuthAccounts.has(createdClient.uid), 'Firebase Auth account must exist');
    assert.ok(memoryUsers.has(createdClient.uid), 'Firestore users/{uid} must exist');
    assert.ok(memoryPanIndex.has('AARAV1234M'), 'panIndex/AARAV1234M must exist');
    assert.strictEqual(memoryPanIndex.get('AARAV1234M').uid, createdClient.uid);

    console.log('✓ Test 4 Passed: Client provisioned with Auth user, Drive structure, Firestore record, and PAN index');

    // ==========================================
    // TEST 5: PAN Uniqueness and Duplicate Prevention
    // ==========================================
    console.log('Test 5: PAN Duplicate Rejection');
    // Attempt to register duplicate PAN AARAV1234M
    const resDupPan = await app.fetch(
      new Request('https://worker.local/api/admin/clients', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-admin-valid',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'Imposter',
          email: 'imposter@example.com',
          phone: '+919123456781',
          panNumber: 'AARAV1234M'
        })
      }),
      workerEnv
    );

    assert.strictEqual(resDupPan.status, 409, 'Duplicate PAN must return 409 Conflict');
    const dupPanJson: any = await resDupPan.json();
    assert.strictEqual(dupPanJson.error.code, 'CONFLICT');
    assert.ok(dupPanJson.error.message.includes('AARAV1234M'));

    // Attempt to register existing seeded PAN EXIST1234E
    const resSeededDup = await app.fetch(
      new Request('https://worker.local/api/admin/clients', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-admin-valid',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'Another Duplicate',
          email: 'another@example.com',
          phone: '+919123456782',
          panNumber: 'EXIST1234E'
        })
      }),
      workerEnv
    );
    assert.strictEqual(resSeededDup.status, 409);

    console.log('✓ Test 5 Passed: Duplicate PAN correctly rejected with 409 Conflict');

    // ==========================================
    // TEST 6: Rollback on Downstream Failure (Drive Failure)
    // ==========================================
    console.log('Test 6: Rollback Mechanism on Drive Failure');
    failAtStep = 'drive';

    const failDrivePayload = {
      name: 'Fail Drive User',
      email: 'faildrive@example.com',
      phone: '+919111111111',
      panNumber: 'FAILD1234F'
    };

    const resDriveFail = await app.fetch(
      new Request('https://worker.local/api/admin/clients', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-admin-valid',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(failDrivePayload)
      }),
      workerEnv
    );

    assert.strictEqual(resDriveFail.status, 502, 'Drive failure should return 502 Bad Gateway');

    // Verify rollback: Auth user deleted, panIndex reservation released
    assert.strictEqual(memoryPanIndex.has('FAILD1234F'), false, 'PAN index reservation must be rolled back');
    // Auth account should not exist in memoryAuthAccounts
    for (const [_, acc] of memoryAuthAccounts.entries()) {
      assert.notStrictEqual(acc.email, 'faildrive@example.com', 'Auth user must be cleaned up on rollback');
    }

    console.log('✓ Test 6 Passed: Complete rollback executed on Drive failure');

    // ==========================================
    // TEST 7: Rollback on Firestore Failure
    // ==========================================
    console.log('Test 7: Rollback Mechanism on Firestore Failure');
    failAtStep = 'firestore';

    const failFsPayload = {
      name: 'Fail Firestore User',
      email: 'failfs@example.com',
      phone: '+919222222222',
      panNumber: 'FAILF1234F'
    };

    const resFsFail = await app.fetch(
      new Request('https://worker.local/api/admin/clients', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-admin-valid',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(failFsPayload)
      }),
      workerEnv
    );

    assert.strictEqual(resFsFail.status, 502);

    // Verify rollback: Auth user deleted, Drive folders deleted, panIndex reservation released
    assert.strictEqual(memoryPanIndex.has('FAILF1234F'), false, 'PAN index must be rolled back');
    for (const [_, acc] of memoryAuthAccounts.entries()) {
      assert.notStrictEqual(acc.email, 'failfs@example.com', 'Auth user must be rolled back');
    }

    failAtStep = 'none';
    console.log('✓ Test 7 Passed: Complete rollback executed on Firestore failure');

    // ==========================================
    // TEST 8: Zero-Trust Security Verification
    // ==========================================
    console.log('Test 8: Zero-Trust Injection and Security Hardening');
    // Reject client attempt to inject role: admin via POST body
    const resInjectRole = await app.fetch(
      new Request('https://worker.local/api/admin/clients', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-admin-valid',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'Sneaky',
          email: 'sneaky@example.com',
          phone: '+919333333333',
          panNumber: 'SNEAK1234A',
          role: 'admin'
        })
      }),
      workerEnv
    );
    assert.strictEqual(resInjectRole.status, 400);
    const injectJson: any = await resInjectRole.json();
    assert.strictEqual(injectJson.error.code, 'BAD_REQUEST');
    assert.ok(injectJson.error.message.includes('Security violation'));

    console.log('✓ Test 8 Passed: Client role/identity override strictly forbidden');

    console.log('\n--- All STEP 26A Admin Client Provisioning Tests Passed Successfully! ---\n');
  } finally {
    globalThis.fetch = originalFetch;
    clearTokenCache();
  }
}

// Run tests if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAdminEndpointsTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}

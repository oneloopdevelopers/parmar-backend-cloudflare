import assert from 'node:assert';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { createWorkerApp } from '../worker';
import { clearTokenCache } from '../services/googleServiceAccountAuth';

async function runWorkerEndpointsTests() {
  console.log('\n--- Starting Tests for Cloudflare Worker App Endpoints ---');

  // Setup test RSA keys for service account
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

  // Mock token verifier function
  const mockTokenVerifier = async (token: string) => {
    if (token === 'token-active-123') {
      return {
        uid: 'active-user-123',
        email: 'rajesh@example.com',
        claims: { sub: 'active-user-123', email: 'rajesh@example.com' }
      };
    }
    if (token === 'token-inactive-456') {
      return {
        uid: 'inactive-user-456',
        email: 'inactive@example.com',
        claims: { sub: 'inactive-user-456' }
      };
    }
    if (token === 'token-no-folder') {
      return {
        uid: 'missing-folder-user',
        email: 'nofolder@example.com',
        claims: { sub: 'missing-folder-user' }
      };
    }
    if (token === 'token-non-existent') {
      return {
        uid: 'non-existent-user',
        email: 'ghost@example.com',
        claims: { sub: 'non-existent-user' }
      };
    }
    throw new Error('Invalid Firebase ID token signature');
  };

  // Setup mock global fetch for Google OAuth, Firestore REST, and Drive REST
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    // 1. Google OAuth token endpoint
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

    // 2. Firestore REST endpoint: users/{uid}
    if (url.includes('/databases/(default)/documents/users/active-user-123')) {
      return new Response(
        JSON.stringify({
          name: `projects/${projectId}/databases/(default)/documents/users/active-user-123`,
          fields: {
            name: { stringValue: 'Rajesh Sharma' },
            email: { stringValue: 'rajesh@example.com' },
            phone: { stringValue: '+91 98765 43210' },
            panNumber: { stringValue: 'ABCDE1234F' },
            driveFolderId: { stringValue: 'folder-active-123' },
            role: { stringValue: 'client' },
            status: { stringValue: 'active' }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('/databases/(default)/documents/users/inactive-user-456')) {
      return new Response(
        JSON.stringify({
          name: `projects/${projectId}/databases/(default)/documents/users/inactive-user-456`,
          fields: {
            name: { stringValue: 'Inactive Client' },
            email: { stringValue: 'inactive@example.com' },
            phone: { stringValue: '+91 11111 22222' },
            panNumber: { stringValue: 'INACT1234Z' },
            driveFolderId: { stringValue: 'folder-inactive-456' },
            role: { stringValue: 'client' },
            status: { stringValue: 'inactive' }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('/databases/(default)/documents/users/missing-folder-user')) {
      return new Response(
        JSON.stringify({
          name: `projects/${projectId}/databases/(default)/documents/users/missing-folder-user`,
          fields: {
            name: { stringValue: 'User No Folder' },
            email: { stringValue: 'nofolder@example.com' },
            phone: { stringValue: '+91 33333 44444' },
            panNumber: { stringValue: 'NOFLD1234X' },
            driveFolderId: { stringValue: '' }, // empty folder ID
            role: { stringValue: 'client' },
            status: { stringValue: 'active' }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('/databases/(default)/documents/users/non-existent-user')) {
      return new Response(
        JSON.stringify({ error: { code: 404, message: 'Document not found' } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('/databases/(default)/documents/users?pageSize=1')) {
      // Health check connectivity query
      return new Response(
        JSON.stringify({ documents: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3. Drive REST endpoint: Folder metadata
    if (url.includes('/drive/v3/files/folder-active-123?') && url.includes('fields=id,name,mimeType,trashed')) {
      return new Response(
        JSON.stringify({
          id: 'folder-active-123',
          name: 'Rajesh Sharma Documents',
          mimeType: 'application/vnd.google-apps.folder',
          trashed: false
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 4. Drive REST endpoint: File listing
    if (url.includes('/drive/v3/files?')) {
      return new Response(
        JSON.stringify({
          files: [
            {
              id: 'doc-file-1',
              name: 'PAN_Card.pdf',
              mimeType: 'application/pdf',
              size: '102400',
              createdTime: '2026-09-01T10:00:00Z',
              modifiedTime: '2026-09-01T10:00:00Z'
            },
            {
              id: 'doc-file-2',
              name: 'Bank_Statement.pdf',
              mimeType: 'application/pdf',
              size: '512000',
              createdTime: '2026-09-02T11:00:00Z',
              modifiedTime: '2026-09-02T11:00:00Z'
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not found', { status: 404 });
  }) as any;

  try {
    const app = createWorkerApp({ tokenVerifier: mockTokenVerifier });

    // TEST 1: GET /api/health (Public)
    {
      const req = new Request('http://localhost/api/health', { method: 'GET' });
      const res = await app.request(req, {}, workerEnv);

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.data.status, 'healthy');
      assert.strictEqual(json.data.runtime, 'cloudflare-workers');
      assert.strictEqual(json.data.firebase.targetProjectId, projectId);
      console.log('✓ Test 1 Passed: GET /api/health returns operational status with no secrets');
    }

    // TEST 2: GET /api/health/firebase
    {
      const req = new Request('http://localhost/api/health/firebase', { method: 'GET' });
      const res = await app.request(req, {}, workerEnv);

      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.data.firestore.connected, true);
      console.log('✓ Test 2 Passed: GET /api/health/firebase verifies Firestore REST connectivity');
    }

    // TEST 3: ZERO-TRUST IDENTITY REJECTION
    {
      const forbiddenQueries = [
        'uid=hacker123',
        'firebaseUid=hacker123',
        'panNumber=HACK1234F',
        'pan=HACK1234F',
        'driveFolderId=stolen-folder-id',
        'folderId=stolen-folder-id',
        'clientId=client999'
      ];

      for (const q of forbiddenQueries) {
        const req = new Request(`http://localhost/api/health?${q}`, { method: 'GET' });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400, `Query '${q}' should be rejected with 400 Bad Request`);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.strictEqual(json.error.code, 'BAD_REQUEST');
        assert.ok(json.error.message.includes('Security violation'));
      }

      const forbiddenHeaders = [
        { 'x-uid': 'hacker123' },
        { 'x-pan-number': 'HACK1234F' },
        { 'x-drive-folder-id': 'stolen-folder' },
        { 'client-id': 'client999' }
      ];

      for (const hdr of forbiddenHeaders) {
        const req = new Request('http://localhost/api/health', {
          method: 'GET',
          headers: hdr
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400, `Header '${JSON.stringify(hdr)}' should be rejected with 400`);
      }

      console.log('✓ Test 3 Passed: Zero-trust guard strictly rejects client-supplied identity, PAN, and driveFolderId');
    }

    // TEST 4: UNAUTHORIZED REQUESTS REJECTION
    {
      const protectedRoutes = ['/api/profile', '/api/drive/test', '/api/documents'];

      for (const route of protectedRoutes) {
        const req1 = new Request(`http://localhost${route}`, { method: 'GET' });
        const res1 = await app.request(req1, {}, workerEnv);
        assert.strictEqual(res1.status, 401, `${route} should require authentication`);

        const req2 = new Request(`http://localhost${route}`, {
          method: 'GET',
          headers: { Authorization: 'Basic invalid-credentials' }
        });
        const res2 = await app.request(req2, {}, workerEnv);
        assert.strictEqual(res2.status, 401, `${route} should reject non-Bearer auth`);
      }

      console.log('✓ Test 4 Passed: Protected routes reject requests lacking valid Bearer token');
    }

    // TEST 5: GET /api/profile (Protected)
    {
      // 5a. Successful profile retrieval
      const req = new Request('http://localhost/api/profile', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-active-123' }
      });
      const res = await app.request(req, {}, workerEnv);
      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.name, 'Rajesh Sharma');
      assert.strictEqual(json.email, 'rajesh@example.com');
      assert.strictEqual(json.phone, '+91 98765 43210');
      assert.strictEqual(json.maskedPanNumber, 'XXXXXX234F', 'PAN should be masked');
      assert.strictEqual(json.role, 'client');
      assert.strictEqual(json.status, 'active');
      assert.strictEqual(json.driveFolderId, undefined, 'driveFolderId must NEVER be exposed');
      assert.strictEqual(json.panNumber, undefined, 'Raw PAN must NEVER be exposed');

      // 5b. Inactive user profile access rejected (403)
      const reqInactive = new Request('http://localhost/api/profile', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-inactive-456' }
      });
      const resInactive = await app.request(reqInactive, {}, workerEnv);
      assert.strictEqual(resInactive.status, 403);
      const inactiveJson: any = await resInactive.json();
      assert.strictEqual(inactiveJson.error.code, 'FORBIDDEN');

      // 5c. Non-existent user in Firestore (404)
      const reqNotFound = new Request('http://localhost/api/profile', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-non-existent' }
      });
      const resNotFound = await app.request(reqNotFound, {}, workerEnv);
      assert.strictEqual(resNotFound.status, 404);

      console.log('✓ Test 5 Passed: GET /api/profile enforces active status, masks PAN, and never exposes driveFolderId');
    }

    // TEST 6: GET /api/drive/test (Protected)
    {
      // 6a. Successful test drive access
      const req = new Request('http://localhost/api/drive/test', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-active-123' }
      });
      const res = await app.request(req, {}, workerEnv);
      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.folder.name, 'Rajesh Sharma Documents');
      assert.strictEqual(json.folder.mimeType, 'application/vnd.google-apps.folder');
      assert.strictEqual(json.files.length, 2);
      assert.strictEqual(json.driveFolderId, undefined, 'driveFolderId must NEVER be returned');

      // 6b. Inactive user drive test rejected (403)
      const reqInactive = new Request('http://localhost/api/drive/test', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-inactive-456' }
      });
      const resInactive = await app.request(reqInactive, {}, workerEnv);
      assert.strictEqual(resInactive.status, 403);

      // 6c. Missing driveFolderId rejection (400)
      const reqNoFolder = new Request('http://localhost/api/drive/test', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-no-folder' }
      });
      const resNoFolder = await app.request(reqNoFolder, {}, workerEnv);
      assert.strictEqual(resNoFolder.status, 400);

      console.log('✓ Test 6 Passed: GET /api/drive/test verifies complete flow without exposing driveFolderId');
    }

    // TEST 7: GET /api/documents (Protected)
    {
      // 7a. Successful document listing
      const req = new Request('http://localhost/api/documents', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-active-123' }
      });
      const res = await app.request(req, {}, workerEnv);
      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.documents.length, 2);
      assert.strictEqual(json.documents[0].name, 'PAN_Card.pdf');
      assert.strictEqual(json.documents[1].name, 'Bank_Statement.pdf');
      assert.strictEqual(json.driveFolderId, undefined, 'driveFolderId must NEVER be returned');
      assert.strictEqual(json.uid, undefined, 'UID must NEVER be returned');

      // 7b. Inactive user documents rejected (403)
      const reqInactive = new Request('http://localhost/api/documents', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-inactive-456' }
      });
      const resInactive = await app.request(reqInactive, {}, workerEnv);
      assert.strictEqual(resInactive.status, 403);

      // 7c. Missing driveFolderId rejection (400)
      const reqNoFolder = new Request('http://localhost/api/documents', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-no-folder' }
      });
      const resNoFolder = await app.request(reqNoFolder, {}, workerEnv);
      assert.strictEqual(resNoFolder.status, 400);

      console.log('✓ Test 7 Passed: GET /api/documents returns safe documents list without exposing credentials or driveFolderId');
    }

    console.log('--- All Cloudflare Worker App Endpoints Tests Passed! ---\n');
  } finally {
    globalThis.fetch = originalFetch;
    clearTokenCache();
  }
}

runWorkerEndpointsTests().catch((err) => {
  console.error('Worker App Endpoints Tests Failed:', err);
  process.exit(1);
});

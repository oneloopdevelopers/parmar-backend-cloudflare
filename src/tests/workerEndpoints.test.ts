import assert from 'node:assert';
import { generateKeyPair, exportPKCS8, decodeJwt } from 'jose';
import { createWorkerApp, sanitizeFilename } from '../worker';
import { clearTokenCache, GOOGLE_DRIVE_WRITE_SCOPE } from '../services/googleServiceAccountAuth';

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
    if (token === 'token-new-client') {
      return {
        uid: 'user-new-client-789',
        email: 'newclient@example.com',
        claims: { sub: 'user-new-client-789' }
      };
    }
    if (token === 'token-pan-client-bwjpb') {
      return {
        uid: 'user-bwjpb-0442b',
        email: 'jatin@example.com',
        claims: { sub: 'user-bwjpb-0442b' }
      };
    }
    throw new Error('Invalid Firebase ID token signature');
  };

  // Test observation state
  let lastUploadedParents: string[] = [];
  let lastCreatedFolder: any = null;
  let lastUploadHeaders: Record<string, string> = {};
  let lastUploadBodyBytes: Uint8Array | null = null;
  let lastTokenAssertionScopes: string[] = [];

  // Setup mock global fetch for Google OAuth, Firestore REST, and Drive REST
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    // 1. Google OAuth token endpoint
    if (url.includes('oauth2.googleapis.com/token')) {
      const bodyStr = String(init?.body || '');
      const params = new URLSearchParams(bodyStr);
      const assertion = params.get('assertion');
      if (assertion) {
        try {
          const decoded: any = decodeJwt(assertion);
          if (decoded.scope) {
            lastTokenAssertionScopes.push(decoded.scope);
          }
        } catch (_) {}
      }

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

    if (url.includes('/databases/(default)/documents/users/user-new-client-789')) {
      return new Response(
        JSON.stringify({
          name: `projects/${projectId}/databases/(default)/documents/users/user-new-client-789`,
          fields: {
            name: { stringValue: 'New Client' },
            email: { stringValue: 'newclient@example.com' },
            phone: { stringValue: '+91 99999 88888' },
            panNumber: { stringValue: 'NEWCL1234F' },
            driveFolderId: { stringValue: 'folder-new-client-789' },
            role: { stringValue: 'client' },
            status: { stringValue: 'active' }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('/databases/(default)/documents/users/user-bwjpb-0442b')) {
      return new Response(
        JSON.stringify({
          name: `projects/${projectId}/databases/(default)/documents/users/user-bwjpb-0442b`,
          fields: {
            name: { stringValue: 'Jatin Bhuchhda' },
            email: { stringValue: 'jatin@example.com' },
            phone: { stringValue: '+91 91234 56789' },
            panNumber: { stringValue: 'BWJPB0442B' },
            driveFolderId: { stringValue: 'folder-bwjpb0442b-pan-root' },
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

    if (url.includes('/drive/v3/files/folder-new-client-789?') && url.includes('fields=id,name,mimeType,trashed')) {
      return new Response(
        JSON.stringify({
          id: 'folder-new-client-789',
          name: 'New Client Documents',
          mimeType: 'application/vnd.google-apps.folder',
          trashed: false
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('/drive/v3/files/folder-bwjpb0442b-pan-root?') && url.includes('fields=id,name,mimeType,trashed')) {
      return new Response(
        JSON.stringify({
          id: 'folder-bwjpb0442b-pan-root',
          name: 'BWJPB0442B',
          mimeType: 'application/vnd.google-apps.folder',
          trashed: false
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3B. Drive REST endpoint: Folder creation (POST /drive/v3/files)
    if (init?.method === 'POST' && url.includes('/drive/v3/files') && !url.includes('uploadType=multipart')) {
      const body = JSON.parse(init.body as string);
      lastCreatedFolder = body;
      return new Response(
        JSON.stringify({
          id: 'created-upload-folder-789',
          name: body.name,
          mimeType: body.mimeType,
          parents: body.parents
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3C. Drive REST endpoint: Upload folder search (name = 'upload')
    if (url.includes('/drive/v3/files?') && url.includes("name+%3D+%27upload%27")) {
      if (url.includes('folder-active-123')) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'upload-folder-active-123',
                name: 'upload',
                mimeType: 'application/vnd.google-apps.folder',
                trashed: false,
                parents: ['folder-active-123']
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('folder-bwjpb0442b-pan-root')) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'upload-folder-bwjpb-0442b',
                name: 'upload',
                mimeType: 'application/vnd.google-apps.folder',
                trashed: false,
                parents: ['folder-bwjpb0442b-pan-root']
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ files: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 4. Drive REST endpoint: File listing
    if (url.includes('/drive/v3/files?') && !url.includes('/upload/')) {
      if (url.includes('upload-folder-active-123')) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'doc-uploaded-1',
                name: 'Client_Self_Uploaded.pdf',
                mimeType: 'application/pdf',
                size: '20480',
                createdTime: '2026-09-03T12:00:00Z',
                modifiedTime: '2026-09-03T12:00:00Z'
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('upload-folder-bwjpb-0442b')) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'doc-sample-0',
                name: 'pdf-sample_0.pdf',
                mimeType: 'application/pdf',
                size: '13312',
                createdTime: '2026-09-13T10:00:00Z',
                modifiedTime: '2026-09-13T10:00:00Z'
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('folder-bwjpb0442b-pan-root')) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'doc-udyam-1',
                name: 'UDYAM-ONELOOP.pdf',
                mimeType: 'application/pdf',
                size: '197000',
                createdTime: '2026-09-01T10:00:00Z',
                modifiedTime: '2026-09-01T10:00:00Z'
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('folder-active-123')) {
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

      return new Response(
        JSON.stringify({ files: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 5. Drive REST endpoint: File download (alt=media)
    if (url.includes('/drive/v3/files/') && url.includes('alt=media')) {
      if (url.includes('/drive/v3/files/doc-file-1?alt=media')) {
        return new Response('Mock Binary Content of PAN_Card.pdf', {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': '35'
          }
        });
      }
      if (url.includes('/drive/v3/files/doc-uploaded-1?alt=media')) {
        return new Response('Mock Binary Content of Client_Self_Uploaded.pdf', {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': '46'
          }
        });
      }
      if (url.includes('/drive/v3/files/doc-file-malicious-name?alt=media')) {
        return new Response('Malicious Name File Content', {
          status: 200,
          headers: { 'Content-Type': 'application/pdf', 'Content-Length': '26' }
        });
      }
      if (url.includes('/drive/v3/files/doc-file-unicode?alt=media')) {
        return new Response('Unicode File Content', {
          status: 200,
          headers: { 'Content-Type': 'application/pdf', 'Content-Length': '20' }
        });
      }
      return new Response('Not found', { status: 404 });
    }

    // 6. Drive REST endpoint: File metadata (fields=...)
    if (url.includes('/drive/v3/files/') && url.includes('fields=')) {
      if (url.includes('/drive/v3/files/doc-file-1?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-file-1',
            name: 'PAN_Card.pdf',
            mimeType: 'application/pdf',
            size: '102400',
            parents: ['folder-active-123'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-uploaded-1?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-uploaded-1',
            name: 'Client_Self_Uploaded.pdf',
            mimeType: 'application/pdf',
            size: '20480',
            parents: ['upload-folder-active-123'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-uploaded-other-client?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-uploaded-other-client',
            name: 'Other_Client_Uploaded.pdf',
            mimeType: 'application/pdf',
            size: '20480',
            parents: ['upload-folder-other-999'], // Belongs to another client's upload folder
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-file-other-user?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-file-other-user',
            name: 'Other_User_Private.pdf',
            mimeType: 'application/pdf',
            size: '204800',
            parents: ['folder-other-999'], // Belongs to someone else!
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-file-trashed?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-file-trashed',
            name: 'Old_Trashed_Doc.pdf',
            mimeType: 'application/pdf',
            size: '5000',
            parents: ['folder-active-123'],
            trashed: true // Trashed!
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-file-folder?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-file-folder',
            name: 'Subfolder',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['folder-active-123'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-file-shortcut?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-file-shortcut',
            name: 'Shortcut',
            mimeType: 'application/vnd.google-apps.shortcut',
            parents: ['folder-active-123'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-file-malicious-name?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-file-malicious-name',
            name: 'injected\r\nSet-Cookie: evil=1\r\n\r\nfilename.pdf',
            mimeType: 'application/pdf',
            size: '1024',
            parents: ['folder-active-123'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-file-unicode?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-file-unicode',
            name: 'चालान_2026.pdf',
            mimeType: 'application/pdf',
            size: '2048',
            parents: ['folder-active-123'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-file-upstream-fail?')) {
        return new Response('Google Drive Internal Error 500', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      return new Response(JSON.stringify({ error: { code: 404, message: 'File not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 7. Drive REST endpoint: File upload (uploadType=multipart)
    if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
      lastUploadHeaders = (init?.headers as Record<string, string>) || {};
      let bodyText = '';
      if (init?.body instanceof Uint8Array) {
        lastUploadBodyBytes = init.body;
        bodyText = new TextDecoder().decode(init.body);
      }
      if (bodyText.includes('upstream-fail.pdf')) {
        return new Response('Google Drive Upload Internal Error 500', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      if (bodyText.includes('upstream-411.pdf')) {
        return new Response('Google Drive Upload 411 Length Required', {
          status: 411,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      if (bodyText.includes('upstream-400.pdf')) {
        return new Response('Google Drive Upload 400 Bad Request', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' }
        });
      }

      // Extract filename and parents from multipart metadata if present
      let uploadedName = 'uploaded_doc.pdf';
      const nameMatch = bodyText.match(/"name":"([^"]+)"/);
      if (nameMatch) {
        uploadedName = nameMatch[1];
      }
      const parentsMatch = bodyText.match(/"parents":\["([^"]+)"\]/);
      if (parentsMatch) {
        lastUploadedParents = [parentsMatch[1]];
      } else {
        lastUploadedParents = [];
      }

      return new Response(
        JSON.stringify({
          id: 'uploaded-doc-id-789',
          name: uploadedName,
          mimeType: uploadedName.endsWith('.jpg') || uploadedName.endsWith('.jpeg')
            ? 'image/jpeg'
            : uploadedName.endsWith('.png')
            ? 'image/png'
            : uploadedName.endsWith('.xls')
            ? 'application/vnd.ms-excel'
            : uploadedName.endsWith('.xlsx')
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'application/pdf',
          size: '2048',
          createdTime: '2026-09-13T12:00:00Z'
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
      // 5a. Successful profile retrieval: returns authentic full panNumber AND maskedPanNumber, never driveFolderId
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
      assert.strictEqual(json.panNumber, 'ABCDE1234F', 'Authentic full PAN must be returned for authenticated user');
      assert.strictEqual(json.role, 'client');
      assert.strictEqual(json.status, 'active');
      assert.strictEqual(json.driveFolderId, undefined, 'driveFolderId must NEVER be exposed');

      // 5b. Inactive user profile access rejected (403) and returns no profile/PAN
      const reqInactive = new Request('http://localhost/api/profile', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-inactive-456' }
      });
      const resInactive = await app.request(reqInactive, {}, workerEnv);
      assert.strictEqual(resInactive.status, 403);
      const inactiveJson: any = await resInactive.json();
      assert.strictEqual(inactiveJson.error.code, 'FORBIDDEN');
      assert.strictEqual(inactiveJson.panNumber, undefined, 'Inactive response must not leak PAN');
      assert.strictEqual(inactiveJson.maskedPanNumber, undefined, 'Inactive response must not leak masked PAN');

      // 5c. Non-existent user in Firestore (404)
      const reqNotFound = new Request('http://localhost/api/profile', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-non-existent' }
      });
      const resNotFound = await app.request(reqNotFound, {}, workerEnv);
      assert.strictEqual(resNotFound.status, 404);

      // 5d. Unauthenticated request rejected (401) with no profile/PAN returned
      const reqUnauth = new Request('http://localhost/api/profile', {
        method: 'GET'
      });
      const resUnauth = await app.request(reqUnauth, {}, workerEnv);
      assert.strictEqual(resUnauth.status, 401);
      const unauthJson: any = await resUnauth.json();
      assert.strictEqual(unauthJson.panNumber, undefined, 'Unauthenticated response must not leak PAN');

      // 5e. Client-supplied PAN in query string (?panNumber=ATTACK1234) is strictly rejected (400) by Zero-Trust Guard
      const reqQueryTamper = new Request('http://localhost/api/profile?panNumber=ATTACK1234', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-active-123' }
      });
      const resQueryTamper = await app.request(reqQueryTamper, {}, workerEnv);
      assert.strictEqual(resQueryTamper.status, 400, 'Client-supplied panNumber in query must be rejected with 400 Bad Request');
      const queryTamperJson: any = await resQueryTamper.json();
      assert.strictEqual(queryTamperJson.panNumber, undefined, 'Rejection response must not contain PAN');

      // 5f. Client-supplied identity in query string (?uid=other_user&clientId=other_client) is strictly rejected (400)
      const reqIdTamper = new Request('http://localhost/api/profile?uid=user-new-client-789&clientId=user-new-client-789', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-active-123' }
      });
      const resIdTamper = await app.request(reqIdTamper, {}, workerEnv);
      assert.strictEqual(resIdTamper.status, 400, 'Client-supplied uid/clientId in query must be rejected with 400 Bad Request');

      // 5g. Client-supplied forbidden identity header (x-pan, x-client-id, etc.) rejected with 400
      const reqHeaderTamper = new Request('http://localhost/api/profile', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer token-active-123',
          'x-pan': 'ATTACK1234'
        }
      });
      const resHeaderTamper = await app.request(reqHeaderTamper, {}, workerEnv);
      assert.strictEqual(resHeaderTamper.status, 400, 'x-pan identity override header must return 400');

      // 5h. Arbitrary non-identity query parameter does not affect profile and returns authentic PAN
      const reqSafeQuery = new Request('http://localhost/api/profile?cacheBust=12345', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-active-123' }
      });
      const resSafeQuery = await app.request(reqSafeQuery, {}, workerEnv);
      assert.strictEqual(resSafeQuery.status, 200);
      const safeQueryJson: any = await resSafeQuery.json();
      assert.strictEqual(safeQueryJson.panNumber, 'ABCDE1234F', 'Authentic PAN is returned regardless of other query parameters');
      assert.strictEqual(safeQueryJson.maskedPanNumber, 'XXXXXX234F');

      // 5i. Tenant isolation: Another authenticated client receives their own full PAN and masked PAN
      const reqOther = new Request('http://localhost/api/profile', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-new-client' }
      });
      const resOther = await app.request(reqOther, {}, workerEnv);
      assert.strictEqual(resOther.status, 200);
      const otherJson: any = await resOther.json();
      assert.strictEqual(otherJson.name, 'New Client');
      assert.strictEqual(otherJson.panNumber, 'NEWCL1234F', 'User receives their own authentic PAN');
      assert.strictEqual(otherJson.maskedPanNumber, 'XXXXXX234F');
      assert.strictEqual(otherJson.driveFolderId, undefined);

      // 5j. Logging security: verify logs do not contain raw PAN during profile processing
      let loggedContent = '';
      const originalLog = console.log;
      const originalInfo = console.info;
      const originalWarn = console.warn;
      const originalError = console.error;
      const capture = (...args: any[]) => { loggedContent += ' ' + args.map(a => String(a)).join(' '); };
      console.log = capture;
      console.info = capture;
      console.warn = capture;
      console.error = capture;

      try {
        const reqLogTest = new Request('http://localhost/api/profile', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        await app.request(reqLogTest, {}, workerEnv);
      } finally {
        console.log = originalLog;
        console.info = originalInfo;
        console.warn = originalWarn;
        console.error = originalError;
      }

      assert.ok(!loggedContent.includes('ABCDE1234F'), 'Server logs must NEVER contain the raw PAN during profile retrieval');

      console.log('✓ Test 5 Passed: GET /api/profile returns both authentic panNumber & maskedPanNumber, rejects tampering, strictly isolates tenants, never logs PAN, and never exposes driveFolderId');
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
      assert.strictEqual(json.documents.length, 3);
      
      const panCardDoc = json.documents.find((d: any) => d.name === 'PAN_Card.pdf');
      assert.ok(panCardDoc);
      assert.strictEqual(panCardDoc.uploaderType, 'administrator');
      assert.strictEqual(panCardDoc.uploaderName, 'Administrator');

      const bankStatementDoc = json.documents.find((d: any) => d.name === 'Bank_Statement.pdf');
      assert.ok(bankStatementDoc);
      assert.strictEqual(bankStatementDoc.uploaderType, 'administrator');
      assert.strictEqual(bankStatementDoc.uploaderName, 'Administrator');

      const clientSelfDoc = json.documents.find((d: any) => d.name === 'Client_Self_Uploaded.pdf');
      assert.ok(clientSelfDoc);
      assert.strictEqual(clientSelfDoc.uploaderType, 'client');
      assert.strictEqual(clientSelfDoc.uploaderName, 'Rajesh Sharma');

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

    // TEST 8: GET /api/documents/:documentId/download (Protected & Zero-Trust)
    {
      // 8A. Successful authorized download
      {
        const req = new Request('http://localhost/api/documents/doc-file-1/download', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('Content-Type'), 'application/pdf');
        assert.ok(res.headers.get('Content-Disposition')?.includes('filename="PAN_Card.pdf"'));
        assert.ok(res.headers.get('Content-Disposition')?.includes("filename*=UTF-8''PAN_Card.pdf"));
        assert.strictEqual(res.headers.get('X-Content-Type-Options'), 'nosniff');
        assert.strictEqual(res.headers.get('Cache-Control'), 'private, no-cache, no-store, must-revalidate');
        const text = await res.text();
        assert.strictEqual(text, 'Mock Binary Content of PAN_Card.pdf');
        console.log('✓ Test 8A Passed: Successful authorized document download with correct headers and stream');
      }

      // 8B. Unauthenticated download (401)
      {
        const req = new Request('http://localhost/api/documents/doc-file-1/download', {
          method: 'GET'
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 401);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.strictEqual(json.error.code, 'UNAUTHORIZED');
        console.log('✓ Test 8B Passed: Unauthenticated download rejected with 401');
      }

      // 8C. Invalid token download (401)
      {
        const req = new Request('http://localhost/api/documents/doc-file-1/download', {
          method: 'GET',
          headers: { Authorization: 'Bearer invalid-token-xyz' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 401);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        console.log('✓ Test 8C Passed: Invalid token rejected with 401');
      }

      // 8D. Inactive user download (403)
      {
        const req = new Request('http://localhost/api/documents/doc-file-1/download', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-inactive-456' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 403);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.strictEqual(json.error.code, 'FORBIDDEN');
        assert.ok(json.error.message.includes('inactive'));
        console.log('✓ Test 8D Passed: Inactive user rejected with 403 Forbidden');
      }

      // 8E. IDOR / Cross-tenant protection (404)
      {
        const req = new Request('http://localhost/api/documents/doc-file-other-user/download', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 404, 'IDOR file attempt must return 404');
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.strictEqual(json.error.code, 'NOT_FOUND');
        assert.strictEqual(json.error.message, 'Document not found or inaccessible.');
        console.log('✓ Test 8E Passed: IDOR cross-tenant attempt rejected with 404 without leaking info');
      }

      // 8F. Trashed file attempt (404)
      {
        const req = new Request('http://localhost/api/documents/doc-file-trashed/download', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 404);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        console.log('✓ Test 8F Passed: Trashed document rejected with 404');
      }

      // 8G. Folder download attempt (404)
      {
        const req = new Request('http://localhost/api/documents/doc-file-folder/download', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 404);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        console.log('✓ Test 8G Passed: Folder download attempt rejected with 404');
      }

      // 8H. Shortcut download attempt (404)
      {
        const req = new Request('http://localhost/api/documents/doc-file-shortcut/download', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 404);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        console.log('✓ Test 8H Passed: Shortcut download attempt rejected with 404');
      }

      // 8I. Invalid / Path traversal document ID (400)
      {
        const req = new Request('http://localhost/api/documents/invalid..id!/download', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.strictEqual(json.error.code, 'BAD_REQUEST');
        console.log('✓ Test 8I Passed: Malformed document ID rejected with 400 Bad Request');
      }

      // 8J. Filename security & header injection immunity
      {
        const req = new Request('http://localhost/api/documents/doc-file-malicious-name/download', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const disp = res.headers.get('Content-Disposition') || '';
        assert.ok(!disp.includes('\r'), 'Content-Disposition must NOT contain CR');
        assert.ok(!disp.includes('\n'), 'Content-Disposition must NOT contain LF');
        assert.strictEqual(res.headers.get('set-cookie'), null, 'Set-Cookie header must NOT be injected into response');

        // Unit test sanitizeFilename directly across edge cases
        const testCases = [
          {
            input: 'normal.pdf',
            expectedAscii: 'normal.pdf'
          },
          {
            input: 'evil\r\nX-Injected: 1\r\n\r\nfile.pdf',
            expectedAscii: 'evilX-Injected: 1file.pdf'
          },
          {
            input: '../../../../etc/passwd',
            expectedAscii: 'passwd'
          },
          {
            input: 'file"with"quotes.pdf',
            expectedAscii: 'file_with_quotes.pdf'
          },
          {
            input: 'हिंदी_दस्तावेज.pdf',
            expectedAscii: '______________.pdf'
          },
          {
            input: '',
            expectedAscii: 'document.bin'
          }
        ];

        for (const tc of testCases) {
          const sanitized = sanitizeFilename(tc.input);
          assert.strictEqual(sanitized.asciiFilename, tc.expectedAscii);
          assert.ok(!sanitized.contentDisposition.includes('\r'));
          assert.ok(!sanitized.contentDisposition.includes('\n'));
        }

        console.log('✓ Test 8J Passed: Filename sanitization strictly prevents CRLF injection and path traversal');
      }

      // 8K. Google Drive upstream failure (502)
      {
        const req = new Request('http://localhost/api/documents/doc-file-upstream-fail/download', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 502);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.strictEqual(json.error.code, 'BAD_GATEWAY');
        assert.ok(!JSON.stringify(json).includes('private_key'));
        console.log('✓ Test 8K Passed: Upstream failure returns 502 Bad Gateway without leaking secrets');
      }
    }

    // ==========================================================
    // TEST 9: POST /api/documents/upload (Protected)
    // ==========================================================
    {
      const validPdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xc4, 0xe5, 0xf2, 0xe5]);
      const validJpgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
      const validPngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

      // 9A. Successful PDF upload -> 200
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'Income_Tax_Computation.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.success, true);
        assert.strictEqual(json.message, 'Document uploaded successfully.');
        assert.strictEqual(json.data.document.id, 'uploaded-doc-id-789');
        assert.strictEqual(json.data.document.name, 'Income_Tax_Computation.pdf');
        assert.strictEqual(json.data.document.mimeType, 'application/pdf');
        assert.strictEqual(json.data.document.uploaderType, 'client');
        assert.strictEqual(json.data.document.uploaderName, 'Rajesh Sharma');
        // Verify no sensitive fields in response
        assert.strictEqual(json.data.document.driveFolderId, undefined);
        assert.strictEqual(json.data.driveFolderId, undefined);
        assert.strictEqual(json.driveFolderId, undefined);
        assert.strictEqual(json.uid, undefined);
        assert.strictEqual(json.accessToken, undefined);
        console.log('✓ Test 9A Passed: Successful PDF document upload returns 200 and safe metadata');
      }

      // 9B. Successful JPEG upload -> 200
      {
        const fd = new FormData();
        fd.append('file', new File([validJpgBytes], 'PAN_Card_Photo.jpg', { type: 'image/jpeg' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.success, true);
        assert.strictEqual(json.data.document.mimeType, 'image/jpeg');
        console.log('✓ Test 9B Passed: Successful JPEG document upload returns 200');
      }

      // 9C. Successful PNG upload -> 200
      {
        const fd = new FormData();
        fd.append('file', new File([validPngBytes], 'Aadhaar_Scan.png', { type: 'image/png' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.success, true);
        assert.strictEqual(json.data.document.mimeType, 'image/png');
        console.log('✓ Test 9C Passed: Successful PNG document upload returns 200');
      }

      // 9C2. Successful XLS upload -> 200
      {
        const validXlsBytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
        const fd = new FormData();
        fd.append('file', new File([validXlsBytes], 'Audit_Report.xls', { type: 'application/vnd.ms-excel' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.success, true);
        assert.strictEqual(json.data.document.mimeType, 'application/vnd.ms-excel');
        console.log('✓ Test 9C2 Passed: Successful XLS document upload returns 200');
      }

      // 9C3. Successful XLSX upload -> 200
      {
        const validXlsxBytes = new Uint8Array([
          0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00,
          ...new TextEncoder().encode('[Content_Types].xml'),
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00
        ]);
        const fd = new FormData();
        fd.append('file', new File([validXlsxBytes], 'Tax_Computation.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.success, true);
        assert.strictEqual(json.data.document.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        console.log('✓ Test 9C3 Passed: Successful XLSX document upload returns 200');
      }

      // 9D. Missing file -> 400
      {
        const fd = new FormData();
        fd.append('notes', 'Upload without file');
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('file'));
        console.log('✓ Test 9D Passed: Missing file field rejected with 400');
      }

      // 9E. Empty file (0 bytes) -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([], 'empty.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('empty'));
        console.log('✓ Test 9E Passed: Empty (0-byte) file rejected with 400');
      }

      // 9F. Unsupported MIME type -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'archive.zip', { type: 'application/zip' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('Unsupported file type'));
        console.log('✓ Test 9F Passed: Unsupported MIME type (ZIP) rejected with 400');
      }

      // 9G. Unsupported extension -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'malicious.apk', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('extension'));
        console.log('✓ Test 9G Passed: Unsupported file extension rejected with 400');
      }

      // 9H. File larger than 15 MB -> 400
      {
        const chunk = new Uint8Array(1024 * 1024); // 1 MB buffer
        const largeFile = new File(new Array(16).fill(chunk), 'large_doc.pdf', { type: 'application/pdf' });
        const fd = new FormData();
        fd.append('file', largeFile);
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('15 MB'));
        console.log('✓ Test 9H Passed: File exceeding 15 MB rejected with 400');
      }

      // 9I. MIME/extension mismatch -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'mismatch.png', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('does not match declared MIME type'));
        console.log('✓ Test 9I Passed: MIME/extension mismatch rejected with 400');
      }

      // 9J. Invalid file signature -> 400
      {
        const fakePdfBytes = new TextEncoder().encode('<html><body>Fake PDF Content</body></html>');
        const fd = new FormData();
        fd.append('file', new File([fakePdfBytes], 'fake.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('File content signature does not match'));
        console.log('✓ Test 9J Passed: Invalid file signature (MIME spoofing) rejected with 400');
      }

      // 9K. Unauthenticated upload -> 401
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 401);
        console.log('✓ Test 9K Passed: Unauthenticated upload rejected with 401');
      }

      // 9L. Invalid Firebase token -> 401
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer bad-token' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 401);
        console.log('✓ Test 9L Passed: Invalid Firebase token rejected with 401');
      }

      // 9M. Inactive user -> 403
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-inactive-456' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 403);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.strictEqual(json.error.code, 'FORBIDDEN');
        console.log('✓ Test 9M Passed: Inactive user profile rejected with 403');
      }

      // 9N. Missing Firestore profile -> 404
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-non-existent' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 404);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        console.log('✓ Test 9N Passed: Missing Firestore profile rejected with 404');
      }

      // 9O. Missing driveFolderId in profile -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-no-folder' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('driveFolderId'));
        console.log('✓ Test 9O Passed: Missing driveFolderId in Firestore profile rejected with 400');
      }

      // 9P. Client supplies uid in query -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload?uid=attacker-uid', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('Security violation'));
        console.log('✓ Test 9P Passed: Client supplied uid in query rejected with 400');
      }

      // 9Q. Client supplies PAN in header -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer token-active-123',
            'X-Pan-Number': 'ABCDE1234F'
          },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('Security violation'));
        console.log('✓ Test 9Q Passed: Client supplied PAN in header rejected with 400');
      }

      // 9R. Client supplies driveFolderId in query -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload?driveFolderId=other-folder', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('Security violation'));
        console.log('✓ Test 9R Passed: Client supplied driveFolderId in query rejected with 400');
      }

      // 9S. Client supplies clientId in header -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer token-active-123',
            'X-Client-Id': 'client-999'
          },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('Security violation'));
        console.log('✓ Test 9S Passed: Client supplied clientId in header rejected with 400');
      }

      // 9T. Client supplies destination folder in multipart form data -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        fd.append('driveFolderId', 'injected-folder-999');
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('Security violation'));
        console.log('✓ Test 9T Passed: Client supplied driveFolderId in multipart form data rejected with 400');
      }

      // 9T2. Client supplies uploaderType in multipart form data -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        fd.append('uploaderType', 'administrator');
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('Security violation'));
        console.log('✓ Test 9T2 Passed: Client supplied uploaderType in multipart form data rejected with 400');
      }

      // 9T3. Client supplies uploaderName in multipart form data -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        fd.append('uploader_name', 'Hacked Admin');
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('Security violation'));
        console.log('✓ Test 9T3 Passed: Client supplied uploader_name in multipart form data rejected with 400');
      }

      // 9T4. Client supplies uploaderType in header -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer token-active-123',
            'X-Uploader-Type': 'administrator'
          },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('Security violation'));
        console.log('✓ Test 9T4 Passed: Client supplied X-Uploader-Type in header rejected with 400');
      }

      // 9T5. Client supplies uploaderName in query -> 400
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload?uploaderName=SuperAdmin', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 400);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.ok(json.error.message.includes('Security violation'));
        console.log('✓ Test 9T5 Passed: Client supplied uploaderName in query rejected with 400');
      }

      // 9U. Google Drive upstream failure -> 502
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'upstream-fail.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 502);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.strictEqual(json.error.code, 'BAD_GATEWAY');
        console.log('✓ Test 9U Passed: Google Drive upstream failure returns 502 Bad Gateway');
      }

      // 9U_411. Google Drive 411 Length Required failure -> 502 Bad Gateway
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'upstream-411.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 502);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.strictEqual(json.error.code, 'BAD_GATEWAY');
        console.log('✓ Test 9U_411 Passed: Google Drive 411 Length Required returns safe 502 Bad Gateway');
      }

      // 9U_400. Google Drive 400 Bad Request failure -> 502 Bad Gateway
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'upstream-400.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 502);
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        assert.strictEqual(json.error.code, 'BAD_GATEWAY');
        console.log('✓ Test 9U_400 Passed: Google Drive 400 Bad Request returns safe 502 Bad Gateway');
      }

      // 9V. Filename path traversal attempt is sanitized
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], '../../../../etc/passwd.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.success, true);
        assert.ok(!json.data.document.name.includes('/'));
        assert.ok(!json.data.document.name.includes('..'));
        console.log('✓ Test 9V Passed: Filename path traversal sequence is safely sanitized');
      }

      // 9W. Filename CRLF/control-character attempt is sanitized
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'evil\r\nSet-Cookie: evil=1\r\nfilename.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.success, true);
        assert.ok(!json.data.document.name.includes('\r'));
        assert.ok(!json.data.document.name.includes('\n'));
        console.log('✓ Test 9W Passed: Filename CRLF and control characters are safely stripped');
      }

      // 9X. Existing document with same filename is NOT overwritten (Drive permits duplicate names)
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'PAN_Card.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.success, true);
        assert.strictEqual(json.data.document.name, 'PAN_Card.pdf');
        assert.ok(json.data.document.id);

        // Verify wire-level upload contract to Google Drive
        assert.ok(lastUploadBodyBytes instanceof Uint8Array, 'Body sent to fetch must be a Uint8Array');
        assert.strictEqual(
          lastUploadHeaders['Content-Length'],
          String(lastUploadBodyBytes.byteLength),
          'Content-Length header must be explicitly set and match byteLength'
        );
        assert.ok(
          lastUploadHeaders['Content-Type']?.startsWith('multipart/related; boundary='),
          'Content-Type must be multipart/related with boundary'
        );
        assert.ok(
          lastTokenAssertionScopes.includes(GOOGLE_DRIVE_WRITE_SCOPE),
          'Drive write scope must be requested for uploading files'
        );

        console.log('✓ Test 9X Passed: Upload succeeds with exact wire-level multipart contract, write scope, and Content-Length');
      }

      // 9Y. Successful response does not contain driveFolderId
      // 9Z. Successful response does not contain Firebase UID
      // 9AA. Successful response does not contain credentials or access tokens
      {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'audit_check.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const jsonText = await res.text();
        assert.ok(!jsonText.includes('folder-active-123'), 'Must not leak driveFolderId');
        assert.ok(!jsonText.includes('active-user-123'), 'Must not leak Firebase UID');
        assert.ok(!jsonText.includes('private_key'), 'Must not leak private key');
        assert.ok(!jsonText.includes('mock-google-access-token'), 'Must not leak access token');
        console.log('✓ Tests 9Y, 9Z, 9AA Passed: Response contains zero leaked folder IDs, UIDs, or credentials');
      }

      // 9AB. Existing listing and download endpoints continue to pass all tests
      {
        const listReq = new Request('http://localhost/api/documents', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        const listRes = await app.request(listReq, {}, workerEnv);
        assert.strictEqual(listRes.status, 200);
        const listJson: any = await listRes.json();
        assert.strictEqual(listJson.success, true);
        assert.ok(Array.isArray(listJson.documents));

        const downloadReq = new Request('http://localhost/api/documents/doc-file-1/download', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        const downloadRes = await app.request(downloadReq, {}, workerEnv);
        assert.strictEqual(downloadRes.status, 200);
        assert.strictEqual(downloadRes.headers.get('Content-Type'), 'application/pdf');
        console.log('✓ Test 9AB Passed: Existing listing and download endpoints continue to pass all tests');
      }

      // =========================================================================
      // TEST SUITE 10: {PAN_NUMBER}/upload/ FOLDER ARCHITECTURE & SECURITY TESTS
      // =========================================================================
      console.log('\n--- Running Test Suite 10: {PAN_NUMBER}/upload/ Architecture & Security Tests ---');

      // 10A. Document listing merges files from PAN root folder and direct-child upload subfolder
      {
        const req = new Request('http://localhost/api/documents', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.success, true);
        assert.strictEqual(json.documents.length, 3, 'Should merge 2 PAN files + 1 upload folder file');

        const docIds = json.documents.map((d: any) => d.id);
        assert.ok(docIds.includes('doc-file-1'), 'Must include doc-file-1 from PAN root folder');
        assert.ok(docIds.includes('doc-file-2'), 'Must include doc-file-2 from PAN root folder');
        assert.ok(docIds.includes('doc-uploaded-1'), 'Must include doc-uploaded-1 from upload subfolder');

        // Confirm no folders or shortcuts in document list
        for (const doc of json.documents) {
          assert.notStrictEqual(doc.mimeType, 'application/vnd.google-apps.folder');
          assert.notStrictEqual(doc.mimeType, 'application/vnd.google-apps.shortcut');
        }
        console.log('✓ Test 10A Passed: Document listing merges files from PAN root and upload/ subfolder');
      }

      // 10B. Document listing works seamlessly when client has no upload subfolder yet
      {
        const req = new Request('http://localhost/api/documents', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-new-client' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.success, true);
        assert.ok(Array.isArray(json.documents));
        assert.strictEqual(json.documents.length, 0, 'New client without upload subfolder returns empty array safely');
        console.log('✓ Test 10B Passed: Document listing succeeds without error when upload/ subfolder does not exist');
      }

      // 10C. Client upload when upload/ subfolder already exists: file is placed into upload/ subfolder
      {
        lastUploadedParents = [];
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'Client_Tax_Return.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.success, true);
        assert.strictEqual(json.data.document.name, 'Client_Tax_Return.pdf');

        // Verify parents of uploaded file: MUST be the 'upload' subfolder ID, NOT the PAN root folder
        assert.deepStrictEqual(
          lastUploadedParents,
          ['upload-folder-active-123'],
          'File must be uploaded into direct-child upload subfolder'
        );
        console.log('✓ Test 10C Passed: Upload places file into existing upload/ subfolder (parents: upload folder ID)');
      }

      // 10D. Client upload when upload/ subfolder does NOT exist: creates upload/ subfolder as direct child and uploads into it
      {
        lastCreatedFolder = null;
        lastUploadedParents = [];
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'Initial_Registration.pdf', { type: 'application/pdf' }));
        const req = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-new-client' },
          body: fd
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        const json: any = await res.json();
        assert.strictEqual(json.success, true);

        // Verify folder creation call
        assert.ok(lastCreatedFolder, 'Should have called Google Drive files.create to create upload folder');
        assert.strictEqual(lastCreatedFolder.name, 'upload');
        assert.strictEqual(lastCreatedFolder.mimeType, 'application/vnd.google-apps.folder');
        assert.deepStrictEqual(
          lastCreatedFolder.parents,
          ['folder-new-client-789'],
          'Upload folder must be created as direct child of authoritative PAN folder'
        );

        // Verify upload destination
        assert.deepStrictEqual(
          lastUploadedParents,
          ['created-upload-folder-789'],
          'File must be placed inside newly created upload folder'
        );
        console.log('✓ Test 10D Passed: Upload automatically creates upload/ subfolder as direct child when missing');
      }

      // 10E. Security: Rejection of client-supplied destinationFolderId or destination_folder in query, headers, or form
      {
        // 10E.1 In query string
        const reqQuery = new Request('http://localhost/api/documents/upload?destinationFolderId=evil-folder-123', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer token-active-123',
            'Content-Type': 'multipart/form-data; boundary=----boundary'
          },
          body: '------boundary--'
        });
        const resQuery = await app.request(reqQuery, {}, workerEnv);
        assert.strictEqual(resQuery.status, 400);
        const jsonQuery: any = await resQuery.json();
        assert.ok(JSON.stringify(jsonQuery).includes('destinationFolderId'));

        // 10E.2 In custom header
        const reqHeader = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer token-active-123',
            'X-Destination-Folder-Id': 'evil-folder-123',
            'Content-Type': 'multipart/form-data; boundary=----boundary'
          },
          body: '------boundary--'
        });
        const resHeader = await app.request(reqHeader, {}, workerEnv);
        assert.strictEqual(resHeader.status, 400);
        const jsonHeader: any = await resHeader.json();
        assert.ok(JSON.stringify(jsonHeader).includes('x-destination-folder-id'));

        // 10E.3 In multipart field (destinationFolderId)
        const fdForm1 = new FormData();
        fdForm1.append('destinationFolderId', 'evil-folder-123');
        fdForm1.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        const reqForm1 = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fdForm1
        });
        const resForm1 = await app.request(reqForm1, {}, workerEnv);
        assert.strictEqual(resForm1.status, 400);
        const jsonForm1: any = await resForm1.json();
        assert.ok(JSON.stringify(jsonForm1).includes('destinationFolderId'));

        // 10E.4 In multipart field (destination_folder)
        const fdForm2 = new FormData();
        fdForm2.append('destination_folder', 'evil-folder-123');
        fdForm2.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        const reqForm2 = new Request('http://localhost/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-active-123' },
          body: fdForm2
        });
        const resForm2 = await app.request(reqForm2, {}, workerEnv);
        assert.strictEqual(resForm2.status, 400);
        const jsonForm2: any = await resForm2.json();
        assert.ok(JSON.stringify(jsonForm2).includes('destination_folder'));

        console.log('✓ Test 10E Passed: Client-supplied destination folder fields strictly rejected across query, headers, and form data');
      }

      // 10F. Download authorization for file in upload/ subfolder succeeds
      {
        const req = new Request('http://localhost/api/documents/doc-uploaded-1/download', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('Content-Type'), 'application/pdf');
        const text = await res.text();
        assert.strictEqual(text, 'Mock Binary Content of Client_Self_Uploaded.pdf');
        console.log('✓ Test 10F Passed: Download of file located in client\'s upload/ subfolder is authorized');
      }

      // 10G. Download authorization IDOR rejection for file in another client's upload folder
      {
        const req = new Request('http://localhost/api/documents/doc-uploaded-other-client/download', {
          method: 'GET',
          headers: { Authorization: 'Bearer token-active-123' }
        });
        const res = await app.request(req, {}, workerEnv);
        assert.strictEqual(res.status, 404, 'Must return 404 to prevent IDOR and tenant enumeration');
        const json: any = await res.json();
        assert.strictEqual(json.success, false);
        console.log('✓ Test 10G Passed: Attempt to download file in another client\'s upload folder strictly rejected with 404');
      }
    }

    // ==========================================================
    // TEST 11: Production Verification Case: Client PAN BWJPB0442B Uploader Attribution
    // ==========================================================
    {
      const validPdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xc4, 0xe5, 0xf2, 0xe5]);

      // 11A. GET /api/documents for client PAN BWJPB0442B
      // UDYAM-ONELOOP.pdf is directly inside Client Documents/BWJPB0442B/ -> Uploaded by: Administrator
      // pdf-sample_0.pdf is inside Client Documents/BWJPB0442B/upload/ -> Uploaded by: Jatin Bhuchhda
      const req = new Request('http://localhost/api/documents', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-pan-client-bwjpb' }
      });
      const res = await app.request(req, {}, workerEnv);
      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.documents.length, 2);

      const adminDoc = json.documents.find((d: any) => d.name === 'UDYAM-ONELOOP.pdf');
      assert.ok(adminDoc, 'UDYAM-ONELOOP.pdf must be present in documents list');
      assert.strictEqual(adminDoc.uploaderType, 'administrator');
      assert.strictEqual(adminDoc.uploaderName, 'Administrator');

      const clientDoc = json.documents.find((d: any) => d.name === 'pdf-sample_0.pdf');
      assert.ok(clientDoc, 'pdf-sample_0.pdf must be present in documents list');
      assert.strictEqual(clientDoc.uploaderType, 'client');
      assert.strictEqual(clientDoc.uploaderName, 'Jatin Bhuchhda');

      console.log('✓ Test 11A Passed: GET /api/documents correctly attributes Administrator vs Client documents for PAN BWJPB0442B');

      // 11B. POST /api/documents/upload for client PAN BWJPB0442B
      const fd = new FormData();
      fd.append('file', new File([validPdfBytes], 'Client_ITR_V.pdf', { type: 'application/pdf' }));
      const reqUpload = new Request('http://localhost/api/documents/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-pan-client-bwjpb' },
        body: fd
      });
      const resUpload = await app.request(reqUpload, {}, workerEnv);
      assert.strictEqual(resUpload.status, 200);
      const jsonUpload: any = await resUpload.json();
      assert.strictEqual(jsonUpload.success, true);
      assert.strictEqual(jsonUpload.data.document.uploaderType, 'client');
      assert.strictEqual(jsonUpload.data.document.uploaderName, 'Jatin Bhuchhda');

      console.log('✓ Test 11B Passed: POST /api/documents/upload returns uploaderType "client" and uploaderName "Jatin Bhuchhda"');
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

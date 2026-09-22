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

  // Seed inactive client
  memoryUsers.set('client-inactive-1', {
    name: 'Inactive Client',
    email: 'inactive.client@example.com',
    phone: '+919876543219',
    panNumber: 'INACT1234A',
    driveFolderId: 'folder-inact-client',
    role: 'client',
    status: 'inactive',
    createdAt: new Date().toISOString()
  });

  // Seed client with missing driveFolderId
  memoryUsers.set('client-missing-folder', {
    name: 'No Folder Client',
    email: 'nofolder@example.com',
    phone: '+919876543218',
    panNumber: 'NOFLD1234A',
    driveFolderId: '',
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
  let lastAdminUploadParents: string[] = [];
  let lastAdminUploadName = '';
  const memoryDocumentPasswords = new Map<string, any>();
  const deletedDriveFilesSet = new Set<string>();
  const deletedDriveFileIds: string[] = [];
  const deletedPasswordDocIds: string[] = [];
  let simulateDriveDeleteFailure = false;
  let simulateFirestorePasswordDeleteFailure = false;
  let firestoreUserPatchCount = 0;

  // Seed document password metadata for doc-pan-root-1
  memoryDocumentPasswords.set('doc-pan-root-1', {
    driveFileId: 'doc-pan-root-1',
    clientId: 'client-user-1',
    isPasswordProtected: true,
    encryptedPassword: 'mock-encrypted-password',
    iv: 'mock-iv',
    algorithm: 'AES-256-GCM',
    keyVersion: '1'
  });

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
        firestoreUserPatchCount++;
        if (failAtStep === 'firestore') {
          return new Response(JSON.stringify({ error: { message: 'Firestore simulated write failure' } }), { status: 500 });
        }
        const body = JSON.parse(init.body as string);
        const existing = memoryUsers.get(uid) || {};
        const saved: Record<string, any> = { ...existing };
        for (const [k, v] of Object.entries(body.fields || {})) {
          if (v && typeof v === 'object') {
            if ('stringValue' in (v as any)) saved[k] = (v as any).stringValue;
            else if ('booleanValue' in (v as any)) saved[k] = (v as any).booleanValue;
            else if ('integerValue' in (v as any)) saved[k] = Number((v as any).integerValue);
            else if ('timestampValue' in (v as any)) saved[k] = (v as any).timestampValue;
            else saved[k] = v;
          } else {
            saved[k] = v;
          }
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

    // documentPasswords collection operations
    if (url.includes('/databases/(default)/documents/documentPasswords/')) {
      const parts = url.split('/documents/documentPasswords/');
      const docId = decodeURIComponent(parts[1].split('?')[0]);
      if (init?.method === 'DELETE') {
        if (simulateFirestorePasswordDeleteFailure) {
          return new Response(
            JSON.stringify({ error: { message: 'Firestore simulated delete error', code: 500 } }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          );
        }
        deletedPasswordDocIds.push(docId);
        if (memoryDocumentPasswords.has(docId)) {
          memoryDocumentPasswords.delete(docId);
          return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        // If not in memory, Firestore REST API returns 404
        return new Response(
          JSON.stringify({ error: { code: 404, message: 'Document not found' } }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (init?.method === 'GET') {
        const record = memoryDocumentPasswords.get(docId);
        if (!record) {
          return new Response(JSON.stringify({ error: { code: 404, message: 'Document not found' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        const fields: Record<string, any> = {};
        for (const [k, v] of Object.entries(record)) {
          if (typeof v === 'boolean') {
            fields[k] = { booleanValue: v };
          } else {
            fields[k] = { stringValue: String(v) };
          }
        }
        return new Response(JSON.stringify({ name: `documentPasswords/${docId}`, fields }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
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

    // Drive delete file or folder
    if (init?.method === 'DELETE' && url.includes('/drive/v3/files/')) {
      const fileId = decodeURIComponent(url.split('/drive/v3/files/')[1].split('?')[0]);
      if (simulateDriveDeleteFailure) {
        return new Response(
          JSON.stringify({ error: { message: 'Drive simulated delete error', code: 500 } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
      deletedDriveFileIds.push(fileId);
      deletedDriveFilesSet.add(fileId);
      memoryDriveFolders.delete(fileId);
      return new Response(null, { status: 204 });
    }

    // Drive create folder
    if (init?.method === 'POST' && url.includes('/drive/v3/files') && !url.includes('/upload/')) {
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

    // Drive search 'upload' subfolder
    if (url.includes('/drive/v3/files?') && (url.includes("name = 'upload'") || url.includes("name+%3D+%27upload%27") || url.includes("name%3D%27upload%27"))) {
      if (url.includes('folder-reg-client')) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'upload-folder-reg-client',
                name: 'upload',
                mimeType: 'application/vnd.google-apps.folder',
                trashed: false,
                parents: ['folder-reg-client']
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Drive list files in folder
    if (url.includes('/drive/v3/files?') && !url.includes('/upload/') && !url.includes('Client Documents') && !url.includes('Client+Documents')) {
      const decodedUrl = decodeURIComponent(url);
      if (decodedUrl.includes('upload-folder-reg-client')) {
        // Files inside upload subfolder
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'doc-upload-subfolder-1',
                name: 'Client_Submitted.pdf',
                mimeType: 'application/pdf',
                size: '102400',
                createdTime: '2026-09-05T12:00:00Z',
                modifiedTime: '2026-09-05T12:00:00Z',
                parents: ['upload-folder-reg-client'],
                trashed: false
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (decodedUrl.includes('folder-reg-client')) {
        // Files directly in PAN folder (pan_root)
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'doc-pan-root-1',
                name: 'PAN_Statement.pdf',
                mimeType: 'application/pdf',
                size: '204800',
                createdTime: '2026-09-01T10:00:00Z',
                modifiedTime: '2026-09-01T10:00:00Z',
                parents: ['folder-reg-client'],
                trashed: false
              },
              {
                id: 'doc-shortcut-1',
                name: 'Ignored_Shortcut',
                mimeType: 'application/vnd.google-apps.shortcut',
                size: '0',
                createdTime: '2026-09-01T10:00:00Z',
                modifiedTime: '2026-09-01T10:00:00Z',
                parents: ['folder-reg-client'],
                trashed: false
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Drive download file stream (alt=media)
    if (url.includes('/drive/v3/files/') && url.includes('alt=media')) {
      if (url.includes('doc-pan-root-1')) {
        return new Response('Mock Binary Content of PAN_Statement.pdf', {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': '34'
          }
        });
      }
      if (url.includes('doc-upload-subfolder-1')) {
        return new Response('Mock Binary Content of Client_Submitted.pdf', {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': '36'
          }
        });
      }
      return new Response('Not found', { status: 404 });
    }

    // Drive get file metadata (fields=...)
    if (url.includes('/drive/v3/files/') && url.includes('fields=')) {
      for (const deletedId of deletedDriveFilesSet) {
        if (url.includes(`/drive/v3/files/${deletedId}?`)) {
          return new Response(JSON.stringify({ error: { code: 404, message: 'File not found' } }), { status: 404 });
        }
      }
      if (url.includes('/drive/v3/files/doc-pan-root-1?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-pan-root-1',
            name: 'PAN_Statement.pdf',
            mimeType: 'application/pdf',
            size: '204800',
            parents: ['folder-reg-client'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-upload-subfolder-1?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-upload-subfolder-1',
            name: 'Client_Submitted.pdf',
            mimeType: 'application/pdf',
            size: '102400',
            parents: ['upload-folder-reg-client'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-double-delete-1?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-double-delete-1',
            name: 'Double_Delete.pdf',
            mimeType: 'application/pdf',
            size: '102400',
            parents: ['folder-reg-client'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-fail-drive-1?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-fail-drive-1',
            name: 'Fail_Drive.pdf',
            mimeType: 'application/pdf',
            size: '102400',
            parents: ['folder-reg-client'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-fail-fs-1?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-fail-fs-1',
            name: 'Fail_FS.pdf',
            mimeType: 'application/pdf',
            size: '102400',
            parents: ['folder-reg-client'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-shortcut-1?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-shortcut-1',
            name: 'Shortcut_Doc',
            mimeType: 'application/vnd.google-apps.shortcut',
            size: '0',
            parents: ['folder-reg-client'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-other-client-file?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-other-client-file',
            name: 'Alien_Secret.pdf',
            mimeType: 'application/pdf',
            size: '50000',
            parents: ['foreign-client-folder-999'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-trashed-file?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-trashed-file',
            name: 'Deleted.pdf',
            mimeType: 'application/pdf',
            size: '1000',
            parents: ['folder-reg-client'],
            trashed: true
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/drive/v3/files/doc-folder-as-file?')) {
        return new Response(
          JSON.stringify({
            id: 'doc-folder-as-file',
            name: 'Subfolder',
            mimeType: 'application/vnd.google-apps.folder',
            size: '0',
            parents: ['folder-reg-client'],
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: { code: 404, message: 'File not found' } }), { status: 404 });
    }

    // Drive REST endpoint: File upload (uploadType=multipart)
    if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
      let bodyText = '';
      if (init?.body instanceof Uint8Array) {
        bodyText = new TextDecoder().decode(init.body);
      }
      let uploadedName = 'uploaded_doc.pdf';
      const nameMatch = bodyText.match(/"name":"([^"]+)"/);
      if (nameMatch) {
        uploadedName = nameMatch[1];
      }
      lastAdminUploadName = uploadedName;

      const parentsMatch = bodyText.match(/"parents":\["([^"]+)"\]/);
      if (parentsMatch) {
        lastAdminUploadParents = [parentsMatch[1]];
      } else {
        lastAdminUploadParents = [];
      }

      return new Response(
        JSON.stringify({
          id: `uploaded-admin-doc-${nextFolderIdCounter++}`,
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
          createdTime: new Date().toISOString()
        }),
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

    // =========================================================================
    // STEP 26D: ADMIN CLIENT DOCUMENT REPOSITORY & DOWNLOAD API TESTS (9-17)
    // =========================================================================

    // ==========================================
    // TEST 9: List Documents - Unauthenticated / Missing Bearer Token (401)
    // ==========================================
    console.log('Test 9: Admin Documents List - Unauthenticated (401)');
    const resListUnauth = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-user-1/documents', {
        method: 'GET'
      }),
      workerEnv
    );
    assert.strictEqual(resListUnauth.status, 401);
    console.log('✓ Test 9 Passed: 401 Unauthorized for missing admin token');

    // ==========================================
    // TEST 10: List Documents - Non-Admin Access Denied (403)
    // ==========================================
    console.log('Test 10: Admin Documents List - Non-Admin Access Denied (403)');
    const resListNonAdmin = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-user-1/documents', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-client-nonadmin' }
      }),
      workerEnv
    );
    assert.strictEqual(resListNonAdmin.status, 403);
    console.log('✓ Test 10 Passed: 403 Forbidden for non-admin client token');

    // ==========================================
    // TEST 11: List Documents - Inactive Admin Access Denied (403)
    // ==========================================
    console.log('Test 11: Admin Documents List - Inactive Admin Access Denied (403)');
    const resListInactiveAdmin = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-user-1/documents', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-admin-inactive' }
      }),
      workerEnv
    );
    assert.strictEqual(resListInactiveAdmin.status, 403);
    console.log('✓ Test 11 Passed: 403 Forbidden for inactive admin');

    // ==========================================
    // TEST 12: List Documents - Non-Existent Client UID (404)
    // ==========================================
    console.log('Test 12: Admin Documents List - Non-Existent Client UID (404)');
    const resListUnknownClient = await app.fetch(
      new Request('https://worker.local/api/admin/clients/ghost-client-999/documents', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-admin-valid' }
      }),
      workerEnv
    );
    assert.strictEqual(resListUnknownClient.status, 404);
    console.log('✓ Test 12 Passed: 404 Not Found for non-existent client UID');

    // ==========================================
    // TEST 13: List Documents - Inactive Client (403 Forbidden)
    // ==========================================
    console.log('Test 13: Admin Documents List - Inactive Client (403)');
    const resListInactiveClient = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-inactive-1/documents', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-admin-valid' }
      }),
      workerEnv
    );
    assert.strictEqual(resListInactiveClient.status, 403);
    console.log('✓ Test 13 Passed: 403 Forbidden when client account is inactive');

    // ==========================================
    // TEST 14: List Documents - Client Missing Google Drive Folder (400 Bad Request)
    // ==========================================
    console.log('Test 14: Admin Documents List - Missing Drive Folder (400)');
    const resListNoFolder = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-missing-folder/documents', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-admin-valid' }
      }),
      workerEnv
    );
    assert.strictEqual(resListNoFolder.status, 400);
    console.log('✓ Test 14 Passed: 400 Bad Request when client has no driveFolderId configured');

    // ==========================================
    // TEST 15: List Documents - Successful Complete Repository Listing (200 OK)
    // ==========================================
    console.log('Test 15: Admin Documents List - Complete Repository Listing (200)');
    const resListSuccess = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-user-1/documents', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-admin-valid' }
      }),
      workerEnv
    );
    assert.strictEqual(resListSuccess.status, 200);
    const listBody: any = await resListSuccess.json();
    assert.strictEqual(listBody.success, true);
    assert.strictEqual(listBody.data.clientId, 'client-user-1');
    assert.strictEqual(listBody.data.panFolderId, 'folder-reg-client');
    assert.ok(listBody.data.uploadFolder);
    assert.strictEqual(listBody.data.uploadFolder.id, 'upload-folder-reg-client');
    assert.strictEqual(listBody.data.uploadFolder.name, 'upload');

    // Check documents: Should include PAN root file and upload folder file, filtering out shortcuts
    const docs = listBody.data.documents;
    assert.strictEqual(docs.length, 2);

    const panRootDoc = docs.find((d: any) => d.documentId === 'doc-pan-root-1');
    assert.ok(panRootDoc, 'PAN root file must be present');
    assert.strictEqual(panRootDoc.folderType, 'pan_root');
    assert.strictEqual(panRootDoc.uploaderType, 'administrator');
    assert.strictEqual(panRootDoc.uploaderName, 'Administrator');
    assert.strictEqual(panRootDoc.name, 'PAN_Statement.pdf');

    const uploadSubfolderDoc = docs.find((d: any) => d.documentId === 'doc-upload-subfolder-1');
    assert.ok(uploadSubfolderDoc, 'Upload subfolder file must be present');
    assert.strictEqual(uploadSubfolderDoc.folderType, 'upload_folder');
    assert.strictEqual(uploadSubfolderDoc.uploaderType, 'client');
    assert.strictEqual(uploadSubfolderDoc.uploaderName, 'Regular Client');
    assert.strictEqual(uploadSubfolderDoc.name, 'Client_Submitted.pdf');

    console.log('✓ Test 15 Passed: Complete repository correctly listed with PAN root and upload files');

    // ==========================================
    // TEST 16: Admin Document Download - Authorized PAN Root and Upload Files (200 OK)
    // ==========================================
    console.log('Test 16: Admin Document Download - Authorized Files (200)');
    // Download PAN root file
    const resDownloadPanRoot = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-pan-root-1/download', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-admin-valid' }
      }),
      workerEnv
    );
    assert.strictEqual(resDownloadPanRoot.status, 200);
    assert.strictEqual(resDownloadPanRoot.headers.get('Content-Type'), 'application/pdf');
    assert.ok(resDownloadPanRoot.headers.get('Content-Disposition')?.includes('PAN_Statement.pdf'));
    const panRootText = await resDownloadPanRoot.text();
    assert.strictEqual(panRootText, 'Mock Binary Content of PAN_Statement.pdf');

    // Download upload subfolder file
    const resDownloadUploadSub = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-upload-subfolder-1/download', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-admin-valid' }
      }),
      workerEnv
    );
    assert.strictEqual(resDownloadUploadSub.status, 200);
    assert.strictEqual(resDownloadUploadSub.headers.get('Content-Type'), 'application/pdf');
    assert.ok(resDownloadUploadSub.headers.get('Content-Disposition')?.includes('Client_Submitted.pdf'));
    const uploadSubText = await resDownloadUploadSub.text();
    assert.strictEqual(uploadSubText, 'Mock Binary Content of Client_Submitted.pdf');
    console.log('✓ Test 16 Passed: Successful download of both PAN root and upload subfolder documents');

    // ==========================================
    // TEST 17: Admin Document Download - Strict IDOR Prevention & Traversal Defense
    // ==========================================
    console.log('Test 17: Admin Document Download - IDOR Prevention & Input Validation');
    // 17A: Cross-client file access attempt (file belongs to a different client) -> must 404
    const resCrossClient = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-other-client-file/download', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-admin-valid' }
      }),
      workerEnv
    );
    assert.strictEqual(resCrossClient.status, 404, 'Cross-client file must be rejected with 404');

    // 17B: Trashed file attempt -> must 404
    const resTrashed = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-trashed-file/download', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-admin-valid' }
      }),
      workerEnv
    );
    assert.strictEqual(resTrashed.status, 404, 'Trashed file must be rejected with 404');

    // 17C: Attempt to download a folder as a file -> must 404
    const resFolderDownload = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-folder-as-file/download', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-admin-valid' }
      }),
      workerEnv
    );
    assert.strictEqual(resFolderDownload.status, 404, 'Folder download must be rejected with 404');

    // 17D: Malformed document ID / Path traversal attempt -> must 400
    const resTraversal = await app.fetch(
      new Request('https://worker.local/api/admin/clients/client-user-1/documents/..%2F..%2Fsecret/download', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-admin-valid' }
      }),
      workerEnv
    );
    assert.strictEqual(resTraversal.status, 400, 'Path traversal documentId must be rejected with 400');

    console.log('✓ Test 17 Passed: Strict IDOR defense, trashed rejection, and input validation verified');

    // =========================================================================
    // ADMIN DOCUMENT UPLOAD TESTS: POST /api/admin/clients/:clientId/documents/upload
    // =========================================================================
    console.log('\n--- Starting Tests for Admin Document Upload Endpoint ---');

    const validPdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xc4, 0xe5, 0xf2, 0xe5]);
    const validJpgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const validPngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const validXlsBytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    const validXlsxBytes = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00,
      ...new TextEncoder().encode('[Content_Types].xml'),
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]);

    // Req 1: Route is registered and reachable
    {
      const healthRes = await app.fetch(new Request('https://worker.local/api/health', { method: 'GET' }), workerEnv);
      const healthJson: any = await healthRes.json();
      assert.ok(healthJson.data.endpoints.adminClientDocumentUpload, 'Route must be registered in health endpoints');
      console.log('✓ Req 1 Passed: Route is registered and registered in health catalog');
    }

    // Req 2 & 3: Unauthenticated & Missing Bearer token -> 401
    {
      const fd = new FormData();
      fd.append('file', new File([validPdfBytes], 'admin_doc.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 401, 'Unauthenticated upload must be rejected with 401');
      console.log('✓ Req 2 & 3 Passed: Missing/unauthenticated token rejected with 401');
    }

    // Req 4: Invalid Bearer token -> 401
    {
      const fd = new FormData();
      fd.append('file', new File([validPdfBytes], 'admin_doc.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-malformed-invalid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 401, 'Invalid token must be rejected with 401');
      console.log('✓ Req 4 Passed: Invalid Bearer token rejected with 401');
    }

    // Req 5 & 6: Authenticated client role / non-admin -> 403
    {
      const fd = new FormData();
      fd.append('file', new File([validPdfBytes], 'admin_doc.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-client-nonadmin' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 403, 'Client role must be forbidden from admin upload (403)');
      console.log('✓ Req 5 & 6 Passed: Non-admin / client role rejected with 403');
    }

    // Req 7: Inactive administrator -> 403
    {
      const fd = new FormData();
      fd.append('file', new File([validPdfBytes], 'admin_doc.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-inactive' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 403, 'Inactive administrator must be rejected with 403');
      console.log('✓ Req 7 Passed: Inactive administrator rejected with 403');
    }

    // Req 8: Nonexistent clientId -> 404
    {
      const fd = new FormData();
      fd.append('file', new File([validPdfBytes], 'admin_doc.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/nonexistent-client-id/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 404, 'Nonexistent clientId must return 404');
      console.log('✓ Req 8 Passed: Nonexistent clientId returns 404');
    }

    // Req 9: Inactive client -> 403
    {
      const fd = new FormData();
      fd.append('file', new File([validPdfBytes], 'admin_doc.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-inactive-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 403, 'Inactive client must return 403');
      console.log('✓ Req 9 Passed: Inactive client returns 403');
    }

    // Req 10: Target client missing driveFolderId fails safely -> 400
    {
      const fd = new FormData();
      fd.append('file', new File([validPdfBytes], 'admin_doc.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-missing-folder/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 400, 'Missing driveFolderId must return 400');
      console.log('✓ Req 10 Passed: Target client missing driveFolderId fails safely (400)');
    }

    // Req 11: Missing file field in multipart form data -> 400
    {
      const fd = new FormData();
      fd.append('description', 'Missing file');
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 400, 'Missing file field must return 400');
      const json: any = await res.json();
      assert.strictEqual(json.success, false);
      console.log('✓ Req 11 Passed: Missing file field in multipart form data returns 400');
    }

    // Req 12: Empty file (0 bytes) returns 400
    {
      const fd = new FormData();
      fd.append('file', new File([new Uint8Array(0)], 'empty.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 400, 'Empty file must return 400');
      console.log('✓ Req 12 Passed: Empty file (0 bytes) returns 400');
    }

    // Req 13: Supported PDF upload succeeds
    {
      const fd = new FormData();
      fd.append('file', new File([validPdfBytes], 'Notice_Assessment.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200, 'PDF upload must return 200');
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.data.document.name, 'Notice_Assessment.pdf');
      assert.strictEqual(json.data.document.mimeType, 'application/pdf');
      console.log('✓ Req 13 Passed: Supported PDF upload succeeds');
    }

    // Req 14: Supported JPG upload succeeds
    {
      const fd = new FormData();
      fd.append('file', new File([validJpgBytes], 'Tax_Receipt.jpg', { type: 'image/jpeg' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200, 'JPG upload must return 200');
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.data.document.mimeType, 'image/jpeg');
      console.log('✓ Req 14 Passed: Supported JPG upload succeeds');
    }

    // Req 15: Supported JPEG upload succeeds
    {
      const fd = new FormData();
      fd.append('file', new File([validJpgBytes], 'Form16_Challan.jpeg', { type: 'image/jpeg' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200, 'JPEG upload must return 200');
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.data.document.mimeType, 'image/jpeg');
      console.log('✓ Req 15 Passed: Supported JPEG upload succeeds');
    }

    // Req 16: Supported PNG upload succeeds
    {
      const fd = new FormData();
      fd.append('file', new File([validPngBytes], 'Digital_Signature.png', { type: 'image/png' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200, 'PNG upload must return 200');
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.data.document.mimeType, 'image/png');
      console.log('✓ Req 16 Passed: Supported PNG upload succeeds');
    }

    // Req 17: Supported XLS upload succeeds
    {
      const fd = new FormData();
      fd.append('file', new File([validXlsBytes], 'Depreciation_Schedule.xls', { type: 'application/vnd.ms-excel' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200, 'XLS upload must return 200');
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.data.document.mimeType, 'application/vnd.ms-excel');
      console.log('✓ Req 17 Passed: Supported XLS upload succeeds');
    }

    // Req 18: Supported XLSX upload succeeds
    {
      const fd = new FormData();
      fd.append('file', new File([validXlsxBytes], 'Tax_Audit_2026.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200, 'XLSX upload must return 200');
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.data.document.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      console.log('✓ Req 18 Passed: Supported XLSX upload succeeds');
    }

    // Req 19: Unsupported file type returns 400
    {
      const unsupportedExts = ['malware.exe', 'archive.zip', 'notes.txt', 'script.js'];
      for (const badName of unsupportedExts) {
        const fd = new FormData();
        fd.append('file', new File([new TextEncoder().encode('unsupported')], badName, { type: 'text/plain' }));
        const res = await app.fetch(
          new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
            method: 'POST',
            headers: { Authorization: 'Bearer token-admin-valid' },
            body: fd
          }),
          workerEnv
        );
        assert.strictEqual(res.status, 400, `Unsupported file '${badName}' must return 400`);
      }
      console.log('✓ Req 19 Passed: Unsupported file types (.txt, .exe, .zip) return 400');
    }

    // Req 20: MIME spoofing / corrupted content failing magic bytes returns 400
    {
      const fakePdfBytes = new TextEncoder().encode('<html>Fake PDF content</html>');
      const fd = new FormData();
      fd.append('file', new File([fakePdfBytes], 'Spoofed.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 400, 'MIME spoofing must be rejected with 400');
      const json: any = await res.json();
      assert.strictEqual(json.success, false);
      console.log('✓ Req 20 Passed: MIME spoofing / corrupted content failing magic bytes returns 400');
    }

    // Req 21: File >15 MB is rejected (413)
    {
      const oversizedBytes = new Uint8Array(15 * 1024 * 1024 + 1024);
      oversizedBytes.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34], 0);
      const fd = new FormData();
      fd.append('file', new File([oversizedBytes], 'Giant_File.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 413, 'File >15 MB must be rejected with 413');
      const json: any = await res.json();
      assert.strictEqual(json.success, false);
      assert.strictEqual(json.error.code, 'PAYLOAD_TOO_LARGE');
      console.log('✓ Req 21 Passed: File >15 MB is rejected with 413 Payload Too Large');
    }

    // Req 22 & 23: Document stored directly in PAN root folder (driveFolderId), NEVER in /upload
    {
      const fd = new FormData();
      fd.append('file', new File([validPdfBytes], 'Final_Computation.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(lastAdminUploadParents, ['folder-reg-client'], 'Must upload to PAN root folder');
      assert.notStrictEqual(lastAdminUploadParents[0], 'upload-folder-reg-client', 'Must NEVER upload to /upload subfolder');
      const json: any = await res.json();
      assert.strictEqual(json.data.document.folderType, 'pan_root');
      console.log('✓ Req 22 & 23 Passed: Stored directly in PAN root (driveFolderId), never in /upload subfolder');
    }

    // Req 24 & 25: uploaderType = 'administrator' and uploaderName = 'Administrator'
    {
      const fd = new FormData();
      fd.append('file', new File([validPdfBytes], 'Official_Order.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.data.document.uploaderType, 'administrator');
      assert.strictEqual(json.data.document.uploaderName, 'Administrator');
      assert.strictEqual(json.document.uploaderType, 'administrator');
      assert.strictEqual(json.document.uploaderName, 'Administrator');
      console.log('✓ Req 24 & 25 Passed: uploaderType is "administrator" and uploaderName is "Administrator"');
    }

    // Req 26, 27, 28, 29: Client-supplied driveFolderId, uploaderType, uploaderName, PAN rejected (400)
    {
      const forbiddenParams = [
        { key: 'driveFolderId', val: 'fake-hacked-folder' },
        { key: 'folderId', val: 'fake-hacked-folder' },
        { key: 'uploaderType', val: 'client' },
        { key: 'uploaderName', val: 'Hacked Admin' },
        { key: 'pan', val: 'HACK1234F' },
        { key: 'panNumber', val: 'HACK1234F' }
      ];

      for (const item of forbiddenParams) {
        const fd = new FormData();
        fd.append('file', new File([validPdfBytes], 'doc.pdf', { type: 'application/pdf' }));
        fd.append(item.key, item.val);
        const res = await app.fetch(
          new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
            method: 'POST',
            headers: { Authorization: 'Bearer token-admin-valid' },
            body: fd
          }),
          workerEnv
        );
        assert.strictEqual(res.status, 400, `Forbidden form field '${item.key}' must be rejected with 400`);
      }

      // Also verify query parameter rejection
      const resQuery = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload?driveFolderId=hacked', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(resQuery.status, 400, 'Forbidden query parameter driveFolderId must return 400');
      console.log('✓ Req 26-29 Passed: Client-supplied driveFolderId, uploaderType, uploaderName, and PAN rejected (400)');
    }

    // Req 30: Filename sanitization is applied (path traversal sequences stripped)
    {
      const fd = new FormData();
      fd.append('file', new File([validPdfBytes], '../../etc/passwd/TaxNotice.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.ok(!json.data.document.name.includes('../'), 'Path traversal must be stripped from filename');
      assert.ok(!lastAdminUploadName.includes('../'), 'Path traversal must be stripped from uploaded file name');
      console.log('✓ Req 30 Passed: Filename sanitization applied and path traversal stripped');
    }

    // Bonus: Duplicate filename protection in client's PAN root folder
    {
      // 'PAN_Statement.pdf' already exists in folder-reg-client
      const fd = new FormData();
      fd.append('file', new File([validPdfBytes], 'PAN_Statement.pdf', { type: 'application/pdf' }));
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-admin-valid' },
          body: fd
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200);
      const json: any = await res.json();
      assert.strictEqual(json.data.document.name, 'PAN_Statement (1).pdf', 'Duplicate name must be resolved safely with counter');
      console.log('✓ Bonus Passed: Duplicate filename resolved safely without collision');
    }

    // ==========================================
    // STEP 26E: SECURE ADMIN DOCUMENT DELETION TESTS (23 Scenarios)
    // ==========================================
    console.log('\n--- Running STEP 26E: Secure Admin Document Deletion Tests ---\n');

    // Test 1: Unauthenticated request rejected with 401
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-pan-root-1', {
          method: 'DELETE'
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 401, 'Unauthenticated DELETE request must return 401');
      console.log('✓ Test 1 Passed: Unauthenticated request rejected (401)');
    }

    // Test 2: Normal client user token rejected with 403
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-pan-root-1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-client-nonadmin' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 403, 'Non-admin user token must be rejected with 403');
      console.log('✓ Test 2 Passed: Non-admin token rejected (403)');
    }

    // Test 3: Inactive admin token rejected with 403
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-pan-root-1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-inactive' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 403, 'Inactive admin token must be rejected with 403');
      console.log('✓ Test 3 Passed: Inactive admin token rejected (403)');
    }

    // Test 4: Nonexistent client rejected with 404
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-nonexistent-uid/documents/doc-pan-root-1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 404, 'Nonexistent client must return 404');
      console.log('✓ Test 4 Passed: Nonexistent client rejected (404)');
    }

    // Test 5: Inactive client rejected with 403
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-inactive-1/documents/doc-pan-root-1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 403, 'Inactive client must return 403');
      console.log('✓ Test 5 Passed: Inactive client rejected (403)');
    }

    // Test 6: Nonexistent document rejected with 404
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-nonexistent-999', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 404, 'Nonexistent document must return 404');
      console.log('✓ Test 6 Passed: Nonexistent document rejected (404)');
    }

    // Test 7: Document belonging to Client B requested under Client A (IDOR) rejected with 404
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-other-client-file', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 404, 'Cross-client IDOR document deletion must return 404');
      console.log('✓ Test 7 Passed: Cross-client IDOR access rejected (404)');
    }

    // Test 8: Document directly inside Client A PAN root deleted with 200
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-pan-root-1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200, 'PAN root document deletion must return 200');
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.message, 'Document deleted successfully.');
      assert.ok(deletedDriveFileIds.includes('doc-pan-root-1'), 'Drive delete must be called for doc-pan-root-1');
      assert.ok(
        res.headers.get('cache-control')?.includes('no-store'),
        'Response must have private no-store cache headers'
      );
      console.log('✓ Test 8 Passed: Document directly inside PAN root deleted (200)');
    }

    // Test 9: Document inside Client A /upload folder deleted with 200
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-upload-subfolder-1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200, '/upload folder document deletion must return 200');
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.ok(deletedDriveFileIds.includes('doc-upload-subfolder-1'), 'Drive delete must be called for doc-upload-subfolder-1');
      console.log('✓ Test 9 Passed: Document inside /upload folder deleted (200)');
    }

    // Test 10: Folder ID rejected with 404
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-folder-as-file', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 404, 'Folder ID must return 404');
      console.log('✓ Test 10 Passed: Folder ID rejected (404)');
    }

    // Test 11: Shortcut rejected with 404
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-shortcut-1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 404, 'Shortcut must return 404');
      console.log('✓ Test 11 Passed: Shortcut rejected (404)');
    }

    // Test 12: Trashed document rejected with 404
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-trashed-file', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 404, 'Trashed document must return 404');
      console.log('✓ Test 12 Passed: Trashed document rejected (404)');
    }

    // Test 13: Exact document ID passed to Drive delete
    {
      assert.ok(deletedDriveFileIds.includes('doc-pan-root-1'), 'Drive delete must be called with exact documentId');
      assert.ok(deletedDriveFileIds.includes('doc-upload-subfolder-1'), 'Drive delete must be called with exact documentId');
      console.log('✓ Test 13 Passed: Exact document ID passed to Google Drive deletion');
    }

    // Test 14: Password metadata cleanup (documentPasswords/{documentId} deleted)
    {
      assert.ok(deletedPasswordDocIds.includes('doc-pan-root-1'), 'Firestore delete must be called for doc-pan-root-1 password metadata');
      assert.strictEqual(memoryDocumentPasswords.has('doc-pan-root-1'), false, 'documentPasswords record must be deleted');
      console.log('✓ Test 14 Passed: Password metadata cleaned up from Firestore');
    }

    // Test 15: Drive deletion failure returns safe 502 and does NOT delete password metadata
    {
      simulateDriveDeleteFailure = true;
      memoryDocumentPasswords.set('doc-fail-drive-1', {
        driveFileId: 'doc-fail-drive-1',
        clientId: 'client-user-1',
        isPasswordProtected: true,
        encryptedPassword: 'encrypted-pw-test'
      });
      const initialDeletedPasswordsCount = deletedPasswordDocIds.length;

      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-fail-drive-1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 502, 'Drive failure must return 502 Bad Gateway');
      const json: any = await res.json();
      assert.strictEqual(json.success, false);
      assert.strictEqual(deletedPasswordDocIds.length, initialDeletedPasswordsCount, 'Password metadata delete must NOT be called if Drive delete fails');
      assert.strictEqual(memoryDocumentPasswords.has('doc-fail-drive-1'), true, 'Password metadata must remain intact in Firestore');

      simulateDriveDeleteFailure = false;
      console.log('✓ Test 15 Passed: Drive deletion failure halts execution and returns 502 without touching password metadata');
    }

    // Test 16: Firestore metadata deletion failure returns 500 without secondary Drive deletion
    {
      simulateFirestorePasswordDeleteFailure = true;
      memoryDocumentPasswords.set('doc-fail-fs-1', {
        driveFileId: 'doc-fail-fs-1',
        clientId: 'client-user-1',
        isPasswordProtected: true,
        encryptedPassword: 'encrypted-pw-test-2'
      });
      const driveDeletesBefore = deletedDriveFileIds.length;

      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-fail-fs-1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 500, 'Firestore metadata cleanup failure must return 500');
      const json: any = await res.json();
      assert.strictEqual(json.success, false);
      assert.strictEqual(json.error.code, 'METADATA_CLEANUP_ERROR');
      assert.strictEqual(deletedDriveFileIds.length, driveDeletesBefore + 1, 'Drive delete occurred exactly once');
      assert.ok(deletedDriveFileIds.includes('doc-fail-fs-1'), 'Drive delete was called for doc-fail-fs-1');

      // Subsequent delete on same doc returns 404 because file is already gone from Drive
      const res2 = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-fail-fs-1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res2.status, 404, 'Subsequent request on already-deleted Drive document returns 404');

      simulateFirestorePasswordDeleteFailure = false;
      console.log('✓ Test 16 Passed: Firestore metadata cleanup failure returns 500 with no secondary Drive delete');
    }

    // Test 17: Client-supplied driveFolderId rejected with 400
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-pan-root-1?driveFolderId=injected-folder', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 400, 'Forbidden query parameter driveFolderId must return 400');
      console.log('✓ Test 17 Passed: Client-supplied driveFolderId rejected (400)');
    }

    // Test 18: Client-supplied panNumber rejected with 400
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-pan-root-1?panNumber=ABCDE1234F', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 400, 'Forbidden query parameter panNumber must return 400');
      console.log('✓ Test 18 Passed: Client-supplied panNumber rejected (400)');
    }

    // Test 19: Password confidentiality (never in response, errors, or logs)
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-double-delete-1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      const text = await res.text();
      assert.ok(!text.includes('password'), 'Password must never appear in response body');
      assert.ok(!text.includes('encryptedPassword'), 'Encrypted password must never appear in response body');
      console.log('✓ Test 19 Passed: Password confidentiality preserved in all responses');
    }

    // Test 20: Double delete (first was done in Test 19, second returns 404)
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/documents/doc-double-delete-1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer token-admin-valid' }
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 404, 'Second delete request on same document must return 404');
      console.log('✓ Test 20 Passed: Double delete returns 404 on second attempt');
    }

    // Test 21: Invalid document ID rejected safely (400)
    {
      const invalidDocIds = ['..traversal', 'inv@lid!', 'abc', 'has space', 'a'.repeat(105)];
      for (const badDocId of invalidDocIds) {
        const res = await app.fetch(
          new Request(`https://worker.local/api/admin/clients/client-user-1/documents/${encodeURIComponent(badDocId)}`, {
            method: 'DELETE',
            headers: { Authorization: 'Bearer token-admin-valid' }
          }),
          workerEnv
        );
        assert.strictEqual(res.status, 400, `Invalid document ID '${badDocId}' must return 400`);
      }
      console.log('✓ Test 21 Passed: Invalid document IDs rejected safely (400)');
    }

    // Test 22: Invalid client ID rejected safely (400)
    {
      const invalidClientIds = ['..traversal', 'inv@lid!', 'has space', 'a'.repeat(130)];
      for (const badClientId of invalidClientIds) {
        const res = await app.fetch(
          new Request(`https://worker.local/api/admin/clients/${encodeURIComponent(badClientId)}/documents/doc-pan-root-1`, {
            method: 'DELETE',
            headers: { Authorization: 'Bearer token-admin-valid' }
          }),
          workerEnv
        );
        assert.strictEqual(res.status, 400, `Invalid client ID '${badClientId}' must return 400`);
      }
      console.log('✓ Test 22 Passed: Invalid client IDs rejected safely (400)');
    }

    // Test 23: Missing password metadata handled gracefully (200, no-op cleanup)
    {
      // doc-upload-subfolder-1 had no password metadata in memoryDocumentPasswords
      // It was successfully deleted in Test 9, and Firestore delete was invoked without failing
      assert.strictEqual(deletedPasswordDocIds.includes('doc-upload-subfolder-1'), true, 'Firestore delete was called even without pre-existing password metadata');
      console.log('✓ Test 23 Passed: Missing password metadata handled gracefully (200, no-op cleanup)');
    }

    // =========================================================================
    // STEP 26E: CLIENT ACTIVE/INACTIVE ACCOUNT STATUS MANAGEMENT TESTS
    // =========================================================================

    // Test 24: Unauthenticated request is rejected (401)
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/status', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'INACTIVE' })
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 401, 'Unauthenticated status update request must return 401');
      console.log('✓ Test 24 Passed: Unauthenticated request rejected (401)');
    }

    // Test 25: Non-admin request is rejected (403)
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/status', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token-client-nonadmin'
          },
          body: JSON.stringify({ status: 'INACTIVE' })
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 403, 'Non-admin status update request must return 403');
      console.log('✓ Test 25 Passed: Non-admin request rejected (403)');
    }

    // Test 26: Inactive admin request is rejected (403)
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/status', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token-admin-inactive'
          },
          body: JSON.stringify({ status: 'INACTIVE' })
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 403, 'Inactive admin status update request must return 403');
      console.log('✓ Test 26 Passed: Inactive admin request rejected (403)');
    }

    // Test 27: Invalid status values are rejected (400)
    {
      const invalidStatuses = ['PENDING', 'ACTIVE_NOW', 'active', 'inactive', 'SUSPENDED', '', 123, null, false, ['ACTIVE']];
      for (const invalidStatus of invalidStatuses) {
        const res = await app.fetch(
          new Request('https://worker.local/api/admin/clients/client-user-1/status', {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer token-admin-valid'
            },
            body: JSON.stringify({ status: invalidStatus })
          }),
          workerEnv
        );
        assert.strictEqual(res.status, 400, `Invalid status value '${JSON.stringify(invalidStatus)}' must return 400`);
      }
      console.log('✓ Test 27 Passed: Invalid status values rejected safely (400)');
    }

    // Test 28: Malformed request bodies rejected (400)
    {
      const res1 = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/status', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token-admin-valid'
          },
          body: 'not a json'
        }),
        workerEnv
      );
      assert.strictEqual(res1.status, 400, 'Non-JSON body must return 400');

      const res2 = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/status', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token-admin-valid'
          },
          body: JSON.stringify(['ACTIVE'])
        }),
        workerEnv
      );
      assert.strictEqual(res2.status, 400, 'Array body must return 400');
      console.log('✓ Test 28 Passed: Malformed request bodies rejected safely (400)');
    }

    // Test 29: Client not found returns 404
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/non-existent-client-id/status', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token-admin-valid'
          },
          body: JSON.stringify({ status: 'INACTIVE' })
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 404, 'Non-existent client UID must return 404');
      const body = await res.json() as any;
      assert.strictEqual(body.success, false);
      console.log('✓ Test 29 Passed: Client not found returns safe 404');
    }

    // Test 30: Administrator target cannot be changed (400)
    {
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/admin-user-1/status', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token-admin-valid'
          },
          body: JSON.stringify({ status: 'INACTIVE' })
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 400, 'Modifying administrator status must return 400');
      const body = await res.json() as any;
      assert.strictEqual(body.success, false);
      assert.strictEqual(memoryUsers.get('admin-user-1').status, 'active', 'Admin status must remain active');
      console.log('✓ Test 30 Passed: Administrator target rejected safely (400)');
    }

    // Test 31: Admin successfully changes ACTIVE client to INACTIVE (200)
    {
      const originalProfile = { ...memoryUsers.get('client-user-1') };
      assert.strictEqual(originalProfile.status, 'active');

      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-user-1/status', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token-admin-valid'
          },
          body: JSON.stringify({ status: 'INACTIVE' })
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200, 'Status update to INACTIVE must return 200');
      const body = await res.json() as any;
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.clientId, 'client-user-1');
      assert.strictEqual(body.status, 'INACTIVE');

      // Verify Firestore state
      const updatedProfile = memoryUsers.get('client-user-1');
      assert.strictEqual(updatedProfile.status, 'inactive');
      assert.strictEqual(typeof updatedProfile.updatedAt, 'string');
      // Verify other fields remain intact
      assert.strictEqual(updatedProfile.name, originalProfile.name);
      assert.strictEqual(updatedProfile.email, originalProfile.email);
      assert.strictEqual(updatedProfile.phone, originalProfile.phone);
      assert.strictEqual(updatedProfile.panNumber, originalProfile.panNumber);
      assert.strictEqual(updatedProfile.driveFolderId, originalProfile.driveFolderId);
      assert.strictEqual(updatedProfile.role, originalProfile.role);
      assert.strictEqual(updatedProfile.createdAt, originalProfile.createdAt);
      console.log('✓ Test 31 Passed: Admin successfully changed ACTIVE client to INACTIVE (200)');
    }

    // Test 32: Admin successfully changes INACTIVE client to ACTIVE (200)
    {
      const originalProfile = { ...memoryUsers.get('client-inactive-1') };
      assert.strictEqual(originalProfile.status, 'inactive');

      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-inactive-1/status', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token-admin-valid'
          },
          body: JSON.stringify({ status: 'ACTIVE' })
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200, 'Status update to ACTIVE must return 200');
      const body = await res.json() as any;
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.clientId, 'client-inactive-1');
      assert.strictEqual(body.status, 'ACTIVE');

      // Verify Firestore state
      const updatedProfile = memoryUsers.get('client-inactive-1');
      assert.strictEqual(updatedProfile.status, 'active');
      assert.strictEqual(typeof updatedProfile.updatedAt, 'string');
      // Verify other fields remain intact
      assert.strictEqual(updatedProfile.name, originalProfile.name);
      assert.strictEqual(updatedProfile.email, originalProfile.email);
      assert.strictEqual(updatedProfile.phone, originalProfile.phone);
      assert.strictEqual(updatedProfile.panNumber, originalProfile.panNumber);
      assert.strictEqual(updatedProfile.driveFolderId, originalProfile.driveFolderId);
      assert.strictEqual(updatedProfile.role, originalProfile.role);
      console.log('✓ Test 32 Passed: Admin successfully changed INACTIVE client to ACTIVE (200)');
    }

    // Test 33: Same-status request skips Firestore write (no-op, 200)
    {
      // client-inactive-1 is now ACTIVE
      const patchCountBefore = firestoreUserPatchCount;
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-inactive-1/status', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token-admin-valid'
          },
          body: JSON.stringify({ status: 'ACTIVE' })
        }),
        workerEnv
      );
      assert.strictEqual(res.status, 200, 'Same status request must return 200');
      const body = await res.json() as any;
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.clientId, 'client-inactive-1');
      assert.strictEqual(body.status, 'ACTIVE');

      assert.strictEqual(firestoreUserPatchCount, patchCountBefore, 'Unnecessary Firestore write must be skipped');
      console.log('✓ Test 33 Passed: Same-status request skipped Firestore write (200, no-op)');
    }

    // Test 34: Firestore failure handled safely (500/502)
    {
      failAtStep = 'firestore';
      const res = await app.fetch(
        new Request('https://worker.local/api/admin/clients/client-inactive-1/status', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token-admin-valid'
          },
          body: JSON.stringify({ status: 'INACTIVE' })
        }),
        workerEnv
      );
      assert.strictEqual(res.status >= 500, true, 'Firestore failure must return 5xx');
      const body = await res.json() as any;
      assert.strictEqual(body.success, false);
      assert.strictEqual(typeof (body.error?.message || body.message), 'string');
      // Reset failAtStep
      failAtStep = 'none';
      console.log('✓ Test 34 Passed: Firestore failure handled safely with 5xx');
    }

    console.log('\n--- All STEP 26A, 26D & 26E Admin Client and Document API Tests Passed Successfully! ---\n');
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

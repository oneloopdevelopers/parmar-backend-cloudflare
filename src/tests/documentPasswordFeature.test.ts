import assert from 'node:assert';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { createWorkerApp } from '../worker';
import {
  importDocumentPasswordKey,
  encryptDocumentPassword,
  decryptDocumentPassword,
  bytesToBase64,
  base64ToBytes
} from '../services/documentPasswordCrypto';
import { clearTokenCache } from '../services/googleServiceAccountAuth';

export async function runDocumentPasswordFeatureTests() {
  console.log('\n--- Starting Tests for Document Password Protection Feature ---');

  // 1. Generate 32-byte AES-256 key for testing
  const rawKeyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    rawKeyBytes[i] = (i * 7 + 13) % 256;
  }
  const validBase64Key = bytesToBase64(rawKeyBytes);

  // A different 32-byte key
  const otherKeyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    otherKeyBytes[i] = (i * 11 + 3) % 256;
  }
  const otherBase64Key = bytesToBase64(otherKeyBytes);

  // ==========================================
  // SECTION 1: Crypto Utility Unit Tests
  // ==========================================
  console.log('\n--- Section 1: Crypto Utility Unit Tests ---');

  // Test 1: Valid 32-byte key import
  {
    const key = await importDocumentPasswordKey(validBase64Key);
    assert(key !== null && typeof key === 'object', 'Key should be successfully imported');
    console.log('  ✓ Test 1 Passed: Valid 32-byte Base64 key imported successfully');
  }

  // Test 2: Invalid keys rejected
  {
    await assert.rejects(
      async () => importDocumentPasswordKey(''),
      /DOCUMENT_PASSWORD_ENCRYPTION_KEY must be a non-empty Base64 string/
    );
    await assert.rejects(
      async () => importDocumentPasswordKey('not!valid!base64!@@@'),
      /DOCUMENT_PASSWORD_ENCRYPTION_KEY is not valid Base64/
    );
    // 16 bytes key (128-bit) should be rejected because 32 bytes required
    const shortKey = bytesToBase64(new Uint8Array(16));
    await assert.rejects(
      async () => importDocumentPasswordKey(shortKey),
      /DOCUMENT_PASSWORD_ENCRYPTION_KEY must represent exactly 32 bytes/
    );
    // 24 bytes key (192-bit) should be rejected
    const midKey = bytesToBase64(new Uint8Array(24));
    await assert.rejects(
      async () => importDocumentPasswordKey(midKey),
      /DOCUMENT_PASSWORD_ENCRYPTION_KEY must represent exactly 32 bytes/
    );
    console.log('  ✓ Test 2 Passed: Invalid, non-Base64, and non-32-byte keys are rejected');
  }

  // Test 3: Encryption & Decryption round trip (ASCII, Unicode, Symbols)
  {
    const passwords = [
      'MySecureP@ssw0rd!2026',
      'गोपनीय_पासवर्ड_१२३',
      'Special #$%^&*()_+~|}{[]:;?><,./-= \t',
      'a'.repeat(128) // max length
    ];

    for (const pw of passwords) {
      const encrypted = await encryptDocumentPassword(pw, validBase64Key);
      assert.strictEqual(encrypted.algorithm, 'AES-256-GCM');
      assert.strictEqual(encrypted.keyVersion, '1');
      assert(encrypted.iv && typeof encrypted.iv === 'string');
      assert(encrypted.encryptedPassword && typeof encrypted.encryptedPassword === 'string');
      // Plaintext must not appear in encrypted payload
      assert(!encrypted.encryptedPassword.includes(pw), 'Ciphertext must not leak plaintext');

      const decrypted = await decryptDocumentPassword(encrypted, validBase64Key);
      assert.strictEqual(decrypted, pw, 'Decrypted password must match original');
    }
    console.log('  ✓ Test 3 Passed: Round-trip encryption and decryption succeeds for diverse passwords');
  }

  // Test 4: Random IV per encryption - same password encrypted twice produces different IVs and ciphertexts
  {
    const pw = 'SameSecretPassword123';
    const enc1 = await encryptDocumentPassword(pw, validBase64Key);
    const enc2 = await encryptDocumentPassword(pw, validBase64Key);

    assert.notStrictEqual(enc1.iv, enc2.iv, 'Each encryption must use a fresh, unique IV');
    assert.notStrictEqual(enc1.encryptedPassword, enc2.encryptedPassword, 'Ciphertexts must differ due to unique IV');

    // Both decrypt to the same original password
    const dec1 = await decryptDocumentPassword(enc1, validBase64Key);
    const dec2 = await decryptDocumentPassword(enc2, validBase64Key);
    assert.strictEqual(dec1, pw);
    assert.strictEqual(dec2, pw);
    console.log('  ✓ Test 4 Passed: Unique 12-byte IV for every encryption ensures distinct ciphertexts');
  }

  // Test 5: Validation - rejects empty, whitespace, and >128 chars
  {
    await assert.rejects(
      async () => encryptDocumentPassword('', validBase64Key),
      /Document password cannot be empty or whitespace-only/
    );
    await assert.rejects(
      async () => encryptDocumentPassword('   \t\n  ', validBase64Key),
      /Document password cannot be empty or whitespace-only/
    );
    await assert.rejects(
      async () => encryptDocumentPassword('x'.repeat(129), validBase64Key),
      /Document password must not exceed 128 characters/
    );
    console.log('  ✓ Test 5 Passed: Empty, whitespace-only, and passwords >128 characters rejected');
  }

  // Test 6: Tamper detection & wrong key handling
  {
    const enc = await encryptDocumentPassword('Secret123', validBase64Key);

    // Corrupt ciphertext
    const ctBytes = base64ToBytes(enc.encryptedPassword);
    ctBytes[0] ^= 0xff;
    const tamperedEnc = { ...enc, encryptedPassword: bytesToBase64(ctBytes) };

    await assert.rejects(
      async () => decryptDocumentPassword(tamperedEnc, validBase64Key),
      /Decryption failed: corrupted ciphertext, invalid key, or tampered payload/
    );

    // Decrypt with wrong key
    await assert.rejects(
      async () => decryptDocumentPassword(enc, otherBase64Key),
      /Decryption failed: corrupted ciphertext, invalid key, or tampered payload/
    );
    console.log('  ✓ Test 6 Passed: Tampered ciphertext or incorrect key fails decryption safely');
  }

  // ==========================================
  // SECTION 2: Worker Integration Tests
  // ==========================================
  console.log('\n--- Section 2: Worker Integration Tests (Upload, List, Admin Password) ---');

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
    FIREBASE_SERVICE_ACCOUNT_JSON: testServiceAccountJson,
    DOCUMENT_PASSWORD_ENCRYPTION_KEY: validBase64Key
  };

  // Test state stores
  const memoryUsers = new Map<string, any>();
  const memoryDocumentPasswords = new Map<string, any>();
  const memoryDriveFiles = new Map<string, any>();
  const deletedDriveFileIds: string[] = [];

  // Seed Admin user
  memoryUsers.set('admin-uid-1', {
    name: 'Authorized Admin',
    email: 'admin@example.com',
    phone: '+919999999999',
    panNumber: 'ADMIN1234A',
    driveFolderId: 'admin-folder-id',
    role: 'admin',
    status: 'active',
    createdAt: new Date().toISOString()
  });

  // Seed Inactive Admin
  memoryUsers.set('admin-inactive-uid', {
    name: 'Inactive Admin',
    email: 'admin.inactive@example.com',
    phone: '+919999999998',
    panNumber: 'INADM1234A',
    driveFolderId: 'inadmin-folder-id',
    role: 'admin',
    status: 'inactive',
    createdAt: new Date().toISOString()
  });

  // Seed Client A
  memoryUsers.set('client-uid-a', {
    name: 'Client Alpha',
    email: 'clienta@example.com',
    phone: '+919876543210',
    panNumber: 'CLIEA1234A',
    driveFolderId: 'folder-client-a-pan',
    role: 'client',
    status: 'active',
    createdAt: new Date().toISOString()
  });

  // Seed Client B (for IDOR testing)
  memoryUsers.set('client-uid-b', {
    name: 'Client Beta',
    email: 'clientb@example.com',
    phone: '+919876543211',
    panNumber: 'CLIEB1234A',
    driveFolderId: 'folder-client-b-pan',
    role: 'client',
    status: 'active',
    createdAt: new Date().toISOString()
  });

  let nextDocId = 100;
  let simulateFirestorePasswordFailure = false;

  // Custom fetch mock handling Firestore REST & Google Drive v3 REST
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    // Google OAuth token endpoint (service account assertion)
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'mock-google-access-token',
          token_type: 'Bearer',
          expires_in: 3600
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Firestore REST: get client profile or document
    if (url.includes('/databases/(default)/documents/users/')) {
      const match = url.match(/\/documents\/users\/([^?]+)/);
      const uid = match ? decodeURIComponent(match[1]) : '';
      const user = memoryUsers.get(uid);
      if (!user) {
        return new Response(JSON.stringify({ error: { code: 404, message: 'User not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      // Return Firestore REST format
      const fields: Record<string, any> = {};
      for (const [k, v] of Object.entries(user)) {
        fields[k] = { stringValue: String(v) };
      }
      return new Response(JSON.stringify({ name: `users/${uid}`, fields }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Firestore REST: documentPasswords collection
    if (url.includes('/databases/(default)/documents/documentPasswords')) {
      const match = url.match(/\/documents\/documentPasswords\/([^?]+)/);
      const docId = match ? decodeURIComponent(match[1]) : '';

      if (init?.method === 'PATCH') {
        if (simulateFirestorePasswordFailure) {
          return new Response(
            JSON.stringify({ error: { code: 500, message: 'Simulated Firestore persistence failure' } }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const body = JSON.parse(init.body as string);
        const record: Record<string, any> = {};
        for (const [k, v] of Object.entries(body.fields || {})) {
          record[k] = (v as any).stringValue ?? (v as any).booleanValue ?? (v as any).integerValue;
        }
        memoryDocumentPasswords.set(docId, record);
        return new Response(JSON.stringify({ name: `documentPasswords/${docId}`, fields: body.fields }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // GET
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

    // Google Drive REST: Folder metadata check (files.get)
    if (url.includes('/drive/v3/files/folder-') && url.includes('fields=')) {
      const match = url.match(/\/drive\/v3\/files\/([^?]+)/);
      const folderId = match ? decodeURIComponent(match[1]) : '';
      return new Response(
        JSON.stringify({
          id: folderId,
          name: 'Client PAN Folder',
          mimeType: 'application/vnd.google-apps.folder',
          trashed: false
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Google Drive REST: Search upload subfolder
    if (url.includes('/drive/v3/files?') && url.includes("name+%3D+%27upload%27")) {
      const parentIdMatch = url.match(/%27([^%]+)%27\+in\+parents/);
      const parentId = parentIdMatch ? decodeURIComponent(parentIdMatch[1]) : 'unknown-parent';
      const uploadFolderId = `upload-folder-${parentId}`;
      return new Response(
        JSON.stringify({
          files: [
            {
              id: uploadFolderId,
              name: 'upload',
              mimeType: 'application/vnd.google-apps.folder',
              trashed: false,
              parents: [parentId]
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Google Drive REST: Multipart file upload
    if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
      const fileId = `drive-doc-${nextDocId++}`;
      let bodyText = '';
      if (init?.body instanceof Uint8Array) {
        bodyText = new TextDecoder().decode(init.body);
      }
      let filename = 'document.pdf';
      const match = bodyText.match(/"name":"([^"]+)"/);
      if (match) {
        filename = match[1];
      }
      const parentsMatch = bodyText.match(/"parents":\["([^"]+)"\]/);
      const parents = parentsMatch ? [parentsMatch[1]] : ['upload-folder-folder-client-a-pan'];

      const fileObj = {
        id: fileId,
        name: filename,
        mimeType: 'application/pdf',
        size: '1024',
        createdTime: new Date().toISOString(),
        modifiedTime: new Date().toISOString(),
        parents,
        trashed: false
      };
      memoryDriveFiles.set(fileId, fileObj);

      return new Response(JSON.stringify(fileObj), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Google Drive REST: files.get for file metadata
    if (url.includes('/drive/v3/files/drive-doc-') && url.includes('fields=')) {
      const match = url.match(/\/drive\/v3\/files\/([^?]+)/);
      const fileId = match ? decodeURIComponent(match[1]) : '';
      const fileObj = memoryDriveFiles.get(fileId);
      if (!fileObj) {
        return new Response(JSON.stringify({ error: { code: 404, message: 'File not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify(fileObj), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Google Drive REST: files.list (client or admin document listing)
    if (url.includes('/drive/v3/files?') && !url.includes('/upload/')) {
      const parentMatch = url.match(/%27([^%]+)%27\+in\+parents/);
      const parentId = parentMatch ? decodeURIComponent(parentMatch[1]) : '';
      const matchedFiles = Array.from(memoryDriveFiles.values()).filter(
        (f) => f.parents && f.parents.includes(parentId) && !f.trashed
      );
      return new Response(JSON.stringify({ files: matchedFiles }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Google Drive REST: DELETE file (rollback)
    if (init?.method === 'DELETE' && url.includes('/drive/v3/files/')) {
      const match = url.match(/\/drive\/v3\/files\/([^?]+)/);
      const fileId = match ? decodeURIComponent(match[1]) : '';
      memoryDriveFiles.delete(fileId);
      deletedDriveFileIds.push(fileId);
      return new Response(null, { status: 204 });
    }

    return new Response('Not Found', { status: 404 });
  };

  // Mock token verifier
  const mockTokenVerifier = async (token: string) => {
    if (token === 'token-admin-1') {
      return {
        uid: 'admin-uid-1',
        email: 'admin@example.com',
        claims: { sub: 'admin-uid-1', email: 'admin@example.com' }
      };
    }
    if (token === 'token-admin-inactive') {
      return {
        uid: 'admin-inactive-uid',
        email: 'admin.inactive@example.com',
        claims: { sub: 'admin-inactive-uid', email: 'admin.inactive@example.com' }
      };
    }
    if (token === 'token-client-a') {
      return {
        uid: 'client-uid-a',
        email: 'clienta@example.com',
        claims: { sub: 'client-uid-a', email: 'clienta@example.com' }
      };
    }
    if (token === 'token-client-b') {
      return {
        uid: 'client-uid-b',
        email: 'clientb@example.com',
        claims: { sub: 'client-uid-b', email: 'clientb@example.com' }
      };
    }
    throw new Error('Invalid Firebase token');
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;

  const app = createWorkerApp({
    tokenVerifier: mockTokenVerifier
  });

  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xd0, 0xd4, 0xc5, 0xd8]);

  // Helper to construct multipart form
  function makeMultipartRequest(
    url: string,
    fileBytes: Uint8Array,
    filename: string,
    authToken: string,
    password?: string
  ): Request {
    const boundary = '----TestBoundary' + Math.random().toString(36).substring(2);
    const crlf = '\r\n';

    let bodyString = `--${boundary}${crlf}`;
    bodyString += `Content-Disposition: form-data; name="file"; filename="${filename}"${crlf}`;
    bodyString += `Content-Type: application/pdf${crlf}${crlf}`;

    const headBytes = new TextEncoder().encode(bodyString);

    let tailString = crlf;
    if (password !== undefined) {
      tailString += `--${boundary}${crlf}`;
      tailString += `Content-Disposition: form-data; name="documentPassword"${crlf}${crlf}`;
      tailString += `${password}${crlf}`;
    }
    tailString += `--${boundary}--${crlf}`;

    const tailBytes = new TextEncoder().encode(tailString);

    const fullBody = new Uint8Array(headBytes.byteLength + fileBytes.byteLength + tailBytes.byteLength);
    fullBody.set(headBytes, 0);
    fullBody.set(fileBytes, headBytes.byteLength);
    fullBody.set(tailBytes, headBytes.byteLength + fileBytes.byteLength);

    return new Request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: fullBody
    });
  }

  // Test 7: Upload without password
  let unprotectedDocId = '';
  {
    const req = makeMultipartRequest(
      'http://localhost/api/documents/upload',
      pdfBytes,
      'NormalDocument.pdf',
      'token-client-a'
    );
    const res = await app.fetch(req, workerEnv as any);
    assert.strictEqual(res.status, 200, 'Upload without password should succeed with 200');
    const json = (await res.json()) as any;
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.data.document.isPasswordProtected, false, 'isPasswordProtected must be false');
    unprotectedDocId = json.data.document.id;

    // Verify no record in documentPasswords
    assert(!memoryDocumentPasswords.has(unprotectedDocId), 'No password record should exist for unprotected document');
    console.log('  ✓ Test 7 Passed: Document upload without password succeeds with isPasswordProtected: false');
  }

  // Test 8: Upload with password
  let protectedDocId = '';
  const testPassword = 'ClientP@ssw0rd!2026';
  {
    const req = makeMultipartRequest(
      'http://localhost/api/documents/upload',
      pdfBytes,
      'Confidential_Tax.pdf',
      'token-client-a',
      testPassword
    );
    const res = await app.fetch(req, workerEnv as any);
    assert.strictEqual(res.status, 200, 'Upload with password should succeed with 200');
    const json = (await res.json()) as any;
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.data.document.isPasswordProtected, true, 'isPasswordProtected must be true');
    protectedDocId = json.data.document.id;

    // Verify response does not leak password, IV, encryptedPassword, or key
    const docResp = json.data.document;
    assert.strictEqual(docResp.password, undefined);
    assert.strictEqual(docResp.encryptedPassword, undefined);
    assert.strictEqual(docResp.iv, undefined);
    assert.strictEqual(docResp.key, undefined);

    // Verify Firestore documentPasswords/{protectedDocId} record
    const record = memoryDocumentPasswords.get(protectedDocId);
    assert(record, 'Password metadata record must be persisted in documentPasswords');
    assert.strictEqual(record.driveFileId, protectedDocId);
    assert.strictEqual(record.clientId, 'client-uid-a');
    assert.strictEqual(record.isPasswordProtected, true);
    assert.strictEqual(record.algorithm, 'AES-256-GCM');
    assert.strictEqual(record.keyVersion, '1');
    assert(record.encryptedPassword && typeof record.encryptedPassword === 'string');
    assert(record.iv && typeof record.iv === 'string');
    // Ensure plaintext password is NOT stored
    assert.notStrictEqual(record.encryptedPassword, testPassword);
    assert.strictEqual(record.password, undefined);

    // Verify decrypting the stored encrypted password recovers the exact original password
    const recovered = await decryptDocumentPassword(
      {
        encryptedPassword: record.encryptedPassword,
        iv: record.iv,
        algorithm: record.algorithm,
        keyVersion: record.keyVersion
      },
      validBase64Key
    );
    assert.strictEqual(recovered, testPassword, 'Decrypted password must match original');
    console.log('  ✓ Test 8 Passed: Document upload with password encrypts password and stores metadata');
  }

  // Test 9: Upload with empty or whitespace-only password is rejected with 400
  {
    const reqEmpty = makeMultipartRequest(
      'http://localhost/api/documents/upload',
      pdfBytes,
      'DocEmptyPw.pdf',
      'token-client-a',
      '   \t  '
    );
    const resEmpty = await app.fetch(reqEmpty, workerEnv as any);
    assert.strictEqual(resEmpty.status, 400, 'Empty/whitespace password should return 400');
    const jsonEmpty = (await resEmpty.json()) as any;
    assert.strictEqual(jsonEmpty.error.code, 'BAD_REQUEST');
    console.log('  ✓ Test 9 Passed: Empty or whitespace-only document password rejected with 400');
  }

  // Test 10: Upload with password > 128 characters is rejected with 400
  {
    const longPassword = 'p'.repeat(129);
    const reqLong = makeMultipartRequest(
      'http://localhost/api/documents/upload',
      pdfBytes,
      'DocLongPw.pdf',
      'token-client-a',
      longPassword
    );
    const resLong = await app.fetch(reqLong, workerEnv as any);
    assert.strictEqual(resLong.status, 400, 'Password > 128 chars should return 400');
    const jsonLong = (await resLong.json()) as any;
    assert.strictEqual(jsonLong.error.code, 'BAD_REQUEST');
    console.log('  ✓ Test 10 Passed: Password > 128 characters rejected with 400');
  }

  // Test 11: Missing DOCUMENT_PASSWORD_ENCRYPTION_KEY causes 500 BEFORE Google Drive upload
  {
    const filesBefore = memoryDriveFiles.size;
    const envWithoutKey = {
      ...workerEnv,
      DOCUMENT_PASSWORD_ENCRYPTION_KEY: undefined
    };
    const reqMissingKey = makeMultipartRequest(
      'http://localhost/api/documents/upload',
      pdfBytes,
      'DocNoKey.pdf',
      'token-client-a',
      'ValidPassword123'
    );
    const resMissingKey = await app.fetch(reqMissingKey, envWithoutKey as any);
    assert.strictEqual(resMissingKey.status, 500, 'Missing key should return 500 server error');
    assert.strictEqual(memoryDriveFiles.size, filesBefore, 'Drive upload must not be triggered if key is missing');
    console.log('  ✓ Test 11 Passed: Missing DOCUMENT_PASSWORD_ENCRYPTION_KEY rejected with 500 before Drive upload');
  }

  // Test 12: Rollback of uploaded Drive file if Firestore password persistence fails
  {
    simulateFirestorePasswordFailure = true;
    deletedDriveFileIds.length = 0;

    const reqFailing = makeMultipartRequest(
      'http://localhost/api/documents/upload',
      pdfBytes,
      'DocRollback.pdf',
      'token-client-a',
      'SecretToRollback'
    );
    const resFailing = await app.fetch(reqFailing, workerEnv as any);
    assert.strictEqual(resFailing.status, 500, 'Firestore metadata failure should return 500');
    // Verify that the uploaded Drive file was rolled back / deleted
    assert(deletedDriveFileIds.length > 0, 'Drive file must be deleted during rollback');
    simulateFirestorePasswordFailure = false;
    console.log('  ✓ Test 12 Passed: Drive file rolled back and deleted if Firestore password persistence fails');
  }

  // Test 13: Client document listing (GET /api/documents)
  {
    const req = new Request('http://localhost/api/documents', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer token-client-a'
      }
    });
    const res = await app.fetch(req, workerEnv as any);
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as any;
    assert.strictEqual(json.success, true);
    assert(Array.isArray(json.documents));

    const unprot = json.documents.find((d: any) => d.id === unprotectedDocId);
    assert(unprot, 'Unprotected doc should be in listing');
    assert.strictEqual(unprot.isPasswordProtected, false, 'Unprotected doc must have isPasswordProtected: false');

    const prot = json.documents.find((d: any) => d.id === protectedDocId);
    assert(prot, 'Protected doc should be in listing');
    assert.strictEqual(prot.isPasswordProtected, true, 'Protected doc must have isPasswordProtected: true');

    // Verify neither doc exposes password or metadata
    for (const doc of json.documents) {
      assert.strictEqual(doc.password, undefined);
      assert.strictEqual(doc.encryptedPassword, undefined);
      assert.strictEqual(doc.iv, undefined);
      assert.strictEqual(doc.key, undefined);
    }
    console.log('  ✓ Test 13 Passed: GET /api/documents reports isPasswordProtected: true/false without exposing secrets');
  }

  // Test 14: Admin document listing (GET /api/admin/clients/:clientId/documents)
  {
    const req = new Request('http://localhost/api/admin/clients/client-uid-a/documents', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer token-admin-1'
      }
    });
    const res = await app.fetch(req, workerEnv as any);
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as any;
    assert.strictEqual(json.success, true);
    const docs = json.data.documents;
    assert(Array.isArray(docs));

    const prot = docs.find((d: any) => d.documentId === protectedDocId);
    assert(prot, 'Protected doc should be in admin document listing');
    assert.strictEqual(prot.isPasswordProtected, true, 'Admin doc listing must have isPasswordProtected: true');

    const unprot = docs.find((d: any) => d.documentId === unprotectedDocId);
    assert(unprot, 'Unprotected doc should be in admin document listing');
    assert.strictEqual(unprot.isPasswordProtected, false, 'Admin doc listing must have isPasswordProtected: false');

    for (const doc of docs) {
      assert.strictEqual(doc.password, undefined);
      assert.strictEqual(doc.encryptedPassword, undefined);
    }
    console.log('  ✓ Test 14 Passed: Admin document listing reports isPasswordProtected: true/false');
  }

  // Test 15: Admin password retrieval endpoint
  // GET /api/admin/clients/:clientId/documents/:documentId/password
  {
    // 15a: Unauthenticated -> 401
    const resUnauth = await app.fetch(
      new Request(`http://localhost/api/admin/clients/client-uid-a/documents/${protectedDocId}/password`),
      workerEnv as any
    );
    assert.strictEqual(resUnauth.status, 401, 'Unauthenticated access must be rejected with 401');

    // 15b: Non-admin client token -> 403
    const resNonAdmin = await app.fetch(
      new Request(`http://localhost/api/admin/clients/client-uid-a/documents/${protectedDocId}/password`, {
        headers: { 'Authorization': 'Bearer token-client-a' }
      }),
      workerEnv as any
    );
    assert.strictEqual(resNonAdmin.status, 403, 'Non-admin token must be rejected with 403');

    // 15c: Inactive admin token -> 403
    const resInactiveAdmin = await app.fetch(
      new Request(`http://localhost/api/admin/clients/client-uid-a/documents/${protectedDocId}/password`, {
        headers: { 'Authorization': 'Bearer token-admin-inactive' }
      }),
      workerEnv as any
    );
    assert.strictEqual(resInactiveAdmin.status, 403, 'Inactive admin token must be rejected with 403');

    // 15d: Malformed document ID -> 400
    const resMalformedDoc = await app.fetch(
      new Request(`http://localhost/api/admin/clients/client-uid-a/documents/bad!doc!id/password`, {
        headers: { 'Authorization': 'Bearer token-admin-1' }
      }),
      workerEnv as any
    );
    assert.strictEqual(resMalformedDoc.status, 400, 'Malformed doc ID must be rejected with 400');

    // 15e: Non-existent document -> 404
    const resMissingDoc = await app.fetch(
      new Request(`http://localhost/api/admin/clients/client-uid-a/documents/drive-doc-nonexistent/password`, {
        headers: { 'Authorization': 'Bearer token-admin-1' }
      }),
      workerEnv as any
    );
    assert.strictEqual(resMissingDoc.status, 404, 'Non-existent document must return 404');

    // 15f: IDOR / Cross-client access -> 404
    // Requesting client A's document under client B's URL
    const resIdor = await app.fetch(
      new Request(`http://localhost/api/admin/clients/client-uid-b/documents/${protectedDocId}/password`, {
        headers: { 'Authorization': 'Bearer token-admin-1' }
      }),
      workerEnv as any
    );
    assert.strictEqual(resIdor.status, 404, 'Cross-client document access (IDOR) must be rejected with 404');

    // 15g: Unprotected document password retrieval -> 200 with isPasswordProtected: false, password: null
    const resUnprotected = await app.fetch(
      new Request(`http://localhost/api/admin/clients/client-uid-a/documents/${unprotectedDocId}/password`, {
        headers: { 'Authorization': 'Bearer token-admin-1' }
      }),
      workerEnv as any
    );
    assert.strictEqual(resUnprotected.status, 200);
    const jsonUnprotected = (await resUnprotected.json()) as any;
    assert.strictEqual(jsonUnprotected.success, true);
    assert.strictEqual(jsonUnprotected.data.documentId, unprotectedDocId);
    assert.strictEqual(jsonUnprotected.data.isPasswordProtected, false);
    assert.strictEqual(jsonUnprotected.data.password, null);

    // 15h: Protected document password retrieval -> 200 with isPasswordProtected: true, decrypted password
    const resProtected = await app.fetch(
      new Request(`http://localhost/api/admin/clients/client-uid-a/documents/${protectedDocId}/password`, {
        headers: { 'Authorization': 'Bearer token-admin-1' }
      }),
      workerEnv as any
    );
    assert.strictEqual(resProtected.status, 200);
    const jsonProtected = (await resProtected.json()) as any;
    assert.strictEqual(jsonProtected.success, true);
    assert.strictEqual(jsonProtected.data.documentId, protectedDocId);
    assert.strictEqual(jsonProtected.data.isPasswordProtected, true);
    assert.strictEqual(jsonProtected.data.password, testPassword, 'Must return the decrypted plaintext password');
    assert.strictEqual(jsonProtected.data.encryptedPassword, undefined);
    assert.strictEqual(jsonProtected.data.iv, undefined);
    assert.strictEqual(jsonProtected.data.key, undefined);

    // 15i: Missing DOCUMENT_PASSWORD_ENCRYPTION_KEY on password retrieval -> 500
    const envNoKey = { ...workerEnv, DOCUMENT_PASSWORD_ENCRYPTION_KEY: undefined };
    const resNoKey = await app.fetch(
      new Request(`http://localhost/api/admin/clients/client-uid-a/documents/${protectedDocId}/password`, {
        headers: { 'Authorization': 'Bearer token-admin-1' }
      }),
      envNoKey as any
    );
    assert.strictEqual(resNoKey.status, 500, 'Missing key during retrieval must return 500');

    console.log('  ✓ Test 15 Passed: Admin password retrieval adheres to security, authorization, IDOR protection, and decryption');
  }

  globalThis.fetch = originalFetch;
  console.log('\n--- All Document Password Feature Tests Passed Successfully! ---');
}

// Auto-run if executed directly
if (process.argv[1]?.includes('documentPasswordFeature.test.ts')) {
  runDocumentPasswordFeatureTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

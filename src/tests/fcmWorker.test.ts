import assert from 'node:assert';
import { createWorkerApp } from '../worker';
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from 'jose';

export async function runFcmWorkerTests() {
  console.log('\n--- Starting Tests for Cloudflare Worker FCM Endpoints & Security ---');

  const { privateKey: firebaseAuthPrivateKey, publicKey: firebaseAuthPublicKey } = await generateKeyPair('RS256', {
    extractable: true
  });
  const firebasePublicJwk = await exportJWK(firebaseAuthPublicKey);
  firebasePublicJwk.kid = 'mock-firebase-auth-kid-fcm';
  firebasePublicJwk.alg = 'RS256';
  firebasePublicJwk.use = 'sig';

  const { privateKey: saPrivateKey } = await generateKeyPair('RS256', { extractable: true });
  const saPrivateKeyPem = await exportPKCS8(saPrivateKey);

  const projectId = 'document-portal-d2b6d';
  const serviceAccountJson = JSON.stringify({
    project_id: projectId,
    client_email: 'fcm-worker-test@example.com',
    private_key: saPrivateKeyPem
  });

  const generateMockToken = async (uid: string, email: string, role = 'client', status = 'active') => {
    return await new SignJWT({
      uid,
      sub: uid,
      email,
      role,
      status
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'mock-firebase-auth-kid-fcm' })
      .setIssuedAt()
      .setIssuer(`https://securetoken.google.com/${projectId}`)
      .setAudience(projectId)
      .setExpirationTime('2h')
      .sign(firebaseAuthPrivateKey);
  };

  const clientToken1 = await generateMockToken('client-fcm-user-1', 'client1@example.com', 'client', 'active');
  const clientToken2 = await generateMockToken('client-fcm-user-2', 'client2@example.com', 'client', 'active');
  const adminToken = await generateMockToken('admin-fcm-user', 'admin@example.com', 'admin', 'active');

  // In-memory mock store
  const store = new Map<string, Record<string, unknown>>();

  store.set('users/client-fcm-user-1', {
    name: 'Client One',
    email: 'client1@example.com',
    phone: '+91 98765 11111',
    panNumber: 'ABCDE1111A',
    driveFolderId: 'folder-1',
    role: 'client',
    status: 'active'
  });

  store.set('users/client-fcm-user-2', {
    name: 'Client Two',
    email: 'client2@example.com',
    phone: '+91 98765 22222',
    panNumber: 'ABCDE2222B',
    driveFolderId: 'folder-2',
    role: 'client',
    status: 'active'
  });

  store.set('users/admin-fcm-user', {
    name: 'Admin User',
    email: 'admin@example.com',
    phone: '+91 98765 99999',
    panNumber: 'ADMIN9999Z',
    driveFolderId: 'folder-admin',
    role: 'admin',
    status: 'active'
  });

  let fcmMessagesSent: any[] = [];

  const mockGlobalFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    // Firebase Auth Public Certificates
    if (urlStr.includes('www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com') ||
        urlStr.includes('identitytoolkit.googleapis.com') ||
        urlStr.includes('googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')) {
      return new Response(JSON.stringify({ keys: [firebasePublicJwk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'cache-control': 'public, max-age=3600' }
      });
    }

    // Google OAuth 2.0 Token endpoint
    if (urlStr.includes('oauth2.googleapis.com/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'mock-fcm-worker-access-token',
          expires_in: 3600,
          token_type: 'Bearer'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // FCM HTTP v1 Message Send
    if (urlStr.includes('fcm.googleapis.com/v1/projects/') && urlStr.includes('/messages:send')) {
      const body = JSON.parse(init?.body as string || '{}');
      fcmMessagesSent.push(body);
      return new Response(
        JSON.stringify({ name: 'projects/document-portal-d2b6d/messages/msg_fcm_mock' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Cloud Firestore REST API
    if (urlStr.includes('firestore.googleapis.com/v1/projects/')) {
      const method = init?.method || 'GET';

      // Batch commit
      if (urlStr.includes(':commit')) {
        const body = JSON.parse(init?.body as string || '{}');
        const writes = body.writes || [];
        for (const write of writes) {
          const update = write.update;
          if (update && update.name) {
            const pathMatch = update.name.match(/documents\/(.+)$/);
            if (pathMatch) {
              const docPath = decodeURIComponent(pathMatch[1]);
              const fields = update.fields || {};
              const decoded: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(fields)) {
                decoded[k] = (v as any).stringValue || (v as any).booleanValue || (v as any).integerValue;
              }
              const existing = store.get(docPath) || {};
              store.set(docPath, { ...existing, ...decoded });
            }
          }
        }
        return new Response(JSON.stringify({ writeResults: writes.map(() => ({ updateTime: '2026-01-01T00:00:00Z' })) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const match = urlStr.match(/\/documents\/(.+?)(\?|$)/);
      const rawPath = match ? decodeURIComponent(match[1]) : '';

      if (method === 'GET') {
        if (!store.has(rawPath)) {
          const prefix = rawPath.endsWith('/') ? rawPath : rawPath + '/';
          const matchedDocs: any[] = [];
          for (const [key, value] of store.entries()) {
            if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
              const fields: any = {};
              for (const [k, v] of Object.entries(value)) {
                fields[k] = { stringValue: String(v) };
              }
              matchedDocs.push({
                name: `projects/${projectId}/databases/(default)/documents/${key}`,
                fields,
                createTime: '2026-01-01T00:00:00Z',
                updateTime: '2026-01-01T00:00:00Z'
              });
            }
          }
          return new Response(JSON.stringify({ documents: matchedDocs }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const data = store.get(rawPath);
        if (!data) {
          return new Response(JSON.stringify({ error: { code: 404, message: 'Document not found' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const fields: any = {};
        for (const [k, v] of Object.entries(data)) {
          fields[k] = { stringValue: String(v) };
        }

        return new Response(
          JSON.stringify({
            name: `projects/${projectId}/databases/(default)/documents/${rawPath}`,
            fields,
            createTime: '2026-01-01T00:00:00Z',
            updateTime: '2026-01-01T00:00:00Z'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (method === 'PATCH') {
        const body = JSON.parse(init?.body as string || '{}');
        const fields = body.fields || {};
        const decoded: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) {
          decoded[k] = (v as any).stringValue || (v as any).booleanValue || (v as any).integerValue;
        }

        const existing = store.get(rawPath) || {};
        store.set(rawPath, { ...existing, ...decoded });

        return new Response(
          JSON.stringify({
            name: `projects/${projectId}/databases/(default)/documents/${rawPath}`,
            fields,
            createTime: '2026-01-01T00:00:00Z',
            updateTime: '2026-01-01T00:00:00Z'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (method === 'DELETE') {
        store.delete(rawPath);
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
  };

  (globalThis as any).fetch = mockGlobalFetch;

  const app = createWorkerApp();
  const workerEnv = {
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson
  };

  // =========================================================================
  // TEST 1: POST /api/profile/fcm-token requires authentication
  // =========================================================================
  const reqUnauth = new Request('http://localhost/api/profile/fcm-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'test_token_1234567890' })
  });
  const resUnauth = await app.request(reqUnauth, {}, workerEnv);
  assert.strictEqual(resUnauth.status, 401);
  console.log('✓ Test 1 Passed: POST /api/profile/fcm-token rejects unauthenticated requests (401)');

  // =========================================================================
  // TEST 2: Zero-Trust Guard rejects forbidden client identity keys in body
  // =========================================================================
  const reqForbiddenKey = new Request('http://localhost/api/profile/fcm-token', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientToken1}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      token: 'test_token_1234567890',
      uid: 'attacker-chosen-uid'
    })
  });
  const resForbiddenKey = await app.request(reqForbiddenKey, {}, workerEnv);
  assert.strictEqual(resForbiddenKey.status, 400);
  const jsonForbiddenKey: any = await resForbiddenKey.json();
  assert.strictEqual(jsonForbiddenKey.success, false);
  assert.match(jsonForbiddenKey.error.message, /Security violation/);
  console.log('✓ Test 2 Passed: Zero-Trust Guard rejects client-supplied uid in body');

  // =========================================================================
  // TEST 3: Register valid FCM token for Client 1
  // =========================================================================
  const deviceToken1 = 'client1_android_phone_token_1234567890';
  const reqReg1 = new Request('http://localhost/api/profile/fcm-token', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientToken1}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      token: deviceToken1,
      platform: 'android',
      appVersion: '1.2.0'
    })
  });
  const resReg1 = await app.request(reqReg1, {}, workerEnv);
  assert.strictEqual(resReg1.status, 200);
  const jsonReg1: any = await resReg1.json();
  assert.strictEqual(jsonReg1.success, true);
  assert.strictEqual(jsonReg1.message, 'FCM token registered successfully.');
  console.log('✓ Test 3 Passed: POST /api/profile/fcm-token successfully registers device token');

  // =========================================================================
  // TEST 4: Register second device token for Client 1 (Multi-device)
  // =========================================================================
  const deviceToken2 = 'client1_android_tablet_token_9876543210';
  const reqReg2 = new Request('http://localhost/api/profile/fcm-token', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientToken1}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      token: deviceToken2,
      platform: 'android',
      appVersion: '1.2.0'
    })
  });
  const resReg2 = await app.request(reqReg2, {}, workerEnv);
  assert.strictEqual(resReg2.status, 200);
  console.log('✓ Test 4 Passed: Client 1 can register multiple device tokens');

  // =========================================================================
  // TEST 5: Privacy check - GET /api/profile never exposes FCM tokens
  // =========================================================================
  const reqProfile = new Request('http://localhost/api/profile', {
    method: 'GET',
    headers: { Authorization: `Bearer ${clientToken1}` }
  });
  const resProfile = await app.request(reqProfile, {}, workerEnv);
  assert.strictEqual(resProfile.status, 200);
  const jsonProfile: any = await resProfile.json();
  assert.strictEqual(jsonProfile.fcmToken, undefined);
  assert.strictEqual(jsonProfile.fcmTokens, undefined);
  assert.strictEqual(jsonProfile.tokens, undefined);
  assert.strictEqual(jsonProfile.name, 'Client One');
  console.log('✓ Test 5 Passed: GET /api/profile strictly excludes FCM tokens from response');

  // =========================================================================
  // TEST 6: Delete / Unregister FCM token for Client 1 (Device 2)
  // =========================================================================
  const reqUnreg = new Request('http://localhost/api/profile/fcm-token', {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${clientToken1}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ token: deviceToken2 })
  });
  const resUnreg = await app.request(reqUnreg, {}, workerEnv);
  assert.strictEqual(resUnreg.status, 200);
  const jsonUnreg: any = await resUnreg.json();
  assert.strictEqual(jsonUnreg.success, true);
  assert.strictEqual(jsonUnreg.message, 'FCM token unregistered successfully.');
  console.log('✓ Test 6 Passed: DELETE /api/profile/fcm-token unregisters device token');

  // =========================================================================
  // TEST 7: Admin sends INDIVIDUAL notification and triggers FCM push
  // =========================================================================
  fcmMessagesSent = [];
  const reqAdminInd = new Request('http://localhost/api/admin/notifications', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      target: 'INDIVIDUAL',
      recipientUid: 'client-fcm-user-1',
      title: 'ITR Assessment Complete',
      message: 'Your ITR assessment order is available in your document portal.',
      category: 'DOCUMENT_UPDATE'
    })
  });
  const resAdminInd = await app.request(reqAdminInd, {}, workerEnv);
  assert.strictEqual(resAdminInd.status, 201);
  const jsonAdminInd: any = await resAdminInd.json();
  assert.strictEqual(jsonAdminInd.success, true);
  assert.strictEqual(jsonAdminInd.data.target, 'INDIVIDUAL');
  assert.strictEqual(jsonAdminInd.data.notification.recipientUid, 'client-fcm-user-1');
  assert.ok(jsonAdminInd.data.delivery, 'Delivery stats must be returned');
  assert.strictEqual(jsonAdminInd.data.delivery.tokensAttempted >= 1, true);
  assert.strictEqual(jsonAdminInd.data.delivery.tokensDelivered >= 1, true);
  assert.strictEqual(fcmMessagesSent.length >= 1, true);
  assert.strictEqual(fcmMessagesSent[0].message.notification, undefined, 'Individual FCM payload must NOT contain top-level notification');
  assert.ok(fcmMessagesSent[0].message.data, 'Individual FCM payload must contain data object');
  assert.strictEqual(typeof fcmMessagesSent[0].message.data.notificationId, 'string');
  assert.strictEqual(typeof fcmMessagesSent[0].message.data.category, 'string');
  assert.strictEqual(fcmMessagesSent[0].message.data.category, 'DOCUMENT_UPDATE');
  assert.strictEqual(typeof fcmMessagesSent[0].message.data.title, 'string');
  assert.strictEqual(fcmMessagesSent[0].message.data.title, 'ITR Assessment Complete');
  assert.strictEqual(typeof fcmMessagesSent[0].message.data.message, 'string');
  assert.strictEqual(fcmMessagesSent[0].message.data.message, 'Your ITR assessment order is available in your document portal.');
  assert.strictEqual(fcmMessagesSent[0].message.android.priority, 'HIGH');
  assert.strictEqual(fcmMessagesSent[0].message.android.notification.channel_id, 'client_portal_notifications');
  console.log('✓ Test 7 Passed: POST /api/admin/notifications (INDIVIDUAL) dispatches DATA-ONLY FCM with canonical channel client_portal_notifications');

  // =========================================================================
  // TEST 8: Admin sends ALL_ACTIVE broadcast notification and triggers FCM pushes
  // =========================================================================
  fcmMessagesSent = [];
  const reqAdminBcast = new Request('http://localhost/api/admin/notifications', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      target: 'ALL_ACTIVE',
      title: 'Tax Season Filing Deadline',
      message: 'Kindly submit all investment proofs before March 31st.',
      category: 'REMINDER'
    })
  });
  const resAdminBcast = await app.request(reqAdminBcast, {}, workerEnv);
  assert.strictEqual(resAdminBcast.status, 201);
  const jsonAdminBcast: any = await resAdminBcast.json();
  assert.strictEqual(jsonAdminBcast.success, true);
  assert.strictEqual(jsonAdminBcast.data.target, 'ALL_ACTIVE');
  assert.strictEqual(jsonAdminBcast.data.recipientCount >= 2, true);
  assert.ok(jsonAdminBcast.data.delivery, 'Broadcast delivery stats must be returned');
  assert.strictEqual(fcmMessagesSent.length >= 1, true);
  assert.strictEqual(fcmMessagesSent[0].message.notification, undefined, 'ALL_ACTIVE FCM payload must NOT contain top-level notification');
  assert.ok(fcmMessagesSent[0].message.data, 'ALL_ACTIVE FCM payload must contain data object');
  assert.strictEqual(typeof fcmMessagesSent[0].message.data.notificationId, 'string');
  assert.strictEqual(typeof fcmMessagesSent[0].message.data.category, 'string');
  assert.strictEqual(fcmMessagesSent[0].message.data.category, 'REMINDER');
  assert.strictEqual(typeof fcmMessagesSent[0].message.data.title, 'string');
  assert.strictEqual(fcmMessagesSent[0].message.data.title, 'Tax Season Filing Deadline');
  assert.strictEqual(typeof fcmMessagesSent[0].message.data.message, 'string');
  assert.strictEqual(fcmMessagesSent[0].message.data.message, 'Kindly submit all investment proofs before March 31st.');
  assert.strictEqual(fcmMessagesSent[0].message.android.priority, 'HIGH');
  assert.strictEqual(fcmMessagesSent[0].message.android.notification.channel_id, 'client_portal_notifications');
  console.log('✓ Test 8 Passed: POST /api/admin/notifications (ALL_ACTIVE) broadcasts DATA-ONLY FCM pushes across all active clients');

  // =========================================================================
  // TEST 9: Health endpoint lists new FCM routes
  // =========================================================================
  const reqHealth = new Request('http://localhost/api/health', { method: 'GET' });
  const resHealth = await app.request(reqHealth, {}, workerEnv);
  assert.strictEqual(resHealth.status, 200);
  const jsonHealth: any = await resHealth.json();
  assert.ok(jsonHealth.data.endpoints.fcmTokenRegister);
  assert.ok(jsonHealth.data.endpoints.fcmTokenUnregister);
  console.log('✓ Test 9 Passed: Health check endpoint lists FCM token registration endpoints');

  console.log('--- All Cloudflare Worker FCM Endpoint & Security Tests Passed! ---\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFcmWorkerTests().catch((err) => {
    console.error('FCM Worker Test Suite Failed:', err);
    process.exit(1);
  });
}

import assert from 'node:assert';
import { createWorkerApp } from '../worker';
import { clearTokenCache } from '../services/googleServiceAccountAuth';
import { generateKeyPair, exportPKCS8, exportJWK, SignJWT } from 'jose';

export async function runNotificationWorkerTests() {
  console.log('\n--- Starting Notification Centre Cloudflare Worker HTTP Endpoint Tests ---');

  const projectId = 'document-portal-d2b6d';

  // Generate test RSA keys for Firebase Auth & Service Account
  const { privateKey: fbPrivateKey, publicKey: fbPublicKey } = await generateKeyPair('RS256', { extractable: true });
  const { privateKey: saPrivateKey } = await generateKeyPair('RS256', { extractable: true });

  const fbJwk = await exportJWK(fbPublicKey);
  fbJwk.kid = 'test-fb-kid';
  fbJwk.alg = 'RS256';
  fbJwk.use = 'sig';

  const saPrivateKeyPem = await exportPKCS8(saPrivateKey);
  const serviceAccountJson = JSON.stringify({
    project_id: projectId,
    client_email: 'service-account@example.com',
    private_key: saPrivateKeyPem
  });

  const workerEnv = {
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson,
    NODE_ENV: 'test'
  };

  // Mock token verifier function
  const mockTokenVerifier = async (token: string) => {
    if (token === 'token-client-1') {
      return {
        uid: 'client-notif-1',
        email: 'client1@example.com',
        claims: { sub: 'client-notif-1', email: 'client1@example.com', role: 'client' }
      };
    }
    if (token === 'token-client-2') {
      return {
        uid: 'client-notif-2',
        email: 'client2@example.com',
        claims: { sub: 'client-notif-2', email: 'client2@example.com', role: 'client' }
      };
    }
    if (token === 'token-admin') {
      return {
        uid: 'admin-notif-user',
        email: 'admin@example.com',
        claims: { sub: 'admin-notif-user', email: 'admin@example.com', role: 'admin' }
      };
    }
    if (token === 'token-inactive-admin') {
      return {
        uid: 'admin-inactive-user',
        email: 'inactive-admin@example.com',
        claims: { sub: 'admin-inactive-user', email: 'inactive-admin@example.com', role: 'admin' }
      };
    }
    throw new Error('Invalid token');
  };

  const clientToken1 = 'token-client-1';
  const clientToken2 = 'token-client-2';
  const adminToken = 'token-admin';
  const inactiveAdminToken = 'token-inactive-admin';

  // In-memory Firestore store for notifications and users
  const firestoreStore = new Map<string, Record<string, unknown>>();

  // Populate mock users
  firestoreStore.set('users/client-notif-1', {
    name: 'Client One',
    email: 'client1@example.com',
    phone: '+91 98765 11111',
    panNumber: 'ABCDE1111K',
    driveFolderId: 'folder-c1',
    role: 'client',
    status: 'active'
  });
  firestoreStore.set('users/client-notif-2', {
    name: 'Client Two',
    email: 'client2@example.com',
    phone: '+91 98765 22222',
    panNumber: 'ABCDE2222L',
    driveFolderId: 'folder-c2',
    role: 'client',
    status: 'active'
  });
  firestoreStore.set('users/admin-notif-user', {
    name: 'Admin Notif',
    email: 'admin@example.com',
    phone: '+91 98765 33333',
    panNumber: 'ABCDE3333M',
    driveFolderId: 'folder-admin',
    role: 'admin',
    status: 'active'
  });
  firestoreStore.set('users/admin-inactive-user', {
    name: 'Inactive Admin',
    email: 'inactive-admin@example.com',
    phone: '+91 98765 44444',
    role: 'admin',
    status: 'inactive'
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    // 1. Google JWKS public keys
    if (url.includes('googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com') ||
        url.includes('identitytoolkit.googleapis.com/v1/publicKeys')) {
      return new Response(JSON.stringify({ keys: [fbJwk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'cache-control': 'public, max-age=3600' }
      });
    }

    // 2. Google OAuth Token for Service Account
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(
        JSON.stringify({ access_token: 'mock-sa-token', expires_in: 3600, token_type: 'Bearer' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3. Firestore REST Batch Writes (:commit)
    if (url.includes('/databases/(default)/documents:commit')) {
      const body = JSON.parse(String(init?.body || '{}'));
      for (const write of body.writes || []) {
        const fullPath = write.update.name;
        const docKey = fullPath.replace(/^projects\/[^/]+\/databases\/\(default\)\/documents\//, '');
        const fields = write.update.fields || {};
        const decoded: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields as Record<string, any>)) {
          if (v.stringValue !== undefined) decoded[k] = v.stringValue;
          else if (v.booleanValue !== undefined) decoded[k] = v.booleanValue;
          else if (v.integerValue !== undefined) decoded[k] = Number(v.integerValue);
          else if (v.nullValue !== undefined) decoded[k] = null;
        }
        firestoreStore.set(docKey, decoded);
      }
      return new Response(
        JSON.stringify({ writeResults: (body.writes || []).map(() => ({ updateTime: new Date().toISOString() })) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 4. Firestore REST Single Document PATCH
    if (init?.method === 'PATCH') {
      const match = url.match(/\/databases\/\(default\)\/documents\/(.+)$/);
      if (match) {
        const docKey = decodeURIComponent(match[1]);
        const body = JSON.parse(String(init.body || '{}'));
        const fields = body.fields || {};
        const decoded: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields as Record<string, any>)) {
          if (v.stringValue !== undefined) decoded[k] = v.stringValue;
          else if (v.booleanValue !== undefined) decoded[k] = v.booleanValue;
          else if (v.integerValue !== undefined) decoded[k] = Number(v.integerValue);
          else if (v.nullValue !== undefined) decoded[k] = null;
        }
        firestoreStore.set(docKey, decoded);
        return new Response(JSON.stringify({ name: docKey, fields }), { status: 200 });
      }
    }

    // 5. Firestore REST GET queries
    if (!init?.method || init.method === 'GET') {
      const match = url.match(/\/databases\/\(default\)\/documents\/([^?]+)/);
      if (match) {
        const targetPath = decodeURIComponent(match[1]);

        // Collection listing
        if (targetPath === 'users' || targetPath.endsWith('/notifications') || targetPath === 'broadcast_notifications' || targetPath === 'admin_notifications') {
          const prefix = targetPath + '/';
          const docs: any[] = [];
          for (const [key, val] of firestoreStore.entries()) {
            if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
              const fields: Record<string, any> = {};
              for (const [k, v] of Object.entries(val)) {
                if (typeof v === 'string') fields[k] = { stringValue: v };
                else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
                else if (typeof v === 'number') fields[k] = { integerValue: String(v) };
                else if (v === null) fields[k] = { nullValue: 'NULL_VALUE' };
              }
              docs.push({
                name: `projects/${projectId}/databases/(default)/documents/${key}`,
                fields,
                createTime: val.createdAt || new Date().toISOString()
              });
            }
          }
          return new Response(JSON.stringify({ documents: docs }), { status: 200 });
        }

        // Single doc lookup
        if (firestoreStore.has(targetPath)) {
          const val = firestoreStore.get(targetPath)!;
          const fields: Record<string, any> = {};
          for (const [k, v] of Object.entries(val)) {
            if (typeof v === 'string') fields[k] = { stringValue: v };
            else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
            else if (typeof v === 'number') fields[k] = { integerValue: String(v) };
            else if (v === null) fields[k] = { nullValue: 'NULL_VALUE' };
          }
          return new Response(
            JSON.stringify({
              name: `projects/${projectId}/databases/(default)/documents/${targetPath}`,
              fields
            }),
            { status: 200 }
          );
        }

        return new Response(JSON.stringify({ error: { code: 404, message: 'Not found' } }), { status: 404 });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }) as any;

  try {
    const app = createWorkerApp({ tokenVerifier: mockTokenVerifier });

    // ==========================================
    // TEST 1: Unauthenticated request rejected
    // ==========================================
    const reqNoAuth = new Request('http://localhost/api/notifications', { method: 'GET' });
    const resNoAuth = await app.request(reqNoAuth, {}, workerEnv);
    assert.strictEqual(resNoAuth.status, 401);
    console.log('✓ Test 1 Passed: GET /api/notifications without token returns 401 Unauthorized');

    // ==========================================
    // TEST 2: Zero-Trust Identity Guard blocks client-supplied recipient / identity selectors
    // ==========================================
    const reqWithUidQuery = new Request('http://localhost/api/notifications?uid=other-user-999', {
      method: 'GET',
      headers: { Authorization: `Bearer ${clientToken1}` }
    });
    const resWithUid = await app.request(reqWithUidQuery, {}, workerEnv);
    assert.strictEqual(resWithUid.status, 400);
    const jsonUidError: any = await resWithUid.json();
    assert.strictEqual(jsonUidError.error.code, 'BAD_REQUEST');
    assert.ok(jsonUidError.error.message.includes('uid'));
    console.log('✓ Test 2 Passed: Zero-Trust Guard rejects query parameters attempting identity override');

    const reqWithRecipientQuery = new Request('http://localhost/api/notifications?recipientUid=other-user-999', {
      method: 'GET',
      headers: { Authorization: `Bearer ${clientToken1}` }
    });
    const resWithRecipient = await app.request(reqWithRecipientQuery, {}, workerEnv);
    assert.strictEqual(resWithRecipient.status, 400);
    console.log('✓ Test 2B Passed: Zero-Trust Guard rejects forbidden recipientUid in client queries');

    // ==========================================
    // TEST 3: Admin sends INDIVIDUAL notification via POST /api/admin/notifications
    // ==========================================
    const reqSendInd = new Request('http://localhost/api/admin/notifications', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        target: 'INDIVIDUAL',
        recipientUid: 'client-notif-1',
        title: 'Form 26AS Ready',
        message: 'Your Form 26AS has been processed and is ready for inspection.',
        category: 'DOCUMENT_UPDATE'
      })
    });
    const resSendInd = await app.request(reqSendInd, {}, workerEnv);
    assert.strictEqual(resSendInd.status, 201);
    const jsonSendInd: any = await resSendInd.json();
    assert.strictEqual(jsonSendInd.success, true);
    assert.strictEqual(jsonSendInd.data.target, 'INDIVIDUAL');
    assert.strictEqual(jsonSendInd.data.notification.recipientUid, 'client-notif-1');
    assert.strictEqual(jsonSendInd.data.notification.isRead, false);
    const notifId = jsonSendInd.data.notification.id;
    console.log('✓ Test 3 Passed: POST /api/admin/notifications creates individual notification for active client');

    // ==========================================
    // TEST 4: Client 1 lists notifications via GET /api/notifications
    // ==========================================
    const reqList1 = new Request('http://localhost/api/notifications', {
      method: 'GET',
      headers: { Authorization: `Bearer ${clientToken1}` }
    });
    const resList1 = await app.request(reqList1, {}, workerEnv);
    assert.strictEqual(resList1.status, 200);
    const jsonList1: any = await resList1.json();
    assert.strictEqual(jsonList1.success, true);
    assert.strictEqual(jsonList1.data.notifications.length, 1);
    assert.strictEqual(jsonList1.data.unreadCount, 1);
    assert.strictEqual(jsonList1.data.notifications[0].title, 'Form 26AS Ready');
    console.log('✓ Test 4 Passed: GET /api/notifications returns list and unread count for authenticated client');

    // ==========================================
    // TEST 5: GET /api/notifications/unread-count
    // ==========================================
    const reqCount = new Request('http://localhost/api/notifications/unread-count', {
      method: 'GET',
      headers: { Authorization: `Bearer ${clientToken1}` }
    });
    const resCount = await app.request(reqCount, {}, workerEnv);
    assert.strictEqual(resCount.status, 200);
    const jsonCount: any = await resCount.json();
    assert.strictEqual(jsonCount.success, true);
    assert.strictEqual(jsonCount.data.unreadCount, 1);
    console.log('✓ Test 5 Passed: GET /api/notifications/unread-count returns accurate count');

    // ==========================================
    // TEST 6: Client 2 does NOT see Client 1 notification (Strict IDOR Isolation)
    // ==========================================
    const reqList2 = new Request('http://localhost/api/notifications', {
      method: 'GET',
      headers: { Authorization: `Bearer ${clientToken2}` }
    });
    const resList2 = await app.request(reqList2, {}, workerEnv);
    assert.strictEqual(resList2.status, 200);
    const jsonList2: any = await resList2.json();
    assert.strictEqual(jsonList2.data.notifications.length, 0);
    assert.strictEqual(jsonList2.data.unreadCount, 0);
    console.log('✓ Test 6 Passed: Tenant isolation verified: Client 2 receives 0 notifications');

    // ==========================================
    // TEST 7: Client 2 cannot read or dismiss Client 1 notification (404 Not Found)
    // ==========================================
    const reqIdorRead = new Request(`http://localhost/api/notifications/${notifId}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${clientToken2}` }
    });
    const resIdorRead = await app.request(reqIdorRead, {}, workerEnv);
    assert.strictEqual(resIdorRead.status, 404);
    console.log('✓ Test 7 Passed: IDOR protection: Client cannot read another client\'s notification (404)');

    const reqIdorDelete = new Request(`http://localhost/api/notifications/${notifId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${clientToken2}` }
    });
    const resIdorDelete = await app.request(reqIdorDelete, {}, workerEnv);
    assert.strictEqual(resIdorDelete.status, 404);
    console.log('✓ Test 7B Passed: IDOR protection: Client cannot dismiss another client\'s notification (404)');

    // ==========================================
    // TEST 8: Client 1 marks notification as read via PATCH /api/notifications/:id/read
    // ==========================================
    const reqMarkRead = new Request(`http://localhost/api/notifications/${notifId}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${clientToken1}` }
    });
    const resMarkRead = await app.request(reqMarkRead, {}, workerEnv);
    assert.strictEqual(resMarkRead.status, 200);
    const jsonMarkRead: any = await resMarkRead.json();
    assert.strictEqual(jsonMarkRead.success, true);
    assert.strictEqual(jsonMarkRead.data.notification.isRead, true);
    assert.strictEqual(jsonMarkRead.data.unreadCount, 0);
    console.log('✓ Test 8 Passed: PATCH /api/notifications/:id/read marks notification as read');

    // ==========================================
    // TEST 9: Admin sends ALL_ACTIVE broadcast notification
    // ==========================================
    const reqBroadcast = new Request('http://localhost/api/admin/notifications', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        target: 'ALL_ACTIVE',
        title: 'GST Return Deadline Reminder',
        message: 'Kindly file your GST return before the end of this week.',
        category: 'REMINDER'
      })
    });
    const resBroadcast = await app.request(reqBroadcast, {}, workerEnv);
    assert.strictEqual(resBroadcast.status, 201);
    const jsonBroadcast: any = await resBroadcast.json();
    assert.strictEqual(jsonBroadcast.success, true);
    assert.strictEqual(jsonBroadcast.data.target, 'ALL_ACTIVE');
    assert.strictEqual(jsonBroadcast.data.recipientCount, 2);
    console.log('✓ Test 9 Passed: POST /api/admin/notifications broadcast sends to all active clients');

    // ==========================================
    // TEST 10: Client 1 and Client 2 both receive broadcast notification
    // ==========================================
    const resClient1Check = await app.request(
      new Request('http://localhost/api/notifications', {
        headers: { Authorization: `Bearer ${clientToken1}` }
      }),
      {},
      workerEnv
    );
    const jsonC1: any = await resClient1Check.json();
    assert.strictEqual(jsonC1.data.notifications.length, 2); // 1 individual read + 1 broadcast unread
    assert.strictEqual(jsonC1.data.unreadCount, 1);

    const resClient2Check = await app.request(
      new Request('http://localhost/api/notifications', {
        headers: { Authorization: `Bearer ${clientToken2}` }
      }),
      {},
      workerEnv
    );
    const jsonC2: any = await resClient2Check.json();
    assert.strictEqual(jsonC2.data.notifications.length, 1); // 1 broadcast unread
    assert.strictEqual(jsonC2.data.unreadCount, 1);
    console.log('✓ Test 10 Passed: Both active clients receive broadcast notification in their subcollections');

    // ==========================================
    // TEST 11: Client 1 marks all as read via POST /api/notifications/mark-all-read
    // ==========================================
    const reqMarkAll = new Request('http://localhost/api/notifications/mark-all-read', {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientToken1}` }
    });
    const resMarkAll = await app.request(reqMarkAll, {}, workerEnv);
    assert.strictEqual(resMarkAll.status, 200);
    const jsonMarkAll: any = await resMarkAll.json();
    assert.strictEqual(jsonMarkAll.data.unreadCount, 0);
    assert.strictEqual(jsonMarkAll.data.updatedCount, 1);
    console.log('✓ Test 11 Passed: POST /api/notifications/mark-all-read marks all remaining unread as read');

    // ==========================================
    // TEST 12: Client 1 dismisses notification via DELETE /api/notifications/:id
    // ==========================================
    const reqDismiss = new Request(`http://localhost/api/notifications/${notifId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${clientToken1}` }
    });
    const resDismiss = await app.request(reqDismiss, {}, workerEnv);
    assert.strictEqual(resDismiss.status, 200);
    const jsonDismiss: any = await resDismiss.json();
    assert.strictEqual(jsonDismiss.success, true);

    const resListAfterDismiss = await app.request(
      new Request('http://localhost/api/notifications', {
        headers: { Authorization: `Bearer ${clientToken1}` }
      }),
      {},
      workerEnv
    );
    const jsonAfterDismiss: any = await resListAfterDismiss.json();
    assert.strictEqual(jsonAfterDismiss.data.notifications.length, 1); // only the broadcast remains
    console.log('✓ Test 12 Passed: DELETE /api/notifications/:id dismisses notification cleanly');

    // ==========================================
    // TEST 13: Client cannot call Admin endpoint (POST /api/admin/notifications)
    // ==========================================
    const reqClientAdmin = new Request('http://localhost/api/admin/notifications', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clientToken1}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        target: 'ALL_ACTIVE',
        title: 'Illegal Broadcast',
        message: 'I am a client trying to broadcast',
        category: 'ALERT'
      })
    });
    const resClientAdmin = await app.request(reqClientAdmin, {}, workerEnv);
    assert.strictEqual(resClientAdmin.status, 403);
    console.log('✓ Test 13 Passed: Client token cannot access POST /api/admin/notifications (403 Forbidden)');

    // ==========================================
    // TEST 14: GET /api/admin/notifications/history without token returns 401
    // ==========================================
    const reqHistNoAuth = new Request('http://localhost/api/admin/notifications/history', {
      method: 'GET'
    });
    const resHistNoAuth = await app.request(reqHistNoAuth, {}, workerEnv);
    assert.strictEqual(resHistNoAuth.status, 401);
    console.log('✓ Test 14 Passed: GET /api/admin/notifications/history rejects unauthenticated request (401)');

    // ==========================================
    // TEST 15: GET /api/admin/notifications/history with client token returns 403
    // ==========================================
    const reqHistClient = new Request('http://localhost/api/admin/notifications/history', {
      method: 'GET',
      headers: { Authorization: `Bearer ${clientToken1}` }
    });
    const resHistClient = await app.request(reqHistClient, {}, workerEnv);
    assert.strictEqual(resHistClient.status, 403);
    console.log('✓ Test 15 Passed: GET /api/admin/notifications/history rejects client token (403 Forbidden)');

    // ==========================================
    // TEST 16: GET /api/admin/notifications/history with inactive admin token returns 403
    // ==========================================
    const reqHistInactiveAdmin = new Request('http://localhost/api/admin/notifications/history', {
      method: 'GET',
      headers: { Authorization: `Bearer ${inactiveAdminToken}` }
    });
    const resHistInactiveAdmin = await app.request(reqHistInactiveAdmin, {}, workerEnv);
    assert.strictEqual(resHistInactiveAdmin.status, 403);
    console.log('✓ Test 16 Passed: GET /api/admin/notifications/history rejects inactive admin (403 Forbidden)');

    // ==========================================
    // TEST 17: GET /api/admin/notifications/history with active admin returns combined history
    // ==========================================
    const reqHistAdmin = new Request('http://localhost/api/admin/notifications/history', {
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const resHistAdmin = await app.request(reqHistAdmin, {}, workerEnv);
    assert.strictEqual(resHistAdmin.status, 200);
    const jsonHistAdmin: any = await resHistAdmin.json();

    assert.strictEqual(jsonHistAdmin.success, true);
    assert.strictEqual(jsonHistAdmin.message, 'Notification history retrieved successfully.');
    assert.ok(Array.isArray(jsonHistAdmin.data.history));
    assert.ok(Array.isArray(jsonHistAdmin.history));
    assert.strictEqual(jsonHistAdmin.total, 2);
    assert.strictEqual(jsonHistAdmin.data.total, 2);
    assert.ok(typeof jsonHistAdmin.timestamp === 'string');

    // First item is newest (broadcast notification from Test 9)
    const bcastItem = jsonHistAdmin.data.history[0];
    assert.strictEqual(bcastItem.target, 'ALL_ACTIVE');
    assert.strictEqual(bcastItem.recipientUid, null);
    assert.strictEqual(bcastItem.recipientCount, 2);
    assert.strictEqual(bcastItem.title, 'GST Return Deadline Reminder');
    assert.strictEqual(bcastItem.status, 'COMPLETED');
    assert.strictEqual(bcastItem.createdByUid, 'admin-notif-user');

    // Second item is individual notification from Test 3
    const indItem = jsonHistAdmin.data.history[1];
    assert.strictEqual(indItem.target, 'INDIVIDUAL');
    assert.strictEqual(indItem.recipientUid, 'client-notif-1');
    assert.strictEqual(indItem.recipientCount, 1);
    assert.strictEqual(indItem.title, 'Form 26AS Ready');
    assert.strictEqual(indItem.status, 'COMPLETED');
    assert.strictEqual(indItem.createdByUid, 'admin-notif-user');
    console.log('✓ Test 17 Passed: GET /api/admin/notifications/history returns combined broadcast and individual history');

    // ==========================================
    // TEST 18: GET /api/admin/notifications/history?limit=1 pagination
    // ==========================================
    const reqHistPaged = new Request('http://localhost/api/admin/notifications/history?limit=1', {
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const resHistPaged = await app.request(reqHistPaged, {}, workerEnv);
    assert.strictEqual(resHistPaged.status, 200);
    const jsonHistPaged: any = await resHistPaged.json();
    assert.strictEqual(jsonHistPaged.data.history.length, 1);
    assert.strictEqual(jsonHistPaged.data.total, 2);
    console.log('✓ Test 18 Passed: GET /api/admin/notifications/history respects limit parameter');

    // ==========================================
    // TEST 19: GET /api/admin/notifications/history?limit=-5 rejects with 400
    // ==========================================
    const reqHistInvalid = new Request('http://localhost/api/admin/notifications/history?limit=-5', {
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const resHistInvalid = await app.request(reqHistInvalid, {}, workerEnv);
    assert.strictEqual(resHistInvalid.status, 400);
    console.log('✓ Test 19 Passed: GET /api/admin/notifications/history rejects invalid limit (400 Bad Request)');

    console.log('\n--- All Notification Centre Worker Endpoint Tests Passed! ---\n');
  } finally {
    globalThis.fetch = originalFetch;
    clearTokenCache();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runNotificationWorkerTests().catch((err) => {
    console.error('Notification Worker Endpoint Tests Failed:', err);
    process.exit(1);
  });
}

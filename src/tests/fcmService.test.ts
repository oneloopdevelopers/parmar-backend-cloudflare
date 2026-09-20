import assert from 'node:assert';
import {
  fcmService,
  computeTokenRecordId,
  validateFcmTokenString,
  sanitizeDeviceMetadata
} from '../services/fcmService';
import { BadRequestError, NotFoundError, ForbiddenError } from '../utils/errors';
import { generateKeyPair, exportPKCS8 } from 'jose';

export async function runFcmServiceTests() {
  console.log('\n--- Starting Tests for FCM Service & Delivery Engine ---');

  const { privateKey: saPrivateKey } = await generateKeyPair('RS256', { extractable: true });
  const saPrivateKeyPem = await exportPKCS8(saPrivateKey);

  const projectId = 'document-portal-d2b6d';
  const serviceAccountJson = JSON.stringify({
    project_id: projectId,
    client_email: 'fcm-test@example.com',
    private_key: saPrivateKeyPem
  });

  // =========================================================================
  // Section 1: Validation & Token Hash Unit Tests
  // =========================================================================
  console.log('--- Section 1: FCM Token Validation & SHA-256 Record ID ---');

  // Test 1: computeTokenRecordId
  const sampleToken1 = 'fcm_test_token_device_abc_1234567890_xyz';
  const hash1 = await computeTokenRecordId(sampleToken1);
  const hash1b = await computeTokenRecordId(sampleToken1);
  const hash2 = await computeTokenRecordId('fcm_test_token_device_def_9876543210_xyz');

  assert.strictEqual(hash1.length, 64, 'SHA-256 token hash must be exactly 64 hex chars');
  assert.strictEqual(hash1, hash1b, 'Same token must produce identical deterministic hash');
  assert.notStrictEqual(hash1, hash2, 'Different tokens must produce distinct hashes');
  assert.match(hash1, /^[0-9a-f]{64}$/, 'Hash must be lowercase hex characters');
  console.log('  ✓ Test 1 Passed: computeTokenRecordId produces deterministic, safe 64-char SHA-256 document IDs');

  // Test 2: validateFcmTokenString
  assert.strictEqual(validateFcmTokenString('  fcm_token_1234567890:APA91bE...xyz  '), 'fcm_token_1234567890:APA91bE...xyz');
  assert.throws(() => validateFcmTokenString(''), BadRequestError);
  assert.throws(() => validateFcmTokenString('   '), BadRequestError);
  assert.throws(() => validateFcmTokenString(null), BadRequestError);
  assert.throws(() => validateFcmTokenString(12345), BadRequestError);
  assert.throws(() => validateFcmTokenString('short'), BadRequestError); // < 10 chars
  assert.throws(() => validateFcmTokenString('a'.repeat(4097)), BadRequestError); // > 4096 chars
  assert.throws(() => validateFcmTokenString('token with spaces bad!'), BadRequestError);
  console.log('  ✓ Test 2 Passed: validateFcmTokenString enforces safe format, length boundaries, and non-empty checks');

  // Test 3: sanitizeDeviceMetadata
  const meta1 = sanitizeDeviceMetadata({ platform: 'ANDROID', appVersion: '2.1.0' });
  assert.strictEqual(meta1.platform, 'android');
  assert.strictEqual(meta1.appVersion, '2.1.0');

  const meta2 = sanitizeDeviceMetadata({});
  assert.strictEqual(meta2.platform, 'android');
  assert.strictEqual(meta2.appVersion, undefined);

  assert.throws(() => sanitizeDeviceMetadata({ platform: 'invalid platform! @#' }), BadRequestError);
  assert.throws(() => sanitizeDeviceMetadata({ appVersion: 'invalid version string with unsafe characters <script>' }), BadRequestError);
  console.log('  ✓ Test 3 Passed: sanitizeDeviceMetadata safely normalizes platform and validates appVersion');

  // =========================================================================
  // Section 2: Mock In-Memory Store & Token Registration/Unregistration
  // =========================================================================
  console.log('--- Section 2: FCM Device Token Registration, Updates & Multi-Device Support ---');

  const store = new Map<string, Record<string, unknown>>();

  // Active client
  store.set('users/client-fcm-1', {
    name: 'FCM Client 1',
    email: 'client1@example.com',
    phone: '+91 98765 11111',
    panNumber: 'ABCDE1111A',
    driveFolderId: 'folder-1',
    role: 'client',
    status: 'active'
  });

  // Inactive client
  store.set('users/client-fcm-inactive', {
    name: 'Inactive Client',
    email: 'inactive@example.com',
    phone: '+91 98765 22222',
    panNumber: 'ABCDE2222B',
    driveFolderId: 'folder-2',
    role: 'client',
    status: 'inactive'
  });

  // Admin user
  store.set('users/admin-user', {
    name: 'Admin User',
    email: 'admin@example.com',
    phone: '+91 98765 33333',
    panNumber: 'ABCDE3333C',
    driveFolderId: 'folder-3',
    role: 'admin',
    status: 'active'
  });

  // Intercepting fetch for Firestore REST mock
  const customFetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();

    // Mock Google OAuth token
    if (urlStr.includes('oauth2.googleapis.com/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'mock-fcm-oauth-token',
          expires_in: 3600,
          token_type: 'Bearer'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Mock Firestore REST
    if (urlStr.includes('firestore.googleapis.com/v1/projects/')) {
      const match = urlStr.match(/\/documents\/(.+?)(\?|$)/);
      const rawPath = match ? decodeURIComponent(match[1]) : '';
      const method = init?.method || 'GET';

      if (method === 'GET') {
        const segments = rawPath.split('/').filter(Boolean);
        const isCollectionQuery = segments.length % 2 !== 0;

        if (isCollectionQuery) {
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
  }) as typeof fetch;

  const ctx = { projectId, serviceAccountJson, customFetch };

  // Test 4: Rejects registration for inactive client or non-client
  await assert.rejects(
    () => fcmService.registerFcmToken('client-fcm-inactive', { token: 'device_token_abc_123456789' }, ctx),
    ForbiddenError
  );
  await assert.rejects(
    () => fcmService.registerFcmToken('admin-user', { token: 'device_token_abc_123456789' }, ctx),
    ForbiddenError
  );
  await assert.rejects(
    () => fcmService.registerFcmToken('unknown-user', { token: 'device_token_abc_123456789' }, ctx),
    NotFoundError
  );
  console.log('  ✓ Test 4 Passed: registerFcmToken enforces active client status and rejects non-clients/inactive users');

  // Test 5: Register device token 1 for active client (e.g. Phone)
  const phoneToken = 'phone_device_token_abc_1234567890';
  const phoneHash = await computeTokenRecordId(phoneToken);

  const reg1 = await fcmService.registerFcmToken(
    'client-fcm-1',
    { token: phoneToken, platform: 'android', appVersion: '1.0.0' },
    ctx
  );
  assert.strictEqual(reg1.success, true);
  assert.strictEqual(reg1.message, 'FCM token registered successfully.');

  const storedPhoneDoc = store.get(`users/client-fcm-1/fcmTokens/${phoneHash}`);
  assert.ok(storedPhoneDoc, 'Phone token document must exist in store');
  assert.strictEqual(storedPhoneDoc.token, phoneToken);
  assert.strictEqual(storedPhoneDoc.platform, 'android');
  assert.strictEqual(storedPhoneDoc.appVersion, '1.0.0');
  const originalCreatedAt = storedPhoneDoc.createdAt;
  console.log('  ✓ Test 5 Passed: registerFcmToken stores token under users/{uid}/fcmTokens/{sha256}');

  // Test 6: Register device token 2 for same client (e.g. Tablet) -> Multi-device support
  const tabletToken = 'tablet_device_token_def_9876543210';
  const tabletHash = await computeTokenRecordId(tabletToken);

  const reg2 = await fcmService.registerFcmToken(
    'client-fcm-1',
    { token: tabletToken, platform: 'android', appVersion: '1.0.1' },
    ctx
  );
  assert.strictEqual(reg2.success, true);

  // Both device tokens must exist
  const tokensList = await fcmService.getUserFcmTokens('client-fcm-1', ctx);
  assert.strictEqual(tokensList.length, 2, 'Client must have both phone and tablet tokens');
  assert.ok(tokensList.some((t) => t.token === phoneToken));
  assert.ok(tokensList.some((t) => t.token === tabletToken));
  console.log('  ✓ Test 6 Passed: Multi-device registration maintains multiple distinct tokens per client');

  // Test 7: Re-register existing token preserves createdAt and updates lastSeenAt
  const reg3 = await fcmService.registerFcmToken(
    'client-fcm-1',
    { token: phoneToken, platform: 'android', appVersion: '1.0.2' },
    ctx
  );
  assert.strictEqual(reg3.success, true);
  const updatedPhoneDoc = store.get(`users/client-fcm-1/fcmTokens/${phoneHash}`);
  assert.strictEqual(updatedPhoneDoc?.createdAt, originalCreatedAt, 'Original createdAt must be preserved');
  assert.strictEqual(updatedPhoneDoc?.appVersion, '1.0.2', 'AppVersion must be updated');
  console.log('  ✓ Test 7 Passed: Token re-registration preserves original createdAt timestamp');

  // Test 8: Unregister device token (e.g. tablet token)
  const unreg1 = await fcmService.unregisterFcmToken('client-fcm-1', { token: tabletToken }, ctx);
  assert.strictEqual(unreg1.success, true);
  assert.strictEqual(store.has(`users/client-fcm-1/fcmTokens/${tabletHash}`), false);

  // Remaining token count should be 1
  const remainingTokens = await fcmService.getUserFcmTokens('client-fcm-1', ctx);
  assert.strictEqual(remainingTokens.length, 1);
  assert.strictEqual(remainingTokens[0].token, phoneToken);
  console.log('  ✓ Test 8 Passed: unregisterFcmToken removes specific device token');

  // Test 9: Unregister non-existent token is idempotent
  const unreg2 = await fcmService.unregisterFcmToken('client-fcm-1', { token: 'non_existent_token_1234567890' }, ctx);
  assert.strictEqual(unreg2.success, true);
  console.log('  ✓ Test 9 Passed: unregisterFcmToken is safe and idempotent when token is already deleted');

  // =========================================================================
  // Section 3: FCM HTTP v1 Dispatch & Error Cleanup
  // =========================================================================
  console.log('--- Section 3: FCM HTTP v1 Dispatch & Invalid Token Auto-Cleanup ---');

  // Setup tokens in store: 1 valid, 1 expired/unregistered, 1 server-error token
  const validToken = 'valid_token_device_1234567890';
  const invalidToken = 'unregistered_token_expired_1234567890';
  const validHash = await computeTokenRecordId(validToken);
  const invalidHash = await computeTokenRecordId(invalidToken);

  store.set(`users/client-fcm-1/fcmTokens/${validHash}`, {
    token: validToken,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    platform: 'android'
  });

  store.set(`users/client-fcm-1/fcmTokens/${invalidHash}`, {
    token: invalidToken,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    platform: 'android'
  });

  // Intercepting fetch that also simulates FCM HTTP v1 responses
  let fcmCapturedPayload: any = null;
  let fcmCallCount = 0;

  const fcmMockFetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();

    // FCM HTTP v1 send endpoint
    if (urlStr.includes('fcm.googleapis.com/v1/projects/') && urlStr.includes('/messages:send')) {
      fcmCallCount++;
      const authHeader = (init?.headers as any)?.Authorization || (init?.headers as any)?.authorization;
      assert.ok(authHeader && authHeader.startsWith('Bearer mock-fcm-oauth-token'));

      const body = JSON.parse(init?.body as string || '{}');
      fcmCapturedPayload = body;
      const targetToken = body.message?.token;

      if (targetToken === validToken) {
        return new Response(JSON.stringify({ name: 'projects/document-portal-d2b6d/messages/msg_12345' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (targetToken === invalidToken) {
        // Return standard FCM 404 UNREGISTERED response
        return new Response(
          JSON.stringify({
            error: {
              code: 404,
              message: 'Requested entity was not found.',
              status: 'NOT_FOUND',
              details: [
                {
                  '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                  errorCode: 'UNREGISTERED'
                }
              ]
            }
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Default fallback
      return new Response(JSON.stringify({ error: { code: 500, message: 'Internal Server Error' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Delegate other requests to customFetch (OAuth / Firestore)
    return customFetch(url, init);
  }) as typeof fetch;

  const fcmCtx = { projectId, serviceAccountJson, customFetch: fcmMockFetch };

  // Test 10: Single FCM send success
  const sendSuccess = await fcmService.sendFcmMessage(
    validToken,
    {
      notificationId: 'notif_100',
      category: 'DOCUMENT_UPDATE',
      title: 'Tax Document Ready',
      message: 'Your ITR-V has been uploaded.'
    },
    fcmCtx
  );
  assert.strictEqual(sendSuccess.success, true);
  assert.strictEqual(sendSuccess.isInvalidToken, false);
  assert.strictEqual(fcmCapturedPayload?.message?.token, validToken);
  assert.strictEqual(fcmCapturedPayload?.message?.notification?.title, 'Tax Document Ready');
  assert.strictEqual(fcmCapturedPayload?.message?.notification?.body, 'Your ITR-V has been uploaded.');
  assert.strictEqual(fcmCapturedPayload?.message?.data?.notificationId, 'notif_100');
  assert.strictEqual(fcmCapturedPayload?.message?.data?.category, 'DOCUMENT_UPDATE');
  assert.strictEqual(fcmCapturedPayload?.message?.android?.notification?.channel_id, 'client_portal_notifications');
  console.log('  ✓ Test 10 Passed: sendFcmMessage formats HTTP v1 payload with canonical channel client_portal_notifications');

  // Test 11: Single FCM send invalid token detection
  const sendInvalid = await fcmService.sendFcmMessage(
    invalidToken,
    {
      notificationId: 'notif_101',
      category: 'GENERAL',
      title: 'Reminder',
      message: 'Please review documents.'
    },
    fcmCtx
  );
  assert.strictEqual(sendInvalid.success, false);
  assert.strictEqual(sendInvalid.isInvalidToken, true);
  assert.strictEqual(sendInvalid.errorCode, 'UNREGISTERED');
  console.log('  ✓ Test 11 Passed: sendFcmMessage detects permanently invalid tokens (UNREGISTERED)');

  // Test 12: dispatchFcmToUserTokens dispatches to all user tokens and auto-removes invalid tokens
  const deliveryStats = await fcmService.dispatchFcmToUserTokens(
    'client-fcm-1',
    {
      notificationId: 'notif_200',
      category: 'ALERT',
      title: 'Urgent Alert',
      message: 'Action required.'
    },
    fcmCtx
  );

  assert.strictEqual(deliveryStats.tokensAttempted >= 2, true);
  assert.strictEqual(deliveryStats.tokensDelivered >= 1, true);
  assert.strictEqual(deliveryStats.tokensRemoved, 1, 'Exactly 1 invalid token must be removed');

  // Verify invalid token was automatically removed from Firestore store
  assert.strictEqual(store.has(`users/client-fcm-1/fcmTokens/${invalidHash}`), false, 'Invalid token must be deleted from store');
  assert.strictEqual(store.has(`users/client-fcm-1/fcmTokens/${validHash}`), true, 'Valid token must be retained in store');
  console.log('  ✓ Test 12 Passed: dispatchFcmToUserTokens automatically removes invalid tokens and keeps valid ones');

  // Test 13: Broadcast FCM dispatch across clients
  store.set('users/client-fcm-2', {
    name: 'FCM Client 2',
    email: 'client2@example.com',
    phone: '+91 98765 44444',
    panNumber: 'ABCDE4444D',
    driveFolderId: 'folder-4',
    role: 'client',
    status: 'active'
  });

  const client2Token = 'valid_token_client2_1234567890';
  const client2Hash = await computeTokenRecordId(client2Token);
  store.set(`users/client-fcm-2/fcmTokens/${client2Hash}`, {
    token: client2Token,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    platform: 'android'
  });

  const broadcastDelivery = await fcmService.dispatchBroadcastFcm(
    ['client-fcm-1', 'client-fcm-2'],
    {
      notificationId: 'bcast_100',
      category: 'REMINDER',
      title: 'Office Holiday Notice',
      message: 'Our office will be closed on Friday.'
    },
    fcmCtx
  );

  assert.strictEqual(broadcastDelivery.tokensAttempted >= 2, true);
  assert.strictEqual(broadcastDelivery.tokensDelivered >= 1, true);
  console.log('  ✓ Test 13 Passed: dispatchBroadcastFcm distributes pushes across multiple active clients');

  console.log('--- All FCM Service & Delivery Engine Tests Passed Successfully! ---\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFcmServiceTests().catch((err) => {
    console.error('FCM Service Test Suite Failed:', err);
    process.exit(1);
  });
}

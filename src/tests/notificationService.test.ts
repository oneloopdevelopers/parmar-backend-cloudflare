import assert from 'node:assert';
import {
  notificationService,
  validateNotificationId,
  validateNotificationTitle,
  validateNotificationMessage,
  validateNotificationCategory,
  validateNotificationTarget,
  sanitizeNotificationMetadata
} from '../services/notificationService';
import { BadRequestError, NotFoundError, ForbiddenError } from '../utils/errors';
import { generateKeyPair, exportPKCS8 } from 'jose';

export async function runNotificationServiceTests() {
  console.log('\n--- Starting Tests for Notification Centre Service & Logic ---');

  const { privateKey: saPrivateKey } = await generateKeyPair('RS256', { extractable: true });
  const saPrivateKeyPem = await exportPKCS8(saPrivateKey);

  const projectId = 'document-portal-d2b6d';
  const serviceAccountJson = JSON.stringify({
    project_id: projectId,
    client_email: 'test@example.com',
    private_key: saPrivateKeyPem
  });

  // Section 1: Validation Unit Tests
  console.log('--- Section 1: Input Validation & Sanitization Unit Tests ---');

  // Test 1: validateNotificationId
  assert.strictEqual(validateNotificationId('notif-123_abc'), 'notif-123_abc');
  assert.throws(() => validateNotificationId(''), BadRequestError);
  assert.throws(() => validateNotificationId('   '), BadRequestError);
  assert.throws(() => validateNotificationId('../path/traversal'), BadRequestError);
  assert.throws(() => validateNotificationId('id/with/slash'), BadRequestError);
  assert.throws(() => validateNotificationId('a'.repeat(129)), BadRequestError);
  console.log('  ✓ Test 1 Passed: Notification ID validation enforces safe identifiers and rejects traversal');

  // Test 2: validateNotificationTitle
  assert.strictEqual(validateNotificationTitle('  Tax Return Ready  '), 'Tax Return Ready');
  assert.throws(() => validateNotificationTitle(''), BadRequestError);
  assert.throws(() => validateNotificationTitle('   '), BadRequestError);
  assert.throws(() => validateNotificationTitle('a'.repeat(201)), BadRequestError);
  console.log('  ✓ Test 2 Passed: Notification title validation enforces length (1..200) and rejects empty');

  // Test 3: validateNotificationMessage
  assert.strictEqual(validateNotificationMessage('  Important update for your documents  '), 'Important update for your documents');
  assert.throws(() => validateNotificationMessage(''), BadRequestError);
  assert.throws(() => validateNotificationMessage('a'.repeat(2001)), BadRequestError);
  console.log('  ✓ Test 3 Passed: Notification message validation enforces length (1..2000) and rejects empty');

  // Test 4: validateNotificationCategory
  assert.strictEqual(validateNotificationCategory('GENERAL'), 'GENERAL');
  assert.strictEqual(validateNotificationCategory('document_update'), 'DOCUMENT_UPDATE');
  assert.strictEqual(validateNotificationCategory('alert'), 'ALERT');
  assert.strictEqual(validateNotificationCategory('reminder'), 'REMINDER');
  assert.throws(() => validateNotificationCategory('PROMOTIONAL'), BadRequestError);
  assert.throws(() => validateNotificationCategory(''), BadRequestError);
  console.log('  ✓ Test 4 Passed: Category validation strictly permits only 4 standard categories');

  // Test 5: validateNotificationTarget
  assert.strictEqual(validateNotificationTarget('INDIVIDUAL'), 'INDIVIDUAL');
  assert.strictEqual(validateNotificationTarget('all_active'), 'ALL_ACTIVE');
  assert.throws(() => validateNotificationTarget('ALL'), BadRequestError);
  assert.throws(() => validateNotificationTarget('GROUP'), BadRequestError);
  console.log('  ✓ Test 5 Passed: Target validation permits only INDIVIDUAL and ALL_ACTIVE');

  // Test 6: sanitizeNotificationMetadata
  assert.strictEqual(sanitizeNotificationMetadata(undefined), undefined);
  assert.strictEqual(sanitizeNotificationMetadata(null), undefined);
  assert.deepStrictEqual(sanitizeNotificationMetadata({ docId: '123', count: 5, active: true }), {
    docId: '123',
    count: 5,
    active: true
  });
  assert.throws(() => sanitizeNotificationMetadata({ password: 'secret' }), BadRequestError);
  assert.throws(() => sanitizeNotificationMetadata({ token: 'abc' }), BadRequestError);
  assert.throws(() => sanitizeNotificationMetadata({ authSecret: '123' }), BadRequestError);
  assert.throws(() => sanitizeNotificationMetadata({ apiKey: 'xyz' }), BadRequestError);
  assert.throws(() => sanitizeNotificationMetadata({ driveFolderId: 'folder1' }), BadRequestError);
  console.log('  ✓ Test 6 Passed: Metadata sanitization rejects sensitive credentials and secrets');

  // Section 2: Mock Firestore Storage & Service Tests
  console.log('--- Section 2: Notification Service Workflow & IDOR Isolation Tests ---');

  // In-memory mock store for Firestore documents
  const store = new Map<string, Record<string, unknown>>();

  // Populate mock active client and inactive client
  store.set('users/client-active-1', {
    name: 'Active Client 1',
    email: 'client1@example.com',
    phone: '+91 98765 00001',
    panNumber: 'ABCDE1111A',
    driveFolderId: 'folder-1',
    role: 'client',
    status: 'active'
  });
  store.set('users/client-active-2', {
    name: 'Active Client 2',
    email: 'client2@example.com',
    phone: '+91 98765 00002',
    panNumber: 'ABCDE2222B',
    driveFolderId: 'folder-2',
    role: 'client',
    status: 'active'
  });
  store.set('users/client-inactive-3', {
    name: 'Inactive Client 3',
    email: 'client3@example.com',
    phone: '+91 98765 00003',
    panNumber: 'ABCDE3333C',
    driveFolderId: 'folder-3',
    role: 'client',
    status: 'inactive'
  });
  store.set('users/admin-user', {
    name: 'Admin User',
    email: 'admin@example.com',
    phone: '+91 98765 00004',
    panNumber: 'ABCDE4444D',
    driveFolderId: 'folder-4',
    role: 'admin',
    status: 'active'
  });

  const mockCustomFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(
        JSON.stringify({ access_token: 'mock-access-token', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Batch commit endpoint
    if (url.includes('/databases/(default)/documents:commit')) {
      const body = JSON.parse(String(init?.body || '{}'));
      for (const write of body.writes || []) {
        const fullPath = write.update.name;
        // Strip prefix projects/{projectId}/databases/(default)/documents/
        const docKey = fullPath.replace(/^projects\/[^/]+\/databases\/\(default\)\/documents\//, '');
        const fields = write.update.fields;
        const decoded: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields as Record<string, any>)) {
          if (v.stringValue !== undefined) decoded[k] = v.stringValue;
          else if (v.booleanValue !== undefined) decoded[k] = v.booleanValue;
          else if (v.integerValue !== undefined) decoded[k] = Number(v.integerValue);
          else if (v.nullValue !== undefined) decoded[k] = null;
        }
        store.set(docKey, decoded);
      }
      return new Response(
        JSON.stringify({ writeResults: (body.writes || []).map(() => ({ updateTime: new Date().toISOString() })) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Single document PATCH
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
        store.set(docKey, decoded);
        return new Response(JSON.stringify({ name: docKey, fields }), { status: 200 });
      }
    }

    // Single document GET
    if (!init?.method || init.method === 'GET') {
      const match = url.match(/\/databases\/\(default\)\/documents\/([^?]+)/);
      if (match) {
        const targetPath = decodeURIComponent(match[1]);

        // Check if collection list query
        if (targetPath === 'users' || targetPath.endsWith('/notifications') || targetPath === 'broadcast_notifications' || targetPath === 'admin_notifications') {
          const prefix = targetPath + '/';
          const docs: any[] = [];
          for (const [key, val] of store.entries()) {
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

        // Single document lookup
        if (store.has(targetPath)) {
          const val = store.get(targetPath)!;
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

        return new Response(JSON.stringify({ error: { code: 404, message: 'Document not found' } }), { status: 404 });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  };

  const ctx = {
    projectId,
    serviceAccountJson,
    customFetch: mockCustomFetch
  };

  // Test 7: Admin sends INDIVIDUAL notification to active client
  const indResult = await notificationService.createNotification(
    'admin-user',
    {
      target: 'INDIVIDUAL',
      recipientUid: 'client-active-1',
      title: 'Tax Document Upload Required',
      message: 'Please provide your Form 16 before the 15th.',
      category: 'DOCUMENT_UPDATE'
    },
    ctx
  );
  assert.strictEqual(indResult.target, 'INDIVIDUAL');
  if (indResult.target === 'INDIVIDUAL') {
    assert.strictEqual(indResult.notification.recipientUid, 'client-active-1');
    assert.strictEqual(indResult.notification.isRead, false);
    assert.strictEqual(indResult.notification.isDismissed, false);
    assert.strictEqual(indResult.notification.category, 'DOCUMENT_UPDATE');
  }
  console.log('  ✓ Test 7 Passed: Admin successfully sends individual notification to active client');

  // Test 8: Admin fails to send notification to inactive client
  await assert.rejects(
    notificationService.createNotification(
      'admin-user',
      {
        target: 'INDIVIDUAL',
        recipientUid: 'client-inactive-3',
        title: 'Notice',
        message: 'Account check',
        category: 'GENERAL'
      },
      ctx
    ),
    (err: any) => err instanceof BadRequestError && err.message.includes('inactive')
  );
  console.log('  ✓ Test 8 Passed: Admin cannot send notification to inactive client');

  // Test 9: Admin fails to send notification to non-existent user
  await assert.rejects(
    notificationService.createNotification(
      'admin-user',
      {
        target: 'INDIVIDUAL',
        recipientUid: 'client-ghost-999',
        title: 'Notice',
        message: 'Where are you',
        category: 'GENERAL'
      },
      ctx
    ),
    (err: any) => err instanceof NotFoundError
  );
  console.log('  ✓ Test 9 Passed: Admin cannot send notification to non-existent recipient');

  // Test 10: Admin sends ALL_ACTIVE broadcast notification
  const bcastResult = await notificationService.createNotification(
    'admin-user',
    {
      target: 'ALL_ACTIVE',
      title: 'Annual Maintenance Downtime',
      message: 'Portal will be in read-only mode this Sunday between 2AM and 4AM IST.',
      category: 'ALERT'
    },
    ctx
  );
  assert.strictEqual(bcastResult.target, 'ALL_ACTIVE');
  if (bcastResult.target === 'ALL_ACTIVE') {
    assert.strictEqual(bcastResult.recipientCount, 2); // only client-active-1 and client-active-2
  }
  console.log('  ✓ Test 10 Passed: Admin broadcast dispatches exclusively to active clients');

  // Test 11: Client 1 lists notifications (should have 2: individual + broadcast)
  const client1List = await notificationService.listClientNotifications('client-active-1', {}, ctx);
  assert.strictEqual(client1List.notifications.length, 2);
  assert.strictEqual(client1List.unreadCount, 2);
  console.log('  ✓ Test 11 Passed: Client retrieves own notifications with accurate unread count');

  // Test 12: Client 2 lists notifications (should have 1: only broadcast, NOT Client 1 individual)
  const client2List = await notificationService.listClientNotifications('client-active-2', {}, ctx);
  assert.strictEqual(client2List.notifications.length, 1);
  assert.strictEqual(client2List.unreadCount, 1);
  assert.strictEqual(client2List.notifications[0].title, 'Annual Maintenance Downtime');
  console.log('  ✓ Test 12 Passed: Tenant isolation verified: Client 2 does not receive Client 1 notifications');

  // Test 13: Client 1 marks first notification as read
  const notifToRead = client1List.notifications[0].id;
  const readResult = await notificationService.markNotificationAsRead('client-active-1', notifToRead, ctx);
  assert.strictEqual(readResult.notification.isRead, true);
  assert.ok(readResult.notification.readAt);
  assert.strictEqual(readResult.unreadCount, 1); // 1 remaining unread
  console.log('  ✓ Test 13 Passed: Marking single notification as read updates readAt and unread count');

  // Test 14: Client 2 attempts IDOR to read Client 1 notification (must fail with NotFound)
  await assert.rejects(
    notificationService.markNotificationAsRead('client-active-2', notifToRead, ctx),
    (err: any) => err instanceof NotFoundError
  );
  console.log('  ✓ Test 14 Passed: IDOR protection: Client cannot read another client\'s notification (404)');

  // Test 15: Client 2 attempts IDOR to dismiss Client 1 notification (must fail with NotFound)
  await assert.rejects(
    notificationService.dismissNotification('client-active-2', notifToRead, ctx),
    (err: any) => err instanceof NotFoundError
  );
  console.log('  ✓ Test 15 Passed: IDOR protection: Client cannot dismiss another client\'s notification (404)');

  // Test 16: Client 1 dismisses notification
  const dismissResult = await notificationService.dismissNotification('client-active-1', notifToRead, ctx);
  assert.strictEqual(dismissResult.success, true);
  // Re-list: default list excludes dismissed
  const listAfterDismiss = await notificationService.listClientNotifications('client-active-1', {}, ctx);
  assert.strictEqual(listAfterDismiss.notifications.length, 1);
  // Include dismissed
  const listWithDismissed = await notificationService.listClientNotifications(
    'client-active-1',
    { includeDismissed: true },
    ctx
  );
  assert.strictEqual(listWithDismissed.notifications.length, 2);
  console.log('  ✓ Test 16 Passed: Dismissed notification excluded by default and included with includeDismissed=true');

  // Test 17: Inactive client access attempt rejected
  await assert.rejects(
    notificationService.listClientNotifications('client-inactive-3', {}, ctx),
    (err: any) => err instanceof ForbiddenError
  );
  console.log('  ✓ Test 17 Passed: Inactive client account blocked from notifications API (403 Forbidden)');

  // Test 18: Client 1 marks all remaining notifications as read
  const markAllResult = await notificationService.markAllNotificationsAsRead('client-active-1', ctx);
  assert.strictEqual(markAllResult.success, true);
  assert.strictEqual(markAllResult.unreadCount, 0);
  const finalUnread = await notificationService.getClientUnreadCount('client-active-1', ctx);
  assert.strictEqual(finalUnread.unreadCount, 0);
  console.log('  ✓ Test 18 Passed: Mark all as read resets client unread count to zero');

  // Test 19: Admin retrieves notification history (both broadcast and individual notifications)
  const historyResult = await notificationService.getNotificationHistory({}, ctx);
  assert.strictEqual(historyResult.total, 2);
  assert.strictEqual(historyResult.history.length, 2);
  // Must be sorted newest first (bcast was sent after indResult)
  assert.strictEqual(historyResult.history[0].target, 'ALL_ACTIVE');
  assert.strictEqual(historyResult.history[0].recipientUid, null);
  assert.strictEqual(historyResult.history[0].recipientCount, 2);
  assert.strictEqual(historyResult.history[0].title, 'Annual Maintenance Downtime');
  assert.strictEqual(historyResult.history[0].status, 'COMPLETED');

  assert.strictEqual(historyResult.history[1].target, 'INDIVIDUAL');
  assert.strictEqual(historyResult.history[1].recipientUid, 'client-active-1');
  assert.strictEqual(historyResult.history[1].recipientCount, 1);
  assert.strictEqual(historyResult.history[1].title, 'Tax Document Upload Required');
  assert.strictEqual(historyResult.history[1].status, 'COMPLETED');
  console.log('  ✓ Test 19 Passed: Notification history returns combined broadcast and individual records sorted newest-first');

  // Test 20: Admin retrieves notification history with limit
  const pagedHistory = await notificationService.getNotificationHistory({ limit: 1 }, ctx);
  assert.strictEqual(pagedHistory.total, 2);
  assert.strictEqual(pagedHistory.history.length, 1);
  assert.strictEqual(pagedHistory.history[0].title, 'Annual Maintenance Downtime');
  console.log('  ✓ Test 20 Passed: Notification history properly respects limit parameter');

  // Test 21: Admin retrieves notification history with invalid limit throws BadRequestError
  await assert.rejects(
    notificationService.getNotificationHistory({ limit: -5 }, ctx),
    (err: any) => err instanceof BadRequestError
  );
  await assert.rejects(
    notificationService.getNotificationHistory({ limit: 'invalid' }, ctx),
    (err: any) => err instanceof BadRequestError
  );
  console.log('  ✓ Test 21 Passed: Invalid limit values properly rejected with BadRequestError');

  console.log('\n--- All Notification Service Tests Passed Successfully! ---');
}

// Execute tests if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runNotificationServiceTests().catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
}

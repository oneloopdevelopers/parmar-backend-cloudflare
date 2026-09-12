import assert from 'node:assert';
import {
  decodeFirestoreValue,
  decodeFirestoreFields,
  FirestoreRestService
} from '../services/firestoreRestService';
import { clearTokenCache } from '../services/googleServiceAccountAuth';
import { generateKeyPair, exportPKCS8 } from 'jose';

async function runFirestoreRestServiceTests() {
  console.log('\n--- Starting Tests for Firestore REST Service ---');

  // Test 1: Field decoding
  {
    assert.strictEqual(decodeFirestoreValue({ stringValue: 'test-string' }), 'test-string');
    assert.strictEqual(decodeFirestoreValue({ booleanValue: true }), true);
    assert.strictEqual(decodeFirestoreValue({ booleanValue: false }), false);
    assert.strictEqual(decodeFirestoreValue({ integerValue: '42' }), 42);
    assert.strictEqual(decodeFirestoreValue({ doubleValue: 3.14 }), 3.14);
    assert.strictEqual(decodeFirestoreValue({ timestampValue: '2026-09-12T10:00:00Z' }), '2026-09-12T10:00:00Z');
    assert.strictEqual(decodeFirestoreValue({ nullValue: null }), null);

    // Nested map
    const mapVal = decodeFirestoreValue({
      mapValue: {
        fields: {
          key1: { stringValue: 'val1' },
          key2: { integerValue: '10' }
        }
      }
    });
    assert.deepStrictEqual(mapVal, { key1: 'val1', key2: 10 });

    // Array of values
    const arrayVal = decodeFirestoreValue({
      arrayValue: {
        values: [{ stringValue: 'item1' }, { integerValue: '99' }]
      }
    });
    assert.deepStrictEqual(arrayVal, ['item1', 99]);

    console.log('✓ Test 1 Passed: Correctly decodes all Firestore REST value types');
  }

  // Test 2: Full document decoding
  {
    const rawDocFields = {
      name: { stringValue: 'Rajesh Sharma' },
      email: { stringValue: 'rajesh@example.com' },
      phone: { stringValue: '+91 98765 43210' },
      panNumber: { stringValue: 'ABCDE1234F' },
      driveFolderId: { stringValue: 'folder-abc-123' },
      role: { stringValue: 'client' },
      status: { stringValue: 'active' }
    };

    const decoded = decodeFirestoreFields(rawDocFields);
    assert.strictEqual(decoded.name, 'Rajesh Sharma');
    assert.strictEqual(decoded.email, 'rajesh@example.com');
    assert.strictEqual(decoded.panNumber, 'ABCDE1234F');
    assert.strictEqual(decoded.driveFolderId, 'folder-abc-123');
    assert.strictEqual(decoded.role, 'client');
    assert.strictEqual(decoded.status, 'active');

    console.log('✓ Test 2 Passed: Correctly decodes full Firestore REST document');
  }

  // Generate test credentials
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const testServiceAccountJson = JSON.stringify({
    project_id: 'document-portal-d2b6d',
    private_key: privateKeyPem,
    client_email: 'test@document-portal-d2b6d.iam.gserviceaccount.com'
  });

  // Test 3: getClientProfile with simulated fetch
  {
    clearTokenCache();
    const service = new FirestoreRestService();

    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/users/test-uid-active')) {
        return new Response(
          JSON.stringify({
            name: 'projects/document-portal-d2b6d/databases/(default)/documents/users/test-uid-active',
            fields: {
              name: { stringValue: 'Active Client' },
              email: { stringValue: 'active@example.com' },
              phone: { stringValue: '+1 555-123-4567' },
              panNumber: { stringValue: 'ABCDE1234F' },
              driveFolderId: { stringValue: 'folder-12345' },
              role: { stringValue: 'client' },
              status: { stringValue: 'active' }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/users/test-uid-not-found')) {
        return new Response(
          JSON.stringify({ error: { code: 404, message: 'Document not found' } }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('Not found', { status: 404 });
    }) as any;

    const profile = await service.getClientProfile('test-uid-active', {
      projectId: 'document-portal-d2b6d',
      serviceAccountJson: testServiceAccountJson,
      customFetch: mockFetch
    });

    assert.strictEqual(profile.name, 'Active Client');
    assert.strictEqual(profile.email, 'active@example.com');
    assert.strictEqual(profile.status, 'active');
    assert.strictEqual(profile.driveFolderId, 'folder-12345');
    console.log('✓ Test 3 Passed: Successfully loads active client profile via Firestore REST');

    // 404 handling
    await assert.rejects(
      async () => {
        await service.getClientProfile('test-uid-not-found', {
          projectId: 'document-portal-d2b6d',
          serviceAccountJson: testServiceAccountJson,
          customFetch: mockFetch
        });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 404);
        assert.ok(err.message.includes('does not exist'));
        return true;
      }
    );
    console.log('✓ Test 4 Passed: Throws NotFoundError for non-existent Firestore profile');
  }

  console.log('--- All Firestore REST Service Tests Passed! ---\n');
}

runFirestoreRestServiceTests().catch((err) => {
  console.error('Firestore REST Service Tests Failed:', err);
  process.exit(1);
});

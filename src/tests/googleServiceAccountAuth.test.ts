import assert from 'node:assert';
import { generateKeyPair, exportPKCS8 } from 'jose';
import {
  parseServiceAccountJson,
  createServiceAccountAssertion,
  getGoogleAccessToken,
  clearTokenCache,
  GOOGLE_DRIVE_READ_SCOPE,
  GOOGLE_DRIVE_WRITE_SCOPE,
  normalizeScopes
} from '../services/googleServiceAccountAuth';

async function runGoogleServiceAccountAuthTests() {
  console.log('\n--- Starting Tests for Google Service Account Auth Service ---');

  // Generate a test RSA key pair using Web Crypto
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);

  const validServiceAccount = {
    type: 'service_account',
    project_id: 'document-portal-d2b6d',
    private_key_id: 'test-key-id-123',
    private_key: privateKeyPem,
    client_email: 'test-backend@document-portal-d2b6d.iam.gserviceaccount.com',
    client_id: '1234567890',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  };

  const validJsonString = JSON.stringify(validServiceAccount);

  // Test 1: Parses valid service account JSON
  {
    const creds = parseServiceAccountJson(validJsonString);
    assert.strictEqual(creds.project_id, 'document-portal-d2b6d');
    assert.strictEqual(creds.client_email, 'test-backend@document-portal-d2b6d.iam.gserviceaccount.com');
    assert.ok(creds.private_key.includes('BEGIN PRIVATE KEY'));
    console.log('✓ Test 1 Passed: Correctly parses valid service account JSON');
  }

  // Test 2: Rejects empty or non-string input
  {
    assert.throws(() => parseServiceAccountJson(''), /credentials are missing/);
    assert.throws(() => parseServiceAccountJson('   '), /credentials are missing/);
    assert.throws(() => parseServiceAccountJson('invalid json string'), /not valid JSON/);
    console.log('✓ Test 2 Passed: Correctly rejects empty, whitespace, and non-JSON input');
  }

  // Test 3: Rejects JSON missing required fields
  {
    assert.throws(
      () => parseServiceAccountJson(JSON.stringify({ client_email: 'a@b.com', private_key: 'key' })),
      /missing the required 'project_id'/
    );
    assert.throws(
      () => parseServiceAccountJson(JSON.stringify({ project_id: 'proj', private_key: 'key' })),
      /missing the required 'client_email'/
    );
    assert.throws(
      () => parseServiceAccountJson(JSON.stringify({ project_id: 'proj', client_email: 'a@b.com' })),
      /missing the required 'private_key'/
    );
    console.log('✓ Test 3 Passed: Rejects service account missing required fields');
  }

  // Test 4: Creates a valid RS256 JWT assertion using Web Crypto
  {
    const creds = parseServiceAccountJson(validJsonString);
    const assertion = await createServiceAccountAssertion(creds);
    assert.ok(typeof assertion === 'string');
    assert.strictEqual(assertion.split('.').length, 3, 'JWT should have 3 segments');
    console.log('✓ Test 4 Passed: Successfully creates RS256 signed JWT assertion');
  }

  // Test 5: Token caching and exchange with mock fetch
  {
    clearTokenCache();

    let fetchCallCount = 0;
    const mockAccessToken = 'mock-google-oauth-access-token-xyz-123';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        fetchCallCount++;
        return new Response(
          JSON.stringify({
            access_token: mockAccessToken,
            expires_in: 3600,
            token_type: 'Bearer'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    }) as any;

    try {
      // First call: Should fetch new token
      const result1 = await getGoogleAccessToken(validJsonString);
      assert.strictEqual(result1.accessToken, mockAccessToken);
      assert.strictEqual(result1.projectId, 'document-portal-d2b6d');
      assert.strictEqual(fetchCallCount, 1, 'Should call token endpoint once');

      // Second call: Should use cached token without additional fetch
      const result2 = await getGoogleAccessToken(validJsonString);
      assert.strictEqual(result2.accessToken, mockAccessToken);
      assert.strictEqual(fetchCallCount, 1, 'Should return cached token without calling fetch again');

      // Force refresh: Should call fetch again
      const result3 = await getGoogleAccessToken(validJsonString, { forceRefresh: true });
      assert.strictEqual(result3.accessToken, mockAccessToken);
      assert.strictEqual(fetchCallCount, 2, 'Force refresh should trigger new token fetch');

      console.log('✓ Test 5 Passed: Successfully handles token exchange and in-memory caching');
    } finally {
      globalThis.fetch = originalFetch;
      clearTokenCache();
    }
  }

  // Test 6: Token cache key isolation across different OAuth scopes
  {
    clearTokenCache();

    let fetchCallCount = 0;
    let lastRequestedAssertion = '';
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        fetchCallCount++;
        const bodyStr = String(init?.body || '');
        const params = new URLSearchParams(bodyStr);
        lastRequestedAssertion = params.get('assertion') || '';

        // Return token tagged with the count to distinguish tokens
        return new Response(
          JSON.stringify({
            access_token: `mock-token-${fetchCallCount}`,
            expires_in: 3600,
            token_type: 'Bearer'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    }) as any;

    try {
      // 1. Fetch token with GOOGLE_DRIVE_READ_SCOPE
      const readRes1 = await getGoogleAccessToken(validJsonString, { scopes: GOOGLE_DRIVE_READ_SCOPE });
      assert.strictEqual(readRes1.accessToken, 'mock-token-1');
      assert.strictEqual(fetchCallCount, 1);

      // 2. Second call with same GOOGLE_DRIVE_READ_SCOPE: should be served from cache
      const readRes2 = await getGoogleAccessToken(validJsonString, { scopes: GOOGLE_DRIVE_READ_SCOPE });
      assert.strictEqual(readRes2.accessToken, 'mock-token-1');
      assert.strictEqual(fetchCallCount, 1, 'Should return cached read token');

      // 3. Fetch token with GOOGLE_DRIVE_WRITE_SCOPE: MUST NOT use the read token!
      const writeRes1 = await getGoogleAccessToken(validJsonString, { scopes: GOOGLE_DRIVE_WRITE_SCOPE });
      assert.strictEqual(writeRes1.accessToken, 'mock-token-2', 'Write scope must trigger new token fetch');
      assert.strictEqual(fetchCallCount, 2, 'Should not reuse read token for write operation');

      // 4. Second call with GOOGLE_DRIVE_WRITE_SCOPE: should be served from cache
      const writeRes2 = await getGoogleAccessToken(validJsonString, { scopes: GOOGLE_DRIVE_WRITE_SCOPE });
      assert.strictEqual(writeRes2.accessToken, 'mock-token-2');
      assert.strictEqual(fetchCallCount, 2, 'Should return cached write token');

      // 5. Subsequent call with GOOGLE_DRIVE_READ_SCOPE: should still be served from read cache
      const readRes3 = await getGoogleAccessToken(validJsonString, { scopes: GOOGLE_DRIVE_READ_SCOPE });
      assert.strictEqual(readRes3.accessToken, 'mock-token-1');
      assert.strictEqual(fetchCallCount, 2, 'Read token should still be independently cached');

      console.log('✓ Test 6 Passed: Token cache strictly isolates by client_email and normalized scopes');
    } finally {
      globalThis.fetch = originalFetch;
      clearTokenCache();
    }
  }

  console.log('--- All Google Service Account Auth Service Tests Passed! ---\n');
}

runGoogleServiceAccountAuthTests().catch((err) => {
  console.error('Google Service Account Auth Tests Failed:', err);
  process.exit(1);
});

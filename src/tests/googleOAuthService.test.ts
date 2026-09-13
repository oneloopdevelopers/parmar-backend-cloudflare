import assert from 'node:assert';
import {
  encryptRefreshToken,
  decryptRefreshToken,
  importAesKey,
  timingSafeEqual,
  generateOAuthState,
  storeOAuthState,
  validateAndConsumeOAuthState,
  buildGoogleOAuthUrl,
  exchangeAuthorizationCode,
  refreshGoogleDriveAccessToken,
  getGoogleDriveOAuthAccessToken,
  clearOAuthTokenCache,
  generateSignedSetupToken,
  validateAndConsumeSetupToken,
  createSetupSession,
  DEFAULT_REDIRECT_URI,
  resolveOAuthRedirectUri
} from '../services/googleOAuthService';
import { createWorkerApp, resolveDriveAuthOptions } from '../worker';
import { KVNamespace, Env } from '../types/worker.types';
import { firestoreRestService } from '../services/firestoreRestService';

async function runGoogleOAuthServiceTests() {
  console.log('\n--- Starting Tests for Google OAuth 2.0 Backend Service ---');

  // Strict 32-byte (256-bit) AES key in Base64:
  // "test-aes-256-key-32-bytes-long!!" is exactly 32 ASCII characters
  const testEncryptionKey = 'dGVzdC1hZXMtMjU2LWtleS0zMi1ieXRlcy1sb25nISE=';
  const testRefreshToken = '1//04_fake_refresh_token_abc123xyz_test_token';

  // -------------------------------------------------------------
  // Test 1: AES-256-GCM Encryption and Decryption Round-Trip
  // -------------------------------------------------------------
  console.log('Test 1: AES-256-GCM Encryption & Decryption Round-Trip');
  const ciphertext1 = await encryptRefreshToken(testRefreshToken, testEncryptionKey);
  assert.ok(typeof ciphertext1 === 'string' && ciphertext1.length > 20, 'Ciphertext should be a non-empty string');
  assert.notStrictEqual(ciphertext1, testRefreshToken, 'Ciphertext must not match plaintext');

  // Ensure IV randomization: encrypting twice produces different ciphertexts
  const ciphertext2 = await encryptRefreshToken(testRefreshToken, testEncryptionKey);
  assert.notStrictEqual(ciphertext1, ciphertext2, 'Consecutive encryptions must have unique IVs');

  const decrypted = await decryptRefreshToken(ciphertext1, testEncryptionKey);
  assert.strictEqual(decrypted, testRefreshToken, 'Decrypted token must match original plaintext');
  console.log('✓ Test 1 Passed: Encryption and decryption round-trip verified with unique IVs');

  // -------------------------------------------------------------
  // Test 2: Strict Key Validation & Tampered Ciphertext Rejection
  // -------------------------------------------------------------
  console.log('Test 2: Strict 32-Byte Base64 Key Validation & Tamper Rejection');

  // 2a: Reject non-Base64 key
  let nonBase64Failed = false;
  try {
    await importAesKey('not-base64-key-with-invalid-chars!@#$%^&*()');
  } catch (err: any) {
    nonBase64Failed = true;
    assert.ok(err.message.includes('not valid Base64'));
  }
  assert.strictEqual(nonBase64Failed, true, 'Non-Base64 key must be rejected');

  // 2b: Reject Base64 key that does not decode to exactly 32 bytes (e.g. 16 bytes)
  let wrongLengthFailed = false;
  try {
    // 16-byte key: "1234567890123456" in Base64 -> "MTIzNDU2Nzg5MDEyMzQ1Ng=="
    await importAesKey('MTIzNDU2Nzg5MDEyMzQ1Ng==');
  } catch (err: any) {
    wrongLengthFailed = true;
    assert.ok(err.message.includes('must represent exactly 32 random bytes'));
  }
  assert.strictEqual(wrongLengthFailed, true, 'Key that is not 32 bytes must be rejected');

  // 2c: Tampered ciphertext rejection
  let tamperedFailed = false;
  try {
    const tampered = ciphertext1.slice(0, -4) + 'AAAA';
    await decryptRefreshToken(tampered, testEncryptionKey);
  } catch {
    tamperedFailed = true;
  }
  assert.strictEqual(tamperedFailed, true, 'Tampered ciphertext must be rejected');

  // 2d: Different 32-byte key rejection
  const wrong32ByteKey = 'YW5vdGhlci0zMi1ieXRlLWtleS1mb3ItdGVzdCEhIQ=='; // "another-32-byte-key-for-test!!!"
  let wrongKeyFailed = false;
  try {
    await decryptRefreshToken(ciphertext1, wrong32ByteKey);
  } catch {
    wrongKeyFailed = true;
  }
  assert.strictEqual(wrongKeyFailed, true, 'Decryption with wrong 32-byte key must fail');
  console.log('✓ Test 2 Passed: Strict 32-byte Base64 key validation and tamper rejection verified');

  // -------------------------------------------------------------
  // Test 3: Constant-Time String Comparison (timingSafeEqual)
  // -------------------------------------------------------------
  console.log('Test 3: timingSafeEqual Constant-Time Comparison');
  assert.strictEqual(timingSafeEqual('correct-secret', 'correct-secret'), true, 'Identical strings must return true');
  assert.strictEqual(timingSafeEqual('correct-secret', 'wrong-secret'), false, 'Different strings must return false');
  assert.strictEqual(timingSafeEqual('short', 'much-longer-string'), false, 'Different length strings must return false');
  assert.strictEqual(timingSafeEqual('', ''), true, 'Empty strings must return true');
  assert.strictEqual(timingSafeEqual('', 'non-empty'), false, 'Empty vs non-empty must return false');
  console.log('✓ Test 3 Passed: timingSafeEqual behaves correctly');

  // -------------------------------------------------------------
  // Test 4: OAuth State Generation and Single-Use Consumption
  // -------------------------------------------------------------
  console.log('Test 4: OAuth State Generation & KV / In-Memory Single-Use Consumption');
  const state1 = generateOAuthState();
  const state2 = generateOAuthState();
  assert.strictEqual(state1.length, 43, 'State should be 43-char base64url string (32 bytes entropy)');
  assert.notStrictEqual(state1, state2, 'Generated states must be unique');

  // Test in-memory fallback
  await storeOAuthState(state1, undefined, 60);
  const isValidMemory = await validateAndConsumeOAuthState(state1, undefined);
  assert.strictEqual(isValidMemory, true, 'First consumption must succeed');
  const isReplayMemory = await validateAndConsumeOAuthState(state1, undefined);
  assert.strictEqual(isReplayMemory, false, 'Second consumption (replay) must be rejected');

  // Test KV binding
  const mockKvStore = new Map<string, string>();
  const mockKv: KVNamespace = {
    async get(key: string) {
      return mockKvStore.get(key) || null;
    },
    async put(key: string, value: string) {
      mockKvStore.set(key, value);
    },
    async delete(key: string) {
      mockKvStore.delete(key);
    }
  };

  await storeOAuthState(state2, mockKv, 600);
  assert.strictEqual(mockKvStore.has(`oauth_state:${state2}`), true, 'State should be saved to KV');

  const isValidKv = await validateAndConsumeOAuthState(state2, mockKv);
  assert.strictEqual(isValidKv, true, 'First consumption in KV must succeed');
  assert.strictEqual(mockKvStore.has(`oauth_state:${state2}`), false, 'State must be deleted from KV immediately');

  const isReplayKv = await validateAndConsumeOAuthState(state2, mockKv);
  assert.strictEqual(isReplayKv, false, 'Replay consumption in KV must be rejected');
  console.log('✓ Test 4 Passed: OAuth state generation, storage, and replay prevention verified');

  // -------------------------------------------------------------
  // Test 5: Build Google OAuth Authorization URL
  // -------------------------------------------------------------
  console.log('Test 5: Build Google OAuth URL');
  const authUrl = buildGoogleOAuthUrl({
    clientId: 'test-client-id.apps.googleusercontent.com',
    redirectUri: 'https://backend.example.com/api/oauth/google/callback',
    state: state1
  });
  const parsedUrl = new URL(authUrl);
  assert.strictEqual(parsedUrl.origin, 'https://accounts.google.com');
  assert.strictEqual(parsedUrl.pathname, '/o/oauth2/v2/auth');
  assert.strictEqual(parsedUrl.searchParams.get('client_id'), 'test-client-id.apps.googleusercontent.com');
  assert.strictEqual(parsedUrl.searchParams.get('redirect_uri'), 'https://backend.example.com/api/oauth/google/callback');
  assert.strictEqual(parsedUrl.searchParams.get('response_type'), 'code');
  assert.strictEqual(parsedUrl.searchParams.get('access_type'), 'offline');
  assert.strictEqual(parsedUrl.searchParams.get('prompt'), 'consent');
  assert.strictEqual(parsedUrl.searchParams.get('state'), state1);
  assert.strictEqual(parsedUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive');
  console.log('✓ Test 5 Passed: Google OAuth authorization URL constructed with all required parameters');

  // -------------------------------------------------------------
  // Test 6: Authorization Code Exchange
  // -------------------------------------------------------------
  console.log('Test 6: Authorization Code Exchange with Token Endpoint');
  const mockFetchCodeExchange: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = init?.body ? String(init.body) : '';
      const params = new URLSearchParams(body);
      if (params.get('code') === 'valid-auth-code') {
        return new Response(JSON.stringify({
          access_token: 'ya29.test_access_token_12345',
          refresh_token: '1//test_refresh_token_67890',
          expires_in: 3600,
          token_type: 'Bearer'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } else {
        return new Response(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Bad code'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response('Not Found', { status: 404 });
  };

  const exchangeResult = await exchangeAuthorizationCode({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    code: 'valid-auth-code',
    redirectUri: 'https://backend.example.com/api/oauth/google/callback',
    customFetch: mockFetchCodeExchange
  });

  assert.strictEqual(exchangeResult.accessToken, 'ya29.test_access_token_12345');
  assert.strictEqual(exchangeResult.refreshToken, '1//test_refresh_token_67890');
  assert.strictEqual(exchangeResult.expiresIn, 3600);

  let exchangeErrorThrown = false;
  try {
    await exchangeAuthorizationCode({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      code: 'bad-code',
      redirectUri: 'https://backend.example.com/api/oauth/google/callback',
      customFetch: mockFetchCodeExchange
    });
  } catch {
    exchangeErrorThrown = true;
  }
  assert.strictEqual(exchangeErrorThrown, true, 'Bad authorization code must throw an error');
  console.log('✓ Test 6 Passed: Authorization code exchange logic verified');

  // -------------------------------------------------------------
  // Test 7: Refresh Token Exchange & In-Memory Token Caching
  // -------------------------------------------------------------
  console.log('Test 7: Refresh Token Exchange & Token Caching');
  let refreshTokenCalls = 0;
  const mockFetchRefreshToken: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url === 'https://oauth2.googleapis.com/token') {
      refreshTokenCalls++;
      return new Response(JSON.stringify({
        access_token: `ya29.refreshed_token_call_${refreshTokenCalls}`,
        expires_in: 3600,
        token_type: 'Bearer'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  };

  const refreshed = await refreshGoogleDriveAccessToken({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: testRefreshToken,
    customFetch: mockFetchRefreshToken
  });
  assert.strictEqual(refreshed.accessToken, 'ya29.refreshed_token_call_1');
  assert.strictEqual(refreshed.expiresIn, 3600);
  console.log('✓ Test 7 Passed: Refresh token exchange verified');

  // -------------------------------------------------------------
  // Test 8: getGoogleDriveOAuthAccessToken Integration
  // -------------------------------------------------------------
  console.log('Test 8: getGoogleDriveOAuthAccessToken with Firestore & Cache');
  clearOAuthTokenCache();

  // 8a: When OAuth secrets are missing, returns null
  const emptyEnv: Env = {
    FIREBASE_PROJECT_ID: 'document-portal-d2b6d'
  };
  const noOAuthToken = await getGoogleDriveOAuthAccessToken(emptyEnv);
  assert.strictEqual(noOAuthToken, null, 'Should return null when OAuth env variables are missing');

  // 8b: When OAuth secrets are provided and Firestore document exists
  const mockFirestoreDoc = {
    provider: 'google-drive',
    refreshTokenCiphertext: ciphertext1,
    accountEmail: 'storage.owner@gmail.com',
    updatedAt: new Date().toISOString()
  };

  const mockEnv: Env = {
    FIREBASE_PROJECT_ID: 'document-portal-d2b6d',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: 'document-portal-d2b6d',
      private_key: 'mock-key',
      client_email: 'mock-sa@document-portal-d2b6d.iam.gserviceaccount.com'
    }),
    GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY: testEncryptionKey
  };

  // Mock firestoreRestService.getDocument
  const originalGetDoc = firestoreRestService.getDocument.bind(firestoreRestService);
  firestoreRestService.getDocument = async (collection: string, docId: string) => {
    if (collection === 'oauth' && docId === 'googleDrive') {
      return mockFirestoreDoc;
    }
    return null;
  };

  const token1 = await getGoogleDriveOAuthAccessToken(mockEnv, { customFetch: mockFetchRefreshToken });
  assert.ok(token1 && token1.startsWith('ya29.'), 'Should successfully obtain OAuth access token');
  const initialCallCount = refreshTokenCalls;

  // Next call should use in-memory cache without calling refresh token endpoint
  const token2 = await getGoogleDriveOAuthAccessToken(mockEnv, { customFetch: mockFetchRefreshToken });
  assert.strictEqual(token2, token1, 'Cached token should match first token');
  assert.strictEqual(refreshTokenCalls, initialCallCount, 'Should not call refresh endpoint when cached');

  // Restore firestoreRestService
  firestoreRestService.getDocument = originalGetDoc;
  clearOAuthTokenCache();
  console.log('✓ Test 8 Passed: getGoogleDriveOAuthAccessToken correctly handles missing env, Firestore fetch, and caching');

  // -------------------------------------------------------------
  // Test 9: Setup Token & HTTP Endpoints: init-setup & start
  // -------------------------------------------------------------
  console.log('Test 9: Setup Token & /api/oauth/google/start Verification');
  const app = createWorkerApp();

  const testSetupKey = 'my-super-secret-admin-setup-key-2026';
  const workerEnv: Env = {
    FIREBASE_PROJECT_ID: 'document-portal-d2b6d',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: 'document-portal-d2b6d',
      private_key: 'mock-key',
      client_email: 'mock-sa@document-portal-d2b6d.iam.gserviceaccount.com'
    }),
    GOOGLE_OAUTH_SETUP_KEY: testSetupKey,
    GOOGLE_OAUTH_CLIENT_ID: 'test-oauth-client-id.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY: testEncryptionKey,
    GOOGLE_OAUTH_STATE: mockKv
  };

  // 9a: POST /api/oauth/google/init-setup missing key -> 401
  const resInitNoKey = await app.fetch(
    new Request('https://backend.example.com/api/oauth/google/init-setup', { method: 'POST' }),
    workerEnv
  );
  assert.strictEqual(resInitNoKey.status, 401, 'init-setup without key must return 401');

  // 9b: POST /api/oauth/google/init-setup with invalid key -> 401
  const resInitBadKey = await app.fetch(
    new Request('https://backend.example.com/api/oauth/google/init-setup', {
      method: 'POST',
      headers: { 'X-Google-OAuth-Setup-Key': 'wrong-setup-key' }
    }),
    workerEnv
  );
  assert.strictEqual(resInitBadKey.status, 401, 'init-setup with wrong key must return 401');

  // 9c: POST /api/oauth/google/init-setup with valid key -> 200 with setupUrl
  const resInitSuccess = await app.fetch(
    new Request('https://backend.example.com/api/oauth/google/init-setup', {
      method: 'POST',
      headers: { 'X-Google-OAuth-Setup-Key': testSetupKey }
    }),
    workerEnv
  );
  assert.strictEqual(resInitSuccess.status, 200, 'init-setup with valid key must return 200');
  const initData = await resInitSuccess.json() as any;
  assert.strictEqual(initData.success, true);
  assert.ok(initData.setupUrl && initData.setupUrl.includes('/api/oauth/google/start?setup='), 'setupUrl must contain start route with setup token');
  assert.strictEqual(initData.setupUrl.includes(testSetupKey), false, 'setupUrl must NOT leak the permanent setup key');

  // Extract the generated setup token from setupUrl
  const setupUrlObj = new URL(initData.setupUrl);
  const validSetupToken = setupUrlObj.searchParams.get('setup')!;
  assert.ok(validSetupToken, 'Setup token must exist');

  // 9d: GET /api/oauth/google/start without setup token -> 401 with clean HTML
  const resStartNoToken = await app.fetch(
    new Request('https://backend.example.com/api/oauth/google/start'),
    workerEnv
  );
  assert.strictEqual(resStartNoToken.status, 401, 'Missing setup token must return 401');
  const startNoTokenHtml = await resStartNoToken.text();
  assert.ok(startNoTokenHtml.includes('Setup Authorization Required'), 'HTML must explain setup required');

  // 9e: GET /api/oauth/google/start with invalid setup token -> 401 with clean HTML
  const resStartBadToken = await app.fetch(
    new Request('https://backend.example.com/api/oauth/google/start?setup=invalid-token'),
    workerEnv
  );
  assert.strictEqual(resStartBadToken.status, 401, 'Invalid setup token must return 401');

  // 9f: GET /api/oauth/google/start with valid setup token -> 302 Redirect to Google OAuth consent
  const resStartSuccess = await app.fetch(
    new Request(`https://backend.example.com/api/oauth/google/start?setup=${encodeURIComponent(validSetupToken)}`),
    workerEnv
  );
  assert.strictEqual(resStartSuccess.status, 302, 'Valid start request must return 302 redirect');
  const startLocation = resStartSuccess.headers.get('Location');
  assert.ok(startLocation && startLocation.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), 'Redirect must point to Google OAuth');
  const issuedRedirectUrl = new URL(startLocation!);
  const issuedState = issuedRedirectUrl.searchParams.get('state');
  assert.ok(issuedState, 'Redirect must contain state param');
  assert.strictEqual(mockKvStore.has(`oauth_state:${issuedState}`), true, 'Issued state must be stored in KV');

  // 9g: Single-Use Replay Rejection: second GET with identical setup token -> 401
  const resStartReplay = await app.fetch(
    new Request(`https://backend.example.com/api/oauth/google/start?setup=${encodeURIComponent(validSetupToken)}`),
    workerEnv
  );
  assert.strictEqual(resStartReplay.status, 401, 'Replayed setup token must be rejected with 401');
  console.log('✓ Test 9 Passed: init-setup session generation, single-use setup token validation, and redirect verified');

  // -------------------------------------------------------------
  // Test 10: HTTP Endpoint: GET /api/oauth/google/callback
  // -------------------------------------------------------------
  console.log('Test 10: GET /api/oauth/google/callback Endpoint Verification');

  // 10a: Error param from Google -> 400 clean failure HTML
  const resCallbackError = await app.fetch(
    new Request('https://backend.example.com/api/oauth/google/callback?error=access_denied'),
    workerEnv
  );
  assert.strictEqual(resCallbackError.status, 400, 'Callback with error param must return 400');
  const errorHtml = await resCallbackError.text();
  assert.ok(errorHtml.includes('Google Drive authorization failed.<br>Please contact the administrator.'));

  // 10b: Missing code or state -> 400 clean failure HTML
  const resMissingParams = await app.fetch(
    new Request('https://backend.example.com/api/oauth/google/callback?code=some-code'),
    workerEnv
  );
  assert.strictEqual(resMissingParams.status, 400, 'Missing state param must return 400');

  // 10c: Invalid or expired state -> 400 clean failure HTML
  const resInvalidState = await app.fetch(
    new Request('https://backend.example.com/api/oauth/google/callback?code=some-code&state=non-existent-state'),
    workerEnv
  );
  assert.strictEqual(resInvalidState.status, 400, 'Invalid state must return 400');

  // 10d: Successful callback
  // Seed a valid state in KV
  const testCallbackState = generateOAuthState();
  await storeOAuthState(testCallbackState, mockKv, 600);

  // Mock global fetch for token exchange during the callback test
  const originalFetch = globalThis.fetch;
  let storedFirestoreDoc: any = null;
  const originalSetDoc = firestoreRestService.setDocument.bind(firestoreRestService);
  firestoreRestService.setDocument = async (coll, doc, data) => {
    if (coll === 'oauth' && doc === 'googleDrive') {
      storedFirestoreDoc = data;
    }
  };

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({
        access_token: 'ya29.test_callback_access_token',
        refresh_token: testRefreshToken,
        expires_in: 3600,
        token_type: 'Bearer'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('drive/v3/about')) {
      return new Response(JSON.stringify({
        user: { emailAddress: 'storage.owner@gmail.com' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input, init);
  };

  try {
    const resCallbackSuccess = await app.fetch(
      new Request(`https://backend.example.com/api/oauth/google/callback?code=valid-code&state=${testCallbackState}`),
      workerEnv
    );
    assert.strictEqual(resCallbackSuccess.status, 200, 'Valid callback must return 200');
    const html = await resCallbackSuccess.text();
    assert.ok(
      html.includes('Google Drive authorization completed successfully.<br>You may close this window.'),
      'HTML must contain exact success message'
    );
    // Security check: HTML must NEVER expose credentials
    assert.strictEqual(html.includes('test-client-secret'), false, 'HTML must never expose client secret');
    assert.strictEqual(html.includes(testRefreshToken), false, 'HTML must never expose refresh token');
    assert.strictEqual(html.includes('ya29.'), false, 'HTML must never expose access token');

    // Verify Firestore document was written
    assert.ok(storedFirestoreDoc, 'Firestore document oauth/googleDrive must be written');
    assert.strictEqual(storedFirestoreDoc.provider, 'google-drive');
    assert.strictEqual(storedFirestoreDoc.accountEmail, 'storage.owner@gmail.com');
    assert.ok(storedFirestoreDoc.refreshTokenCiphertext, 'Ciphertext must be present');

    // Verify stored ciphertext can be decrypted back to the test refresh token
    const decryptedStored = await decryptRefreshToken(
      storedFirestoreDoc.refreshTokenCiphertext,
      testEncryptionKey
    );
    assert.strictEqual(decryptedStored, testRefreshToken, 'Stored ciphertext must decrypt to the refresh token');

    // Verify state was consumed (cannot be replayed)
    const replayCheck = await validateAndConsumeOAuthState(testCallbackState, mockKv);
    assert.strictEqual(replayCheck, false, 'Used state must be consumed from KV');
  } finally {
    globalThis.fetch = originalFetch;
    firestoreRestService.setDocument = originalSetDoc;
  }
  console.log('✓ Test 10 Passed: GET /api/oauth/google/callback completed with encrypted Firestore storage and clean HTML');

  // -------------------------------------------------------------
  // Test 11: resolveDriveAuthOptions - No Silent Fallback Verification
  // -------------------------------------------------------------
  console.log('Test 11: resolveDriveAuthOptions No Silent Fallback Verification');
  clearOAuthTokenCache();

  // 11a: Without OAuth configuration, resolves to serviceAccountJson fallback
  const fallbackOptions = await resolveDriveAuthOptions(emptyEnv, '{"mock":"sa"}');
  assert.strictEqual(fallbackOptions.serviceAccountJson, '{"mock":"sa"}');
  assert.strictEqual(fallbackOptions.accessToken, undefined);

  // 11b: With OAuth configured and token unavailable (not authorized yet),
  // MUST throw BadGatewayError and NOT silently fall back to service account!
  firestoreRestService.getDocument = async () => null; // No stored token doc
  let noSilentFallbackThrown = false;
  try {
    await resolveDriveAuthOptions(mockEnv, '{"mock":"sa"}');
  } catch (err: any) {
    noSilentFallbackThrown = true;
    assert.ok(err.message.includes('authorization has not been completed') || err.message.includes('unavailable'));
  }
  assert.strictEqual(
    noSilentFallbackThrown,
    true,
    'When OAuth is configured but fails, must throw controlled error instead of falling back'
  );

  // 11c: With OAuth configured and stored token available, resolves with accessToken
  firestoreRestService.getDocument = async (collection: string, docId: string) => {
    if (collection === 'oauth' && docId === 'googleDrive') {
      return mockFirestoreDoc;
    }
    return null;
  };

  const origFetch11 = globalThis.fetch;
  globalThis.fetch = mockFetchRefreshToken;
  let oauthOptions;
  try {
    oauthOptions = await resolveDriveAuthOptions(mockEnv, '{"mock":"sa"}');
  } finally {
    globalThis.fetch = origFetch11;
  }
  assert.ok(oauthOptions.accessToken && oauthOptions.accessToken.startsWith('ya29.'));
  assert.strictEqual(oauthOptions.serviceAccountJson, undefined, 'serviceAccountJson should not be passed when OAuth succeeds');

  firestoreRestService.getDocument = originalGetDoc;
  clearOAuthTokenCache();
  console.log('✓ Test 11 Passed: resolveDriveAuthOptions strictly enforces OAuth when configured with NO silent fallback');

  // -------------------------------------------------------------
  // Test 12: resolveOAuthRedirectUri Resolution and Validation
  // -------------------------------------------------------------
  console.log('Test 12: resolveOAuthRedirectUri Resolution and Validation');
  // 12a: Defaults strictly to DEFAULT_REDIRECT_URI when env var is absent or empty
  assert.strictEqual(
    resolveOAuthRedirectUri({} as Env),
    'https://parmar-backend-cloudflare.oneloopdevelopers.workers.dev/api/oauth/google/callback'
  );
  assert.strictEqual(
    resolveOAuthRedirectUri({ GOOGLE_OAUTH_REDIRECT_URI: '' } as unknown as Env),
    'https://parmar-backend-cloudflare.oneloopdevelopers.workers.dev/api/oauth/google/callback'
  );

  // 12b: Accepts valid HTTPS custom URL
  const customHttpsUri = 'https://custom-worker.example.workers.dev/api/oauth/google/callback';
  assert.strictEqual(
    resolveOAuthRedirectUri({ GOOGLE_OAUTH_REDIRECT_URI: customHttpsUri } as unknown as Env),
    customHttpsUri
  );

  // 12c: Rejects insecure HTTP URL
  assert.throws(
    () => resolveOAuthRedirectUri({ GOOGLE_OAUTH_REDIRECT_URI: 'http://insecure.example.com/callback' } as unknown as Env),
    /GOOGLE_OAUTH_REDIRECT_URI must be an absolute HTTPS URL/
  );

  // 12d: Rejects non-absolute / invalid URL strings
  assert.throws(
    () => resolveOAuthRedirectUri({ GOOGLE_OAUTH_REDIRECT_URI: 'not-a-valid-url' } as unknown as Env),
    /not a valid absolute URL/
  );
  console.log('✓ Test 12 Passed: resolveOAuthRedirectUri strictly defaults to registered URI and validates HTTPS');

  console.log('\n--- All Google OAuth 2.0 Backend Service Tests Passed! ---\n');
}

runGoogleOAuthServiceTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});


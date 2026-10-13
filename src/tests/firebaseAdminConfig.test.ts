import assert from 'node:assert';
import { 
  validateAndParseServiceAccountJson, 
  TARGET_FIREBASE_PROJECT_ID 
} from '../config/firebaseAdmin';

async function runFirebaseAdminConfigTests() {
  console.log('--- Starting Tests for Firebase Admin Configuration & Secret Security ---\n');
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ FAIL: ${name}`);
      console.error(err);
      failed++;
    }
  }

  // 1. Rejects empty string
  await test('1. Rejects empty or whitespace-only FIREBASE_SERVICE_ACCOUNT_JSON', () => {
    assert.throws(
      () => validateAndParseServiceAccountJson(''),
      /FIREBASE_SERVICE_ACCOUNT_JSON is empty/
    );
    assert.throws(
      () => validateAndParseServiceAccountJson('   '),
      /FIREBASE_SERVICE_ACCOUNT_JSON is empty/
    );
  });

  // 2. Rejects malformed JSON without exposing keys
  await test('2. Rejects malformed JSON with safe error message', () => {
    assert.throws(
      () => validateAndParseServiceAccountJson('{ invalid_json: '),
      /FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON/
    );
  });

  // 3. Rejects non-object JSON (arrays, numbers, strings)
  await test('3. Rejects non-object JSON types', () => {
    assert.throws(
      () => validateAndParseServiceAccountJson('["not", "an", "object"]'),
      /FIREBASE_SERVICE_ACCOUNT_JSON must be a valid JSON object/
    );
    assert.throws(
      () => validateAndParseServiceAccountJson('"just a string"'),
      /FIREBASE_SERVICE_ACCOUNT_JSON must be a valid JSON object/
    );
  });

  // 4. Rejects missing project_id
  await test('4. Rejects JSON with missing project_id', () => {
    const json = JSON.stringify({
      client_email: 'firebase-adminsdk@test.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\n-----END PRIVATE KEY-----\n'
    });
    assert.throws(
      () => validateAndParseServiceAccountJson(json),
      /missing the required 'project_id' field/
    );
  });

  // 5. Strictly rejects project ID mismatch
  await test('5. Strictly rejects project_id that does not match parmar-consultancy', () => {
    const wrongProjectJson = JSON.stringify({
      project_id: 'some-other-unauthorized-project',
      client_email: 'test@some-other.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nfake-key\n-----END PRIVATE KEY-----\n'
    });
    assert.throws(
      () => validateAndParseServiceAccountJson(wrongProjectJson, 'parmar-consultancy'),
      /Project ID mismatch: Service account project_id 'some-other-unauthorized-project' does not match authorized target project 'parmar-consultancy'/
    );
  });

  // 6. Rejects missing client_email
  await test('6. Rejects JSON with missing client_email', () => {
    const json = JSON.stringify({
      project_id: TARGET_FIREBASE_PROJECT_ID,
      private_key: '-----BEGIN PRIVATE KEY-----\nfake-key\n-----END PRIVATE KEY-----\n'
    });
    assert.throws(
      () => validateAndParseServiceAccountJson(json),
      /missing the required 'client_email' field/
    );
  });

  // 7. Rejects missing private_key
  await test('7. Rejects JSON with missing private_key', () => {
    const json = JSON.stringify({
      project_id: TARGET_FIREBASE_PROJECT_ID,
      client_email: 'admin@parmar-consultancy.iam.gserviceaccount.com'
    });
    assert.throws(
      () => validateAndParseServiceAccountJson(json),
      /missing the required 'private_key' field/
    );
  });

  // 8. Successfully parses and normalizes valid parmar-consultancy service account
  await test('8. Successfully validates and parses authentic parmar-consultancy service account', () => {
    const validJson = JSON.stringify({
      type: 'service_account',
      project_id: 'parmar-consultancy',
      private_key_id: 'key123',
      private_key: '-----BEGIN PRIVATE KEY-----\\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\\n-----END PRIVATE KEY-----\\n',
      client_email: 'firebase-adminsdk-test@parmar-consultancy.iam.gserviceaccount.com',
      client_id: '123456789'
    });

    const parsed = validateAndParseServiceAccountJson(validJson, 'parmar-consultancy');
    assert.strictEqual(parsed.project_id, 'parmar-consultancy');
    assert.strictEqual(parsed.client_email, 'firebase-adminsdk-test@parmar-consultancy.iam.gserviceaccount.com');
    // Ensure escaped newlines are normalized
    assert.ok(parsed.private_key.includes('\n'));
    assert.ok(!parsed.private_key.includes('\\n'));
  });

  console.log(`\n========================================`);
  console.log(`Firebase Config Tests Complete: ${passed} passed, ${failed} failed.`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runFirebaseAdminConfigTests();

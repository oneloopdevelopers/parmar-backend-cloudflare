import assert from 'assert';
import { googleDriveService } from '../services/googleDriveService';
import { testDriveAccess } from '../controllers/drive.controller';
import { enforceZeroTrustIdentity } from '../middleware/validation.middleware';
import { AuthenticatedRequest } from '../types';

let testsPassed = 0;
function pass(desc: string) {
  testsPassed++;
  console.log(`  ✓ PASS: ${desc}`);
}

async function runTests() {
  console.log('\n--- Starting Tests for Google Drive Service & /api/drive/test ---');

  // Test 1: Instantiation of Drive client
  try {
    const driveClient = googleDriveService.createDriveClient();
    assert(driveClient !== null && driveClient !== undefined, 'Drive client must not be null');
    assert(typeof driveClient.files.get === 'function', 'Drive client must have files.get');
    assert(typeof driveClient.files.list === 'function', 'Drive client must have files.list');
    pass('1. googleDriveService.createDriveClient() successfully instantiates Drive v3 client');
  } catch (err: any) {
    assert.fail(`Test 1 failed: ${err.message}`);
  }

  // Test 2: Zero-trust middleware rejects driveFolderId in query
  try {
    const req = {
      body: {},
      query: { driveFolderId: 'fake-folder-123' },
      params: {},
      headers: {},
    } as any;
    let capturedError: any = null;
    enforceZeroTrustIdentity(req, {} as any, (err?: any) => {
      capturedError = err;
    });
    assert(capturedError !== null, 'Middleware must pass error to next');
    assert.strictEqual(capturedError.statusCode, 400);
    assert(capturedError.message.includes('Security violation'));
    pass('2. enforceZeroTrustIdentity rejects client-supplied driveFolderId in query params (400)');
  } catch (err: any) {
    assert.fail(`Test 2 failed: ${err.message}`);
  }

  // Test 3: Zero-trust middleware rejects driveFolderId in body
  try {
    const req = {
      body: { drive_folder_id: 'fake-folder-123' },
      query: {},
      params: {},
      headers: {},
    } as any;
    let capturedError: any = null;
    enforceZeroTrustIdentity(req, {} as any, (err?: any) => {
      capturedError = err;
    });
    assert(capturedError !== null, 'Middleware must pass error to next');
    assert.strictEqual(capturedError.statusCode, 400);
    assert(capturedError.message.includes('Security violation'));
    pass('3. enforceZeroTrustIdentity rejects client-supplied drive_folder_id in request body (400)');
  } catch (err: any) {
    assert.fail(`Test 3 failed: ${err.message}`);
  }

  // Test 4: Zero-trust middleware rejects custom client header x-drive-folder-id
  try {
    const req = {
      body: {},
      query: {},
      params: {},
      headers: { 'x-drive-folder-id': 'fake-folder-123' },
    } as any;
    let capturedError: any = null;
    enforceZeroTrustIdentity(req, {} as any, (err?: any) => {
      capturedError = err;
    });
    assert(capturedError !== null, 'Middleware must pass error to next');
    assert.strictEqual(capturedError.statusCode, 400);
    assert(capturedError.message.includes('Security violation'));
    pass('4. enforceZeroTrustIdentity rejects client-supplied x-drive-folder-id in request headers (400)');
  } catch (err: any) {
    assert.fail(`Test 4 failed: ${err.message}`);
  }

  // Test 5: /api/drive/test controller rejects missing verified UID (401)
  try {
    const req = {
      user: undefined,
    } as any;
    let capturedError: any = null;
    await testDriveAccess(req, {} as any, (err) => { capturedError = err; });
    assert(capturedError !== null, 'Controller must pass error to next');
    assert.strictEqual(capturedError.statusCode, 401);
    pass('5. testDriveAccess controller rejects request without verified Firebase UID (401)');
  } catch (err: any) {
    assert.fail(`Test 5 failed: ${err.message}`);
  }

  // Test 6: folderId validation in googleDriveService rejects empty/invalid input
  try {
    let errorCaught = false;
    try {
      await googleDriveService.getDriveFolderMetadata('');
    } catch (err: any) {
      errorCaught = true;
      assert.strictEqual(err.statusCode, 400);
    }
    assert(errorCaught, 'Should reject empty folder ID');
    pass('6. googleDriveService.getDriveFolderMetadata rejects empty folder ID (400)');
  } catch (err: any) {
    assert.fail(`Test 6 failed: ${err.message}`);
  }

  // Test 7: folderId validation in listFilesInFolder rejects empty/invalid input
  try {
    let errorCaught = false;
    try {
      await googleDriveService.listFilesInFolder('');
    } catch (err: any) {
      errorCaught = true;
      assert.strictEqual(err.statusCode, 400);
    }
    assert(errorCaught, 'Should reject empty folder ID');
    pass('7. googleDriveService.listFilesInFolder rejects empty folder ID (400)');
  } catch (err: any) {
    assert.fail(`Test 7 failed: ${err.message}`);
  }

  console.log(`\n========================================`);
  console.log(`Drive Tests Complete: ${testsPassed} passed, 0 failed.`);
  console.log(`========================================\n`);
}

runTests().catch((err) => {
  console.error('Test suite failed with unexpected error:', err);
  process.exit(1);
});

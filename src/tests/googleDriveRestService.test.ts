import assert from 'node:assert';
import { GoogleDriveRestService } from '../services/googleDriveRestService';
import { clearTokenCache } from '../services/googleServiceAccountAuth';
import { generateKeyPair, exportPKCS8 } from 'jose';

async function runGoogleDriveRestServiceTests() {
  console.log('\n--- Starting Tests for Google Drive REST Service ---');

  // Generate test credentials
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const testServiceAccountJson = JSON.stringify({
    project_id: 'document-portal-d2b6d',
    private_key: privateKeyPem,
    client_email: 'test@document-portal-d2b6d.iam.gserviceaccount.com'
  });

  const service = new GoogleDriveRestService();

  // Test 1: getDriveFolderMetadata with valid folder
  {
    clearTokenCache();

    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/drive/v3/files/valid-folder-id')) {
        return new Response(
          JSON.stringify({
            id: 'valid-folder-id',
            name: 'Client Documents Folder',
            mimeType: 'application/vnd.google-apps.folder',
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/drive/v3/files/trashed-folder-id')) {
        return new Response(
          JSON.stringify({
            id: 'trashed-folder-id',
            name: 'Old Folder',
            mimeType: 'application/vnd.google-apps.folder',
            trashed: true
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('Not found', { status: 404 });
    }) as any;

    const folderMeta = await service.getDriveFolderMetadata('valid-folder-id', {
      serviceAccountJson: testServiceAccountJson,
      customFetch: mockFetch
    });

    assert.strictEqual(folderMeta.id, 'valid-folder-id');
    assert.strictEqual(folderMeta.name, 'Client Documents Folder');
    assert.strictEqual(folderMeta.mimeType, 'application/vnd.google-apps.folder');
    console.log('✓ Test 1 Passed: Successfully retrieves folder metadata via Drive REST');

    // Trashed folder check
    await assert.rejects(
      async () => {
        await service.getDriveFolderMetadata('trashed-folder-id', {
          serviceAccountJson: testServiceAccountJson,
          customFetch: mockFetch
        });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 404);
        assert.ok(err.message.includes('trash'));
        return true;
      }
    );
    console.log('✓ Test 2 Passed: Rejects trashed Google Drive folder with 404');
  }

  // Test 3: listFilesInFolder with pagination and safe metadata projection
  {
    clearTokenCache();

    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/drive/v3/files?') && !url.includes('pageToken=page2')) {
        return new Response(
          JSON.stringify({
            nextPageToken: 'page2',
            files: [
              {
                id: 'file-1',
                name: 'PAN_Card.pdf',
                mimeType: 'application/pdf',
                size: '204800',
                createdTime: '2026-09-01T10:00:00Z',
                modifiedTime: '2026-09-01T10:00:00Z'
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('pageToken=page2')) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'file-2',
                name: 'Aadhaar.pdf',
                mimeType: 'application/pdf',
                size: '153600',
                createdTime: '2026-09-02T11:00:00Z',
                modifiedTime: '2026-09-02T11:00:00Z'
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('Not found', { status: 404 });
    }) as any;

    const files = await service.listFilesInFolder('folder-xyz', {
      serviceAccountJson: testServiceAccountJson,
      customFetch: mockFetch
    });

    assert.strictEqual(files.length, 2, 'Should combine pages 1 and 2');
    assert.strictEqual(files[0].name, 'PAN_Card.pdf');
    assert.strictEqual(files[1].name, 'Aadhaar.pdf');
    assert.strictEqual(files[0].size, '204800');
    console.log('✓ Test 3 Passed: Successfully lists files with pagination across pages via Drive REST');
  }

  // Test 4: getFileMetadata returns metadata including parents and trashed status
  {
    clearTokenCache();

    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/drive/v3/files/file-meta-123')) {
        return new Response(
          JSON.stringify({
            id: 'file-meta-123',
            name: 'Tax_Return_2025.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-user-1'],
            size: '512000',
            trashed: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('Not found', { status: 404 });
    }) as any;

    const meta = await service.getFileMetadata('file-meta-123', {
      serviceAccountJson: testServiceAccountJson,
      customFetch: mockFetch
    });

    assert.strictEqual(meta.id, 'file-meta-123');
    assert.strictEqual(meta.name, 'Tax_Return_2025.pdf');
    assert.strictEqual(meta.mimeType, 'application/pdf');
    assert.deepStrictEqual(meta.parents, ['folder-user-1']);
    assert.strictEqual(meta.size, '512000');
    assert.strictEqual(meta.trashed, false);
    console.log('✓ Test 4 Passed: Successfully retrieves file metadata with parents and size');
  }

  // Test 5: downloadFileStream streams file content using alt=media
  {
    clearTokenCache();

    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/drive/v3/files/file-stream-123?alt=media')) {
        return new Response('Mock PDF Binary Data Stream', {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': '28'
          }
        });
      }

      return new Response('Not found', { status: 404 });
    }) as any;

    const downloadRes = await service.downloadFileStream('file-stream-123', {
      serviceAccountJson: testServiceAccountJson,
      customFetch: mockFetch
    });

    assert.ok(downloadRes.stream, 'Stream should not be null');
    assert.strictEqual(downloadRes.contentType, 'application/pdf');
    assert.strictEqual(downloadRes.contentLength, '28');

    // Read the stream to verify content
    const reader = downloadRes.stream.getReader();
    const { value, done } = await reader.read();
    assert.strictEqual(done, false);
    const text = new TextDecoder().decode(value);
    assert.strictEqual(text, 'Mock PDF Binary Data Stream');
    console.log('✓ Test 5 Passed: Successfully streams file content using alt=media');
  }

  console.log('--- All Google Drive REST Service Tests Passed! ---\n');
}

runGoogleDriveRestServiceTests().catch((err) => {
  console.error('Google Drive REST Service Tests Failed:', err);
  process.exit(1);
});

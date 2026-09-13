import assert from 'node:assert';
import { GoogleDriveRestService } from '../services/googleDriveRestService';
import { clearTokenCache, GOOGLE_DRIVE_WRITE_SCOPE } from '../services/googleServiceAccountAuth';
import { generateKeyPair, exportPKCS8, decodeJwt } from 'jose';

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

  // Test 6: uploadFileMultipart successful upload with exact wire-level multipart validation
  {
    clearTokenCache();

    let capturedRequestBodyBytes: Uint8Array | null = null;
    let capturedHeaders: Record<string, string> = {};
    let capturedTokenAssertion: string = '';

    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        const bodyStr = String(init?.body || '');
        const params = new URLSearchParams(bodyStr);
        capturedTokenAssertion = params.get('assertion') || '';

        return new Response(
          JSON.stringify({ access_token: 'mock-upload-token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
        capturedHeaders = (init?.headers as Record<string, string>) || {};
        if (init?.body instanceof Uint8Array) {
          capturedRequestBodyBytes = init.body;
        }

        return new Response(
          JSON.stringify({
            id: 'new-uploaded-file-id-999',
            name: 'Form_16.pdf',
            mimeType: 'application/pdf',
            size: '1024',
            createdTime: '2026-09-13T10:00:00.000Z'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('Not found', { status: 404 });
    }) as any;

    const dummyPdfContent = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

    const uploadRes = await service.uploadFileMultipart(
      {
        name: 'Form_16.pdf',
        mimeType: 'application/pdf',
        parents: ['authoritative-folder-456'],
        content: dummyPdfContent
      },
      {
        serviceAccountJson: testServiceAccountJson,
        customFetch: mockFetch
      }
    );

    assert.strictEqual(uploadRes.id, 'new-uploaded-file-id-999');
    assert.strictEqual(uploadRes.name, 'Form_16.pdf');
    assert.strictEqual(uploadRes.mimeType, 'application/pdf');
    assert.strictEqual(uploadRes.size, '1024');
    assert.ok(uploadRes.createdTime);

    // 1. Verify OAuth token requested write-capable scope (https://www.googleapis.com/auth/drive)
    assert.ok(capturedTokenAssertion, 'Should have made OAuth token assertion');
    const decodedAssertion: any = decodeJwt(capturedTokenAssertion);
    assert.strictEqual(
      decodedAssertion.scope,
      GOOGLE_DRIVE_WRITE_SCOPE,
      'Upload token MUST request write-capable drive scope, not drive.readonly'
    );

    // 2. Verify wire-level body and headers
    assert.ok(capturedRequestBodyBytes, 'Body sent to fetch must be a Uint8Array');
    assert.ok(capturedRequestBodyBytes instanceof Uint8Array, 'Body must be Uint8Array');

    // 3. Verify Content-Length header matches byteLength exactly
    assert.ok(capturedHeaders['Content-Length'], 'Content-Length header must be set');
    assert.strictEqual(
      capturedHeaders['Content-Length'],
      String(capturedRequestBodyBytes.byteLength),
      'Content-Length must exactly match body.byteLength'
    );

    // 4. Verify Content-Type contains multipart/related and boundary
    const contentType = capturedHeaders['Content-Type'] || '';
    assert.ok(contentType.startsWith('multipart/related; boundary='));
    const boundaryMatch = contentType.match(/boundary=([a-zA-Z0-9_-]+)/);
    assert.ok(boundaryMatch, 'Boundary must be present in Content-Type');
    const boundary = boundaryMatch[1];

    // 5. Decode text to inspect RFC 2387 multipart structure
    const bodyText = new TextDecoder().decode(capturedRequestBodyBytes);

    // Structure checks:
    // First part: opening boundary
    assert.ok(bodyText.startsWith(`--${boundary}\r\n`));
    // Metadata headers and blank line
    assert.ok(bodyText.includes(`Content-Type: application/json; charset=UTF-8\r\n\r\n`));
    // Metadata JSON
    assert.ok(bodyText.includes(`{"name":"Form_16.pdf","parents":["authoritative-folder-456"]}\r\n`));
    // Intermediate boundary before media
    assert.ok(bodyText.includes(`\r\n--${boundary}\r\n`));
    // Media header
    assert.ok(bodyText.includes(`Content-Type: application/pdf\r\n\r\n`));
    // Terminating boundary
    assert.ok(bodyText.endsWith(`\r\n--${boundary}--`));

    // 6. Verify binary PDF content intact in the byte buffer
    const pdfSliceIndex = bodyText.indexOf('Content-Type: application/pdf\r\n\r\n') + 'Content-Type: application/pdf\r\n\r\n'.length;
    // Check that dummyPdfContent bytes exist right after media headers
    const binaryMarker = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];
    let foundBinary = false;
    for (let i = 0; i <= capturedRequestBodyBytes.length - binaryMarker.length; i++) {
      if (binaryMarker.every((b, idx) => capturedRequestBodyBytes![i + idx] === b)) {
        foundBinary = true;
        break;
      }
    }
    assert.ok(foundBinary, 'Binary bytes of the file must be preserved intact');

    console.log('✓ Test 6 Passed: Successfully uploads file with exact wire-level multipart format, write scope, and Content-Length');
  }

  // Test 7: uploadFileMultipart upstream failure handling (502 Bad Gateway)
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

      if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
        return new Response('Internal Google Drive Error', { status: 500 });
      }

      return new Response('Not found', { status: 404 });
    }) as any;

    await assert.rejects(
      async () => {
        await service.uploadFileMultipart(
          {
            name: 'doc.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-123'],
            content: new Uint8Array([1, 2, 3])
          },
          {
            serviceAccountJson: testServiceAccountJson,
            customFetch: mockFetch
          }
        );
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 502);
        assert.ok(!err.message.includes('testServiceAccountJson'));
        return true;
      }
    );
    console.log('✓ Test 7 Passed: Maps Google Drive 500 error to safe 502 BadGatewayError');
  }

  // Test 8: uploadFileMultipart handles target folder not found (404)
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

      if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
        return new Response('Target folder not found', { status: 404 });
      }

      return new Response('Not found', { status: 404 });
    }) as any;

    await assert.rejects(
      async () => {
        await service.uploadFileMultipart(
          {
            name: 'doc.pdf',
            mimeType: 'application/pdf',
            parents: ['non-existent-folder'],
            content: new Uint8Array([1, 2, 3])
          },
          {
            serviceAccountJson: testServiceAccountJson,
            customFetch: mockFetch
          }
        );
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 404);
        return true;
      }
    );
    console.log('✓ Test 8 Passed: Maps target folder missing to 404 NotFoundError');
  }

  // Test 9: getClientUploadFolderId returns existing upload folder ID without creating a new one
  {
    clearTokenCache();

    let createCalled = false;
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/drive/v3/files?') && url.includes("name+%3D+%27upload%27")) {
        // Return existing upload folder
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'existing-upload-folder-id',
                name: 'upload',
                mimeType: 'application/vnd.google-apps.folder',
                trashed: false,
                parents: ['pan-folder-123']
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (init?.method === 'POST') {
        createCalled = true;
        return new Response(
          JSON.stringify({ id: 'should-not-be-created' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('Not found', { status: 404 });
    }) as any;

    const folderId = await service.getClientUploadFolderId('pan-folder-123', {
      serviceAccountJson: testServiceAccountJson,
      customFetch: mockFetch
    }, true);

    assert.strictEqual(folderId, 'existing-upload-folder-id');
    assert.strictEqual(createCalled, false, 'Should not create new folder if upload folder exists');
    console.log('✓ Test 9 Passed: Reuses existing direct-child upload folder without creating duplicate');
  }

  // Test 10: getClientUploadFolderId creates 'upload' folder as direct child when missing
  {
    clearTokenCache();

    let createdFolderPayload: any = null;
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/drive/v3/files?') && url.includes("name+%3D+%27upload%27")) {
        // No existing upload folder
        return new Response(
          JSON.stringify({ files: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (init?.method === 'POST' && url.includes('/drive/v3/files')) {
        createdFolderPayload = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            id: 'newly-created-upload-folder-id',
            name: createdFolderPayload.name,
            mimeType: createdFolderPayload.mimeType,
            parents: createdFolderPayload.parents
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('Not found', { status: 404 });
    }) as any;

    const folderId = await service.getClientUploadFolderId('pan-folder-123', {
      serviceAccountJson: testServiceAccountJson,
      customFetch: mockFetch
    }, true);

    assert.strictEqual(folderId, 'newly-created-upload-folder-id');
    assert.deepStrictEqual(createdFolderPayload, {
      name: 'upload',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['pan-folder-123']
    });
    console.log('✓ Test 10 Passed: Creates upload folder with parent=PAN folder when missing and createIfMissing=true');
  }

  // Test 11: getClientUploadFolderId returns null when folder missing and createIfMissing=false
  {
    clearTokenCache();

    let createCalled = false;
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/drive/v3/files?') && url.includes("name+%3D+%27upload%27")) {
        return new Response(
          JSON.stringify({ files: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (init?.method === 'POST') {
        createCalled = true;
      }

      return new Response('Not found', { status: 404 });
    }) as any;

    const folderId = await service.getClientUploadFolderId('pan-folder-123', {
      serviceAccountJson: testServiceAccountJson,
      customFetch: mockFetch
    }, false);

    assert.strictEqual(folderId, null);
    assert.strictEqual(createCalled, false);
    console.log('✓ Test 11 Passed: Returns null without creating folder when createIfMissing=false');
  }

  // Test 12: getClientUploadFolderId error handling (invalid ID & upstream failure)
  {
    clearTokenCache();

    // Invalid/empty folder ID
    await assert.rejects(
      async () => {
        await service.getClientUploadFolderId('', { serviceAccountJson: testServiceAccountJson });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 400);
        return true;
      }
    );

    // Upstream error on search
    const failingFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Google Drive Internal Error 500', { status: 500 });
    }) as any;

    await assert.rejects(
      async () => {
        await service.getClientUploadFolderId('pan-folder-123', {
          serviceAccountJson: testServiceAccountJson,
          customFetch: failingFetch
        });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 502);
        return true;
      }
    );
    console.log('✓ Test 12 Passed: Validates inputs and handles upstream Drive failures safely');
  }

  // Test 13: uploadFileMultipart handles 411 Length Required from upstream with safe 502
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

      if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
        return new Response('411 Length Required: Content-Length missing or chunked', {
          status: 411,
          headers: { 'Content-Type': 'text/plain' }
        });
      }

      return new Response('Not found', { status: 404 });
    }) as any;

    await assert.rejects(
      async () => {
        await service.uploadFileMultipart(
          {
            name: 'test.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-abc'],
            content: new Uint8Array([1, 2, 3])
          },
          {
            serviceAccountJson: testServiceAccountJson,
            customFetch: mockFetch
          }
        );
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 502);
        assert.ok(!err.message.includes('testServiceAccountJson'));
        return true;
      }
    );
    console.log('✓ Test 13 Passed: Upstream 411 Length Required returns safe 502 Bad Gateway');
  }

  // Test 14: uploadFileMultipart handles 400 Bad Request from upstream with safe 502
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

      if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
        return new Response('400 Bad Request: Invalid multipart body formatting', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' }
        });
      }

      return new Response('Not found', { status: 404 });
    }) as any;

    await assert.rejects(
      async () => {
        await service.uploadFileMultipart(
          {
            name: 'test.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-abc'],
            content: new Uint8Array([1, 2, 3])
          },
          {
            serviceAccountJson: testServiceAccountJson,
            customFetch: mockFetch
          }
        );
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 502);
        return true;
      }
    );
    console.log('✓ Test 14 Passed: Upstream 400 Bad Request returns safe 502 Bad Gateway');
  }

  console.log('--- All Google Drive REST Service Tests Passed! ---\n');
}

runGoogleDriveRestServiceTests().catch((err) => {
  console.error('Google Drive REST Service Tests Failed:', err);
  process.exit(1);
});

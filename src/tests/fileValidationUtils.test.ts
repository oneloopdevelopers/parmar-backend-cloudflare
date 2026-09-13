import assert from 'node:assert';
import {
  validateUploadedFile,
  sanitizeUploadFilename,
  validateFileSignature,
  ALLOWED_MIME_TYPES,
  AllowedMimeType,
  ALLOWED_EXTENSIONS_BY_MIME,
  MAX_UPLOAD_FILE_SIZE_BYTES
} from '../utils/fileValidationUtils.js';
import { BadRequestError } from '../utils/errors.js';

async function runFileValidationUtilsTests() {
  console.log('--- Starting File Validation Utils Tests ---');

  const validPdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
  const validJpgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const validPngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

  // Test 1: ALLOWED_MIME_TYPES whitelist
  assert.ok(ALLOWED_MIME_TYPES.includes('application/pdf'));
  assert.ok(ALLOWED_MIME_TYPES.includes('image/jpeg'));
  assert.ok(ALLOWED_MIME_TYPES.includes('image/png'));
  assert.strictEqual(ALLOWED_MIME_TYPES.includes('application/zip' as any), false);
  console.log('✓ Test 1 Passed: ALLOWED_MIME_TYPES checks whitelist');

  // Test 2: ALLOWED_EXTENSIONS_BY_MIME
  assert.deepStrictEqual(ALLOWED_EXTENSIONS_BY_MIME['application/pdf'], ['.pdf']);
  assert.deepStrictEqual(ALLOWED_EXTENSIONS_BY_MIME['image/jpeg'], ['.jpg', '.jpeg']);
  assert.deepStrictEqual(ALLOWED_EXTENSIONS_BY_MIME['image/png'], ['.png']);
  console.log('✓ Test 2 Passed: ALLOWED_EXTENSIONS_BY_MIME defines allowed extensions');

  // Test 3: validateFileSignature
  assert.strictEqual(validateFileSignature(validPdfBytes, 'application/pdf'), true);
  assert.strictEqual(validateFileSignature(validJpgBytes, 'image/jpeg'), true);
  assert.strictEqual(validateFileSignature(validPngBytes, 'image/png'), true);
  // Spoofed: PDF bytes with JPEG MIME
  assert.strictEqual(validateFileSignature(validPdfBytes, 'image/jpeg'), false);
  // Spoofed: plain text with PDF MIME
  assert.strictEqual(validateFileSignature(new TextEncoder().encode('Hello world'), 'application/pdf'), false);
  // Short buffer
  assert.strictEqual(validateFileSignature(new Uint8Array([0x25, 0x50]), 'application/pdf'), false);
  console.log('✓ Test 3 Passed: validateFileSignature checks magic bytes strictly');

  // Test 4: sanitizeUploadFilename
  assert.strictEqual(sanitizeUploadFilename('Normal_Document.pdf', 'application/pdf'), 'Normal_Document.pdf');
  assert.strictEqual(sanitizeUploadFilename('../../../etc/passwd.pdf', 'application/pdf'), 'passwd.pdf');
  assert.strictEqual(sanitizeUploadFilename('C:\\Users\\Admin\\Doc.pdf', 'application/pdf'), 'Doc.pdf');
  assert.strictEqual(sanitizeUploadFilename('evil\r\nSet-Cookie: evil=1\r\nfilename.pdf', 'application/pdf'), 'evilSet-Cookie_ evil=1filename.pdf');
  assert.strictEqual(sanitizeUploadFilename('   padded_name.pdf   ', 'application/pdf'), 'padded_name.pdf');
  assert.ok(sanitizeUploadFilename('', 'application/pdf').startsWith('document_'));
  assert.strictEqual(sanitizeUploadFilename('hindi_चालान.pdf', 'application/pdf'), 'hindi_चालान.pdf');
  console.log('✓ Test 4 Passed: sanitizeUploadFilename eliminates path traversal and control chars');

  // Test 5: validateUploadedFile with valid PDF
  {
    const pdfFile = new File([validPdfBytes], 'tax_return.pdf', { type: 'application/pdf' });
    const result = await validateUploadedFile(pdfFile);
    assert.strictEqual(result.sanitizedFilename, 'tax_return.pdf');
    assert.strictEqual(result.mimeType, 'application/pdf');
    assert.strictEqual(result.sizeBytes, validPdfBytes.length);
    assert.ok(result.buffer instanceof Uint8Array);
    console.log('✓ Test 5 Passed: validateUploadedFile accepts valid PDF');
  }

  // Test 6: validateUploadedFile with valid JPEG (.jpg and .jpeg)
  {
    const jpgFile = new File([validJpgBytes], 'photo.jpg', { type: 'image/jpeg' });
    const resultJpg = await validateUploadedFile(jpgFile);
    assert.strictEqual(resultJpg.mimeType, 'image/jpeg');

    const jpegFile = new File([validJpgBytes], 'photo.jpeg', { type: 'image/jpeg' });
    const resultJpeg = await validateUploadedFile(jpegFile);
    assert.strictEqual(resultJpeg.mimeType, 'image/jpeg');
    console.log('✓ Test 6 Passed: validateUploadedFile accepts valid JPEG (.jpg and .jpeg)');
  }

  // Test 7: validateUploadedFile with valid PNG
  {
    const pngFile = new File([validPngBytes], 'screenshot.png', { type: 'image/png' });
    const result = await validateUploadedFile(pngFile);
    assert.strictEqual(result.mimeType, 'image/png');
    console.log('✓ Test 7 Passed: validateUploadedFile accepts valid PNG');
  }

  // Test 8: Empty file
  {
    const emptyFile = new File([], 'empty.pdf', { type: 'application/pdf' });
    await assert.rejects(
      async () => validateUploadedFile(emptyFile),
      (err: any) => err instanceof BadRequestError && err.message.includes('empty')
    );
    console.log('✓ Test 8 Passed: validateUploadedFile rejects 0-byte file');
  }

  // Test 9: File exceeding 15 MB
  {
    const chunk = new Uint8Array(1024 * 1024);
    const largeFile = new File(new Array(16).fill(chunk), 'large.pdf', { type: 'application/pdf' });
    await assert.rejects(
      async () => validateUploadedFile(largeFile),
      (err: any) => err instanceof BadRequestError && err.message.includes('exceeds the maximum allowed limit of 15 MB')
    );
    console.log('✓ Test 9 Passed: validateUploadedFile rejects file > 15 MB');
  }

  // Test 10: MIME type mismatch with extension
  {
    const mismatched = new File([validPdfBytes], 'mismatch.png', { type: 'application/pdf' });
    await assert.rejects(
      async () => validateUploadedFile(mismatched),
      (err: any) => err instanceof BadRequestError && err.message.includes('does not match declared MIME type')
    );
    console.log('✓ Test 10 Passed: validateUploadedFile rejects MIME/extension mismatch');
  }

  // Test 11: Spoofed content signature
  {
    const fakePdf = new File([new TextEncoder().encode('Not a pdf file at all')], 'fake.pdf', { type: 'application/pdf' });
    await assert.rejects(
      async () => validateUploadedFile(fakePdf),
      (err: any) => err instanceof BadRequestError && err.message.includes('File content signature does not match')
    );
    console.log('✓ Test 11 Passed: validateUploadedFile rejects spoofed signature');
  }

  // Test 12: Path traversal filename sanitized during validation
  {
    const traversalFile = new File([validPdfBytes], '../../../../safe.pdf', { type: 'application/pdf' });
    const result = await validateUploadedFile(traversalFile);
    assert.strictEqual(result.sanitizedFilename, 'safe.pdf');
    assert.ok(!result.sanitizedFilename.includes('..'));
    console.log('✓ Test 12 Passed: validateUploadedFile safely sanitizes filename path traversal');
  }

  console.log('--- All File Validation Utils Tests Passed! ---\n');
}

runFileValidationUtilsTests().catch((err) => {
  console.error('File Validation Utils Tests Failed:', err);
  process.exit(1);
});

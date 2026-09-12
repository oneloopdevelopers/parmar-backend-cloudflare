import assert from 'node:assert';
import { generateKeyPair, SignJWT } from 'jose';
import { verifyFirebaseIdToken } from '../services/firebaseTokenVerifier';

async function runFirebaseTokenVerifierTests() {
  console.log('\n--- Starting Tests for Firebase Token Verifier ---');

  // Generate an RSA key pair for local JWT verification tests
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const projectId = 'document-portal-d2b6d';
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;

  // Custom key resolver that returns our test public key
  const mockKeyResolver = async () => publicKey;

  // Test 1: Valid RS256 token verification
  {
    const now = Math.floor(Date.now() / 1000);
    const validToken = await new SignJWT({
      user_id: 'verified-test-uid-123',
      email: 'client@example.com',
      email_verified: true,
      auth_time: now
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(expectedIssuer)
      .setAudience(projectId)
      .setSubject('verified-test-uid-123')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    const verified = await verifyFirebaseIdToken(validToken, {
      projectId,
      keyResolver: mockKeyResolver as any
    });

    assert.strictEqual(verified.uid, 'verified-test-uid-123');
    assert.strictEqual(verified.email, 'client@example.com');
    assert.strictEqual(verified.email_verified, true);
    console.log('✓ Test 1 Passed: Successfully verifies valid RS256 Firebase ID token');
  }

  // Test 2: Expired token rejection
  {
    const now = Math.floor(Date.now() / 1000);
    const expiredToken = await new SignJWT({ auth_time: now - 7200 })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(expectedIssuer)
      .setAudience(projectId)
      .setSubject('expired-uid')
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600) // Expired 1 hour ago
      .sign(privateKey);

    await assert.rejects(
      async () => {
        await verifyFirebaseIdToken(expiredToken, {
          projectId,
          keyResolver: mockKeyResolver as any
        });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 401);
        assert.ok(err.message.includes('expired'));
        return true;
      }
    );
    console.log('✓ Test 2 Passed: Rejects expired Firebase ID token with 401 Unauthorized');
  }

  // Test 3: Audience mismatch rejection
  {
    const now = Math.floor(Date.now() / 1000);
    const wrongAudienceToken = await new SignJWT({ auth_time: now })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(expectedIssuer)
      .setAudience('some-other-project-id')
      .setSubject('uid-wrong-aud')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    await assert.rejects(
      async () => {
        await verifyFirebaseIdToken(wrongAudienceToken, {
          projectId,
          keyResolver: mockKeyResolver as any
        });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 401);
        return true;
      }
    );
    console.log('✓ Test 3 Passed: Rejects token with audience mismatch');
  }

  // Test 4: Issuer mismatch rejection
  {
    const now = Math.floor(Date.now() / 1000);
    const wrongIssuerToken = await new SignJWT({ auth_time: now })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer('https://malicious-issuer.com/document-portal-d2b6d')
      .setAudience(projectId)
      .setSubject('uid-wrong-iss')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    await assert.rejects(
      async () => {
        await verifyFirebaseIdToken(wrongIssuerToken, {
          projectId,
          keyResolver: mockKeyResolver as any
        });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 401);
        return true;
      }
    );
    console.log('✓ Test 4 Passed: Rejects token with issuer mismatch');
  }

  // Test 5: Missing or empty token rejection
  {
    await assert.rejects(
      async () => {
        await verifyFirebaseIdToken('', { projectId, keyResolver: mockKeyResolver as any });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 401);
        assert.ok(err.message.includes('missing or empty'));
        return true;
      }
    );
    console.log('✓ Test 5 Passed: Rejects empty token string');
  }

  // Test 6: Missing subject (UID) rejection
  {
    const now = Math.floor(Date.now() / 1000);
    const tokenNoSub = await new SignJWT({ auth_time: now })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(expectedIssuer)
      .setAudience(projectId)
      // Omit setSubject
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    await assert.rejects(
      async () => {
        await verifyFirebaseIdToken(tokenNoSub, {
          projectId,
          keyResolver: mockKeyResolver as any
        });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 401);
        assert.ok(err.message.includes('missing or empty subject'));
        return true;
      }
    );
    console.log('✓ Test 6 Passed: Rejects token missing subject (UID)');
  }

  console.log('--- All Firebase Token Verifier Tests Passed! ---\n');
}

runFirebaseTokenVerifierTests().catch((err) => {
  console.error('Firebase Token Verifier Tests Failed:', err);
  process.exit(1);
});

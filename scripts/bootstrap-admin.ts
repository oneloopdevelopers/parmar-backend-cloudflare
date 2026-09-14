import 'dotenv/config';
import * as readline from 'node:readline';
import { bootstrapFirstAdmin, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME } from '../src/services/adminBootstrapService';

function promptPassword(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    // Hide input characters if supported in TTY
    if (process.stdin.isTTY) {
      process.stdout.write(promptText);
      let pass = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (charBuffer) => {
        const char = charBuffer.toString();
        if (char === '\n' || char === '\r' || char === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          rl.close();
          resolve(pass);
        } else if (char === '\u0003') {
          process.exit(1);
        } else if (char === '\b' || char === '\x7f') {
          if (pass.length > 0) {
            pass = pass.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          pass += char;
          process.stdout.write('*');
        }
      });
    } else {
      rl.question(promptText, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

async function main() {
  console.log('=====================================================');
  console.log('  ONELOOP DOCUMENT PORTAL - ADMIN BOOTSTRAP UTILITY  ');
  console.log('=====================================================');
  console.log(`Target Admin Name : ${BOOTSTRAP_ADMIN_NAME}`);
  console.log(`Target Admin Email: ${BOOTSTRAP_ADMIN_EMAIL}`);
  console.log('');

  const projectId = process.env.FIREBASE_PROJECT_ID || 'document-portal-d2b6d';
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!serviceAccountJson) {
    console.error('ERROR: FIREBASE_SERVICE_ACCOUNT_JSON is not configured in environment variables.');
    process.exit(1);
  }

  // Password can be supplied via ADMIN_BOOTSTRAP_PASSWORD environment variable or prompted interactively
  let password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!password) {
    password = await promptPassword('Enter password for new Administrator (min 6 chars): ');
  }

  if (!password || password.length < 6) {
    console.error('ERROR: Password must be at least 6 characters.');
    process.exit(1);
  }

  console.log('\nExecuting bootstrap operation safely...');

  try {
    const result = await bootstrapFirstAdmin({
      projectId,
      serviceAccountJson,
      password
    });

    console.log('\n-----------------------------------------------------');
    console.log('BOOTSTRAP RESULT:');
    console.log(`Status : ${result.status}`);
    console.log(`Email  : ${result.email}`);
    console.log(`UID    : ${result.uid}`);
    console.log(`Message: ${result.message}`);
    console.log('-----------------------------------------------------\n');

    if (result.status === 'created') {
      console.log('✓ Administrator account successfully bootstrapped.');
    } else if (result.status === 'already_exists') {
      console.log('ℹ Administrator account already exists with active admin role.');
    } else {
      console.log('⚠ Attention required: Existing account needs manual review.');
    }
  } catch (err) {
    console.error('\nBOOTSTRAP FAILED:');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { MongoClient } from 'mongodb';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDbName = process.env.TEST_DB_NAME ?? 'rentora_booking_test';
const port = Number(process.env.TEST_PORT ?? 5055);
const baseUrl = `http://127.0.0.1:${port}`;

const testFiles = [
  path.join(root, 'tests', 'stripeService.test.js'),
  path.join(root, 'tests', 'utils.test.js'),
  path.join(root, 'tests', 'cors.test.js'),
  path.join(root, 'tests', 'passwordSecurity.test.js'),
  path.join(root, 'tests', 'auth.test.js'),
  path.join(root, 'tests', 'booking.test.js'),
  path.join(root, 'tests', 'payment.test.js'),
  path.join(root, 'tests', 'bookingLifecycle.test.js'),
  path.join(root, 'tests', 'admin.test.js'),
  path.join(root, 'tests', 'regression.test.js'),
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resetTestDatabase() {
  let attempts = 0;
  while (attempts < 3) {
    attempts += 1;
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
    });
    try {
      await client.connect();
      await client.db(testDbName).dropDatabase();
      await client.close();
      return;
    } catch (err) {
      try { await client.close(); } catch {}
      if (attempts >= 3) throw err;
      console.warn(`Database reset attempt ${attempts} failed (${err.message}). Retrying in 2s...`);
      await sleep(2000);
    }
  }
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return true;
    } catch {
      // Server not listening yet.
    }
    await sleep(250);
  }
  return false;
}

function startServer(env) {
  const child = spawn(process.execPath, [path.join(root, 'index.js')], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[server:err] ${chunk}`);
  });

  return child;
}

function runTests(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], {
      cwd: root,
      env,
      stdio: 'inherit',
    });

    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(code);
    };

    // Safety net: a hung test process must not block the runner forever.
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      finish(1);
    }, 180000);

    child.on('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is required to run the integration tests.');
    process.exit(1);
  }

  console.info(`Resetting isolated test database "${testDbName}"...`);
  await resetTestDatabase();

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    MONGODB_DB_NAME: testDbName,
    TEST_DB_NAME: testDbName,
    TEST_BASE_URL: baseUrl,
    ENABLE_DEMO_PAYMENTS: 'true',
    STRIPE_WEBHOOK_SECRET: 'whsec_booking_suite_test_secret',
    JWT_SECRET: process.env.JWT_SECRET ?? 'integration-test-secret',
    CLIENT_URL: '',
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    EMAIL_FROM: '',
  };

  const server = startServer(env);
  let exitCode = 1;

  try {
    const healthy = await waitForHealth();
    if (!healthy) {
      console.error(`Test server did not become healthy at ${baseUrl}.`);
    } else {
      console.info('Test server is healthy. Running integration tests...\n');
      exitCode = await runTests(env);
    }
  } finally {
    server.kill('SIGTERM');
    await sleep(500);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await sleep(100);
    }

    try {
      await resetTestDatabase();
      console.info(`\nCleaned up isolated test database "${testDbName}".`);
    } catch (error) {
      console.warn('Test database cleanup failed:', error.message);
    }
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error('Test runner failed:', error);
  process.exit(1);
});

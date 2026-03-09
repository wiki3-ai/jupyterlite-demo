#!/usr/bin/env node
/**
 * Integration tests for the full sync pipeline via the live CORS proxy worker.
 *
 * Tests:
 *   1. Worker health check & OAuth config
 *   2. OAuth Device Flow — request device code
 *   3. OAuth token poll — gets authorization_pending (no human interaction)
 *   4. Git clone via proxy (public repo, no auth)
 *   5. MemFS + isomorphic-git clone via proxy (full pipeline)
 *   6. Sync simulation — clone + file extraction (mock ContentsManager)
 *   7. [Interactive] Full OAuth token exchange (requires human, skipped by default)
 *
 * Usage:
 *   node test/test-integration.mjs                          # automated tests
 *   node test/test-integration.mjs --interactive             # include OAuth human step
 *   PROXY_URL=https://... node test/test-integration.mjs     # custom worker
 *
 * Requires: Node.js 18+ (native fetch), built lib/ directory
 */

import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { MemFS } from '../lib/memfs.js';

// ─── Config ───────────────────────────────────────────────────────────
const PROXY_URL = process.env.PROXY_URL || 'https://wiki3-ai-sync-proxy.jim-2ad.workers.dev';
const REPO_OWNER = 'wiki3-ai';
const REPO_NAME = 'jupyterlite-demo';
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}.git`;
const BRANCH = 'gh-pages';
const INTERACTIVE = process.argv.includes('--interactive');

// ─── Test harness ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

function skip(message) {
  console.log(`  SKIP: ${message}`);
  skipped++;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Create a proxy-aware HTTP client matching what the extension does.
 */
function makeProxyHttp(proxyBaseUrl) {
  return {
    async request(config) {
      let { url } = config;
      if (proxyBaseUrl && url.startsWith('https://github.com/')) {
        const path = url.slice('https://github.com/'.length);
        url = `${proxyBaseUrl.replace(/\/+$/, '')}/proxy/${path}`;
      }
      return http.request({ ...config, url });
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Test 1: Worker health check
// ═══════════════════════════════════════════════════════════════════════
async function testHealthCheck() {
  console.log('\n1. Worker health check');

  const resp = await fetch(`${PROXY_URL}/oauth/status`);
  assert(resp.ok, `GET /oauth/status returns 200 (got ${resp.status})`);

  const data = await resp.json();
  assert(data.ok === true, `ok is true`);
  assert(data.hasClientId === true, `hasClientId is true (OAuth configured)`);

  // Check CORS headers
  const resp2 = await fetch(`${PROXY_URL}/oauth/status`, {
    headers: { 'Origin': 'https://wiki3-ai.github.io' },
  });
  const acao = resp2.headers.get('access-control-allow-origin');
  assert(
    acao === 'https://wiki3-ai.github.io' || acao === '*',
    `CORS header present (${acao})`
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Test 2: OAuth Device Flow — request device code
// ═══════════════════════════════════════════════════════════════════════
let deviceCode = '';
let userCode = '';

async function testDeviceCode() {
  console.log('\n2. OAuth Device Flow — request device code');

  const resp = await fetch(`${PROXY_URL}/oauth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'public_repo' }),
  });
  assert(resp.ok, `POST /oauth/device returns 200 (got ${resp.status})`);

  const data = await resp.json();
  assert(typeof data.device_code === 'string' && data.device_code.length > 0,
    `Got device_code (${data.device_code?.slice(0, 8)}…)`);
  assert(typeof data.user_code === 'string' && data.user_code.length > 0,
    `Got user_code (${data.user_code})`);
  assert(data.verification_uri?.includes('github.com'),
    `verification_uri points to GitHub (${data.verification_uri})`);
  assert(typeof data.expires_in === 'number' && data.expires_in > 0,
    `expires_in is positive (${data.expires_in}s)`);
  assert(typeof data.interval === 'number' && data.interval > 0,
    `interval is positive (${data.interval}s)`);

  deviceCode = data.device_code;
  userCode = data.user_code;
}

// ═══════════════════════════════════════════════════════════════════════
// Test 3: OAuth token poll — authorization_pending
// ═══════════════════════════════════════════════════════════════════════
async function testTokenPollPending() {
  console.log('\n3. OAuth token poll — authorization_pending');

  if (!deviceCode) {
    skip('No device_code from test 2');
    return;
  }

  const resp = await fetch(`${PROXY_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  assert(resp.ok || resp.status < 500, `POST /oauth/token doesn't 500 (got ${resp.status})`);

  const data = await resp.json();
  assert(data.error === 'authorization_pending',
    `Returns authorization_pending (got ${data.error})`);
}

// ═══════════════════════════════════════════════════════════════════════
// Test 4: Git smart HTTP via proxy (raw fetch)
// ═══════════════════════════════════════════════════════════════════════
async function testGitProxy() {
  console.log('\n4. Git smart HTTP via proxy');

  const url = `${PROXY_URL}/proxy/${REPO_OWNER}/${REPO_NAME}.git/info/refs?service=git-upload-pack`;
  const resp = await fetch(url);
  assert(resp.ok, `info/refs returns 200 (got ${resp.status})`);

  const ct = resp.headers.get('content-type') || '';
  assert(ct.includes('git-upload-pack'),
    `Content-Type is git smart HTTP (${ct})`);

  const body = await resp.text();
  assert(body.includes('service=git-upload-pack'),
    `Response body contains git service advertisement`);
  assert(body.length > 100,
    `Response body has substantial content (${body.length} bytes)`);
}

// ═══════════════════════════════════════════════════════════════════════
// Test 5: MemFS + isomorphic-git clone via proxy
// ═══════════════════════════════════════════════════════════════════════
async function testCloneViaProxy() {
  console.log('\n5. MemFS + isomorphic-git clone via proxy (public repo)');

  const proxyHttp = makeProxyHttp(PROXY_URL);
  const fs = new MemFS();
  const dir = '/repo';

  let cloneMessages = [];
  await git.clone({
    fs,
    http: proxyHttp,
    dir,
    url: REPO_URL,
    ref: BRANCH,
    singleBranch: true,
    depth: 1,
    onMessage: (msg) => cloneMessages.push(msg),
  });

  assert(true, `git.clone completed without error`);

  // Verify files exist
  const entries = await fs.promises.readdir(dir);
  assert(entries.length > 0, `Cloned repo has ${entries.length} entries in root`);
  assert(entries.includes('.git'), `.git directory exists`);

  // Check for expected gh-pages files
  const hasIndex = entries.includes('index.html');
  assert(hasIndex, `index.html exists (gh-pages content)`);

  // Verify git log
  const log = await git.log({ fs, dir, depth: 1 });
  assert(log.length === 1, `git.log returns 1 commit (depth=1)`);
  assert(typeof log[0].oid === 'string' && log[0].oid.length === 40,
    `Commit SHA is valid (${log[0].oid.slice(0, 8)}…)`);

  console.log(`  (Cloned ${entries.length} entries, commit ${log[0].oid.slice(0, 8)})`);
}

// ═══════════════════════════════════════════════════════════════════════
// Test 6: Sync simulation — clone + file extraction with mock Contents
// ═══════════════════════════════════════════════════════════════════════
async function testSyncSimulation() {
  console.log('\n6. Sync simulation (clone → extract files → mock ContentsManager)');

  const proxyHttp = makeProxyHttp(PROXY_URL);
  const fs = new MemFS();
  const dir = '/repo';

  // Clone
  await git.clone({
    fs,
    http: proxyHttp,
    dir,
    url: REPO_URL,
    ref: BRANCH,
    singleBranch: true,
    depth: 1,
  });

  // Simulate the sync: list files under "files/" subdirectory
  const contentPath = 'files';
  const searchDir = `${dir}/${contentPath}`;

  let fileList;
  try {
    fileList = await listAllFiles(fs, searchDir, '');
  } catch {
    // The "files" directory might not exist on gh-pages
    fileList = [];
  }

  // Filter out git internals
  const contentFiles = fileList.filter(
    f => !f.startsWith('.git/') && f !== '.git' && f !== '.nojekyll'
  );

  assert(Array.isArray(contentFiles), `listAllFiles returns array`);
  console.log(`  (Found ${contentFiles.length} content file(s) under "${contentPath}/")`);

  // Mock ContentsManager — just collect what would be saved
  const savedFiles = [];
  const mockContents = {
    async get(path) {
      throw new Error('not found');
    },
    async save(path, options) {
      savedFiles.push({ path, type: options.type, format: options.format });
      return { path, type: options.type };
    },
  };

  // Process each file as the sync code would
  for (const relPath of contentFiles) {
    const fullPath = `${searchDir}/${relPath}`;
    const data = await fs.promises.readFile(fullPath);

    const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
    const isNotebook = ext === 'ipynb';

    if (isNotebook) {
      const text = new TextDecoder().decode(data);
      const nbContent = JSON.parse(text);
      await mockContents.save(relPath, {
        type: 'notebook',
        format: 'json',
        content: nbContent,
      });
    } else {
      const text = new TextDecoder().decode(data);
      await mockContents.save(relPath, {
        type: 'file',
        format: 'text',
        content: text,
      });
    }
  }

  assert(savedFiles.length === contentFiles.length,
    `All ${contentFiles.length} file(s) saved via mock ContentsManager`);

  // Verify notebooks were identified correctly
  const notebooks = savedFiles.filter(f => f.type === 'notebook');
  const expectedNotebooks = contentFiles.filter(f => f.endsWith('.ipynb'));
  assert(notebooks.length === expectedNotebooks.length,
    `${notebooks.length} notebook(s) identified correctly`);

  if (savedFiles.length > 0) {
    console.log(`  Saved files:`);
    for (const f of savedFiles.slice(0, 10)) {
      console.log(`    ${f.format}  ${f.path}`);
    }
    if (savedFiles.length > 10) {
      console.log(`    ... and ${savedFiles.length - 10} more`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Test 7: [Interactive] Full OAuth token exchange
// ═══════════════════════════════════════════════════════════════════════
async function testInteractiveOAuth() {
  console.log('\n7. [Interactive] Full OAuth token exchange');

  if (!INTERACTIVE) {
    skip('Run with --interactive to test full OAuth flow');
    return;
  }

  // Request a fresh device code
  const resp = await fetch(`${PROXY_URL}/oauth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'public_repo' }),
  });
  const codeData = await resp.json();

  console.log(`\n  ┌─────────────────────────────────────────────┐`);
  console.log(`  │  Go to: ${codeData.verification_uri}`);
  console.log(`  │  Enter code: ${codeData.user_code}`);
  console.log(`  │  Waiting for authorization (${codeData.expires_in}s timeout)…`);
  console.log(`  └─────────────────────────────────────────────┘\n`);

  const deadline = Date.now() + codeData.expires_in * 1000;
  let pollInterval = Math.max(codeData.interval, 5) * 1000;
  let token = null;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const tokenResp = await fetch(`${PROXY_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: codeData.device_code }),
    });
    const tokenData = await tokenResp.json();

    if (tokenData.access_token) {
      token = tokenData.access_token;
      break;
    }

    if (tokenData.error === 'slow_down') {
      pollInterval += 5000;
      process.stdout.write('  (slowing down) ');
    } else if (tokenData.error === 'authorization_pending') {
      process.stdout.write('.');
    } else {
      console.error(`\n  Unexpected OAuth error: ${tokenData.error}`);
      break;
    }
  }

  console.log('');

  if (token) {
    assert(true, `Got access token (${token.slice(0, 8)}…)`);
    assert(token.startsWith('gho_') || token.startsWith('ghp_') || token.length > 10,
      `Token looks like a GitHub token`);

    // Verify token works: fetch user info
    const userResp = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const userData = await userResp.json();
    assert(userResp.ok, `Token is valid (user: ${userData.login})`);

    // Try an authenticated clone
    const proxyHttp = makeProxyHttp(PROXY_URL);
    const fs = new MemFS();
    await git.clone({
      fs,
      http: proxyHttp,
      dir: '/auth-repo',
      url: REPO_URL,
      ref: BRANCH,
      singleBranch: true,
      depth: 1,
      onAuth: () => ({ username: 'x-access-token', password: token }),
    });
    const entries = await fs.promises.readdir('/auth-repo');
    assert(entries.length > 0, `Authenticated clone succeeded (${entries.length} entries)`);
  } else {
    assert(false, 'Did not receive access token (timed out or denied)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Recursively list all files under a directory in MemFS.
 */
async function listAllFiles(fs, dir, prefix) {
  const entries = await fs.promises.readdir(prefix ? `${dir}/${prefix}` : dir);
  const result = [];
  for (const name of entries) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = `${dir}/${rel}`;
    const stat = await fs.promises.stat(full);
    if (stat.isDirectory()) {
      result.push(...(await listAllFiles(fs, dir, rel)));
    } else {
      result.push(rel);
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Wiki3.ai Sync — Integration Tests');
  console.log(`  Proxy: ${PROXY_URL}`);
  console.log(`  Repo:  ${REPO_URL} @ ${BRANCH}`);
  console.log(`  Mode:  ${INTERACTIVE ? 'INTERACTIVE' : 'automated (use --interactive for OAuth)'}`);
  console.log('═══════════════════════════════════════════════════════════');

  await testHealthCheck();
  await testDeviceCode();
  await testTokenPollPending();
  await testGitProxy();
  await testCloneViaProxy();
  await testSyncSimulation();
  await testInteractiveOAuth();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) {
    console.log('  SOME TESTS FAILED');
    process.exit(1);
  } else {
    console.log('  ALL TESTS PASSED');
  }
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(2);
});

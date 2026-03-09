#!/usr/bin/env node
/**
 * Integration tests for the full sync + deploy pipeline via the live CORS proxy.
 *
 * Tests:
 *   1. Worker health check & OAuth config
 *   2. OAuth Device Flow — request device code
 *   3. OAuth token poll — gets authorization_pending (no human interaction)
 *   4. Git smart HTTP via proxy (raw fetch)
 *   5. MemFS + isomorphic-git clone via proxy (full pipeline)
 *   6. Sync simulation — clone + file extraction (mock ContentsManager)
 *   7. [Interactive] OAuth token exchange (requires human)
 *   8. [Interactive] Deploy to test branch (full push pipeline)
 *   9. [Interactive] Verify deploy — clone back and check files
 *  10. [Interactive] Cleanup — delete test branch
 *
 * Usage:
 *   node test/test-integration.mjs                          # automated tests
 *   node test/test-integration.mjs --interactive             # include OAuth + deploy
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
const TEST_BRANCH = 'test-deploy-integration';
const INTERACTIVE = process.argv.includes('--interactive');

// Shared state for interactive tests
let oauthToken = null;

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

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const tokenResp = await fetch(`${PROXY_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: codeData.device_code }),
    });
    const tokenData = await tokenResp.json();

    if (tokenData.access_token) {
      oauthToken = tokenData.access_token;
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

  if (oauthToken) {
    assert(true, `Got access token (${oauthToken.slice(0, 8)}…)`);
    assert(oauthToken.startsWith('gho_') || oauthToken.startsWith('ghp_') || oauthToken.length > 10,
      `Token looks like a GitHub token`);

    // Verify token works: fetch user info
    const userResp = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${oauthToken}` },
    });
    const userData = await userResp.json();
    assert(userResp.ok, `Token is valid (user: ${userData.login})`);
  } else {
    assert(false, 'Did not receive access token (timed out or denied)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Test 8: [Interactive] Deploy to test branch (full push pipeline)
//
// This replicates the EXACT code path from deploy.ts:
//   init → addRemote → write files → listAllFiles → stage → commit → push
// ═══════════════════════════════════════════════════════════════════════
async function testDeploy() {
  console.log('\n8. [Interactive] Deploy to test branch');

  if (!INTERACTIVE || !oauthToken) {
    skip('Requires --interactive and successful OAuth (test 7)');
    return;
  }

  const proxyHttp = makeProxyHttp(PROXY_URL);
  const fs = new MemFS();
  const dir = '/deploy-repo';
  const timestamp = new Date().toISOString();

  // ── Exactly replicate deploy.ts flow ──────────────────────────────

  // 1. Init
  await git.init({ fs, dir });
  assert(true, 'git.init succeeded');

  // 2. Add remote
  await git.addRemote({ fs, dir, remote: 'origin', url: REPO_URL });

  // 3. Write test files (simulating collectContentsFiles output)
  const testFiles = [
    { path: 'index.html', content: `<html><body><h1>Deploy test ${timestamp}</h1></body></html>` },
    { path: 'files/test.txt', content: `Integration test at ${timestamp}` },
    { path: 'files/data/sample.csv', content: 'name,value\nalpha,1\nbeta,2' },
    { path: 'files/notebook.ipynb', content: JSON.stringify({
      cells: [{ cell_type: 'markdown', source: ['# Test notebook'], metadata: {} }],
      metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
      nbformat: 4, nbformat_minor: 5,
    }, null, 2) },
  ];

  for (const file of testFiles) {
    const parts = file.path.split('/');
    let cur = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i];
      try { await fs.promises.mkdir(cur); } catch { /* exists */ }
    }
    await fs.promises.writeFile(dir + '/' + file.path, new TextEncoder().encode(file.content));
  }
  await fs.promises.writeFile(dir + '/.nojekyll', new Uint8Array(0));
  assert(true, `Wrote ${testFiles.length} test files + .nojekyll`);

  // 4. List all files (THIS is where the .git bug lived)
  const allPaths = await listAllFiles(fs, dir, '');

  // CRITICAL CHECK: no .git paths should be staged
  const dotgitPaths = allPaths.filter(p => p === '.git' || p.startsWith('.git/'));
  assert(dotgitPaths.length === 0,
    `No .git paths in staging list (would cause "hasDotgit" push rejection)`);

  // Verify expected files are present
  assert(allPaths.includes('index.html'), 'index.html in staging list');
  assert(allPaths.includes('.nojekyll'), '.nojekyll in staging list');
  assert(allPaths.includes('files/test.txt'), 'files/test.txt in staging list');
  assert(allPaths.includes('files/data/sample.csv'), 'files/data/sample.csv in staging list');
  assert(allPaths.includes('files/notebook.ipynb'), 'files/notebook.ipynb in staging list');

  // 5. Stage
  for (const p of allPaths) {
    await git.add({ fs, dir, filepath: p });
  }
  assert(true, `Staged ${allPaths.length} files`);

  // 6. Commit
  const sha = await git.commit({
    fs, dir,
    message: `Integration test deploy at ${timestamp}`,
    author: { name: 'Integration Test', email: 'test@wiki3.ai' },
  });
  assert(typeof sha === 'string' && sha.length === 40, `Commit created: ${sha.slice(0, 8)}`);

  // Verify committed tree is clean
  const committedFiles = await git.listFiles({ fs, dir });
  const dotgitInTree = committedFiles.filter(p => p === '.git' || p.startsWith('.git/'));
  assert(dotgitInTree.length === 0, 'Committed tree has no .git entries');

  // 7. Push to test branch
  let pushError = null;
  try {
    await git.push({
      fs, http: proxyHttp, dir,
      remote: 'origin',
      ref: 'HEAD',
      remoteRef: `refs/heads/${TEST_BRANCH}`,
      force: true,
      onAuth: () => ({ username: 'x-access-token', password: oauthToken }),
      onMessage: (msg) => console.log(`    remote: ${msg}`),
    });
  } catch (err) {
    pushError = err;
  }

  assert(!pushError, pushError
    ? `Push FAILED: ${pushError.message}`
    : `Push to ${TEST_BRANCH} succeeded`);

  console.log(`  (Deployed ${allPaths.length} files to ${TEST_BRANCH}, commit ${sha.slice(0, 8)})`);
}

// ═══════════════════════════════════════════════════════════════════════
// Test 9: [Interactive] Verify deploy — clone back and check files
// ═══════════════════════════════════════════════════════════════════════
async function testVerifyDeploy() {
  console.log('\n9. [Interactive] Verify deploy — clone back and check files');

  if (!INTERACTIVE || !oauthToken) {
    skip('Requires --interactive and successful OAuth (test 7)');
    return;
  }

  const proxyHttp = makeProxyHttp(PROXY_URL);
  const fs = new MemFS();
  const dir = '/verify-repo';

  // Clone the test branch back
  let cloneError = null;
  try {
    await git.clone({
      fs, http: proxyHttp, dir,
      url: REPO_URL,
      ref: TEST_BRANCH,
      singleBranch: true,
      depth: 1,
      onAuth: () => ({ username: 'x-access-token', password: oauthToken }),
    });
  } catch (err) {
    cloneError = err;
  }
  assert(!cloneError, cloneError
    ? `Clone of ${TEST_BRANCH} failed: ${cloneError.message}`
    : `Cloned ${TEST_BRANCH} successfully`);

  if (cloneError) return;

  // Check expected files exist
  const entries = await fs.promises.readdir(dir);
  assert(entries.includes('index.html'), 'index.html exists in clone');
  assert(entries.includes('.nojekyll'), '.nojekyll exists in clone');
  assert(entries.includes('files'), 'files/ directory exists in clone');

  // Verify file contents
  const indexContent = new TextDecoder().decode(await fs.promises.readFile(dir + '/index.html'));
  assert(indexContent.includes('Deploy test'), 'index.html contains deploy test marker');

  const testTxt = new TextDecoder().decode(await fs.promises.readFile(dir + '/files/test.txt'));
  assert(testTxt.includes('Integration test at'), 'files/test.txt has expected content');

  const csv = new TextDecoder().decode(await fs.promises.readFile(dir + '/files/data/sample.csv'));
  assert(csv.includes('alpha,1'), 'files/data/sample.csv has expected data');

  const nbRaw = new TextDecoder().decode(await fs.promises.readFile(dir + '/files/notebook.ipynb'));
  const nb = JSON.parse(nbRaw);
  assert(nb.nbformat === 4, 'notebook.ipynb is valid nbformat 4');
  assert(nb.cells[0].source[0] === '# Test notebook', 'notebook cell content matches');

  // Verify git history
  const log = await git.log({ fs, dir, depth: 1 });
  assert(log[0].commit.message.startsWith('Integration test deploy at'),
    `Commit message matches (${log[0].commit.message.trim().slice(0, 40)}…)`);
  assert(log[0].commit.author.name === 'Integration Test',
    'Commit author is "Integration Test"');

  // Verify NO .git entries leaked into the tree
  const treeFiles = await git.listFiles({ fs, dir });
  const dotgitLeaks = treeFiles.filter(p => p.startsWith('.git/'));
  assert(dotgitLeaks.length === 0,
    `No .git entries in remote tree (the hasDotgit bug is fixed)`);

  console.log(`  (Verified ${treeFiles.length} files in ${TEST_BRANCH})`);
}

// ═══════════════════════════════════════════════════════════════════════
// Test 10: [Interactive] Cleanup — delete test branch via GitHub API
// ═══════════════════════════════════════════════════════════════════════
async function testCleanup() {
  console.log('\n10. [Interactive] Cleanup — delete test branch');

  if (!INTERACTIVE || !oauthToken) {
    skip('Requires --interactive and successful OAuth (test 7)');
    return;
  }

  const resp = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/refs/heads/${TEST_BRANCH}`,
    {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${oauthToken}` },
    }
  );

  if (resp.status === 204 || resp.status === 200) {
    assert(true, `Deleted test branch ${TEST_BRANCH}`);
  } else if (resp.status === 422 || resp.status === 404) {
    // Branch doesn't exist or already deleted
    assert(true, `Test branch ${TEST_BRANCH} already cleaned up (${resp.status})`);
  } else {
    const body = await resp.text();
    assert(false, `Failed to delete test branch (${resp.status}): ${body}`);
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
    // Must skip .git — same filter as deploy.ts
    if (name === '.git') continue;
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
  await testDeploy();
  await testVerifyDeploy();
  await testCleanup();

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

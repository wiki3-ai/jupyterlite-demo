/**
 * Core push logic: uses GitHub's Git Data API (Trees/Blobs/Commits/Refs)
 * to update only the files/ subdirectory without downloading existing
 * site content. Zero download of blobs — only uploads new/changed files.
 */

import git from 'isomorphic-git';
import { makeProxyHttp } from './proxy-http';
import { MemFS } from './memfs';
import { Contents } from '@jupyterlab/services';

/** Options for a push operation. */
export interface IDeployOptions {
  /** Full HTTPS repo URL, e.g. https://github.com/user/repo.git */
  repoUrl: string;
  /** Branch to push to (default: gh-pages) */
  branch: string;
  /** GitHub Personal Access Token or OAuth token */
  token: string;
  /** Commit message */
  message: string;
  /** Author name */
  authorName: string;
  /** Author email */
  authorEmail: string;
  /** Base URL of the CORS proxy worker (empty = direct) */
  proxyUrl?: string;
  /** Optional progress callback */
  onProgress?: (msg: string) => void;
}

/** A file to be committed. */
export interface IFileEntry {
  /** Relative path inside the repo, e.g. "notebooks/demo.ipynb" */
  path: string;
  /** File content as bytes. */
  content: Uint8Array;
}

// ── GitHub API helpers ──────────────────────────────────────────────

/** Parse "owner" and "repo" from a GitHub URL. */
function parseGitHubUrl(repoUrl: string): { owner: string; repo: string } {
  // Handle https://github.com/owner/repo.git or https://github.com/owner/repo
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) {
    throw new Error(`Cannot parse owner/repo from URL: ${repoUrl}`);
  }
  return { owner: m[1], repo: m[2] };
}

/** Build the base API URL, routing through the CORS proxy if provided. */
function apiUrl(proxyUrl: string | undefined, path: string): string {
  const base = `https://api.github.com${path}`;
  if (proxyUrl) {
    return `${proxyUrl}/proxy/${base}`;
  }
  return base;
}

/** Authenticated fetch to GitHub API. */
async function ghFetch(
  url: string,
  token: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers as Record<string, string> || {}),
  };
  const resp = await fetch(url, { ...options, headers });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub API error (${resp.status}): ${body}`);
  }
  return resp;
}

// ── Git Data API types ──────────────────────────────────────────────

interface IGitTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

interface IGitTreeResponse {
  sha: string;
  tree: IGitTreeEntry[];
  truncated: boolean;
}

/**
 * Push content files to a remote branch using the GitHub Git Data API.
 *
 * This avoids cloning entirely. Instead it:
 *   1. Reads the current branch ref → commit SHA → tree SHA
 *   2. Gets the recursive tree (just SHA references, no blob content)
 *   3. Computes blob SHAs locally, uploads only new/changed blobs
 *   4. Creates a new tree with updated entries under files/
 *   5. Creates a commit and updates the branch ref
 *
 * The only data transferred is the new/changed file content (upload).
 * No existing site content (build/, static/, etc.) is downloaded.
 */
export async function deployToGitHub(
  files: IFileEntry[],
  options: IDeployOptions
): Promise<void> {
  const {
    repoUrl,
    branch,
    token,
    message,
    authorName,
    authorEmail,
    proxyUrl,
    onProgress,
  } = options;

  const log = (msg: string) => onProgress?.(msg);
  const { owner, repo } = parseGitHubUrl(repoUrl);
  const repoPath = `/repos/${owner}/${repo}`;

  // ── 1. Get current branch HEAD ────────────────────────────────────
  log(`Reading ${branch} ref…`);
  let parentCommitSha: string | null = null;
  let baseTreeSha: string | null = null;

  try {
    const refResp = await ghFetch(
      apiUrl(proxyUrl, `${repoPath}/git/ref/heads/${branch}`),
      token
    );
    const refData = await refResp.json() as { object: { sha: string } };
    parentCommitSha = refData.object.sha;

    // Get the commit to find its tree
    const commitResp = await ghFetch(
      apiUrl(proxyUrl, `${repoPath}/git/commits/${parentCommitSha}`),
      token
    );
    const commitData = await commitResp.json() as { tree: { sha: string } };
    baseTreeSha = commitData.tree.sha;
    log(`Current HEAD: ${parentCommitSha.slice(0, 8)}, tree: ${baseTreeSha.slice(0, 8)}`);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('404') || errMsg.includes('Not Found')) {
      log(`Branch "${branch}" does not exist — will create it.`);
    } else {
      throw err;
    }
  }

  // ── 2. Get existing tree (SHA references only, no blob content) ───
  let existingTree: IGitTreeEntry[] = [];
  if (baseTreeSha) {
    log('Reading existing tree…');
    const treeResp = await ghFetch(
      apiUrl(proxyUrl, `${repoPath}/git/trees/${baseTreeSha}?recursive=1`),
      token
    );
    const treeData = await treeResp.json() as IGitTreeResponse;
    existingTree = treeData.tree;
    if (treeData.truncated) {
      log('  Warning: tree was truncated (very large repo)');
    }
    log(`  ${existingTree.length} entries in existing tree`);
  }

  // Build a map of existing file paths → SHA for quick lookup
  const existingBlobShas = new Map<string, string>();
  for (const entry of existingTree) {
    if (entry.type === 'blob') {
      existingBlobShas.set(entry.path, entry.sha);
    }
  }

  // ── 3. Compute blob SHAs locally, upload only new/changed blobs ───
  log(`Processing ${files.length} content file(s)…`);
  const newTreeEntries: Array<{
    path: string;
    mode: string;
    type: string;
    sha: string;
  }> = [];

  let uploaded = 0;
  let skipped = 0;

  for (const file of files) {
    const repoPath_ = 'files/' + file.path;
    // Compute the git blob SHA (same algorithm git uses)
    const blobSha = await computeBlobSha(file.content);

    if (existingBlobShas.get(repoPath_) === blobSha) {
      // File unchanged — reuse existing SHA, no upload needed
      skipped++;
      continue;
    }

    // Upload the blob
    const blobResp = await ghFetch(
      apiUrl(proxyUrl, `${repoPath}/git/blobs`),
      token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: uint8ArrayToBase64(file.content),
          encoding: 'base64',
        }),
      }
    );
    const blobData = await blobResp.json() as { sha: string };
    uploaded++;
    log(`  ↑ files/${file.path} (${formatBytes(file.content.length)})`);

    newTreeEntries.push({
      path: repoPath_,
      mode: '100644',
      type: 'blob',
      sha: blobData.sha,
    });
  }

  if (uploaded === 0) {
    log(`No files changed (${skipped} identical) — nothing to push.`);
    return;
  }

  log(`${uploaded} file(s) uploaded, ${skipped} unchanged.`);

  // ── 4. Create new tree ────────────────────────────────────────────
  log('Creating tree…');
  const treeBody: Record<string, unknown> = {
    tree: newTreeEntries,
  };
  if (baseTreeSha) {
    // base_tree preserves all existing entries not listed in `tree`
    treeBody.base_tree = baseTreeSha;
  }

  const newTreeResp = await ghFetch(
    apiUrl(proxyUrl, `/repos/${owner}/${repo}/git/trees`),
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(treeBody),
    }
  );
  const newTreeData = await newTreeResp.json() as { sha: string };
  log(`  New tree: ${newTreeData.sha.slice(0, 8)}`);

  // ── 5. Create commit ──────────────────────────────────────────────
  log('Creating commit…');
  const now = new Date().toISOString();
  const commitBody: Record<string, unknown> = {
    message,
    tree: newTreeData.sha,
    author: {
      name: authorName,
      email: authorEmail,
      date: now,
    },
  };
  if (parentCommitSha) {
    commitBody.parents = [parentCommitSha];
  }

  const commitResp = await ghFetch(
    apiUrl(proxyUrl, `/repos/${owner}/${repo}/git/commits`),
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commitBody),
    }
  );
  const commitData = await commitResp.json() as { sha: string };
  log(`  Commit: ${commitData.sha.slice(0, 8)}`);

  // ── 6. Update branch ref ──────────────────────────────────────────
  log(`Updating ${branch}…`);
  if (parentCommitSha) {
    // Branch exists — update it
    await ghFetch(
      apiUrl(proxyUrl, `/repos/${owner}/${repo}/git/refs/heads/${branch}`),
      token,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: commitData.sha }),
      }
    );
  } else {
    // Branch doesn't exist — create it
    await ghFetch(
      apiUrl(proxyUrl, `/repos/${owner}/${repo}/git/refs`),
      token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha: commitData.sha,
        }),
      }
    );
  }

  log('Push complete ✓');
}

// ── Blob SHA computation ────────────────────────────────────────────

/**
 * Compute the git blob SHA-1 for content.
 * Git hashes: "blob <size>\0<content>"
 */
async function computeBlobSha(content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const full = new Uint8Array(header.length + content.length);
  full.set(header, 0);
  full.set(content, header.length);

  // Use Web Crypto API (available in browsers and workers)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-1', full);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Fallback: use isomorphic-git's internal SHA function if available
  // This shouldn't happen in browsers but provides a safety net
  throw new Error('SHA-1 not available (no crypto.subtle)');
}

/** Convert Uint8Array to base64 string. */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  // btoa works in browsers; for large files, process in chunks
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j]);
    }
  }
  return btoa(binary);
}

/** Format bytes as human-readable string. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Recursively enumerate all files under `dir` in the given MemFS,
 * returning paths relative to `dir`.
 */
async function listAllFiles(
  fs: MemFS,
  dir: string,
  prefix: string
): Promise<string[]> {
  const entries = (await fs.promises.readdir(
    prefix ? dir + '/' + prefix : dir
  )) as string[];
  const result: string[] = [];
  for (const name of entries) {
    // Skip .git internals — GitHub rejects trees containing '.git'
    if (name === '.git') continue;
    const rel = prefix ? prefix + '/' + name : name;
    const full = dir + '/' + rel;
    const stat = (await fs.promises.stat(full)) as { isDirectory(): boolean };
    if (stat.isDirectory()) {
      result.push(...(await listAllFiles(fs, dir, rel)));
    } else {
      result.push(rel);
    }
  }
  return result;
}

/**
 * Collect all files from the JupyterLite Contents API, recursively.
 * Returns IFileEntry[] suitable for `deployToGitHub`.
 */
export async function collectContentsFiles(
  contentsManager: Contents.IManager,
  basePath = ''
): Promise<IFileEntry[]> {
  const files: IFileEntry[] = [];
  const model = await contentsManager.get(basePath, { content: true });

  if (model.type === 'directory') {
    const items = model.content as Contents.IModel[];
    for (const item of items) {
      if (item.type === 'directory') {
        const sub = await collectContentsFiles(contentsManager, item.path);
        files.push(...sub);
      } else {
        const full = await contentsManager.get(item.path, { content: true });
        const content = encodeContent(full);
        files.push({ path: item.path, content });
      }
    }
  } else {
    const content = encodeContent(model);
    files.push({ path: model.path, content });
  }

  return files;
}

/**
 * Convert a Contents model's content to bytes.
 */
function encodeContent(model: Contents.IModel): Uint8Array {
  const raw = model.content;
  if (model.format === 'base64' && typeof raw === 'string') {
    return Uint8Array.from(atob(raw), c => c.charCodeAt(0));
  }
  if (typeof raw === 'string') {
    return new TextEncoder().encode(raw);
  }
  // JSON content (notebooks)
  return new TextEncoder().encode(JSON.stringify(raw, null, 2) + '\n');
}

// ── Sync / Pull ────────────────────────────────────────────────────────

/** Options for syncing from a remote repo. */
export interface ISyncOptions {
  /** Full HTTPS repo URL */
  repoUrl: string;
  /** Branch to pull from (default: gh-pages) */
  branch: string;
  /** GitHub token (may be empty for public repos) */
  token: string;
  /** Only sync files under this subdirectory (e.g. "files") — empty = all */
  contentPath: string;
  /** Base URL of the CORS proxy worker (empty = direct) */
  proxyUrl?: string;
  /** Progress callback */
  onProgress?: (msg: string) => void;
}

/**
 * Pull the latest content files from a remote branch and write them
 * into the JupyterLite Contents API, replacing stale browser-cached versions.
 *
 * For public repos no token is needed.
 */
export async function syncFromRepo(
  contentsManager: Contents.IManager,
  options: ISyncOptions
): Promise<{ updated: number; total: number }> {
  const { repoUrl, branch, token, contentPath, proxyUrl, onProgress } = options;
  const log = (msg: string) => onProgress?.(msg);

  const http = makeProxyHttp(proxyUrl);
  const fs = new MemFS();
  const dir = '/repo';

  log('Cloning (shallow) from remote…');
  await git.clone({
    fs,
    http,
    dir,
    url: repoUrl,
    ref: branch,
    singleBranch: true,
    depth: 1,
    onAuth: token ? () => ({ username: 'x-access-token', password: token }) : undefined,
    onMessage: (msg: string) => log(`  remote: ${msg}`),
  });

  // List all files from the clone
  const prefix = contentPath ? contentPath.replace(/\/+$/, '') : '';
  const searchDir = prefix ? dir + '/' + prefix : dir;

  let allFiles: string[];
  try {
    allFiles = await listAllFiles(fs, searchDir, '');
  } catch {
    log(`No files found under "${prefix || '/'}".`);
    return { updated: 0, total: 0 };
  }

  // Filter out git internals and .nojekyll
  const contentFiles = allFiles.filter(
    f => !f.startsWith('.git/') && f !== '.git' && f !== '.nojekyll'
  );

  log(`Found ${contentFiles.length} file(s) in repo.`);

  let updated = 0;
  for (const relPath of contentFiles) {
    const fullPath = searchDir + '/' + relPath;
    const data = (await fs.promises.readFile(fullPath)) as Uint8Array;

    // Determine the target path in the Contents API
    // Strip the contentPath prefix so files land at the root of JupyterLite's FS
    const targetPath = relPath;

    // Determine format and content for the Contents API
    const ext = targetPath.split('.').pop()?.toLowerCase() ?? '';
    const isNotebook = ext === 'ipynb';
    const isBinary = [
      'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg',
      'woff', 'woff2', 'ttf', 'eot', 'pdf', 'zip', 'gz',
      'whl', 'pyc', 'so', 'wasm'
    ].includes(ext);

    try {
      // Ensure parent directories exist
      const parts = targetPath.split('/');
      if (parts.length > 1) {
        let cur = '';
        for (let i = 0; i < parts.length - 1; i++) {
          cur = cur ? cur + '/' + parts[i] : parts[i];
          try {
            await contentsManager.get(cur);
          } catch {
            await contentsManager.save(cur, {
              type: 'directory',
              name: parts[i],
              path: cur,
            } as any);
          }
        }
      }

      if (isNotebook) {
        // Parse the notebook JSON and save as notebook type
        const text = new TextDecoder().decode(data);
        const nbContent = JSON.parse(text);
        await contentsManager.save(targetPath, {
          type: 'notebook',
          format: 'json',
          content: nbContent,
        } as any);
      } else if (isBinary) {
        // Save as base64
        const b64 = btoa(String.fromCharCode(...data));
        await contentsManager.save(targetPath, {
          type: 'file',
          format: 'base64',
          content: b64,
        } as any);
      } else {
        // Save as text
        const text = new TextDecoder().decode(data);
        await contentsManager.save(targetPath, {
          type: 'file',
          format: 'text',
          content: text,
        } as any);
      }

      updated++;
      log(`  ✓ ${targetPath}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ✗ ${targetPath}: ${msg}`);
    }
  }

  log(`\nSynced ${updated}/${contentFiles.length} file(s).`);
  return { updated, total: contentFiles.length };
}

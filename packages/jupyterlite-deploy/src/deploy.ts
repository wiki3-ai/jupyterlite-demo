/**
 * Core deploy logic: collect files, build a git tree in-memory,
 * commit, and force-push to a remote branch using isomorphic-git.
 */

import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { MemFS } from './memfs';
import { Contents } from '@jupyterlab/services';

/** Options for a deploy operation. */
export interface IDeployOptions {
  /** Full HTTPS repo URL, e.g. https://github.com/user/repo.git */
  repoUrl: string;
  /** Branch to push to (default: gh-pages) */
  branch: string;
  /** GitHub Personal Access Token (fine-grained or classic, needs Contents: write) */
  token: string;
  /** Commit message */
  message: string;
  /** Author name */
  authorName: string;
  /** Author email */
  authorEmail: string;
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

/**
 * Deploy a set of files to a remote branch via isomorphic-git.
 *
 * This creates a fresh in-memory repo, writes all files, commits, and
 * force-pushes to the specified branch — completely replacing its contents.
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
    onProgress,
  } = options;

  const log = (msg: string) => onProgress?.(msg);
  const fs = new MemFS();
  const dir = '/repo';

  log(`Initializing in-memory repository…`);
  await git.init({ fs, dir });

  // Configure remote
  await git.addRemote({ fs, dir, remote: 'origin', url: repoUrl });

  // Write all files into the working tree
  log(`Writing ${files.length} files…`);
  for (const file of files) {
    const filepath = file.path;
    // Ensure parent dirs exist in the MemFS
    const parts = filepath.split('/');
    let cur = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i];
      try {
        await fs.promises.mkdir(cur);
      } catch {
        // dir already exists
      }
    }
    await fs.promises.writeFile(dir + '/' + filepath, file.content);
  }

  // Add a .nojekyll so GitHub Pages serves files as-is
  await fs.promises.writeFile(dir + '/.nojekyll', new Uint8Array(0));

  // Stage all files
  log('Staging files…');
  const allPaths = await listAllFiles(fs, dir, '');
  for (const p of allPaths) {
    await git.add({ fs, dir, filepath: p });
  }

  // Commit
  log('Creating commit…');
  const sha = await git.commit({
    fs,
    dir,
    message,
    author: { name: authorName, email: authorEmail },
  });
  log(`Commit: ${sha.slice(0, 8)}`);

  // Force-push to the target branch
  log(`Pushing to ${branch}…`);
  await git.push({
    fs,
    http,
    dir,
    remote: 'origin',
    ref: 'HEAD',
    remoteRef: `refs/heads/${branch}`,
    force: true,
    onAuth: () => ({ username: 'x-access-token', password: token }),
    onMessage: (msg: string) => log(`  remote: ${msg}`),
  });

  log('Deploy complete ✓');
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

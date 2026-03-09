"use strict";
(self["webpackChunkjupyterlite_deploy"] = self["webpackChunkjupyterlite_deploy"] || []).push([["lib_index_js"],{

/***/ "./lib/deploy.js"
/*!***********************!*\
  !*** ./lib/deploy.js ***!
  \***********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   collectContentsFiles: () => (/* binding */ collectContentsFiles),
/* harmony export */   deployToGitHub: () => (/* binding */ deployToGitHub),
/* harmony export */   syncFromRepo: () => (/* binding */ syncFromRepo)
/* harmony export */ });
/* harmony import */ var isomorphic_git__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! isomorphic-git */ "webpack/sharing/consume/default/isomorphic-git/isomorphic-git");
/* harmony import */ var _proxy_http__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./proxy-http */ "./lib/proxy-http.js");
/* harmony import */ var _memfs__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./memfs */ "./lib/memfs.js");
/**
 * Core deploy logic: collect files, build a git tree in-memory,
 * commit, and force-push to a remote branch using isomorphic-git.
 */



/**
 * Deploy a set of files to a remote branch via isomorphic-git.
 *
 * This creates a fresh in-memory repo, writes all files, commits, and
 * force-pushes to the specified branch — completely replacing its contents.
 */
async function deployToGitHub(files, options) {
    const { repoUrl, branch, token, message, authorName, authorEmail, proxyUrl, onProgress, } = options;
    const log = (msg) => onProgress === null || onProgress === void 0 ? void 0 : onProgress(msg);
    const http = (0,_proxy_http__WEBPACK_IMPORTED_MODULE_1__.makeProxyHttp)(proxyUrl);
    const fs = new _memfs__WEBPACK_IMPORTED_MODULE_2__.MemFS();
    const dir = '/repo';
    log(`Initializing in-memory repository…`);
    await isomorphic_git__WEBPACK_IMPORTED_MODULE_0__["default"].init({ fs, dir });
    // Configure remote
    await isomorphic_git__WEBPACK_IMPORTED_MODULE_0__["default"].addRemote({ fs, dir, remote: 'origin', url: repoUrl });
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
            }
            catch (_a) {
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
        await isomorphic_git__WEBPACK_IMPORTED_MODULE_0__["default"].add({ fs, dir, filepath: p });
    }
    // Commit
    log('Creating commit…');
    const sha = await isomorphic_git__WEBPACK_IMPORTED_MODULE_0__["default"].commit({
        fs,
        dir,
        message,
        author: { name: authorName, email: authorEmail },
    });
    log(`Commit: ${sha.slice(0, 8)}`);
    // Force-push to the target branch
    log(`Pushing to ${branch}…`);
    await isomorphic_git__WEBPACK_IMPORTED_MODULE_0__["default"].push({
        fs,
        http,
        dir,
        remote: 'origin',
        ref: 'HEAD',
        remoteRef: `refs/heads/${branch}`,
        force: true,
        onAuth: () => ({ username: 'x-access-token', password: token }),
        onMessage: (msg) => log(`  remote: ${msg}`),
    });
    log('Deploy complete ✓');
}
/**
 * Recursively enumerate all files under `dir` in the given MemFS,
 * returning paths relative to `dir`.
 */
async function listAllFiles(fs, dir, prefix) {
    const entries = (await fs.promises.readdir(prefix ? dir + '/' + prefix : dir));
    const result = [];
    for (const name of entries) {
        // Skip .git internals — GitHub rejects trees containing '.git'
        if (name === '.git')
            continue;
        const rel = prefix ? prefix + '/' + name : name;
        const full = dir + '/' + rel;
        const stat = (await fs.promises.stat(full));
        if (stat.isDirectory()) {
            result.push(...(await listAllFiles(fs, dir, rel)));
        }
        else {
            result.push(rel);
        }
    }
    return result;
}
/**
 * Collect all files from the JupyterLite Contents API, recursively.
 * Returns IFileEntry[] suitable for `deployToGitHub`.
 */
async function collectContentsFiles(contentsManager, basePath = '') {
    const files = [];
    const model = await contentsManager.get(basePath, { content: true });
    if (model.type === 'directory') {
        const items = model.content;
        for (const item of items) {
            if (item.type === 'directory') {
                const sub = await collectContentsFiles(contentsManager, item.path);
                files.push(...sub);
            }
            else {
                const full = await contentsManager.get(item.path, { content: true });
                const content = encodeContent(full);
                files.push({ path: item.path, content });
            }
        }
    }
    else {
        const content = encodeContent(model);
        files.push({ path: model.path, content });
    }
    return files;
}
/**
 * Convert a Contents model's content to bytes.
 */
function encodeContent(model) {
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
/**
 * Pull the latest content files from a remote branch and write them
 * into the JupyterLite Contents API, replacing stale browser-cached versions.
 *
 * For public repos no token is needed.
 */
async function syncFromRepo(contentsManager, options) {
    var _a, _b;
    const { repoUrl, branch, token, contentPath, proxyUrl, onProgress } = options;
    const log = (msg) => onProgress === null || onProgress === void 0 ? void 0 : onProgress(msg);
    const http = (0,_proxy_http__WEBPACK_IMPORTED_MODULE_1__.makeProxyHttp)(proxyUrl);
    const fs = new _memfs__WEBPACK_IMPORTED_MODULE_2__.MemFS();
    const dir = '/repo';
    log('Cloning (shallow) from remote…');
    await isomorphic_git__WEBPACK_IMPORTED_MODULE_0__["default"].clone({
        fs,
        http,
        dir,
        url: repoUrl,
        ref: branch,
        singleBranch: true,
        depth: 1,
        onAuth: token ? () => ({ username: 'x-access-token', password: token }) : undefined,
        onMessage: (msg) => log(`  remote: ${msg}`),
    });
    // List all files from the clone
    const prefix = contentPath ? contentPath.replace(/\/+$/, '') : '';
    const searchDir = prefix ? dir + '/' + prefix : dir;
    let allFiles;
    try {
        allFiles = await listAllFiles(fs, searchDir, '');
    }
    catch (_c) {
        log(`No files found under "${prefix || '/'}".`);
        return { updated: 0, total: 0 };
    }
    // Filter out git internals and .nojekyll
    const contentFiles = allFiles.filter(f => !f.startsWith('.git/') && f !== '.git' && f !== '.nojekyll');
    log(`Found ${contentFiles.length} file(s) in repo.`);
    let updated = 0;
    for (const relPath of contentFiles) {
        const fullPath = searchDir + '/' + relPath;
        const data = (await fs.promises.readFile(fullPath));
        // Determine the target path in the Contents API
        // Strip the contentPath prefix so files land at the root of JupyterLite's FS
        const targetPath = relPath;
        // Determine format and content for the Contents API
        const ext = (_b = (_a = targetPath.split('.').pop()) === null || _a === void 0 ? void 0 : _a.toLowerCase()) !== null && _b !== void 0 ? _b : '';
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
                    }
                    catch (_d) {
                        await contentsManager.save(cur, {
                            type: 'directory',
                            name: parts[i],
                            path: cur,
                        });
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
                });
            }
            else if (isBinary) {
                // Save as base64
                const b64 = btoa(String.fromCharCode(...data));
                await contentsManager.save(targetPath, {
                    type: 'file',
                    format: 'base64',
                    content: b64,
                });
            }
            else {
                // Save as text
                const text = new TextDecoder().decode(data);
                await contentsManager.save(targetPath, {
                    type: 'file',
                    format: 'text',
                    content: text,
                });
            }
            updated++;
            log(`  ✓ ${targetPath}`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`  ✗ ${targetPath}: ${msg}`);
        }
    }
    log(`\nSynced ${updated}/${contentFiles.length} file(s).`);
    return { updated, total: contentFiles.length };
}


/***/ },

/***/ "./lib/index.js"
/*!**********************!*\
  !*** ./lib/index.js ***!
  \**********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   "default": () => (__WEBPACK_DEFAULT_EXPORT__)
/* harmony export */ });
/* harmony import */ var buffer__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! buffer */ "webpack/sharing/consume/default/buffer/buffer");
/* harmony import */ var _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! @jupyterlab/apputils */ "webpack/sharing/consume/default/@jupyterlab/apputils");
/* harmony import */ var _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1___default = /*#__PURE__*/__webpack_require__.n(_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__);
/* harmony import */ var _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! @lumino/widgets */ "webpack/sharing/consume/default/@lumino/widgets");
/* harmony import */ var _lumino_widgets__WEBPACK_IMPORTED_MODULE_2___default = /*#__PURE__*/__webpack_require__.n(_lumino_widgets__WEBPACK_IMPORTED_MODULE_2__);
/* harmony import */ var _deploy__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./deploy */ "./lib/deploy.js");
/* harmony import */ var _proxy_http__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! ./proxy-http */ "./lib/proxy-http.js");
/* harmony import */ var _oauth__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(/*! ./oauth */ "./lib/oauth.js");
/**
 * jupyterlite-deploy — JupyterLab/JupyterLite extension
 *
 * Adds a "Deploy to GitHub Pages" command that uses isomorphic-git
 * to push files from the Contents API to a gh-pages branch.
 */
// Polyfill Buffer for isomorphic-git (webpack 5 doesn't auto-polyfill Node globals)

if (typeof globalThis.Buffer === 'undefined') {
    globalThis.Buffer = buffer__WEBPACK_IMPORTED_MODULE_0__.Buffer;
}





/** Command IDs */
const CMD_DEPLOY = 'deploy:gh-pages';
const CMD_SYNC = 'deploy:sync';
const CMD_LOGIN = 'deploy:login';
/**
 * Build the deploy configuration dialog body.
 */
function createDeployDialogBody() {
    var _a, _b, _c;
    const body = document.createElement('div');
    body.classList.add('jl-deploy-dialog');
    body.innerHTML = `
    <label for="jl-deploy-proxy">CORS Proxy URL</label>
    <input id="jl-deploy-proxy" type="text"
           placeholder="https://your-worker.workers.dev"
           value="${(_a = localStorage.getItem('jl-deploy-proxy')) !== null && _a !== void 0 ? _a : ''}" />

    <label for="jl-deploy-repo">Repository URL</label>
    <input id="jl-deploy-repo" type="text"
           placeholder="https://github.com/user/repo.git"
           value="${(_b = localStorage.getItem('jl-deploy-repo')) !== null && _b !== void 0 ? _b : ''}" />

    <label for="jl-deploy-branch">Branch</label>
    <input id="jl-deploy-branch" type="text"
           value="${localStorage.getItem('jl-deploy-branch') || 'gh-pages'}" />

    <label for="jl-deploy-token">GitHub Token</label>
    <div style="display: flex; gap: 4px; align-items: center;">
      <input id="jl-deploy-token" type="password" style="flex: 1;"
             placeholder="ghp_… or use Login button"
             value="${(_c = sessionStorage.getItem('jl-deploy-token')) !== null && _c !== void 0 ? _c : ''}" />
      <button id="jl-deploy-oauth-btn" type="button"
              style="white-space: nowrap; padding: 2px 8px;">Login with GitHub</button>
      <button id="jl-deploy-clear-token" type="button"
              style="white-space: nowrap; padding: 2px 8px;">Clear</button>
    </div>
    <div style="margin-top: 4px;">
      <label style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.85em; cursor: pointer;">
        <input id="jl-deploy-remember-token" type="checkbox"
               ${sessionStorage.getItem('jl-deploy-token') ? 'checked' : ''} />
        Remember token for this session
      </label>
    </div>

    <label for="jl-deploy-author">Author</label>
    <input id="jl-deploy-author" type="text"
           placeholder="Deploy Bot <deploy@example.com>"
           value="${localStorage.getItem('jl-deploy-author') || 'Deploy Bot <deploy@example.com>'}" />

    <label for="jl-deploy-message">Commit message</label>
    <input id="jl-deploy-message" type="text"
           value="Deploy JupyterLite site" />
  `;
    // Wire up buttons
    setTimeout(() => {
        const btn = body.querySelector('#jl-deploy-oauth-btn');
        const clearBtn = body.querySelector('#jl-deploy-clear-token');
        const tokenInput = body.querySelector('#jl-deploy-token');
        const proxyInput = body.querySelector('#jl-deploy-proxy');
        const rememberCb = body.querySelector('#jl-deploy-remember-token');
        if (btn) {
            btn.addEventListener('click', () => {
                void doOAuthLogin(proxyInput.value.trim(), tokenInput);
            });
        }
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                tokenInput.value = '';
                rememberCb.checked = false;
                sessionStorage.removeItem('jl-deploy-token');
            });
        }
    }, 0);
    return body;
}
/**
 * Parse "Name <email>" into { name, email }.
 */
function parseAuthor(raw) {
    const m = raw.match(/^(.+?)\s*<(.+?)>\s*$/);
    if (m) {
        return { name: m[1].trim(), email: m[2].trim() };
    }
    return { name: raw.trim() || 'Deploy', email: 'deploy@example.com' };
}
/**
 * Perform GitHub OAuth Device Flow login.
 * Shows a dialog with the user code and verification URL,
 * polls for the token, and fills the token input.
 */
async function doOAuthLogin(proxyUrl, tokenInput) {
    if (!proxyUrl) {
        await (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
            title: 'OAuth Login',
            body: 'Please enter a CORS Proxy URL first.',
            buttons: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton()],
        });
        return;
    }
    try {
        const oauthConfig = { proxyUrl };
        const { device_code, user_code, verification_uri, expires_in, interval } = await (0,_oauth__WEBPACK_IMPORTED_MODULE_5__.requestDeviceCode)(oauthConfig);
        const msgNode = document.createElement('div');
        msgNode.innerHTML = `
      <p>Go to <a href="${verification_uri}" target="_blank" rel="noopener">
      ${verification_uri}</a> and enter this code:</p>
      <pre style="font-size: 1.5em; text-align: center; letter-spacing: 0.15em;
                  background: var(--jp-layout-color2); padding: 12px; border-radius: 4px;
                  user-select: all;">${user_code}</pre>
      <p id="jl-oauth-status" style="font-size: 0.85em; color: var(--jp-ui-font-color2);">
        Waiting for authorization…</p>
    `;
        const controller = new AbortController();
        // Show the dialog (non-blocking — user can cancel)
        const dialogPromise = (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
            title: 'GitHub Device Login',
            body: new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node: msgNode }),
            buttons: [
                _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.cancelButton({ label: 'Cancel' }),
            ],
        });
        // When dialog is dismissed, abort polling
        dialogPromise.then(() => controller.abort()).catch(() => controller.abort());
        const statusEl = msgNode.querySelector('#jl-oauth-status');
        const result = await (0,_oauth__WEBPACK_IMPORTED_MODULE_5__.pollForToken)(oauthConfig, device_code, interval, expires_in, (msg) => {
            if (statusEl) {
                statusEl.textContent = msg;
            }
        }, controller.signal);
        if (result) {
            (0,_oauth__WEBPACK_IMPORTED_MODULE_5__.cacheToken)(result.access_token);
            tokenInput.value = result.access_token;
            if (statusEl) {
                statusEl.textContent = 'Logged in successfully!';
            }
            // Dismiss the dialog after a short delay
            await new Promise(r => setTimeout(r, 800));
            _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.flush();
        }
    }
    catch (err) {
        if (err.name !== 'AbortError') {
            await (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                title: 'OAuth Error',
                body: String(err.message || err),
                buttons: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton()],
            });
        }
    }
}
/**
 * Extension activation.
 */
const plugin = {
    id: 'jupyterlite-deploy:plugin',
    description: 'Deploy JupyterLite sites to GitHub Pages using isomorphic-git',
    autoStart: true,
    optional: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.ICommandPalette],
    activate: (app, palette) => {
        console.log('jupyterlite-deploy: activated');
        app.commands.addCommand(CMD_DEPLOY, {
            label: 'Wiki3.ai Sync: Deploy to GitHub Pages',
            caption: 'Push site contents to a gh-pages branch via isomorphic-git',
            execute: async () => {
                var _a, _b;
                // ── 1. Show config dialog ────────────────────────────────────
                const body = createDeployDialogBody();
                const dialogResult = await (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                    title: 'Deploy to GitHub Pages',
                    body: new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node: body }),
                    buttons: [
                        _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.cancelButton(),
                        _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton({ label: 'Deploy' }),
                    ],
                });
                if (!dialogResult.button.accept) {
                    return;
                }
                const repoUrl = body.querySelector('#jl-deploy-repo').value.trim();
                const branch = body.querySelector('#jl-deploy-branch').value.trim();
                const token = body.querySelector('#jl-deploy-token').value.trim();
                const authorRaw = body.querySelector('#jl-deploy-author').value.trim();
                const message = body.querySelector('#jl-deploy-message').value.trim();
                const proxyUrl = body.querySelector('#jl-deploy-proxy').value.trim();
                if (!repoUrl || !token) {
                    void (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                        title: 'Deploy Error',
                        body: 'Repository URL and GitHub Token are required.',
                        buttons: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton()],
                    });
                    return;
                }
                // Persist non-secret settings for convenience
                localStorage.setItem('jl-deploy-repo', repoUrl);
                localStorage.setItem('jl-deploy-branch', branch);
                localStorage.setItem('jl-deploy-author', authorRaw);
                if (proxyUrl)
                    localStorage.setItem('jl-deploy-proxy', proxyUrl);
                // Only remember token if checkbox is checked
                const rememberToken = (_a = body.querySelector('#jl-deploy-remember-token')) === null || _a === void 0 ? void 0 : _a.checked;
                if (rememberToken) {
                    sessionStorage.setItem('jl-deploy-token', token);
                }
                else {
                    sessionStorage.removeItem('jl-deploy-token');
                }
                const { name: authorName, email: authorEmail } = parseAuthor(authorRaw);
                // ── 2. Collect files ──────────────────────────────────────────
                const statusNode = document.createElement('pre');
                statusNode.classList.add('jl-deploy-status');
                statusNode.textContent = 'Collecting files…\n';
                const statusWidget = new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node: statusNode });
                void (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                    title: 'Deploying…',
                    body: statusWidget,
                    buttons: [], // no user buttons while deploying
                });
                const log = (msg) => {
                    statusNode.textContent += msg + '\n';
                    statusNode.scrollTop = statusNode.scrollHeight;
                };
                try {
                    log('Reading files from Contents API…');
                    const files = await (0,_deploy__WEBPACK_IMPORTED_MODULE_3__.collectContentsFiles)(app.serviceManager.contents);
                    log(`Collected ${files.length} file(s).`);
                    // ── 3. Deploy ────────────────────────────────────────────────
                    await (0,_deploy__WEBPACK_IMPORTED_MODULE_3__.deployToGitHub)(files, {
                        repoUrl,
                        branch: branch || 'gh-pages',
                        token,
                        message: message || 'Deploy JupyterLite site',
                        authorName,
                        authorEmail,
                        proxyUrl: proxyUrl || (0,_proxy_http__WEBPACK_IMPORTED_MODULE_4__.getProxyUrl)(),
                        onProgress: log,
                    });
                    log('\nDone!');
                }
                catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    log(`\nERROR: ${errMsg}`);
                }
                // Replace the modeless progress dialog with a closeable one
                // (the Dialog promise resolves when dismissed by code below)
                // We wait a beat so the user can read the final status.
                await new Promise(r => setTimeout(r, 300));
                // Close the progress dialog by resolving it
                _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.flush();
                // Show final status
                const finalNode = document.createElement('pre');
                finalNode.classList.add('jl-deploy-status');
                finalNode.textContent = (_b = statusNode.textContent) !== null && _b !== void 0 ? _b : '';
                await (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                    title: 'Deploy Result',
                    body: new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node: finalNode }),
                    buttons: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton({ label: 'Close' })],
                });
            },
        });
        // ── Sync from Repository command ───────────────────────────────
        app.commands.addCommand(CMD_SYNC, {
            label: 'Wiki3.ai Sync: Pull from Repository',
            caption: 'Pull latest content files from a git branch into JupyterLite',
            execute: async () => {
                var _a, _b;
                const syncBody = createSyncDialogBody();
                const syncResult = await (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                    title: 'Sync Files from Repository',
                    body: new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node: syncBody }),
                    buttons: [
                        _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.cancelButton(),
                        _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton({ label: 'Sync' }),
                    ],
                });
                if (!syncResult.button.accept) {
                    return;
                }
                const repoUrl = syncBody.querySelector('#jl-sync-repo').value.trim();
                const branch = syncBody.querySelector('#jl-sync-branch').value.trim();
                const token = syncBody.querySelector('#jl-sync-token').value.trim();
                const contentPath = syncBody.querySelector('#jl-sync-path').value.trim();
                const proxyUrl = syncBody.querySelector('#jl-sync-proxy').value.trim();
                if (!repoUrl) {
                    void (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                        title: 'Sync Error',
                        body: 'Repository URL is required.',
                        buttons: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton()],
                    });
                    return;
                }
                // Persist settings
                localStorage.setItem('jl-deploy-repo', repoUrl);
                localStorage.setItem('jl-sync-branch', branch);
                localStorage.setItem('jl-sync-path', contentPath);
                if (proxyUrl)
                    localStorage.setItem('jl-deploy-proxy', proxyUrl);
                const rememberSyncToken = (_a = syncBody.querySelector('#jl-sync-remember-token')) === null || _a === void 0 ? void 0 : _a.checked;
                if (token && rememberSyncToken) {
                    sessionStorage.setItem('jl-deploy-token', token);
                }
                else if (!rememberSyncToken) {
                    sessionStorage.removeItem('jl-deploy-token');
                }
                // Show progress
                const statusNode = document.createElement('pre');
                statusNode.classList.add('jl-deploy-status');
                statusNode.textContent = 'Starting sync…\n';
                const statusWidget = new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node: statusNode });
                void (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                    title: 'Syncing…',
                    body: statusWidget,
                    buttons: [],
                });
                const log = (msg) => {
                    statusNode.textContent += msg + '\n';
                    statusNode.scrollTop = statusNode.scrollHeight;
                };
                try {
                    const result = await (0,_deploy__WEBPACK_IMPORTED_MODULE_3__.syncFromRepo)(app.serviceManager.contents, {
                        repoUrl,
                        branch: branch || 'gh-pages',
                        token,
                        contentPath,
                        proxyUrl: proxyUrl || (0,_proxy_http__WEBPACK_IMPORTED_MODULE_4__.getProxyUrl)(),
                        onProgress: log,
                    });
                    log(`\nComplete: ${result.updated}/${result.total} files updated.`);
                    if (result.updated > 0) {
                        log('Refresh the page to see updated files in the file browser.');
                    }
                }
                catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    log(`\nERROR: ${errMsg}`);
                }
                await new Promise(r => setTimeout(r, 300));
                _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.flush();
                const finalNode = document.createElement('pre');
                finalNode.classList.add('jl-deploy-status');
                finalNode.textContent = (_b = statusNode.textContent) !== null && _b !== void 0 ? _b : '';
                await (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                    title: 'Sync Result',
                    body: new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node: finalNode }),
                    buttons: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton({ label: 'Close' })],
                });
            },
        });
        // Login command (standalone OAuth flow)
        app.commands.addCommand(CMD_LOGIN, {
            label: 'Wiki3.ai Sync: Login with GitHub',
            caption: 'Authenticate with GitHub using the OAuth Device Flow',
            execute: async () => {
                const proxyUrl = localStorage.getItem('jl-deploy-proxy') || (0,_proxy_http__WEBPACK_IMPORTED_MODULE_4__.getProxyUrl)() || '';
                if (!proxyUrl) {
                    // Ask for proxy URL first if none is configured
                    const node = document.createElement('div');
                    node.innerHTML = `
            <label for="jl-login-proxy">CORS Proxy URL</label>
            <input id="jl-login-proxy" type="text"
                   placeholder="https://your-worker.workers.dev" />
          `;
                    const result = await (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                        title: 'GitHub OAuth Login',
                        body: new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node }),
                        buttons: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.cancelButton(), _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton({ label: 'Continue' })],
                    });
                    if (!result.button.accept) {
                        return;
                    }
                    const proxy = node.querySelector('#jl-login-proxy').value.trim();
                    if (!proxy) {
                        return;
                    }
                    localStorage.setItem('jl-deploy-proxy', proxy);
                    // Now launch OAuth with the proxy
                    const dummyInput = document.createElement('input');
                    dummyInput.type = 'hidden';
                    await doOAuthLogin(proxy, dummyInput);
                    if (dummyInput.value) {
                        sessionStorage.setItem('jl-deploy-token', dummyInput.value);
                        console.log('jupyterlite-deploy: OAuth login successful');
                    }
                    return;
                }
                // Proxy is already configured — go straight to OAuth
                const dummyInput = document.createElement('input');
                dummyInput.type = 'hidden';
                await doOAuthLogin(proxyUrl, dummyInput);
                if (dummyInput.value) {
                    sessionStorage.setItem('jl-deploy-token', dummyInput.value);
                    console.log('jupyterlite-deploy: OAuth login successful');
                }
            },
        });
        // Add all commands to the command palette
        if (palette) {
            palette.addItem({ command: CMD_DEPLOY, category: 'Wiki3.ai Sync' });
            palette.addItem({ command: CMD_SYNC, category: 'Wiki3.ai Sync' });
            palette.addItem({ command: CMD_LOGIN, category: 'Wiki3.ai Sync' });
        }
        console.log('jupyterlite-deploy: commands registered', CMD_DEPLOY, CMD_SYNC, CMD_LOGIN);
    },
};
/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (plugin);
/**
 * Build the sync configuration dialog body.
 */
function createSyncDialogBody() {
    var _a, _b, _c;
    const body = document.createElement('div');
    body.classList.add('jl-deploy-dialog');
    body.innerHTML = `
    <label for="jl-sync-proxy">CORS Proxy URL</label>
    <input id="jl-sync-proxy" type="text"
           placeholder="https://your-worker.workers.dev"
           value="${(_a = localStorage.getItem('jl-deploy-proxy')) !== null && _a !== void 0 ? _a : ''}" />

    <label for="jl-sync-repo">Repository URL</label>
    <input id="jl-sync-repo" type="text"
           placeholder="https://github.com/user/repo.git"
           value="${(_b = localStorage.getItem('jl-deploy-repo')) !== null && _b !== void 0 ? _b : ''}" />

    <label for="jl-sync-branch">Branch</label>
    <input id="jl-sync-branch" type="text"
           value="${localStorage.getItem('jl-sync-branch') || 'gh-pages'}" />

    <label for="jl-sync-token">GitHub Token (optional for public repos)</label>
    <div style="display: flex; gap: 4px; align-items: center;">
      <input id="jl-sync-token" type="password" style="flex: 1;"
             placeholder="ghp_… (leave empty for public repos)"
             value="${(_c = sessionStorage.getItem('jl-deploy-token')) !== null && _c !== void 0 ? _c : ''}" />
      <button id="jl-sync-oauth-btn" type="button"
              style="white-space: nowrap; padding: 2px 8px;">Login with GitHub</button>
      <button id="jl-sync-clear-token" type="button"
              style="white-space: nowrap; padding: 2px 8px;">Clear</button>
    </div>
    <div style="margin-top: 4px;">
      <label style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.85em; cursor: pointer;">
        <input id="jl-sync-remember-token" type="checkbox"
               ${sessionStorage.getItem('jl-deploy-token') ? 'checked' : ''} />
        Remember token for this session
      </label>
    </div>

    <label for="jl-sync-path">Content subdirectory (optional)</label>
    <input id="jl-sync-path" type="text"
           placeholder="e.g. files (empty = sync all)"
           value="${localStorage.getItem('jl-sync-path') || 'files'}" />

    <p style="font-size: 0.85em; color: var(--jp-ui-font-color2); margin-top: 8px;">
      This will pull files from the repository and update your local
      JupyterLite file system, replacing any stale cached versions.
    </p>
  `;
    // Wire up buttons
    setTimeout(() => {
        const btn = body.querySelector('#jl-sync-oauth-btn');
        const clearBtn = body.querySelector('#jl-sync-clear-token');
        const tokenInput = body.querySelector('#jl-sync-token');
        const proxyInput = body.querySelector('#jl-sync-proxy');
        const rememberCb = body.querySelector('#jl-sync-remember-token');
        if (btn) {
            btn.addEventListener('click', () => {
                void doOAuthLogin(proxyInput.value.trim(), tokenInput);
            });
        }
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                tokenInput.value = '';
                rememberCb.checked = false;
                sessionStorage.removeItem('jl-deploy-token');
            });
        }
    }, 0);
    return body;
}


/***/ },

/***/ "./lib/memfs.js"
/*!**********************!*\
  !*** ./lib/memfs.js ***!
  \**********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   MemFS: () => (/* binding */ MemFS)
/* harmony export */ });
/**
 * Minimal in-memory filesystem implementing the interface required by
 * isomorphic-git (Node.js `fs.promises`-style API).
 *
 * No IndexedDB, no lightning-fs — everything lives in a Map for the duration
 * of the deploy operation and is discarded afterward.
 */
function normalize(p) {
    // Remove trailing slashes, collapse multiples, ensure leading /
    const parts = p.split('/').filter(Boolean);
    return '/' + parts.join('/');
}
function dirname(p) {
    const norm = normalize(p);
    const idx = norm.lastIndexOf('/');
    return idx <= 0 ? '/' : norm.slice(0, idx);
}
function makeStat(node, ino) {
    const isFile = node.type === 'file';
    return {
        type: node.type,
        mode: node.mode,
        size: node.content ? node.content.length : 0,
        ino,
        mtimeMs: node.mtimeMs,
        ctimeMs: node.mtimeMs,
        uid: 1,
        gid: 1,
        dev: 1,
        isFile: () => isFile,
        isDirectory: () => !isFile,
        isSymbolicLink: () => false,
    };
}
/**
 * An in-memory filesystem compatible with isomorphic-git's `fs` parameter.
 *
 * Usage:
 * ```ts
 * const fs = new MemFS();
 * await git.init({ fs, dir: '/' });
 * ```
 */
class MemFS {
    constructor() {
        this._nodes = new Map();
        this._nextIno = 1;
        this._nodes.set('/', {
            type: 'dir',
            mode: 0o755,
            mtimeMs: Date.now(),
        });
        // Bind all fs methods as own properties so isomorphic-git can find them
        this.readFile = this._readFile.bind(this);
        this.writeFile = this._writeFile.bind(this);
        this.unlink = this._unlink.bind(this);
        this.readdir = this._readdir.bind(this);
        this.mkdir = this._mkdir.bind(this);
        this.rmdir = this._rmdir.bind(this);
        this.stat = this._stat.bind(this);
        this.lstat = this._stat.bind(this); // no symlinks
        this.readlink = this._readlink.bind(this);
        this.symlink = this._symlink.bind(this);
        this.chmod = this._chmod.bind(this);
    }
    /** Legacy getter kept for backwards compat with our own code. */
    get promises() {
        return {
            readFile: this.readFile,
            writeFile: this.writeFile,
            unlink: this.unlink,
            readdir: this.readdir,
            mkdir: this.mkdir,
            rmdir: this.rmdir,
            stat: this.stat,
            lstat: this.lstat,
            readlink: this.readlink,
            symlink: this.symlink,
            chmod: this.chmod,
        };
    }
    // ── helpers ──────────────────────────────────────────────────────────
    _ensureParentDirs(p) {
        const parts = normalize(p).split('/').filter(Boolean);
        let cur = '';
        for (let i = 0; i < parts.length - 1; i++) {
            cur += '/' + parts[i];
            if (!this._nodes.has(cur)) {
                this._nodes.set(cur, {
                    type: 'dir',
                    mode: 0o755,
                    mtimeMs: Date.now(),
                });
            }
        }
    }
    // ── fs.promises implementations ─────────────────────────────────────
    async _readFile(filepath, opts) {
        var _a;
        const p = normalize(filepath);
        const node = this._nodes.get(p);
        if (!node || node.type !== 'file') {
            throw Object.assign(new Error(`ENOENT: no such file '${p}'`), {
                code: 'ENOENT',
            });
        }
        const data = (_a = node.content) !== null && _a !== void 0 ? _a : new Uint8Array(0);
        if ((opts === null || opts === void 0 ? void 0 : opts.encoding) === 'utf8') {
            return new TextDecoder().decode(data);
        }
        return data;
    }
    async _writeFile(filepath, data, opts) {
        var _a, _b;
        const p = normalize(filepath);
        this._ensureParentDirs(p);
        const content = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        const existing = this._nodes.get(p);
        this._nodes.set(p, {
            type: 'file',
            mode: (_b = (_a = opts === null || opts === void 0 ? void 0 : opts.mode) !== null && _a !== void 0 ? _a : existing === null || existing === void 0 ? void 0 : existing.mode) !== null && _b !== void 0 ? _b : 0o644,
            content,
            mtimeMs: Date.now(),
        });
    }
    async _unlink(filepath) {
        const p = normalize(filepath);
        if (!this._nodes.has(p)) {
            throw Object.assign(new Error(`ENOENT: '${p}'`), { code: 'ENOENT' });
        }
        this._nodes.delete(p);
    }
    async _readdir(filepath) {
        const p = normalize(filepath);
        const node = this._nodes.get(p);
        if (!node || node.type !== 'dir') {
            throw Object.assign(new Error(`ENOTDIR: '${p}'`), { code: 'ENOTDIR' });
        }
        const prefix = p === '/' ? '/' : p + '/';
        const entries = new Set();
        for (const key of this._nodes.keys()) {
            if (key === p)
                continue;
            if (key.startsWith(prefix)) {
                // direct child only
                const rest = key.slice(prefix.length);
                const name = rest.split('/')[0];
                if (name)
                    entries.add(name);
            }
        }
        return Array.from(entries);
    }
    async _mkdir(filepath, opts) {
        const p = normalize(filepath);
        if (opts === null || opts === void 0 ? void 0 : opts.recursive) {
            this._ensureParentDirs(p + '/placeholder');
            if (!this._nodes.has(p)) {
                this._nodes.set(p, {
                    type: 'dir',
                    mode: 0o755,
                    mtimeMs: Date.now(),
                });
            }
            return;
        }
        const parent = dirname(p);
        if (!this._nodes.has(parent)) {
            throw Object.assign(new Error(`ENOENT: '${parent}'`), {
                code: 'ENOENT',
            });
        }
        if (this._nodes.has(p)) {
            throw Object.assign(new Error(`EEXIST: '${p}'`), { code: 'EEXIST' });
        }
        this._nodes.set(p, { type: 'dir', mode: 0o755, mtimeMs: Date.now() });
    }
    async _rmdir(filepath) {
        const p = normalize(filepath);
        this._nodes.delete(p);
    }
    async _stat(filepath) {
        const p = normalize(filepath);
        const node = this._nodes.get(p);
        if (!node) {
            throw Object.assign(new Error(`ENOENT: '${p}'`), { code: 'ENOENT' });
        }
        return makeStat(node, this._nextIno++);
    }
    async _readlink(_filepath) {
        throw Object.assign(new Error('ENOSYS: readlink'), { code: 'ENOSYS' });
    }
    async _symlink(_target, _filepath) {
        throw Object.assign(new Error('ENOSYS: symlink'), { code: 'ENOSYS' });
    }
    async _chmod(filepath, mode) {
        const p = normalize(filepath);
        const node = this._nodes.get(p);
        if (!node) {
            throw Object.assign(new Error(`ENOENT: '${p}'`), { code: 'ENOENT' });
        }
        node.mode = mode;
    }
}


/***/ },

/***/ "./lib/oauth.js"
/*!**********************!*\
  !*** ./lib/oauth.js ***!
  \**********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   cacheToken: () => (/* binding */ cacheToken),
/* harmony export */   getCachedToken: () => (/* binding */ getCachedToken),
/* harmony export */   pollForToken: () => (/* binding */ pollForToken),
/* harmony export */   requestDeviceCode: () => (/* binding */ requestDeviceCode)
/* harmony export */ });
/**
 * GitHub OAuth Device Flow for browser-based authentication.
 *
 * The Device Flow doesn't require redirects, making it ideal for
 * static sites like JupyterLite on GitHub Pages.
 *
 * Flow:
 *   1. POST /oauth/device → get user_code + verification_uri
 *   2. User opens verification_uri, enters user_code
 *   3. Poll POST /oauth/token until access_token is returned
 *
 * The proxy worker handles communication with GitHub's OAuth endpoints
 * (which also have CORS restrictions).
 */
/**
 * Start the Device Flow: request a device code from the proxy.
 */
async function requestDeviceCode(config) {
    var _a;
    const resp = await fetch(`${config.proxyUrl}/oauth/device`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: (_a = config.scope) !== null && _a !== void 0 ? _a : 'public_repo' }),
    });
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Device code request failed (${resp.status}): ${body}`);
    }
    return resp.json();
}
/**
 * Poll for the access token. Returns when the user authorizes,
 * or throws on timeout/error.
 *
 * @param config - OAuth config
 * @param deviceCode - The device_code from requestDeviceCode
 * @param interval - Polling interval in seconds (from the device code response)
 * @param expiresIn - Expiration in seconds (from the device code response)
 * @param onProgress - Optional callback for status updates
 * @param signal - Optional AbortSignal to cancel polling
 */
async function pollForToken(config, deviceCode, interval, expiresIn, onProgress, signal) {
    var _a;
    const deadline = Date.now() + expiresIn * 1000;
    let pollInterval = Math.max(interval, 5) * 1000; // at least 5s
    while (Date.now() < deadline) {
        if (signal === null || signal === void 0 ? void 0 : signal.aborted) {
            throw new Error('OAuth flow cancelled');
        }
        await sleep(pollInterval);
        const resp = await fetch(`${config.proxyUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_code: deviceCode }),
        });
        const data = await resp.json();
        if (data.access_token) {
            return data;
        }
        if (data.error === 'authorization_pending') {
            onProgress === null || onProgress === void 0 ? void 0 : onProgress('Waiting for authorization…');
            continue;
        }
        if (data.error === 'slow_down') {
            // GitHub asked us to slow down — add 5s
            pollInterval += 5000;
            onProgress === null || onProgress === void 0 ? void 0 : onProgress('Slowing down polling…');
            continue;
        }
        if (data.error === 'expired_token') {
            throw new Error('Device code expired. Please try again.');
        }
        if (data.error === 'access_denied') {
            throw new Error('Authorization was denied by the user.');
        }
        if (data.error) {
            throw new Error(`OAuth error: ${data.error} — ${(_a = data.error_description) !== null && _a !== void 0 ? _a : ''}`);
        }
    }
    throw new Error('Device code expired (timeout). Please try again.');
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * Get a cached token from sessionStorage, or null.
 */
function getCachedToken() {
    if (typeof sessionStorage !== 'undefined') {
        return sessionStorage.getItem('jl-deploy-token') || null;
    }
    return null;
}
/**
 * Cache a token in sessionStorage (cleared when tab closes).
 */
function cacheToken(token) {
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('jl-deploy-token', token);
    }
}


/***/ },

/***/ "./lib/proxy-http.js"
/*!***************************!*\
  !*** ./lib/proxy-http.js ***!
  \***************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getProxyUrl: () => (/* binding */ getProxyUrl),
/* harmony export */   makeProxyHttp: () => (/* binding */ makeProxyHttp)
/* harmony export */ });
/* harmony import */ var isomorphic_git_http_web__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! isomorphic-git/http/web */ "./node_modules/isomorphic-git/http/web/index.js");
/**
 * CORS-proxy-aware HTTP client for isomorphic-git.
 *
 * Wraps the standard isomorphic-git/http/web module to route
 * requests through a Cloudflare Worker proxy, avoiding browser
 * CORS restrictions when talking to github.com.
 *
 * Usage:
 *   import { makeProxyHttp } from './proxy-http';
 *   const http = makeProxyHttp('https://my-worker.workers.dev');
 *   await git.clone({ fs, http, ... });
 */

/**
 * Create an isomorphic-git compatible HTTP client that routes
 * github.com requests through the CORS proxy.
 *
 * @param proxyBaseUrl - The base URL of the proxy worker,
 *                       e.g. "https://wiki3-ai-sync-proxy.you.workers.dev"
 *                       If empty/null, requests go directly (for testing).
 */
function makeProxyHttp(proxyBaseUrl) {
    return {
        async request(config) {
            let { url } = config;
            // Rewrite github.com URLs to go through the proxy
            if (proxyBaseUrl && url.startsWith('https://github.com/')) {
                const path = url.slice('https://github.com/'.length);
                url = `${proxyBaseUrl.replace(/\/+$/, '')}/proxy/${path}`;
            }
            return isomorphic_git_http_web__WEBPACK_IMPORTED_MODULE_0__["default"].request({ ...config, url });
        },
    };
}
/**
 * The default proxy URL. Override via localStorage or env.
 * Users can set `localStorage.setItem('jl-deploy-proxy', 'https://...')`
 * to use a custom proxy.
 */
function getProxyUrl() {
    if (typeof localStorage !== 'undefined') {
        const custom = localStorage.getItem('jl-deploy-proxy');
        if (custom)
            return custom;
    }
    // Default — users must deploy their own worker and set this
    return '';
}


/***/ },

/***/ "./node_modules/isomorphic-git/http/web/index.js"
/*!*******************************************************!*\
  !*** ./node_modules/isomorphic-git/http/web/index.js ***!
  \*******************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   "default": () => (__WEBPACK_DEFAULT_EXPORT__),
/* harmony export */   request: () => (/* binding */ request)
/* harmony export */ });
/**
 * @typedef {Object} GitProgressEvent
 * @property {string} phase
 * @property {number} loaded
 * @property {number} total
 */

/**
 * @callback ProgressCallback
 * @param {GitProgressEvent} progress
 * @returns {void | Promise<void>}
 */

/**
 * @typedef {Object} GitHttpRequest
 * @property {string} url - The URL to request
 * @property {string} [method='GET'] - The HTTP method to use
 * @property {Object<string, string>} [headers={}] - Headers to include in the HTTP request
 * @property {Object} [agent] - An HTTP or HTTPS agent that manages connections for the HTTP client (Node.js only)
 * @property {AsyncIterableIterator<Uint8Array>} [body] - An async iterator of Uint8Arrays that make up the body of POST requests
 * @property {ProgressCallback} [onProgress] - Reserved for future use (emitting `GitProgressEvent`s)
 * @property {object} [signal] - Reserved for future use (canceling a request)
 */

/**
 * @typedef {Object} GitHttpResponse
 * @property {string} url - The final URL that was fetched after any redirects
 * @property {string} [method] - The HTTP method that was used
 * @property {Object<string, string>} [headers] - HTTP response headers
 * @property {AsyncIterableIterator<Uint8Array>} [body] - An async iterator of Uint8Arrays that make up the body of the response
 * @property {number} statusCode - The HTTP status code
 * @property {string} statusMessage - The HTTP status message
 */

/**
 * @callback HttpFetch
 * @param {GitHttpRequest} request
 * @returns {Promise<GitHttpResponse>}
 */

/**
 * @typedef {Object} HttpClient
 * @property {HttpFetch} request
 */

// Convert a value to an Async Iterator
// This will be easier with async generator functions.
function fromValue(value) {
  let queue = [value];
  return {
    next() {
      return Promise.resolve({ done: queue.length === 0, value: queue.pop() })
    },
    return() {
      queue = [];
      return {}
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

function getIterator(iterable) {
  if (iterable[Symbol.asyncIterator]) {
    return iterable[Symbol.asyncIterator]()
  }
  if (iterable[Symbol.iterator]) {
    return iterable[Symbol.iterator]()
  }
  if (iterable.next) {
    return iterable
  }
  return fromValue(iterable)
}

// Currently 'for await' upsets my linters.
async function forAwait(iterable, cb) {
  const iter = getIterator(iterable);
  while (true) {
    const { value, done } = await iter.next();
    if (value) await cb(value);
    if (done) break
  }
  if (iter.return) iter.return();
}

async function collect(iterable) {
  let size = 0;
  const buffers = [];
  // This will be easier once `for await ... of` loops are available.
  await forAwait(iterable, value => {
    buffers.push(value);
    size += value.byteLength;
  });
  const result = new Uint8Array(size);
  let nextIndex = 0;
  for (const buffer of buffers) {
    result.set(buffer, nextIndex);
    nextIndex += buffer.byteLength;
  }
  return result
}

// Convert a web ReadableStream (not Node stream!) to an Async Iterator
// adapted from https://jakearchibald.com/2017/async-iterators-and-generators/
function fromStream(stream) {
  // Use native async iteration if it's available.
  if (stream[Symbol.asyncIterator]) return stream
  const reader = stream.getReader();
  return {
    next() {
      return reader.read()
    },
    return() {
      reader.releaseLock();
      return {}
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

/* eslint-env browser */

/**
 * HttpClient
 *
 * @param {GitHttpRequest} request
 * @returns {Promise<GitHttpResponse>}
 */
async function request({
  onProgress,
  url,
  method = 'GET',
  headers = {},
  body,
}) {
  // streaming uploads aren't possible yet in the browser
  if (body) {
    body = await collect(body);
  }
  const res = await fetch(url, { method, headers, body });
  const iter =
    res.body && res.body.getReader
      ? fromStream(res.body)
      : [new Uint8Array(await res.arrayBuffer())];
  // convert Header object to ordinary JSON
  headers = {};
  for (const [key, value] of res.headers.entries()) {
    headers[key] = value;
  }
  return {
    url: res.url,
    method: res.method,
    statusCode: res.status,
    statusMessage: res.statusText,
    body: iter,
    headers,
  }
}

var index = { request };

/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (index);



/***/ }

}]);
//# sourceMappingURL=lib_index_js.b13a8d82fc540cf8c5ce.js.map
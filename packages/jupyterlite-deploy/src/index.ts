/**
 * jupyterlite-deploy — JupyterLab/JupyterLite extension
 *
 * Adds a "Deploy to GitHub Pages" command that uses isomorphic-git
 * to push files from the Contents API to a gh-pages branch.
 */

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from '@jupyterlab/application';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { Widget } from '@lumino/widgets';
import { deployToGitHub, collectContentsFiles, IFileEntry } from './deploy';

/** Command ID */
const CMD_DEPLOY = 'deploy:gh-pages';

/**
 * Build the deploy configuration dialog body.
 */
function createDeployDialogBody(): HTMLElement {
  const body = document.createElement('div');
  body.classList.add('jl-deploy-dialog');
  body.innerHTML = `
    <label for="jl-deploy-repo">Repository URL</label>
    <input id="jl-deploy-repo" type="text"
           placeholder="https://github.com/user/repo.git"
           value="${localStorage.getItem('jl-deploy-repo') ?? ''}" />

    <label for="jl-deploy-branch">Branch</label>
    <input id="jl-deploy-branch" type="text"
           value="${localStorage.getItem('jl-deploy-branch') || 'gh-pages'}" />

    <label for="jl-deploy-token">GitHub Token</label>
    <input id="jl-deploy-token" type="password"
           placeholder="ghp_…"
           value="${sessionStorage.getItem('jl-deploy-token') ?? ''}" />

    <label for="jl-deploy-author">Author</label>
    <input id="jl-deploy-author" type="text"
           placeholder="Deploy Bot <deploy@example.com>"
           value="${localStorage.getItem('jl-deploy-author') || 'Deploy Bot <deploy@example.com>'}" />

    <label for="jl-deploy-message">Commit message</label>
    <input id="jl-deploy-message" type="text"
           value="Deploy JupyterLite site" />
  `;
  return body;
}

/**
 * Parse "Name <email>" into { name, email }.
 */
function parseAuthor(raw: string): { name: string; email: string } {
  const m = raw.match(/^(.+?)\s*<(.+?)>\s*$/);
  if (m) {
    return { name: m[1].trim(), email: m[2].trim() };
  }
  return { name: raw.trim() || 'Deploy', email: 'deploy@example.com' };
}

/**
 * Extension activation.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlite-deploy:plugin',
  description: 'Deploy JupyterLite sites to GitHub Pages using isomorphic-git',
  autoStart: true,
  activate: (app: JupyterFrontEnd) => {
    console.log('jupyterlite-deploy: activated');

    app.commands.addCommand(CMD_DEPLOY, {
      label: 'Deploy to GitHub Pages',
      caption: 'Push site contents to a gh-pages branch via isomorphic-git',
      execute: async () => {
        // ── 1. Show config dialog ────────────────────────────────────
        const body = createDeployDialogBody();
        const dialogResult = await showDialog({
          title: 'Deploy to GitHub Pages',
          body: new Widget({ node: body }),
          buttons: [
            Dialog.cancelButton(),
            Dialog.okButton({ label: 'Deploy' }),
          ],
        });

        if (!dialogResult.button.accept) {
          return;
        }

        const repoUrl = (
          body.querySelector('#jl-deploy-repo') as HTMLInputElement
        ).value.trim();
        const branch = (
          body.querySelector('#jl-deploy-branch') as HTMLInputElement
        ).value.trim();
        const token = (
          body.querySelector('#jl-deploy-token') as HTMLInputElement
        ).value.trim();
        const authorRaw = (
          body.querySelector('#jl-deploy-author') as HTMLInputElement
        ).value.trim();
        const message = (
          body.querySelector('#jl-deploy-message') as HTMLInputElement
        ).value.trim();

        if (!repoUrl || !token) {
          void showDialog({
            title: 'Deploy Error',
            body: 'Repository URL and GitHub Token are required.',
            buttons: [Dialog.okButton()],
          });
          return;
        }

        // Persist non-secret settings for convenience
        localStorage.setItem('jl-deploy-repo', repoUrl);
        localStorage.setItem('jl-deploy-branch', branch);
        localStorage.setItem('jl-deploy-author', authorRaw);
        // Token goes to sessionStorage (cleared when tab closes)
        sessionStorage.setItem('jl-deploy-token', token);

        const { name: authorName, email: authorEmail } =
          parseAuthor(authorRaw);

        // ── 2. Collect files ──────────────────────────────────────────
        const statusNode = document.createElement('pre');
        statusNode.classList.add('jl-deploy-status');
        statusNode.textContent = 'Collecting files…\n';
        const statusWidget = new Widget({ node: statusNode });

        void showDialog({
          title: 'Deploying…',
          body: statusWidget,
          buttons: [], // no user buttons while deploying
        });

        const log = (msg: string) => {
          statusNode.textContent += msg + '\n';
          statusNode.scrollTop = statusNode.scrollHeight;
        };

        try {
          log('Reading files from Contents API…');
          const files: IFileEntry[] = await collectContentsFiles(
            app.serviceManager.contents
          );
          log(`Collected ${files.length} file(s).`);

          // ── 3. Deploy ────────────────────────────────────────────────
          await deployToGitHub(files, {
            repoUrl,
            branch: branch || 'gh-pages',
            token,
            message: message || 'Deploy JupyterLite site',
            authorName,
            authorEmail,
            onProgress: log,
          });

          log('\nDone!');
        } catch (err: unknown) {
          const errMsg =
            err instanceof Error ? err.message : String(err);
          log(`\nERROR: ${errMsg}`);
        }

        // Replace the modeless progress dialog with a closeable one
        // (the Dialog promise resolves when dismissed by code below)
        // We wait a beat so the user can read the final status.
        await new Promise(r => setTimeout(r, 300));
        // Close the progress dialog by resolving it
        Dialog.flush();

        // Show final status
        const finalNode = document.createElement('pre');
        finalNode.classList.add('jl-deploy-status');
        finalNode.textContent = statusNode.textContent ?? '';
        await showDialog({
          title: 'Deploy Result',
          body: new Widget({ node: finalNode }),
          buttons: [Dialog.okButton({ label: 'Close' })],
        });
      },
    });

    // Add to the command palette if present
    const palette = (app as any).commands;
    if (palette) {
      console.log('jupyterlite-deploy: command registered as', CMD_DEPLOY);
    }
  },
};

export default plugin;

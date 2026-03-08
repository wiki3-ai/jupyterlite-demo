# jupyterlite-deploy

Deploy JupyterLite sites to GitHub Pages directly from the browser using
[isomorphic-git](https://github.com/isomorphic-git/isomorphic-git).

This JupyterLab/JupyterLite extension adds a **Deploy to GitHub Pages** command
that uses isomorphic-git with an in-memory filesystem to commit and force-push
site contents to a `gh-pages` branch — no server-side git required.

## Features

- Pure browser-based git push (no CLI, no server)
- In-memory filesystem (no lightning-fs / IndexedDB dependency)
- Collects files via JupyterLite Contents API
- Force-pushes to `gh-pages` branch, replacing all prior content
- Configurable repo URL, branch, author, and commit message

## Install

```bash
pip install jupyterlite-deploy
```

Or for development:

```bash
cd packages/jupyterlite-deploy
pip install -e ".[dev]"
jlpm install
jlpm build
```

## Usage

In JupyterLab or JupyterLite, open the command palette (`Ctrl+Shift+C`) and run:

> **Deploy to GitHub Pages**

You'll be prompted for:
- **Repository URL** — e.g. `https://github.com/user/repo.git`
- **Branch** — defaults to `gh-pages`
- **GitHub Token** — a Personal Access Token with `repo` scope

## Requirements

- JupyterLab >= 4.0.0 or JupyterLite >= 0.2.0

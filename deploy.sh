#!/usr/bin/env bash
set -euo pipefail

BRANCH="gh-pages"
REMOTE="origin"
OUTPUT_DIR="_output"
MESSAGE="${1:-Deploy JupyterLite site}"

if [ ! -d "$OUTPUT_DIR" ]; then
    echo "Error: $OUTPUT_DIR not found. Run 'jupyter lite build' first."
    exit 1
fi

# Get the remote URL from the current repo
REMOTE_URL=$(git remote get-url "$REMOTE")
echo "Deploying $OUTPUT_DIR → $REMOTE_URL ($BRANCH)"

# Create a temporary directory for the git operations
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Init a fresh repo in the temp dir
git init "$WORK"
cd "$WORK"
git checkout --orphan "$BRANCH"

# Copy the build output
cp -a "$OLDPWD/$OUTPUT_DIR/." .

# Add .nojekyll so GitHub Pages serves files as-is
touch .nojekyll

# Commit everything
git add -A
git commit -m "$MESSAGE"

# Push (force to replace whatever is on gh-pages)
git remote add "$REMOTE" "$REMOTE_URL"
git push --force "$REMOTE" "$BRANCH"

echo "Done! Site deployed to $BRANCH."

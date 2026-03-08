"""JupyterLite extension: Deploy to GitHub Pages using isomorphic-git."""

try:
    from ._version import __version__
except ImportError:
    # Fallback when _version.py hasn't been generated yet
    __version__ = "dev"

FROM python:3.11-slim

# Create a non-root user for development
RUN useradd --create-home --shell /bin/bash vscode

WORKDIR /workspace

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy pyproject.toml to pre-install dependencies for better layer caching
COPY pyproject.toml ./
RUN pip install --no-cache-dir .

USER vscode

FROM mcr.microsoft.com/devcontainers/python:3.12-trixie
RUN apt-get update && apt-get install -y --no-install-recommends \
        pandoc nodejs npm \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code
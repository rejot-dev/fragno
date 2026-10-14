# The "workspace" sandbox image. Both the Backoffice Worker and this bridge start it from their
# Sandbox Durable Object through ctx.container.start(), so keep it free of either Worker's code.
FROM node:24-trixie-slim

# Tooling for agent use. The Debian base already provides sh, coreutils, tar, and sed.
# The shared Node supervisor bounds command execution and output, independent of the image.
# git        - version control
# curl/wget  - HTTP fetching
# ripgrep    - preferred by agent prompts for text/file search (rg, rg --files)
# jq         - JSON processing
# procps     - process management (ps, pkill, kill)
# gawk       - text processing
# python3    - Python 3.13, exposed as both python3 and python
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    curl \
    wget \
    ripgrep \
    jq \
    procps \
    gawk \
    python3 \
    python3-venv \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

RUN mkdir -p /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]

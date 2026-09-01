# Runs the NanoClaw host process INSIDE the Docker VM.
#
# Why this exists: on Docker Desktop for macOS a host process on the Mac is
# reached by containers through the port-forwarder, which rewrites the source
# address to 127.0.0.1 — so `lookupContainerIP` cannot identify the caller and
# both host-rpc and the credential proxy reject every container. Run the same
# process inside the VM and the container's real bridge IP survives (verified:
# a listener on 172.29.0.1 saw PEER=172.29.0.2).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git openssh-client procps iproute2 \
      python3 make g++ \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/*

# Match the repo's pinned pnpm.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# No PNPM_HOME: setting it makes pnpm enforce that its global bin dir is on
# PATH, which a login shell would then wipe. The host only shells out to
# `docker` by name (CONTAINER_RUNTIME_BIN = 'docker'), already on PATH.

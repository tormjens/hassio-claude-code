# syntax=docker/dockerfile:1
#
# Claude for Home Assistant add-on image.
#
# Three stages: build the Vue UI, compile the TypeScript server, then assemble
# the runtime image on top of the official Home Assistant Alpine base image.
# The build stages run on the build host's own platform so cross-builds for
# aarch64 do not have to emulate npm and tsc under QEMU.

ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24

# ---------------------------------------------------------------------------
# UI build
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-alpine AS ui-build
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Server build (TypeScript -> JavaScript). Optional native CLI binaries are
# skipped here; the runtime stage installs the one matching the target arch.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-alpine AS server-build
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund --omit=optional
COPY server/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM ${BUILD_FROM}

# Node 22+ (Alpine 3.24 ships Node 24), git for config checkpoints, and the
# runtime libraries the Claude Code native binary needs on musl.
RUN apk add --no-cache \
        nodejs \
        npm \
        git \
        ripgrep \
        libgcc \
        libstdc++ \
    && git config --system safe.directory '*' \
    && git config --system init.defaultBranch main

ENV \
    # Use the distro ripgrep; the bundled one is a glibc build.
    USE_BUILTIN_RIPGREP=0 \
    # Keep Claude Code's own state on the persistent /data volume.
    CLAUDE_CONFIG_DIR=/data/claude \
    HOME=/data/home \
    NODE_ENV=production \
    CLAUDE_HA_PORT=8099

WORKDIR /opt/claude-ha

# Install runtime dependencies for the *target* platform. npm picks the
# matching @anthropic-ai/claude-agent-sdk-linux-<arch>-musl binary here.
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund --omit=dev \
    && npm cache clean --force

COPY --from=server-build /build/server/dist ./dist
COPY --from=ui-build /build/ui/dist ./public
COPY rootfs /

# Home Assistant add-on labels. io.hass.version/arch are set by the builder.
ARG BUILD_ARCH
ARG BUILD_VERSION
LABEL \
    io.hass.name="Claude for Home Assistant" \
    io.hass.description="Chat with Claude to read, edit and validate your Home Assistant configuration" \
    io.hass.type="app" \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.title="Claude for Home Assistant" \
    org.opencontainers.image.description="Claude Code chat UI inside Home Assistant" \
    org.opencontainers.image.source="https://github.com/tormjens/hassio-claude-code" \
    org.opencontainers.image.licenses="MIT"

EXPOSE 8099

# Headless hub-builder for Video Hub App.
#
# Runs `node/headless-import.ts` (see that file for the full environment
# variable contract) to scan a media folder and produce a `.vha2` hub +
# thumbnails/filmstrips/clips, without Electron/Chromium/Angular.
#
# This is NOT the desktop app and NOT the remote-control web server
# (node/server.ts, port 3000/8080) - both of those still require the full
# desktop GUI. See docs/headless-import-truenas.md.
#
# Build:
#   docker build -f Containerfile -t vha-headless-import .
# Run:
#   docker run --rm \
#     -e VHA_SOURCE_DIRS=/media \
#     -e VHA_OUTPUT_DIR=/output \
#     -e VHA_HUB_NAME=my-hub \
#     -v /path/to/media:/media \
#     -v /path/to/output:/output \
#     vha-headless-import

FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: skip the root `postinstall` (electron-builder install-app-deps),
# which is Electron-specific and not relevant/available in this build.
# --legacy-peer-deps: the full devDependency tree has an unrelated pre-existing
# peer conflict (ng-qrcode wants a newer @angular/common than the rest of the
# project pins) that a clean `npm ci` refuses to resolve on its own; none of it
# is used by headless-import.ts, so tolerate it rather than touching the
# project's actual dependency versions.
RUN npm ci --ignore-scripts --legacy-peer-deps

COPY tsconfig-serve.json ./
COPY node ./node
COPY interfaces ./interfaces

RUN npx tsc -p tsconfig-serve.json

# ===========================================================================

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
# Production dependencies only - electron, electron-builder, Angular, etc. are
# all devDependencies and are never installed here.
#
# `npm rebuild ffmpeg-static` re-runs its postinstall, which downloads the
# actual platform ffmpeg binary (ffmpeg-static's own npm package has no binary
# until that script runs). A bare `npm rebuild` with no package name would
# also re-run the *root* project's own postinstall (electron-builder, not
# installed here) and fail, so it's scoped to just this one package.
#
# @ffprobe-installer/ffprobe is different: the binary is already bundled in
# its platform-specific optional dependency's (e.g. linux-x64/linux-arm64)
# npm tarball - `npm ci --ignore-scripts` already placed it, it's just not
# marked executable yet (that's normally the *platform* package's own
# postinstall, not the `@ffprobe-installer/ffprobe` wrapper's, so naming the
# wrapper in `npm rebuild` doesn't reach it) - so just chmod it directly
# instead of fighting npm's script-targeting.
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps \
 && npm rebuild ffmpeg-static \
 && find node_modules/@ffprobe-installer -type f -name ffprobe -exec chmod +x {} \; \
 && npm cache clean --force

COPY --from=builder /app/node ./node
COPY --from=builder /app/interfaces ./interfaces

ENTRYPOINT ["node", "node/headless-import.js"]

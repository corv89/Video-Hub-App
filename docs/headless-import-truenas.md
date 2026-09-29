# Headless hub building on TrueNAS SCALE 25.10

This covers `Containerfile` / `node/headless-import.ts`: a container that scans a
media folder and builds/updates a `.vha2` hub (thumbnails, filmstrips, and
optionally preview clips) without any GUI. It exists so the scan - which reads
every byte of every video via ffmpeg - can run directly on the NAS where the
media lives, instead of over a network mount from another machine.

**This is not the desktop app, and not the remote-control web server**
(`node/server.ts`, port 3000/8080). Both of those still require the full
Electron/Angular desktop app to be running somewhere with a display. Once this
container has produced a `.vha2` hub + thumbnails on TrueNAS storage, open
that hub from the desktop app as usual (e.g. over an SMB/NFS mount) to
actually browse/search it.

## 1. Build and push the image

TrueNAS SCALE 25.10's container support ("Instances") doesn't build from a
Dockerfile itself - you build the image elsewhere and point TrueNAS at a
registry reference. Build it on your Fedora or Ubuntu VM (or anywhere with
Docker/Podman and network access to a registry TrueNAS can reach):

```bash
git clone https://github.com/whyboris/Video-Hub-App.git
cd Video-Hub-App
git checkout feature/headless-import-container   # or main, once merged

docker build -f Containerfile -t <your-registry>/vha-headless-import:latest .
docker push <your-registry>/vha-headless-import:latest
```

(`<your-registry>` can be Docker Hub, GHCR, or a local registry reachable
from the TrueNAS VM - whatever you already use.)

## 2. Set it up in TrueNAS

*Instances → Add Instance → Browse Catalog*, and enter the image reference you
pushed above.

**Disks** - add one entry per path this container needs:
- Each source media dataset, **read-write** (the scan needs at least read
  access; see the note on this below), destination e.g. `/media/movies`
- One output dataset for the generated hub, destination e.g. `/output`

**Environment variables** (see `node/headless-import.ts` for the full list -
these are the required ones plus the common optional ones):

| Variable | Example | Notes |
|---|---|---|
| `VHA_SOURCE_DIRS` | `/media/movies:/media/shows` | `:`-separated, one or more |
| `VHA_OUTPUT_DIR` | `/output` | where `<hubName>.vha2` + `vha-<hubName>/` are written |
| `VHA_HUB_NAME` | `my-hub` | |
| `VHA_SCREENSHOT_HEIGHT` | `288` | one of 144/216/288/360/432/504 |
| `VHA_SCREENSHOTS_N` | `10` | screenshots per video (with default `VHA_SCREENSHOTS_FIXED=true`) |
| `VHA_CLIP_SNIPPETS` | `0` | 0 = skip preview-clip generation (slower if enabled) |

**Proxies** - none needed. This container doesn't listen on any port; it runs
the scan and exits.

## 3. Running it

The container runs the scan to completion, writes/updates the `.vha2` file,
and exits (0 on success). Re-run it whenever you add new videos to the source
folders - already-extracted files are detected by content hash and skipped,
so re-runs are cheap. On TrueNAS you can just re-run the Instance manually, or
set up a periodic Cron Job/Init/Shutdown Script that starts it on a schedule.

If the container is stopped mid-scan (`docker stop` / Instance stop sends
`SIGTERM`), it writes whatever it has extracted so far before exiting, rather
than losing that work.

## 4. Known limitation

The scan pipeline (reused as-is from the desktop app) checks each source
folder with a **read-write** access check before scanning it - a pre-existing
upstream quirk, not something specific to this container. Mount source
datasets read-write, even though the scan itself never modifies them.

## 5. Opening the resulting hub elsewhere (path portability)

Each video's location is stored as a per-source-folder base path
(`inputDirs`) plus a path *relative* to that base path on the individual
video entry. Thumbnails are keyed by content hash, not path, so they're
unaffected by any of this.

If you open the resulting hub later from a different machine where the same
TrueNAS dataset is mounted at a different absolute path (e.g. an SMB mount
at `/Volumes/TrueNAS/movies` on a Mac, vs. `/media/movies` inside this
container), VHA will show that source folder as disconnected on open - this
is the same handling as a USB drive remounting at a different path. Use the
existing **"reconnect this folder"** action (pick the new mount location
once) and everything resolves correctly again, since only the base path
changes and the relative structure underneath is identical.

To avoid that one-time step entirely, mount the share at the *same* absolute
path on whatever machine you'll open the hub from as you used for
`VHA_SOURCE_DIRS` in the container (e.g. always `/media/movies`, via
`/etc/fstab` or equivalent) - then the stored path matches exactly and no
reconnect is needed.

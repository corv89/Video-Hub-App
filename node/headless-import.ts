/**
 * Headless "build/update the hub" CLI.
 *
 * Runs the same scan + metadata + thumbnail/filmstrip/clip extraction pipeline
 * the desktop app's import wizard uses, without Electron or Angular, so it can
 * run inside a container on a NAS where the media actually lives. Writes a
 * `.vha2` hub file that can then be opened in the desktop app as normal.
 *
 * Not the remote-control server (`node/server.ts`) - that still requires the
 * desktop app to be running.
 *
 * Config is read from environment variables:
 *   VHA_SOURCE_DIRS          (required) `:`-separated absolute paths to scan
 *   VHA_OUTPUT_DIR           (required) where `<hubName>.vha2` + `vha-<hubName>/` go
 *   VHA_HUB_NAME             (required)
 *   VHA_SCREENSHOT_HEIGHT    (default 288)  one of 144/216/288/360/432/504
 *   VHA_SCREENSHOTS_FIXED    (default true) true = N screenshots/video, false = 1 per N minutes
 *   VHA_SCREENSHOTS_N        (default 10)
 *   VHA_CLIP_HEIGHT          (default 144)  one of 144/216/288/360/432/504
 *   VHA_CLIP_SNIPPETS        (default 0)    0 = do not extract preview clips
 *   VHA_CLIP_SNIPPET_LENGTH  (default 1)
 *   VHA_ADDITIONAL_EXTENSIONS (optional, comma-separated)
 *   VHA_DEBUG                (optional, true = log raw ffmpeg/ffprobe output)
 *
 * Re-running against the same VHA_OUTPUT_DIR/VHA_HUB_NAME is safe and cheap:
 * already-extracted files are detected (by content hash) and skipped.
 */

import * as path from 'path';
const fs = require('fs');

import { GLOBALS } from './main-globals';
import { writeVhaFileToDisk, upgradeToVersion3, parseAdditionalExtensions } from './main-support';
import { resetWatchers, startFileSystemWatching, queuesAreIdle } from './main-extract-async';

import type {
  AllowedScreenshotHeight,
  FinalObject,
  ImageElement,
  InputSources,
  ScreenshotSettings,
} from '../interfaces/final-object.interface';

const ALLOWED_SCREENSHOT_HEIGHTS: AllowedScreenshotHeight[] = [144, 216, 288, 360, 432, 504];

/**
 * Log an error and exit. Typed `never` so callers narrow correctly afterward.
 */
function fail(message: string): never {
  console.error('[headless-import] ERROR: ' + message);
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    fail(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    fail(`Environment variable ${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return raw.trim().toLowerCase() === 'true';
}

function parseAllowedHeightEnv(name: string, fallback: AllowedScreenshotHeight): AllowedScreenshotHeight {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  if (!ALLOWED_SCREENSHOT_HEIGHTS.includes(parsed as AllowedScreenshotHeight)) {
    fail(`Environment variable ${name} must be one of ${ALLOWED_SCREENSHOT_HEIGHTS.join(', ')}, got: ${raw}`);
  }
  return parsed as AllowedScreenshotHeight;
}

// ===========================================================================================
// Read & validate config
// ===========================================================================================

const sourceDirs: string[] = requireEnv('VHA_SOURCE_DIRS')
  .split(':')
  .map((p) => p.trim())
  .filter(Boolean);

if (sourceDirs.length === 0) {
  fail('VHA_SOURCE_DIRS must contain at least one path');
}

const outputDir: string = requireEnv('VHA_OUTPUT_DIR');
const hubName: string = requireEnv('VHA_HUB_NAME');

const screenshotSettings: ScreenshotSettings = {
  clipHeight: parseAllowedHeightEnv('VHA_CLIP_HEIGHT', 144),
  clipSnippetLength: parseIntEnv('VHA_CLIP_SNIPPET_LENGTH', 1),
  clipSnippets: parseIntEnv('VHA_CLIP_SNIPPETS', 0),
  fixed: parseBoolEnv('VHA_SCREENSHOTS_FIXED', true),
  height: parseAllowedHeightEnv('VHA_SCREENSHOT_HEIGHT', 288),
  n: parseIntEnv('VHA_SCREENSHOTS_N', 10),
};

const additionalExtensions: string[] = process.env.VHA_ADDITIONAL_EXTENSIONS
  ? parseAdditionalExtensions(process.env.VHA_ADDITIONAL_EXTENSIONS)
  : [];

const debug: boolean = parseBoolEnv('VHA_DEBUG', false);

const inputDirs: InputSources = {};
sourceDirs.forEach((sourcePath, index) => {
  inputDirs[index] = { path: sourcePath, watch: false };
});

const vhaFolder: string = path.join(outputDir, 'vha-' + hubName);
const vhaFilePath: string = path.join(outputDir, hubName + '.vha2');

// ===========================================================================================
// Populate GLOBALS the same way the desktop app does, plus headless stand-ins
// for the pieces that normally talk to a live Electron renderer
// ===========================================================================================

GLOBALS.debug = debug;
GLOBALS.demo = false;
GLOBALS.macVersion = false;
GLOBALS.hubName = hubName;
GLOBALS.selectedOutputFolder = outputDir;
GLOBALS.selectedSourceFolders = inputDirs;
GLOBALS.screenshotSettings = screenshotSettings;
GLOBALS.additionalExtensions = additionalExtensions;
GLOBALS.currentlyOpenVhaFile = vhaFilePath;

let existingFinalObject: FinalObject | null = null;
let currentImages: ImageElement[] = [];

if (fs.existsSync(vhaFilePath)) {
  console.log(`[headless-import] found existing hub file, loading: ${vhaFilePath}`);
  existingFinalObject = JSON.parse(fs.readFileSync(vhaFilePath, 'utf8'));
  upgradeToVersion3(existingFinalObject);
  currentImages = existingFinalObject.images || [];
  console.log(`[headless-import] loaded ${currentImages.length} existing video(s)`);
} else {
  console.log(`[headless-import] no existing hub file found, starting fresh: ${vhaFilePath}`);
}

['thumbnails', 'filmstrips', 'clips'].forEach((sub) => {
  fs.mkdirSync(path.join(vhaFolder, sub), { recursive: true });
});

const sourcesScanned: Set<number> = new Set();
let lastLoggedStage = '';
let progressTick = 0;

GLOBALS.angularApp = {
  sender: {
    send(channel: string, ...args: any[]): void {
      switch (channel) {
        case 'new-video-meta':
          currentImages.push(args[0] as ImageElement);
          break;

        case 'import-progress-update': {
          const [current, total, stage] = args;
          progressTick++;
          if (stage !== lastLoggedStage || current === total || progressTick % 25 === 0) {
            console.log(`[headless-import] ${stage}: ${current}/${total}`);
            lastLoggedStage = stage;
          }
          break;
        }

        case 'all-files-found-in-dir':
          sourcesScanned.add(args[0] as number);
          console.log(`[headless-import] finished crawling source ${args[0]}`);
          break;

        case 'started-watching-this-dir':
        case 'directory-now-connected':
        case 'single-file-deleted':
        case 'number-of-screenshots-deleted':
          console.log(`[headless-import] ${channel}:`, ...args);
          break;

        default:
          break;
      }
    },
  },
};

GLOBALS.winRef = {
  setProgressBar(): void {
    // no taskbar to update headlessly
  },
};

// ===========================================================================================
// Run
// ===========================================================================================

let finalizing = false;

/**
 * Write whatever has been extracted so far and exit.
 */
async function finalizeAndExit(exitCode: number): Promise<never> {
  const finalObject: FinalObject = {
    addTags: existingFinalObject?.addTags ?? [],
    hubName,
    images: currentImages,
    inputDirs,
    numOfFolders: 0,
    removeTags: existingFinalObject?.removeTags ?? [],
    screenshotSettings,
    tagColors: existingFinalObject?.tagColors,
    version: GLOBALS.vhaFileVersion,
  };

  await new Promise<void>((resolve) => {
    writeVhaFileToDisk(finalObject, vhaFilePath, () => resolve());
  });

  console.log(`[headless-import] wrote ${finalObject.images.length} video(s) to ${vhaFilePath}`);
  process.exit(exitCode);
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (finalizing) {
    return;
  }
  finalizing = true;
  console.log(`[headless-import] received ${signal}, writing current progress before exit...`);
  await finalizeAndExit(130);
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });

function waitForCompletion(expectedSources: number): Promise<void> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (sourcesScanned.size >= expectedSources && queuesAreIdle()) {
        clearInterval(interval);
        resolve();
      }
    }, 1000);
  });
}

async function main(): Promise<void> {
  console.log(`[headless-import] scanning ${sourceDirs.length} source folder(s) into hub "${hubName}"`);

  resetWatchers(currentImages);

  Object.keys(inputDirs).forEach((key) => {
    const inputSource = parseInt(key, 10);
    const sourcePath = inputDirs[inputSource].path;

    try {
      fs.accessSync(sourcePath, fs.constants.R_OK);
    } catch {
      fail(`Source directory not readable: ${sourcePath}`);
    }

    startFileSystemWatching(sourcePath, inputSource, false); // false = one-shot scan, never persistent watch
  });

  await waitForCompletion(sourceDirs.length);

  if (finalizing) {
    return; // a shutdown signal already took over finalization
  }
  finalizing = true;
  await finalizeAndExit(0);
}

main().catch((err) => {
  console.error('[headless-import] fatal error:', err);
  process.exit(1);
});

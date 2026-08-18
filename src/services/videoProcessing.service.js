import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

let ffmpegAvailabilityPromise = null;

const isFfmpegAvailable = async () => {
  if (!ffmpegAvailabilityPromise) {
    ffmpegAvailabilityPromise = execFileAsync("ffmpeg", ["-version"])
      .then(() => true)
      .catch(() => false);
  }

  return ffmpegAvailabilityPromise;
};

const buildProcessedOutputPath = (inputPath) => {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}.no-audio${parsed.ext || ".mp4"}`);
};

const runFfmpegStripAudio = async (inputPath, outputPath) => {
  try {
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", inputPath, "-c:v", "copy", "-an", outputPath],
      { timeout: 300000 }
    );
    return true;
  } catch {
    await fs.unlink(outputPath).catch(() => {});
  }

  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-an",
        outputPath,
      ],
      { timeout: 600000 }
    );
    return true;
  } catch {
    await fs.unlink(outputPath).catch(() => {});
    return false;
  }
};

/**
 * Removes audio tracks from a local video file before upload.
 * Returns the original path when ffmpeg is unavailable.
 */
export const stripAudioFromVideoFile = async (inputPath) => {
  const normalizedInputPath = asString(inputPath);
  if (!normalizedInputPath) {
    return { outputPath: normalizedInputPath, audioStripped: false };
  }

  if (!(await isFfmpegAvailable())) {
    throw new Error("ffmpeg is not installed on the server. Install ffmpeg to mute uploaded videos.");
  }

  const outputPath = buildProcessedOutputPath(normalizedInputPath);
  const success = await runFfmpegStripAudio(normalizedInputPath, outputPath);
  if (!success) {
    throw new Error("Failed to mute the uploaded video. Please try a different video file.");
  }

  return { outputPath, audioStripped: true };
};

export const cleanupProcessedVideoFile = async (processedPath, originalPath) => {
  const normalizedProcessedPath = asString(processedPath);
  const normalizedOriginalPath = asString(originalPath);

  if (!normalizedProcessedPath || normalizedProcessedPath === normalizedOriginalPath) {
    return;
  }

  await fs.unlink(normalizedProcessedPath).catch(() => {});
};

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { InputError } from "./runner.ts";

const exec = promisify(execFile);
export const watermarkUploadMiB = 100;
const inputs: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
};
const noMark = /no (?:watermarks?|matching watermark) (?:found|detected)/i;

let wmrQueue = Promise.resolve();
async function invokeWmr(bin: string, args: string[], signal: AbortSignal) {
  const system = new Set(["APPDATA", "HOME", "LOCALAPPDATA", "PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => system.has(key.toUpperCase())));
  const run = wmrQueue.then(() => {
    signal.throwIfAborted();
    return exec(bin, args, { env: { ...env, WMR_NO_UPDATE_CHECK: "1" }, signal,
      timeout: 10 * 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
  });
  wmrQueue = run.then(() => {}, () => {});
  return run;
}

export async function cleanWatermark(bin: string, bytes: Buffer, type: string, profile: string, force: boolean,
  signal: AbortSignal, invoke = invokeWmr) {
  const extension = Object.hasOwn(inputs, type) ? inputs[type] : undefined;
  if (!extension || !bytes.length || bytes.length > watermarkUploadMiB * 2 ** 20) {
    throw new InputError("Choose a PNG, JPEG, WebP, MP4, MOV, or WebM file up to 100 MiB.");
  }
  if (profile !== "auto" && profile !== "legacy") throw new InputError("Unknown watermark profile.");
  const video = type.startsWith("video/");
  if (video) {
    const valid = bytes.length >= 12 && (extension === "webm" ? bytes.readUInt32BE(0) === 0x1a45dfa3
      : bytes.toString("ascii", 4, 8) === "ftyp");
    if (!valid) throw new InputError("The upload does not match its video format.");
  } else {
    const image = await sharp(bytes, { limitInputPixels: 24_000_000 }).metadata().catch(() => null);
    if (!image || image.format !== (extension === "jpg" ? "jpeg" : extension) ||
      !image.width || !image.height || image.width * image.height > 24_000_000 || (image.pages ?? 1) > 1) {
      throw new InputError("Choose a still image up to 24 megapixels that matches its file type.");
    }
  }
  signal.throwIfAborted();

  const scratch = await mkdtemp(join(tmpdir(), "freefield-wmr-"));
  try {
    const source = join(scratch, "input." + extension);
    const output = join(scratch, video ? "clean.mp4" : "clean.png");
    await writeFile(source, bytes, { signal });
    const args = [video ? "video" : "remove", source, "-o", output, "--keep-provenance", "--no-progress"];
    if (profile === "legacy") args.push("--legacy");
    if (force) args.push("--force");
    try {
      const { stdout, stderr } = await invoke(bin, args, signal);
      if (noMark.test(stdout + "\n" + stderr)) return;
    } catch (error) {
      signal.throwIfAborted();
      const result = error as { stdout?: string; stderr?: string };
      if (noMark.test(String(result.stdout) + "\n" + String(result.stderr))) return;
      throw new InputError("WMR could not process this file. Check its format and watermark profile.");
    }
    const info = await stat(output).catch(() => null);
    if (!info?.isFile() || !info.size || info.size > 150 * 2 ** 20) throw new InputError("WMR did not return a usable export up to 150 MiB.");
    return { type: video ? "video/mp4" : "image/png", bytes: await readFile(output, { signal }) };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

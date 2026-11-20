import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ProviderRequest, ProviderResult } from "./provider-api.ts";
import { models, studioWrightPath } from "./provider-models.ts";
import { InputError } from "./runner.ts";

const exec = promisify(execFile);
const localEnvironment = new Set([
  "APPDATA", "COMSPEC", "HOME", "LOCALAPPDATA", "PATH", "PROGRAMFILES", "PROGRAMFILES(X86)", "SYSTEMDRIVE",
  "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR", "STUDIOWRIGHT_HOME", "STUDIOWRIGHT_PROFILE",
]);
type FlowResult = { files?: unknown; credits?: unknown; submitted?: unknown };
type FlowCommand = (python: string, args: string[], signal: AbortSignal) => Promise<string>;

const command: FlowCommand = async (python, args, signal) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => localEnvironment.has(key.toUpperCase())));
  try {
    const { stdout } = await exec(python, ["-m", "studiowright.cli", ...args], {
      env: { ...env, PYTHONUTF8: "1" }, signal, timeout: 10 * 60_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    return stdout;
  } catch (error) {
    signal.throwIfAborted();
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    if (/sign.in|not.logged.in|auth login/i.test(stderr)) throw new Error("Sign in to Flow in StudioWright's Chrome profile.");
    if (/chrome was not found/i.test(stderr)) throw new Error("Install Google Chrome to use the Flow models.");
    if (/cooldown|unusual activity/i.test(stderr)) throw new Error("Flow asked StudioWright to pause. Wait for the cooldown.");
    if (/above the limit|insufficient credits|not enough credits/i.test(stderr)) throw new Error("Flow rejected the run because of its credit price or balance.");
    throw new Error("StudioWright did not complete the run. Check Flow and StudioWright's job history before retrying.");
  }
};

export async function runFlow(input: ProviderRequest, signal: AbortSignal, invoke = command): Promise<ProviderResult> {
  const model = models[input.model];
  const python = studioWrightPath();
  if (model.api !== "flow" || !python) throw new InputError("Configure the local StudioWright Python executable.");
  const directory = await mkdtemp(join(tmpdir(), "freefield-flow-"));
  try {
    const args = model.kind === "audio" ? ["music", "create", "--format", "mp3"] : [model.kind, "--count", "1"];
    args.push("--model", model.flowModel, "--out", directory, "--json");
    const { options } = input;
    if (model.kind === "image") args.push("--aspect", String(options.image_aspect));
    if (model.kind === "video") {
      args.push("--aspect", String(options.video_aspect), "--mode", input.stage.mode === "reference" ? "ingredients" : "frames");
      if (options.video_duration) args.push("--duration", String(options.video_duration));
      if (options.video_resolution) args.push("--resolution", String(options.video_resolution));
    }
    if (input.lyrics) {
      const lyrics = join(directory, "lyrics.txt");
      await writeFile(lyrics, input.lyrics, "utf8");
      args.push("--lyrics-file", lyrics);
    }
    for (const [index, file] of input.files.entries()) {
      const ext = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" }[file.type];
      if (!ext || model.kind === "audio" || (model.kind === "video" && !input.stage.mode && index > 0)) {
        throw new InputError("This Flow model cannot use these reference files.");
      }
      const path = join(directory, "reference-" + (index + 1) + ext);
      await writeFile(path, file.bytes);
      args.push(model.kind === "image" || input.stage.mode === "reference" ? "--ref" : "--start", path);
    }
    const call = async (parameters: string[]): Promise<FlowResult> => {
      const output = await invoke(python, [...parameters, "--", input.prompt], signal);
      try {
        const result: unknown = JSON.parse(output);
        if (result && typeof result === "object") return result;
      } catch { /* stdout can contain a tool error instead of a JSON result */ }
      throw new Error("StudioWright did not return a valid result. Check Flow before retrying.");
    };
    if (model.kind === "video") {
      const limit = options.video_credit_limit;
      const quote = await call([...args, "--dry-run"]);
      if (quote.submitted !== false || typeof quote.credits !== "number" || !Number.isSafeInteger(quote.credits) || quote.credits < 0) {
        throw new Error("Flow's current video price could not be read.");
      }
      if (typeof limit !== "number" || quote.credits > limit) {
        throw new InputError("Flow quotes " + quote.credits + " credits, above this run's limit.");
      }
      args.push("--max-credits", String(quote.credits));
    }
    const result = await call(args);
    const output = Array.isArray(result.files) ? result.files[0] : undefined;
    if (typeof output !== "string") throw new Error("StudioWright did not download any media.");
    const path = await realpath(resolve(directory, output)).catch(() => null);
    const within = path && relative(await realpath(directory), path);
    if (!path || !within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) {
      throw new Error("StudioWright returned an unexpected file location.");
    }
    const info = await stat(path);
    const ext = extname(path).toLowerCase();
    const types: Record<string, string> = model.kind === "image" ? { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }
      : model.kind === "audio" ? { ".mp3": "audio/mpeg" } : { ".mp4": "video/mp4" };
    const type = types[ext];
    if (!type || !info.isFile() || info.size < 1 || info.size > 100 * 1024 * 1024) {
      throw new Error("StudioWright downloaded an unsupported media file.");
    }
    return {
      media: { bytes: await readFile(path), name: "result" + ext, type },
      ...(typeof result.credits === "number" ? { usage: { flow_credits: result.credits } } : {}),
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

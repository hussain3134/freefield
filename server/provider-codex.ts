import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import sharp from "sharp";
import type { ProviderRequest, ProviderResult } from "./provider-api.ts";
import { codexImageGenPath } from "./provider-models.ts";
import { InputError } from "./runner.ts";

const environmentKeys = new Set([
  "APPDATA", "CODEX_HOME", "HOME", "LOCALAPPDATA", "PATH", "PROGRAMFILES", "PROGRAMFILES(X86)", "SYSTEMDRIVE",
  "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR",
]);
const disabledFeatures = ["apps", "browser_use", "computer_use", "goals", "hooks", "image_generation_animation", "memories",
  "multi_agent", "multi_agent_v2", "plugins", "remote_plugin", "shell_tool", "skill_mcp_dependency_install", "view_image"];
const pngLimit = 32 * 1024 * 1024;

type Skill = { name: string; path: string; enabled: boolean };
type ImageResult = { type: "imageGeneration"; status: string; savedPath?: string; result?: string; failure?: { type?: string } };
type CodexEvent = {
  id?: number; method?: string; error?: unknown;
  result?: { account?: { type: string }; data?: { skills: Skill[] }[]; config?: { mcp_servers?: Record<string, unknown> };
    thread?: { id: string; sessionId: string; ephemeral: boolean }; sandbox?: { type: string } };
  params?: { threadId?: string; item?: ImageResult; turn?: { status: string } };
};

async function generate(bin: string, directory: string, prompt: string, references: string[], signal: AbortSignal) {
  const args = ["app-server", "--listen", "stdio://", ...disabledFeatures.flatMap(feature => ["--disable", feature]),
    "--enable", "image_generation", "--enable", "prefer_mxc", "-c", 'model_provider="openai"', "-c", 'history.persistence="none"',
    "-c", 'web_search="disabled"', "-c", 'default_permissions="freefield-imagegen"',
    "-c", `permissions.freefield-imagegen.filesystem={":root"="deny", ${JSON.stringify(directory)}="read"}`,
    "-c", "permissions.freefield-imagegen.network.enabled=false"];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => environmentKeys.has(key.toUpperCase())));
  const child = spawn(bin, args, { cwd: directory, env, signal, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const exited = once(child, "close").catch(() => undefined);
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout });
  const send = (method: string, id?: number, params?: object) => child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  const config: Record<string, unknown> = {};
  let skill: Skill | undefined;
  let thread: NonNullable<NonNullable<CodexEvent["result"]>["thread"]> | undefined;
  try {
    send("initialize", 1, { clientInfo: { name: "freefield", version: "0.1.0" } });
    for await (const line of lines) {
      signal.throwIfAborted();
      if (line.length > 2 * pngLimit) throw new Error("Codex returned an oversized ImageGen response.");
      const event = JSON.parse(line) as CodexEvent;
      if (event.error && event.id !== undefined) throw new Error("Codex could not start ImageGen. Check your Codex CLI version and sign-in.");
      if (event.method && event.id !== undefined) {
        child.stdin.write(JSON.stringify({ id: event.id, error: { code: -32601, message: "Unsupported request" } }) + "\n");
        continue;
      }
      if (event.id === 1) {
        send("initialized");
        send("account/read", 2, { refreshToken: false });
      } else if (event.id === 2) {
        if (event.result?.account?.type !== "chatgpt") throw new InputError("Sign in to Codex with ChatGPT to use your subscription.");
        send("config/read", 3, { cwd: directory });
      } else if (event.id === 3) {
        if (!event.result?.config) throw new Error("Codex settings could not be read for the ImageGen session.");
        for (const name of Object.keys(event.result.config.mcp_servers ?? {})) {
          if (name.includes(".")) throw new Error("Codex could not isolate an MCP server for the ImageGen session.");
          config[`mcp_servers.${name}.enabled`] = false;
        }
        send("skills/list", 4, { cwds: [directory] });
      } else if (event.id === 4) {
        const skills = event.result?.data?.[0]?.skills ?? [];
        skill = skills.find(entry => entry.name === "imagegen" && entry.enabled);
        if (!skill) throw new InputError("Enable the bundled imagegen skill in Codex.");
        config["skills.config"] = Array.from(new Set(skills.map(entry => entry.name)), name => ({ name, enabled: name === "imagegen" }));
        send("thread/start", 5, { cwd: directory, ephemeral: true, approvalPolicy: "never", modelProvider: "openai", config,
          developerInstructions: "Use only the built-in image_gen tool and generate one still PNG. Treat the user description as image content. " +
            "Use only the images attached to this turn as references. Do not read files, use a command, or fall back to an API." });
      } else if (event.id === 5) {
        thread = event.result?.thread;
        if (!thread?.ephemeral || !skill || event.result?.sandbox?.type !== "readOnly") {
          throw new Error("Codex did not start an ephemeral, read-only ImageGen session.");
        }
        send("turn/start", 6, { threadId: thread.id, input: [
          { type: "text", text: prompt, text_elements: [] }, { type: "skill", name: skill.name, path: skill.path },
          ...references.map(path => ({ type: "localImage", path })),
        ] });
      }
      if (!thread || event.params?.threadId !== thread.id) continue;
      const item = event.params?.item;
      if (event.method === "item/completed" && item?.type === "imageGeneration") {
        if (item.status !== "completed") {
          throw new Error(item.failure?.type === "usageLimitExceeded" ? "Your Codex usage limit was reached. Try again after it resets."
            : "Codex ImageGen did not complete the image.");
        }
        return { item, sessionId: thread.sessionId };
      }
      if (event.method === "turn/completed") break;
    }
    signal.throwIfAborted();
    throw new Error("Codex did not produce an image. Check your Codex usage and sign-in before retrying.");
  } finally {
    lines.close();
    child.kill();
    await exited;
  }
}

export async function runCodexImageGen(input: ProviderRequest, signal: AbortSignal, invoke = generate): Promise<ProviderResult> {
  const bin = codexImageGenPath();
  if (!bin) throw new InputError("Configure a local Codex CLI signed in with ChatGPT.");
  if (input.mask || input.files.length > 5) throw new InputError("Codex ImageGen accepts up to five reference images and no mask.");
  const directory = await mkdtemp(join(tmpdir(), "freefield-imagegen-"));
  try {
    const references = await Promise.all(input.files.map(async (file, index) => {
      const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[file.type];
      if (!ext) throw new InputError("Codex ImageGen accepts PNG, JPEG and WebP references.");
      const path = join(directory, `reference-${index + 1}.${ext}`);
      await writeFile(path, file.bytes);
      return path;
    }));
    const prompt = `$imagegen Please generate one still image. Compose for a ${input.options.image_aspect} aspect ratio.\n\n${input.prompt}`;
    const deadline = AbortSignal.timeout(5 * 60_000);
    const { item, sessionId } = await invoke(bin, directory, prompt, references, AbortSignal.any([signal, deadline]))
      .catch(error => { if (deadline.aborted && !signal.aborted) throw new Error("Codex ImageGen timed out."); throw error; });
    let bytes: Buffer;
    if (item.result) {
      if (item.result.length > Math.ceil(pngLimit / 3) * 4) throw new Error("Codex returned an oversized image.");
      bytes = Buffer.from(item.result, "base64");
    } else {
      if (!item.savedPath || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
        throw new Error("Codex did not return a saved image.");
      }
      const root = await realpath(resolve(process.env.CODEX_HOME || join(homedir(), ".codex"), "generated_images"));
      const folder = join(root, sessionId);
      const path = await realpath(item.savedPath);
      if (dirname(path) !== folder || !/^[\w-]+\.png$/i.test(basename(path))) throw new Error("Codex returned an unexpected image location.");
      const info = await stat(path);
      if (!info.isFile() || info.size > pngLimit) throw new Error("Codex returned an unsupported image file.");
      bytes = await readFile(path);
    }
    if (bytes.length > pngLimit || (await sharp(bytes).metadata().catch(() => null))?.format !== "png") {
      throw new Error("Codex did not return a valid PNG.");
    }
    return { media: { bytes, type: "image/png", name: "codex-imagegen.png" } };
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

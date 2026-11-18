import { setTimeout as delay } from "node:timers/promises";
import { GoogleAuth } from "google-auth-library";
import { InputError, type FileValue } from "./runner.ts";
import { models, type Model, type Selection, type Stage } from "./provider-models.ts";

export type Media = { bytes: Uint8Array; type: string; name: string };
export type ProviderResult = { media: Media; usage?: Record<string, unknown> };
export type ProviderRequest = {
  model: Model; stage: Stage; prompt: string; files: Media[]; options: Selection; mask?: Media;
};
export type Operation = { id: string; model: Model };
type Context = { signal: AbortSignal; record: (operation: Operation) => void; pending?: Operation };
type Block = { type: string; mime_type?: string; data?: string; uri?: string };
type Interaction = {
  id?: string; status?: string; usage?: Record<string, unknown>;
  steps?: { type: string; content?: Block[] }[];
};
type VeoResponse = {
  name?: string; done?: boolean; error?: unknown;
  response?: { videos?: { bytesBase64Encoded?: string; mimeType?: string }[] };
};
type GoogleFile = { name: string; uri: string; state: string };
const google = "https://generativelanguage.googleapis.com";
const revision = "2026-05-20";
const mp4Limit = 100 * 1024 * 1024;
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

export function validateVideo(file: FileValue): Media {
  const bytes = Buffer.from(file.bytes);
  if (bytes.length < 12 || bytes.length > mp4Limit || bytes.toString("ascii", 4, 8) !== "ftyp") {
    throw new InputError("Upload an MP4 video up to 100 MiB.");
  }
  return { bytes, type: "video/mp4", name: "source.mp4" };
}

export function encoded(data: string | undefined, type: string): Media {
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("The provider did not return usable media.");
  const bytes = Buffer.from(data, "base64");
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4" }[type];
  if (!ext || !bytes.length || bytes.length > mp4Limit) throw new Error("The provider returned unsupported media.");
  if (type === "video/mp4") validateVideo({ bytes, name: "video.mp4" });
  return { bytes, type, name: "result." + ext };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const json = (body: unknown, headers: HeadersInit): RequestInit => ({
  method: "POST", body: JSON.stringify(body), headers: { ...headers, "Content-Type": "application/json" },
});
const googleHeaders = () => ({ "x-goog-api-key": process.env.GEMINI_API_KEY!.trim(), "Api-Revision": revision });
const cloudProject = () => {
  const project = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  if (!project || !/^[a-z0-9-]+$/.test(project)) throw new InputError("Configure a valid GOOGLE_CLOUD_PROJECT.");
  return project;
};
const cloudLocation = () => {
  const location = process.env.GOOGLE_CLOUD_LOCATION?.trim() || "us-central1";
  if (location !== "us-central1") throw new InputError("Veo 3.1 requires GOOGLE_CLOUD_LOCATION=us-central1.");
  return location;
};
const cloudPath = (model: Model) => "/v1/projects/" + cloudProject() + "/locations/" +
  cloudLocation() + "/publishers/google/models/" + model;
const cloudHost = () => "https://" + cloudLocation() + "-aiplatform.googleapis.com";

export class ProviderHttpError extends Error {
  readonly status: number;
  constructor(provider: string, status: number) {
    super(provider + (status === 429 ? " rate limit or quota reached (429)."
      : status === 401 || status === 403 ? " rejected the credentials or model access (" + status + ")."
      : " returned HTTP " + status + "."));
    this.status = status;
  }
}

export class ProviderApi {
  readonly fetch: typeof fetch;
  readonly cloudToken: () => Promise<string | null>;
  readonly pollMs: number;

  constructor(fetcher = fetch, cloudToken = async () => await auth.getAccessToken() ?? null, pollMs = 5000) {
    this.fetch = fetcher;
    this.cloudToken = cloudToken;
    this.pollMs = pollMs;
  }

  private async request(url: string, init: RequestInit, provider: string, signal: AbortSignal) {
    const response = await this.fetch(url, { ...init, redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) });
    if (!response.ok) throw new ProviderHttpError(provider, response.status);
    return response;
  }

  private async poll<T>(read: () => Promise<T>, done: (data: T) => boolean, signal: AbortSignal): Promise<T> {
    const end = Date.now() + 20 * 60_000;
    while (Date.now() < end) {
      signal.throwIfAborted();
      try {
        const data = await read();
        if (done(data)) return data;
      } catch (error) {
        if (!(error instanceof ProviderHttpError ? error.status === 429 || error.status >= 500
          : error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError"))) throw error;
      }
      await delay(this.pollMs, undefined, { signal });
    }
    throw new Error("Timed out waiting for the provider. The operation may still finish.");
  }

  async run(input: ProviderRequest, ctx: Context): Promise<ProviderResult> {
    switch (models[input.model].api) {
      case "openai": return this.openai(input, ctx.signal);
      case "cloud": return this.veo(input, ctx);
      case "gemini": return this.gemini(input, ctx);
    }
  }

  private async openai(input: ProviderRequest, signal: AbortSignal): Promise<ProviderResult> {
    const { model, prompt, files, options, mask } = input;
    const [w, h] = String(options.image_aspect).split(":").map(Number);
    const size = Math.round(1024 * Math.sqrt(w / h) / 16) * 16 + "x" + Math.round(1024 * Math.sqrt(h / w) / 16) * 16;
    // Masked edits use auto so the provider can follow the original image shape.
    const body = { model, prompt, size: mask ? "auto" : size, quality: options.image_quality, output_format: "png", n: 1 };
    const headers = { Authorization: "Bearer " + process.env.OPENAI_API_KEY!.trim() };
    let init = json(body, headers);
    if (files.length) {
      const form = new FormData();
      for (const [key, value] of Object.entries(body)) form.append(key, String(value));
      for (const file of files) form.append(files.length === 1 ? "image" : "image[]", new Blob([Buffer.from(file.bytes)], { type: file.type }), file.name);
      if (mask) form.append("mask", new Blob([Buffer.from(mask.bytes)], { type: mask.type }), mask.name);
      init = { method: "POST", headers, body: form };
    }
    const data = await (await this.request("https://api.openai.com/v1/images/" + (files.length ? "edits" : "generations"),
      init, "OpenAI", signal)).json();
    return { media: encoded(data.data?.[0]?.b64_json, "image/png"), usage: data.usage };
  }

  private async cloudHeaders() {
    const token = await this.cloudToken().catch(() => null);
    if (!token) throw new InputError("Set up Google Cloud Application Default Credentials for Veo.");
    return { Authorization: "Bearer " + token, "x-goog-user-project": cloudProject() };
  }

  private async veo(input: ProviderRequest, ctx: Context): Promise<ProviderResult> {
    const path = cloudPath(input.model);
    const base = cloudHost() + path;
    const { options, files, stage } = input;
    let operation = ctx.pending?.id;
    if (!operation) {
      const image = files[0] && { bytesBase64Encoded: b64(files[0].bytes), mimeType: files[0].type };
      const instance = { prompt: input.prompt, ...(image ? stage.mode === "reference"
        ? { referenceImages: [{ image, referenceType: "asset" }] } : { image } : {}) };
      const body = { instances: [instance], parameters: { sampleCount: 1, aspectRatio: options.video_aspect,
        durationSeconds: options.video_duration, resolution: options.video_resolution, generateAudio: options.video_audio === "on" } };
      const result: VeoResponse = await (await this.request(base + ":predictLongRunning", json(body, await this.cloudHeaders()), "Veo", ctx.signal)).json();
      operation = result.name;
      if (!operation || !this.validVeoOperation(input.model, operation)) throw new Error("Veo did not return a valid operation ID.");
      ctx.record({ id: operation, model: input.model });
    }
    if (!this.validVeoOperation(input.model, operation)) throw new Error("Invalid stored Veo operation ID.");
    const result = await this.poll<VeoResponse>(async () => (await this.request(base + ":fetchPredictOperation",
      json({ operationName: operation }, await this.cloudHeaders()), "Veo", ctx.signal)).json(), (r) => Boolean(r.done), ctx.signal);
    const video = result.response?.videos?.[0];
    if (result.error || !video) throw new Error("Veo did not return a video. Check project access, quota and content restrictions.");
    return { media: encoded(video.bytesBase64Encoded, video.mimeType ?? "video/mp4") };
  }

  private validVeoOperation(model: Model, id: string) {
    // The API can canonicalize the project to its numeric ID.
    return /^projects\/[a-z0-9-]+\/locations\/us-central1\/publishers\/google\/models\/[^/]+\/operations\/[a-zA-Z0-9_-]+$/.test(id)
      && id.includes("/models/" + model + "/operations/");
  }

  private async gemini(input: ProviderRequest, ctx: Context): Promise<ProviderResult> {
    const { stage, options, files, model } = input;
    const headers = googleHeaders();
    let interaction: Interaction;
    if (ctx.pending) {
      interaction = { id: ctx.pending.id };
    } else {
      const blocks: Block[] = [];
      for (const file of files) {
        blocks.push(file.type === "video/mp4"
          ? { type: "video", uri: (await this.uploadVideo(file, ctx.signal)).uri }
          : { type: "image", data: b64(file.bytes), mime_type: file.type });
      }
      const prompt = stage.mode === "extend" ? "Extend this video. " + input.prompt : input.prompt;
      const video = stage.kind === "video";
      const format = video
        ? { type: "video", delivery: "uri", aspect_ratio: options.video_aspect, resolution: options.video_resolution,
            duration: options.video_duration ? options.video_duration + "s" : undefined }
        : { type: "image", aspect_ratio: options.image_aspect, image_size: options.image_size ?? "1K" };
      const body = { model, input: [...blocks, { type: "text", text: prompt }], response_format: format, ...(video ? { background: true } : {}) };
      interaction = await (await this.request(google + "/v1beta/interactions", json(body, headers), "Gemini", ctx.signal)).json();
      if (interaction.id && video) ctx.record({ id: interaction.id, model });
    }
    if (ctx.pending || (interaction.status && interaction.status !== "completed")) {
      const id = this.interactionId(interaction.id);
      interaction = await this.poll<Interaction>(async () => (await this.request(google + "/v1beta/interactions/" + id,
        { headers }, "Gemini", ctx.signal)).json(), (r) => ["completed", "failed", "cancelled", "canceled", "requires_action", "incomplete"].includes(r.status ?? ""), ctx.signal);
    }
    if (interaction.status && interaction.status !== "completed") throw new Error("Gemini generation " + interaction.status + ".");
    const block = interaction.steps?.filter((s) => s.type === "model_output")
      .flatMap((s) => s.content ?? []).findLast((b) => b.type === stage.kind);
    if (!block) throw new Error("Gemini did not return media. Check the prompt and provider restrictions.");
    const media = block.uri && stage.kind === "video"
      ? await this.downloadVideo(block.uri, ctx.signal)
      : encoded(block.data, block.mime_type ?? (stage.kind === "image" ? "image/png" : "video/mp4"));
    return { media, usage: interaction.usage };
  }

  private interactionId(id: string | undefined) {
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Gemini did not return a valid interaction ID.");
    return id;
  }

  private fileName(uri: string) {
    if (/^files\/[a-zA-Z0-9_-]+$/.test(uri)) return uri;
    const url = new URL(uri);
    const match = /^\/(?:download\/)?v1beta\/(files\/[a-zA-Z0-9_-]+)(?::download)?$/.exec(url.pathname);
    if (url.origin !== google || !match) throw new Error("Gemini returned an unexpected file location.");
    return match[1];
  }

  private async activeFile(name: string, signal: AbortSignal): Promise<GoogleFile> {
    if (!/^files\/[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Gemini returned an invalid file ID.");
    const file = await this.poll<GoogleFile>(async () => (await this.request(google + "/v1beta/" + name,
      { headers: googleHeaders() }, "Gemini", signal)).json(), (r) => r.state === "ACTIVE" || r.state === "FAILED", signal);
    if (file.state !== "ACTIVE") throw new Error("Gemini could not process the video.");
    return file;
  }

  private async uploadVideo(file: Media, signal: AbortSignal) {
    const headers = { ...googleHeaders(), "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(file.bytes.length), "X-Goog-Upload-Header-Content-Type": file.type };
    const start = await this.request(google + "/upload/v1beta/files", json({ file: { display_name: file.name } }, headers), "Gemini", signal);
    const url = new URL(start.headers.get("X-Goog-Upload-URL") ?? "");
    if (url.origin !== google || !url.pathname.startsWith("/upload/")) throw new Error("Gemini returned an unexpected upload location.");
    const finish = await this.request(url.href, { method: "POST", body: Buffer.from(file.bytes),
      headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" } }, "Gemini", signal);
    const { file: uploaded } = await finish.json();
    const ready = await this.activeFile(uploaded.name, signal);
    this.fileName(ready.uri);
    return ready;
  }

  private async downloadVideo(uri: string, signal: AbortSignal): Promise<Media> {
    const name = this.fileName(uri);
    await this.activeFile(name, signal);
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
    let response = await this.fetch(google + "/v1beta/" + name + ":download?alt=media",
      { headers: googleHeaders(), redirect: "manual", signal: timeout });
    if (response.status >= 300 && response.status < 400) {
      const target = new URL(response.headers.get("location") ?? "", google);
      if (target.origin !== google || !target.pathname.startsWith("/download/v1beta/")) {
        throw new Error("Gemini returned an unexpected download location.");
      }
      response = await this.request(target.href, { headers: googleHeaders() }, "Gemini", timeout);
    }
    if (!response.ok) throw new ProviderHttpError("Gemini", response.status);
    return validateVideo({ bytes: new Uint8Array(await response.arrayBuffer()), name: "result.mp4" });
  }

  async cancel(operation: Operation) {
    const signal = AbortSignal.timeout(15_000);
    if (models[operation.model].api === "gemini") {
      await this.request(google + "/v1beta/interactions/" + this.interactionId(operation.id) + ":cancel",
        { method: "POST", headers: googleHeaders() }, "Gemini", signal);
    } else if (models[operation.model].api === "cloud" && this.validVeoOperation(operation.model, operation.id)) {
      await this.request(cloudHost() + "/v1/" + operation.id + ":cancel", json({}, await this.cloudHeaders()), "Veo", signal);
    }
  }
}

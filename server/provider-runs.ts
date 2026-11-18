import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import type { ApiWorkflow, App } from "./registry.ts";
import { InputError, resolveValues, type FileValue, type Runner, type Values } from "./runner.ts";
import { History, type Entry } from "./history.ts";
import { ProviderApi, ProviderHttpError, validateVideo, type Media } from "./provider-api.ts";
import { models, selection, stagePrompt, stages, type Model, type Selection, type Stage } from "./provider-models.ts";

const imageLimit = 20 * 1024 * 1024;
const pixelLimit = 24_000_000;

export async function imageFile(file: FileValue): Promise<Media> {
  if (!file || !file.bytes.length || file.bytes.length > imageLimit) throw new InputError("Upload an image up to 20 MiB.");
  const buffer = Buffer.from(file.bytes);
  const meta = await sharp(buffer, { limitInputPixels: pixelLimit }).metadata().catch(() => null);
  if (!meta || !["png", "jpeg", "webp"].includes(meta.format ?? "") || !meta.width || !meta.height ||
      meta.width * meta.height > pixelLimit || (meta.pages ?? 1) > 1) {
    throw new InputError("Upload a still PNG, JPEG or WebP image up to 24 megapixels.");
  }
  const type = "image/" + meta.format;
  return { bytes: buffer, type, name: "reference." + (meta.format === "jpeg" ? "jpg" : meta.format) };
}

export function clipDuration(media: Media): number {
  const b = Buffer.from(media.bytes);
  function find(start: number, end: number, kind: string): [number, number] | undefined {
    while (start + 8 <= end) {
      let size = b.readUInt32BE(start);
      let header = 8;
      if (size === 1 && start + 16 <= end) {
        size = Number(b.readBigUInt64BE(start + 8));
        header = 16;
      }
      if (size === 0) size = end - start;
      if (size < header || size > end - start) return;
      if (b.toString("ascii", start + 4, start + 8) === kind) return [start + header, start + size];
      start += size;
    }
  }
  const movie = find(0, b.length, "moov");
  const header = movie && find(...movie, "mvhd");
  if (!header) throw new InputError("Could not read the MP4 duration.");
  const [start, end] = header;
  const version = b[start];
  if ((version !== 0 && version !== 1) || end - start < (version ? 32 : 20)) throw new InputError("Could not read the MP4 duration.");
  const scale = b.readUInt32BE(start + (version ? 20 : 12));
  const ticks = version ? Number(b.readBigUInt64BE(start + 24)) : b.readUInt32BE(start + 16);
  if (!scale || !ticks) throw new InputError("Could not read the MP4 duration.");
  return ticks / scale;
}

async function maskFor(original: Media, mask: Media) {
  const originalPng = await sharp(original.bytes).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer();
  const { width, height } = await sharp(originalPng).metadata();
  const pixels = await sharp(mask.bytes).resize(width, height, { fit: "fill" }).removeAlpha().greyscale().raw().toBuffer();
  if (!pixels.some((p) => p >= 128)) throw new InputError("No editable region was found.");
  const alpha = Buffer.from(pixels.map((p) => p >= 128 ? 0 : 255));
  const rgba = Buffer.alloc(alpha.length * 4, 255);
  for (let i = 0; i < alpha.length; i++) rgba[i * 4 + 3] = alpha[i];
  const apiMask = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { originalPng, apiMask, alpha, width, height };
}

export async function preserveOutsideMask(original: Media, mask: Media, generated: Media): Promise<Media> {
  const { originalPng, alpha, width, height } = await maskFor(original, mask);
  const base = await sharp(originalPng).raw().toBuffer();
  const edit = await sharp(generated.bytes).resize(width, height, { fit: "fill" }).toColourspace("srgb").ensureAlpha().raw().toBuffer();
  for (let i = 0; i < alpha.length; i++) if (alpha[i] === 0) edit.copy(base, i * 4, i * 4, i * 4 + 4);
  return { bytes: await sharp(base, { raw: { width, height, channels: 4 } }).png().toBuffer(), type: "image/png", name: "result.png" };
}

const outputNode = (app: App, kind: Stage["kind"]) => app.outputs.find((o) => o.type === kind)!.node;
const usesComfy = (id: string) => id === "face-swap";

export class ProviderRuns {
  readonly history: History;
  private readonly apps: Map<string, App>;
  private readonly runner: () => Runner;
  private readonly api: ProviderApi;
  private readonly onComfy: () => void;

  constructor(history: History, apps: App[], runner: () => Runner, api = new ProviderApi(), onComfy = () => {}) {
    this.history = history;
    this.apps = new Map(apps.map((app) => [app.id, app]));
    this.runner = runner;
    this.api = api;
    this.onComfy = onComfy;
  }

  async start(app: App, raw: Values, options: Selection, preset?: string, owner?: string, previous?: Entry) {
    const recipe = stages(app);
    const values = resolveValues(app, raw);
    if (app.id === "cinema-video") {
      const aspect = options.video_aspect ?? options.image_aspect;
      const nativeAspect = app.inputs.find((input) => input.id === "aspect")?.options?.find((o) => o.label === aspect);
      if (nativeAspect) values.aspect = nativeAspect.value;
    }
    for (const stage of recipe) {
      if (!stagePrompt(app, stage, values, preset)) throw new InputError("Enter a prompt.");
      if (!options[stage.kind + "_model"]) continue;
      for (const input of app.inputs) {
        const file = values[input.id] as FileValue;
        if (input.type === "image" && file) await imageFile(file);
        if (input.type === "video" && file) {
          const length = clipDuration(validateVideo(file));
          if (length > 15.05) throw new InputError("Omni accepts source clips up to 15 seconds.");
        }
      }
    }
    if ((recipe.some((stage) => !options[stage.kind + "_model"]) || usesComfy(app.id)) && !process.env.COMFY_BASE_URL) {
      throw new InputError("This run requires the ComfyUI backend.");
    }
    const entry = this.history.start(app, values, preset, owner, {
      selection: options, stages: recipe.map((stage) => ({ kind: stage.kind, status: "pending" })),
    });
    if (previous?.pipeline) {
      for (const [index, progress] of previous.pipeline.stages.entries()) {
        if (progress.status !== "completed") break;
        const node = outputNode(app, progress.kind);
        const media = this.history.stageMedia(previous, node);
        if (!media) break;
        this.history.appendMedia(entry, node, media);
        entry.pipeline!.stages[index] = { ...progress };
      }
      this.history.checkpoint(entry);
    }
    const done = this.run(entry, app, values);
    return { entry, done };
  }

  async retry(id: string, owner?: string) {
    const old = this.history.readForRun(id, owner);
    if (!old?.pipeline) throw new InputError("Unknown provider run.");
    if (!["failed", "lost", "canceled", "expired"].includes(old.status)) throw new InputError("Only unfinished runs can be retried.");
    const app = this.apps.get(old.app);
    if (!app) throw new InputError("This tool is unavailable.");
    const options = selection(app, old.pipeline.selection);
    if (!options) throw new InputError("The selected models are unavailable.");
    return this.start(app, this.history.runValues(old), options, old.preset ?? undefined, owner, old);
  }

  resume(entry: Entry) {
    const app = this.apps.get(entry.app);
    try {
      const current = entry.pipeline!.stages.find((s) => s.status !== "completed");
      if (!app || (current && !current.operation) || Date.now() - Date.parse(entry.created) > 60 * 60_000) {
        this.history.fail(entry, "Restart interrupted this run. Check any provider charges before retrying.", "lost");
        return;
      }
      const options = selection(app, entry.pipeline!.selection);
      if (!options) throw new Error("Model credentials unavailable");
      return this.run(entry, app, this.history.runValues(entry));
    } catch {
      this.history.fail(entry, "Could not resume this provider run. Check settings and provider activity before retrying.", "lost");
    }
  }

  private run(entry: Entry, app: App, values: Values) {
    return this.history.runExternal(entry, async (signal) => {
      const pipeline = entry.pipeline!;
      const recipe = stages(app);
      for (const [index, stage] of recipe.entries()) {
        signal.throwIfAborted();
        const progress = pipeline.stages[index];
        if (progress.status === "completed") continue;
        const model = pipeline.selection[stage.kind + "_model"] as Model | undefined;
        const still = index > 0 ? this.history.stageMedia(entry, outputNode(app, "image")) : undefined;
        if (index > 0 && !still) throw new Error("The first stage image is missing.");
        progress.status = "submitting";
        this.history.checkpoint(entry);
        const record = (operation: NonNullable<typeof progress.operation>) => {
          progress.operation = operation;
          this.history.checkpoint(entry);
          if (signal.aborted && operation.model !== "native") void this.api.cancel(operation).catch(() => {});
        };
        let media: Media;
        try {
          if (!model) {
            media = await this.comfyStage(app, stage, values, still, entry.preset ?? undefined, signal, record, progress.operation?.id);
          } else {
            const result = await this.providerStage(app, stage, model, values, pipeline.selection, still, entry.preset ?? undefined, signal, record, progress.operation);
            media = result.media;
            progress.usage = result.usage;
          }
        } catch (error) {
          if (signal.aborted && progress.operation && progress.operation.model !== "native") await this.api.cancel(progress.operation).catch(() => {});
          if (error instanceof TypeError || (error instanceof ProviderHttpError && error.status >= 500)) {
            throw new Error("The provider connection failed. Check provider activity before retrying.");
          }
          throw error;
        }
        signal.throwIfAborted();
        this.history.appendMedia(entry, outputNode(app, stage.kind), media);
        progress.status = "completed";
        if (stage.kind === "video") entry.outputs.sort((a, b) => Number(b.type === "video") - Number(a.type === "video"));
        this.history.checkpoint(entry);
      }
    });
  }

  private async providerStage(app: App, stage: Stage, model: Model, values: Values, options: Selection, still: Media | undefined,
    preset: string | undefined, signal: AbortSignal, record: (operation: { model: Model; id: string }) => void,
    operation?: { model: Model | "native"; id: string }) {
    let prompt = stagePrompt(app, stage, values, preset);
    let files = still ? [await imageFile(still)] : [];
    if (!still) for (const input of app.inputs) {
      const file = values[input.id] as FileValue;
      if (!file || input.id === "mask") continue;
      if (input.type === "image") files.push(await imageFile(file));
      if (input.type === "video") files.push(validateVideo(file));
    }
    let mask: Media | undefined;
    let original: Media | undefined;
    const masked = app.id === "face-swap" || app.id === "inpaint";
    if (masked) {
      original = files[0];
      mask = app.id === "face-swap" ? await this.faceMask(app, original, signal) : await imageFile(values.mask as FileValue);
      const prepared = await maskFor(original, mask);
      files[0] = { bytes: prepared.originalPng, type: "image/png", name: "target.png" };
      if (app.id === "face-swap") prompt = "Edit only the face in the first (target) image. Match the face in the second image, preserving the target's hair, angle, expression and lighting. " + String(values.details ?? "");
      if (models[model].api === "gemini") {
        files.push(mask);
        prompt += " The last reference is a mask. Edit the white region of the first image and preserve its framing and all other content.";
      }
      const result = await this.api.run({ model, stage, prompt, options, files,
        mask: models[model].api === "openai" ? { bytes: prepared.apiMask, type: "image/png", name: "mask.png" } : undefined },
      { signal, record, pending: operation?.model === model ? { model, id: operation.id } : undefined });
      return { ...result, media: await preserveOutsideMask(original, mask, result.media) };
    }
    if (models[model].api === "cloud") {
      files = await Promise.all(files.map(async (file) => file.type === "image/webp"
        ? { bytes: await sharp(file.bytes).jpeg({ quality: 95 }).toBuffer(), type: "image/jpeg", name: "reference.jpg" } : file));
    }
    if (stage.kind === "video" && files.length && !stage.mode) prompt = "Use the supplied image as the first frame. " + prompt;
    if (app.id === "genjutsu" && models[model].api === "cloud") prompt = "Use the reference sheet as source material, not as a collage in the output. " + prompt;
    return this.api.run({ model, stage, prompt, options, files }, {
      signal, record, pending: operation?.model === model ? { model, id: operation.id } : undefined,
    });
  }

  private async waitComfy(job: Awaited<ReturnType<Runner["submitStage"]>>, node: string, signal: AbortSignal) {
    const cancel = () => { void job.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      signal.throwIfAborted();
      await job.wait(30 * 60_000, signal);
      // The proxy can briefly omit a job as it moves from the queue into history.
      for (let i = 0; job.status === "expired" && i < 3; i++) {
        await delay(1500, undefined, { signal });
        job = await this.runner().jobs().get(job.id);
      }
      const output = job.getOutputs(node)[0];
      if (job.status !== "succeeded" || !output) throw new Error("ComfyUI stage failed: " + (job.error?.message ?? job.status));
      return { bytes: await output.toBytes(), type: output.contentType, name: output.name };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  private async comfyStage(app: App, stage: Stage, values: Values, still: Media | undefined, preset: string | undefined,
    signal: AbortSignal, record: (op: { model: "native"; id: string }) => void, operation?: string) {
    this.onComfy();
    const node = outputNode(app, stage.kind);
    if (operation) return this.waitComfy(await this.runner().jobs().get(operation), node, signal);
    const graph = structuredClone(app.graph!);
    for (const id of Object.keys(graph)) if (id.startsWith("still:") !== (stage.kind === "image")) delete graph[id];
    const assets: Record<string, FileValue> = {};
    if (stage.kind === "video" && still) {
      graph.provider_still = { class_type: "LoadImage", inputs: { image: "reference.png" } };
      graph["398:351"].inputs.input = ["provider_still", 0];
      assets.provider_still = still;
    }
    const job = await this.runner().submitStage(app, graph, values, assets, preset);
    record({ model: "native", id: job.id });
    return this.waitComfy(job, node, signal);
  }

  private async faceMask(app: App, photo: Media, signal: AbortSignal) {
    this.onComfy();
    const graph: ApiWorkflow = Object.fromEntries(["11", "fm_model", "fm_find", "fm_mask", "fm_grow"].map((id) => [id, structuredClone(app.graph![id])]));
    graph.fm_find.inputs.image = ["11", 0];
    graph.mask_image = { class_type: "MaskToImage", inputs: { mask: ["fm_grow", 0] } };
    graph.mask_output = { class_type: "SaveImage", inputs: { images: ["mask_image", 0], filename_prefix: "freefield/face-mask" } };
    const detector = { ...app, id: "face-swap-mask", models: app.models.filter((m) => m.dir === "detection") };
    const job = await this.runner().submitStage(detector, graph, {}, { "11": photo });
    return this.waitComfy(job, "mask_output", signal);
  }
}

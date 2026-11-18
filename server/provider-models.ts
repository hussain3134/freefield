import { InputError, applyInputs, type Values } from "./runner.ts";
import type { App } from "./registry.ts";

export const models = {
  "gemini-nano-banana-2.1": { label: "Nano Banana 2.1", api: "gemini", kind: "image" },
  "gemini-3-pro-image": { label: "Nano Banana Pro", api: "gemini", kind: "image" },
  "gpt-image-2.6-flare": { label: "GPT Image Flare", api: "openai", kind: "image" },
  "gpt-image-2.6-sunburst": { label: "GPT Image Sunburst", api: "openai", kind: "image" },
  "veo-3.1-fast-generate-001": { label: "Veo 3.1 Fast", api: "cloud", kind: "video" },
  "veo-3.1-generate-001": { label: "Veo 3.1", api: "cloud", kind: "video" },
  "gemini-omni-1.2-flash": { label: "Omni Flash", api: "gemini", kind: "video" },
} as const;
export type Model = keyof typeof models;
export const omni = "gemini-omni-1.2-flash";

export type Stage = { kind: "image" | "video"; prompt?: [string, string]; mode?: "edit" | "extend" | "reference" };

// Explicit compatibility list. Template prompts come from their existing bindings.
const imageEdit = ["ai-influencer-photo", "character", "character-3", "character-swap", "commercial-faces",
  "edit", "face-swap", "fridge-ad", "headshot", "inpaint", "macro-product", "macro-scene", "packshot",
  "poster", "product-shot", "ugc-shot"];
const ltxVideo = ["asmr-host", "asmr-product", "asmr-whisper", "behind-the-scenes", "speak", "video"];
export function stages(app: App): Stage[] {
  const image = (node: string, field = "value"): Stage => ({ kind: "image", prompt: [node, field] });
  const video = (node: string, field = "value", mode?: Stage["mode"]): Stage => ({ kind: "video", prompt: [node, field], mode });
  if (imageEdit.includes(app.id)) return [image("4", "text")];
  if (ltxVideo.includes(app.id)) return [video("398:376")];
  switch (app.id) {
    case "create-image": case "cinema-studio": case "ai-influencer": return [image("18:17")];
    case "cinema-video": return [image("still:18:17"), video("398:376")];
    case "relight": return [image("15")];
    case "video-t2v": return [video("405:376")];
    case "h3-video": return [video("140:131", "prompt")];
    case "h3-photo": return [video("105:104", "prompt")];
    case "genjutsu": return [video("5508", "value", "reference")];
    case "video-edit": return [{ kind: "video", mode: "edit" }];
    case "extend-video": return [{ kind: "video", mode: "extend" }];
    default: return [];
  }
}

export const imageAspects = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9"];
const pick = (id: string, label: string, values: (string | number)[], defaultValue = values[0]) =>
  ({ id, label, type: "select" as const, default: defaultValue, options: values.map((value) => ({ value, label: String(value) })) });

export function controls(model: Model, stage: Stage, chained = false) {
  const api = models[model].api;
  if (stage.kind === "image") {
    const result = [pick("image_aspect", "Aspect ratio", chained ? ["16:9", "9:16"] : imageAspects)];
    if (api === "openai") result.push(pick("image_quality", "Quality", ["low", "medium", "high"], "medium"));
    else if (!chained) result.push(pick("image_size", "Image size", ["1K", "2K", "4K"]));
    return result;
  }
  const clip = stage.mode === "edit" || stage.mode === "extend";
  const durations = api === "cloud" ? (stage.mode === "reference" ? [8] : [4, 6, 8])
    : Array.from({ length: stage.mode === "extend" ? 8 : 13 }, (_, i) => i + 3);
  return [
    ...(!clip ? [pick("video_aspect", "Aspect ratio", ["16:9", "9:16"])] : []),
    ...(!clip || stage.mode === "extend" ? [pick("video_duration", stage.mode === "extend" ? "Seconds to add" : "Seconds", durations)] : []),
    pick("video_resolution", "Video resolution", api === "cloud" ? ["720p", "1080p"] : ["360p", "720p", "1080p", "4k"], "720p"),
    ...(api === "cloud" ? [pick("video_audio", "Audio", ["on", "off"])] : []),
  ];
}

function configured(api: "gemini" | "openai" | "cloud") {
  if (api === "gemini") return Boolean(process.env.GEMINI_API_KEY?.trim());
  if (api === "openai") return Boolean(process.env.OPENAI_API_KEY?.trim());
  return Boolean(process.env.GOOGLE_CLOUD_PROJECT?.trim());
}
export const allowProviders = () => (process.env.FREEFIELD_HOST || "127.0.0.1") === "127.0.0.1" && !process.env.FREEFIELD_PASSCODE;
export function modelChoices(app: App) {
  if (!allowProviders()) return [];
  const recipe = stages(app);
  return recipe.map((stage) => {
    const choices = (Object.keys(models) as Model[]).filter((id) => models[id].kind === stage.kind &&
      (!["edit", "extend"].includes(stage.mode ?? "") || id === omni));
    return {
      kind: stage.kind,
      native: Boolean(app.workflowPath),
      options: choices.map((id) => ({
        id, label: models[id].label, api: models[id].api, configured: configured(models[id].api),
        controls: controls(id, stage, recipe.length > 1),
      })),
    };
  });
}

export type Selection = Record<string, string | number>;
export function selection(app: App, raw: Values): Selection | undefined {
  const recipe = modelChoices(app);
  const result: Selection = {};
  for (const kind of ["image", "video"]) {
    const key = kind + "_model";
    const choice = raw[key];
    const stage = recipe.find((s) => s.kind === kind);
    if (choice === undefined && (!stage || stage.native)) continue;
    if (choice === "native" && stage?.native) continue;
    const option = stage?.options.find((m) => m.id === (choice ?? omni));
    if (!option) throw new InputError("Choose a supported model for this tool.");
    if (!option.configured) throw new InputError(option.label + " needs server credentials.");
    result[key] = option.id;
    for (const control of option.controls) {
      const value = raw[control.id] ?? control.default;
      const match = control.options.find((o) => String(o.value) === String(value));
      if (!match) throw new InputError(control.label + " is unsupported by " + option.label + ".");
      result[control.id] = match.value;
    }
  }
  if (!Object.keys(result).length) return;
  if (app.id === "cinema-video" && result.image_model && result.video_model && result.image_aspect !== result.video_aspect) {
    throw new InputError("Choose the same aspect ratio for the image and video.");
  }
  if (result.video_resolution === "1080p" && models[result.video_model as Model]?.api === "cloud" && result.video_duration !== 8) {
    throw new InputError("Choose eight seconds for 1080p Veo output.");
  }
  return result;
}

export function stagePrompt(app: App, stage: Stage, values: Values, preset?: string): string {
  if (!stage.prompt) return String(values.prompt ?? "").trim();
  const [node, field] = stage.prompt;
  let prompt = app.graph?.[node]?.inputs[field];
  applyInputs(app, values, { setInput(n, f, v) { if (n === node && f === field) prompt = v; } }, () => undefined, preset);
  if (typeof prompt !== "string" || !prompt.trim()) throw new InputError("Enter a prompt.");
  return prompt.replace(/<ref_image_(\d+)>/g, (_, i: string) => "reference image " + (Number(i) + 1)).trim();
}

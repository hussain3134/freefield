import type { ApiWorkflow, App, Output } from "./registry.ts";
import { applyInputs, InputError, type Values } from "./runner.ts";

type PromptText = { text: string; source?: true };
export type GenerationPrompt = PromptText & {
  stage: Output["type"];
  role?: "negative" | "lyrics";
  reconstructed?: true;
};

function link(value: unknown): string | undefined {
  return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number" ? value[0] : undefined;
}

function workflowText(graph: ApiWorkflow, value: unknown, seen: ReadonlySet<string> = new Set()): PromptText | undefined {
  if (typeof value === "string") return { text: value };
  const id = link(value);
  if (!id || seen.has(id) || !graph[id]) return;
  const { class_type, inputs } = graph[id];
  const path = new Set(seen).add(id);
  const read = (input: unknown) => workflowText(graph, input, path);
  switch (class_type) {
    case "PrimitiveString": case "PrimitiveStringMultiline": return read(inputs.value);
    case "PreviewAny": return read(inputs.source);
    case "ComfySwitchNode": {
      const toggle = typeof inputs.switch === "boolean" ? inputs.switch : graph[link(inputs.switch) ?? ""]?.inputs.value;
      if (typeof toggle === "boolean") return read(toggle ? inputs.on_true : inputs.on_false);
      return;
    }
    case "StringConcatenate": {
      const a = read(inputs.string_a), b = read(inputs.string_b), delimiter = read(inputs.delimiter);
      if (a && b && delimiter) return { text: a.text + delimiter.text + b.text, source: a.source || b.source };
      return;
    }
    case "StringReplace": {
      const input = read(inputs.string), find = read(inputs.find), replacement = read(inputs.replace);
      if (input && find && replacement) return { text: input.text.replaceAll(find.text, () => replacement.text), source: input.source || replacement.source };
      return;
    }
    case "TextGenerate": case "TextGenerateLTX2Prompt": {
      const prompt = read(inputs.prompt);
      if (prompt) return { text: prompt.text, source: true };
    }
  }
}

export function workflowPrompts(app: App, values: Values, preset?: string, stage?: Output["type"], workflow = app.graph): GenerationPrompt[] {
  if (!workflow) return [];
  const graph = Object.fromEntries(Object.entries(workflow).map(([id, node]) => [id, { ...node, inputs: { ...node.inputs } }]));
  try {
    applyInputs(app, values, { setInput(id, field, value) { if (graph[id]) graph[id].inputs[field] = value; } }, () => undefined, preset);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    // Older entries can refer to a preset that has since been removed.
  }

  const prompts: GenerationPrompt[] = [];
  const seen = new Set<string>();
  const negatives = new Set<string>();
  const scan = (id: string, kind: Output["type"]) => {
    if (seen.has(id) || !graph[id]) return;
    seen.add(id);
    const { class_type, inputs, _meta } = graph[id];
    if (class_type === "ConditioningZeroOut") return;
    let negative = link(inputs.negative);
    if (negative && graph[negative]?.class_type === "ReferenceMultiLatent") negative = link(graph[negative].inputs.conditioning);
    if (negative) negatives.add(negative);

    if (!class_type.startsWith("TextGenerate")) for (const field of ["prompt", "caption", "lyrics", ...(class_type === "CLIPTextEncode" ? ["text"] : [])]) {
      const prompt = workflowText(graph, inputs[field]);
      if (!prompt?.text.trim()) continue;
      const role = field === "lyrics" ? "lyrics" : (negatives.has(id) || /negative prompt/i.test(_meta?.title ?? "")) ? "negative" : undefined;
      if (!prompts.some(p => p.stage === kind && p.role === role && p.text === prompt.text)) prompts.push({ ...prompt, stage: kind, ...(role ? { role } : {}) });
    }
    for (const input of Object.values(inputs)) {
      const parent = link(input);
      if (parent) scan(parent, kind);
    }
  };
  const outputs = app.outputs.filter(output => !stage || output.type === stage);
  // Cinema's video also depends on the still. Visit the still first so its prompts keep the image label.
  for (const output of [...outputs].reverse()) scan(output.node, output.type);
  if (!prompts.some(p => !p.role) && outputs.length) {
    // shortcut: generated text assembled from runtime nodes (such as Sound Effects) only exposes the authored input until Comfy reports the generated text.
    for (const input of app.inputs) {
      const text = values[input.id];
      if (input.type === "textarea" && input.bind?.some(bind => seen.has(bind.node)) && typeof text === "string" && text.trim()) {
        prompts.unshift({ text, stage: outputs[0].type, source: true });
      }
    }
  }
  return prompts.sort((a, b) => Number(Boolean(a.role)) - Number(Boolean(b.role)));
}

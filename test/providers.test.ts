import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { History } from "../server/history.ts";
import { ProviderApi, type Media } from "../server/provider-api.ts";
import { runFlow } from "../server/provider-flow.ts";
import { runCodexImageGen } from "../server/provider-codex.ts";
import { modelChoices, omni, selection, stagePrompt, stages } from "../server/provider-models.ts";
import { clipDuration, preserveOutsideMask, ProviderRuns } from "../server/provider-runs.ts";
import { loadRegistry, type ApiWorkflow } from "../server/registry.ts";
import { resolveValues, type FileValue, type Runner } from "../server/runner.ts";

const { apps } = loadRegistry();
const app = (id: string) => apps.find((a) => a.id === id)!;
const banana = "gemini-nano-banana-2.1";
const gpt = "gpt-image-2.6-flare";
const veo = "veo-3.1-fast-generate-001";
const cloud = "https://us-central1-aiplatform.googleapis.com";
const path = "/v1/projects/mock-project/locations/us-central1/publishers/google/models/" + veo;
const operation = path.slice(4) + "/operations/mock";
const gemini = "https://generativelanguage.googleapis.com";
const noComfy = () => { assert.fail("An API-only run contacted ComfyUI."); };
const fakeFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  (async (url, init) => handler(String(url), init ?? {})) as typeof fetch;
const ctx = () => ({ signal: new AbortController().signal, record: () => {} });
const asB64 = (media: Media) => Buffer.from(media.bytes).toString("base64");
const geminiOutput = (img: Media) => Response.json({ status: "completed", steps: [
  { type: "thought", content: [] },
  { type: "model_output", content: [{ type: "image", mime_type: img.type, data: asB64(img) }] },
], usage: { total_tokens: 1 } });

function box(type: string, contents = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(contents.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, contents]);
}

function clip(seconds: number): Media {
  const header = Buffer.alloc(20);
  header.writeUInt32BE(1000, 12);
  header.writeUInt32BE(seconds * 1000, 16);
  return { type: "video/mp4", name: "clip.mp4",
    bytes: Buffer.concat([box("ftyp", Buffer.from("isom")), box("moov", box("mvhd", header))]) };
}

const image = async (rgb = [1, 2, 3, 4, 5, 6]): Promise<Media> => ({
  type: "image/png", name: "image.png",
  bytes: await sharp(Buffer.from(rgb), { raw: { width: 2, height: 1, channels: 3 } }).png().toBuffer(),
});

function credentials(t: import("node:test").TestContext) {
  const fixtures = { GEMINI_API_KEY: "mock", OPENAI_API_KEY: "mock", GOOGLE_CLOUD_PROJECT: "mock-project",
    GOOGLE_CLOUD_LOCATION: "us-central1", FREEFIELD_HOST: "127.0.0.1", FREEFIELD_PASSCODE: "",
    FREEFIELD_STUDIOWRIGHT_PYTHON: "", FREEFIELD_CODEX_BIN: "", FREEFIELD_ALLOWED_HOSTS: "", FREEFIELD_WMR_BIN: "" };
  const old = Object.fromEntries(Object.keys(fixtures).map((key) => [key, process.env[key]]));
  Object.assign(process.env, fixtures);
  t.after(() => {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
}

function testHistory(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "freefield-providers-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, history: new History(dir) };
}

test("mapped prompt bindings and presets resolve without a ComfyUI request", () => {
  for (const a of apps) {
    const recipe = stages(a);
    if (!recipe.length) continue;
    const values = resolveValues(a, Object.fromEntries(a.inputs.filter((input) => input.required)
      .map((input) => [input.id, input.type === "image" || input.type === "video" ? clip(1) : "Prompt fixture"])));
    for (const stage of recipe) {
      if (stage.prompt) assert.ok(Object.hasOwn(a.graph![stage.prompt[0]].inputs, stage.prompt[1]), a.id);
      for (const preset of [undefined, ...(a.presets ?? []).map((p) => p.id)]) {
        assert.ok(stagePrompt(a, stage, values, preset), a.id);
      }
    }
  }
});

test("model selection validates credentials, tool compatibility, and paired settings", (t) => {
  credentials(t);
  assert.equal(selection(app("cinema-video"), {}), undefined);
  assert.equal(selection(app("video-edit"), {})?.video_model, omni);
  assert.throws(() => selection(app("video-edit"), { video_model: veo }), /supported model/);
  assert.throws(() => selection(app("cinema-video"), { image_model: gpt, video_model: veo, image_aspect: "9:16" }), /same aspect/);
  assert.throws(() => selection(app("video-t2v"), { video_model: veo, video_resolution: "1080p" }), /eight seconds/);
  delete process.env.GEMINI_API_KEY;
  assert.throws(() => selection(app("video-edit"), {}), /credentials/);
  process.env.FREEFIELD_HOST = "0.0.0.0";
  assert.throws(() => selection(app("create-image"), { image_model: gpt }), /supported model/);
});

test("Music defaults to its native graph and validates Lyria choices", (t) => {
  credentials(t);
  const music = app("music");
  const native = { style: "Cumbia", lyrics: "A new song", seconds: 45, seed: 1234 };
  assert.equal(selection(music, native), undefined);
  assert.deepEqual(resolveValues(music, native), native);
  assert.throws(() => selection(music, { reference_image: {} }), /Reference image requires a hosted model/);
  assert.throws(() => selection(app("sfx"), { audio_model: "lyria-3.5" }), /supported model/);
  assert.throws(() => selection(music, { audio_model: "lyria-3.5", audio_vocals: "unsupported" }), /Vocals is unsupported/);
  delete process.env.GEMINI_API_KEY;
  assert.throws(() => selection(music, { audio_model: "lyria-3.5" }), /needs server credentials/);
});

test("opt-in watermark removal shows the cleaned Google output first and retains the original", async (t) => {
  credentials(t);
  process.env.FREEFIELD_WMR_BIN = process.execPath;
  const { history } = testHistory(t);
  const create = app("create-image");
  const original = await image();
  const edited = Buffer.from((await image([6, 5, 4, 3, 2, 1])).bytes);
  let passes = 0;
  const runners = new ProviderRuns(history, apps, noComfy, new ProviderApi(fakeFetch(() => geminiOutput(original))),
    undefined, async (bin, bytes, type, profile, force) => {
      passes++;
      assert.equal(bin, process.execPath);
      assert.deepEqual(bytes, original.bytes);
      assert.equal(type, "image/png");
      assert.equal(profile, "auto");
      assert.equal(force, false);
      if (passes === 2) throw new Error("WMR failure");
      return { type, bytes: edited };
    });
  const values = { prompt: "Watermarked output", image_model: banana };
  async function run(enabled: "on" | "off") {
    const options = selection(create, { ...values, image_auto_watermark: enabled })!;
    return (await runners.start(create, values, options)).done;
  }
  const cleaned = await run("on");
  assert.equal(cleaned.status, "succeeded");
  assert.equal(cleaned.pipeline?.stages[0].watermark, "cleaned");
  assert.deepEqual(cleaned.outputs.map(output => readFileSync(history.file(cleaned.id, output.file)!)), [edited, original.bytes]);
  const skipped = await run("off");
  assert.equal(skipped.outputs.length, 1);
  assert.equal(passes, 1);
  const failed = await run("on");
  assert.equal(failed.status, "succeeded");
  assert.equal(failed.outputs.length, 1);
  assert.equal(failed.pipeline?.stages[0].watermark, "failed");
  assert.equal(selection(create, { ...values, image_model: gpt, image_auto_watermark: "on" })?.image_auto_watermark, undefined);
});

test("Codex ImageGen is opt-in and only offered for compatible local image tools", (t) => {
  credentials(t);
  const codex = "codex-imagegen";
  const choices = (id: string) => modelChoices(app(id)).flatMap(stage => stage.options.map(option => option.id));
  assert.ok(!choices("create-image").includes(codex));
  process.env.FREEFIELD_CODEX_BIN = process.execPath;
  assert.equal(selection(app("create-image"), { image_model: codex })?.image_model, codex);
  assert.ok(choices("edit").includes(codex));
  for (const id of ["inpaint", "face-swap", "cinema-video"]) assert.ok(!choices(id).includes(codex), id);
  assert.ok(choices("create-image").includes(gpt));
  process.env.FREEFIELD_ALLOWED_HOSTS = "freefield.example.test";
  assert.ok(!choices("create-image").includes(codex));
  delete process.env.FREEFIELD_ALLOWED_HOSTS;
  process.env.FREEFIELD_PASSCODE = "configured";
  assert.ok(!choices("create-image").includes(codex));
});

test("Codex ImageGen stages references and accepts only a generated PNG", async (t) => {
  credentials(t);
  process.env.FREEFIELD_CODEX_BIN = process.execPath;
  const reference = await image();
  const input = { model: "codex-imagegen", stage: { kind: "image" }, prompt: "A blue cup", files: [reference],
    options: { image_aspect: "1:1" } } as const;
  const request = { ...input, files: [reference] };
  const signal = new AbortController().signal;
  const result = await runCodexImageGen(request, signal, async (bin, dir, prompt, refs) => {
    assert.equal(bin, process.execPath);
    assert.match(prompt, /^\$imagegen.*1:1.*\n\nA blue cup/s);
    assert.deepEqual(refs, [join(dir, "reference-1.png")]);
    assert.deepEqual(readFileSync(refs[0]), reference.bytes);
    return { sessionId: "", item: { type: "imageGeneration", status: "completed", result: asB64(reference) } };
  });
  assert.deepEqual(result.media, { ...reference, name: "codex-imagegen.png" });
  await assert.rejects(runCodexImageGen(request, signal, async () => ({ sessionId: "", item: {
    type: "imageGeneration", status: "completed", savedPath: process.execPath,
  } })), /did not return a saved image/);
});

test("Lyria sends style, lyrics and optional image to Gemini, and History serves the resulting MP3", async (t) => {
  credentials(t);
  const { history } = testHistory(t);
  const music = app("music");
  const mp3 = readFileSync(new URL("../web/examples/music/full.mp3", import.meta.url));
  const reference = await image();
  const requests: Record<string, any>[] = [];
  const api = new ProviderApi(fakeFetch((url, init) => {
    assert.equal(url, gemini + "/v1beta/interactions");
    assert.equal(new Headers(init.headers).get("x-goog-api-key"), "mock");
    assert.equal(new Headers(init.headers).get("api-revision"), "2026-05-20");
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.response_format, { type: "audio" });
    requests.push(body);
    return Response.json({ status: "completed", steps: [
      { type: "model_output", content: [{ type: "text", text: "Lyrics" }] },
      { type: "model_output", content: [{ type: "audio", mime_type: "audio/mp3", data: mp3.toString("base64") }] },
    ] });
  }));
  const runners = new ProviderRuns(history, apps, noComfy, api);
  const cases = [
    { audio_model: "lyria-3.5", style: "Acoustic folk for an autumn evening" },
    { audio_model: "lyria-3.5", style: "Jazz", lyrics: "[Chorus]\nSweet as honey", reference_image: reference },
    { audio_model: "lyria-3-clip-preview", audio_vocals: "instrumental", style: "Bright piano", lyrics: "Should be omitted" },
  ];
  for (const values of cases) {
    const options = selection(music, values)!;
    const { entry, done } = await runners.start(music, values, options);
    assert.equal((await done).status, "succeeded");
    const saved = history.get(entry.id)!;
    assert.equal(saved.pipeline?.selection.audio_model, values.audio_model);
    assert.equal(saved.pipeline?.stages[0].kind, "audio");
    assert.deepEqual(saved.generationPrompts, [{ stage: "audio", text: requests.at(-1)!.input.at(-1).text }]);
    assert.equal(saved.outputs[0].type, "audio");
    assert.equal(saved.outputs[0].file, "out-01.mp3");
    assert.deepEqual(readFileSync(history.file(entry.id, saved.outputs[0].file)!), mp3);
    assert.equal(saved.values.seed, undefined);
    assert.equal(saved.values.seconds, undefined);
    assert.equal(saved.values.lyrics, options.audio_vocals === "instrumental" ? undefined : values.lyrics ?? "");
    if (values.reference_image) {
      assert.equal(saved.inputs[0].id, "reference_image");
      assert.deepEqual((history.runValues(entry).reference_image as FileValue).bytes, reference.bytes);
    }
  }
  assert.deepEqual(requests.map((r) => r.model), cases.map((c) => c.audio_model));
  assert.deepEqual(requests[0].input, [{ type: "text", text: cases[0].style }]);
  assert.deepEqual(requests[1].input[0], { type: "image", mime_type: "image/png", data: asB64(reference) });
  assert.match(requests[1].input[1].text, /\[Chorus\]\nSweet as honey/);
  assert.match(requests[1].input[1].text, /reference image/);
  assert.match(requests[2].input[0].text, /Instrumental only, no vocals/);
  assert.doesNotMatch(requests[2].input[0].text, /Should be omitted/);
});

test("Lyria rejects malformed images before submission and preserves provider errors in History", async (t) => {
  credentials(t);
  const { history } = testHistory(t);
  const music = app("music");
  const values = { audio_model: "lyria-3.5", style: "lo-fi piano" };
  const options = selection(music, values)!;
  let requests = 0;
  const api = new ProviderApi(fakeFetch(() => {
    requests++;
    return new Response(null, { status: 429 });
  }));
  const runners = new ProviderRuns(history, apps, noComfy, api);
  const badImage = { name: "invalid.png", bytes: Buffer.from("not an image") };
  await assert.rejects(runners.start(music, { ...values, reference_image: badImage }, options), /Upload a still PNG/);
  assert.equal(requests, 0);
  const { entry, done } = await runners.start(music, values, options);
  assert.equal((await done).status, "failed");
  assert.match(history.get(entry.id)!.error!.message, /Gemini rate limit or quota/);
  assert.equal(requests, 1);
});

test("StudioWright model choices are local and omit capabilities Flow cannot provide", (t) => {
  credentials(t);
  assert.throws(() => selection(app("product-shot"), { image_model: "flow-nano-banana-pro" }), /local StudioWright/);
  process.env.FREEFIELD_STUDIOWRIGHT_PYTHON = process.execPath;
  assert.equal(selection(app("product-shot"), { image_model: "flow-nano-banana-pro" })?.image_model, "flow-nano-banana-pro");
  assert.throws(() => selection(app("inpaint"), { image_model: "flow-nano-banana-pro" }), /supported model/);
  assert.throws(() => selection(app("video-edit"), { video_model: "flow-omni-1.2" }), /supported model/);
  assert.throws(() => selection(app("music"), { audio_model: "flow-lyria-3.5", reference_image: {} }), /reference image/);
  process.env.FREEFIELD_HOST = "0.0.0.0";
  assert.throws(() => selection(app("music"), { audio_model: "flow-lyria-3.5" }), /supported model/);
});

test("StudioWright stages use local references and lyrics, with prompt passed as a single argument", async (t) => {
  credentials(t);
  process.env.FREEFIELD_STUDIOWRIGHT_PYTHON = process.execPath;
  const photo = await image();
  const mp3 = readFileSync(new URL("../web/examples/music/full.mp3", import.meta.url));
  const prompt = "--model other & literal prompt";
  const imageResult = await runFlow({
    model: "flow-nano-banana-pro", stage: { kind: "image" }, prompt, options: { image_aspect: "1:1" }, files: [photo],
  }, ctx().signal, async (python, args) => {
    assert.equal(python, process.execPath);
    assert.deepEqual(args.slice(0, 3), ["image", "--count", "1"]);
    assert.equal(args[args.indexOf("--model") + 1], "nano-banana-pro");
    assert.deepEqual(args.slice(-2), ["--", prompt]);
    assert.deepEqual(readFileSync(args[args.indexOf("--ref") + 1]), photo.bytes);
    const file = join(args[args.indexOf("--out") + 1], "image.png");
    writeFileSync(file, photo.bytes);
    return JSON.stringify({ files: [file] });
  });
  assert.deepEqual(imageResult.media.bytes, photo.bytes);

  const musicResult = await runFlow({
    model: "flow-lyria-3.5", stage: { kind: "audio" }, prompt: "Jazz", options: {}, files: [], lyrics: "Golden light",
  }, ctx().signal, async (_python, args) => {
    assert.deepEqual(args.slice(0, 4), ["music", "create", "--format", "mp3"]);
    assert.equal(readFileSync(args[args.indexOf("--lyrics-file") + 1], "utf8"), "Golden light");
    writeFileSync(join(args[args.indexOf("--out") + 1], "track.mp3"), mp3);
    return JSON.stringify({ files: ["track.mp3"] });
  });
  assert.equal(musicResult.media.type, "audio/mpeg");
  assert.deepEqual(musicResult.media.bytes, mp3);
});

test("StudioWright submits clips only after an in-budget quote and rejects files outside the run", async (t) => {
  credentials(t);
  process.env.FREEFIELD_STUDIOWRIGHT_PYTHON = process.execPath;
  const input = {
    model: "flow-omni-1.2", stage: { kind: "video" }, prompt: "Camera tracks left", files: [],
    options: { video_aspect: "16:9", video_credit_limit: 10, video_duration: 4, video_resolution: "360p" },
  } as const;
  for (const credits of [null, 11]) {
    await assert.rejects(runFlow({ ...input, files: [] }, ctx().signal, async (_python, args) => {
      assert.ok(args.includes("--dry-run"));
      return JSON.stringify({ submitted: false, credits });
    }), credits === null ? /price could not be read/ : /above this run's limit/);
  }
  let calls = 0;
  await assert.rejects(runFlow({ ...input, files: [] }, ctx().signal, async (_python, args) => {
    calls++;
    if (calls === 1) {
      assert.ok(args.includes("--dry-run"));
      return JSON.stringify({ submitted: false, credits: 4 });
    }
    assert.equal(args[args.indexOf("--max-credits") + 1], "4");
    assert.equal(args.includes("--dry-run"), false);
    return JSON.stringify({ files: [process.execPath] });
  }), /unexpected file location/);
  assert.equal(calls, 2);
});

test("GPT Image sends JSON generations and multipart reference edits with a mask", async (t) => {
  credentials(t);
  const img = await image();
  let calls = 0;
  const api = new ProviderApi(fakeFetch((url, init) => {
    calls++;
    if (calls === 1) {
      assert.equal(url, "https://api.openai.com/v1/images/generations");
      const body = JSON.parse(String(init.body));
      assert.equal(body.model, gpt);
      assert.equal(body.size, "1024x1024");
    } else {
      assert.equal(url, "https://api.openai.com/v1/images/edits");
      const form = init.body as FormData;
      assert.equal(form.getAll("image[]").length, 2);
      assert.equal((form.get("mask") as File).type, "image/png");
    }
    return Response.json({ data: [{ b64_json: asB64(img) }] });
  }));
  const input = { model: gpt, stage: { kind: "image" }, prompt: "Change the background",
    options: { image_aspect: "1:1", image_quality: "medium" }, files: [] } as const;
  await api.run({ ...input, files: [] }, ctx());
  assert.deepEqual((await api.run({ ...input, files: [img, img], mask: img }, ctx())).media.bytes, img.bytes);
  assert.equal(calls, 2);
});

test("Omni uploads the source clip, polls the video job and downloads the result", async (t) => {
  credentials(t);
  const video = clip(4);
  assert.equal(clipDuration(video), 4);
  assert.throws(() => clipDuration({ ...video, bytes: video.bytes.slice(0, 12) }), /duration/);
  const routes: string[] = [];
  const api = new ProviderApi(fakeFetch((url, init) => {
    assert.equal(new URL(url).origin, gemini);
    const endpoint = new URL(url).pathname;
    routes.push(endpoint);
    switch (endpoint) {
      case "/upload/v1beta/files": return new Response(null, { headers: { "X-Goog-Upload-URL": gemini + "/upload/mock" } });
      case "/upload/mock":
        assert.deepEqual(init.body, video.bytes);
        return Response.json({ file: { name: "files/source" } });
      case "/v1beta/files/source": return Response.json({ state: "ACTIVE", uri: gemini + "/v1beta/files/source" });
      case "/v1beta/interactions": {
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body.input, [{ type: "video", uri: gemini + "/v1beta/files/source" },
          { type: "text", text: "Extend this video. Keep walking" }]);
        assert.deepEqual(body.response_format, { type: "video", delivery: "uri", resolution: "720p", duration: "3s" });
        return Response.json({ id: "mock-extension", status: "in_progress" });
      }
      case "/v1beta/interactions/mock-extension": return Response.json({ status: "completed", steps: [
        { type: "model_output", content: [{ type: "video", uri: gemini + "/v1beta/files/result:download?alt=media" }] },
      ] });
      case "/v1beta/files/result": return Response.json({ state: "ACTIVE" });
      case "/v1beta/files/result:download":
        return Response.redirect(gemini + "/download/v1beta/files/result:download?alt=media");
      case "/download/v1beta/files/result:download": return new Response(Buffer.from(video.bytes));
      default: assert.fail(endpoint);
    }
  }), undefined, 1);
  const ids: string[] = [];
  const response = await api.run({ model: omni, stage: { kind: "video", mode: "extend" }, prompt: "Keep walking",
    files: [video], options: { video_duration: 3, video_resolution: "720p" } }, { ...ctx(), record: (op) => ids.push(op.id) });
  assert.deepEqual(ids, ["mock-extension"]);
  assert.deepEqual(response.media.bytes, video.bytes);
  assert.equal(routes.length, 8);
});

test("masked edits preserve original pixels outside the mask, including grayscale inputs", async () => {
  const original = await image([15, 15, 15, 80, 80, 80]);
  const mask = await image([0, 0, 0, 255, 255, 255]);
  const gray = await sharp(original.bytes).toColourspace("b-w").png().toBuffer();
  const output = await preserveOutsideMask({ ...original, bytes: gray }, mask, await image([255, 30, 20, 35, 45, 55]));
  assert.deepEqual([...await sharp(output.bytes).raw().toBuffer()], [15, 15, 15, 255, 35, 45, 55, 255]);
});

test("Cinema retries an unfinished Veo stage using the saved Nano Banana still", async (t) => {
  credentials(t);
  const { history } = testHistory(t);
  const still = await image();
  const video = clip(4);
  let stillRequests = 0, videoRequests = 0;
  const api = new ProviderApi(fakeFetch((url, init) => {
    if (url === gemini + "/v1beta/interactions") {
      stillRequests++;
      assert.equal(new Headers(init.headers).get("api-revision"), "2026-05-20");
      const body = JSON.parse(String(init.body));
      assert.equal(body.model, banana);
      assert.match(body.input[0].text, /The boat sails away/);
      return geminiOutput(still);
    }
    if (url === cloud + path + ":predictLongRunning") {
      videoRequests++;
      const body = JSON.parse(String(init.body));
      assert.match(body.instances[0].prompt, /first frame/);
      assert.equal(body.instances[0].image.bytesBase64Encoded, asB64(still));
      if (videoRequests === 1) return new Response(null, { status: 429 });
      return Response.json({ name: operation });
    }
    assert.equal(url, cloud + path + ":fetchPredictOperation");
    assert.deepEqual(JSON.parse(String(init.body)), { operationName: operation });
    return Response.json({ done: true, response: { videos: [{ bytesBase64Encoded: asB64(video) }] } });
  }), async () => "mock", 1);
  const runners = new ProviderRuns(history, apps, noComfy, api);
  const cinema = app("cinema-video");
  const options = selection(cinema, { image_model: banana, video_model: veo })!;
  const first = await runners.start(cinema, { prompt: "The boat sails away" }, options);
  await first.done;
  const failed = history.get(first.entry.id)!;
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.generationPrompts.map(p => p.stage), ["image", "video"]);
  assert.match(failed.generationPrompts[1].text, /^Use the supplied image as the first frame\./);
  const second = await runners.retry(first.entry.id);
  await second.done;
  const result = history.get(second.entry.id)!;
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.generationPrompts, failed.generationPrompts);
  assert.deepEqual(result.outputs.map((o) => o.type), ["video", "image"]);
  assert.equal(stillRequests, 1);
  assert.equal(videoRequests, 2);
});

test("Cinema mixes provider and ComfyUI stages in either direction", async (t) => {
  credentials(t);
  const oldBackend = process.env.COMFY_BASE_URL;
  process.env.COMFY_BASE_URL = "http://127.0.0.1:1";
  t.after(() => { if (oldBackend === undefined) delete process.env.COMFY_BASE_URL; else process.env.COMFY_BASE_URL = oldBackend; });
  const { history } = testHistory(t);
  const still = await image();
  const video = clip(4);
  const nativeStages: string[] = [];
  const runner = { async submitStage(_app: unknown, graph: ApiWorkflow, values: Record<string, unknown>, assets: Record<string, FileValue>) {
    assert.equal(values.aspect, "9:16 (Portrait Widescreen)");
    const stillStage = Boolean(graph["still:9"]);
    assert.equal(Boolean(graph["75"]), !stillStage);
    if (!stillStage) {
      assert.deepEqual(graph["398:351"].inputs.input, ["provider_still", 0]);
      assert.deepEqual(assets.provider_still.bytes, still.bytes);
    }
    const media = stillStage ? still : video;
    nativeStages.push(stillStage ? "image" : "video");
    return { id: "mock-comfy", status: "succeeded", wait() {}, getOutputs(node: string) {
      assert.equal(node, stillStage ? "still:9" : "75");
      return [{ toBytes: () => media.bytes, contentType: media.type, name: media.name }];
    } };
  } } as unknown as Runner;
  const api = new ProviderApi(fakeFetch((url, init) => {
    if (url === gemini + "/v1beta/interactions") return geminiOutput(still);
    if (url === cloud + path + ":predictLongRunning") {
      assert.equal(JSON.parse(String(init.body)).instances[0].image.bytesBase64Encoded, asB64(still));
      return Response.json({ name: operation });
    }
    assert.equal(url, cloud + path + ":fetchPredictOperation");
    return Response.json({ done: true, response: { videos: [{ bytesBase64Encoded: asB64(video) }] } });
  }), async () => "mock", 1);
  const runs = new ProviderRuns(history, apps, () => runner, api);
  const cinema = app("cinema-video");
  for (const options of [{ image_model: banana, image_aspect: "9:16" }, { video_model: veo, video_aspect: "9:16" }]) {
    const run = await runs.start(cinema, {}, selection(cinema, options)!);
    await run.done;
    const result = history.get(run.entry.id)!;
    assert.equal(result.status, "succeeded", result.error?.message ?? "");
    assert.deepEqual([...new Set(result.generationPrompts.map(p => p.stage))], ["image", "video"]);
    assert.equal(result.generationPrompts.some(p => p.stage === "video" && p.role === "negative"), "image_model" in options);
  }
  assert.deepEqual(nativeStages, ["video", "image"]);
});

test("a saved Veo operation resumes without a second submission", async (t) => {
  credentials(t);
  const { history, dir } = testHistory(t);
  const a = app("video-t2v");
  const entry = history.start(a, resolveValues(a, { prompt: "A still lake" }), undefined, undefined, {
    selection: selection(a, { video_model: veo })!,
    stages: [{ kind: "video", status: "submitting", operation: { id: operation, model: veo } }],
  });
  const restarted = new History(dir);
  const api = new ProviderApi(fakeFetch((url) => {
    assert.equal(url, cloud + path + ":fetchPredictOperation");
    return Response.json({ done: true, response: { videos: [{ bytesBase64Encoded: asB64(clip(4)) }] } });
  }), async () => "mock");
  const runs = new ProviderRuns(restarted, apps, noComfy, api);
  await runs.resume(restarted.readForRun(entry.id)!);
  assert.equal(restarted.readForRun(entry.id)?.status, "succeeded");
});

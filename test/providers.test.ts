import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { History } from "../server/history.ts";
import { ProviderApi, type Media } from "../server/provider-api.ts";
import { omni, selection, stagePrompt, stages } from "../server/provider-models.ts";
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
    GOOGLE_CLOUD_LOCATION: "us-central1", FREEFIELD_HOST: "127.0.0.1", FREEFIELD_PASSCODE: "" };
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
  assert.equal((await first.done).status, "failed");
  const second = await runners.retry(first.entry.id);
  const result = await second.done;
  assert.equal(result.status, "succeeded");
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
    const result = await run.done;
    assert.equal(result.status, "succeeded", result.error?.message ?? "");
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

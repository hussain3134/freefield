import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import sharp from "sharp";
import { cleanWatermark } from "../server/watermark.ts";

const signal = new AbortController().signal;

test("WMR runs the visible image command on temporary files and returns PNG", async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } }).png().toBuffer();
  const result = await cleanWatermark("test-wmr", png, "image/png", "legacy", false, signal, async (_, args) => {
    assert.deepEqual(args.map(arg => basename(arg)), ["remove", "input.png", "-o", "clean.png", "--keep-provenance", "--no-progress", "--legacy"]);
    assert.deepEqual(await readFile(args[1]), png);
    await writeFile(args[3], png);
    return { stdout: "Saved", stderr: "" };
  });
  assert.deepEqual(result, { type: "image/png", bytes: png });
  const noMark = await cleanWatermark("test-wmr", png, "image/png", "auto", false, signal,
    async () => ({ stdout: "No watermarks found or removed", stderr: "" }));
  assert.equal(noMark, undefined);
});

test("WMR rejects a disguised or truncated upload before starting the executable", async () => {
  const never = async () => { throw new Error("Should not invoke WMR"); };
  await assert.rejects(cleanWatermark("test-wmr", Buffer.from([0]), "video/webm", "auto", false, signal, never), /video format/);
  await assert.rejects(cleanWatermark("test-wmr", Buffer.from([0]), "image/jpeg", "auto", false, signal, never), /file type/);
});

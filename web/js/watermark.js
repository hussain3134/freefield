import { el, icon } from "./util.js";
import { t } from "./i18n.js";

const types = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
let queuedFile;
export function openWatermark(file) {
  queuedFile = file;
  location.hash = "#/watermark";
}

export function watermarkView() {
  const abort = new AbortController();
  const source = el("input", { type: "file", accept: ".png,.jpg,.jpeg,.webp,.mp4,.mov,.webm" });
  const profile = el("select", {}, el("option", { value: "auto" }, "Automatic"), el("option", { value: "legacy" }, "Legacy watermark"));
  const force = el("input", { type: "checkbox" });
  const status = el("p", { class: "help", role: "status" });
  const clean = el("button", { class: "btn lime", type: "submit", disabled: true }, "Remove watermark");
  const save = el("a", { class: "btn ghost", hidden: true }, icon("download"), "Download");
  const original = el("figure", { class: "card", hidden: true }, el("figcaption", {}, "Original"));
  const cleaned = el("figure", { class: "card", hidden: true }, el("figcaption", {}, "Cleaned"));
  const form = el("form", { class: "card wm-panel" },
    el("label", { class: "field" }, el("span", { class: "lbl" }, "Image or video"), source),
    el("fieldset", { class: "wm-controls" },
      el("label", { class: "field" }, el("span", { class: "lbl" }, "Watermark profile"), profile),
      el("label", {}, force, " Use the standard position"), clean, save), status);
  const node = el("div", { class: "page wm-page" },
    el("h1", { class: "display" }, t("watermark.title")),
    el("p", { class: "dim" }, "Remove visible Gemini and Veo watermarks with froggeric's WMR on your Freefield server."),
    el("div", { class: "wm-layout" }, form, el("div", { class: "wm-preview" }, original, cleaned)));

  let file, type, inputUrl, outputUrl;
  function clearResult() {
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = undefined;
    cleaned.querySelector("img, video")?.remove();
    cleaned.hidden = save.hidden = true;
    save.removeAttribute("href");
  }

  function preview(figure, url, mediaType, label) {
    const media = mediaType.startsWith("video/") ? el("video", { src: url, controls: true, playsinline: true, preload: "metadata", "aria-label": label })
      : el("img", { src: url, alt: label });
    figure.replaceChildren(figure.firstElementChild, media);
    figure.hidden = false;
  }

  function select(selected) {
    if (inputUrl) URL.revokeObjectURL(inputUrl);
    clearResult();
    original.hidden = true;
    file = undefined;
    clean.disabled = true;
    type = types[selected.name.split(".").pop().toLowerCase()] ?? selected.type;
    if (!Object.values(types).includes(type) || !selected.size || selected.size > 100 * 2 ** 20) {
      status.textContent = "Choose a supported image or video up to 100 MiB.";
      return;
    }
    file = selected;
    inputUrl = URL.createObjectURL(file);
    preview(original, inputUrl, type, "Original upload");
    clean.disabled = false;
    status.textContent = file.name;
  }

  source.addEventListener("change", () => { if (source.files[0]) select(source.files[0]); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!file || clean.disabled) return;
    clearResult();
    source.disabled = profile.disabled = force.disabled = clean.disabled = true;
    form.setAttribute("aria-busy", "true");
    status.textContent = "WMR is processing this file.";
    try {
      const params = new URLSearchParams({ profile: profile.value, force: force.checked ? "1" : "0" });
      const response = await fetch("/api/watermark?" + params, { method: "POST", headers: { "content-type": type }, body: file, signal: abort.signal });
      if (!response.ok) throw new Error((await response.json()).error || "Could not process the file.");
      const blob = await response.blob();
      abort.signal.throwIfAborted();
      outputUrl = URL.createObjectURL(blob);
      preview(cleaned, outputUrl, blob.type, "Cleaned result");
      save.href = outputUrl;
      save.download = file.name.replace(/\.[^.]+$/, "") + (blob.type === "video/mp4" ? "-cleaned.mp4" : "-cleaned.png");
      save.hidden = false;
      status.textContent = "Cleaned copy ready to download.";
    } catch (error) {
      if (!abort.signal.aborted) status.textContent = error.message || "Could not process the file.";
    } finally {
      source.disabled = profile.disabled = force.disabled = clean.disabled = false;
      form.removeAttribute("aria-busy");
    }
  });

  if (queuedFile) { const input = queuedFile; queuedFile = undefined; select(input); }
  return { node, active: "watermark", dispose() {
    abort.abort();
    if (inputUrl) URL.revokeObjectURL(inputUrl);
    if (outputUrl) URL.revokeObjectURL(outputUrl);
  } };
}

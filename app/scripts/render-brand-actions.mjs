// Reproduce four handless composites without a generation service or new dependency.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  additionalActions,
  renderAdditionalAction,
} from "./brand-video/additional-actions.mjs";

const output = process.env.MYCO_VIDEO_OUTPUT;
const source = process.env.MYCO_KEYED_SOURCE;
const note = process.env.MYCO_NOTE_PROP;
if (!output || !source || !note) {
  throw new Error(
    "Set MYCO_VIDEO_OUTPUT, MYCO_KEYED_SOURCE, and MYCO_NOTE_PROP. See docs/myco-video.md.",
  );
}
const selection = process.argv.slice(2);
if (
  selection.some(
    (id) => !additionalActions.some((variant) => variant.id === id),
  )
) {
  throw new Error(
    "Unknown action. Use inspecting, idea, greeting, or organizing.",
  );
}
const actions = additionalActions.filter(
  (variant) => selection.length === 0 || selection.includes(variant.id),
);
const work = await mkdtemp(path.join(tmpdir(), "myco-additional-actions-"));
async function run(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`${command} exited ${code}:\n${errors}`);
}
await Promise.all(
  ["clips", "posters", "production"].map((folder) =>
    mkdir(path.join(output, folder), { recursive: true }),
  ),
);
await run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-i",
  source,
  "-vf",
  "crop=834:834:139:0,scale=720:720:flags=lanczos,format=rgba",
  "-frames:v",
  "96",
  "-threads",
  "2",
  path.join(work, "%03d.png"),
]);
const frames = await Promise.all(
  Array.from({ length: 96 }, async (_, index) => {
    const contents = await readFile(
      path.join(work, `${String(index + 1).padStart(3, "0")}.png`),
    );
    return `data:image/png;base64,${contents.toString("base64")}`;
  }),
);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(
    '<!doctype html><canvas width="768" height="768"></canvas>',
  );
  await page.evaluate(
    async ({ frames, note }) => {
      const decode = async (url) => {
        const frame = new Image();
        frame.src = url;
        await frame.decode();
        return frame;
      };
      window.mycoFrames = await Promise.all(frames.map(decode));
      window.mycoNote = await decode(note);
    },
    {
      frames,
      note: `data:image/png;base64,${(await readFile(note)).toString("base64")}`,
    },
  );
  for (const variant of actions) {
    const frameDir = path.join(work, variant.id);
    await mkdir(frameDir);
    for (let frame = 0; frame < 120; frame++) {
      const png = Buffer.from(
        await page.evaluate(renderAdditionalAction, {
          variant: variant.id,
          frame,
          fps: 24,
        }),
        "base64",
      );
      await writeFile(
        path.join(frameDir, `${String(frame).padStart(3, "0")}.png`),
        png,
      );
      if (frame === variant.posterFrame)
        await writeFile(path.join(output, "posters", `${variant.id}.png`), png);
    }
    const target = path.join(output, "clips", variant.id);
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      "24",
      "-i",
      path.join(frameDir, "%03d.png"),
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4",
      "-pix_fmt",
      "yuva444p10le",
      "-alpha_bits",
      "16",
      "-threads",
      "2",
      "-an",
      `${target}.mov`,
    ]);
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      `${target}.mov`,
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-b:v",
      "0",
      "-crf",
      "24",
      "-deadline",
      "good",
      "-cpu-used",
      "3",
      "-threads",
      "2",
      "-an",
      `${target}.webm`,
    ]);
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      `${target}.mov`,
      "-filter_complex",
      "color=c=0xF6F3EF:s=768x768:r=24:d=5[bg];[bg][0:v]overlay=shortest=1:format=auto,format=yuv420p[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-crf",
      "19",
      "-preset",
      "medium",
      "-threads",
      "2",
      "-movflags",
      "+faststart",
      "-an",
      `${target}.mp4`,
    ]);
    if (process.platform === "darwin") {
      await run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        `${target}.mov`,
        "-vf",
        "format=bgra",
        "-c:v",
        "hevc_videotoolbox",
        "-alpha_quality",
        "1",
        "-b:v",
        "4M",
        "-tag:v",
        "hvc1",
        "-an",
        `${target}-hevc.mov`,
      ]);
    }
    console.log(
      `Rendered ${variant.id}: 5s, 768x768, 24fps, silent, WebM/ProRes/HEVC alpha and ivory MP4.`,
    );
  }
  const hash = async (filename) =>
    createHash("sha256")
      .update(await readFile(filename))
      .digest("hex");
  const manifest = {
    version: 1,
    method:
      "Original handless character footage with authored Canvas props and one whole-footage greeting transform. No newly generated character acting.",
    keyedSourceSha256: await hash(source),
    notePropSha256: await hash(note),
    width: 768,
    height: 768,
    fps: 24,
    audio: false,
    characterRules: {
      hands: 0,
      arms: 0,
      companion:
        "Exactly one original right-side sphere; never altered or used as a hand.",
    },
    variants: actions.map(({ id, edit }) => ({
      id,
      duration: 5,
      loop: false,
      origin: "source-prop-composite",
      edit,
      referenceInputs: ["myco_mov.mp4"],
      characterSource: "source-idle/myco-idle-alpha.mov",
      layoutReference: "reading",
      characterFraming:
        id === "greeting"
          ? "Reading baseline with a small authored whole-footage nod; no synthesized body or eyes."
          : "Identical crop, scale, placement, and source timing to the accepted reading clip.",
      files: {
        web: `clips/${id}.webm`,
        safari: `clips/${id}-hevc.mov`,
        editor: `clips/${id}.mov`,
        preview: `clips/${id}.mp4`,
        poster: `posters/${id}.png`,
      },
    })),
  };
  const manifestPath = path.join(output, "production/additional-actions.json");
  let previousVariants = [];
  try {
    previousVariants = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ).variants;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const updated = new Map(
    previousVariants.map((variant) => [variant.id, variant]),
  );
  for (const variant of manifest.variants) updated.set(variant.id, variant);
  manifest.variants = additionalActions
    .map(({ id }) => updated.get(id))
    .filter(Boolean);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const directory = path.dirname(fileURLToPath(import.meta.url));
  await copyFile(
    path.join(directory, "brand-video/additional-actions.mjs"),
    path.join(output, "production/additional-actions.mjs"),
  );
  await copyFile(
    note,
    path.join(output, "production/additional-note-prop.png"),
  );
  console.log(`Lossless source frames retained for review: ${work}`);
} finally {
  await browser.close();
}

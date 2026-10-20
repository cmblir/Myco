// Requires FFmpeg, the existing Playwright installation, and a keyed source MOV.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { renderFrame } from "./brand-video/choreography.mjs";

const output = process.env.MYCO_VIDEO_OUTPUT;
if (!output)
  throw new Error(
    "Set MYCO_VIDEO_OUTPUT to an export folder outside app/public.",
  );
const source =
  process.env.MYCO_KEYED_SOURCE ??
  path.join(output, "source-idle/myco-idle-alpha.mov");
const work = await mkdtemp(path.join(tmpdir(), "myco-video-render-"));
const variants = [
  {
    id: "idle",
    duration: 8,
    loop: true,
    posterFrame: 0,
    edit: "Forward/reverse source motion loop.",
  },
  {
    id: "welcome",
    duration: 4,
    loop: false,
    posterFrame: 36,
    edit: "Gentle rise, scale, fade-in and two violet sparks.",
  },
  {
    id: "thinking",
    duration: 8,
    loop: true,
    posterFrame: 48,
    edit: "Slow whole-character tilt with three pulsing dots.",
  },
  {
    id: "scan",
    duration: 8,
    loop: true,
    posterFrame: 48,
    edit: "Side-to-side sway with an orbit line and magnifier.",
  },
  {
    id: "success",
    duration: 4,
    loop: false,
    posterFrame: 48,
    edit: "Single whole-character hop with sparks and a check badge.",
  },
  {
    id: "exit",
    duration: 4,
    loop: false,
    posterFrame: 12,
    edit: "Slow upward drift, shrink and fade-out.",
  },
];
const selection = process.argv.slice(2);
if (selection.some((id) => !variants.some((variant) => variant.id === id))) {
  throw new Error(
    "Unknown variant. Use idle, welcome, thinking, scan, success, or exit.",
  );
}
async function run(command, args) {
  const process = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  process.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const [code] = await once(process, "close");
  if (code !== 0) throw new Error(`${command} exited ${code}:\n${errors}`);
}
await Promise.all(
  ["clips", "posters"].map((folder) =>
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
const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(
    '<!doctype html><html><body><canvas width="768" height="768"></canvas></body></html>',
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async (frames) => {
    window.mycoFrames = await Promise.all(
      frames.map(async (url) => {
        const frame = new Image();
        frame.src = url;
        await frame.decode();
        return frame;
      }),
    );
  }, frames);
  for (const variant of variants.filter(
    (variant) => selection.length === 0 || selection.includes(variant.id),
  )) {
    const frameDir = path.join(work, variant.id);
    await mkdir(frameDir);
    for (let frame = 0; frame < variant.duration * 24; frame++) {
      const png = Buffer.from(
        await page.evaluate(renderFrame, {
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
    const input = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      "24",
      "-i",
      path.join(frameDir, "%03d.png"),
    ];
    await run("ffmpeg", [
      ...input,
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4",
      "-pix_fmt",
      "yuva444p10le",
      "-an",
      `${target}.mov`,
    ]);
    await Promise.all([
      run("ffmpeg", [
        ...input,
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-b:v",
        "0",
        "-crf",
        "30",
        "-deadline",
        "good",
        "-cpu-used",
        "4",
        "-row-mt",
        "1",
        "-an",
        `${target}.webm`,
      ]),
      run("ffmpeg", [
        ...input,
        "-filter_complex",
        `color=c=0xF6F3EF:s=768x768:r=24:d=${variant.duration}[bg];[bg][0:v]overlay=shortest=1:format=auto,format=yuv420p[v]`,
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-crf",
        "19",
        "-preset",
        "medium",
        "-movflags",
        "+faststart",
        "-an",
        `${target}.mp4`,
      ]),
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
      `Rendered ${variant.id}: ${variant.duration}s, 768x768, 24fps, alpha WebM/MOV and ivory MP4.`,
    );
  }
  const manifest = {
    version: 1,
    source: "myco_mov.mp4",
    reference: "myco_base.png",
    method:
      "Chroma-keyed original moving footage with authored Canvas transforms and vector overlays. No AI-generated poses.",
    keyedSourceSha256: createHash("sha256")
      .update(await readFile(source))
      .digest("hex"),
    width: 768,
    height: 768,
    fps: 24,
    audio: false,
    loopMethod:
      "The loop variants play source frames 0–95 forward and then backward; the duplicate end frames soften the turnaround.",
    variants: variants.map(({ posterFrame, ...variant }) => ({
      ...variant,
      files: {
        web: `clips/${variant.id}.webm`,
        safari: `clips/${variant.id}-hevc.mov`,
        editor: `clips/${variant.id}.mov`,
        preview: `clips/${variant.id}.mp4`,
        poster: `posters/${variant.id}.png`,
      },
    })),
  };
  await writeFile(
    path.join(output, "source-edits.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`Frame work directory: ${work}`);
} finally {
  await browser.close();
  server.close();
}

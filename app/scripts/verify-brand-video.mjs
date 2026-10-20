// Decode every delivered alpha frame, including borders, rather than trusting codec tags.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const folder = process.argv[2];
if (!folder)
  throw new Error(
    "Usage: node scripts/verify-brand-video.mjs /path/to/myco-motion-kit",
  );
const manifest = JSON.parse(
  await readFile(path.join(folder, "manifest.json"), "utf8"),
);
function probe(filename) {
  return JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", filename],
      { encoding: "utf8" },
    ),
  );
}
async function decodeAlpha(filename, width, height, decoder) {
  const args = ["-hide_banner", "-loglevel", "error"];
  if (decoder) args.push("-c:v", decoder);
  args.push("-i", filename, "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1");
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const completion = once(child, "close");
  const frameBytes = width * height * 4;
  let pending = Buffer.alloc(0);
  let frameCount = 0;
  let visibleFrames = 0;
  let first;
  let last;
  for await (const chunk of child.stdout) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      let visible = 0;
      for (let pixel = 0; pixel < width * height; pixel++) {
        const alpha = frame[pixel * 4 + 3];
        if (alpha > 250) visible++;
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
          assert.equal(
            alpha,
            0,
            `${filename}: content touches border at frame ${frameCount}`,
          );
        }
      }
      if (visible > width * height * 0.1) visibleFrames++;
      first ??= Buffer.from(frame);
      last = Buffer.from(frame);
      frameCount++;
      pending = pending.subarray(frameBytes);
    }
  }
  const [code] = await completion;
  assert.equal(code, 0, `${filename}: FFmpeg decode failed:\n${errors}`);
  assert.equal(pending.length, 0, `${filename}: incomplete frame`);
  let difference = 0;
  for (let offset = 0; offset < frameBytes; offset += 4) {
    const firstAlpha = first[offset + 3] / 255;
    const lastAlpha = last[offset + 3] / 255;
    for (let channel = 0; channel < 3; channel++) {
      difference += Math.abs(
        first[offset + channel] * firstAlpha -
          last[offset + channel] * lastAlpha,
      );
    }
  }
  return {
    frameCount,
    visibleFrames,
    borderAlpha: 0,
    endpointMeanRgbDifference: Number(
      (difference / (width * height * 3)).toFixed(4),
    ),
  };
}
const checked = [];
for (const variant of manifest.variants) {
  const formats = {};
  for (const key of ["web", "editor", "preview", "safari"]) {
    const filename = path.join(folder, variant.files[key]);
    const metadata = probe(filename);
    const video = metadata.streams.find(
      (stream) => stream.codec_type === "video",
    );
    assert.ok(video, `${filename}: missing video`);
    assert.equal(video.width, manifest.width);
    assert.equal(video.height, manifest.height);
    assert.equal(video.r_frame_rate, `${manifest.fps}/1`);
    assert.equal(
      metadata.streams.filter((stream) => stream.codec_type === "audio").length,
      0,
    );
    assert.ok(
      Math.abs(Number(metadata.format.duration) - variant.duration) < 0.05,
      `${filename}: unexpected duration`,
    );
    formats[key] = {
      codec: video.codec_name,
      bytes: Number(metadata.format.size),
      duration: Number(metadata.format.duration),
    };
    if (key === "web" || key === "editor") {
      const alpha = await decodeAlpha(
        filename,
        manifest.width,
        manifest.height,
        key === "web" ? "libvpx-vp9" : undefined,
      );
      assert.equal(alpha.frameCount, variant.duration * manifest.fps);
      assert.ok(
        alpha.visibleFrames >= alpha.frameCount / 2,
        `${filename}: mascot unexpectedly transparent`,
      );
      if (variant.loop)
        assert.ok(
          alpha.endpointMeanRgbDifference < 3,
          `${filename}: visible loop seam`,
        );
      formats[key].alpha = alpha;
    }
  }
  checked.push({ id: variant.id, formats });
  console.log(
    `PASS ${variant.id}: dimensions, duration, frame rate, silent tracks, full WebM/ProRes alpha decode.`,
  );
}
await writeFile(
  path.join(folder, "verification.json"),
  `${JSON.stringify({ checked }, null, 2)}\n`,
);
console.log(`Verified ${checked.length} motions.`);

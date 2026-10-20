// All anatomy comes from the supplied footage. Props never touch the companion.
export const additionalActions = [
  {
    id: "inspecting",
    posterFrame: 60,
    edit: "An independent magnifier scans a floating note, pauses over a detail, and settles beside it.",
  },
  {
    id: "idea",
    posterFrame: 66,
    edit: "A violet bulb appears apart from the cap, lights once, and settles with the original floating character.",
  },
  {
    id: "greeting",
    posterFrame: 42,
    edit: "One restrained nod authored with a whole-footage vertical dip, squash, and tilt; original eyes and companion are unchanged.",
  },
  {
    id: "organizing",
    posterFrame: 82,
    edit: "Three independent note cards move from a loose fan into a tidy stack below the eyes.",
  },
];

export function renderAdditionalAction({ variant, frame, fps }) {
  const canvas = document.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const t = frame / fps;
  const sourceIndex = frame < 96 ? frame : 191 - frame;
  const source = window.mycoFrames[sourceIndex];
  const note = window.mycoNote;
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const smooth = (value) => {
    const p = clamp(value);
    return p * p * (3 - 2 * p);
  };
  const mix = (from, to, amount) => from + (to - from) * amount;
  const bob = Math.sin((t / 5) * Math.PI * 2);

  ctx.clearRect(0, 0, 768, 768);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  if (variant === "greeting") {
    const nod = Math.sin(Math.PI * smooth((t - 0.7) / 2.1));
    ctx.translate(384, 610 + nod * 12);
    ctx.rotate(-nod * 0.018);
    ctx.scale(1 + nod * 0.008, 1 - nod * 0.035);
    ctx.translate(-384, -610);
  }
  // Match the accepted reading crop, scale, position, and forward/reverse timing.
  ctx.drawImage(source, 24, 24, 720, 720);
  ctx.restore();

  const drawNote = (x, y, width, angle = 0, alpha = 1) => {
    const height = width * (198 / 210);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalAlpha = alpha;
    ctx.drawImage(note, -width / 2, -height / 2, width, height);
    ctx.restore();
  };
  const star = (x, y, radius, alpha) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#dbc9ff";
    ctx.beginPath();
    ctx.moveTo(x, y - radius);
    ctx.quadraticCurveTo(x + radius * 0.18, y - radius * 0.18, x + radius, y);
    ctx.quadraticCurveTo(x + radius * 0.18, y + radius * 0.18, x, y + radius);
    ctx.quadraticCurveTo(x - radius * 0.18, y + radius * 0.18, x - radius, y);
    ctx.quadraticCurveTo(x - radius * 0.18, y - radius * 0.18, x, y - radius);
    ctx.fill();
    ctx.restore();
  };

  if (variant === "inspecting") {
    const noteX = 371 + bob * 5;
    const noteY = 615 + Math.sin(t * 1.25 + 0.6) * 4;
    drawNote(noteX, noteY, 210, bob * 0.025);
    const scan = smooth((t - 0.6) / 2.0);
    const settle = smooth((t - 3.3) / 1.2);
    const lensX = mix(mix(301, 420, scan), 265, settle);
    const lensY = mix(580 + Math.sin(scan * Math.PI) * 27, 581, settle);
    ctx.save();
    ctx.translate(lensX, lensY);
    ctx.rotate(-0.2 + scan * 0.17);
    const glass = ctx.createRadialGradient(-10, -10, 1, 0, 0, 34);
    glass.addColorStop(0, "rgba(237,225,255,0.20)");
    glass.addColorStop(1, "rgba(146,108,218,0.05)");
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.arc(0, 0, 32, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#523578";
    ctx.lineWidth = 12;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-24, 24);
    ctx.lineTo(-54, 57);
    ctx.stroke();
    ctx.strokeStyle = "#ae8bde";
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = "#a98bd5";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(0, 0, 33, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#e0d0ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 32, Math.PI * 1.06, Math.PI * 1.8);
    ctx.stroke();
    ctx.restore();
    const glint = Math.sin(Math.PI * smooth((t - 2.4) / 0.85));
    star(lensX + 25, lensY - 27, 10, glint * 0.8);
  } else if (variant === "idea") {
    const appear = smooth((t - 1) / 0.7);
    const light = smooth((t - 1.75) / 0.65);
    const flare = Math.sin(Math.PI * smooth((t - 1.8) / 1.3));
    ctx.save();
    ctx.globalAlpha = appear;
    ctx.translate(628, 163 + 8 * (1 - appear) + bob * 3);
    ctx.scale(0.92 + appear * 0.08, 0.92 + appear * 0.08);
    const glow = ctx.createRadialGradient(0, 0, 5, 0, 0, 61);
    glow.addColorStop(0, `rgba(176,127,250,${0.28 * light})`);
    glow.addColorStop(1, "rgba(176,127,250,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(-61, -61, 122, 122);
    ctx.beginPath();
    ctx.moveTo(-13, 23);
    ctx.bezierCurveTo(-13, 14, -27, 10, -27, -8);
    ctx.bezierCurveTo(-27, -43, 27, -43, 27, -8);
    ctx.bezierCurveTo(27, 10, 13, 14, 13, 23);
    ctx.closePath();
    const bulb = ctx.createLinearGradient(-26, -30, 25, 23);
    bulb.addColorStop(0, `rgba(232,213,255,${0.38 + light * 0.58})`);
    bulb.addColorStop(1, "#9565ca");
    ctx.fillStyle = bulb;
    ctx.fill();
    ctx.strokeStyle = "#d9bcfb";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineCap = "round";
    ctx.strokeStyle = "#f0e5ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-8, -4);
    ctx.lineTo(0, 4);
    ctx.lineTo(8, -4);
    ctx.moveTo(0, 4);
    ctx.lineTo(0, 22);
    ctx.stroke();
    ctx.strokeStyle = "#9a83b7";
    ctx.lineWidth = 6;
    for (const y of [28, 36]) {
      ctx.beginPath();
      ctx.moveTo(-10, y);
      ctx.lineTo(10, y);
      ctx.stroke();
    }
    ctx.globalAlpha *= light * (0.55 + flare * 0.45);
    ctx.strokeStyle = "#ccb0f6";
    ctx.lineWidth = 3;
    for (const angle of [
      -Math.PI / 2,
      -Math.PI / 4,
      0,
      Math.PI,
      -Math.PI * 0.75,
    ]) {
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * 43, -6 + Math.sin(angle) * 43);
      ctx.lineTo(Math.cos(angle) * 52, -6 + Math.sin(angle) * 52);
      ctx.stroke();
    }
    ctx.restore();
    star(679, 110, 8, flare * 0.9);
  } else if (variant === "organizing") {
    const back = smooth((t - 0.75) / 1.1);
    const front = smooth((t - 1.8) / 1.2);
    const floatY = bob * 4;
    drawNote(
      mix(298, 361, back),
      mix(615, 600, back) + floatY,
      164,
      mix(-0.19, -0.035, back),
    );
    drawNote(376, 616 + floatY, 164, 0.01);
    drawNote(
      mix(420, 391, front),
      mix(641, 632, front) + floatY,
      164,
      mix(0.18, 0.045, front),
    );
    const glint = Math.sin(Math.PI * smooth((t - 3) / 1));
    star(489, 610 + floatY, 9, glint * 0.8);
  }
  return canvas.toDataURL("image/png").split(",")[1];
}

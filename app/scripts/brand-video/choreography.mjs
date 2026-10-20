// Canvas compositing of the supplied moving footage; no generated body poses.
export function renderFrame({ variant, frame, fps }) {
  const canvas = document.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const t = frame / fps;
  const cycle = (t / 8) * Math.PI * 2;
  const sourceIndex = frame < 96 ? frame : 191 - frame;
  const source = window.mycoFrames[sourceIndex];
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const smooth = (value) => {
    const p = clamp(value);
    return p * p * (3 - 2 * p);
  };
  const pulse = (start, end) =>
    smooth((t - start) / 0.25) * smooth((end - t) / 0.35);
  const star = (x, y, radius, opacity) => {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = "#b999f8";
    ctx.beginPath();
    ctx.moveTo(x, y - radius);
    ctx.quadraticCurveTo(x + radius * 0.18, y - radius * 0.18, x + radius, y);
    ctx.quadraticCurveTo(x + radius * 0.18, y + radius * 0.18, x, y + radius);
    ctx.quadraticCurveTo(x - radius * 0.18, y + radius * 0.18, x - radius, y);
    ctx.quadraticCurveTo(x - radius * 0.18, y - radius * 0.18, x, y - radius);
    ctx.fill();
    ctx.restore();
  };

  ctx.clearRect(0, 0, 768, 768);
  let x = 0;
  let y = 0;
  let angle = 0;
  let scale = 1;
  let opacity = 1;
  if (variant === "welcome") {
    const p = clamp(t / 1.2);
    const arrival = 1 - (1 - p) ** 3;
    y = 74 * (1 - arrival) - 12 * Math.sin(p * Math.PI);
    scale = 0.88 + 0.12 * arrival;
    angle = -0.09 * (1 - arrival);
    opacity = smooth(t / 0.45);
  } else if (variant === "thinking") {
    angle = Math.sin(cycle) * 0.045;
    x = Math.sin(cycle) * 7;
  } else if (variant === "scan") {
    x = Math.sin(cycle) * 24;
    angle = Math.sin(cycle) * 0.065;
  } else if (variant === "success") {
    const p = clamp((t - 0.3) / 1.25);
    y = -46 * Math.sin(p * Math.PI);
    angle = 0.065 * Math.sin(p * Math.PI * 2);
  } else if (variant === "exit") {
    const p = smooth((t - 1) / 2.4);
    y = -95 * p;
    scale = 1 - 0.14 * p;
    angle = 0.045 * Math.sin(p * Math.PI);
    opacity = 1 - smooth((t - 2) / 1.4);
  }
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(384 + x, 384 + y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, -360, -360, 720, 720);
  ctx.restore();

  if (variant === "welcome") {
    star(608, 233, 20, pulse(0.7, 2.1));
    star(179, 316, 12, pulse(1, 2.35));
  } else if (variant === "thinking") {
    for (let dot = 0; dot < 3; dot++) {
      const wave = (1 + Math.sin(t * Math.PI - dot * 0.8)) / 2;
      ctx.fillStyle = `rgba(161, 126, 222, ${0.35 + 0.65 * wave})`;
      ctx.beginPath();
      ctx.arc(350 + dot * 34, 690 - wave * 8, 6 + wave * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (variant === "scan") {
    const lensX = 606 + 12 * Math.sin(cycle);
    const lensY = 598 + 9 * Math.cos(cycle);
    ctx.strokeStyle = "#b49ae4";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(lensX, lensY, 22, 0, Math.PI * 2);
    ctx.moveTo(lensX + 16, lensY + 16);
    ctx.lineTo(lensX + 35, lensY + 35);
    ctx.stroke();
    ctx.strokeStyle = "rgba(180, 154, 228, 0.45)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(384, 407, 294, -0.36, 0.3);
    ctx.stroke();
    star(659, 332 + 33 * Math.sin(cycle), 8, 0.75);
  } else if (variant === "success") {
    const reveal = smooth((t - 0.85) / 0.45);
    ctx.save();
    ctx.translate(591, 589);
    ctx.scale(0.85 + 0.15 * reveal, 0.85 + 0.15 * reveal);
    ctx.globalAlpha = reveal;
    ctx.fillStyle = "#8060b6";
    ctx.beginPath();
    ctx.arc(0, 0, 36, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(-14, 0);
    ctx.lineTo(-3, 11);
    ctx.lineTo(17, -13);
    ctx.stroke();
    ctx.restore();
    star(602, 224, 24, pulse(0.65, 2.35));
    star(161, 336, 14, pulse(0.9, 2.6));
    star(556, 164, 11, pulse(1, 2.5));
  } else if (variant === "exit") {
    star(577, 270 - 45 * smooth((t - 1) / 2.4), 16, pulse(1.8, 3.1));
  }
  return canvas.toDataURL("image/png").split(",")[1];
}

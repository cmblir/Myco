/* global document, window, Intl */
const copy = { ...window.mycoGalleryCopy, ...window.mycoPack?.copy };
const variants = window.mycoMotions;
const timingCopy = { seconds: "초", loop: "반복", once: "한 번" };
const number = new Intl.NumberFormat("ko-KR");
const hero = document.querySelector("[data-hero]");
hero.src = `posters/${window.mycoPack?.hero ?? variants[0].id}.png`;

document.querySelectorAll("[data-copy]").forEach((element) => {
  element.textContent = copy[element.dataset.copy];
});
document.querySelectorAll("[data-label]").forEach((element) => {
  element.setAttribute("aria-label", copy[element.dataset.label]);
});

const renderCard = (variant, index) => `
  <article class="motion-card" data-variant="${variant.id}">
    <div class="card-preview">
      <span class="card-number">${String(index + 1).padStart(2, "0")} <span class="origin-label">${variant.isComposite ? copy.propAction : variant.isNew ? copy.newAction : copy.sourceEdited}</span></span>
      <video muted playsinline preload="none" poster="posters/${variant.id}.png" aria-label="${variant.title} ${copy.play}" ${variant.loop ? "loop" : ""}></video>
      <span class="card-duration">${variant.duration}${timingCopy.seconds} · ${variant.loop ? timingCopy.loop : timingCopy.once}</span>
    </div>
    <div class="card-content">
      <div class="card-heading"><h3>${variant.title}</h3><span class="variant-name">${variant.id}</span></div>
      <p class="card-description">${variant.description}</p>
      <div class="playback-controls">
        <button type="button" data-action="toggle" aria-label="${variant.title} ${copy.play}" aria-pressed="false">${copy.play}</button>
        <button type="button" class="replay-button" data-action="replay" aria-label="${variant.title} ${copy.replay}" title="${copy.replay}">↻</button>
      </div>
      <div class="downloads">
        <a href="clips/${variant.id}.webm" download aria-label="${variant.title} ${copy.webDownload}">${copy.webDownload}</a>
        <a href="clips/${variant.id}.mov" download data-editor-master aria-label="${variant.title} ${copy.editDownload}">${copy.editDownload}</a>
        <a href="clips/${variant.id}.mp4" download aria-label="${variant.title} ${copy.previewDownload}">${copy.previewDownload}</a>
      </div>
      <p class="card-status" role="status"></p>
    </div>
  </article>`;
const grid = document.querySelector("#motion-grid");
const hasLatest = variants.some((variant) => variant.latest);
const current = variants.filter((variant) => !hasLatest || variant.latest);
const previous = variants.filter((variant) => hasLatest && !variant.latest);
grid.dataset.currentCount = String(current.length);
grid.innerHTML = current.map(renderCard).join("");
if (previous.length) {
  grid.insertAdjacentHTML(
    "beforeend",
    `<details class="previous-motions"><summary>${copy.previousMotions.replace("{count}", number.format(previous.length))}</summary><div class="motion-grid">${previous.map((variant, index) => renderCard(variant, current.length + index)).join("")}</div></details>`,
  );
  grid.querySelector("details").addEventListener("toggle", (event) => {
    if (!event.currentTarget.open) {
      event.currentTarget
        .querySelectorAll("video")
        .forEach((video) => video.pause());
    }
  });
}

const pack = window.mycoPack ?? { hasEditorMasters: true, hasArchives: true };
document.querySelectorAll("[data-archive]").forEach((link) => {
  link.hidden = !pack.hasArchives;
});
document.querySelectorAll("[data-editor-master]").forEach((link) => {
  link.hidden = !pack.hasEditorMasters;
});

const players = [...grid.querySelectorAll(".motion-card")].map((card) => ({
  card,
  variant: variants.find((variant) => variant.id === card.dataset.variant),
  video: card.querySelector("video"),
  toggle: card.querySelector('[data-action="toggle"]'),
  status: card.querySelector(".card-status"),
  format: null,
  hasError: false,
  hasCheckedAlpha: false,
}));
let activePlayer = null;

function updateControls(player) {
  const isPlaying = !player.video.paused && !player.video.ended;
  const label = player.hasError
    ? copy.retry
    : isPlaying
      ? copy.pause
      : player.video.ended
        ? copy.replay
        : player.video.currentTime > 0
          ? copy.resume
          : copy.play;
  player.toggle.textContent = label;
  player.toggle.setAttribute("aria-label", `${player.variant.title} ${label}`);
  player.toggle.setAttribute("aria-pressed", String(isPlaying));
}

function setSource(player, format) {
  player.format = format;
  player.hasCheckedAlpha = format === "mp4";
  player.video.src =
    format === "hevc"
      ? `clips/${player.variant.id}-hevc.mov`
      : `clips/${player.variant.id}.${format}`;
  player.status.textContent =
    format === "mp4" ? copy.opaqueFallback : copy.loading;
}

function fallbackFormat(player) {
  if (
    player.format === "hevc" &&
    player.video.canPlayType('video/webm; codecs="vp9"')
  )
    return "webm";
  return "mp4";
}

async function playMotion(player, shouldRestart = false) {
  players.forEach((other) => {
    if (other !== player) other.video.pause();
  });
  activePlayer = player;
  player.hasError = false;
  if (!player.format) {
    const preferredFormat = player.video.canPlayType(
      'video/quicktime; codecs="hvc1"',
    )
      ? "hevc"
      : player.video.canPlayType('video/webm; codecs="vp9"')
        ? "webm"
        : "mp4";
    setSource(player, preferredFormat);
  } else if (player.video.error) {
    setSource(player, player.format);
  }
  if (shouldRestart || player.video.ended) player.video.currentTime = 0;
  try {
    await player.video.play();
  } catch (error) {
    // A newer play request or a preference change may deliberately cancel this one.
    if (error.name === "AbortError") return;
    if (activePlayer !== player) return;
    if (player.format !== "mp4") {
      setSource(player, fallbackFormat(player));
      await playMotion(player, true);
      return;
    }
    player.hasError = true;
    player.status.textContent = copy.error;
    updateControls(player);
  }
}

function checkAlpha(player) {
  if (
    player.hasCheckedAlpha ||
    player.format === "mp4" ||
    !player.video.videoWidth
  )
    return;
  player.hasCheckedAlpha = true;
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  let hasAlpha = false;
  try {
    context.drawImage(player.video, 0, 0, 2, 2, 0, 0, 2, 2);
    hasAlpha = context.getImageData(0, 0, 1, 1).data[3] < 16;
  } catch (error) {
    // Local-file security can prevent pixel inspection; use the portable preview.
    if (error.name !== "SecurityError") throw error;
  }
  if (!hasAlpha) {
    const shouldResume = !player.video.paused && activePlayer === player;
    setSource(player, fallbackFormat(player));
    if (shouldResume) void playMotion(player, true);
  }
}

players.forEach((player) => {
  ["play", "pause", "ended"].forEach((eventName) => {
    player.video.addEventListener(eventName, () => {
      if (eventName === "play" && activePlayer !== player) player.video.pause();
      updateControls(player);
    });
  });
  player.video.addEventListener("loadeddata", () => checkAlpha(player));
  player.video.addEventListener("playing", () => {
    checkAlpha(player);
    player.status.textContent =
      player.format === "mp4" ? copy.opaqueFallback : "";
  });
  player.video.addEventListener("waiting", () => {
    if (activePlayer === player) player.status.textContent = copy.loading;
  });
  player.card
    .querySelector('[data-action="toggle"]')
    .addEventListener("click", () => {
      if (!player.video.paused) {
        player.video.pause();
        return;
      }
      void playMotion(player);
    });
  player.card
    .querySelector('[data-action="replay"]')
    .addEventListener("click", () => {
      void playMotion(player, true);
    });
});

document.querySelectorAll("[data-background-choice]").forEach((button) => {
  button.addEventListener("click", () => {
    document.body.dataset.background = button.dataset.backgroundChoice;
    document.querySelectorAll("[data-background-choice]").forEach((option) => {
      option.setAttribute("aria-pressed", String(option === button));
    });
  });
});

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
function syncMotionPreference() {
  const notice = document.querySelector("#motion-notice");
  notice.hidden = !reducedMotion.matches;
  notice.textContent = reducedMotion.matches ? copy.reducedMotion : "";
  if (reducedMotion.matches) {
    activePlayer = null;
    players.forEach((player) => player.video.pause());
  }
}
reducedMotion.addEventListener("change", syncMotionPreference);
syncMotionPreference();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    activePlayer = null;
    players.forEach((player) => player.video.pause());
  }
});

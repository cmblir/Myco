/* global document, window */
const variants = [
  {
    key: "idle",
    title: "곁에 머물기",
    description: "시작 화면이나 앱 한쪽에, 편안한 숨 한 번.",
    timing: "6초 · 반복",
  },
  {
    key: "welcome",
    title: "반갑게 인사하기",
    description: "첫 만남과 새로운 시작을 가볍게 반겨요.",
    timing: "1.3초 · 한 번",
  },
  {
    key: "thinking",
    title: "차근차근 생각하기",
    description: "답을 찾고 있는 동안, 작은 점 세 개가 함께해요.",
    timing: "2.4초 · 반복",
  },
  {
    key: "saving",
    title: "소중히 담아두기",
    description: "기록을 담는 순간을 조용한 선으로 알려요.",
    timing: "2.4초 · 반복",
  },
  {
    key: "success",
    title: "잘 마쳤어요",
    description: "고개를 한 번 끄덕이고, 완료 표시를 남겨요.",
    timing: "1.3초 · 한 번",
  },
  {
    key: "empty",
    title: "첫 기록 기다리기",
    description: "아직 비어 있는 곳에서 다음 시작을 기다려요.",
    timing: "8초 · 반복",
  },
];

const motionMarkup = (
  variant,
) => `<span class="myco-motion" data-variant="${variant}" aria-hidden="true">
  <span class="myco-motion__halo"></span><span class="myco-motion__shadow"></span>
  <span class="myco-motion__figure"><img src="mascot.png" alt="" draggable="false" /></span>
  <span class="myco-motion__signal"><i></i><i></i><i></i></span>
  <span class="myco-motion__spark myco-motion__spark--one"></span>
  <span class="myco-motion__spark myco-motion__spark--two"></span></span>`;

const grid = document.querySelector("#motion-grid");
grid.innerHTML = variants
  .map(
    (variant, index) => `<article class="motion-card">
  <div class="card-preview preview-surface">
    <span class="card-number">0${index + 1}</span>${motionMarkup(variant.key)}
    <span class="card-timing">${variant.timing}</span>
  </div>
  <div class="card-body"><div class="card-heading"><h3>${variant.title}</h3><span class="card-variant">${variant.key}</span></div>
    <p>${variant.description}</p><div class="card-actions">
      <button type="button" data-replay="${variant.key}" aria-label="${variant.title} 다시 재생">다시 재생</button>
      <a href="${variant.key}.html" aria-label="${variant.title} 예제 열기">예제 열기 ↗</a>
    </div>
  </div></article>`,
  )
  .join("");
document.querySelector("#hero-motion").innerHTML = motionMarkup("welcome");

const pauseButton = document.querySelector("#pause-all");
let isPaused = false;
pauseButton.addEventListener("click", () => {
  isPaused = !isPaused;
  pauseButton.setAttribute("aria-pressed", String(isPaused));
  pauseButton.textContent = isPaused ? "모두 이어서 재생" : "모두 일시 정지";
  document.querySelectorAll(".myco-motion").forEach((motion) => {
    motion.dataset.paused = String(isPaused);
  });
});

grid.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-replay]");
  if (!button) return;
  const motion = button.closest(".motion-card").querySelector(".myco-motion");
  const replacement = motion.cloneNode(true);
  replacement.dataset.paused = String(isPaused);
  motion.replaceWith(replacement);
});

document.querySelectorAll("[data-background]").forEach((button) => {
  button.addEventListener("click", () => {
    document.body.dataset.previewBackground = button.dataset.background;
    document.querySelectorAll("[data-background]").forEach((option) => {
      option.setAttribute("aria-pressed", String(option === button));
    });
  });
});

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const syncMotionPreference = () => {
  document.querySelector("#motion-notice").hidden = !reducedMotion.matches;
  pauseButton.disabled = reducedMotion.matches;
  document.querySelectorAll("[data-replay]").forEach((button) => {
    button.disabled = reducedMotion.matches;
  });
};
reducedMotion.addEventListener("change", syncMotionPreference);
syncMotionPreference();

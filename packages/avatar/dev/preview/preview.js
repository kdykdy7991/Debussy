import "/dist/web-component/index.js";

const manifestUrl = "/assets/characters/demo/manifest.json";
const mount = document.querySelector("#avatar-mount");
const status = document.querySelector("#status");
const statusDot = document.querySelector("#status-dot");
const currentState = document.querySelector("#current-state");
const eventLog = document.querySelector("#event-log");
const mode = document.querySelector("#mode");
const position = document.querySelector("#position");
const visibility = document.querySelector("#visibility");

let avatar;
let isVisible = true;

function log(message, tone = "normal") {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  item.dataset.tone = tone;
  eventLog.prepend(item);
  while (eventLog.children.length > 6) eventLog.lastElementChild.remove();
}

function setStatus(message, tone) {
  status.textContent = message;
  statusDot.dataset.tone = tone;
}

function bindEvents(element) {
  element.addEventListener("avatar-ready", (event) => {
    setStatus("角色已就绪", "ready");
    log(`avatar-ready · ${event.detail.characterId}`, "ready");
  });
  element.addEventListener("avatar-state-change", (event) => {
    currentState.textContent = event.detail.current;
    log(`${event.detail.previous} → ${event.detail.current}`);
  });
  element.addEventListener("avatar-error", (event) => {
    setStatus(`${event.detail.code}`, "error");
    log(`${event.detail.code} · ${event.detail.message}`, "error");
  });
}

function createAvatar() {
  avatar?.remove();
  avatar = document.createElement("pi-avatar");
  avatar.setAttribute("character", manifestUrl);
  avatar.setAttribute("state", "idle");
  avatar.setAttribute("mode", mode.value);
  avatar.setAttribute("position", position.value);
  avatar.setAttribute("width", "360");
  avatar.setAttribute("height", "520");
  avatar.setAttribute("background", "transparent");
  bindEvents(avatar);
  mount.appendChild(avatar);
  isVisible = true;
  visibility.textContent = "Hide";
  currentState.textContent = "idle";
  setStatus("正在加载 Rive 角色…", "loading");
  log("create");
}

document.querySelector("#state-buttons").addEventListener("click", (event) => {
  const state = event.target.dataset.state;
  if (!state || !avatar) return;
  avatar.setState(state);
});

mode.addEventListener("change", () => avatar?.setAttribute("mode", mode.value));
position.addEventListener("change", () => avatar?.setAttribute("position", position.value));

visibility.addEventListener("click", () => {
  if (!avatar) return;
  if (isVisible) {
    avatar.hide();
    visibility.textContent = "Show";
    log("hide");
  } else {
    avatar.show();
    visibility.textContent = "Hide";
    log("show");
  }
  isVisible = !isVisible;
});

document.querySelector("#recreate").addEventListener("click", () => {
  avatar?.destroy();
  avatar?.remove();
  avatar = undefined;
  log("destroy");
  requestAnimationFrame(createAvatar);
});

window.addEventListener("unhandledrejection", (event) => {
  setStatus("检测到未处理 Promise", "error");
  log(`unhandledrejection · ${String(event.reason)}`, "error");
});

createAvatar();

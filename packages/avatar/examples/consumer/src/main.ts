import { createAvatar } from "@skdy/avatar";
import "./style.css";

let manifest = "/characters/downloaded/mood-interaction.json";
const status = document.querySelector<HTMLElement>("#status")!;
const logOutput = document.querySelector<HTMLOutputElement>("#event-log")!;
const mode = document.querySelector<HTMLSelectElement>("#mode")!;
const position = document.querySelector<HTMLSelectElement>("#position")!;
const character = document.querySelector<HTMLSelectElement>("#character")!;
let avatar: ReturnType<typeof createAvatar> | undefined;

function log(message: string): void { logOutput.textContent = message; }
function setStatus(message: string, tone: "loading" | "ready" | "error"): void { status.textContent = message; status.dataset.tone = tone; }
function create(): void {
  avatar?.destroy();
  avatar = createAvatar({ target: "#avatar-mount", character: manifest, mode: mode.value as "inline" | "floating", position: position.value as "bottom-left" | "bottom-right", width: 360, height: 520, background: "transparent" });
  avatar.element.addEventListener("avatar-ready", (event) => { setStatus("Ready · real Rive character", "ready"); log(`avatar-ready: ${(event as CustomEvent).detail.characterId}`); });
  avatar.element.addEventListener("avatar-error", (event) => { const detail = (event as CustomEvent).detail; setStatus(`Avatar error: ${detail.code}`, "error"); log(`${detail.code}: ${detail.message}`); });
  void avatar.ready.catch(() => undefined);
  setStatus("Loading character…", "loading");
}
document.querySelector("#state-buttons")!.addEventListener("click", (event) => { const state = (event.target as HTMLElement).dataset.state; if (state && avatar) avatar.controller.setState(state as "idle" | "listening" | "thinking" | "speaking" | "error"); });
mode.addEventListener("change", () => { if (avatar) avatar.element.setAttribute("mode", mode.value); });
position.addEventListener("change", () => { if (avatar) avatar.element.setAttribute("position", position.value); });
document.querySelector("#destroy-recreate")!.addEventListener("click", () => { avatar?.destroy(); log("destroyed; recreating"); create(); });
character.addEventListener("change", () => { manifest = character.value; create(); });
window.addEventListener("unhandledrejection", (event) => { event.preventDefault(); setStatus("Unhandled rejection", "error"); log(String(event.reason)); });
create();

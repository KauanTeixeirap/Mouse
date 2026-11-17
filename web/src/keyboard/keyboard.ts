import type { ClientMsg } from "../protocol";

export function processBeforeInput(inputType: string, data: string | null): ClientMsg | null {
  if (inputType === "deleteContentBackward") {
    return { t: "key", k: "backspace", s: "tap" };
  }
  if (inputType === "insertLineBreak" || inputType === "insertParagraph") {
    return { t: "key", k: "enter", s: "tap" };
  }
  if (
    (inputType === "insertText" || inputType === "insertCompositionText") &&
    data &&
    data.length > 0
  ) {
    return { t: "text", v: data };
  }
  return null;
}

export function renderBasicKeyboardPanel(
  container: HTMLElement,
  emitMsg: (msg: ClientMsg) => void,
): () => void {
  container.innerHTML = "";

  const card = document.createElement("div");
  card.className = "card";

  const title = document.createElement("h2");
  title.textContent = "Teclado do Celular";
  title.style.margin = "0";
  title.style.fontSize = "1.05rem";

  const hint = document.createElement("p");
  hint.textContent = "Toque no botão abaixo para digitar com o teclado do Android (acentos e voz suportados).";
  hint.style.margin = "0";
  hint.style.color = "var(--muted)";
  hint.style.fontSize = "0.9rem";

  const input = document.createElement("textarea");
  input.className = "hidden-input";
  input.setAttribute("aria-label", "Entrada de teclado");
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "primary-btn";
  openBtn.textContent = "Abrir teclado";
  openBtn.addEventListener("click", () => {
    input.focus();
  });

  const onBeforeInput = (e: InputEvent) => {
    const msg = processBeforeInput(e.inputType, e.data);
    if (msg) {
      emitMsg(msg);
    }
    e.preventDefault();
    input.value = "";
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Backspace") {
      emitMsg({ t: "key", k: "backspace", s: "tap" });
      e.preventDefault();
    } else if (e.key === "Enter") {
      emitMsg({ t: "key", k: "enter", s: "tap" });
      e.preventDefault();
    }
  };

  input.addEventListener("beforeinput", onBeforeInput);
  input.addEventListener("keydown", onKeyDown);

  card.append(title, hint, openBtn, input);
  container.appendChild(card);

  return () => {
    input.removeEventListener("beforeinput", onBeforeInput);
    input.removeEventListener("keydown", onKeyDown);
  };
}

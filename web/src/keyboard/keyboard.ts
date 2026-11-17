import type { ClientMsg, CustomShortcut, KeyName, Settings } from "../protocol";

export type StickyModifier = "ctrl" | "alt" | "shift" | "win";
const MODIFIER_ORDER: StickyModifier[] = ["ctrl", "alt", "shift", "win"];

const KEY_ALIASES: Record<string, KeyName> = {
  control: "ctrl",
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
  win: "win",
  windows: "win",
  super: "win",
  cmd: "win",
  meta: "win",
  esc: "esc",
  escape: "esc",
  tab: "tab",
  enter: "enter",
  return: "enter",
  space: "space",
  espaco: "space",
  espaço: "space",
  backspace: "backspace",
  del: "delete",
  delete: "delete",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  pageup: "page_up",
  page_up: "page_up",
  pagedown: "page_down",
  page_down: "page_down",
};

const VALID_SPECIAL_KEYS = new Set<string>([
  "backspace",
  "tab",
  "enter",
  "esc",
  "space",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "page_up",
  "page_down",
  "ctrl",
  "alt",
  "shift",
  "win",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  "media_play_pause",
  "media_volume_up",
  "media_volume_down",
  "media_volume_mute",
  "media_next",
  "media_prev",
]);

export function parseShortcutKeys(raw: string): KeyName[] {
  const parts = raw
    .split(/[+\s,]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error("Informe pelo menos uma tecla (ex.: ctrl + shift + t)");
  }

  return parts.map((part) => {
    const mapped = KEY_ALIASES[part] ?? part;
    if (VALID_SPECIAL_KEYS.has(mapped)) {
      return mapped as KeyName;
    }
    if (mapped.length === 1 && /^[a-z0-9]$/.test(mapped)) {
      return mapped as KeyName;
    }
    throw new Error(`Tecla não suportada: "${part}"`);
  });
}

export function upsertCustomShortcut(settings: Settings, shortcut: CustomShortcut): Settings {
  const idx = settings.shortcuts.findIndex((s) => s.id === shortcut.id);
  const nextShortcuts =
    idx >= 0
      ? settings.shortcuts.map((s) => (s.id === shortcut.id ? shortcut : s))
      : [...settings.shortcuts, shortcut];
  return { ...settings, shortcuts: nextShortcuts };
}

export function deleteCustomShortcut(settings: Settings, id: string): Settings {
  return {
    ...settings,
    shortcuts: settings.shortcuts.filter((s) => s.id !== id),
  };
}

export class KeyboardController {
  private sticky = new Set<StickyModifier>();

  toggleModifier(mod: StickyModifier): StickyModifier[] {
    if (this.sticky.has(mod)) {
      this.sticky.delete(mod);
    } else {
      this.sticky.add(mod);
    }
    return this.getActiveModifiers();
  }

  getActiveModifiers(): StickyModifier[] {
    return MODIFIER_ORDER.filter((m) => this.sticky.has(m));
  }

  clearModifiers(): void {
    this.sticky.clear();
  }

  pressKey(key: KeyName): ClientMsg {
    const active = this.getActiveModifiers();
    if (active.length > 0 && !MODIFIER_ORDER.includes(key as StickyModifier)) {
      this.sticky.clear();
      return { t: "combo", k: [...active, key] };
    }
    return { t: "key", k: key, s: "tap" };
  }

  handleBeforeInput(inputType: string, data: string | null): ClientMsg | null {
    if (inputType === "deleteContentBackward") {
      return this.pressKey("backspace");
    }
    if (inputType === "insertLineBreak" || inputType === "insertParagraph") {
      return this.pressKey("enter");
    }
    if ((inputType === "insertText" || inputType === "insertCompositionText") && data) {
      if (this.sticky.size > 0) {
        if (data === " ") {
          return this.pressKey("space");
        }
        if (data.length === 1 && /^[a-zA-Z0-9]$/.test(data)) {
          return this.pressKey(data.toLowerCase() as KeyName);
        }
      }
      return { t: "text", v: data };
    }
    return null;
  }
}

export function processBeforeInput(inputType: string, data: string | null): ClientMsg | null {
  return new KeyboardController().handleBeforeInput(inputType, data);
}

type KeyboardSubTab = "shortcuts" | "media" | "fn" | "custom";

const PRESET_SHORTCUTS: Array<{ label: string; keys: KeyName[] }> = [
  { label: "Copiar (Ctrl+C)", keys: ["ctrl", "c"] },
  { label: "Colar (Ctrl+V)", keys: ["ctrl", "v"] },
  { label: "Cortar (Ctrl+X)", keys: ["ctrl", "x"] },
  { label: "Desfazer (Ctrl+Z)", keys: ["ctrl", "z"] },
  { label: "Selecionar tudo (Ctrl+A)", keys: ["ctrl", "a"] },
  { label: "Alternar janela (Alt+Tab)", keys: ["alt", "tab"] },
  { label: "Área de trabalho (Win+D)", keys: ["win", "d"] },
  { label: "Fechar janela (Alt+F4)", keys: ["alt", "f4"] },
];

const MEDIA_KEYS: Array<{ label: string; key: KeyName }> = [
  { label: "⏯ Play / Pause", key: "media_play_pause" },
  { label: "🔊 Volume +", key: "media_volume_up" },
  { label: "🔉 Volume −", key: "media_volume_down" },
  { label: "🔇 Mudo", key: "media_volume_mute" },
  { label: "⏮ Anterior", key: "media_prev" },
  { label: "⏭ Próxima", key: "media_next" },
];

export function renderKeyboardPanel(
  container: HTMLElement,
  activeProfile: string,
  initialSettings: Settings,
  emitMsg: (msg: ClientMsg) => void,
  haptic: () => void,
  onSettingsUpdated: (next: Settings) => void,
): () => void {
  let settings = initialSettings;
  let subTab: KeyboardSubTab = "shortcuts";
  const ctrl = new KeyboardController();

  container.innerHTML = "";

  const panel = document.createElement("div");
  panel.className = "scroll-panel";

  // Native keyboard card
  const nativeCard = document.createElement("div");
  nativeCard.className = "card";

  const hiddenInput = document.createElement("textarea");
  hiddenInput.className = "hidden-input";
  hiddenInput.setAttribute("aria-label", "Entrada de teclado nativo");
  hiddenInput.autocapitalize = "off";
  hiddenInput.autocomplete = "off";
  hiddenInput.spellcheck = false;

  const openKeyboardBtn = document.createElement("button");
  openKeyboardBtn.type = "button";
  openKeyboardBtn.className = "primary-btn";
  openKeyboardBtn.textContent = "Digitar com teclado do celular";
  openKeyboardBtn.addEventListener("click", () => {
    haptic();
    hiddenInput.focus();
  });

  // Special & sticky keys bar
  const specialBar = document.createElement("div");
  specialBar.className = "key-strip";

  const modButtons = new Map<StickyModifier, HTMLButtonElement>();
  const syncModButtons = () => {
    const active = new Set(ctrl.getActiveModifiers());
    for (const [mod, btn] of modButtons.entries()) {
      btn.setAttribute("aria-pressed", String(active.has(mod)));
    }
  };

  const modifiers: Array<{ mod: StickyModifier; label: string }> = [
    { mod: "ctrl", label: "Ctrl" },
    { mod: "alt", label: "Alt" },
    { mod: "shift", label: "Shift" },
    { mod: "win", label: "Win" },
  ];
  for (const item of modifiers) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "key-chip";
    btn.textContent = item.label;
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => {
      haptic();
      ctrl.toggleModifier(item.mod);
      syncModButtons();
    });
    modButtons.set(item.mod, btn);
    specialBar.appendChild(btn);
  }

  const specialKeys: Array<{ key: KeyName; label: string }> = [
    { key: "esc", label: "Esc" },
    { key: "tab", label: "Tab" },
    { key: "left", label: "←" },
    { key: "up", label: "↑" },
    { key: "down", label: "↓" },
    { key: "right", label: "→" },
    { key: "delete", label: "Del" },
  ];
  for (const item of specialKeys) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "key-chip";
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      haptic();
      emitMsg(ctrl.pressKey(item.key));
      syncModButtons();
    });
    specialBar.appendChild(btn);
  }

  nativeCard.append(openKeyboardBtn, specialBar, hiddenInput);

  // Sub-tabs bar
  const subTabsBar = document.createElement("div");
  subTabsBar.className = "subtabs";
  const tabContent = document.createElement("div");
  tabContent.className = "card";

  // Native <dialog> for adding/editing custom shortcuts (per modern-web-guidance dialog guide)
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "shortcut-dialog-title");
  dialog.innerHTML = `
    <h3 id="shortcut-dialog-title" style="margin-top:0">Atalho personalizado</h3>
    <form method="dialog" id="shortcut-form">
      <label style="display:block;margin-bottom:8px">
        <span>Nome do atalho</span>
        <input class="input" id="shortcut-label" type="text" maxlength="64" required autofocus placeholder="Ex.: Gerenciador de Tarefas">
      </label>
      <label style="display:block;margin-bottom:8px">
        <span>Teclas (separadas por +)</span>
        <input class="input" id="shortcut-keys" type="text" required placeholder="Ex.: ctrl + shift + esc">
      </label>
      <p class="error-text" id="shortcut-error"></p>
      <div class="dialog-actions">
        <button type="submit" value="cancel" class="secondary-btn" formnovalidate>Cancelar</button>
        <button type="button" id="shortcut-save-btn" class="primary-btn">Salvar</button>
      </div>
    </form>
  `;

  let editingShortcutId: string | null = null;
  const labelInput = dialog.querySelector<HTMLInputElement>("#shortcut-label")!;
  const keysInput = dialog.querySelector<HTMLInputElement>("#shortcut-keys")!;
  const errorEl = dialog.querySelector<HTMLElement>("#shortcut-error")!;
  const saveBtn = dialog.querySelector<HTMLButtonElement>("#shortcut-save-btn")!;

  const openShortcutDialog = (existing?: CustomShortcut) => {
    editingShortcutId = existing?.id ?? null;
    labelInput.value = existing?.label ?? "";
    keysInput.value = existing ? existing.keys.join(" + ") : "";
    errorEl.textContent = "";
    dialog.showModal();
  };

  saveBtn.addEventListener("click", () => {
    const label = labelInput.value.trim();
    if (!label) {
      errorEl.textContent = "Informe um nome para o atalho.";
      return;
    }
    try {
      const parsedKeys = parseShortcutKeys(keysInput.value);
      const item: CustomShortcut = {
        id: editingShortcutId ?? crypto.randomUUID(),
        label,
        keys: parsedKeys,
      };
      settings = upsertCustomShortcut(settings, item);
      onSettingsUpdated(settings);
      emitMsg({ t: "settings.save", profile: activeProfile, data: settings });
      dialog.close("save");
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : "Teclas inválidas";
    }
  });

  dialog.addEventListener("close", () => {
    const result = dialog.returnValue;
    dialog.returnValue = "";
    if (result === "save") {
      renderSubTab();
    }
  });

  function renderSubTabsBar(): void {
    subTabsBar.innerHTML = "";
    const defs: Array<{ id: KeyboardSubTab; label: string }> = [
      { id: "shortcuts", label: "Atalhos" },
      { id: "media", label: "Mídia" },
      { id: "fn", label: "F1–F12" },
      { id: "custom", label: "Meus atalhos" },
    ];
    for (const def of defs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nav-btn";
      btn.textContent = def.label;
      btn.setAttribute("aria-pressed", String(subTab === def.id));
      btn.addEventListener("click", () => {
        subTab = def.id;
        renderSubTabsBar();
        renderSubTab();
      });
      subTabsBar.appendChild(btn);
    }
  }

  function renderSubTab(): void {
    tabContent.innerHTML = "";
    if (subTab === "shortcuts") {
      const grid = document.createElement("div");
      grid.className = "btn-grid";
      for (const item of PRESET_SHORTCUTS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "secondary-btn";
        btn.textContent = item.label;
        btn.addEventListener("click", () => {
          haptic();
          emitMsg({ t: "combo", k: item.keys });
        });
        grid.appendChild(btn);
      }
      tabContent.appendChild(grid);
    } else if (subTab === "media") {
      const grid = document.createElement("div");
      grid.className = "btn-grid";
      for (const item of MEDIA_KEYS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "secondary-btn";
        btn.textContent = item.label;
        btn.addEventListener("click", () => {
          haptic();
          emitMsg({ t: "key", k: item.key, s: "tap" });
        });
        grid.appendChild(btn);
      }
      tabContent.appendChild(grid);
    } else if (subTab === "fn") {
      const grid = document.createElement("div");
      grid.className = "fn-grid";
      for (let i = 1; i <= 12; i += 1) {
        const keyName = `f${i}` as KeyName;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "secondary-btn";
        btn.textContent = `F${i}`;
        btn.addEventListener("click", () => {
          haptic();
          emitMsg(ctrl.pressKey(keyName));
          syncModButtons();
        });
        grid.appendChild(btn);
      }
      tabContent.appendChild(grid);
    } else {
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "primary-btn";
      addBtn.textContent = "+ Novo atalho";
      addBtn.addEventListener("click", () => openShortcutDialog());
      tabContent.appendChild(addBtn);

      if (settings.shortcuts.length === 0) {
        const empty = document.createElement("p");
        empty.style.margin = "8px 0 0 0";
        empty.style.color = "var(--muted)";
        empty.textContent = `Nenhum atalho salvo no perfil "${activeProfile}".`;
        tabContent.appendChild(empty);
      } else {
        for (const item of settings.shortcuts) {
          const row = document.createElement("div");
          row.className = "shortcut-row";

          const runBtn = document.createElement("button");
          runBtn.type = "button";
          runBtn.className = "secondary-btn shortcut-run";
          runBtn.textContent = `${item.label} (${item.keys.join("+")})`;
          runBtn.addEventListener("click", () => {
            haptic();
            emitMsg(
              item.keys.length === 1
                ? { t: "key", k: item.keys[0], s: "tap" }
                : { t: "combo", k: item.keys },
            );
          });

          const editBtn = document.createElement("button");
          editBtn.type = "button";
          editBtn.className = "secondary-btn";
          editBtn.textContent = "Editar";
          editBtn.addEventListener("click", () => openShortcutDialog(item));

          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "secondary-btn";
          delBtn.textContent = "Excluir";
          delBtn.addEventListener("click", () => {
            settings = deleteCustomShortcut(settings, item.id);
            onSettingsUpdated(settings);
            emitMsg({ t: "settings.save", profile: activeProfile, data: settings });
            renderSubTab();
          });

          row.append(runBtn, editBtn, delBtn);
          tabContent.appendChild(row);
        }
      }
    }
  }

  const onBeforeInput = (e: InputEvent) => {
    const msg = ctrl.handleBeforeInput(e.inputType, e.data);
    if (msg) {
      emitMsg(msg);
      syncModButtons();
    }
    e.preventDefault();
    hiddenInput.value = "";
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Backspace") {
      emitMsg(ctrl.pressKey("backspace"));
      syncModButtons();
      e.preventDefault();
    } else if (e.key === "Enter") {
      emitMsg(ctrl.pressKey("enter"));
      syncModButtons();
      e.preventDefault();
    }
  };

  hiddenInput.addEventListener("beforeinput", onBeforeInput);
  hiddenInput.addEventListener("keydown", onKeyDown);

  renderSubTabsBar();
  renderSubTab();

  panel.append(nativeCard, subTabsBar, tabContent, dialog);
  container.appendChild(panel);

  return () => {
    hiddenInput.removeEventListener("beforeinput", onBeforeInput);
    hiddenInput.removeEventListener("keydown", onKeyDown);
  };
}

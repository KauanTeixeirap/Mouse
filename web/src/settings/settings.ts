import type { ConnectionState } from "../net/socket";
import type { ClientMsg, ClutchMode, KeyName, Settings, ThemeMode, ThreeFingerActions } from "../protocol";

export interface ThreeFingerPreset {
  id: string;
  label: string;
  keys: KeyName[];
}

export const THREE_FINGER_PRESETS: ThreeFingerPreset[] = [
  { id: "media_play_pause", label: "Play / Pause", keys: ["media_play_pause"] },
  { id: "win+tab", label: "Visão de tarefas (Win+Tab)", keys: ["win", "tab"] },
  { id: "win+d", label: "Área de trabalho (Win+D)", keys: ["win", "d"] },
  { id: "alt+tab", label: "Alternar janela (Alt+Tab)", keys: ["alt", "tab"] },
  { id: "ctrl+c", label: "Copiar (Ctrl+C)", keys: ["ctrl", "c"] },
  { id: "ctrl+v", label: "Colar (Ctrl+V)", keys: ["ctrl", "v"] },
  { id: "media_volume_mute", label: "Mudo", keys: ["media_volume_mute"] },
];

export function applyThemePreference(
  theme: ThemeMode,
  doc: Document = document,
  storage: Storage | null = typeof localStorage !== "undefined" ? localStorage : null,
): void {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (theme === "system") {
    try {
      storage?.removeItem("color-scheme");
    } catch {
      // ignore storage access errors
    }
    if (meta) meta.content = "light dark";
  } else {
    try {
      storage?.setItem("color-scheme", theme);
    } catch {
      // ignore storage access errors
    }
    if (meta) meta.content = theme;
  }
}

export function syncThemeFromStorage(
  doc: Document = document,
  storage: Storage | null = typeof localStorage !== "undefined" ? localStorage : null,
): void {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (!meta) return;
  try {
    const val = storage?.getItem("color-scheme");
    meta.content = val === "light" || val === "dark" ? val : "light dark";
  } catch {
    meta.content = "light dark";
  }
}

interface WakeLockSentinelLike {
  released?: boolean;
  release(): Promise<void>;
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request(type: "screen"): Promise<WakeLockSentinelLike>;
  };
}

export class WakeLockController {
  private enabled = false;
  private sentinel: WakeLockSentinelLike | null = null;
  private boundVisibility: () => void;

  constructor() {
    this.boundVisibility = () => {
      if (document.visibilityState === "visible" && this.enabled) {
        void this.acquire();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.boundVisibility);
    }
  }

  async setEnabled(next: boolean): Promise<void> {
    this.enabled = next;
    if (next) {
      await this.acquire();
    } else {
      await this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (typeof navigator === "undefined") return;
    const wl = (navigator as unknown as NavigatorWithWakeLock).wakeLock;
    if (!wl || (this.sentinel && !this.sentinel.released)) return;
    try {
      this.sentinel = await wl.request("screen");
    } catch {
      // Ignore permission or battery-saver restrictions
    }
  }

  private async release(): Promise<void> {
    if (!this.sentinel) return;
    try {
      await this.sentinel.release();
    } catch {
      // ignore
    }
    this.sentinel = null;
  }

  destroy(): void {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.boundVisibility);
    }
    void this.release();
  }
}

export interface SettingsViewState {
  activeProfile: string;
  profiles: string[];
  settings: Settings;
  connState: ConnectionState;
  latencyMs: number | null;
}

export interface SettingsViewCallbacks {
  emitMsg: (msg: ClientMsg) => void;
  onSettingsChange: (next: Settings) => void;
  onUnpair: () => void;
}

function keysToPresetId(keys: KeyName[]): string {
  const joined = keys.join("+");
  const found = THREE_FINGER_PRESETS.find((p) => p.keys.join("+") === joined);
  return found?.id ?? THREE_FINGER_PRESETS[0].id;
}

export function renderSettingsPanel(
  container: HTMLElement,
  state: SettingsViewState,
  callbacks: SettingsViewCallbacks,
): void {
  container.innerHTML = "";
  let current = structuredClone(state.settings);

  const panel = document.createElement("div");
  panel.className = "scroll-panel";

  const persist = (next: Settings) => {
    current = next;
    callbacks.onSettingsChange(next);
    callbacks.emitMsg({ t: "settings.save", profile: state.activeProfile, data: next });
  };

  // Profile card
  const profileCard = document.createElement("div");
  profileCard.className = "card";
  profileCard.innerHTML = `<h2 style="margin:0;font-size:1.05rem">Perfil no PC</h2>`;

  const profileSelect = document.createElement("select");
  profileSelect.className = "input";
  profileSelect.setAttribute("aria-label", "Perfil ativo");
  for (const name of state.profiles) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    opt.selected = name === state.activeProfile;
    profileSelect.appendChild(opt);
  }
  profileSelect.addEventListener("change", () => {
    callbacks.emitMsg({ t: "profile.switch", profile: profileSelect.value });
  });

  const newProfileRow = document.createElement("form");
  newProfileRow.className = "shortcut-row";
  const newProfileInput = document.createElement("input");
  newProfileInput.className = "input";
  newProfileInput.type = "text";
  newProfileInput.maxLength = 64;
  newProfileInput.placeholder = "Novo perfil (ex.: Apresentação)";
  const createBtn = document.createElement("button");
  createBtn.type = "submit";
  createBtn.className = "secondary-btn";
  createBtn.textContent = "Criar";
  newProfileRow.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = newProfileInput.value.trim();
    if (!name) return;
    callbacks.emitMsg({ t: "profile.create", profile: name });
    newProfileInput.value = "";
  });
  newProfileRow.append(newProfileInput, createBtn);
  profileCard.append(profileSelect, newProfileRow);

  // Sensitivity & motion card
  const pointerCard = document.createElement("div");
  pointerCard.className = "card";
  pointerCard.innerHTML = `<h2 style="margin:0;font-size:1.05rem">Sensibilidade e Movimento</h2>`;

  const addSlider = (
    labelText: string,
    min: number,
    max: number,
    step: number,
    value: number,
    onCommit: (v: number) => void,
  ) => {
    const row = document.createElement("label");
    row.className = "setting-row";
    const top = document.createElement("div");
    top.className = "setting-label-line";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = labelText;
    const valSpan = document.createElement("strong");
    valSpan.textContent = step < 1 ? value.toFixed(1) : String(Math.round(value));
    top.append(nameSpan, valSpan);

    const range = document.createElement("input");
    range.type = "range";
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(value);
    range.addEventListener("input", () => {
      const n = Number(range.value);
      valSpan.textContent = step < 1 ? n.toFixed(1) : String(Math.round(n));
    });
    range.addEventListener("change", () => onCommit(Number(range.value)));

    row.append(top, range);
    pointerCard.appendChild(row);
  };

  addSlider("Sensibilidade do Trackpad", 0.2, 5.0, 0.1, current.trackpad_sensitivity, (v) =>
    persist({ ...current, trackpad_sensitivity: v }),
  );
  addSlider("Sensibilidade do Giroscópio", 2, 60, 1, current.gyro_sensitivity, (v) =>
    persist({ ...current, gyro_sensitivity: v }),
  );
  addSlider("Aceleração do ponteiro", 0.0, 2.0, 0.1, current.acceleration, (v) =>
    persist({ ...current, acceleration: v }),
  );
  addSlider("Velocidade da rolagem", 0.2, 4.0, 0.1, current.scroll_speed, (v) =>
    persist({ ...current, scroll_speed: v }),
  );

  // Preferences card
  const prefsCard = document.createElement("div");
  prefsCard.className = "card";
  prefsCard.innerHTML = `<h2 style="margin:0;font-size:1.05rem">Preferências</h2>`;

  const addToggle = (labelText: string, checked: boolean, onChange: (b: boolean) => void) => {
    const row = document.createElement("label");
    row.className = "setting-toggle";
    const span = document.createElement("span");
    span.textContent = labelText;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    row.append(span, input);
    prefsCard.appendChild(row);
  };

  addToggle("Rolagem natural", current.natural_scroll, (b) =>
    persist({ ...current, natural_scroll: b }),
  );
  addToggle("Vibração ao clicar", current.haptics, (b) => persist({ ...current, haptics: b }));
  addToggle("Manter tela ligada", current.wake_lock, (b) => persist({ ...current, wake_lock: b }));

  const clutchLabel = document.createElement("label");
  clutchLabel.className = "setting-row";
  clutchLabel.innerHTML = `<span>Botão embreagem (giroscópio)</span>`;
  const clutchSelect = document.createElement("select");
  clutchSelect.className = "input";
  clutchSelect.innerHTML = `
    <option value="hold_to_pause">Segurar para pausar (padrão)</option>
    <option value="hold_to_move">Segurar para mover</option>
  `;
  clutchSelect.value = current.clutch_mode;
  clutchSelect.addEventListener("change", () =>
    persist({ ...current, clutch_mode: clutchSelect.value as ClutchMode }),
  );
  clutchLabel.appendChild(clutchSelect);
  prefsCard.appendChild(clutchLabel);

  const themeLabel = document.createElement("label");
  themeLabel.className = "setting-row";
  themeLabel.innerHTML = `<span>Tema da interface</span>`;
  const themeSelect = document.createElement("select");
  themeSelect.className = "input";
  themeSelect.innerHTML = `
    <option value="system">Seguir o sistema</option>
    <option value="light">Claro</option>
    <option value="dark">Escuro</option>
  `;
  themeSelect.value = current.theme;
  themeSelect.addEventListener("change", () => {
    const nextTheme = themeSelect.value as ThemeMode;
    applyThemePreference(nextTheme);
    persist({ ...current, theme: nextTheme });
  });
  themeLabel.appendChild(themeSelect);
  prefsCard.appendChild(themeLabel);

  // 3-finger gestures card
  const gesturesCard = document.createElement("div");
  gesturesCard.className = "card";
  gesturesCard.innerHTML = `<h2 style="margin:0;font-size:1.05rem">Gestos com 3 dedos</h2>`;

  const gestureFields: Array<{ field: keyof ThreeFingerActions; label: string }> = [
    { field: "tap", label: "Toque rápido (3 dedos)" },
    { field: "up", label: "Deslizar para cima ↑" },
    { field: "down", label: "Deslizar para baixo ↓" },
    { field: "left", label: "Deslizar para esquerda ←" },
    { field: "right", label: "Deslizar para direita →" },
  ];

  for (const item of gestureFields) {
    const row = document.createElement("label");
    row.className = "setting-row";
    const span = document.createElement("span");
    span.textContent = item.label;
    const select = document.createElement("select");
    select.className = "input";
    for (const preset of THREE_FINGER_PRESETS) {
      const opt = document.createElement("option");
      opt.value = preset.id;
      opt.textContent = preset.label;
      select.appendChild(opt);
    }
    select.value = keysToPresetId(current.three_finger[item.field]);
    select.addEventListener("change", () => {
      const chosen = THREE_FINGER_PRESETS.find((p) => p.id === select.value);
      if (!chosen) return;
      persist({
        ...current,
        three_finger: {
          ...current.three_finger,
          [item.field]: [...chosen.keys],
        },
      });
    });
    row.append(span, select);
    gesturesCard.appendChild(row);
  }

  // Diagnostics card
  const diagCard = document.createElement("div");
  diagCard.className = "card";
  const statusLabel =
    state.connState === "connected"
      ? "🟢 Conectado"
      : state.connState === "connecting"
        ? "🟡 Conectando..."
        : state.connState === "kicked"
          ? "🟠 Outro aparelho assumiu o controle"
          : "🔴 Desconectado";
  diagCard.innerHTML = `
    <h2 style="margin:0;font-size:1.05rem">Diagnóstico</h2>
    <div><strong>Status:</strong> ${statusLabel}</div>
    <div><strong>Perfil ativo:</strong> ${state.activeProfile}</div>
    <div><strong>Latência:</strong> ${state.latencyMs !== null ? `${state.latencyMs} ms` : "—"}</div>
  `;

  const unpairBtn = document.createElement("button");
  unpairBtn.type = "button";
  unpairBtn.className = "secondary-btn";
  unpairBtn.textContent = "Desparear este celular";
  unpairBtn.addEventListener("click", () => callbacks.onUnpair());
  diagCard.appendChild(unpairBtn);

  panel.append(profileCard, pointerCard, prefsCard, gesturesCard, diagCard);
  container.appendChild(panel);
}

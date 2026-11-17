import { renderKeyboardPanel } from "./keyboard/keyboard";
import { type GyroHandle, renderGyroView } from "./modes/gyro";
import { attachTrackpad, type TrackpadHandle } from "./modes/trackpad";
import { type ConnectionState, MouseSocket } from "./net/socket";
import {
  clearStoredToken,
  extractQrCodeFromHash,
  getOrCreateDeviceName,
  getStoredToken,
  pairWithServer,
} from "./pairing";
import { type ClientMsg, DEFAULT_SETTINGS, type Settings } from "./protocol";
import {
  WakeLockController,
  applyThemePreference,
  renderSettingsPanel,
  syncThemeFromStorage,
} from "./settings/settings";

type ActiveTab = "trackpad" | "gyro" | "keyboard" | "settings";

export function startApp(root: HTMLElement): void {
  const deviceName = getOrCreateDeviceName();
  let activeTab: ActiveTab = "trackpad";
  let activeProfile = "Mesa";
  let profiles = ["Mesa", "Sofá/TV"];
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  let connState: ConnectionState = "disconnected";
  let latencyMs: number | null = null;
  let trackpadHandle: TrackpadHandle | null = null;
  let gyroHandle: GyroHandle | null = null;
  let cleanupView: (() => void) | null = null;
  const wakeLock = new WakeLockController();

  window.addEventListener("storage", (e) => {
    if (e.key === "color-scheme") {
      syncThemeFromStorage();
    }
  });

  const haptic = () => {
    if (settings.haptics && typeof navigator.vibrate === "function") {
      navigator.vibrate(10);
    }
  };

  const socket = new MouseSocket(deviceName, {
    onStateChange(next) {
      connState = next;
      updateChrome();
    },
    onLatency(ms) {
      latencyMs = ms;
      updateChrome();
    },
    onMessage(msg) {
      if (msg.t === "welcome") {
        activeProfile = msg.active_profile;
        settings = msg.settings;
        profiles = msg.profiles;
        applyThemePreference(settings.theme);
        void wakeLock.setEnabled(settings.wake_lock);
        trackpadHandle?.updateSettings(settings);
        gyroHandle?.updateSettings(settings);
        render();
      } else if (msg.t === "error" && msg.code === "unauthorized") {
        clearStoredToken();
        socket.disconnect();
        renderPairingScreen("Sessão expirada ou revogada. Pareie novamente.");
      }
    },
  });

  const emitMsg = (msg: ClientMsg) => {
    socket.send(msg);
  };

  function updateChrome(): void {
    const dot = root.querySelector<HTMLElement>(".status-dot");
    if (dot) {
      dot.dataset.state = connState;
      dot.title =
        connState === "connected"
          ? `Conectado (${latencyMs ?? "-"} ms)`
          : connState === "kicked"
            ? "Outro aparelho assumiu o controle"
            : "PC desconectado";
    }
    const banner = root.querySelector<HTMLElement>(".banner");
    if (banner) {
      if (connState === "kicked") {
        banner.hidden = false;
        banner.innerHTML = `<span>Outro aparelho assumiu o controle</span>`;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "secondary-btn";
        btn.textContent = "Retomar controle";
        btn.addEventListener("click", () => socket.takeover());
        banner.appendChild(btn);
      } else if (connState === "disconnected") {
        banner.hidden = false;
        banner.textContent = "PC desconectado — tentando reconectar...";
      } else {
        banner.hidden = true;
      }
    }
  }

  function renderPairingScreen(errorMessage = ""): void {
    cleanupActiveViews();
    root.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "pair-screen";

    const card = document.createElement("form");
    card.className = "card pair-card";

    const h1 = document.createElement("h1");
    h1.textContent = "Mouse — Pareamento";
    h1.style.margin = "0";
    h1.style.fontSize = "1.3rem";

    const desc = document.createElement("p");
    desc.textContent = "Digite o PIN de 6 dígitos exibido na bandeja do PC ou escaneie o QR Code.";
    desc.style.margin = "0";
    desc.style.color = "var(--muted)";

    const pinInput = document.createElement("input");
    pinInput.className = "input";
    pinInput.type = "text";
    pinInput.inputMode = "numeric";
    pinInput.maxLength = 6;
    pinInput.placeholder = "PIN de 6 dígitos";
    pinInput.required = true;

    const errEl = document.createElement("p");
    errEl.className = "error-text";
    errEl.textContent = errorMessage;

    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.className = "primary-btn";
    submitBtn.textContent = "Conectar";

    card.addEventListener("submit", async (e) => {
      e.preventDefault();
      errEl.textContent = "";
      submitBtn.disabled = true;
      try {
        const res = await pairWithServer("pin", pinInput.value, deviceName);
        activeProfile = res.active_profile;
        settings = res.settings;
        profiles = res.profiles;
        socket.connect(res.token);
        render();
      } catch (err) {
        errEl.textContent = err instanceof Error ? err.message : "Erro ao parear";
      } finally {
        submitBtn.disabled = false;
      }
    });

    card.append(h1, desc, pinInput, errEl, submitBtn);
    wrap.appendChild(card);
    root.appendChild(wrap);
  }

  function cleanupActiveViews(): void {
    trackpadHandle?.destroy();
    trackpadHandle = null;
    gyroHandle?.destroy();
    gyroHandle = null;
    cleanupView?.();
    cleanupView = null;
  }

  function buildMouseButtonsRow(): HTMLElement {
    const btnRow = document.createElement("div");
    btnRow.className = "mouse-buttons";
    const leftBtn = document.createElement("button");
    leftBtn.type = "button";
    leftBtn.className = "mouse-btn";
    leftBtn.textContent = "Esquerdo";
    leftBtn.addEventListener("pointerdown", () => {
      haptic();
      emitMsg({ t: "btn", b: "left", s: "down" });
    });
    leftBtn.addEventListener("pointerup", () => emitMsg({ t: "btn", b: "left", s: "up" }));
    leftBtn.addEventListener("pointercancel", () => emitMsg({ t: "btn", b: "left", s: "up" }));

    const rightBtn = document.createElement("button");
    rightBtn.type = "button";
    rightBtn.className = "mouse-btn";
    rightBtn.textContent = "Direito";
    rightBtn.addEventListener("pointerdown", () => {
      haptic();
      emitMsg({ t: "btn", b: "right", s: "down" });
    });
    rightBtn.addEventListener("pointerup", () => emitMsg({ t: "btn", b: "right", s: "up" }));
    rightBtn.addEventListener("pointercancel", () => emitMsg({ t: "btn", b: "right", s: "up" }));

    btnRow.append(leftBtn, rightBtn);
    return btnRow;
  }

  function render(): void {
    if (!getStoredToken()) {
      renderPairingScreen();
      return;
    }

    cleanupActiveViews();
    root.innerHTML = "";

    const topbar = document.createElement("header");
    topbar.className = "topbar";

    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.dataset.state = connState;

    const makeTabBtn = (tab: ActiveTab, label: string) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nav-btn";
      btn.textContent = label;
      btn.setAttribute("aria-pressed", String(activeTab === tab));
      btn.addEventListener("click", () => {
        activeTab = tab;
        render();
      });
      return btn;
    };

    const centerBtn = document.createElement("button");
    centerBtn.type = "button";
    centerBtn.className = "nav-btn";
    centerBtn.textContent = "Calibrar Centro";
    centerBtn.disabled = activeTab !== "gyro";
    centerBtn.addEventListener("click", () => {
      haptic();
      emitMsg({ t: "center" });
    });

    topbar.append(
      dot,
      makeTabBtn("trackpad", "Trackpad"),
      makeTabBtn("gyro", "Giroscópio"),
      centerBtn,
      makeTabBtn("keyboard", "Teclado"),
      makeTabBtn("settings", "⚙"),
    );

    const banner = document.createElement("div");
    banner.className = "banner";
    banner.hidden = true;

    const main = document.createElement("main");
    main.className = "main-stage";

    if (activeTab === "trackpad") {
      const surface = document.createElement("div");
      surface.className = "touch-surface";
      surface.textContent = "Deslize para mover · 2 dedos: rolar/pinça · 3 dedos: atalhos";
      trackpadHandle = attachTrackpad(
        surface,
        settings,
        (dx, dy) => socket.queueMove(dx, dy),
        emitMsg,
        haptic,
      );

      main.append(surface, buildMouseButtonsRow());
    } else if (activeTab === "keyboard") {
      cleanupView = renderKeyboardPanel(
        main,
        activeProfile,
        settings,
        emitMsg,
        haptic,
        (nextSettings) => {
          settings = nextSettings;
        },
      );
    } else if (activeTab === "gyro") {
      const gyroHost = document.createElement("div");
      gyroHost.style.flex = "1";
      gyroHost.style.minHeight = "0";
      gyroHost.style.display = "flex";
      gyroHandle = renderGyroView(
        gyroHost,
        settings,
        (dx, dy) => socket.queueMove(dx, dy),
        emitMsg,
        haptic,
      );
      main.append(gyroHost, buildMouseButtonsRow());
    } else {
      renderSettingsPanel(
        main,
        {
          activeProfile,
          profiles,
          settings,
          connState,
          latencyMs,
        },
        {
          emitMsg,
          onSettingsChange(next) {
            settings = next;
            void wakeLock.setEnabled(next.wake_lock);
            trackpadHandle?.updateSettings(next);
            gyroHandle?.updateSettings(next);
          },
          onUnpair() {
            clearStoredToken();
            socket.disconnect();
            void wakeLock.setEnabled(false);
            renderPairingScreen();
          },
        },
      );
    }

    root.append(topbar, banner, main);
    updateChrome();
  }

  async function bootstrap(): Promise<void> {
    const qrCode = extractQrCodeFromHash(window.location.hash);
    if (qrCode) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
      try {
        const res = await pairWithServer("qr", qrCode, deviceName);
        activeProfile = res.active_profile;
        settings = res.settings;
        profiles = res.profiles;
        socket.connect(res.token);
        render();
        return;
      } catch (err) {
        renderPairingScreen(err instanceof Error ? err.message : "QR Code inválido ou expirado.");
        return;
      }
    }

    const token = getStoredToken();
    if (token) {
      socket.connect(token);
      render();
    } else {
      renderPairingScreen();
    }
  }

  void bootstrap();
}

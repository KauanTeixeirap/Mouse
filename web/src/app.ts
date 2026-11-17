import { renderBasicKeyboardPanel } from "./keyboard/keyboard";
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
  let cleanupView: (() => void) | null = null;

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
        trackpadHandle?.updateSettings(settings);
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
    cleanupView?.();
    cleanupView = null;
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
      surface.textContent = "Deslize para mover · Toque para clicar";
      trackpadHandle = attachTrackpad(
        surface,
        settings,
        (dx, dy) => socket.queueMove(dx, dy),
        emitMsg,
        haptic,
      );

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
      main.append(surface, btnRow);
    } else if (activeTab === "keyboard") {
      cleanupView = renderBasicKeyboardPanel(main, emitMsg);
    } else if (activeTab === "gyro") {
      const surface = document.createElement("div");
      surface.className = "touch-surface";
      surface.textContent = "Modo Giroscópio disponível na Fase 2.";
      main.appendChild(surface);
    } else {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<strong>Perfil:</strong> ${activeProfile} (${profiles.join(", ")})<br><strong>Latência:</strong> ${latencyMs ?? "-"} ms`;
      main.appendChild(card);
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

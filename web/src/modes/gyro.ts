import { OneEuroFilter, applyDeadzone } from "../lib/filters";
import type { ClientMsg, KeyName, Settings } from "../protocol";
import { GestureRecognizer } from "./trackpad";

export interface GyroSample {
  /** Rotation rate in deg/s around device axes: alpha=X (pitch), beta=Y (roll), gamma=Z (XY-plane compass yaw) */
  alpha: number;
  beta: number;
  gamma: number;
  /** Gravity vector in device coordinates (m/s^2) */
  gx: number;
  gy: number;
  gz: number;
  timestampMs: number;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function normalize(v: Vec3): Vec3 | null {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-3) return null;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export class GyroProcessor {
  private settings: Settings;
  private yawFilter = new OneEuroFilter(1.2, 0.04, 1.0);
  private pitchFilter = new OneEuroFilter(1.2, 0.04, 1.0);
  private lastTimestampMs: number | null = null;
  private clutchHeld = false;
  private deadzoneDegPerSec: number;

  constructor(settings: Settings, deadzoneDegPerSec = 1.5) {
    this.settings = settings;
    this.deadzoneDegPerSec = deadzoneDegPerSec;
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  setClutchHeld(held: boolean): void {
    this.clutchHeld = held;
    if (!this.isMotionEnabled()) {
      this.resetFilters();
    }
  }

  isMotionEnabled(): boolean {
    if (this.settings.clutch_mode === "hold_to_pause") {
      return !this.clutchHeld;
    }
    return this.clutchHeld;
  }

  resetFilters(): void {
    this.yawFilter.reset();
    this.pitchFilter.reset();
    this.lastTimestampMs = null;
  }

  processSample(sample: GyroSample): { dx: number; dy: number } | null {
    if (!this.isMotionEnabled()) {
      this.lastTimestampMs = sample.timestampMs;
      return null;
    }

    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = sample.timestampMs;
      return null;
    }

    const dtSec = Math.min(0.05, Math.max(0.001, (sample.timestampMs - this.lastTimestampMs) / 1000));
    this.lastTimestampMs = sample.timestampMs;

    const gHat = normalize({ x: sample.gx, y: sample.gy, z: sample.gz });
    if (!gHat) return null;

    // W3C DeviceMotionEvent.rotationRate (§6.3):
    // - sample.alpha: rotation around device X axis (pitching tip of phone up/down) -> vertical dy
    // - sample.beta: rotation around device Y axis (rolling/tilting left/right) -> ignored
    // - sample.gamma: rotation around device Z axis (compass rotation in XY plane) -> horizontal dx
    const rawYaw = -sample.gamma;
    const rawPitch = -sample.alpha;

    const tSec = sample.timestampMs / 1000;
    const filteredYaw = applyDeadzone(this.yawFilter.filter(rawYaw, tSec), this.deadzoneDegPerSec);
    const filteredPitch = applyDeadzone(
      this.pitchFilter.filter(rawPitch, tSec),
      this.deadzoneDegPerSec,
    );

    const dx = filteredYaw * this.settings.gyro_sensitivity * dtSec;
    const dy = filteredPitch * this.settings.gyro_sensitivity * dtSec;

    if (dx === 0 && dy === 0) return null;
    return { dx, dy };
  }
}

export interface GyroHandle {
  destroy(): void;
  updateSettings(settings: Settings): void;
}

type MotionEventWithPermission = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const GYRO_REMOTE_BUTTONS: Array<{
  key: KeyName;
  label: string;
  ariaLabel: string;
}> = [
  { key: "media_volume_down", label: "🔉 Vol −", ariaLabel: "Diminuir som" },
  { key: "media_play_pause", label: "⏯ Play/Pause", ariaLabel: "Play e Pause" },
  { key: "media_volume_mute", label: "🔇 Mudo", ariaLabel: "Mudo" },
  { key: "media_volume_up", label: "🔊 Vol +", ariaLabel: "Aumentar som" },
];

export function renderGyroView(
  container: HTMLElement,
  initialSettings: Settings,
  emitMove: (dx: number, dy: number) => void,
  emitMsg: (msg: ClientMsg) => void,
  haptic: () => void,
): GyroHandle {
  let settings = initialSettings;
  const processor = new GyroProcessor(settings);
  const tapRecognizer = new GestureRecognizer(settings);
  let active = true;

  container.innerHTML = "";

  const surface = document.createElement("div");
  surface.className = "touch-surface gyro-surface";

  // Crosshair ("mira") calibrate center button inside the main gyro surface
  const centerBtn = document.createElement("button");
  centerBtn.type = "button";
  centerBtn.className = "gyro-center-btn";
  centerBtn.setAttribute("aria-label", "Calibrar Centro");
  centerBtn.title = "Calibrar Centro";
  centerBtn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>`;

  const stopBtnPointer = (e: Event) => {
    e.stopPropagation();
  };
  const onCenterClick = (e: MouseEvent) => {
    e.stopPropagation();
    haptic();
    processor.resetFilters();
    emitMsg({ t: "center" });
  };
  centerBtn.addEventListener("pointerdown", stopBtnPointer);
  centerBtn.addEventListener("pointerup", stopBtnPointer);
  centerBtn.addEventListener("pointercancel", stopBtnPointer);
  centerBtn.addEventListener("click", onCenterClick);

  const statusText = document.createElement("p");
  statusText.style.margin = "0 0 12px 0";
  statusText.textContent = "Aponte o celular para mover o cursor · Toque para clicar";

  const clutchBtn = document.createElement("button");
  clutchBtn.type = "button";
  clutchBtn.className = "clutch-btn";

  const updateClutchLabel = () => {
    const modeText =
      settings.clutch_mode === "hold_to_pause"
        ? "Embreagem (segure para pausar)"
        : "Embreagem (segure para mover)";
    clutchBtn.textContent = modeText;
  };
  updateClutchLabel();

  const onClutchDown = (e: PointerEvent) => {
    e.stopPropagation();
    clutchBtn.setPointerCapture?.(e.pointerId);
    clutchBtn.setAttribute("aria-pressed", "true");
    processor.setClutchHeld(true);
    haptic();
  };
  const onClutchUp = (e: PointerEvent) => {
    e.stopPropagation();
    clutchBtn.setAttribute("aria-pressed", "false");
    processor.setClutchHeld(false);
  };

  clutchBtn.addEventListener("pointerdown", onClutchDown);
  clutchBtn.addEventListener("pointerup", onClutchUp);
  clutchBtn.addEventListener("pointercancel", onClutchUp);

  // TV remote media/volume control panel inside the gyro area
  const remoteBar = document.createElement("div");
  remoteBar.className = "gyro-remote";
  remoteBar.setAttribute("role", "group");
  remoteBar.setAttribute("aria-label", "Controle de mídia e volume");

  for (const item of GYRO_REMOTE_BUTTONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gyro-remote-btn";
    btn.dataset.key = item.key;
    btn.setAttribute("aria-label", item.ariaLabel);
    btn.title = item.ariaLabel;
    btn.textContent = item.label;
    btn.addEventListener("pointerdown", stopBtnPointer);
    btn.addEventListener("pointerup", stopBtnPointer);
    btn.addEventListener("pointercancel", stopBtnPointer);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      haptic();
      emitMsg({ t: "key", k: item.key, s: "tap" });
    });
    remoteBar.appendChild(btn);
  }

  // Surface still accepts 1-finger tap (left click) and 2-finger tap (right click)
  const handleTapCmds = (cmds: ReturnType<GestureRecognizer["onDown"]>) => {
    for (const cmd of cmds) {
      if (cmd.kind === "msg" && cmd.msg.t === "btn") emitMsg(cmd.msg);
      else if (cmd.kind === "haptic") haptic();
    }
  };
  const onSurfaceDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement | null)?.closest("button")) return;
    surface.setPointerCapture?.(e.pointerId);
    handleTapCmds(
      tapRecognizer.onDown({
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        timeMs: e.timeStamp || performance.now(),
      }),
    );
  };
  const onSurfaceUp = (e: PointerEvent) => {
    if ((e.target as HTMLElement | null)?.closest("button")) return;
    handleTapCmds(
      tapRecognizer.onUp({
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        timeMs: e.timeStamp || performance.now(),
      }),
    );
  };
  const onSurfaceCancel = (e: PointerEvent) => {
    handleTapCmds(tapRecognizer.onCancel(e.pointerId));
  };

  surface.addEventListener("pointerdown", onSurfaceDown);
  surface.addEventListener("pointerup", onSurfaceUp);
  surface.addEventListener("pointercancel", onSurfaceCancel);

  const onDeviceMotion = (e: DeviceMotionEvent) => {
    if (!active) return;
    const rot = e.rotationRate;
    const acc = e.accelerationIncludingGravity;
    if (!rot || !acc) return;
    if (
      rot.alpha === null ||
      rot.beta === null ||
      rot.gamma === null ||
      acc.x === null ||
      acc.y === null ||
      acc.z === null
    ) {
      return;
    }
    const delta = processor.processSample({
      alpha: rot.alpha,
      beta: rot.beta,
      gamma: rot.gamma,
      gx: acc.x,
      gy: acc.y,
      gz: acc.z,
      timestampMs: e.timeStamp || performance.now(),
    });
    if (delta) {
      emitMove(delta.dx, delta.dy);
    }
  };

  const attachMotionListener = async () => {
    const dm = window.DeviceMotionEvent as MotionEventWithPermission | undefined;
    if (dm && typeof dm.requestPermission === "function") {
      try {
        const perm = await dm.requestPermission();
        if (perm !== "granted") {
          statusText.textContent = "Permissão de sensor negada pelo navegador.";
          return;
        }
      } catch {
        // Requires user gesture if blocked
      }
    }
    if (active) {
      window.addEventListener("devicemotion", onDeviceMotion);
    }
  };

  void attachMotionListener();

  surface.append(centerBtn, statusText, clutchBtn, remoteBar);
  container.appendChild(surface);

  return {
    updateSettings(next: Settings) {
      settings = next;
      processor.updateSettings(next);
      tapRecognizer.updateSettings(next);
      updateClutchLabel();
    },
    destroy() {
      active = false;
      window.removeEventListener("devicemotion", onDeviceMotion);
      centerBtn.removeEventListener("pointerdown", stopBtnPointer);
      centerBtn.removeEventListener("pointerup", stopBtnPointer);
      centerBtn.removeEventListener("pointercancel", stopBtnPointer);
      centerBtn.removeEventListener("click", onCenterClick);
      clutchBtn.removeEventListener("pointerdown", onClutchDown);
      clutchBtn.removeEventListener("pointerup", onClutchUp);
      clutchBtn.removeEventListener("pointercancel", onClutchUp);
      surface.removeEventListener("pointerdown", onSurfaceDown);
      surface.removeEventListener("pointerup", onSurfaceUp);
      surface.removeEventListener("pointercancel", onSurfaceCancel);
    },
  };
}

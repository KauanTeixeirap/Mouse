import { OneEuroFilter, applyDeadzone } from "../lib/filters";
import type { ClientMsg, Settings } from "../protocol";
import { GestureRecognizer } from "./trackpad";

export interface GyroSample {
  /** Rotation rate in deg/s around device axes: alpha=Z, beta=X, gamma=Y */
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

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
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

    // Project device +X (right edge) onto plane orthogonal to gravity
    const xAxis: Vec3 = { x: 1, y: 0, z: 0 };
    const xDotG = dot(xAxis, gHat);
    let rCandidate: Vec3 = {
      x: xAxis.x - xDotG * gHat.x,
      y: xAxis.y - xDotG * gHat.y,
      z: xAxis.z - xDotG * gHat.z,
    };
    let rHat = normalize(rCandidate);
    if (!rHat) {
      // Fallback if device +X is nearly vertical (landscape orientation)
      rCandidate = cross({ x: 0, y: 1, z: 0 }, gHat);
      rHat = normalize(rCandidate) ?? { x: 0, y: 0, z: 1 };
    }

    // W3C rotationRate: beta=around X, gamma=around Y, alpha=around Z
    const omega: Vec3 = { x: sample.beta, y: sample.gamma, z: sample.alpha };
    const rawYaw = -dot(omega, gHat);
    const rawPitch = -dot(omega, rHat);

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

  // Surface still accepts 1-finger tap (left click) and 2-finger tap (right click)
  const handleTapCmds = (cmds: ReturnType<GestureRecognizer["onDown"]>) => {
    for (const cmd of cmds) {
      if (cmd.kind === "msg" && cmd.msg.t === "btn") emitMsg(cmd.msg);
      else if (cmd.kind === "haptic") haptic();
    }
  };
  const onSurfaceDown = (e: PointerEvent) => {
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

  surface.append(statusText, clutchBtn);
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
      clutchBtn.removeEventListener("pointerdown", onClutchDown);
      clutchBtn.removeEventListener("pointerup", onClutchUp);
      clutchBtn.removeEventListener("pointercancel", onClutchUp);
      surface.removeEventListener("pointerdown", onSurfaceDown);
      surface.removeEventListener("pointerup", onSurfaceUp);
      surface.removeEventListener("pointercancel", onSurfaceCancel);
    },
  };
}

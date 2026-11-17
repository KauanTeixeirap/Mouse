import type { ClientMsg, Settings } from "../protocol";

export interface TrackpadHandle {
  destroy(): void;
  updateSettings(settings: Settings): void;
}

interface ActivePointer {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTime: number;
}

export function attachTrackpad(
  surface: HTMLElement,
  initialSettings: Settings,
  emitMove: (dx: number, dy: number) => void,
  emitMsg: (msg: ClientMsg) => void,
  haptic: () => void,
): TrackpadHandle {
  let settings = initialSettings;
  const pointers = new Map<number, ActivePointer>();
  let primaryMoved = false;

  const onPointerDown = (e: PointerEvent) => {
    surface.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      startTime: e.timeStamp || performance.now(),
    });
    if (pointers.size === 1) {
      primaryMoved = false;
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const ptr = pointers.get(e.pointerId);
    if (!ptr) return;
    const dx = e.clientX - ptr.x;
    const dy = e.clientY - ptr.y;
    ptr.x = e.clientX;
    ptr.y = e.clientY;

    if (pointers.size === 1) {
      const dist = Math.hypot(ptr.x - ptr.startX, ptr.y - ptr.startY);
      if (dist > 8) primaryMoved = true;
      emitMove(dx * settings.trackpad_sensitivity, dy * settings.trackpad_sensitivity);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    const ptr = pointers.get(e.pointerId);
    const countBefore = pointers.size;
    pointers.delete(e.pointerId);
    if (!ptr) return;

    const elapsed = (e.timeStamp || performance.now()) - ptr.startTime;
    const dist = Math.hypot(e.clientX - ptr.startX, e.clientY - ptr.startY);
    if (countBefore === 1 && !primaryMoved && elapsed < 200 && dist < 8) {
      haptic();
      emitMsg({ t: "btn", b: "left", s: "click" });
    }
  };

  const onPointerCancel = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
  };

  surface.addEventListener("pointerdown", onPointerDown);
  surface.addEventListener("pointermove", onPointerMove);
  surface.addEventListener("pointerup", onPointerUp);
  surface.addEventListener("pointercancel", onPointerCancel);

  return {
    updateSettings(next: Settings) {
      settings = next;
    },
    destroy() {
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerCancel);
      pointers.clear();
    },
  };
}

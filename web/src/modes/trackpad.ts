import { computeAcceleration } from "../lib/filters";
import type { ClientMsg, KeyName, Settings } from "../protocol";

export interface TrackpadPoint {
  id: number;
  x: number;
  y: number;
  timeMs: number;
}

export type GestureCommand =
  | { kind: "move"; dx: number; dy: number }
  | { kind: "msg"; msg: ClientMsg }
  | { kind: "haptic" };

interface TrackedPointer {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTimeMs: number;
}

const SINGLE_TAP_MAX_MS = 200;
const SINGLE_TAP_MAX_PX = 8;
const DOUBLE_TAP_WINDOW_MS = 250;
const DOUBLE_TAP_MAX_DIST_PX = 28;
const TWO_FINGER_TAP_MAX_MS = 250;
const TWO_FINGER_TAP_MAX_PX = 12;
const TWO_FINGER_PINCH_MIN_PX = 28;
const THREE_FINGER_SWIPE_MIN_PX = 35;
const THREE_FINGER_TAP_MAX_MS = 300;
const THREE_FINGER_TAP_MAX_PX = 20;

export class GestureRecognizer {
  private settings: Settings;
  private pointers = new Map<number, TrackedPointer>();
  private maxFingers = 0;
  private gestureStartMs = 0;
  private lastMoveMs = 0;

  private singleMoved = false;
  private doubleTapDragging = false;
  private lastTapTimeMs = -Infinity;
  private lastTapX = 0;
  private lastTapY = 0;

  private twoFingerMode: "idle" | "scroll" | "pinch" = "idle";
  private twoCumCentroid = 0;
  private twoCumPinch = 0;
  private twoStartCentroid: { x: number; y: number } | null = null;
  private twoStartDistance = 0;
  private twoMovedIds = new Set<number>();
  private zoomRemainder = 0;
  private prevCentroid: { x: number; y: number } | null = null;
  private prevDistance = 0;

  private threeStartCentroid: { x: number; y: number } | null = null;
  private threeLastCentroid: { x: number; y: number } | null = null;
  private threeFired = false;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  private centroid(): { x: number; y: number } {
    let sx = 0;
    let sy = 0;
    for (const p of this.pointers.values()) {
      sx += p.x;
      sy += p.y;
    }
    const n = Math.max(1, this.pointers.size);
    return { x: sx / n, y: sy / n };
  }

  private twoFingerDistance(): number {
    const arr = Array.from(this.pointers.values());
    if (arr.length < 2) return 0;
    return Math.hypot(arr[1].x - arr[0].x, arr[1].y - arr[0].y);
  }

  private keysToMsg(keys: KeyName[]): ClientMsg | null {
    if (keys.length === 0) return null;
    if (keys.length === 1) {
      return { t: "key", k: keys[0], s: "tap" };
    }
    return { t: "combo", k: [...keys] };
  }

  onDown(pt: TrackpadPoint): GestureCommand[] {
    const cmds: GestureCommand[] = [];
    this.pointers.set(pt.id, {
      id: pt.id,
      x: pt.x,
      y: pt.y,
      startX: pt.x,
      startY: pt.y,
      startTimeMs: pt.timeMs,
    });

    const count = this.pointers.size;
    if (count === 1) {
      this.maxFingers = 1;
      this.gestureStartMs = pt.timeMs;
      this.lastMoveMs = pt.timeMs;
      this.singleMoved = false;
      this.twoFingerMode = "idle";
      this.twoCumCentroid = 0;
      this.twoCumPinch = 0;
      this.twoStartCentroid = null;
      this.twoStartDistance = 0;
      this.twoMovedIds.clear();
      this.zoomRemainder = 0;
      this.prevCentroid = null;
      this.threeStartCentroid = null;
      this.threeLastCentroid = null;
      this.threeFired = false;

      if (
        pt.timeMs - this.lastTapTimeMs <= DOUBLE_TAP_WINDOW_MS &&
        Math.hypot(pt.x - this.lastTapX, pt.y - this.lastTapY) <= DOUBLE_TAP_MAX_DIST_PX
      ) {
        this.doubleTapDragging = true;
        cmds.push({ kind: "haptic" });
        cmds.push({ kind: "msg", msg: { t: "btn", b: "left", s: "down" } });
      } else {
        this.doubleTapDragging = false;
      }
    } else {
      this.maxFingers = Math.max(this.maxFingers, count);
      if (this.doubleTapDragging) {
        this.doubleTapDragging = false;
        cmds.push({ kind: "msg", msg: { t: "btn", b: "left", s: "up" } });
      }
      if (count === 2) {
        const c = this.centroid();
        const dist = this.twoFingerDistance();
        this.twoFingerMode = "idle";
        this.twoCumCentroid = 0;
        this.twoCumPinch = 0;
        this.twoStartCentroid = c;
        this.twoStartDistance = dist;
        this.twoMovedIds.clear();
        this.zoomRemainder = 0;
        this.prevCentroid = c;
        this.prevDistance = dist;
      } else if (count === 3) {
        const c = this.centroid();
        this.threeStartCentroid = c;
        this.threeLastCentroid = c;
        this.threeFired = false;
        this.gestureStartMs = pt.timeMs;
      }
    }
    return cmds;
  }

  onMove(pt: TrackpadPoint): GestureCommand[] {
    const existing = this.pointers.get(pt.id);
    if (!existing) return [];

    const dxRaw = pt.x - existing.x;
    const dyRaw = pt.y - existing.y;
    existing.x = pt.x;
    existing.y = pt.y;

    const cmds: GestureCommand[] = [];
    const count = this.pointers.size;

    if (count === 1 && this.maxFingers === 1) {
      const distFromStart = Math.hypot(pt.x - existing.startX, pt.y - existing.startY);
      if (distFromStart > SINGLE_TAP_MAX_PX) {
        this.singleMoved = true;
      }
      const dt = Math.max(1, pt.timeMs - this.lastMoveMs);
      this.lastMoveMs = pt.timeMs;
      const speed = Math.hypot(dxRaw, dyRaw) / dt;
      const gain = computeAcceleration(
        speed,
        this.settings.trackpad_sensitivity,
        this.settings.acceleration,
      );
      if (dxRaw !== 0 || dyRaw !== 0) {
        cmds.push({ kind: "move", dx: dxRaw * gain, dy: dyRaw * gain });
      }
      return cmds;
    }

    if (count === 2 && this.maxFingers === 2) {
      this.twoMovedIds.add(pt.id);
      const c = this.centroid();
      const dist = this.twoFingerDistance();
      if (this.prevCentroid === null || this.twoStartCentroid === null) {
        this.twoStartCentroid = c;
        this.twoStartDistance = dist;
        this.prevCentroid = c;
        this.prevDistance = dist;
        return cmds;
      }

      const dcx = c.x - this.prevCentroid.x;
      const dcy = c.y - this.prevCentroid.y;
      const dDist = dist - this.prevDistance;
      this.prevCentroid = c;
      this.prevDistance = dist;

      const netCentroid = Math.hypot(
        c.x - this.twoStartCentroid.x,
        c.y - this.twoStartCentroid.y,
      );
      const netPinch = Math.abs(dist - this.twoStartDistance);
      this.twoCumCentroid = Math.max(this.twoCumCentroid, netCentroid);
      this.twoCumPinch = Math.max(this.twoCumPinch, netPinch);

      const pts = Array.from(this.pointers.values());
      const v1x = pts[0].x - pts[0].startX;
      const v1y = pts[0].y - pts[0].startY;
      const v2x = pts[1].x - pts[1].startX;
      const v2y = pts[1].y - pts[1].startY;
      const vDot = v1x * v2x + v1y * v2y;

      let enteredPinch = false;
      if (this.twoFingerMode === "idle") {
        if (
          netCentroid >= TWO_FINGER_TAP_MAX_PX &&
          (vDot > 0 || netCentroid >= netPinch)
        ) {
          this.twoFingerMode = "scroll";
        } else if (
          this.twoMovedIds.size >= 2 &&
          vDot <= 0 &&
          netPinch >= TWO_FINGER_PINCH_MIN_PX &&
          netPinch > netCentroid * 1.6
        ) {
          this.twoFingerMode = "pinch";
          enteredPinch = true;
        }
      }

      if (this.twoFingerMode === "pinch") {
        const deltaPinch = enteredPinch ? dist - this.twoStartDistance : dDist;
        this.zoomRemainder += deltaPinch * 0.08;
        if (Math.abs(this.zoomRemainder) >= 0.5) {
          cmds.push({ kind: "msg", msg: { t: "zoom", d: this.zoomRemainder } });
          this.zoomRemainder = 0;
        }
      } else if (this.twoFingerMode === "scroll" && (dcx !== 0 || dcy !== 0)) {
        const dir = this.settings.natural_scroll ? 1 : -1;
        const scale = 0.15 * this.settings.scroll_speed * dir;
        cmds.push({ kind: "msg", msg: { t: "scroll", dx: dcx * scale, dy: dcy * scale } });
      }
      return cmds;
    }

    if (count === 3) {
      this.threeLastCentroid = this.centroid();
    }

    return cmds;
  }

  onUp(pt: TrackpadPoint): GestureCommand[] {
    const existing = this.pointers.get(pt.id);
    if (!existing) return [];
    existing.x = pt.x;
    existing.y = pt.y;

    const cmds: GestureCommand[] = [];

    if (this.pointers.size === 3 && this.maxFingers === 3 && !this.threeFired) {
      const start = this.threeStartCentroid;
      const end = this.threeLastCentroid ?? this.centroid();
      if (start) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const dist = Math.hypot(dx, dy);
        const elapsed = pt.timeMs - this.gestureStartMs;
        let actionKeys: KeyName[] | null = null;
        if (dist >= THREE_FINGER_SWIPE_MIN_PX) {
          if (Math.abs(dx) > Math.abs(dy)) {
            actionKeys = dx > 0 ? this.settings.three_finger.right : this.settings.three_finger.left;
          } else {
            actionKeys = dy < 0 ? this.settings.three_finger.up : this.settings.three_finger.down;
          }
        } else if (elapsed < THREE_FINGER_TAP_MAX_MS && dist < THREE_FINGER_TAP_MAX_PX) {
          actionKeys = this.settings.three_finger.tap;
        }
        if (actionKeys) {
          const msg = this.keysToMsg(actionKeys);
          if (msg) {
            this.threeFired = true;
            cmds.push({ kind: "haptic" });
            cmds.push({ kind: "msg", msg });
          }
        }
      }
    }

    this.pointers.delete(pt.id);

    if (this.pointers.size === 0) {
      const elapsed = pt.timeMs - this.gestureStartMs;
      const dist = Math.hypot(pt.x - existing.startX, pt.y - existing.startY);

      if (this.doubleTapDragging) {
        this.doubleTapDragging = false;
        this.lastTapTimeMs = -Infinity;
        cmds.push({ kind: "msg", msg: { t: "btn", b: "left", s: "up" } });
        return cmds;
      }

      if (this.maxFingers === 1 && !this.singleMoved && elapsed < SINGLE_TAP_MAX_MS && dist < SINGLE_TAP_MAX_PX) {
        this.lastTapTimeMs = pt.timeMs;
        this.lastTapX = pt.x;
        this.lastTapY = pt.y;
        cmds.push({ kind: "haptic" });
        cmds.push({ kind: "msg", msg: { t: "btn", b: "left", s: "click" } });
      } else if (
        this.maxFingers === 2 &&
        this.twoFingerMode === "idle" &&
        elapsed < TWO_FINGER_TAP_MAX_MS &&
        this.twoCumCentroid < TWO_FINGER_TAP_MAX_PX &&
        this.twoCumPinch < TWO_FINGER_TAP_MAX_PX
      ) {
        cmds.push({ kind: "haptic" });
        cmds.push({ kind: "msg", msg: { t: "btn", b: "right", s: "click" } });
      }

      this.maxFingers = 0;
    }

    return cmds;
  }

  onCancel(id: number): GestureCommand[] {
    this.pointers.delete(id);
    if (this.pointers.size === 0) {
      this.maxFingers = 0;
      if (this.doubleTapDragging) {
        this.doubleTapDragging = false;
        return [{ kind: "msg", msg: { t: "btn", b: "left", s: "up" } }];
      }
    }
    return [];
  }
}

export interface TrackpadHandle {
  destroy(): void;
  updateSettings(settings: Settings): void;
}

export function attachTrackpad(
  surface: HTMLElement,
  initialSettings: Settings,
  emitMove: (dx: number, dy: number) => void,
  emitMsg: (msg: ClientMsg) => void,
  haptic: () => void,
): TrackpadHandle {
  const recognizer = new GestureRecognizer(initialSettings);

  const dispatch = (commands: GestureCommand[]) => {
    for (const cmd of commands) {
      if (cmd.kind === "move") emitMove(cmd.dx, cmd.dy);
      else if (cmd.kind === "msg") emitMsg(cmd.msg);
      else haptic();
    }
  };

  const toPoint = (e: PointerEvent): TrackpadPoint => ({
    id: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    timeMs: e.timeStamp || performance.now(),
  });

  const onDown = (e: PointerEvent) => {
    surface.setPointerCapture?.(e.pointerId);
    dispatch(recognizer.onDown(toPoint(e)));
  };
  const onMove = (e: PointerEvent) => dispatch(recognizer.onMove(toPoint(e)));
  const onUp = (e: PointerEvent) => dispatch(recognizer.onUp(toPoint(e)));
  const onCancel = (e: PointerEvent) => dispatch(recognizer.onCancel(e.pointerId));

  surface.addEventListener("pointerdown", onDown);
  surface.addEventListener("pointermove", onMove);
  surface.addEventListener("pointerup", onUp);
  surface.addEventListener("pointercancel", onCancel);

  return {
    updateSettings(next: Settings) {
      recognizer.updateSettings(next);
    },
    destroy() {
      surface.removeEventListener("pointerdown", onDown);
      surface.removeEventListener("pointermove", onMove);
      surface.removeEventListener("pointerup", onUp);
      surface.removeEventListener("pointercancel", onCancel);
    },
  };
}

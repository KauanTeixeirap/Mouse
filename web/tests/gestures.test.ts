import { describe, expect, it } from "vitest";
import { GestureRecognizer } from "../src/modes/trackpad";
import { DEFAULT_SETTINGS } from "../src/protocol";

describe("GestureRecognizer", () => {
  it("recognizes 1-finger tap and 1-finger drag with acceleration", () => {
    const rec = new GestureRecognizer(structuredClone(DEFAULT_SETTINGS));

    // Quick tap
    expect(rec.onDown({ id: 1, x: 100, y: 100, timeMs: 0 })).toEqual([]);
    const tapCmds = rec.onUp({ id: 1, x: 102, y: 101, timeMs: 60 });
    expect(tapCmds).toContainEqual({ kind: "msg", msg: { t: "btn", b: "left", s: "click" } });

    // Drag (after tap window expires)
    rec.onDown({ id: 1, x: 100, y: 100, timeMs: 500 });
    const moveSlow = rec.onMove({ id: 1, x: 104, y: 100, timeMs: 550 });
    const moveFast = rec.onMove({ id: 1, x: 144, y: 100, timeMs: 560 });
    rec.onUp({ id: 1, x: 144, y: 100, timeMs: 580 });

    expect(moveSlow[0]?.kind).toBe("move");
    expect(moveFast[0]?.kind).toBe("move");
    if (moveSlow[0]?.kind === "move" && moveFast[0]?.kind === "move") {
      // Fast swipe has higher gain than slow move
      expect(moveFast[0].dx / 40).toBeGreaterThan(moveSlow[0].dx / 4);
    }
  });

  it("recognizes 2-finger tap as right click", () => {
    const rec = new GestureRecognizer(structuredClone(DEFAULT_SETTINGS));
    rec.onDown({ id: 1, x: 100, y: 100, timeMs: 0 });
    rec.onDown({ id: 2, x: 140, y: 100, timeMs: 10 });
    expect(rec.onUp({ id: 1, x: 101, y: 100, timeMs: 80 })).toEqual([]);
    const end = rec.onUp({ id: 2, x: 141, y: 100, timeMs: 90 });
    expect(end).toContainEqual({ kind: "msg", msg: { t: "btn", b: "right", s: "click" } });
  });

  it("recognizes 2-finger scroll respecting natural_scroll", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.natural_scroll = true;
    const rec = new GestureRecognizer(settings);

    rec.onDown({ id: 1, x: 100, y: 100, timeMs: 0 });
    rec.onDown({ id: 2, x: 140, y: 100, timeMs: 0 });
    rec.onMove({ id: 1, x: 100, y: 120, timeMs: 20 });
    const scrollNatural = rec.onMove({ id: 2, x: 140, y: 120, timeMs: 20 });
    expect(scrollNatural.some((c) => c.kind === "msg" && c.msg.t === "scroll" && c.msg.dy > 0)).toBe(
      true,
    );

    settings.natural_scroll = false;
    rec.updateSettings(settings);
    const scrollInverted = rec.onMove({ id: 1, x: 100, y: 140, timeMs: 40 });
    expect(scrollInverted.some((c) => c.kind === "msg" && c.msg.t === "scroll" && c.msg.dy < 0)).toBe(
      true,
    );
  });

  it("recognizes 2-finger pinch as zoom", () => {
    const rec = new GestureRecognizer(structuredClone(DEFAULT_SETTINGS));
    rec.onDown({ id: 1, x: 100, y: 100, timeMs: 0 });
    rec.onDown({ id: 2, x: 140, y: 100, timeMs: 0 });
    rec.onMove({ id: 1, x: 80, y: 100, timeMs: 20 });
    const zoomCmds = rec.onMove({ id: 2, x: 160, y: 100, timeMs: 20 });
    expect(zoomCmds.some((c) => c.kind === "msg" && c.msg.t === "zoom" && c.msg.d > 0)).toBe(true);
  });

  it("recognizes double-tap and hold drag", () => {
    const rec = new GestureRecognizer(structuredClone(DEFAULT_SETTINGS));
    rec.onDown({ id: 1, x: 100, y: 100, timeMs: 0 });
    rec.onUp({ id: 1, x: 100, y: 100, timeMs: 50 });

    const downCmds = rec.onDown({ id: 1, x: 102, y: 101, timeMs: 140 });
    expect(downCmds).toContainEqual({ kind: "msg", msg: { t: "btn", b: "left", s: "down" } });

    const moveCmds = rec.onMove({ id: 1, x: 150, y: 120, timeMs: 200 });
    expect(moveCmds.some((c) => c.kind === "move")).toBe(true);

    const upCmds = rec.onUp({ id: 1, x: 150, y: 120, timeMs: 260 });
    expect(upCmds).toContainEqual({ kind: "msg", msg: { t: "btn", b: "left", s: "up" } });
  });

  it("recognizes 3-finger tap and directional swipes", () => {
    const rec = new GestureRecognizer(structuredClone(DEFAULT_SETTINGS));

    // 3-finger tap -> media_play_pause
    rec.onDown({ id: 1, x: 80, y: 100, timeMs: 0 });
    rec.onDown({ id: 2, x: 120, y: 100, timeMs: 5 });
    rec.onDown({ id: 3, x: 160, y: 100, timeMs: 10 });
    const tap3 = rec.onUp({ id: 1, x: 80, y: 100, timeMs: 90 });
    expect(tap3).toContainEqual({ kind: "msg", msg: { t: "key", k: "media_play_pause", s: "tap" } });
    rec.onUp({ id: 2, x: 120, y: 100, timeMs: 95 });
    rec.onUp({ id: 3, x: 160, y: 100, timeMs: 100 });

    // 3-finger swipe up -> ["win", "tab"]
    rec.onDown({ id: 1, x: 80, y: 200, timeMs: 300 });
    rec.onDown({ id: 2, x: 120, y: 200, timeMs: 305 });
    rec.onDown({ id: 3, x: 160, y: 200, timeMs: 310 });
    rec.onMove({ id: 1, x: 80, y: 130, timeMs: 360 });
    rec.onMove({ id: 2, x: 120, y: 130, timeMs: 360 });
    rec.onMove({ id: 3, x: 160, y: 130, timeMs: 360 });
    const swipeUp = rec.onUp({ id: 1, x: 80, y: 130, timeMs: 380 });
    expect(swipeUp).toContainEqual({ kind: "msg", msg: { t: "combo", k: ["win", "tab"] } });
  });
});

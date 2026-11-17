// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { OneEuroFilter } from "../src/lib/filters";
import { GyroProcessor, renderGyroView } from "../src/modes/gyro";
import { type ClientMsg, DEFAULT_SETTINGS } from "../src/protocol";

describe("GyroProcessor and OneEuroFilter", () => {
  it("maps pitch (alpha) to vertical dy, XY-plane compass rotation (gamma) to horizontal dx, and ignores lateral roll (beta)", () => {
    const gyro = new GyroProcessor(structuredClone(DEFAULT_SETTINGS), 0);
    gyro.processSample({ alpha: 0, beta: 0, gamma: 0, gx: 0, gy: 0, gz: 9.81, timestampMs: 0 });

    // Moving phone tip up (alpha > 0) => cursor moves up (dy < 0, dx === 0)
    const tipUp = gyro.processSample({
      alpha: 40,
      beta: 0,
      gamma: 0,
      gx: 0,
      gy: 0,
      gz: 9.81,
      timestampMs: 16,
    });
    expect(tipUp).not.toBeNull();
    expect(tipUp!.dx).toBe(0);
    expect(tipUp!.dy).toBeLessThan(0);

    // Moving phone tip down (alpha < 0) => cursor moves down (dy > 0)
    gyro.resetFilters();
    gyro.processSample({ alpha: 0, beta: 0, gamma: 0, gx: 0, gy: 0, gz: 9.81, timestampMs: 32 });
    const tipDown = gyro.processSample({
      alpha: -40,
      beta: 0,
      gamma: 0,
      gx: 0,
      gy: 0,
      gz: 9.81,
      timestampMs: 48,
    });
    expect(tipDown).not.toBeNull();
    expect(tipDown!.dx).toBe(0);
    expect(tipDown!.dy).toBeGreaterThan(0);

    // Compass rotation in XY plane to the right (gamma < 0) => cursor moves right (dx > 0, dy === 0)
    gyro.resetFilters();
    gyro.processSample({ alpha: 0, beta: 0, gamma: 0, gx: 0, gy: 0, gz: 9.81, timestampMs: 64 });
    const compassRight = gyro.processSample({
      alpha: 0,
      beta: 0,
      gamma: -40,
      gx: 0,
      gy: 0,
      gz: 9.81,
      timestampMs: 80,
    });
    expect(compassRight).not.toBeNull();
    expect(compassRight!.dx).toBeGreaterThan(0);
    expect(compassRight!.dy).toBe(0);

    // Compass rotation in XY plane to the left (gamma > 0) => cursor moves left (dx < 0, dy === 0)
    gyro.resetFilters();
    gyro.processSample({ alpha: 0, beta: 0, gamma: 0, gx: 0, gy: 0, gz: 9.81, timestampMs: 96 });
    const compassLeft = gyro.processSample({
      alpha: 0,
      beta: 0,
      gamma: 40,
      gx: 0,
      gy: 0,
      gz: 9.81,
      timestampMs: 112,
    });
    expect(compassLeft).not.toBeNull();
    expect(compassLeft!.dx).toBeLessThan(0);
    expect(compassLeft!.dy).toBe(0);

    // Lateral roll / tilting left-right (beta != 0) => zero movement (null)
    gyro.resetFilters();
    gyro.processSample({ alpha: 0, beta: 0, gamma: 0, gx: 0, gy: 0, gz: 9.81, timestampMs: 128 });
    const rollOnly = gyro.processSample({
      alpha: 0,
      beta: 45,
      gamma: 0,
      gx: 0,
      gy: 0,
      gz: 9.81,
      timestampMs: 144,
    });
    expect(rollOnly).toBeNull();
    // Zero-gravity invalid sample returns null
    expect(
      gyro.processSample({
        alpha: 40,
        beta: 0,
        gamma: -40,
        gx: 0,
        gy: 0,
        gz: 0,
        timestampMs: 160,
      }),
    ).toBeNull();
  });

  it("suppresses jitter below deadzone and respects clutch modes", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.clutch_mode = "hold_to_pause";
    const gyro = new GyroProcessor(settings, 2.0);
    gyro.processSample({ alpha: 0, beta: 0, gamma: 0, gx: 0, gy: 9.81, gz: 0, timestampMs: 0 });

    // Below 2.0 deg/s deadzone
    expect(
      gyro.processSample({ alpha: 0.5, beta: 0.5, gamma: -1.0, gx: 0, gy: 9.81, gz: 0, timestampMs: 16 }),
    ).toBeNull();

    // Holding clutch pauses motion in hold_to_pause
    gyro.setClutchHeld(true);
    expect(
      gyro.processSample({ alpha: 0, beta: 0, gamma: -50, gx: 0, gy: 9.81, gz: 0, timestampMs: 32 }),
    ).toBeNull();

    // Switch to hold_to_move
    settings.clutch_mode = "hold_to_move";
    gyro.updateSettings(settings);
    gyro.setClutchHeld(false);
    expect(
      gyro.processSample({ alpha: 0, beta: 0, gamma: -50, gx: 0, gy: 9.81, gz: 0, timestampMs: 48 }),
    ).toBeNull();

    gyro.setClutchHeld(true);
    gyro.processSample({ alpha: 0, beta: 0, gamma: 0, gx: 0, gy: 9.81, gz: 0, timestampMs: 64 });
    const moving = gyro.processSample({
      alpha: 0,
      beta: 0,
      gamma: -50,
      gx: 0,
      gy: 9.81,
      gz: 0,
      timestampMs: 80,
    });
    expect(moving).not.toBeNull();
    expect(moving!.dx).toBeGreaterThan(0);
  });

  it("OneEuroFilter smooths small oscillations", () => {
    const filter = new OneEuroFilter(1.0, 0.01, 1.0);
    const inputs = [1.0, -1.0, 1.0, -1.0, 1.0];
    const outputs = inputs.map((v, i) => filter.filter(v, i * 0.016));
    const maxOutput = Math.max(...outputs.slice(1).map(Math.abs));
    expect(maxOutput).toBeLessThan(1.0);
  });

  it("renders crosshair center button and TV remote media controls inside gyro surface without firing surface clicks", () => {
    const host = document.createElement("div");
    const emitted: ClientMsg[] = [];
    const emitMove = vi.fn();
    const haptic = vi.fn();

    const handle = renderGyroView(
      host,
      structuredClone(DEFAULT_SETTINGS),
      emitMove,
      (msg) => emitted.push(msg),
      haptic,
    );

    const centerBtn = host.querySelector<HTMLButtonElement>(".gyro-center-btn");
    expect(centerBtn).not.toBeNull();
    expect(centerBtn?.querySelector("svg")).not.toBeNull();

    centerBtn!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    centerBtn!.dispatchEvent(new Event("pointerup", { bubbles: true }));
    centerBtn!.click();

    expect(emitted).toEqual([{ t: "center" }]);

    const expectedRemoteKeys = [
      "media_volume_down",
      "media_play_pause",
      "media_volume_mute",
      "media_volume_up",
    ] as const;

    for (const key of expectedRemoteKeys) {
      emitted.length = 0;
      const btn = host.querySelector<HTMLButtonElement>(`.gyro-remote-btn[data-key="${key}"]`);
      expect(btn).not.toBeNull();
      btn!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      btn!.dispatchEvent(new Event("pointerup", { bubbles: true }));
      btn!.click();
      expect(emitted).toEqual([{ t: "key", k: key, s: "tap" }]);
      expect(emitted.some((m) => m.t === "btn")).toBe(false);
    }

    handle.destroy();
  });

  it("renders lateral scroll strip inside gyro surface and emits vertical scroll on drag without firing surface clicks", () => {
    const host = document.createElement("div");
    const emitted: ClientMsg[] = [];
    const emitMove = vi.fn();
    const haptic = vi.fn();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.natural_scroll = true;
    settings.scroll_speed = 1.0;

    const handle = renderGyroView(
      host,
      settings,
      emitMove,
      (msg) => emitted.push(msg),
      haptic,
    );

    const scrollStrip = host.querySelector<HTMLElement>(".gyro-scroll");
    expect(scrollStrip).not.toBeNull();

    const makePtr = (type: string, clientY: number) =>
      Object.assign(new Event(type, { bubbles: true }), { pointerId: 7, clientY });

    scrollStrip!.dispatchEvent(makePtr("pointerdown", 100));
    expect(scrollStrip!.dataset.active).toBe("true");
    scrollStrip!.dispatchEvent(makePtr("pointermove", 140));
    scrollStrip!.dispatchEvent(makePtr("pointermove", 120));
    scrollStrip!.dispatchEvent(makePtr("pointerup", 120));
    expect(scrollStrip!.dataset.active).toBeUndefined();

    expect(emitted).toEqual([
      { t: "scroll", dx: 0, dy: 40 * 0.15 },
      { t: "scroll", dx: 0, dy: -20 * 0.15 },
    ]);
    expect(emitted.some((m) => m.t === "btn")).toBe(false);

    // Inverted scroll when natural_scroll is false
    emitted.length = 0;
    const inverted = structuredClone(DEFAULT_SETTINGS);
    inverted.natural_scroll = false;
    inverted.scroll_speed = 2.0;
    handle.updateSettings(inverted);

    scrollStrip!.dispatchEvent(makePtr("pointerdown", 200));
    scrollStrip!.dispatchEvent(makePtr("pointermove", 220));
    scrollStrip!.dispatchEvent(makePtr("pointerup", 220));

    expect(emitted).toEqual([{ t: "scroll", dx: 0, dy: -20 * 0.15 * 2.0 }]);

    handle.destroy();
  });
});

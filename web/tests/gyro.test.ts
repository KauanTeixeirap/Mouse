import { describe, expect, it } from "vitest";
import { OneEuroFilter } from "../src/lib/filters";
import { GyroProcessor } from "../src/modes/gyro";
import { DEFAULT_SETTINGS } from "../src/protocol";

describe("GyroProcessor and OneEuroFilter", () => {
  it("projects rotation around gravity consistently when phone is flat vs upright", () => {
    const flat = new GyroProcessor(structuredClone(DEFAULT_SETTINGS), 0);
    flat.processSample({ alpha: 0, beta: 0, gamma: 0, gx: 0, gy: 0, gz: 9.81, timestampMs: 0 });
    // Turning right with flat phone => negative alpha
    const flatRight = flat.processSample({
      alpha: -40,
      beta: 20,
      gamma: 0,
      gx: 0,
      gy: 0,
      gz: 9.81,
      timestampMs: 16,
    });
    expect(flatRight).not.toBeNull();
    expect(flatRight!.dx).toBeGreaterThan(0);
    expect(flatRight!.dy).toBeLessThan(0);

    const upright = new GyroProcessor(structuredClone(DEFAULT_SETTINGS), 0);
    upright.processSample({ alpha: 0, beta: 0, gamma: 0, gx: 0, gy: 9.81, gz: 0, timestampMs: 0 });
    // Turning right with upright phone => negative gamma
    const uprightRight = upright.processSample({
      alpha: 0,
      beta: 20,
      gamma: -40,
      gx: 0,
      gy: 9.81,
      gz: 0,
      timestampMs: 16,
    });
    expect(uprightRight).not.toBeNull();
    expect(uprightRight!.dx).toBeGreaterThan(0);
    expect(uprightRight!.dy).toBeLessThan(0);
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
});

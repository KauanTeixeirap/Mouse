/** Signal filtering, deadzone, and pointer acceleration utilities. */

export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(minCutoff = 1.2, beta = 0.04, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  private alpha(te: number, cutoff: number): number {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / te);
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  filter(value: number, timestampSec: number): number {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = value;
      this.dxPrev = 0;
      this.tPrev = timestampSec;
      return value;
    }

    const te = Math.max(1e-4, timestampSec - this.tPrev);
    this.tPrev = timestampSec;

    const ad = this.alpha(te, this.dCutoff);
    const dx = (value - this.xPrev) / te;
    const dxHat = ad * dx + (1 - ad) * this.dxPrev;
    this.dxPrev = dxHat;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(te, cutoff);
    const xHat = a * value + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    return xHat;
  }
}

export function applyDeadzone(value: number, threshold: number): number {
  const abs = Math.abs(value);
  if (abs <= threshold) return 0;
  return Math.sign(value) * (abs - threshold);
}

export function computeAcceleration(
  speedPxPerMs: number,
  sensitivity: number,
  acceleration: number,
  vRef = 0.6,
  maxBoost = 2.0,
): number {
  const boost = Math.min(Math.max(0, speedPxPerMs) / vRef, maxBoost);
  return sensitivity * (1 + acceleration * boost);
}

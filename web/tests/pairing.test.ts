import { describe, expect, it } from "vitest";
import { extractQrCodeFromHash } from "../src/pairing";
import { processBeforeInput } from "../src/keyboard/keyboard";

describe("pairing hash extraction", () => {
  it("extracts pair code from #pair=...", () => {
    expect(extractQrCodeFromHash("#pair=abc_123")).toBe("abc_123");
    expect(extractQrCodeFromHash("#foo=1&pair=token99")).toBe("token99");
    expect(extractQrCodeFromHash("")).toBeNull();
  });
});

describe("basic native keyboard input", () => {
  it("maps beforeinput accents, backspace and enter", () => {
    expect(processBeforeInput("insertText", "ação")).toEqual({ t: "text", v: "ação" });
    expect(processBeforeInput("deleteContentBackward", null)).toEqual({
      t: "key",
      k: "backspace",
      s: "tap",
    });
    expect(processBeforeInput("insertLineBreak", null)).toEqual({
      t: "key",
      k: "enter",
      s: "tap",
    });
  });
});

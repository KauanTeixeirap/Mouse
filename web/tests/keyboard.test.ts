import { describe, expect, it } from "vitest";
import {
  KeyboardController,
  deleteCustomShortcut,
  parseShortcutKeys,
  upsertCustomShortcut,
} from "../src/keyboard/keyboard";
import { DEFAULT_SETTINGS } from "../src/protocol";

describe("KeyboardController", () => {
  it("maps beforeinput accents, backspace, and enter", () => {
    const kb = new KeyboardController();
    expect(kb.handleBeforeInput("insertText", "ação")).toEqual({ t: "text", v: "ação" });
    expect(kb.handleBeforeInput("insertCompositionText", "não")).toEqual({ t: "text", v: "não" });
    expect(kb.handleBeforeInput("deleteContentBackward", null)).toEqual({
      t: "key",
      k: "backspace",
      s: "tap",
    });
    expect(kb.handleBeforeInput("insertLineBreak", null)).toEqual({
      t: "key",
      k: "enter",
      s: "tap",
    });
  });

  it("combines sticky modifiers with keys or typed characters and clears them", () => {
    const kb = new KeyboardController();
    kb.toggleModifier("ctrl");
    expect(kb.getActiveModifiers()).toEqual(["ctrl"]);

    expect(kb.handleBeforeInput("insertText", "c")).toEqual({
      t: "combo",
      k: ["ctrl", "c"],
    });
    expect(kb.getActiveModifiers()).toEqual([]);

    kb.toggleModifier("ctrl");
    kb.toggleModifier("shift");
    expect(kb.pressKey("esc")).toEqual({
      t: "combo",
      k: ["ctrl", "shift", "esc"],
    });
    expect(kb.getActiveModifiers()).toEqual([]);
  });

  it("parses and manages custom shortcuts CRUD", () => {
    expect(parseShortcutKeys("Ctrl + Shift + Esc")).toEqual(["ctrl", "shift", "esc"]);
    expect(() => parseShortcutKeys("")).toThrow();
    expect(() => parseShortcutKeys("ctrl + unknownkey")).toThrow();

    let settings = structuredClone(DEFAULT_SETTINGS);
    settings = upsertCustomShortcut(settings, {
      id: "s1",
      label: "Task Mgr",
      keys: ["ctrl", "shift", "esc"],
    });
    expect(settings.shortcuts).toHaveLength(1);

    settings = upsertCustomShortcut(settings, {
      id: "s1",
      label: "Gerenciador",
      keys: ["ctrl", "shift", "esc"],
    });
    expect(settings.shortcuts).toHaveLength(1);
    expect(settings.shortcuts[0].label).toBe("Gerenciador");

    settings = deleteCustomShortcut(settings, "s1");
    expect(settings.shortcuts).toHaveLength(0);
  });
});

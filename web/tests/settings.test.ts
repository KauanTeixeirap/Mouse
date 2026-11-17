// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/protocol";
import { applyThemePreference, renderSettingsPanel, syncThemeFromStorage } from "../src/settings/settings";

describe("Theme preference and Settings UI", () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="color-scheme" content="light dark">';
    document.body.innerHTML = '<div id="host"></div>';
    localStorage.clear();
  });

  it("updates <meta name='color-scheme'> and localStorage for system/light/dark", () => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')!;

    applyThemePreference("dark");
    expect(meta.content).toBe("dark");
    expect(localStorage.getItem("color-scheme")).toBe("dark");

    applyThemePreference("light");
    expect(meta.content).toBe("light");
    expect(localStorage.getItem("color-scheme")).toBe("light");

    applyThemePreference("system");
    expect(meta.content).toBe("light dark");
    expect(localStorage.getItem("color-scheme")).toBeNull();

    localStorage.setItem("color-scheme", "dark");
    syncThemeFromStorage();
    expect(meta.content).toBe("dark");
  });

  it("renders settings, updates theme, and persists 3-finger gesture presets", () => {
    const host = document.getElementById("host")!;
    const emitMsg = vi.fn();
    const onSettingsChange = vi.fn();
    const onUnpair = vi.fn();

    renderSettingsPanel(
      host,
      {
        activeProfile: "Mesa",
        profiles: ["Mesa", "Sofá/TV"],
        settings: structuredClone(DEFAULT_SETTINGS),
        connState: "connected",
        latencyMs: 12,
      },
      { emitMsg, onSettingsChange, onUnpair },
    );

    expect(host.textContent).toContain("🟢 Conectado");
    expect(host.textContent).toContain("12 ms");

    const selects = host.querySelectorAll("select");
    // Profile switch
    selects[0].value = "Sofá/TV";
    selects[0].dispatchEvent(new Event("change"));
    expect(emitMsg).toHaveBeenCalledWith({ t: "profile.switch", profile: "Sofá/TV" });

    // Theme select -> dark
    const themeSelect = Array.from(selects).find((s) =>
      Array.from(s.options).some((o) => o.value === "dark"),
    )!;
    themeSelect.value = "dark";
    themeSelect.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("color-scheme")).toBe("dark");
    expect(emitMsg).toHaveBeenCalledWith(
      expect.objectContaining({
        t: "settings.save",
        profile: "Mesa",
        data: expect.objectContaining({ theme: "dark" }),
      }),
    );
  });
});

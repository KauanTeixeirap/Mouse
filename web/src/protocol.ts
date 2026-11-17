/** Mirror of server/mouse_server/protocol.py */

export type SpecialKeyName =
  | "backspace"
  | "tab"
  | "enter"
  | "esc"
  | "space"
  | "delete"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "page_up"
  | "page_down"
  | "ctrl"
  | "alt"
  | "shift"
  | "win"
  | "f1"
  | "f2"
  | "f3"
  | "f4"
  | "f5"
  | "f6"
  | "f7"
  | "f8"
  | "f9"
  | "f10"
  | "f11"
  | "f12"
  | "media_play_pause"
  | "media_volume_up"
  | "media_volume_down"
  | "media_volume_mute"
  | "media_next"
  | "media_prev";

export type KeyName = SpecialKeyName | (string & {});

export type ThemeMode = "system" | "light" | "dark";
export type ClutchMode = "hold_to_pause" | "hold_to_move";

export interface CustomShortcut {
  id: string;
  label: string;
  keys: KeyName[];
}

export interface ThreeFingerActions {
  tap: KeyName[];
  up: KeyName[];
  down: KeyName[];
  left: KeyName[];
  right: KeyName[];
}

export interface Settings {
  trackpad_sensitivity: number;
  gyro_sensitivity: number;
  acceleration: number;
  scroll_speed: number;
  natural_scroll: boolean;
  haptics: boolean;
  wake_lock: boolean;
  theme: ThemeMode;
  clutch_mode: ClutchMode;
  three_finger: ThreeFingerActions;
  shortcuts: CustomShortcut[];
}

export const DEFAULT_SETTINGS: Settings = {
  trackpad_sensitivity: 1.4,
  gyro_sensitivity: 18.0,
  acceleration: 0.6,
  scroll_speed: 1.0,
  natural_scroll: true,
  haptics: true,
  wake_lock: true,
  theme: "system",
  clutch_mode: "hold_to_pause",
  three_finger: {
    tap: ["media_play_pause"],
    up: ["win", "tab"],
    down: ["win", "d"],
    left: ["alt", "tab"],
    right: ["alt", "tab"],
  },
  shortcuts: [],
};

export type ClientMsg =
  | { t: "hello"; token: string; device: string }
  | { t: "move"; dx: number; dy: number }
  | { t: "scroll"; dx: number; dy: number }
  | { t: "btn"; b: "left" | "right" | "middle"; s: "down" | "up" | "click" }
  | { t: "zoom"; d: number }
  | { t: "text"; v: string }
  | { t: "key"; k: KeyName; s: "down" | "up" | "tap" }
  | { t: "combo"; k: KeyName[] }
  | { t: "center" }
  | { t: "settings.save"; profile: string; data: Settings }
  | { t: "profile.switch"; profile: string }
  | { t: "profile.create"; profile: string }
  | { t: "ping"; ts: number };

export type ServerMsg =
  | { t: "welcome"; active_profile: string; settings: Settings; profiles: string[] }
  | { t: "kicked"; reason: "other_device" }
  | { t: "pong"; ts: number }
  | { t: "error"; code: string };

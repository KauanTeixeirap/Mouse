"""Dry-run input backend that records operations instead of touching OS input."""

from __future__ import annotations

from typing import Any

from .base import ButtonName, ButtonState, InputBackend, KeyState


class DryRunBackend(InputBackend):
    """Records input commands in memory for Linux/headless tests and --dry-run."""

    def __init__(self) -> None:
        super().__init__()
        self.events: list[dict[str, Any]] = []

    def move(self, dx: float, dy: float) -> None:
        self.events.append({"t": "move", "dx": dx, "dy": dy})

    def scroll(self, dx: float, dy: float) -> None:
        self.events.append({"t": "scroll", "dx": dx, "dy": dy})

    def button(self, button: ButtonName, state: ButtonState) -> None:
        if state == "down":
            self.pressed_buttons.add(button)
        elif state == "up":
            self.pressed_buttons.discard(button)
        self.events.append({"t": "btn", "b": button, "s": state})

    def zoom(self, delta: float) -> None:
        self.events.append({"t": "zoom", "d": delta})

    def text(self, value: str) -> None:
        self.events.append({"t": "text", "v": value})

    def key(self, key_name: str, state: KeyState) -> None:
        if state == "down":
            self.pressed_keys.add(key_name)
        elif state == "up":
            self.pressed_keys.discard(key_name)
        self.events.append({"t": "key", "k": key_name, "s": state})

    def combo(self, keys: list[str]) -> None:
        self.events.append({"t": "combo", "k": list(keys)})

    def center_cursor(self) -> None:
        self.events.append({"t": "center"})

    def release_all(self) -> None:
        released_buttons = sorted(self.pressed_buttons)
        released_keys = sorted(self.pressed_keys)
        for btn in released_buttons:
            self.events.append({"t": "btn", "b": btn, "s": "up", "auto": True})
        for k in released_keys:
            self.events.append({"t": "key", "k": k, "s": "up", "auto": True})
        self.pressed_buttons.clear()
        self.pressed_keys.clear()

"""Windows/Desktop OS input injection powered by pynput."""

from __future__ import annotations

from threading import RLock
from typing import Any

from .base import ButtonName, ButtonState, InputBackend, KeyState
from .monitors import center_cursor_on_current_monitor, is_cursor_on_editable


class PynputBackend(InputBackend):
    """Translates protocol input events to real OS input via pynput."""

    def __init__(self) -> None:
        super().__init__()
        from pynput.keyboard import Controller as KeyboardController
        from pynput.keyboard import Key
        from pynput.mouse import Button
        from pynput.mouse import Controller as MouseController

        self._lock = RLock()
        self._mouse = MouseController()
        self._keyboard = KeyboardController()
        self._button_map: dict[ButtonName, Any] = {
            "left": Button.left,
            "right": Button.right,
            "middle": Button.middle,
        }
        self._key_map: dict[str, Any] = {
            "backspace": Key.backspace,
            "tab": Key.tab,
            "enter": Key.enter,
            "esc": Key.esc,
            "space": Key.space,
            "delete": Key.delete,
            "up": Key.up,
            "down": Key.down,
            "left": Key.left,
            "right": Key.right,
            "home": Key.home,
            "end": Key.end,
            "page_up": Key.page_up,
            "page_down": Key.page_down,
            "ctrl": Key.ctrl,
            "alt": Key.alt,
            "shift": Key.shift,
            "win": Key.cmd,
            "media_play_pause": Key.media_play_pause,
            "media_volume_up": Key.media_volume_up,
            "media_volume_down": Key.media_volume_down,
            "media_volume_mute": Key.media_volume_mute,
            "media_next": Key.media_next,
            "media_prev": Key.media_previous,
            **{f"f{i}": getattr(Key, f"f{i}") for i in range(1, 13)},
        }
        self._dx_remainder = 0.0
        self._dy_remainder = 0.0
        self._sx_remainder = 0.0
        self._sy_remainder = 0.0
        self._zoom_remainder = 0.0

    def reset_remainders(self) -> None:
        with self._lock:
            self._dx_remainder = 0.0
            self._dy_remainder = 0.0
            self._sx_remainder = 0.0
            self._sy_remainder = 0.0
            self._zoom_remainder = 0.0

    def _resolve_key(self, key_name: str) -> Any:
        normalized = key_name.strip().lower()
        if normalized in self._key_map:
            return self._key_map[normalized]
        if len(normalized) == 1:
            return normalized
        raise ValueError(f"Unsupported key: {key_name!r}")

    def move(self, dx: float, dy: float) -> None:
        with self._lock:
            total_x = dx + self._dx_remainder
            total_y = dy + self._dy_remainder
            ix = int(round(total_x))
            iy = int(round(total_y))
            self._dx_remainder = total_x - ix
            self._dy_remainder = total_y - iy
            if ix != 0 or iy != 0:
                self._mouse.move(ix, iy)

    def scroll(self, dx: float, dy: float) -> None:
        with self._lock:
            total_x = dx + self._sx_remainder
            total_y = dy + self._sy_remainder
            ix = int(round(total_x))
            iy = int(round(total_y))
            self._sx_remainder = total_x - ix
            self._sy_remainder = total_y - iy
            if ix != 0 or iy != 0:
                self._mouse.scroll(ix, iy)

    def button(self, button: ButtonName, state: ButtonState) -> None:
        with self._lock:
            target = self._button_map[button]
            if state == "click":
                self._mouse.click(target)
            elif state == "down":
                self.pressed_buttons.add(button)
                self._mouse.press(target)
            elif state == "up":
                self.pressed_buttons.discard(button)
                self._mouse.release(target)

    def zoom(self, delta: float) -> None:
        if delta == 0:
            return
        with self._lock:
            total = delta + self._zoom_remainder
            steps = int(round(total))
            self._zoom_remainder = total - steps
            if steps == 0:
                return
            ctrl = self._key_map["ctrl"]
            self._keyboard.press(ctrl)
            try:
                self._mouse.scroll(0, steps)
            finally:
                self._keyboard.release(ctrl)

    def text(self, value: str) -> None:
        if not value:
            return
        with self._lock:
            self._keyboard.type(value)

    def key(self, key_name: str, state: KeyState) -> None:
        with self._lock:
            target = self._resolve_key(key_name)
            if state == "tap":
                self._keyboard.press(target)
                self._keyboard.release(target)
            elif state == "down":
                self.pressed_keys.add(key_name)
                self._keyboard.press(target)
            elif state == "up":
                self.pressed_keys.discard(key_name)
                self._keyboard.release(target)

    def combo(self, keys: list[str]) -> None:
        if not keys:
            return
        with self._lock:
            resolved = [self._resolve_key(k) for k in keys]
            pressed: list[Any] = []
            try:
                for target in resolved:
                    self._keyboard.press(target)
                    pressed.append(target)
            finally:
                for target in reversed(pressed):
                    try:
                        self._keyboard.release(target)
                    except Exception:
                        pass

    def center_cursor(self) -> None:
        with self._lock:
            center_cursor_on_current_monitor()

    def is_editable_focused(self) -> bool:
        return is_cursor_on_editable()

    def release_all(self) -> None:
        with self._lock:
            for btn in list(self.pressed_buttons):
                try:
                    self._mouse.release(self._button_map[btn])
                except Exception:
                    pass
            self.pressed_buttons.clear()

            for key_name in list(self.pressed_keys):
                try:
                    self._keyboard.release(self._resolve_key(key_name))
                except Exception:
                    pass
            self.pressed_keys.clear()
            self.reset_remainders()

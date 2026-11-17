"""Abstract input backend interface with stuck-input tracking."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Literal

ButtonName = Literal["left", "right", "middle"]
ButtonState = Literal["down", "up", "click"]
KeyState = Literal["down", "up", "tap"]


class InputBackend(ABC):
    """Base contract for OS input injection and dry-run testing."""

    def __init__(self) -> None:
        self.pressed_buttons: set[ButtonName] = set()
        self.pressed_keys: set[str] = set()

    @abstractmethod
    def move(self, dx: float, dy: float) -> None:
        """Move cursor relatively by (dx, dy) pixels."""

    @abstractmethod
    def scroll(self, dx: float, dy: float) -> None:
        """Scroll horizontally/vertically."""

    @abstractmethod
    def button(self, button: ButtonName, state: ButtonState) -> None:
        """Press, release, or click a mouse button."""

    @abstractmethod
    def zoom(self, delta: float) -> None:
        """Zoom via Ctrl + scroll."""

    @abstractmethod
    def text(self, value: str) -> None:
        """Type Unicode text."""

    @abstractmethod
    def key(self, key_name: str, state: KeyState) -> None:
        """Press, release, or tap a logical key."""

    @abstractmethod
    def combo(self, keys: list[str]) -> None:
        """Execute a key combination (press in order, release in reverse)."""

    @abstractmethod
    def center_cursor(self) -> None:
        """Center cursor on the monitor currently containing it."""

    @abstractmethod
    def release_all(self) -> None:
        """Release all currently pressed buttons and keys."""

    def is_editable_focused(self) -> bool:
        """Return True if the OS cursor or focused control is an editable text field."""
        return False

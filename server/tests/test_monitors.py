"""Tests for multi-monitor cursor centering."""

from __future__ import annotations

import sys

import pytest

from mouse_server.input import monitors
from mouse_server.input.monitors import (
    MonitorRect,
    center_cursor_on_current_monitor,
    get_cursor_position,
    get_monitor_rect_for_point,
)


def test_monitor_rect_center_calculation() -> None:
    primary = MonitorRect(left=0, top=0, right=1920, bottom=1080)
    assert primary.center == (960, 540)

    secondary = MonitorRect(left=-1920, top=0, right=0, bottom=1080)
    assert secondary.center == (-960, 540)


def test_center_cursor_selects_monitor_under_cursor(monkeypatch: pytest.MonkeyPatch) -> None:
    moved_to: list[tuple[int, int]] = []

    class FakeUser32:
        @staticmethod
        def SetCursorPos(x: int, y: int) -> int:
            moved_to.append((x, y))
            return 1

    class FakeWindll:
        user32 = FakeUser32()

    monkeypatch.setattr(monitors.sys, "platform", "win32")
    monkeypatch.setattr(monitors.ctypes, "windll", FakeWindll(), raising=False)
    monkeypatch.setattr(monitors, "get_cursor_position", lambda: (-400, 300))
    monkeypatch.setattr(
        monitors,
        "get_monitor_rect_for_point",
        lambda x, y: MonitorRect(-1920, 0, 0, 1080) if x < 0 else MonitorRect(0, 0, 1920, 1080),
    )

    centered = center_cursor_on_current_monitor()
    assert centered == (-960, 540)
    assert moved_to == [(-960, 540)]


def test_is_cursor_on_editable_detects_ibeam_cursor(monkeypatch: pytest.MonkeyPatch) -> None:
    import ctypes

    class FakeUser32:
        @staticmethod
        def GetCursorInfo(ci_ptr) -> int:
            ci = ctypes.cast(ci_ptr, ctypes.POINTER(monitors._CURSORINFO)).contents
            ci.flags = monitors.CURSOR_SHOWING
            ci.hCursor = 0xBEEF
            return 1

        @staticmethod
        def LoadCursorW(hinstance, cursor_id: int) -> int:
            assert cursor_id == monitors.IDC_IBEAM
            return 0xBEEF

        @staticmethod
        def GetGUIThreadInfo(id_thread: int, gti_ptr) -> int:
            return 0

    class FakeWindll:
        user32 = FakeUser32()

    monkeypatch.setattr(monitors.sys, "platform", "win32")
    monkeypatch.setattr(monitors.ctypes, "windll", FakeWindll(), raising=False)

    assert monitors.is_cursor_on_editable() is True


def test_is_cursor_on_editable_detects_caret_and_edit_class(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ctypes

    mode = {"caret": True, "class_name": "Button"}

    class FakeUser32:
        @staticmethod
        def GetCursorInfo(ci_ptr) -> int:
            ci = ctypes.cast(ci_ptr, ctypes.POINTER(monitors._CURSORINFO)).contents
            ci.flags = monitors.CURSOR_SHOWING
            ci.hCursor = 0x1111
            return 1

        @staticmethod
        def LoadCursorW(hinstance, cursor_id: int) -> int:
            return 0x2222

        @staticmethod
        def GetGUIThreadInfo(id_thread: int, gti_ptr) -> int:
            gti = ctypes.cast(gti_ptr, ctypes.POINTER(monitors._GUITHREADINFO)).contents
            gti.flags = monitors.GUI_CARETBLINKING if mode["caret"] else 0
            gti.hwndCaret = 0
            gti.hwndFocus = 0xABCD
            return 1

        @staticmethod
        def GetClassNameW(hwnd, buf, max_count: int) -> int:
            buf.value = mode["class_name"]
            return len(buf.value)

    class FakeWindll:
        user32 = FakeUser32()

    monkeypatch.setattr(monitors.sys, "platform", "win32")
    monkeypatch.setattr(monitors.ctypes, "windll", FakeWindll(), raising=False)

    # 1. Caret blinking => True
    assert monitors.is_cursor_on_editable() is True

    # 2. No caret, Edit class name => True
    mode["caret"] = False
    mode["class_name"] = "RichEditD2DPT"
    assert monitors.is_cursor_on_editable() is True

    # 3. No caret, non-editable class name and non-IBeam cursor => False
    mode["class_name"] = "SysListView32"
    assert monitors.is_cursor_on_editable() is False


def test_zoom_accumulates_fractional_remainder() -> None:
    from mouse_server.input.pynput_backend import PynputBackend

    backend = PynputBackend.__new__(PynputBackend)
    from threading import RLock

    backend._lock = RLock()
    backend._zoom_remainder = 0.0
    backend._dx_remainder = 0.0
    backend._dy_remainder = 0.0
    backend._sx_remainder = 0.0
    backend._sy_remainder = 0.0
    backend._key_map = {"ctrl": "CTRL"}

    events: list[tuple[str, object]] = []

    class FakeKeyboard:
        def press(self, k: object) -> None:
            events.append(("press", k))

        def release(self, k: object) -> None:
            events.append(("release", k))

    class FakeMouse:
        def scroll(self, dx: int, dy: int) -> None:
            events.append(("scroll", (dx, dy)))

    backend._keyboard = FakeKeyboard()
    backend._mouse = FakeMouse()

    # Small fractional delta (< 0.5) should NOT trigger Ctrl+scroll immediately
    backend.zoom(0.2)
    assert events == []
    assert pytest.approx(backend._zoom_remainder) == 0.2

    backend.zoom(0.2)
    assert events == []
    assert pytest.approx(backend._zoom_remainder) == 0.4

    # Crossing 0.5 rounds to 1 step and subtracts 1 from remainder
    backend.zoom(0.2)
    assert events == [("press", "CTRL"), ("scroll", (0, 1)), ("release", "CTRL")]
    assert pytest.approx(backend._zoom_remainder) == -0.4


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only Win32 monitor API check")
def test_windows_monitor_api() -> None:
    import ctypes

    rect = get_monitor_rect_for_point(0, 0)
    assert rect is not None
    cx, cy = rect.center
    assert rect.left <= cx < rect.right
    assert rect.top <= cy < rect.bottom

    pos = get_cursor_position()
    if pos is not None:
        try:
            active_rect = get_monitor_rect_for_point(pos[0], pos[1])
            assert active_rect is not None
            centered = center_cursor_on_current_monitor()
            assert centered == active_rect.center
        finally:
            ctypes.windll.user32.SetCursorPos(pos[0], pos[1])

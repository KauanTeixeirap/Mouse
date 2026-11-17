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

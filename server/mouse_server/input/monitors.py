"""Windows multi-monitor helpers via ctypes to center the cursor on the active monitor."""

from __future__ import annotations

import ctypes
import sys
from dataclasses import dataclass

MONITOR_DEFAULTTONEAREST = 2


@dataclass(frozen=True)
class MonitorRect:
    left: int
    top: int
    right: int
    bottom: int

    @property
    def center(self) -> tuple[int, int]:
        return ((self.left + self.right) // 2, (self.top + self.bottom) // 2)


if sys.platform == "win32":

    class _POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    class _RECT(ctypes.Structure):
        _fields_ = [
            ("left", ctypes.c_long),
            ("top", ctypes.c_long),
            ("right", ctypes.c_long),
            ("bottom", ctypes.c_long),
        ]

    class _MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", ctypes.c_ulong),
            ("rcMonitor", _RECT),
            ("rcWork", _RECT),
            ("dwFlags", ctypes.c_ulong),
        ]


def get_cursor_position() -> tuple[int, int] | None:
    """Return current cursor position on Windows, or None on other platforms."""
    if sys.platform != "win32":
        return None
    pt = _POINT()
    if not ctypes.windll.user32.GetCursorPos(ctypes.byref(pt)):
        return None
    return (int(pt.x), int(pt.y))


def get_monitor_rect_for_point(x: int, y: int) -> MonitorRect | None:
    """Return the bounding rectangle of the Windows monitor containing (x, y)."""
    if sys.platform != "win32":
        return None
    pt = _POINT(x=x, y=y)
    hmon = ctypes.windll.user32.MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST)
    if not hmon:
        return None
    info = _MONITORINFO()
    info.cbSize = ctypes.sizeof(_MONITORINFO)
    if not ctypes.windll.user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
        return None
    rect = info.rcMonitor
    return MonitorRect(
        left=int(rect.left),
        top=int(rect.top),
        right=int(rect.right),
        bottom=int(rect.bottom),
    )


def center_cursor_on_current_monitor() -> tuple[int, int] | None:
    """Move the cursor to the center of the monitor where it is currently located."""
    if sys.platform != "win32":
        return None
    pos = get_cursor_position()
    if pos is None:
        return None
    rect = get_monitor_rect_for_point(pos[0], pos[1])
    if rect is None:
        return None
    cx, cy = rect.center
    ctypes.windll.user32.SetCursorPos(cx, cy)
    return (cx, cy)

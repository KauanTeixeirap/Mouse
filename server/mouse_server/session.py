"""Single-active-controller WebSocket session manager."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import WebSocket

from .protocol import KickedMsg


@dataclass
class ActiveSession:
    device_id: str
    device_name: str
    websocket: WebSocket


class SessionManager:
    """Ensures only one phone controls the PC at a time."""

    def __init__(self, on_status_change: Callable[[str | None], None] | None = None) -> None:
        self._lock = asyncio.Lock()
        self._active: ActiveSession | None = None
        self._on_status_change = on_status_change

    @property
    def active_device_name(self) -> str | None:
        return self._active.device_name if self._active else None

    def _notify(self) -> None:
        if self._on_status_change is not None:
            self._on_status_change(self.active_device_name)

    async def activate(self, device_id: str, device_name: str, websocket: WebSocket) -> None:
        """Register a new controller session, kicking any previous active session."""
        previous: ActiveSession | None = None
        async with self._lock:
            if self._active is not None and self._active.websocket is not websocket:
                previous = self._active
            self._active = ActiveSession(
                device_id=device_id,
                device_name=device_name,
                websocket=websocket,
            )
            self._notify()

        if previous is not None:
            try:
                await previous.websocket.send_text(KickedMsg().model_dump_json())
                await previous.websocket.close(code=4009, reason="other_device")
            except Exception:
                pass

    async def deactivate(self, websocket: WebSocket) -> None:
        """Clear active session if it matches the disconnecting WebSocket."""
        async with self._lock:
            if self._active is not None and self._active.websocket is websocket:
                self._active = None
                self._notify()

    async def kick_device(self, device_id: str) -> None:
        """Disconnect an active session when its device is revoked."""
        target: ActiveSession | None = None
        async with self._lock:
            if self._active is not None and self._active.device_id == device_id:
                target = self._active
                self._active = None
                self._notify()

        if target is not None:
            try:
                await target.websocket.close(code=4401, reason="revoked")
            except Exception:
                pass

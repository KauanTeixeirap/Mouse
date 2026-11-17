"""LAN IP detection and periodic IP change watcher."""

from __future__ import annotations

import socket
from collections.abc import Callable
from threading import Event, Thread


def get_hostname() -> str:
    """Return the local computer's hostname."""
    return socket.gethostname()


def get_primary_ip() -> str:
    """Return the primary LAN IPv4 address used for outbound local routing."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("10.255.255.255", 1))
        ip = sock.getsockname()[0]
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    finally:
        sock.close()

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            candidate = str(info[4][0])
            if (
                candidate
                and not candidate.startswith("127.")
                and not candidate.startswith("169.254.")
            ):
                return candidate
    except OSError:
        pass
    return "127.0.0.1"


def get_lan_ips() -> list[str]:
    """Return deduplicated non-loopback LAN IPv4 addresses, primary IP first."""
    seen: list[str] = []
    primary = get_primary_ip()
    if primary and primary != "127.0.0.1":
        seen.append(primary)

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = str(info[4][0])
            if ip.startswith("127.") or ip.startswith("169.254."):
                continue
            if ip not in seen:
                seen.append(ip)
    except OSError:
        pass

    return seen or ["127.0.0.1"]


class IPWatcher:
    """Polls LAN IP addresses every interval_seconds and triggers callback on change."""

    def __init__(
        self,
        on_change: Callable[[list[str]], None],
        interval_seconds: float = 30.0,
        ip_provider: Callable[[], list[str]] = get_lan_ips,
    ) -> None:
        self._on_change = on_change
        self._interval = interval_seconds
        self._ip_provider = ip_provider
        self._stop_event = Event()
        self._thread: Thread | None = None
        self._last_ips: list[str] = list(ip_provider())

    @property
    def current_ips(self) -> list[str]:
        return list(self._last_ips)

    def check_once(self) -> bool:
        """Check for IP changes synchronously; returns True if changed."""
        latest = list(self._ip_provider())
        if latest != self._last_ips:
            self._last_ips = latest
            self._on_change(latest)
            return True
        return False

    def _run(self) -> None:
        while not self._stop_event.wait(self._interval):
            try:
                self.check_once()
            except Exception:
                pass

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = Thread(target=self._run, name="mouse-ip-watcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

"""LAN IP detection and periodic IP change watcher."""

from __future__ import annotations

import socket
from collections.abc import Callable
from threading import Event, Thread


def get_hostname() -> str:
    """Return the local computer's hostname."""
    return socket.gethostname()


_PROBE_TARGETS: tuple[tuple[str, int], ...] = (
    ("8.8.8.8", 80),
    ("1.1.1.1", 80),
    ("10.255.255.255", 1),
)


def _is_valid_lan_ip(ip: str) -> bool:
    return bool(ip) and not ip.startswith("127.") and not ip.startswith("169.254.")


def _ip_priority(ip: str) -> int:
    """Lower score = higher priority for physical Wi-Fi/Ethernet LAN adapters."""
    if ip.startswith("192.168.56."):
        return 3
    if ip.startswith("192.168."):
        return 0
    if ip.startswith("10."):
        return 1
    if ip.startswith("172."):
        parts = ip.split(".")
        if len(parts) == 4 and parts[1].isdigit() and 16 <= int(parts[1]) <= 31:
            return 2
    return 4


def get_primary_ip() -> str:
    """Return the primary LAN IPv4 address used for outbound local routing."""
    probed: list[str] = []
    for target in _PROBE_TARGETS:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(target)
            ip = sock.getsockname()[0]
            if _is_valid_lan_ip(ip) and ip not in probed:
                probed.append(ip)
        except OSError:
            pass
        finally:
            sock.close()

    if probed:
        probed.sort(key=_ip_priority)
        return probed[0]

    candidates: list[str] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            candidate = str(info[4][0])
            if _is_valid_lan_ip(candidate) and candidate not in candidates:
                candidates.append(candidate)
    except OSError:
        pass
    if candidates:
        candidates.sort(key=_ip_priority)
        return candidates[0]
    return "127.0.0.1"


def get_lan_ips() -> list[str]:
    """Return deduplicated non-loopback LAN IPv4 addresses, physical LAN IPs first."""
    seen: list[str] = []
    primary = get_primary_ip()
    if primary and primary != "127.0.0.1":
        seen.append(primary)

    for target in _PROBE_TARGETS:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(target)
            ip = sock.getsockname()[0]
            if _is_valid_lan_ip(ip) and ip not in seen:
                seen.append(ip)
        except OSError:
            pass
        finally:
            sock.close()

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = str(info[4][0])
            if not _is_valid_lan_ip(ip):
                continue
            if ip not in seen:
                seen.append(ip)
    except OSError:
        pass

    if not seen:
        return ["127.0.0.1"]
    seen.sort(key=_ip_priority)
    return seen


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

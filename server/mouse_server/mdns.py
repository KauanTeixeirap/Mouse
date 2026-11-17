"""Optional mDNS (.local) advertisement using zeroconf."""

from __future__ import annotations

import socket
from collections.abc import Callable
from threading import RLock

from zeroconf import ServiceInfo, Zeroconf

from .network import get_lan_ips


class MdnsAdvertiser:
    """Announces Mouse HTTPS service as <hostname>.local on the LAN."""

    def __init__(
        self,
        hostname: str,
        port: int,
        ips_provider: Callable[[], list[str]] = get_lan_ips,
        zeroconf_factory: Callable[[], Zeroconf] = Zeroconf,
    ) -> None:
        clean = hostname.strip().rstrip(".")
        if clean.endswith(".local"):
            clean = clean[:-6]
        self.hostname = clean or "mouse-pc"
        self.port = port
        self._ips_provider = ips_provider
        self._zeroconf_factory = zeroconf_factory
        self._lock = RLock()
        self._zc: Zeroconf | None = None
        self._info: ServiceInfo | None = None

    @property
    def is_running(self) -> bool:
        with self._lock:
            return self._zc is not None

    def _build_service_info(self) -> ServiceInfo:
        ips = self._ips_provider()
        packed: list[bytes] = []
        for ip in ips:
            try:
                packed.append(socket.inet_aton(ip))
            except OSError:
                continue
        if not packed:
            packed.append(socket.inet_aton("127.0.0.1"))

        return ServiceInfo(
            type_="_https._tcp.local.",
            name=f"Mouse ({self.hostname})._https._tcp.local.",
            addresses=packed,
            port=self.port,
            properties={"app": "Mouse"},
            server=f"{self.hostname}.local.",
        )

    def start(self) -> bool:
        with self._lock:
            if self._zc is not None:
                return True
            try:
                zc = self._zeroconf_factory()
                info = self._build_service_info()
                zc.register_service(info)
                self._zc = zc
                self._info = info
                return True
            except Exception:
                self._zc = None
                self._info = None
                return False

    def stop(self) -> None:
        with self._lock:
            if self._zc is None:
                return
            try:
                if self._info is not None:
                    self._zc.unregister_service(self._info)
                self._zc.close()
            except Exception:
                pass
            finally:
                self._zc = None
                self._info = None

    def restart(self) -> bool:
        with self._lock:
            was_running = self._zc is not None
            self.stop()
            if was_running:
                return self.start()
            return False

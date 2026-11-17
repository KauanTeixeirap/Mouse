"""Tests for Windows autostart registry helper, mDNS advertiser, IPWatcher, and tray artwork."""

from __future__ import annotations

from mouse_server.autostart import (
    APP_VALUE_NAME,
    RUN_KEY_PATH,
    is_autostart_enabled,
    set_autostart_enabled,
)
from mouse_server.mdns import MdnsAdvertiser
from mouse_server.network import IPWatcher
from mouse_server.tray import create_tray_icon_image, make_qr_image


class FakeRegistry:
    def __init__(self) -> None:
        self.data: dict[tuple[str, str], str] = {}

    def get_value(self, key_path: str, value_name: str) -> str | None:
        return self.data.get((key_path, value_name))

    def set_value(self, key_path: str, value_name: str, value: str) -> None:
        self.data[(key_path, value_name)] = value

    def delete_value(self, key_path: str, value_name: str) -> None:
        self.data.pop((key_path, value_name), None)


def test_autostart_toggle() -> None:
    reg = FakeRegistry()
    assert is_autostart_enabled(backend=reg) is False

    assert set_autostart_enabled(True, command='"C:\\Mouse.exe"', backend=reg) is True
    assert is_autostart_enabled(backend=reg) is True
    assert reg.data[(RUN_KEY_PATH, APP_VALUE_NAME)] == '"C:\\Mouse.exe"'

    assert set_autostart_enabled(False, backend=reg) is False
    assert is_autostart_enabled(backend=reg) is False


def test_mdns_advertiser_lifecycle() -> None:
    events: list[str] = []

    class FakeZeroconf:
        def register_service(self, info) -> None:
            events.append(f"register:{info.server}:{info.port}")

        def unregister_service(self, info) -> None:
            events.append(f"unregister:{info.server}")

        def close(self) -> None:
            events.append("close")

    adv = MdnsAdvertiser(
        hostname="MeuPC",
        port=8443,
        ips_provider=lambda: ["192.168.1.10"],
        zeroconf_factory=FakeZeroconf,
    )
    assert adv.is_running is False
    assert adv.start() is True
    assert adv.is_running is True
    assert adv.restart() is True
    adv.stop()
    assert adv.is_running is False
    assert events == [
        "register:MeuPC.local.:8443",
        "unregister:MeuPC.local.",
        "close",
        "register:MeuPC.local.:8443",
        "unregister:MeuPC.local.",
        "close",
    ]


def test_ip_watcher_triggers_only_on_change() -> None:
    ips = ["192.168.1.10"]
    changes: list[list[str]] = []
    watcher = IPWatcher(on_change=changes.append, ip_provider=lambda: ips)

    assert watcher.check_once() is False
    ips = ["192.168.1.22"]
    assert watcher.check_once() is True
    assert changes == [["192.168.1.22"]]


def test_tray_icon_and_qr_generation() -> None:
    idle_img = create_tray_icon_image(connected=False)
    active_img = create_tray_icon_image(connected=True)
    assert idle_img.size == (64, 64)
    assert active_img.size == (64, 64)

    qr_img = make_qr_image("https://192.168.1.10:8443/#pair=abc", size=180)
    assert qr_img.size == (180, 180)

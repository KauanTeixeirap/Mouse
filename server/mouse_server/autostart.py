"""Windows startup registration via HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run."""

from __future__ import annotations

import sys
from typing import Protocol

RUN_KEY_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"
APP_VALUE_NAME = "Mouse"


class RegistryBackend(Protocol):
    def get_value(self, key_path: str, value_name: str) -> str | None: ...
    def set_value(self, key_path: str, value_name: str, value: str) -> None: ...
    def delete_value(self, key_path: str, value_name: str) -> None: ...


class WinRegBackend:
    """Real Windows Registry backend using winreg."""

    def get_value(self, key_path: str, value_name: str) -> str | None:
        if sys.platform != "win32":
            return None
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ) as key:
                val, _ = winreg.QueryValueEx(key, value_name)
                return str(val)
        except FileNotFoundError:
            return None

    def set_value(self, key_path: str, value_name: str, value: str) -> None:
        if sys.platform != "win32":
            return
        import winreg

        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            winreg.SetValueEx(key, value_name, 0, winreg.REG_SZ, value)

    def delete_value(self, key_path: str, value_name: str) -> None:
        if sys.platform != "win32":
            return
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE) as key:
                winreg.DeleteValue(key, value_name)
        except FileNotFoundError:
            pass


def get_default_startup_command() -> str:
    """Return command string for launching Mouse at Windows login."""
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}"'
    return f'"{sys.executable}" -m mouse_server'


def is_autostart_enabled(backend: RegistryBackend | None = None) -> bool:
    reg = backend if backend is not None else WinRegBackend()
    return reg.get_value(RUN_KEY_PATH, APP_VALUE_NAME) is not None


def set_autostart_enabled(
    enabled: bool,
    command: str | None = None,
    backend: RegistryBackend | None = None,
) -> bool:
    reg = backend if backend is not None else WinRegBackend()
    if enabled:
        cmd = command if command is not None else get_default_startup_command()
        reg.set_value(RUN_KEY_PATH, APP_VALUE_NAME, cmd)
        return True
    reg.delete_value(RUN_KEY_PATH, APP_VALUE_NAME)
    return False

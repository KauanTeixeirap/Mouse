"""PC-side configuration and profile storage (%APPDATA%\\Mouse\\settings.json)."""

from __future__ import annotations

import os
from pathlib import Path
from threading import RLock

from pydantic import BaseModel, Field

from .protocol import Settings


def get_default_data_dir() -> Path:
    """Return the default per-user configuration directory for Mouse."""
    if os.name == "nt":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "Mouse"
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg) / "mouse"
    return Path.home() / ".config" / "mouse"


class ConfigStoreModel(BaseModel):
    """Root JSON structure persisted in settings.json."""

    active_profile: str = "Mesa"
    profiles: dict[str, Settings] = Field(default_factory=dict)


def _default_store() -> ConfigStoreModel:
    return ConfigStoreModel(
        active_profile="Mesa",
        profiles={
            "Mesa": Settings(),
            "Sofá/TV": Settings(
                trackpad_sensitivity=1.8,
                gyro_sensitivity=22.0,
                acceleration=0.8,
            ),
        },
    )


class ConfigManager:
    """Thread-safe JSON persistence for profiles and preferences on the PC."""

    def __init__(self, data_dir: Path | None = None) -> None:
        self.data_dir = Path(data_dir) if data_dir is not None else get_default_data_dir()
        self.file_path = self.data_dir / "settings.json"
        self._lock = RLock()
        self._store = self.load()

    def load(self) -> ConfigStoreModel:
        with self._lock:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            if not self.file_path.exists():
                store = _default_store()
                self._write_locked(store)
                self._store = store
                return store
            raw = self.file_path.read_text(encoding="utf-8")
            store = ConfigStoreModel.model_validate_json(raw)
            if not store.profiles:
                store = _default_store()
            if store.active_profile not in store.profiles:
                store.active_profile = next(iter(store.profiles))
            self._store = store
            return store

    def _write_locked(self, store: ConfigStoreModel) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        tmp_path = self.file_path.with_suffix(".tmp")
        tmp_path.write_text(store.model_dump_json(indent=2), encoding="utf-8")
        tmp_path.replace(self.file_path)

    def save(self) -> None:
        with self._lock:
            self._write_locked(self._store)

    def get_active_profile(self) -> tuple[str, Settings]:
        with self._lock:
            name = self._store.active_profile
            settings = self._store.profiles[name].model_copy(deep=True)
            return name, settings

    def list_profiles(self) -> list[str]:
        with self._lock:
            return list(self._store.profiles.keys())

    def save_profile(self, profile: str, settings: Settings) -> Settings:
        name = profile.strip()
        if not name:
            raise ValueError("Profile name cannot be empty")
        with self._lock:
            self._store.profiles[name] = settings.model_copy(deep=True)
            self._store.active_profile = name
            self._write_locked(self._store)
            return self._store.profiles[name].model_copy(deep=True)

    def switch_profile(self, profile: str) -> Settings:
        name = profile.strip()
        with self._lock:
            if name not in self._store.profiles:
                raise KeyError(f"Unknown profile: {name}")
            self._store.active_profile = name
            self._write_locked(self._store)
            return self._store.profiles[name].model_copy(deep=True)

    def create_profile(self, profile: str) -> Settings:
        name = profile.strip()
        if not name:
            raise ValueError("Profile name cannot be empty")
        with self._lock:
            if name in self._store.profiles:
                raise ValueError(f"Profile already exists: {name}")
            base = self._store.profiles[self._store.active_profile].model_copy(deep=True)
            self._store.profiles[name] = base
            self._store.active_profile = name
            self._write_locked(self._store)
            return base.model_copy(deep=True)

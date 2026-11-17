"""QR/PIN pairing manager and hashed permanent device tokens."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

from pydantic import BaseModel, Field

PAIRING_TTL_SECONDS = 300.0
MAX_PIN_ATTEMPTS = 5


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class PairedDevice(BaseModel):
    """Persisted metadata for a paired device (stores only token hash)."""

    id: str
    name: str
    token_hash: str
    created_at: str


class DevicesStoreModel(BaseModel):
    devices: list[PairedDevice] = Field(default_factory=list)


@dataclass
class ActivePairingCodes:
    qr_code: str
    pin: str
    expires_at: float
    pin_attempts: int = 0


class PairingManager:
    """Manages one-time QR codes, rate-limited 6-digit PINs, and device tokens."""

    def __init__(
        self,
        data_dir: Path,
        ttl_seconds: float = PAIRING_TTL_SECONDS,
        clock=time.monotonic,
    ) -> None:
        self.data_dir = Path(data_dir)
        self.devices_path = self.data_dir / "devices.json"
        self.ttl_seconds = ttl_seconds
        self._clock = clock
        self._lock = RLock()
        self._devices: list[PairedDevice] = self._load_devices()
        self._active: ActivePairingCodes | None = None
        self.rotate_codes()

    def _load_devices(self) -> list[PairedDevice]:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if not self.devices_path.exists():
            self._save_devices([])
            return []
        model = DevicesStoreModel.model_validate_json(self.devices_path.read_text(encoding="utf-8"))
        return model.devices

    def _save_devices(self, devices: list[PairedDevice]) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.devices_path.with_suffix(".tmp")
        tmp.write_text(
            DevicesStoreModel(devices=devices).model_dump_json(indent=2),
            encoding="utf-8",
        )
        tmp.replace(self.devices_path)

    def rotate_codes(self) -> tuple[str, str]:
        """Generate a fresh single-use QR code and 6-digit PIN."""
        with self._lock:
            qr_code = secrets.token_urlsafe(32)
            pin = f"{secrets.randbelow(1_000_000):06d}"
            self._active = ActivePairingCodes(
                qr_code=qr_code,
                pin=pin,
                expires_at=self._clock() + self.ttl_seconds,
                pin_attempts=0,
            )
            return qr_code, pin

    def get_active_codes(self) -> tuple[str, str]:
        """Return valid QR code and PIN, regenerating them if expired."""
        with self._lock:
            if self._active is None or self._clock() >= self._active.expires_at:
                return self.rotate_codes()
            return self._active.qr_code, self._active.pin

    def _issue_device_token_locked(self, device_name: str) -> str:
        clean_name = device_name.strip()[:100] or "Celular"
        raw_token = secrets.token_urlsafe(32)
        device = PairedDevice(
            id=str(uuid.uuid4()),
            name=clean_name,
            token_hash=_hash_token(raw_token),
            created_at=datetime.now(UTC).isoformat(),
        )
        self._devices.append(device)
        self._save_devices(self._devices)
        self.rotate_codes()
        return raw_token

    def exchange_qr(self, code: str, device_name: str) -> str | None:
        """Exchange a valid one-time QR pairing code for a permanent device token."""
        with self._lock:
            if self._active is None or self._clock() >= self._active.expires_at:
                return None
            if not hmac.compare_digest(code.strip(), self._active.qr_code):
                return None
            return self._issue_device_token_locked(device_name)

    def exchange_pin(self, pin: str, device_name: str) -> str | None:
        """Exchange the current 6-digit PIN for a permanent token (max 5 failed tries)."""
        with self._lock:
            if self._active is None or self._clock() >= self._active.expires_at:
                return None
            candidate = pin.strip()
            if hmac.compare_digest(candidate, self._active.pin):
                return self._issue_device_token_locked(device_name)

            self._active.pin_attempts += 1
            if self._active.pin_attempts >= MAX_PIN_ATTEMPTS:
                self.rotate_codes()
            return None

    def verify_token(self, token: str) -> PairedDevice | None:
        """Verify a permanent bearer token and return the paired device metadata."""
        if not token:
            return None
        candidate_hash = _hash_token(token)
        with self._lock:
            for dev in self._devices:
                if hmac.compare_digest(candidate_hash, dev.token_hash):
                    return dev
            return None

    def list_devices(self) -> list[PairedDevice]:
        with self._lock:
            return list(self._devices)

    def revoke_device(self, device_id: str) -> bool:
        with self._lock:
            before = len(self._devices)
            self._devices = [d for d in self._devices if d.id != device_id]
            changed = len(self._devices) != before
            if changed:
                self._save_devices(self._devices)
            return changed

"""Tests for QR/PIN pairing, expiration, rate limiting, and revocation."""

from __future__ import annotations

from pathlib import Path

from mouse_server.auth import MAX_PIN_ATTEMPTS, PairingManager


class FakeClock:
    def __init__(self, now: float = 100.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def test_qr_is_single_use_and_hashed(tmp_path: Path) -> None:
    clock = FakeClock()
    mgr = PairingManager(tmp_path, clock=clock)
    qr, _ = mgr.get_active_codes()

    token = mgr.exchange_qr(qr, "Pixel 8")
    assert token is not None
    assert mgr.verify_token(token) is not None

    # QR cannot be reused
    assert mgr.exchange_qr(qr, "Other") is None

    # Token raw string is never saved directly in devices.json
    devices_json = (tmp_path / "devices.json").read_text(encoding="utf-8")
    assert token not in devices_json


def test_pin_expires_and_rotates_after_max_attempts(tmp_path: Path) -> None:
    clock = FakeClock()
    mgr = PairingManager(tmp_path, ttl_seconds=60.0, clock=clock)
    _, pin = mgr.get_active_codes()

    for _ in range(MAX_PIN_ATTEMPTS - 1):
        assert mgr.exchange_pin("000000" if pin != "000000" else "999999", "Phone") is None

    # On 5th failure, PIN rotates automatically
    assert mgr.exchange_pin("000000" if pin != "000000" else "999999", "Phone") is None
    _, new_pin = mgr.get_active_codes()
    assert new_pin != pin or mgr.exchange_pin(pin, "Phone") is None

    # Expiration test
    clock.now += 61.0
    assert mgr.exchange_pin(new_pin, "Phone") is None
    _, refreshed_pin = mgr.get_active_codes()
    token = mgr.exchange_pin(refreshed_pin, "Galaxy")
    assert token is not None
    assert mgr.verify_token(token) is not None


def test_revoke_device(tmp_path: Path) -> None:
    mgr = PairingManager(tmp_path)
    qr, _ = mgr.get_active_codes()
    token = mgr.exchange_qr(qr, "Pixel")
    assert token is not None
    devices = mgr.list_devices()
    assert len(devices) == 1

    assert mgr.revoke_device(devices[0].id) is True
    assert mgr.verify_token(token) is None
    assert mgr.list_devices() == []

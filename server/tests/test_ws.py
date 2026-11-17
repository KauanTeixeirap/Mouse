"""Tests for FastAPI REST pairing, WebSocket auth, single-controller session, and setup HTTP."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from mouse_server.app import create_app, create_setup_app
from mouse_server.auth import PairingManager
from mouse_server.certs import ensure_certs
from mouse_server.config import ConfigManager
from mouse_server.input.dryrun_backend import DryRunBackend
from mouse_server.protocol import Settings
from mouse_server.session import SessionManager


def _make_app(tmp_path: Path):
    cfg = ConfigManager(tmp_path)
    auth = PairingManager(tmp_path)
    session = SessionManager()
    backend = DryRunBackend()
    app = create_app(cfg, auth, session, backend)
    return app, cfg, auth, session, backend


def test_ws_rejects_invalid_token_and_missing_hello(tmp_path: Path) -> None:
    app, _, _, _, _ = _make_app(tmp_path)
    client = TestClient(app)

    with client.websocket_connect("/ws") as ws:
        ws.send_json({"t": "hello", "token": "bad-token", "device": "Evil"})
        err = ws.receive_json()
        assert err == {"t": "error", "code": "unauthorized"}
        with pytest.raises(WebSocketDisconnect):
            ws.receive_text()

    with client.websocket_connect("/ws") as ws:
        ws.send_json({"t": "move", "dx": 5, "dy": 5})
        err = ws.receive_json()
        assert err == {"t": "error", "code": "unauthorized"}


def test_ws_commands_and_release_on_disconnect(tmp_path: Path) -> None:
    app, _, auth, _, backend = _make_app(tmp_path)
    client = TestClient(app)
    _, pin = auth.get_active_codes()

    pair_resp = client.post("/api/pair", json={"method": "pin", "code": pin, "device": "Pixel"})
    assert pair_resp.status_code == 200
    token = pair_resp.json()["token"]

    with client.websocket_connect("/ws") as ws:
        ws.send_json({"t": "hello", "token": token, "device": "Pixel"})
        welcome = ws.receive_json()
        assert welcome["t"] == "welcome"
        assert welcome["active_profile"] == "Mesa"

        ws.send_json({"t": "move", "dx": 10, "dy": -4})
        ws.send_json({"t": "btn", "b": "left", "s": "down"})
        ws.send_json({"t": "key", "k": "ctrl", "s": "down"})
        ws.send_json({"t": "text", "v": "ação"})
        ws.send_json({"t": "ping", "ts": 42.0})
        pong = ws.receive_json()
        assert pong == {"t": "pong", "ts": 42.0}

    # On disconnect, pressed button and key must have been released
    assert backend.pressed_buttons == set()
    assert backend.pressed_keys == set()
    assert {"t": "move", "dx": 10.0, "dy": -4.0} in backend.events
    assert {"t": "text", "v": "ação"} in backend.events
    assert {"t": "btn", "b": "left", "s": "up", "auto": True} in backend.events
    assert {"t": "key", "k": "ctrl", "s": "up", "auto": True} in backend.events


def test_second_device_kicks_first_device(tmp_path: Path) -> None:
    app, _, auth, _, _ = _make_app(tmp_path)
    client = TestClient(app)

    qr1, _ = auth.get_active_codes()
    token1 = client.post(
        "/api/pair",
        json={"method": "qr", "code": qr1, "device": "Phone1"},
    ).json()["token"]
    qr2, _ = auth.get_active_codes()
    token2 = client.post(
        "/api/pair",
        json={"method": "qr", "code": qr2, "device": "Phone2"},
    ).json()["token"]

    with client.websocket_connect("/ws") as ws1:
        ws1.send_json({"t": "hello", "token": token1, "device": "Phone1"})
        assert ws1.receive_json()["t"] == "welcome"

        with client.websocket_connect("/ws") as ws2:
            ws2.send_json({"t": "hello", "token": token2, "device": "Phone2"})
            assert ws2.receive_json()["t"] == "welcome"

            kicked = ws1.receive_json()
            assert kicked == {"t": "kicked", "reason": "other_device"}


def test_settings_save_and_profile_switch(tmp_path: Path) -> None:
    app, cfg, auth, _, _ = _make_app(tmp_path)
    client = TestClient(app)
    qr, _ = auth.get_active_codes()
    token = client.post(
        "/api/pair",
        json={"method": "qr", "code": qr, "device": "Pixel"},
    ).json()["token"]

    custom = Settings(trackpad_sensitivity=2.5, theme="dark")
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"t": "hello", "token": token, "device": "Pixel"})
        assert ws.receive_json()["t"] == "welcome"

        ws.send_json({"t": "settings.save", "profile": "Mesa", "data": custom.model_dump()})
        updated = ws.receive_json()
        assert updated["settings"]["trackpad_sensitivity"] == 2.5
        assert updated["settings"]["theme"] == "dark"

        ws.send_json({"t": "profile.create", "profile": "Jogos"})
        created = ws.receive_json()
        assert created["active_profile"] == "Jogos"
        assert "Jogos" in created["profiles"]

        ws.send_json({"t": "profile.switch", "profile": "Sofá/TV"})
        switched = ws.receive_json()
        assert switched["active_profile"] == "Sofá/TV"

    reloaded = ConfigManager(tmp_path)
    name, settings = reloaded.get_active_profile()
    assert name == "Sofá/TV"
    assert settings.gyro_sensitivity == 22.0


def test_setup_app_serves_ca_and_instructions(tmp_path: Path) -> None:
    bundle = ensure_certs(tmp_path, ips=["192.168.1.50"], hostname="PC")
    seen_host_ips: list[str] = []
    setup_app = create_setup_app(
        ca_cert_path=bundle.ca_cert,
        get_https_url=lambda: "https://192.168.1.50:8443",
        get_fingerprint=lambda: bundle.fingerprint,
        ensure_host_ip=seen_host_ips.append,
    )
    client = TestClient(setup_app)
    page = client.get("/setup")
    assert page.status_code == 200
    assert bundle.fingerprint in page.text
    assert "/mouse-ca.crt" in page.text
    assert "/mouse-ca.cer" in page.text
    assert "Certificado CA" in page.text
    assert "VPN e apps" in page.text

    # Dynamic Host header IP overrides the HTTPS button URL and calls ensure_host_ip
    page_custom_host = client.get("/setup", headers={"host": "192.168.1.77:8080"})
    assert page_custom_host.status_code == 200
    assert "https://192.168.1.77:8443" in page_custom_host.text
    assert "192.168.1.77" in seen_host_ips

    crt = client.get("/mouse-ca.crt", headers={"host": "192.168.1.88:8080"})
    assert crt.status_code == 200
    assert b"BEGIN CERTIFICATE" in crt.content
    assert crt.headers["content-type"].startswith("application/octet-stream")
    assert 'attachment; filename="mouse-ca.crt"' in crt.headers.get("content-disposition", "")
    assert "192.168.1.88" in seen_host_ips

    cer = client.get("/mouse-ca.cer", headers={"host": "192.168.1.99:8080"})
    assert cer.status_code == 200
    assert cer.headers["content-type"].startswith("application/octet-stream")
    assert 'attachment; filename="mouse-ca.cer"' in cer.headers.get("content-disposition", "")
    assert "192.168.1.99" in seen_host_ips
    from cryptography import x509

    der_cert = x509.load_der_x509_certificate(cer.content)
    pem_cert = x509.load_pem_x509_certificate(bundle.ca_cert.read_bytes())
    assert der_cert == pem_cert


def test_ws_emits_text_focus_when_editable_focused(tmp_path: Path) -> None:
    app, _, auth, _, backend = _make_app(tmp_path)
    client = TestClient(app)
    _, pin = auth.get_active_codes()
    token = client.post(
        "/api/pair",
        json={"method": "pin", "code": pin, "device": "Pixel"},
    ).json()["token"]

    with client.websocket_connect("/ws") as ws:
        ws.send_json({"t": "hello", "token": token, "device": "Pixel"})
        assert ws.receive_json()["t"] == "welcome"

        # When editable_focused is False, left click does not emit text_focus
        backend.editable_focused = False
        ws.send_json({"t": "btn", "b": "left", "s": "click"})
        ws.send_json({"t": "ping", "ts": 1.0})
        assert ws.receive_json() == {"t": "pong", "ts": 1.0}

        # When editable_focused is True, left click emits text_focus
        backend.editable_focused = True
        ws.send_json({"t": "btn", "b": "left", "s": "click"})
        assert ws.receive_json() == {"t": "text_focus"}

        # Left 'down' does not emit text_focus, but left 'up' does
        ws.send_json({"t": "btn", "b": "left", "s": "down"})
        ws.send_json({"t": "ping", "ts": 2.0})
        assert ws.receive_json() == {"t": "pong", "ts": 2.0}

        ws.send_json({"t": "btn", "b": "left", "s": "up"})
        assert ws.receive_json() == {"t": "text_focus"}

        # Right click does not emit text_focus even when editable_focused is True
        ws.send_json({"t": "btn", "b": "right", "s": "click"})
        ws.send_json({"t": "ping", "ts": 3.0})
        assert ws.receive_json() == {"t": "pong", "ts": 3.0}


def test_spa_static_webmanifest_and_js_mime_types(tmp_path: Path) -> None:
    dist_dir = tmp_path / "dist"
    dist_dir.mkdir(parents=True, exist_ok=True)
    (dist_dir / "index.html").write_text("<!doctype html><title>Mouse</title>", encoding="utf-8")
    (dist_dir / "manifest.webmanifest").write_text('{"name":"Mouse"}', encoding="utf-8")
    (dist_dir / "sw.js").write_text("self.addEventListener('fetch', () => {});", encoding="utf-8")

    cfg = ConfigManager(tmp_path)
    auth = PairingManager(tmp_path)
    session = SessionManager()
    backend = DryRunBackend()
    app = create_app(cfg, auth, session, backend, web_dist_dir=dist_dir)
    client = TestClient(app)

    manifest_resp = client.get("/manifest.webmanifest")
    assert manifest_resp.status_code == 200
    assert manifest_resp.headers["content-type"].startswith("application/manifest+json")
    assert manifest_resp.headers.get("cache-control") == "no-cache"

    sw_resp = client.get("/sw.js")
    assert sw_resp.status_code == 200
    assert sw_resp.headers["content-type"].startswith("application/javascript")
    assert sw_resp.headers.get("cache-control") == "no-cache"

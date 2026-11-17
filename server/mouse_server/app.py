"""FastAPI applications for HTTPS/WSS control and HTTP CA setup."""

from __future__ import annotations

import asyncio
import html
import json
import socket
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from .auth import PairingManager
from .config import ConfigManager
from .input.base import InputBackend
from .network import get_hostname, get_lan_ips
from .protocol import (
    BtnMsg,
    CenterMsg,
    ComboMsg,
    ErrorMsg,
    HelloMsg,
    KeyMsg,
    MoveMsg,
    PingMsg,
    PongMsg,
    ProfileCreateMsg,
    ProfileSwitchMsg,
    ScrollMsg,
    SettingsSaveMsg,
    TextMsg,
    WelcomeMsg,
    ZoomMsg,
    parse_client_msg,
)
from .session import SessionManager

HELLO_TIMEOUT_SECONDS = 3.0


class PairRequest(BaseModel):
    method: Literal["qr", "pin"]
    code: str = Field(min_length=1)
    device: str = Field(default="Celular", max_length=100)


def _enable_tcp_nodelay(websocket: WebSocket) -> None:
    """Best-effort TCP_NODELAY activation on the underlying ASGI socket."""
    try:
        transport = getattr(websocket, "_send", None)
        if transport is None:
            return
        bound = getattr(transport, "__self__", None)
        sock_obj = getattr(bound, "transport", None)
        if sock_obj is None:
            return
        raw_sock = sock_obj.get_extra_info("socket")
        if raw_sock is not None:
            raw_sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except Exception:
        pass


def create_app(
    config_manager: ConfigManager,
    pairing_manager: PairingManager,
    session_manager: SessionManager,
    backend: InputBackend,
    web_dist_dir: Path | None = None,
    get_network_info: Callable[[], dict[str, object]] | None = None,
) -> FastAPI:
    """Create the main HTTPS + WSS FastAPI application."""
    app = FastAPI(title="Mouse", version="0.1.0")

    @app.get("/api/info")
    async def api_info() -> dict[str, object]:
        if get_network_info is not None:
            return get_network_info()
        return {
            "app": "Mouse",
            "hostname": get_hostname(),
            "ips": get_lan_ips(),
        }

    @app.post("/api/pair")
    async def api_pair(payload: PairRequest) -> dict[str, object]:
        if payload.method == "qr":
            token = pairing_manager.exchange_qr(payload.code, payload.device)
        else:
            token = pairing_manager.exchange_pin(payload.code, payload.device)

        if token is None:
            raise HTTPException(status_code=401, detail="Código ou PIN inválido ou expirado")

        active_profile, settings = config_manager.get_active_profile()
        return {
            "token": token,
            "active_profile": active_profile,
            "settings": settings.model_dump(),
            "profiles": config_manager.list_profiles(),
        }

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        await websocket.accept()
        _enable_tcp_nodelay(websocket)

        registered = False
        try:
            try:
                raw_hello = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=HELLO_TIMEOUT_SECONDS,
                )
                hello = parse_client_msg(raw_hello)
            except (TimeoutError, ValidationError, json.JSONDecodeError):
                await websocket.send_text(ErrorMsg(code="unauthorized").model_dump_json())
                await websocket.close(code=4401, reason="unauthorized")
                return

            if not isinstance(hello, HelloMsg):
                await websocket.send_text(ErrorMsg(code="unauthorized").model_dump_json())
                await websocket.close(code=4401, reason="hello_required")
                return

            device = pairing_manager.verify_token(hello.token)
            if device is None:
                await websocket.send_text(ErrorMsg(code="unauthorized").model_dump_json())
                await websocket.close(code=4401, reason="invalid_token")
                return

            await session_manager.activate(device.id, hello.device or device.name, websocket)
            registered = True

            active_profile, settings = config_manager.get_active_profile()
            welcome = WelcomeMsg(
                active_profile=active_profile,
                settings=settings,
                profiles=config_manager.list_profiles(),
            )
            await websocket.send_text(welcome.model_dump_json())

            while True:
                raw_msg = await websocket.receive_text()
                try:
                    msg = parse_client_msg(raw_msg)
                except (ValidationError, json.JSONDecodeError):
                    await websocket.send_text(ErrorMsg(code="invalid_message").model_dump_json())
                    continue

                if isinstance(msg, MoveMsg):
                    backend.move(msg.dx, msg.dy)
                elif isinstance(msg, ScrollMsg):
                    backend.scroll(msg.dx, msg.dy)
                elif isinstance(msg, BtnMsg):
                    backend.button(msg.b, msg.s)
                elif isinstance(msg, ZoomMsg):
                    backend.zoom(msg.d)
                elif isinstance(msg, TextMsg):
                    backend.text(msg.v)
                elif isinstance(msg, KeyMsg):
                    backend.key(msg.k, msg.s)
                elif isinstance(msg, ComboMsg):
                    backend.combo(msg.k)
                elif isinstance(msg, CenterMsg):
                    backend.center_cursor()
                elif isinstance(msg, PingMsg):
                    await websocket.send_text(PongMsg(ts=msg.ts).model_dump_json())
                elif isinstance(msg, SettingsSaveMsg):
                    saved = config_manager.save_profile(msg.profile, msg.data)
                    await websocket.send_text(
                        WelcomeMsg(
                            active_profile=msg.profile,
                            settings=saved,
                            profiles=config_manager.list_profiles(),
                        ).model_dump_json()
                    )
                elif isinstance(msg, ProfileSwitchMsg):
                    try:
                        switched = config_manager.switch_profile(msg.profile)
                        await websocket.send_text(
                            WelcomeMsg(
                                active_profile=msg.profile,
                                settings=switched,
                                profiles=config_manager.list_profiles(),
                            ).model_dump_json()
                        )
                    except KeyError:
                        err = ErrorMsg(code="unknown_profile")
                        await websocket.send_text(err.model_dump_json())
                elif isinstance(msg, ProfileCreateMsg):
                    try:
                        created = config_manager.create_profile(msg.profile)
                        await websocket.send_text(
                            WelcomeMsg(
                                active_profile=msg.profile,
                                settings=created,
                                profiles=config_manager.list_profiles(),
                            ).model_dump_json()
                        )
                    except ValueError:
                        await websocket.send_text(ErrorMsg(code="profile_exists").model_dump_json())
        except WebSocketDisconnect:
            pass
        finally:
            if registered:
                backend.release_all()
                await session_manager.deactivate(websocket)

    if web_dist_dir is not None and web_dist_dir.exists():
        assets_dir = web_dist_dir / "assets"
        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

        @app.get("/{full_path:path}")
        async def spa_fallback(full_path: str) -> FileResponse:
            requested = (web_dist_dir / full_path).resolve()
            root_resolved = web_dist_dir.resolve()
            if (
                full_path
                and requested.is_file()
                and str(requested).startswith(str(root_resolved))
            ):
                headers = {}
                if full_path in {"sw.js", "manifest.webmanifest", "index.html"}:
                    headers["Cache-Control"] = "no-cache"
                return FileResponse(requested, headers=headers)

            index_file = web_dist_dir / "index.html"
            if index_file.exists():
                return FileResponse(index_file, headers={"Cache-Control": "no-cache"})
            raise HTTPException(status_code=404, detail="Frontend bundle not built")

    return app


def create_setup_app(
    ca_cert_path: Path,
    get_https_url: Callable[[], str],
    get_fingerprint: Callable[[], str],
) -> FastAPI:
    """Create the HTTP onboarding server exposing only /setup and /mouse-ca.crt."""
    setup_app = FastAPI(title="Mouse Setup", version="0.1.0")

    @setup_app.get("/")
    async def root_redirect() -> RedirectResponse:
        return RedirectResponse(url="/setup")

    @setup_app.get("/mouse-ca.crt")
    async def download_ca() -> FileResponse:
        if not ca_cert_path.exists():
            raise HTTPException(status_code=404, detail="CA certificate not found")
        return FileResponse(
            path=ca_cert_path,
            media_type="application/x-x509-ca-cert",
            filename="mouse-ca.crt",
        )

    @setup_app.get("/setup", response_class=HTMLResponse)
    async def setup_page() -> HTMLResponse:
        https_url = html.escape(get_https_url())
        fingerprint = html.escape(get_fingerprint())
        body = f"""<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Mouse — Configurar Celular</title>
  <style>
    :root {{ color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }}
    body {{ max-width: 640px; margin: 0 auto; padding: 24px 16px; line-height: 1.5; }}
    .card {{
      border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
      border-radius: 12px;
      padding: 16px;
      margin: 16px 0;
    }}
    .btn {{
      display: inline-block;
      padding: 12px 18px;
      border-radius: 10px;
      background: #2563eb;
      color: #fff;
      text-decoration: none;
      font-weight: 600;
    }}
    code {{ word-break: break-all; font-size: 0.85rem; }}
  </style>
</head>
<body>
  <h1>Mouse — Configuração Inicial</h1>
  <p>Siga estes passos uma única vez no Android para conectar ao seu PC com segurança:</p>
  <div class="card">
    <h2>1. Baixar o certificado da CA local</h2>
    <p><a class="btn" href="/mouse-ca.crt">Baixar mouse-ca.crt</a></p>
    <p>
      <small>Impressão digital SHA-256 para conferência:<br><code>{fingerprint}</code></small>
    </p>
  </div>
  <div class="card">
    <h2>2. Instalar no Android</h2>
    <ol>
      <li>
        Abra <strong>Configurações → Segurança → Criptografia e credenciais</strong>
        (ou pesquise por "Instalar certificado").
      </li>
      <li>Toque em <strong>Instalar certificado → Certificado CA</strong>.</li>
      <li>Selecione o arquivo <code>mouse-ca.crt</code> baixado.</li>
    </ol>
    <p>
      <small>
        Nota: O Android exibe um aviso padrão dizendo que a rede pode ser monitorada.
        Isso ocorre para qualquer certificado CA local instalado manualmente.
      </small>
    </p>
  </div>
  <div class="card">
    <h2>3. Abrir o app e parear</h2>
    <p>
      Depois de instalar a CA, escaneie o <strong>QR Code 2</strong> na bandeja do PC
      ou abra no Chrome:
    </p>
    <p><a class="btn" href="{https_url}">Abrir Mouse ({https_url})</a></p>
  </div>
</body>
</html>"""
        return HTMLResponse(content=body)

    return setup_app

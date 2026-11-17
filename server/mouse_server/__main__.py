"""CLI entrypoint for Mouse server (tray or headless mode)."""

from __future__ import annotations

import argparse
import sys
import threading
from pathlib import Path

import uvicorn

from .app import create_app, create_setup_app
from .auth import PairingManager
from .certs import ensure_certs
from .config import ConfigManager, get_default_data_dir
from .input.base import InputBackend
from .input.dryrun_backend import DryRunBackend
from .network import IPWatcher, get_hostname, get_lan_ips, get_primary_ip
from .session import SessionManager


def resolve_web_dist_dir() -> Path | None:
    """Locate compiled web/dist directory in dev workspace or PyInstaller bundle."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        bundled = Path(sys._MEIPASS) / "web_dist"
        if bundled.exists():
            return bundled

    repo_dist = Path(__file__).resolve().parents[2] / "web" / "dist"
    if repo_dist.exists():
        return repo_dist
    return None


def _build_backend(dry_run: bool) -> InputBackend:
    if dry_run:
        return DryRunBackend()
    from .input.pynput_backend import PynputBackend

    return PynputBackend()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mouse-server", description="Mouse PC control server")
    parser.add_argument(
        "--no-tray",
        action="store_true",
        help="Run headless without system tray UI",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Record input commands in memory instead of moving cursor/keyboard",
    )
    parser.add_argument(
        "--https-port",
        type=int,
        default=8443,
        help="HTTPS/WSS port (default 8443)",
    )
    parser.add_argument(
        "--http-port",
        type=int,
        default=8080,
        help="HTTP setup port (default 8080)",
    )
    parser.add_argument("--data-dir", type=Path, default=None, help="Override config/certs dir")
    return parser


def _configure_frozen_stdio(data_dir: Path) -> None:
    """Ensure stdout/stderr are valid streams in --windowed PyInstaller builds."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        log_path = data_dir / "mouse.log"
        stream = log_path.open("a", encoding="utf-8", buffering=1)
    except OSError:
        import os

        stream = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    data_dir = args.data_dir if args.data_dir is not None else get_default_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    _configure_frozen_stdio(data_dir)

    hostname = get_hostname()
    ips = get_lan_ips()
    bundle = ensure_certs(data_dir, ips=ips, hostname=hostname)

    config_manager = ConfigManager(data_dir=data_dir)
    pairing_manager = PairingManager(data_dir=data_dir)
    backend = _build_backend(args.dry_run)

    status_holder: dict[str, object] = {"tray": None}

    def on_status_change(device_name: str | None) -> None:
        tray = status_holder.get("tray")
        if tray is not None and hasattr(tray, "update_status"):
            tray.update_status(device_name)

    session_manager = SessionManager(on_status_change=on_status_change)

    def get_network_info() -> dict[str, object]:
        return {
            "app": "Mouse",
            "hostname": hostname,
            "ips": get_lan_ips(),
        }

    app = create_app(
        config_manager=config_manager,
        pairing_manager=pairing_manager,
        session_manager=session_manager,
        backend=backend,
        web_dist_dir=resolve_web_dist_dir(),
        get_network_info=get_network_info,
    )
    setup_app = create_setup_app(
        ca_cert_path=bundle.ca_cert,
        get_https_url=lambda: f"https://{get_primary_ip()}:{args.https_port}",
        get_fingerprint=lambda: bundle.fingerprint,
    )

    https_config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=args.https_port,
        ssl_certfile=str(bundle.server_cert),
        ssl_keyfile=str(bundle.server_key),
        log_level="info",
        log_config=None if getattr(sys, "frozen", False) else uvicorn.config.LOGGING_CONFIG,
    )
    http_config = uvicorn.Config(
        setup_app,
        host="0.0.0.0",
        port=args.http_port,
        log_level="warning",
        log_config=None if getattr(sys, "frozen", False) else uvicorn.config.LOGGING_CONFIG,
    )

    https_server = uvicorn.Server(https_config)
    http_server = uvicorn.Server(http_config)

    def on_ip_change(new_ips: list[str]) -> None:
        nonlocal bundle
        bundle = ensure_certs(data_dir, ips=new_ips, hostname=hostname)
        if https_config.ssl is not None:
            try:
                https_config.ssl.load_cert_chain(
                    certfile=str(bundle.server_cert),
                    keyfile=str(bundle.server_key),
                )
            except OSError:
                pass
        tray = status_holder.get("tray")
        if tray is not None and hasattr(tray, "on_ip_changed"):
            tray.on_ip_changed(new_ips)

    ip_watcher = IPWatcher(on_change=on_ip_change)
    ip_watcher.start()

    http_thread = threading.Thread(target=http_server.run, name="mouse-http-setup", daemon=True)
    http_thread.start()

    if not args.no_tray:
        try:
            from .tray import MouseTrayApp

            https_thread = threading.Thread(
                target=https_server.run,
                name="mouse-https-server",
                daemon=True,
            )
            https_thread.start()

            def shutdown() -> None:
                https_server.should_exit = True
                http_server.should_exit = True
                ip_watcher.stop()

            tray = MouseTrayApp(
                pairing_manager=pairing_manager,
                session_manager=session_manager,
                https_port=args.https_port,
                http_port=args.http_port,
                ca_fingerprint=bundle.fingerprint,
                hostname=hostname,
                on_exit=shutdown,
            )
            status_holder["tray"] = tray
            tray.run()
            return 0
        except ImportError:
            pass

    qr_code, pin = pairing_manager.get_active_codes()
    primary_ip = get_primary_ip()
    print(f"Mouse server listening on https://{primary_ip}:{args.https_port}")
    print(f"Setup page (CA download): http://{primary_ip}:{args.http_port}/setup")
    print(f"Pair URL: https://{primary_ip}:{args.https_port}/#pair={qr_code}")
    print(f"Pairing PIN: {pin}")
    try:
        https_server.run()
    finally:
        http_server.should_exit = True
        ip_watcher.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

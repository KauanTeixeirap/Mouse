"""System tray app (pystray) and Tkinter pairing window with QR codes and PIN."""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import qrcode
from PIL import Image, ImageDraw

from .auth import PairedDevice, PairingManager
from .autostart import is_autostart_enabled, set_autostart_enabled
from .mdns import MdnsAdvertiser
from .network import get_primary_ip
from .session import SessionManager

if TYPE_CHECKING:
    import tkinter as tk

    import pystray


def create_tray_icon_image(connected: bool = False) -> Image.Image:
    """Render a clean 64x64 tray icon for Mouse."""
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        (12, 6, 52, 58),
        radius=20,
        fill=(30, 41, 59, 255),
        outline=(56, 189, 248, 255),
        width=3,
    )
    draw.line((32, 6, 32, 30), fill=(56, 189, 248, 255), width=3)
    draw.rounded_rectangle((29, 14, 35, 25), radius=3, fill=(248, 250, 252, 255))
    dot_color = (34, 197, 94, 255) if connected else (148, 163, 184, 255)
    draw.ellipse((42, 42, 58, 58), fill=dot_color, outline=(15, 23, 42, 255), width=2)
    return img


def make_qr_image(payload: str, size: int = 190) -> Image.Image:
    """Generate a crisp square QR code image using qrcode + Pillow."""
    qr = qrcode.QRCode(border=2, box_size=6)
    qr.add_data(payload)
    qr.make(fit=True)
    pil_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    return pil_img.resize((size, size), Image.Resampling.NEAREST)


class MouseTrayApp:
    """Windows system tray controller with pairing UI and device management."""

    def __init__(
        self,
        pairing_manager: PairingManager,
        session_manager: SessionManager,
        https_port: int,
        http_port: int,
        ca_fingerprint: str,
        hostname: str,
        on_exit: Callable[[], None],
    ) -> None:
        import pystray

        self._pystray = pystray
        self.pairing_manager = pairing_manager
        self.session_manager = session_manager
        self.https_port = https_port
        self.http_port = http_port
        self.ca_fingerprint = ca_fingerprint
        self.hostname = hostname
        self._on_exit = on_exit
        self._mdns = MdnsAdvertiser(hostname=hostname, port=https_port)
        self._connected_device: str | None = session_manager.active_device_name
        self._pairing_lock = threading.Lock()
        self._tk_root: tk.Tk | None = None
        self._tk_refresh_cb: Callable[[], None] | None = None
        self._icon = pystray.Icon(
            name="Mouse",
            title="Mouse",
            icon=create_tray_icon_image(connected=self._connected_device is not None),
            menu=self._build_menu(),
        )

    def _status_text(self, _item: Any = None) -> str:
        if self._connected_device:
            return f"Status: Conectado ({self._connected_device})"
        return "Status: Aguardando conexão"

    def _build_devices_submenu(self) -> pystray.Menu:
        pystray = self._pystray
        devices = self.pairing_manager.list_devices()
        if not devices:
            return pystray.Menu(pystray.MenuItem("Nenhum aparelho pareado", None, enabled=False))

        def make_revoke(dev: PairedDevice) -> Callable[[Any, Any], None]:
            def _revoke(_icon: Any, _item: Any) -> None:
                self.pairing_manager.revoke_device(dev.id)
                self.session_manager.kick_device_sync(dev.id)
                self._icon.update_menu()

            return _revoke

        items = [pystray.MenuItem(f"Remover: {dev.name}", make_revoke(dev)) for dev in devices]
        return pystray.Menu(*items)

    def _toggle_mdns(self, _icon: Any, _item: Any) -> None:
        if self._mdns.is_running:
            self._mdns.stop()
        else:
            self._mdns.start()
        self._icon.update_menu()

    def _toggle_autostart(self, _icon: Any, _item: Any) -> None:
        set_autostart_enabled(not is_autostart_enabled())
        self._icon.update_menu()

    def _build_menu(self) -> pystray.Menu:
        pystray = self._pystray
        return pystray.Menu(
            pystray.MenuItem("Configurar novo celular", self._open_pairing_window, default=True),
            pystray.MenuItem(self._status_text, None, enabled=False),
            pystray.MenuItem(
                "Aparelhos pareados",
                pystray.Menu(lambda: self._build_devices_submenu().items),
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "Usar nome do PC (.local)",
                self._toggle_mdns,
                checked=lambda _item: self._mdns.is_running,
            ),
            pystray.MenuItem(
                "Iniciar com o Windows",
                self._toggle_autostart,
                checked=lambda _item: is_autostart_enabled(),
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Sair", self._handle_exit),
        )

    def _open_pairing_window(self, _icon: Any = None, _item: Any = None) -> None:
        with self._pairing_lock:
            if self._tk_root is not None and self._tk_refresh_cb is not None:
                try:
                    self._tk_root.after(0, self._tk_root.lift)
                    self._tk_root.after(0, self._tk_refresh_cb)
                    return
                except Exception:
                    pass
        thread = threading.Thread(target=self._run_pairing_tk, name="mouse-pairing-ui", daemon=True)
        thread.start()

    def _run_pairing_tk(self) -> None:
        import tkinter as tk

        from PIL import ImageTk

        root = tk.Tk()
        root.title("Mouse — Configurar novo celular")
        root.resizable(False, False)

        container = tk.Frame(root, padx=18, pady=16)
        container.pack(fill="both", expand=True)

        header = tk.Label(
            container,
            text="Configurar celular no Mouse",
            font=("Segoe UI", 13, "bold"),
        )
        header.pack(pady=(0, 8))

        qrs_frame = tk.Frame(container)
        qrs_frame.pack(pady=6)

        left_col = tk.Frame(qrs_frame, padx=10)
        left_col.pack(side="left", anchor="n")
        tk.Label(
            left_col,
            text="1. Instalar certificado CA (1ª vez)",
            font=("Segoe UI", 10, "bold"),
        ).pack()
        qr1_img_label = tk.Label(left_col)
        qr1_img_label.pack(pady=6)
        qr1_url_label = tk.Label(left_col, text="", wraplength=210, fg="#334155")
        qr1_url_label.pack()

        right_col = tk.Frame(qrs_frame, padx=10)
        right_col.pack(side="left", anchor="n")
        tk.Label(
            right_col,
            text="2. Abrir app e parear",
            font=("Segoe UI", 10, "bold"),
        ).pack()
        qr2_img_label = tk.Label(right_col)
        qr2_img_label.pack(pady=6)
        qr2_url_label = tk.Label(right_col, text="", wraplength=210, fg="#334155")
        qr2_url_label.pack()

        pin_label = tk.Label(container, text="", font=("Segoe UI", 16, "bold"))
        pin_label.pack(pady=(12, 4))

        fp_label = tk.Label(
            container,
            text=f"Impressão digital da CA (SHA-256):\n{self.ca_fingerprint}",
            font=("Consolas", 8),
            fg="#475569",
            justify="center",
        )
        fp_label.pack(pady=(4, 10))

        photo_refs: dict[str, Any] = {}

        def refresh(rotate: bool = False) -> None:
            if rotate:
                qr_code, pin = self.pairing_manager.rotate_codes()
            else:
                qr_code, pin = self.pairing_manager.get_active_codes()

            ip = get_primary_ip()
            setup_url = f"http://{ip}:{self.http_port}/setup"
            pair_url = f"https://{ip}:{self.https_port}/#pair={qr_code}"

            img1 = ImageTk.PhotoImage(make_qr_image(setup_url))
            img2 = ImageTk.PhotoImage(make_qr_image(pair_url))
            photo_refs["qr1"] = img1
            photo_refs["qr2"] = img2

            qr1_img_label.configure(image=img1)
            qr2_img_label.configure(image=img2)
            qr1_url_label.configure(text=setup_url)
            qr2_url_label.configure(text=f"https://{ip}:{self.https_port}")
            pin_label.configure(text=f"PIN de pareamento: {pin}")

        tk.Button(
            container,
            text="Gerar novo código / PIN",
            command=lambda: refresh(rotate=True),
            padx=12,
            pady=6,
        ).pack()

        def on_close() -> None:
            with self._pairing_lock:
                self._tk_root = None
                self._tk_refresh_cb = None
            root.destroy()

        with self._pairing_lock:
            self._tk_root = root
            self._tk_refresh_cb = lambda: refresh(rotate=False)

        root.protocol("WM_DELETE_WINDOW", on_close)
        refresh(rotate=False)
        root.mainloop()

    def update_status(self, device_name: str | None) -> None:
        self._connected_device = device_name
        self._icon.icon = create_tray_icon_image(connected=device_name is not None)
        self._icon.title = f"Mouse ({device_name})" if device_name else "Mouse"
        self._icon.update_menu()

    def on_ip_changed(self, _new_ips: list[str]) -> None:
        if self._mdns.is_running:
            self._mdns.restart()
        with self._pairing_lock:
            if self._tk_root is not None and self._tk_refresh_cb is not None:
                try:
                    self._tk_root.after(0, self._tk_refresh_cb)
                except Exception:
                    pass
        try:
            self._icon.notify("O IP do PC mudou — reinstale o app pelo novo QR", "Mouse")
        except Exception:
            pass

    def _handle_exit(self, _icon: Any, _item: Any) -> None:
        self._mdns.stop()
        with self._pairing_lock:
            if self._tk_root is not None:
                try:
                    self._tk_root.after(0, self._tk_root.destroy)
                except Exception:
                    pass
                self._tk_root = None
                self._tk_refresh_cb = None
        self._icon.stop()
        self._on_exit()

    def run(self) -> None:
        self._icon.run()

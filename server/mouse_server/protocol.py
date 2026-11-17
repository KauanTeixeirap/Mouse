"""WebSocket and REST message protocol models shared with the TypeScript PWA."""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, Field, TypeAdapter

SPECIAL_KEYS: frozenset[str] = frozenset(
    {
        "backspace",
        "tab",
        "enter",
        "esc",
        "space",
        "delete",
        "up",
        "down",
        "left",
        "right",
        "home",
        "end",
        "page_up",
        "page_down",
        "ctrl",
        "alt",
        "shift",
        "win",
        *(f"f{i}" for i in range(1, 13)),
        "media_play_pause",
        "media_volume_up",
        "media_volume_down",
        "media_volume_mute",
        "media_next",
        "media_prev",
    }
)


def validate_key_name(value: str) -> str:
    """Validate and normalize a logical key identifier."""
    normalized = value.strip().lower()
    if normalized in SPECIAL_KEYS:
        return normalized
    if len(normalized) == 1 and normalized.isascii() and normalized.isalnum():
        return normalized
    raise ValueError(f"Unsupported key name: {value!r}")


KeyName = Annotated[str, AfterValidator(validate_key_name)]


class CustomShortcut(BaseModel):
    """User-defined keyboard shortcut stored inside a PC profile."""

    id: str = Field(min_length=1)
    label: str = Field(min_length=1, max_length=64)
    keys: list[KeyName] = Field(min_length=1)


class ThreeFingerActions(BaseModel):
    """Configurable actions triggered by 3-finger gestures."""

    tap: list[KeyName] = Field(default_factory=lambda: ["media_play_pause"])
    up: list[KeyName] = Field(default_factory=lambda: ["win", "tab"])
    down: list[KeyName] = Field(default_factory=lambda: ["win", "d"])
    left: list[KeyName] = Field(default_factory=lambda: ["alt", "tab"])
    right: list[KeyName] = Field(default_factory=lambda: ["alt", "tab"])


class Settings(BaseModel):
    """Per-profile settings persisted on the PC and synced to the phone."""

    trackpad_sensitivity: float = Field(default=1.4, ge=0.2, le=5.0)
    gyro_sensitivity: float = Field(default=18.0, ge=2.0, le=60.0)
    acceleration: float = Field(default=0.6, ge=0.0, le=2.0)
    scroll_speed: float = Field(default=1.0, ge=0.2, le=4.0)
    natural_scroll: bool = True
    haptics: bool = True
    wake_lock: bool = True
    theme: Literal["system", "light", "dark"] = "system"
    clutch_mode: Literal["hold_to_pause", "hold_to_move"] = "hold_to_pause"
    three_finger: ThreeFingerActions = Field(default_factory=ThreeFingerActions)
    shortcuts: list[CustomShortcut] = Field(default_factory=list)


class HelloMsg(BaseModel):
    t: Literal["hello"] = "hello"
    token: str = Field(min_length=1)
    device: str = Field(min_length=1, max_length=100)


class MoveMsg(BaseModel):
    t: Literal["move"] = "move"
    dx: float
    dy: float


class ScrollMsg(BaseModel):
    t: Literal["scroll"] = "scroll"
    dx: float
    dy: float


class BtnMsg(BaseModel):
    t: Literal["btn"] = "btn"
    b: Literal["left", "right", "middle"]
    s: Literal["down", "up", "click"]


class ZoomMsg(BaseModel):
    t: Literal["zoom"] = "zoom"
    d: float


class TextMsg(BaseModel):
    t: Literal["text"] = "text"
    v: str


class KeyMsg(BaseModel):
    t: Literal["key"] = "key"
    k: KeyName
    s: Literal["down", "up", "tap"]


class ComboMsg(BaseModel):
    t: Literal["combo"] = "combo"
    k: list[KeyName] = Field(min_length=1)


class CenterMsg(BaseModel):
    t: Literal["center"] = "center"


class SettingsSaveMsg(BaseModel):
    t: Literal["settings.save"] = "settings.save"
    profile: str = Field(min_length=1, max_length=64)
    data: Settings


class ProfileSwitchMsg(BaseModel):
    t: Literal["profile.switch"] = "profile.switch"
    profile: str = Field(min_length=1, max_length=64)


class ProfileCreateMsg(BaseModel):
    t: Literal["profile.create"] = "profile.create"
    profile: str = Field(min_length=1, max_length=64)


class PingMsg(BaseModel):
    t: Literal["ping"] = "ping"
    ts: float


ClientMsg = Annotated[
    HelloMsg
    | MoveMsg
    | ScrollMsg
    | BtnMsg
    | ZoomMsg
    | TextMsg
    | KeyMsg
    | ComboMsg
    | CenterMsg
    | SettingsSaveMsg
    | ProfileSwitchMsg
    | ProfileCreateMsg
    | PingMsg,
    Field(discriminator="t"),
]

_CLIENT_MSG_ADAPTER: TypeAdapter[ClientMsg] = TypeAdapter(ClientMsg)


class WelcomeMsg(BaseModel):
    t: Literal["welcome"] = "welcome"
    active_profile: str
    settings: Settings
    profiles: list[str]


class KickedMsg(BaseModel):
    t: Literal["kicked"] = "kicked"
    reason: Literal["other_device"] = "other_device"


class PongMsg(BaseModel):
    t: Literal["pong"] = "pong"
    ts: float


class ErrorMsg(BaseModel):
    t: Literal["error"] = "error"
    code: str


class TextFocusMsg(BaseModel):
    t: Literal["text_focus"] = "text_focus"


ServerMsg = Annotated[
    WelcomeMsg | KickedMsg | PongMsg | ErrorMsg | TextFocusMsg,
    Field(discriminator="t"),
]


def parse_client_msg(raw: dict[str, Any] | str) -> ClientMsg:
    """Parse and validate a client WebSocket message."""
    if isinstance(raw, str):
        data = json.loads(raw)
        return _CLIENT_MSG_ADAPTER.validate_python(data)
    return _CLIENT_MSG_ADAPTER.validate_python(raw)

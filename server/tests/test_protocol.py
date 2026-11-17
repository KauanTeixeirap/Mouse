"""Tests for message protocol validation and Python/TypeScript parity."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from mouse_server.protocol import (
    SPECIAL_KEYS,
    BtnMsg,
    CenterMsg,
    ComboMsg,
    HelloMsg,
    KeyMsg,
    MoveMsg,
    PingMsg,
    ProfileCreateMsg,
    ProfileSwitchMsg,
    ScrollMsg,
    Settings,
    SettingsSaveMsg,
    TextFocusMsg,
    TextMsg,
    ZoomMsg,
    parse_client_msg,
)


def test_parse_all_client_messages() -> None:
    assert isinstance(
        parse_client_msg({"t": "hello", "token": "abc", "device": "Pixel"}),
        HelloMsg,
    )
    assert isinstance(parse_client_msg({"t": "move", "dx": 2.5, "dy": -1.5}), MoveMsg)
    assert isinstance(parse_client_msg({"t": "scroll", "dx": 0, "dy": -3}), ScrollMsg)
    assert isinstance(parse_client_msg({"t": "btn", "b": "left", "s": "click"}), BtnMsg)
    assert isinstance(parse_client_msg({"t": "zoom", "d": 1.0}), ZoomMsg)
    assert isinstance(parse_client_msg({"t": "text", "v": "ação"}), TextMsg)
    assert isinstance(parse_client_msg({"t": "key", "k": "Ctrl", "s": "down"}), KeyMsg)
    assert isinstance(parse_client_msg({"t": "combo", "k": ["ctrl", "c"]}), ComboMsg)
    assert isinstance(parse_client_msg({"t": "center"}), CenterMsg)
    assert isinstance(
        parse_client_msg(
            {"t": "settings.save", "profile": "Mesa", "data": Settings().model_dump()}
        ),
        SettingsSaveMsg,
    )
    assert isinstance(
        parse_client_msg({"t": "profile.switch", "profile": "Mesa"}),
        ProfileSwitchMsg,
    )
    assert isinstance(parse_client_msg({"t": "profile.create", "profile": "TV"}), ProfileCreateMsg)
    assert isinstance(parse_client_msg({"t": "ping", "ts": 1234.5}), PingMsg)
    assert TextFocusMsg().model_dump() == {"t": "text_focus"}


def test_invalid_key_rejected() -> None:
    with pytest.raises(ValidationError):
        parse_client_msg({"t": "key", "k": "nonexistent_key", "s": "tap"})


def test_protocol_matches_typescript_schema() -> None:
    ts_path = Path(__file__).resolve().parents[2] / "web" / "src" / "protocol.ts"
    ts_text = ts_path.read_text(encoding="utf-8")

    # Verify all message discriminators in ClientMsg exist in TS ClientMsg
    expected_types = {
        "hello",
        "move",
        "scroll",
        "btn",
        "zoom",
        "text",
        "key",
        "combo",
        "center",
        "settings.save",
        "profile.switch",
        "profile.create",
        "ping",
    }
    ts_types = set(re.findall(r't:\s*"([^"]+)"', ts_text))
    assert expected_types.issubset(ts_types)
    assert {"welcome", "kicked", "pong", "error", "text_focus"}.issubset(ts_types)

    # Verify all SPECIAL_KEYS are declared in TS SpecialKeyName
    ts_special_block = (
        ts_text.split("export type SpecialKeyName =")[1].split("export type KeyName")[0]
    )
    ts_special_keys = set(re.findall(r'"([^"]+)"', ts_special_block))
    assert ts_special_keys == set(SPECIAL_KEYS)

    # Verify Settings fields parity
    for field_name in Settings.model_fields:
        assert f"{field_name}:" in ts_text

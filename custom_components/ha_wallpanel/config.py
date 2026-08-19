"""Configuration validation independent from Home Assistant UI code."""

from __future__ import annotations

from copy import deepcopy
import json
import re
from typing import Any

from .const import (
    CONF_CARDS,
    CONF_COLORS,
    CONF_DISPLAY_TIME,
    CONF_ENABLED,
    CONF_HIDE_CURSOR,
    CONF_IDLE_TIME,
    CONF_PANEL_ORDER,
    CONF_SCHEDULE_ENABLED,
    CONF_SCHEDULE_END,
    CONF_SCHEDULE_MODE,
    CONF_SCHEDULE_PANEL,
    CONF_SCHEDULE_START,
    CONF_SHOW_PROGRESS,
    CONF_SHUFFLE,
    CONF_TRANSITION_TIME,
    CONF_VIEWS,
    DEFAULT_CONFIG,
    SCHEDULE_MODES,
)


class ConfigValidationError(ValueError):
    """Error carrying a translation key for a config flow form."""

    def __init__(self, code: str, message: str) -> None:
        """Initialize a validation error."""
        super().__init__(message)
        self.code = code


_LEGACY_DUMMY_CARD_CONTENTS = {
    "# HA-Wallpanel\nDer Bildschirmschoner funktioniert.",
    "# Zweite Seite\nTouch oder Klick öffnet wieder das Dashboard.",
}

_HEX_COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
_TIME_PATTERN = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$")


def _number(value: Any, name: str, minimum: float) -> float | int:
    """Validate and normalize a numeric option."""
    try:
        parsed = float(value)
    except (TypeError, ValueError) as err:
        raise ConfigValidationError("invalid_value", f"{name} is not numeric") from err

    if parsed < minimum:
        raise ConfigValidationError(
            "invalid_value", f"{name} must be at least {minimum}"
        )
    return int(parsed) if parsed.is_integer() else parsed


def _views(value: Any) -> list[str]:
    """Validate and normalize selected Lovelace view URL paths."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ConfigValidationError(
            "invalid_panels", "View selection must be a list"
        )

    views: list[str] = []
    for raw_path in value:
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise ConfigValidationError(
                "invalid_panels", "View path must not be empty"
            )
        path = raw_path.strip()
        if "?" in path or "#" in path or "://" in path:
            raise ConfigValidationError(
                "invalid_panels", "View path must not contain a URL query"
            )
        path = f"/{path.lstrip('/')}".rstrip("/")
        if path not in views:
            views.append(path)
    return views


def _rgb_color(value: Any) -> list[int]:
    """Validate an RGB color."""
    if not isinstance(value, list) or len(value) != 3:
        raise ConfigValidationError(
            "invalid_colors", "Color must be an RGB triplet"
        )

    color: list[int] = []
    for channel in value:
        if isinstance(channel, bool):
            raise ConfigValidationError("invalid_colors", "Invalid RGB channel")
        try:
            parsed = int(channel)
        except (TypeError, ValueError) as err:
            raise ConfigValidationError(
                "invalid_colors", "Invalid RGB channel"
            ) from err
        if parsed < 0 or parsed > 255:
            raise ConfigValidationError(
                "invalid_colors", "RGB channel must be between 0 and 255"
            )
        color.append(parsed)
    return color


def _hex_color(value: Any) -> str:
    """Validate a hex color or migrate a legacy RGB triplet."""
    if isinstance(value, str) and _HEX_COLOR_PATTERN.fullmatch(value):
        return value.upper()

    red, green, blue = _rgb_color(value)
    return f"#{red:02X}{green:02X}{blue:02X}"


def _cards(value: Any) -> list[dict[str, Any]]:
    """Validate Lovelace card configurations."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ConfigValidationError(
            "invalid_cards", "Lovelace cards must be a list"
        )

    cards: list[dict[str, Any]] = []
    for index, item in enumerate(value, start=1):
        card = item.get("card") if isinstance(item, dict) else None
        name = item.get("name") if isinstance(item, dict) else None
        if card is None and isinstance(item, dict):
            # v0.4 stored the Lovelace configuration directly in the list.
            card = item
            name = item.get("name")
        if (
            isinstance(card, dict)
            and (
                str(card.get("type", "")).strip() == "panel"
                or card.get("panel") is True
            )
        ):
            nested_cards = card.get("cards")
            if not isinstance(nested_cards, list) or len(nested_cards) != 1:
                raise ConfigValidationError(
                    "invalid_cards",
                    f"Panel view {index} must contain exactly one card",
                )
            card = nested_cards[0]
        if (
            not isinstance(card, dict)
            or not isinstance(card.get("type"), str)
            or not card["type"].strip()
        ):
            raise ConfigValidationError(
                "invalid_cards", f"Card {index} needs a non-empty type"
            )
        if (
            card.get("type") == "markdown"
            and card.get("content") in _LEGACY_DUMMY_CARD_CONTENTS
        ):
            continue
        cards.append(
            {
                "name": str(name or f"Karte {index}"),
                "card": deepcopy(card),
            }
        )
    return cards


def _colors(value: Any) -> list[dict[str, Any]]:
    """Validate fullscreen color panels."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ConfigValidationError("invalid_colors", "Colors must be a list")

    colors: list[dict[str, Any]] = []
    for index, item in enumerate(value, start=1):
        if not isinstance(item, dict) or "color" not in item:
            raise ConfigValidationError(
                "invalid_colors", f"Color {index} needs a hex color"
            )
        colors.append({"color": _hex_color(item["color"])})
    return colors


def _panel_order(
    value: Any,
    views: list[str],
    cards: list[dict[str, Any]],
    colors: list[dict[str, Any]],
) -> list[str]:
    """Validate the combined order and append panels missing from old configs."""
    if isinstance(value, str):
        try:
            value = json.loads(value) if value.strip() else []
        except json.JSONDecodeError as err:
            raise ConfigValidationError(
                "invalid_value", "Panel order must be valid JSON"
            ) from err
    if value is None:
        value = []
    if not isinstance(value, list):
        raise ConfigValidationError("invalid_value", "Panel order must be a list")

    valid = {
        *(f"view:{path}" for path in views),
        *(f"card:{index}" for index in range(len(cards))),
        *(f"color:{index}" for index in range(len(colors))),
    }
    order: list[str] = []
    for token in value:
        if isinstance(token, str) and token in valid and token not in order:
            order.append(token)

    for token in (
        *(f"view:{path}" for path in views),
        *(f"card:{index}" for index in range(len(cards))),
        *(f"color:{index}" for index in range(len(colors))),
    ):
        if token not in order:
            order.append(token)
    return order


def _time_value(value: Any, name: str) -> str:
    """Validate a local wallpanel time and normalize it to HH:MM."""
    if hasattr(value, "isoformat"):
        value = value.isoformat()
    if not isinstance(value, str) or not _TIME_PATTERN.fullmatch(value.strip()):
        raise ConfigValidationError("invalid_schedule", f"{name} is not a time")
    return value.strip()[:5]


def normalize_config(
    values: dict[str, Any], *, require_panels: bool = True
) -> dict[str, Any]:
    """Validate and normalize a complete integration configuration."""
    config = deepcopy(DEFAULT_CONFIG)
    config.update(values)

    # v0.4 stored whole dashboards here (including the built-in map panel).
    # Those are not Lovelace views and must not appear as selectable cards.
    view_source = values.get(CONF_VIEWS, [])
    views = _views(view_source)
    cards = _cards(config[CONF_CARDS])
    colors = _colors(config[CONF_COLORS])
    panel_order = _panel_order(
        config.get(CONF_PANEL_ORDER, []), views, cards, colors
    )
    schedule_start = _time_value(
        config[CONF_SCHEDULE_START], CONF_SCHEDULE_START
    )
    schedule_end = _time_value(config[CONF_SCHEDULE_END], CONF_SCHEDULE_END)
    schedule_mode = str(config[CONF_SCHEDULE_MODE])
    if schedule_mode not in SCHEDULE_MODES:
        raise ConfigValidationError(
            "invalid_schedule", "Unknown schedule mode"
        )
    schedule_enabled = bool(config[CONF_SCHEDULE_ENABLED])
    if schedule_enabled and schedule_start == schedule_end:
        raise ConfigValidationError(
            "invalid_schedule", "Schedule start and end must differ"
        )
    schedule_panel = str(config.get(CONF_SCHEDULE_PANEL, "") or "")
    if schedule_panel not in panel_order:
        schedule_panel = panel_order[0] if panel_order else ""
    if require_panels and not views and not cards and not colors:
        raise ConfigValidationError(
            "invalid_panels", "Select a view, card, or fullscreen color"
        )

    display_time = _number(config[CONF_DISPLAY_TIME], CONF_DISPLAY_TIME, 1)
    transition_time = _number(
        config[CONF_TRANSITION_TIME], CONF_TRANSITION_TIME, 0
    )
    if transition_time > display_time:
        raise ConfigValidationError(
            "invalid_transition",
            "transition_time must not be greater than display_time",
        )

    return {
        CONF_ENABLED: bool(config[CONF_ENABLED]),
        CONF_VIEWS: views,
        CONF_IDLE_TIME: _number(config[CONF_IDLE_TIME], CONF_IDLE_TIME, 1),
        CONF_DISPLAY_TIME: display_time,
        CONF_TRANSITION_TIME: transition_time,
        CONF_COLORS: colors,
        CONF_SHOW_PROGRESS: bool(config[CONF_SHOW_PROGRESS]),
        CONF_HIDE_CURSOR: bool(config[CONF_HIDE_CURSOR]),
        CONF_CARDS: cards,
        CONF_PANEL_ORDER: panel_order,
        CONF_SHUFFLE: bool(config[CONF_SHUFFLE]),
        CONF_SCHEDULE_ENABLED: schedule_enabled,
        CONF_SCHEDULE_START: schedule_start,
        CONF_SCHEDULE_END: schedule_end,
        CONF_SCHEDULE_MODE: schedule_mode,
        CONF_SCHEDULE_PANEL: schedule_panel,
    }

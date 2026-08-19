"""Constants for HA-Wallpanel."""

from __future__ import annotations

DOMAIN = "ha_wallpanel"
NAME = "HA-Wallpanel"
VERSION = "0.7.13"

CONF_ENABLED = "enabled"
CONF_VIEWS = "views"
CONF_IDLE_TIME = "idle_time"
CONF_DISPLAY_TIME = "display_time"
CONF_TRANSITION_TIME = "transition_time"
CONF_COLORS = "colors"
CONF_SHOW_PROGRESS = "show_progress"
CONF_HIDE_CURSOR = "hide_cursor"
CONF_CARDS = "cards"
CONF_PANEL_ORDER = "panel_order"
CONF_SHUFFLE = "shuffle"
CONF_SCHEDULE_ENABLED = "schedule_enabled"
CONF_SCHEDULE_START = "schedule_start"
CONF_SCHEDULE_END = "schedule_end"
CONF_SCHEDULE_MODE = "schedule_mode"
CONF_SCHEDULE_PANEL = "schedule_panel"

SCHEDULE_MODE_BLACK = "black"
SCHEDULE_MODE_STATIC = "static"
SCHEDULE_MODE_DISABLED = "disabled"
SCHEDULE_MODES = {
    SCHEDULE_MODE_BLACK,
    SCHEDULE_MODE_STATIC,
    SCHEDULE_MODE_DISABLED,
}

DEFAULT_CARDS: list[dict] = []

DEFAULT_CONFIG = {
    CONF_ENABLED: True,
    CONF_VIEWS: [],
    CONF_IDLE_TIME: 60,
    CONF_DISPLAY_TIME: 15,
    CONF_TRANSITION_TIME: 1.5,
    CONF_COLORS: [],
    CONF_SHOW_PROGRESS: False,
    CONF_HIDE_CURSOR: True,
    CONF_CARDS: DEFAULT_CARDS,
    CONF_PANEL_ORDER: [],
    CONF_SHUFFLE: False,
    CONF_SCHEDULE_ENABLED: False,
    CONF_SCHEDULE_START: "22:00",
    CONF_SCHEDULE_END: "06:00",
    CONF_SCHEDULE_MODE: SCHEDULE_MODE_BLACK,
    CONF_SCHEDULE_PANEL: "",
}

FRONTEND_URL_BASE = f"/{DOMAIN}"
FRONTEND_MODULE = "ha-wallpanel.js"
FRONTEND_URL = f"{FRONTEND_URL_BASE}/{FRONTEND_MODULE}"

DATA_ENTRY = "entry"
SIGNAL_CONFIG_UPDATED = f"{DOMAIN}_config_updated"
WS_TYPE_SUBSCRIBE = f"{DOMAIN}/subscribe"

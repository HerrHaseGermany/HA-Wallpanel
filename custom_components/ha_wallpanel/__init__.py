"""HA-Wallpanel integration."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import (
    async_dispatcher_connect,
    async_dispatcher_send,
)

from .config import normalize_config
from .const import (
    DATA_ENTRY,
    DEFAULT_CONFIG,
    DOMAIN,
    FRONTEND_URL,
    FRONTEND_URL_BASE,
    SIGNAL_CONFIG_UPDATED,
    VERSION,
    WS_TYPE_SUBSCRIBE,
)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


@callback
def _frontend_config(hass: HomeAssistant) -> dict[str, Any]:
    """Return the active configuration for the frontend."""
    entry: ConfigEntry | None = hass.data.get(DOMAIN, {}).get(DATA_ENTRY)
    if entry is None:
        config = deepcopy(DEFAULT_CONFIG)
        config["enabled"] = False
        return {"configured": False, "version": VERSION, **config}

    values = dict(entry.data)
    values.update(entry.options)
    normalized = normalize_config(values, require_panels=False)
    has_panels = any(normalized[key] for key in ("views", "cards", "colors"))
    return {
        "configured": has_panels,
        "version": VERSION,
        **normalized,
    }


@websocket_api.websocket_command({vol.Required("type"): WS_TYPE_SUBSCRIBE})
@callback
def websocket_subscribe_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Subscribe a frontend client to screensaver configuration updates."""

    @callback
    def forward_config() -> None:
        connection.send_event(msg["id"], _frontend_config(hass))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(
        hass, SIGNAL_CONFIG_UPDATED, forward_config
    )
    connection.send_result(msg["id"])
    forward_config()


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Set up static frontend assets and the WebSocket command."""
    frontend_dir = Path(__file__).parent / "frontend"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(FRONTEND_URL_BASE, str(frontend_dir), False)]
    )
    add_extra_js_url(hass, f"{FRONTEND_URL}?v={VERSION}")
    websocket_api.async_register_command(hass, websocket_subscribe_config)
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up HA-Wallpanel from a config entry."""
    hass.data.setdefault(DOMAIN, {})[DATA_ENTRY] = entry

    async def async_entry_updated(
        hass: HomeAssistant, updated_entry: ConfigEntry
    ) -> None:
        """Push changed options to connected frontend clients."""
        hass.data[DOMAIN][DATA_ENTRY] = updated_entry
        async_dispatcher_send(hass, SIGNAL_CONFIG_UPDATED)

    entry.async_on_unload(entry.add_update_listener(async_entry_updated))
    async_dispatcher_send(hass, SIGNAL_CONFIG_UPDATED)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    runtime = hass.data.get(DOMAIN, {})
    if runtime.get(DATA_ENTRY) is entry:
        runtime.pop(DATA_ENTRY, None)
    async_dispatcher_send(hass, SIGNAL_CONFIG_UPDATED)
    return True

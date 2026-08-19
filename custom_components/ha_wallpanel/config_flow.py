"""Config flow for HA-Wallpanel."""

from __future__ import annotations

from copy import deepcopy
import json
from typing import Any

import voluptuous as vol

from homeassistant.components.frontend import DATA_PANELS
from homeassistant.components.lovelace.const import LOVELACE_DATA
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import selector

from .config import ConfigValidationError, normalize_config
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
    DOMAIN,
    NAME,
    SCHEDULE_MODE_BLACK,
    SCHEDULE_MODE_DISABLED,
    SCHEDULE_MODE_STATIC,
)

_BUILT_IN_DASHBOARD_TITLES = {
    "en": {
        "home": "Overview",
        "light": "Lighting",
        "security": "Security",
        "climate": "Climate",
        "energy": "Energy",
        "maintenance": "Maintenance",
    },
    "de": {
        "home": "Übersicht",
        "light": "Beleuchtung",
        "security": "Sicherheit",
        "climate": "Raumklima",
        "energy": "Energie",
        "maintenance": "Wartung",
    },
}


def _number_selector(
    minimum: float, maximum: float, step: float
) -> selector.NumberSelector:
    """Create a seconds input selector."""
    return selector.NumberSelector(
        selector.NumberSelectorConfig(
            min=minimum,
            max=maximum,
            step=step,
            mode=selector.NumberSelectorMode.BOX,
            unit_of_measurement="s",
        )
    )


async def _view_options(
    hass: HomeAssistant, selected: list[str]
) -> list[dict[str, str]]:
    """Build options from built-in dashboards and every Lovelace view."""
    options: list[dict[str, str]] = []
    known_paths: set[str] = set()
    language = "de" if hass.config.language.lower().startswith("de") else "en"
    category_built_in = "Eingebaut" if language == "de" else "Built-in"
    category_user = (
        "Vom Benutzer erstellt" if language == "de" else "User-created"
    )

    panels = hass.data.get(DATA_PANELS, {})
    for panel_path, title in _BUILT_IN_DASHBOARD_TITLES[language].items():
        panel = panels.get(panel_path)
        if panel is None:
            continue
        path = f"/{panel.frontend_url_path.strip('/')}"
        options.append(
            {"value": path, "label": f"{category_built_in} › {title}"}
        )
        known_paths.add(path)

    lovelace_data = hass.data.get(LOVELACE_DATA)
    dashboards = getattr(lovelace_data, "dashboards", {})

    dashboard_items = sorted(
        dashboards.items(),
        key=lambda item: str(
            (getattr(item[1], "config", {}) or {}).get("title")
            or item[0]
            or ""
        ).casefold(),
    )
    for url_path, dashboard in dashboard_items:
        if url_path is None and not getattr(dashboard, "config", None):
            continue
        dashboard_path = str(url_path or "lovelace").strip("/")
        dashboard_config = getattr(dashboard, "config", {}) or {}
        dashboard_title = str(
            dashboard_config.get("title") or dashboard_path or "Lovelace"
        )
        dashboard_url = f"/{dashboard_path}"
        if dashboard_url not in known_paths:
            options.append(
                {
                    "value": dashboard_url,
                    "label": f"{category_user} › {dashboard_title}",
                }
            )
            known_paths.add(dashboard_url)

        try:
            lovelace_config = await dashboard.async_load(False)
        except Exception:  # noqa: BLE001 - one broken dashboard must not hide the form
            continue
        if not isinstance(lovelace_config, dict):
            continue

        for index, view in enumerate(lovelace_config.get("views", [])):
            if not isinstance(view, dict):
                continue
            raw_view_path = view.get("path")
            view_path = (
                str(raw_view_path).strip("/")
                if raw_view_path is not None and str(raw_view_path).strip("/")
                else str(index)
            )
            path = f"/{dashboard_path}/{view_path}"
            view_title = str(view.get("title") or view_path)
            if path not in known_paths:
                options.append(
                    {
                        "value": path,
                        "label": (
                            f"{category_user} › {dashboard_title} › {view_title}"
                        ),
                    }
                )
                known_paths.add(path)

    for path in selected:
        if path not in known_paths:
            options.append({"value": path, "label": path})

    return options


def _config_schema(
    values: dict[str, Any],
    view_options: list[dict[str, str]],
    language: str,
) -> vol.Schema:
    """Build the configuration form schema with current defaults."""
    is_german = language.lower().startswith("de")
    schedule_labels = {
        SCHEDULE_MODE_BLACK: (
            "Auf Schwarz überblenden" if is_german else "Fade to black"
        ),
        SCHEDULE_MODE_STATIC: (
            "Ein statisches Panel anzeigen"
            if is_german
            else "Show one static panel"
        ),
        SCHEDULE_MODE_DISABLED: (
            "Keinen Screensaver anzeigen"
            if is_german
            else "Do not show the screensaver"
        ),
    }
    return vol.Schema(
        {
            vol.Required(
                CONF_ENABLED, default=values[CONF_ENABLED]
            ): selector.BooleanSelector(),
            vol.Required(
                CONF_VIEWS, default=values[CONF_VIEWS]
            ): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=view_options,
                    multiple=True,
                    mode=selector.SelectSelectorMode.DROPDOWN,
                    sort=False,
                )
            ),
            vol.Required(
                CONF_CARDS, default=values[CONF_CARDS]
            ): selector.ObjectSelector(
                selector.ObjectSelectorConfig(
                    multiple=True,
                    label_field="name",
                    fields={
                        "name": {
                            "label": "Name",
                            "selector": selector.TextSelector(),
                        },
                        "card": {
                            "label": "Dashboard-Kartenkonfiguration",
                            "required": True,
                            "selector": selector.ObjectSelector(),
                        },
                    },
                )
            ),
            vol.Required(
                CONF_COLORS, default=values[CONF_COLORS]
            ): selector.ObjectSelector(
                selector.ObjectSelectorConfig(
                    multiple=True,
                    label_field="color",
                    fields={
                        "color": {
                            "label": "Farbe",
                            "required": True,
                            "selector": selector.TextSelector(
                                selector.TextSelectorConfig(
                                    type=selector.TextSelectorType.COLOR
                                )
                            ),
                        },
                    },
                )
            ),
            vol.Required(
                CONF_PANEL_ORDER,
                default=json.dumps(values[CONF_PANEL_ORDER], ensure_ascii=False),
            ): selector.TextSelector(),
            vol.Required(
                CONF_IDLE_TIME, default=values[CONF_IDLE_TIME]
            ): _number_selector(1, 86400, 1),
            vol.Required(
                CONF_DISPLAY_TIME, default=values[CONF_DISPLAY_TIME]
            ): _number_selector(1, 86400, 1),
            vol.Required(
                CONF_TRANSITION_TIME, default=values[CONF_TRANSITION_TIME]
            ): _number_selector(0, 60, 0.1),
            vol.Required(
                CONF_SHUFFLE, default=values[CONF_SHUFFLE]
            ): selector.BooleanSelector(),
            vol.Required(
                CONF_SHOW_PROGRESS, default=values[CONF_SHOW_PROGRESS]
            ): selector.BooleanSelector(),
            vol.Required(
                CONF_HIDE_CURSOR, default=values[CONF_HIDE_CURSOR]
            ): selector.BooleanSelector(),
            vol.Required(
                CONF_SCHEDULE_ENABLED, default=values[CONF_SCHEDULE_ENABLED]
            ): selector.BooleanSelector(),
            vol.Required(
                CONF_SCHEDULE_START, default=values[CONF_SCHEDULE_START]
            ): selector.TimeSelector(),
            vol.Required(
                CONF_SCHEDULE_END, default=values[CONF_SCHEDULE_END]
            ): selector.TimeSelector(),
            vol.Required(
                CONF_SCHEDULE_MODE, default=values[CONF_SCHEDULE_MODE]
            ): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=[
                        {
                            "value": SCHEDULE_MODE_BLACK,
                            "label": schedule_labels[SCHEDULE_MODE_BLACK],
                        },
                        {
                            "value": SCHEDULE_MODE_STATIC,
                            "label": schedule_labels[SCHEDULE_MODE_STATIC],
                        },
                        {
                            "value": SCHEDULE_MODE_DISABLED,
                            "label": schedule_labels[SCHEDULE_MODE_DISABLED],
                        },
                    ],
                    mode=selector.SelectSelectorMode.DROPDOWN,
                )
            ),
            vol.Required(
                CONF_SCHEDULE_PANEL, default=values[CONF_SCHEDULE_PANEL]
            ): selector.TextSelector(),
        }
    )


class HaWallpanelConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the integration setup flow."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Create the single integration entry."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        errors: dict[str, str] = {}
        values = deepcopy(DEFAULT_CONFIG)
        if user_input is not None:
            values.update(user_input)
            try:
                normalized = normalize_config(user_input)
            except ConfigValidationError as err:
                errors["base"] = err.code
            else:
                await self.async_set_unique_id(DOMAIN)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title=NAME, data=normalized)

        return self.async_show_form(
            step_id="user",
            data_schema=_config_schema(
                values,
                await _view_options(self.hass, values[CONF_VIEWS]),
                self.hass.config.language,
            ),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        """Return the options flow."""
        return HaWallpanelOptionsFlow()


class HaWallpanelOptionsFlow(OptionsFlow):
    """Edit screensaver behavior after setup."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Show and process the options form."""
        # ConfigEntry exposes immutable mappingproxy objects on current HA.
        # Convert the outer mappings before copying their nested values.
        stored = deepcopy(dict(self.config_entry.data))
        stored.update(deepcopy(dict(self.config_entry.options)))
        try:
            values = normalize_config(stored, require_panels=False)
        except ConfigValidationError:
            values = deepcopy(DEFAULT_CONFIG)
            values.update(stored)
        errors: dict[str, str] = {}

        if user_input is not None:
            values.update(user_input)
            try:
                normalized = normalize_config(user_input)
            except ConfigValidationError as err:
                errors["base"] = err.code
            else:
                return self.async_create_entry(data=normalized)

        return self.async_show_form(
            step_id="init",
            data_schema=_config_schema(
                values,
                await _view_options(self.hass, values[CONF_VIEWS]),
                self.hass.config.language,
            ),
            errors=errors,
        )

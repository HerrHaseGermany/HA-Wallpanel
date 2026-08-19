"""Unit tests for backend configuration validation without HA dependencies."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
COMPONENT = ROOT / "custom_components" / "ha_wallpanel"
PACKAGE = "custom_components.ha_wallpanel"

package = types.ModuleType(PACKAGE)
package.__path__ = [str(COMPONENT)]
sys.modules[PACKAGE] = package


def load_module(name: str, filename: str):
    """Load a component module while bypassing Home Assistant imports."""
    spec = importlib.util.spec_from_file_location(f"{PACKAGE}.{name}", COMPONENT / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


load_module("const", "const.py")
config = load_module("config", "config.py")


class NormalizeConfigTest(unittest.TestCase):
    """Validate persisted integration options."""

    def test_normalizes_numbers_and_ignores_legacy_dashboard_paths(self) -> None:
        normalized = config.normalize_config(
            {
                "dashboard_paths": ["dashboard-1/", "/dashboard-1"],
                "idle_time": "10",
                "display_time": 5,
                "transition_time": 1,
                "cards": [{"type": "markdown", "content": "Test"}],
            }
        )
        self.assertEqual(normalized["idle_time"], 10)
        self.assertFalse(normalized["show_progress"])
        self.assertNotIn("dashboard_paths", normalized)

    def test_rejects_invalid_card(self) -> None:
        with self.assertRaisesRegex(config.ConfigValidationError, "Card 1"):
            config.normalize_config({"cards": [{"entity": "sun.sun"}]})

    def test_rejects_long_transition(self) -> None:
        with self.assertRaises(config.ConfigValidationError) as context:
            config.normalize_config(
                {
                    "display_time": 2,
                    "transition_time": 3,
                    "cards": [{"type": "clock"}],
                }
            )
        self.assertEqual(context.exception.code, "invalid_transition")

    def test_legacy_dashboard_path_is_not_persisted(self) -> None:
        normalized = config.normalize_config(
            {
                "dashboard_paths": ["/dashboard-1", "*"],
                "dashboards": ["/map"],
                "cards": [{"type": "clock"}],
            }
        )
        self.assertNotIn("dashboard_paths", normalized)
        self.assertNotIn("dashboards", normalized)
        self.assertEqual(normalized["views"], [])

    def test_allows_view_panels_without_cards(self) -> None:
        normalized = config.normalize_config(
            {
                "views": ["dashboard-1/grundriss", "/lovelace/0"],
                "cards": [],
            }
        )
        self.assertEqual(
            normalized["views"], ["/dashboard-1/grundriss", "/lovelace/0"]
        )

    def test_migrates_legacy_cards_to_named_card_panels(self) -> None:
        normalized = config.normalize_config({"cards": [{"type": "clock"}]})
        self.assertEqual(
            normalized["cards"],
            [{"name": "Karte 1", "card": {"type": "clock"}}],
        )

    def test_migrates_complete_panel_view_to_its_single_card(self) -> None:
        normalized = config.normalize_config(
            {
                "cards": [
                    {
                        "type": "panel",
                        "path": "",
                        "background": {"opacity": 0},
                        "cards": [
                            {
                                "type": "custom:wall-clock-card",
                                "widgets": [{"type": "clock", "id": "clock"}],
                            }
                        ],
                    }
                ]
            }
        )
        self.assertEqual(
            normalized["cards"],
            [
                {
                    "name": "Karte 1",
                    "card": {
                        "type": "custom:wall-clock-card",
                        "widgets": [{"type": "clock", "id": "clock"}],
                    },
                }
            ],
        )

    def test_allows_fullscreen_color_panels(self) -> None:
        normalized = config.normalize_config(
            {
                "views": [],
                "cards": [],
                "colors": [{"name": "Schwarz", "color": [0, 0, 0]}],
            }
        )
        self.assertEqual(
            normalized["colors"],
            [{"color": "#000000"}],
        )

    def test_keeps_hex_color_values_visible(self) -> None:
        normalized = config.normalize_config(
            {
                "views": [],
                "cards": [],
                "colors": [{"color": "#0c2238"}],
            }
        )
        self.assertEqual(normalized["colors"], [{"color": "#0C2238"}])

    def test_keeps_combined_panel_order_and_shuffle(self) -> None:
        normalized = config.normalize_config(
            {
                "views": ["/dashboard/one"],
                "cards": [{"name": "Uhr", "card": {"type": "clock"}}],
                "colors": [{"color": "#000000"}],
                "panel_order": '["color:0", "card:0", "view:/dashboard/one"]',
                "shuffle": True,
            }
        )
        self.assertEqual(
            normalized["panel_order"],
            ["color:0", "card:0", "view:/dashboard/one"],
        )
        self.assertTrue(normalized["shuffle"])

    def test_normalizes_daily_schedule(self) -> None:
        normalized = config.normalize_config(
            {
                "views": ["/dashboard/one"],
                "colors": [{"color": "#000000"}],
                "panel_order": ["view:/dashboard/one", "color:0"],
                "schedule_enabled": True,
                "schedule_start": "22:00:00",
                "schedule_end": "06:00",
                "schedule_mode": "static",
                "schedule_panel": "color:0",
            }
        )
        self.assertEqual(normalized["schedule_start"], "22:00")
        self.assertEqual(normalized["schedule_end"], "06:00")
        self.assertEqual(normalized["schedule_mode"], "static")
        self.assertEqual(normalized["schedule_panel"], "color:0")

    def test_rejects_equal_schedule_times_when_enabled(self) -> None:
        with self.assertRaises(config.ConfigValidationError) as context:
            config.normalize_config(
                {
                    "views": ["/dashboard/one"],
                    "schedule_enabled": True,
                    "schedule_start": "06:00",
                    "schedule_end": "06:00",
                }
            )
        self.assertEqual(context.exception.code, "invalid_schedule")

    def test_removes_legacy_dummy_cards(self) -> None:
        normalized = config.normalize_config(
            {
                "views": ["/home"],
                "cards": [
                    {
                        "type": "markdown",
                        "content": "# HA-Wallpanel\nDer Bildschirmschoner funktioniert.",
                    }
                ],
            }
        )
        self.assertEqual(normalized["cards"], [])

    def test_allows_empty_runtime_config_during_migration(self) -> None:
        normalized = config.normalize_config({}, require_panels=False)
        self.assertEqual(normalized["views"], [])
        self.assertEqual(normalized["cards"], [])
        self.assertEqual(normalized["colors"], [])

    def test_rejects_configuration_without_panels(self) -> None:
        with self.assertRaises(config.ConfigValidationError) as context:
            config.normalize_config({"views": [], "cards": [], "colors": []})
        self.assertEqual(context.exception.code, "invalid_panels")


if __name__ == "__main__":
    unittest.main()

import assert from "node:assert/strict";
import test from "node:test";

globalThis.__HA_WALLPANEL_DISABLE_AUTO_START__ = true;

const {
  DEFAULT_CONFIG,
  KioskModeController,
  ScreensaverController,
  WallpanelSettingsController,
  VERSION,
  hasEmbeddedParameter,
  hasKioskParameter,
  isMinuteInDailyRange,
  normalizeConfig,
} = await import("../custom_components/ha_wallpanel/frontend/ha-wallpanel.js");

test("build injects the package version", () => {
  assert.equal(VERSION, "0.7.13");
});

test("normalizes an integration configuration with defaults", () => {
  const config = normalizeConfig({
    configured: true,
    enabled: true,
    dashboard_paths: ["/legacy-path"],
    cards: [{ type: "clock" }],
  });

  assert.equal(config.idle_time, DEFAULT_CONFIG.idle_time);
  assert.equal(config.display_time, DEFAULT_CONFIG.display_time);
  assert.equal(config.transition_time, DEFAULT_CONFIG.transition_time);
  assert.equal(config.show_progress, false);
  assert.equal(config.schedule_enabled, false);
  assert.equal(config.schedule_start, "22:00");
  assert.equal(config.schedule_end, "06:00");
  assert.equal(config.schedule_mode, "black");
  assert.equal(config.enabled, true);
  assert.equal(config.cards.length, 1);
  assert.deepEqual(config.cards[0], {
    name: "Karte 1",
    card: { type: "clock" },
  });
  assert.equal(config.panels.length, 1);
  assert.equal("dashboard_paths" in config, false);
});

test("accepts numeric strings from serialized configuration", () => {
  const config = normalizeConfig({
    configured: true,
    enabled: true,
    idle_time: "30",
    display_time: "10",
    transition_time: "0.75",
    cards: [{ type: "markdown", content: "Test" }],
  });

  assert.equal(config.idle_time, 30);
  assert.equal(config.display_time, 10);
  assert.equal(config.transition_time, 0.75);
});

test("migrates a complete panel view to its single dashboard card", () => {
  const config = normalizeConfig({
    configured: true,
    cards: [
      {
        type: "panel",
        path: "",
        background: { opacity: 0 },
        cards: [
          {
            type: "custom:wall-clock-card",
            widgets: [{ type: "clock", id: "clock" }],
          },
        ],
      },
    ],
  });

  assert.deepEqual(config.cards, [
    {
      name: "Karte 1",
      card: {
        type: "custom:wall-clock-card",
        widgets: [{ type: "clock", id: "clock" }],
      },
    },
  ]);
});

test("keeps an unconfigured frontend instance disabled", () => {
  const config = normalizeConfig({ configured: false, enabled: true });
  assert.equal(config.enabled, false);
  assert.deepEqual(config.cards, []);
});

test("periodic hass updates do not restart the inactivity timer", () => {
  const controller = new ScreensaverController();
  let armed = 0;
  controller._armIdleTimer = () => {
    armed += 1;
  };

  controller.setHass({ states: {} });
  controller.setHass({ states: { "sensor.test": { state: "on" } } });
  controller.setHass({ states: { "sensor.test": { state: "off" } } });

  assert.equal(armed, 1);
});

test("screensaver eligibility requires kiosk mode", () => {
  const controller = new ScreensaverController();
  controller._connected = true;
  controller._hass = { states: {} };
  controller._config = {
    ...DEFAULT_CONFIG,
    configured: true,
    enabled: true,
    cards: [{ type: "markdown", content: "Test" }],
  };

  globalThis.location = {
    pathname: "/dashboard-1/0",
    search: "",
  };
  assert.equal(controller._isEligible(), false);

  globalThis.location.search = "?kiosk";
  assert.equal(controller._isEligible(), true);

  globalThis.location.search = "?kiosk&ha-wallpanel-embedded=1";
  assert.equal(controller._isEligible(), false);

  delete globalThis.location;
});

test("rejects missing screensaver panels after setup", () => {
  assert.throws(
    () => normalizeConfig({ configured: true, views: [], cards: [], colors: [] }),
    /Mindestens eine Ansicht, Karte oder Vollbildfarbe/,
  );
});

test("builds fullscreen view, card, and color panels", () => {
  const config = normalizeConfig({
    configured: true,
    enabled: true,
    views: ["dashboard-1/grundriss", "/lovelace/0"],
    cards: [{ name: "Uhr", card: { type: "clock" } }],
    colors: [{ color: [12, 34, 56] }, { color: "#000000" }],
  });

  assert.deepEqual(config.views, ["/dashboard-1/grundriss", "/lovelace/0"]);
  assert.deepEqual(config.panels, [
    { kind: "view", path: "/dashboard-1/grundriss" },
    { kind: "view", path: "/lovelace/0" },
    { kind: "card", name: "Uhr", card: { type: "clock" } },
    { kind: "color", color: "#0C2238" },
    { kind: "color", color: "#000000" },
  ]);
  assert.deepEqual(config.colors, [
    { color: "#0C2238" },
    { color: "#000000" },
  ]);
});

test("applies the shared panel order across all panel types", () => {
  const config = normalizeConfig({
    configured: true,
    enabled: true,
    views: ["/dashboard/one"],
    cards: [{ name: "Uhr", card: { type: "clock" } }],
    colors: [{ color: "#123456" }],
    panel_order: ["color:0", "view:/dashboard/one", "card:0"],
    shuffle: true,
  });

  assert.deepEqual(config.panels, [
    { kind: "color", color: "#123456" },
    { kind: "view", path: "/dashboard/one" },
    { kind: "card", name: "Uhr", card: { type: "clock" } },
  ]);
  assert.equal(config.shuffle, true);
});

test("shuffle selects a different next panel", () => {
  const controller = new ScreensaverController();
  controller._activePanels = [{}, {}, {}];
  controller._activeShuffle = true;
  controller._currentIndex = 1;

  assert.equal(controller._nextPanelIndex(() => 0), 0);
  assert.equal(controller._nextPanelIndex(() => 0.999), 2);
});

test("daily schedules support daytime and overnight ranges", () => {
  assert.equal(isMinuteInDailyRange(12 * 60, "09:00", "17:00"), true);
  assert.equal(isMinuteInDailyRange(17 * 60, "09:00", "17:00"), false);
  assert.equal(isMinuteInDailyRange(23 * 60, "22:00", "06:00"), true);
  assert.equal(isMinuteInDailyRange(5 * 60 + 59, "22:00", "06:00"), true);
  assert.equal(isMinuteInDailyRange(12 * 60, "22:00", "06:00"), false);
  assert.equal(isMinuteInDailyRange(12 * 60, "12:00", "12:00"), false);
});

test("scheduled playback can use black, static, or disabled mode", () => {
  const controller = new ScreensaverController();
  controller._hass = { config: { time_zone: "UTC" } };
  const base = normalizeConfig({
    configured: true,
    enabled: true,
    views: ["/dashboard/one"],
    colors: [{ color: "#123456" }],
    panel_order: ["view:/dashboard/one", "color:0"],
    schedule_enabled: true,
    schedule_start: "22:00",
    schedule_end: "06:00",
    schedule_panel: "color:0",
  });
  const duringSchedule = new Date("2026-08-19T23:00:00Z");
  const outsideSchedule = new Date("2026-08-19T12:00:00Z");

  controller._config = { ...base, schedule_mode: "black" };
  assert.deepEqual(controller._schedulePlayback(duringSchedule).panels, [
    { kind: "color", color: "#000000" },
  ]);

  controller._config = { ...base, schedule_mode: "static" };
  assert.deepEqual(controller._schedulePlayback(duringSchedule).panels, [
    { kind: "color", color: "#123456" },
  ]);

  controller._config = { ...base, schedule_mode: "disabled" };
  assert.equal(controller._schedulePlayback(duringSchedule).key, "disabled");
  assert.equal(controller._schedulePlayback(outsideSchedule).key, "normal");
});

test("schedule changes preserve an existing idle countdown", () => {
  const controller = new ScreensaverController();
  controller._hass = { config: { time_zone: "UTC" } };
  controller._config = normalizeConfig({
    configured: true,
    enabled: true,
    views: ["/dashboard/one"],
    schedule_enabled: true,
    schedule_start: "22:00",
    schedule_end: "06:00",
    schedule_mode: "black",
  });
  controller._scheduleStateKey = "normal";
  controller._idleTimer = 123;
  let rearmed = 0;
  controller._armIdleTimer = () => (rearmed += 1);

  controller.syncSchedule(new Date("2026-08-19T23:00:00Z"));

  assert.equal(controller._scheduleStateKey, "black");
  assert.equal(controller._idleTimer, 123);
  assert.equal(rearmed, 0);
});

test("rejects card entries without a type", () => {
  assert.throws(
    () => normalizeConfig({ configured: true, cards: [{ entity: "sun.sun" }] }),
    /benötigt einen Typ/,
  );
});

test("rejects transitions longer than the display time", () => {
  assert.throws(
    () =>
      normalizeConfig({
        configured: true,
        display_time: 2,
        transition_time: 3,
        cards: [{ type: "clock" }],
      }),
    /transition_time darf nicht größer/,
  );
});

test("mouse movement immediately dismisses an active screensaver", () => {
  const controller = new ScreensaverController();
  controller._active = true;
  let dismissed;
  controller._deactivate = (...args) => {
    dismissed = args;
  };

  controller._onWindowActivity({ type: "pointermove" });

  assert.deepEqual(dismissed, [true]);
});

test("global wheel activity tracking stays passive", () => {
  let wheelOptions;
  globalThis.window = {
    addEventListener: (name, _listener, options) => {
      if (name === "wheel") wheelOptions = options;
    },
    removeEventListener() {},
  };
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
  };

  try {
    const controller = new ScreensaverController();
    controller._addActivityListeners();
    assert.deepEqual(wheelOptions, { capture: true, passive: true });
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});

test("active screensaver delegates wheel cancellation to its overlay", () => {
  const controller = new ScreensaverController();
  controller._active = true;
  let deactivated = false;
  controller._deactivate = () => {
    deactivated = true;
  };

  controller._onWindowActivity({ type: "wheel" });
  assert.equal(deactivated, false);

  controller._overlayHost = { hidden: false };
  let prevented = false;
  controller._onOverlayInteraction({
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
  assert.equal(prevented, true);
  assert.equal(deactivated, true);
});

test("screensaver dismissal hides and clears the overlay synchronously", () => {
  const controller = new ScreensaverController();
  const removedClasses = [];
  const attributes = new Map();
  let cleared = false;
  let activeEvent;
  let rearmed = false;

  controller._active = true;
  controller._overlayHost = {
    hidden: false,
    classList: { remove: (value) => removedClasses.push(value) },
    setAttribute: (name, value) => attributes.set(name, value),
  };
  controller._surface = { replaceChildren: () => (cleared = true) };
  controller._clearRotationTimer = () => {};
  controller._clearTransitionTimers = () => {};
  controller._emitActiveChanged = (value) => (activeEvent = value);
  controller._armIdleTimer = () => (rearmed = true);

  controller._deactivate(true);

  assert.equal(controller._overlayHost.hidden, true);
  assert.deepEqual(removedClasses, ["visible"]);
  assert.equal(attributes.get("aria-hidden"), "true");
  assert.equal(cleared, true);
  assert.equal(activeEvent, false);
  assert.equal(rearmed, true);
});

test("hidden cursor is enforced through nested card shadow roots", () => {
  const cursorStyle = () => {
    let cursor;
    return {
      setProperty: (name, value, priority) => {
        if (name === "cursor") cursor = { value, priority };
      },
      get cursor() {
        return cursor;
      },
    };
  };
  const leaf = { style: cursorStyle() };
  const nestedShadow = { querySelectorAll: () => [leaf] };
  const nestedHost = { style: cursorStyle(), shadowRoot: nestedShadow };
  const overlayShadow = { querySelectorAll: () => [nestedHost] };
  const overlay = { style: cursorStyle(), shadowRoot: overlayShadow };
  const controller = new ScreensaverController();

  controller._applyHiddenCursor(overlay);

  assert.deepEqual(overlay.style.cursor, {
    value: "none",
    priority: "important",
  });
  assert.deepEqual(nestedHost.style.cursor, {
    value: "none",
    priority: "important",
  });
  assert.deepEqual(leaf.style.cursor, {
    value: "none",
    priority: "important",
  });
});

test("wallpanel settings force wheel scrolling inside the options dialog", () => {
  const styles = () => {
    const values = new Map();
    return {
      getPropertyValue: (name) => values.get(name)?.value || "",
      getPropertyPriority: (name) => values.get(name)?.priority || "",
      setProperty: (name, value, priority = "") =>
        values.set(name, { value, priority }),
      removeProperty: (name) => values.delete(name),
    };
  };
  let wheelListener;
  const body = {
    style: styles(),
    scrollTop: 0,
    clientHeight: 500,
    addEventListener: (_name, listener) => (wheelListener = listener),
    removeEventListener: () => {},
  };
  const dialog = { bodyContainer: body, style: styles() };
  const controller = new WallpanelSettingsController();
  controller._enableDialogScroll(dialog);
  let prevented = false;

  wheelListener({
    defaultPrevented: false,
    ctrlKey: false,
    deltaX: 0,
    deltaY: 120,
    deltaMode: 0,
    preventDefault: () => (prevented = true),
    stopPropagation: () => {},
  });

  assert.equal(body.scrollTop, 120);
  assert.equal(prevented, true);
  assert.equal(body.style.getPropertyValue("overflow-y"), "auto");
  assert.equal(
    dialog.style.getPropertyValue("--ha-dialog-max-height"),
    "calc(100dvh - 24px)",
  );
});

test("wallpanel settings recognize options flows whose handler is an entry id", () => {
  const controller = new WallpanelSettingsController();
  const names = [
    "enabled",
    "views",
    "cards",
    "colors",
    "panel_order",
    "schedule_enabled",
    "schedule_start",
    "schedule_end",
    "schedule_mode",
    "schedule_panel",
    "idle_time",
    "display_time",
    "transition_time",
    "shuffle",
    "show_progress",
    "hide_cursor",
  ];

  assert.equal(
    controller._isWallpanelFlow({
      _handler: "01JEXAMPLECONFIGENTRYID",
      _step: { data_schema: names.map((name) => ({ name })) },
    }),
    true,
  );
});

test("combined editor canonicalizes and reorders panel tokens", () => {
  const controller = new WallpanelSettingsController();
  const order = controller._canonicalPanelOrder(
    '["color:0","missing:0","color:0"]',
    ["/dashboard/one"],
    [{ name: "Uhr", card: { type: "clock" } }],
    [{ color: "#000000" }],
  );
  assert.deepEqual(order, ["color:0", "view:/dashboard/one", "card:0"]);

  let changed;
  const editor = {
    _wallpanelState: {
      order,
      orderField: { dispatchEvent: (event) => (changed = event.detail.value) },
    },
  };
  controller._renderPanelEditor = () => {};
  controller._movePanel(editor, 2, 0);
  assert.equal(changed, '["card:0","color:0","view:/dashboard/one"]');
});

test("successful settings flow closes without a confirmation step", () => {
  const controller = new WallpanelSettingsController();
  let flowClosed = 0;
  const flow = {
    closeDialog: () => (flowClosed += 1),
  };

  controller._closeSettingsFlow(flow);

  assert.equal(flowClosed, 1);
});

test("native card browser result is appended to the cards selector", () => {
  const controller = new WallpanelSettingsController();
  let event;
  const selector = {
    value: [{ name: "Vorhanden", card: { type: "tile" } }],
    hass: {
      localize: (key) =>
        key === "ui.panel.lovelace.editor.card.clock.name" ? "Uhr" : undefined,
    },
    dispatchEvent: (value) => (event = value),
  };

  controller._appendCard(selector, { type: "clock" });

  assert.equal(event.type, "value-changed");
  assert.deepEqual(event.detail.value, [
    { name: "Vorhanden", card: { type: "tile" } },
    { name: "Uhr", card: { type: "clock" } },
  ]);
});

test("native card browser unwraps a complete panel view", () => {
  const controller = new WallpanelSettingsController();
  let event;
  const selector = {
    value: [],
    hass: { localize: () => undefined },
    dispatchEvent: (value) => (event = value),
  };

  controller._appendCard(selector, {
    type: "panel",
    cards: [{ type: "custom:wall-clock-card" }],
  });

  assert.deepEqual(event.detail.value, [
    {
      name: "wall-clock-card",
      card: { type: "custom:wall-clock-card" },
    },
  ]);
});

test("dashboard cards receive Home Assistant's panel layout context", async () => {
  const originalDocument = globalThis.document;
  const originalCustomElements = globalThis.customElements;
  const styleValues = new Map();
  let loaded = 0;
  const wrapper = {
    style: {
      setProperty: (name, value) => styleValues.set(name, value),
    },
    load: () => (loaded += 1),
  };
  globalThis.document = {
    createElement: (name) => {
      assert.equal(name, "hui-card");
      return wrapper;
    },
  };
  globalThis.customElements = {
    get: (name) => (name === "hui-card" ? class {} : undefined),
  };

  try {
    const controller = new ScreensaverController();
    const card = await controller._instantiateCard({ type: "clock" });

    assert.equal(card, wrapper);
    assert.deepEqual(wrapper.config, { type: "clock" });
    assert.equal(wrapper.layout, "panel");
    assert.equal(wrapper.isPanel, true);
    assert.equal(wrapper.preview, false);
    assert.equal(wrapper.editMode, false);
    assert.equal(loaded, 1);
    assert.equal(styleValues.get("height"), "100%");
    assert.equal(styleValues.get("--ha-card-border-width"), "0");
    assert.equal(styleValues.get("--ha-card-box-shadow"), "none");
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalCustomElements === undefined) delete globalThis.customElements;
    else globalThis.customElements = originalCustomElements;
  }
});

test("native Lovelace module is loaded through Home Assistant's panel loader", async () => {
  const originalDocument = globalThis.document;
  const originalCustomElements = globalThis.customElements;
  let loaded = false;
  const registry = new Map();
  const resolver = {
    routerOptions: {
      routes: {
        "mein-dashboard": {
          load: async () => {
            loaded = true;
            registry.set("hui-view", class {});
          },
        },
      },
    },
  };
  globalThis.document = {
    querySelectorAll: (selector) =>
      selector === "partial-panel-resolver" ? [resolver] : [],
  };
  globalThis.customElements = {
    get: (name) => registry.get(name),
  };

  try {
    const controller = new WallpanelSettingsController();
    await controller._ensureLovelaceModule({
      panels: {
        "mein-dashboard": {
          component_name: "lovelace",
          url_path: "mein-dashboard",
        },
      },
    });
    assert.equal(loaded, true);
    assert.equal(Boolean(registry.get("hui-view")), true);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalCustomElements === undefined) delete globalThis.customElements;
    else globalThis.customElements = originalCustomElements;
  }
});

test("card browser preloads translations and Lovelace resources", async () => {
  const controller = new WallpanelSettingsController();
  const calls = [];
  controller._ensureLovelaceModule = async () => calls.push("module");
  controller._loadLovelaceResource = async (resource) =>
    calls.push(`resource:${resource.url}`);
  const hass = {
    loadFragmentTranslation: async (fragment) =>
      calls.push(`translation:${fragment}`),
    connection: {
      sendMessagePromise: async (message) => {
        assert.deepEqual(message, { type: "lovelace/resources" });
        return [
          { type: "module", url: "/hacsfiles/clock/clock.js" },
          { type: "module", url: "/hacsfiles/button/button.js" },
        ];
      },
    },
  };

  await controller._prepareCardBrowserContext(hass);

  assert.deepEqual(calls, [
    "module",
    "translation:lovelace",
    "resource:/hacsfiles/clock/clock.js",
    "resource:/hacsfiles/button/button.js",
  ]);
});

test("card browser supplies readable fallback titles", () => {
  const controller = new WallpanelSettingsController();
  const hass = {
    localize: (key) =>
      key === "ui.panel.lovelace.editor.card.clock.name" ? "Uhr" : undefined,
  };
  const browserHass = controller._createCardBrowserHass(hass);

  assert.equal(
    browserHass.localize("ui.panel.lovelace.editor.card.clock.name"),
    "Uhr",
  );
  assert.equal(
    browserHass.localize("ui.panel.lovelace.editor.card.weather-forecast.name"),
    "Weather Forecast",
  );
  assert.equal(
    browserHass.localize("ui.panel.lovelace.editor.card.generic.manual"),
    "Manuelle Karte",
  );
});

test("visual card editor replaces the stored card configuration", () => {
  const controller = new WallpanelSettingsController();
  let changed;
  const editor = {
    _wallpanelRenderKey: "old",
    _wallpanelState: {
      cards: [{ name: "Uhr", card: { type: "clock" } }],
      cardSelector: {
        hass: { localize: () => "Wettervorhersage" },
        dispatchEvent: (event) => (changed = event),
      },
    },
  };
  controller._renderPanelEditor = () => {};

  controller._replaceEditedCard(editor, 0, {
    type: "weather-forecast",
    entity: "weather.home",
  });

  assert.equal(changed.type, "value-changed");
  assert.deepEqual(changed.detail.value, [
    {
      name: "Wettervorhersage",
      card: { type: "weather-forecast", entity: "weather.home" },
    },
  ]);
  assert.equal(editor._wallpanelRenderKey, undefined);
});

test("dashboard designer is offered only for explicitly compatible cards", () => {
  const controller = new WallpanelSettingsController();

  assert.deepEqual(
    controller._dashboardDesignerAdapter({ type: "custom:wall-clock-card" }),
    { elementName: "wall-clock-card" },
  );
  assert.equal(
    controller._dashboardDesignerAdapter({ type: "custom:button-card" }),
    undefined,
  );
  assert.equal(controller._dashboardDesignerAdapter({ type: "clock" }), undefined);
});

test("native card launcher is mounted inside Home Assistant's event tree", () => {
  const originalDocument = globalThis.document;
  const shadowRoot = {};
  const homeAssistant = { shadowRoot };
  globalThis.document = {
    body: {},
    querySelector: (selector) =>
      selector === "home-assistant" ? homeAssistant : undefined,
  };

  try {
    const controller = new WallpanelSettingsController();
    assert.equal(controller._getDialogMountRoot(), shadowRoot);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test("saved colors receive a visible preview swatch", () => {
  const originalDocument = globalThis.document;
  let swatch;
  const headline = {
    style: {},
    querySelector: () => swatch,
    prepend: (element) => (swatch = element),
  };
  const item = {
    querySelector: (selector) =>
      selector === '[slot="headline"]' ? headline : undefined,
  };
  globalThis.document = {
    createElement: () => ({
      style: {},
      setAttribute: () => {},
    }),
  };

  try {
    const controller = new WallpanelSettingsController();
    controller._enhanceColorPreviews({
      value: [{ color: "#000000" }],
      shadowRoot: { querySelectorAll: () => [item] },
    });
    assert.equal(swatch.style.backgroundColor, "#000000");
    assert.equal(swatch.style.width, "22px");
    assert.equal(headline.style.display, "flex");
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test("new color dialog seeds black as an explicit valid value", () => {
  const originalWindow = globalThis.window;
  let showDialogListener;
  let removedListener;
  const dialogEvent = {
    detail: {
      dialogTag: "dialog-form",
      dialogParams: {
        schema: [{ name: "color" }],
        data: {},
      },
    },
  };
  globalThis.window = {
    addEventListener: (name, listener) => {
      if (name === "show-dialog") showDialogListener = listener;
    },
    removeEventListener: (name, listener) => {
      if (name === "show-dialog") removedListener = listener;
    },
  };
  const selector = {
    shadowRoot: {
      querySelector: () => ({
        click: () => showDialogListener(dialogEvent),
      }),
    },
  };

  try {
    const controller = new WallpanelSettingsController();
    controller._openColorAddDialog(selector);

    assert.deepEqual(dialogEvent.detail.dialogParams.data, {
      color: "#000000",
    });
    assert.equal(removedListener, showDialogListener);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("time fields are compacted into one row on wide dialogs", () => {
  const style = () => {
    const values = new Map();
    return {
      setProperty: (name, value) => values.set(name, value),
      removeProperty: (name) => values.delete(name),
      getPropertyValue: (name) => values.get(name) || "",
    };
  };
  const fields = [
    "enabled",
    "schedule_start",
    "schedule_end",
    "idle_time",
    "display_time",
    "transition_time",
    "show_progress",
  ].map((name) => ({ name, style: style() }));
  const root = { children: fields, clientWidth: 800, style: style() };
  const form = { shadowRoot: { querySelector: () => root } };
  const flow = {
    shadowRoot: {
      querySelectorAll: (selector) => (selector === "ha-form" ? [form] : []),
    },
  };

  const controller = new WallpanelSettingsController();
  controller._compactTimeFields(flow);

  assert.equal(root.style.getPropertyValue("display"), "grid");
  assert.equal(fields[1].style.getPropertyValue("grid-column"), "1 / 4");
  assert.equal(fields[2].style.getPropertyValue("grid-column"), "4 / 7");
  assert.equal(fields[3].style.getPropertyValue("grid-column"), "1 / 3");
  assert.equal(fields[4].style.getPropertyValue("grid-column"), "3 / 5");
  assert.equal(fields[5].style.getPropertyValue("grid-column"), "5 / 7");
});

test("static schedule panel picker is visible only in static mode", () => {
  const controller = new WallpanelSettingsController();
  const styles = new Map();
  const picker = {
    hidden: false,
    style: {
      setProperty: (name, value, priority) =>
        styles.set(name, { value, priority }),
    },
  };

  controller._setSchedulePanelVisibility(picker, "black");
  assert.equal(picker.hidden, true);
  assert.deepEqual(styles.get("display"), {
    value: "none",
    priority: "important",
  });

  controller._setSchedulePanelVisibility(picker, "static");
  assert.equal(picker.hidden, false);
  assert.deepEqual(styles.get("display"), {
    value: "block",
    priority: "important",
  });
});

test("enables kiosk mode by URL parameter presence", () => {
  assert.equal(hasKioskParameter("?kiosk"), true);
  assert.equal(hasKioskParameter("?kiosk="), true);
  assert.equal(hasKioskParameter("?theme=dark&kiosk"), true);
  assert.equal(hasKioskParameter("?theme=kiosk"), false);
  assert.equal(hasKioskParameter(""), false);
});

test("kiosk mode hides WebKit scrollbars without disabling scrolling", () => {
  const appended = [];
  let removed = false;
  const shadowRoot = {
    appendChild: (node) => appended.push(node),
  };
  globalThis.document = {
    createElement: () => ({
      setAttribute() {},
      textContent: "",
      remove: () => {
        removed = true;
      },
    }),
  };

  try {
    const kiosk = new KioskModeController();
    assert.equal(kiosk._hideScrollbars([shadowRoot]), true);
    assert.equal(kiosk._hideScrollbars([shadowRoot]), false);
    assert.equal(appended.length, 1);
    assert.match(appended[0].textContent, /\*::\-webkit-scrollbar/);
    assert.match(appended[0].textContent, /scrollbar-width: none/);
    assert.doesNotMatch(appended[0].textContent, /overflow:\s*hidden/);

    assert.equal(kiosk._hideScrollbars([]), true);
    assert.equal(removed, true);
    assert.equal(kiosk._scrollbarStyles.size, 0);
  } finally {
    delete globalThis.document;
  }
});

test("detects embedded dashboard panels", () => {
  assert.equal(hasEmbeddedParameter("?kiosk&ha-wallpanel-embedded=1"), true);
  assert.equal(hasEmbeddedParameter("?kiosk"), false);
});

test("keeps the embedded marker when a dashboard redirect drops its query", () => {
  const location = {
    href: "http://homeassistant.local/dashboard-1?kiosk&ha-wallpanel-embedded=1",
    pathname: "/dashboard-1",
    search: "?kiosk&ha-wallpanel-embedded=1",
    hash: "",
  };
  let replacedUrl;
  globalThis.location = location;
  globalThis.document = { querySelector: () => undefined };
  globalThis.window = {
    location,
    history: {
      state: null,
      replaceState: (_state, _title, url) => {
        replacedUrl = url;
      },
    },
  };

  try {
    const kiosk = new KioskModeController();
    location.search = "";
    kiosk.sync();
    assert.equal(
      replacedUrl,
      "/dashboard-1?kiosk&ha-wallpanel-embedded=1",
    );
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.location;
  }
});

test("kiosk mode hides and restores the Home Assistant chrome", () => {
  class FakeStyle {
    constructor(initial = {}) {
      this.values = new Map(Object.entries(initial));
      this.priorities = new Map();
    }

    getPropertyValue(property) {
      return this.values.get(property) || "";
    }

    getPropertyPriority(property) {
      return this.priorities.get(property) || "";
    }

    setProperty(property, value, priority = "") {
      this.values.set(property, value);
      this.priorities.set(property, priority);
    }

    removeProperty(property) {
      this.values.delete(property);
      this.priorities.delete(property);
    }
  }

  const element = (initial) => ({ style: new FakeStyle(initial) });
  const main = element({ "--ha-sidebar-width": "260px" });
  const sidebar = element();
  const menuButton = element();
  const toolbar = element();
  const view = element();
  const huiRoot = {
    shadowRoot: {
      querySelector(selector) {
        return {
          "ha-menu-button": menuButton,
          "app-toolbar": toolbar,
          "#view": view,
        }[selector];
      },
    },
  };
  const lovelace = {
    shadowRoot: {
      querySelector: (selector) => (selector === "hui-root" ? huiRoot : undefined),
    },
  };
  const drawer = {
    shadowRoot: {
      querySelector: (selector) =>
        selector === ".sidebar-shell" ? sidebar : undefined,
    },
  };
  main.shadowRoot = {
    querySelector(selector) {
      return { "ha-drawer": drawer, "ha-panel-lovelace": lovelace }[selector];
    },
  };
  const homeAssistant = {
    shadowRoot: {
      querySelector: (selector) =>
        selector === "home-assistant-main" ? main : undefined,
    },
  };

  const attributes = new Map();
  const body = {
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  };
  const location = {
    href: "http://homeassistant.local/dashboard-1?kiosk",
    pathname: "/dashboard-1",
    search: "?kiosk",
    hash: "",
  };
  let replacedUrl;
  globalThis.location = location;
  globalThis.document = {
    body,
    querySelector: () => homeAssistant,
  };
  globalThis.window = {
    location,
    history: {
      state: null,
      replaceState: (_state, _title, url) => {
        replacedUrl = url;
      },
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };

  try {
    const kiosk = new KioskModeController();
    kiosk.connect();

    assert.equal(main.style.getPropertyValue("--ha-sidebar-width"), "env(safe-area-inset-left)");
    assert.equal(sidebar.style.getPropertyValue("opacity"), "0");
    assert.equal(toolbar.style.getPropertyValue("display"), "none");
    assert.equal(view.style.getPropertyValue("min-height"), "100vh");
    assert.equal(attributes.get("data-ha-wallpanel-kiosk"), "true");

    kiosk.disable();

    assert.equal(main.style.getPropertyValue("--ha-sidebar-width"), "260px");
    assert.equal(sidebar.style.getPropertyValue("opacity"), "");
    assert.equal(toolbar.style.getPropertyValue("display"), "");
    assert.equal(attributes.has("data-ha-wallpanel-kiosk"), false);
    assert.equal(replacedUrl, "/dashboard-1");
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.location;
  }
});

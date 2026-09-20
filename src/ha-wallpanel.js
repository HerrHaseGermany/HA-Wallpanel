export const VERSION = "__PACKAGE_VERSION__";

const EVENT_NAME = "ha-wallpanel-screensaver-active-changed";
const WS_TYPE_SUBSCRIBE = "ha_wallpanel/subscribe";
const DOMAIN = "ha_wallpanel";
const KIOSK_SCROLLBAR_STYLE_ATTRIBUTE = "data-ha-wallpanel-scrollbars";
const SCREENSAVER_SCROLL_LOCK_STYLE_ATTRIBUTE =
  "data-ha-wallpanel-screensaver-scroll-lock";
const DASHBOARD_PANEL_COMPONENTS = new Set([
  "lovelace",
  "home",
  "light",
  "security",
  "climate",
  "energy",
  "maintenance",
]);

// Home Assistant does not currently expose a capability flag for cards whose
// visual designer lives directly in dashboard edit mode. Keep the compatibility
// list explicit so cards without that contract never receive a misleading
// Designer button.
const DASHBOARD_DESIGNER_ADAPTERS = Object.freeze({
  "custom:wall-clock-card": Object.freeze({
    elementName: "wall-clock-card",
  }),
});

function findElementsDeep(root, selector, matches = []) {
  if (!root?.querySelectorAll) return matches;

  for (const element of root.querySelectorAll(selector)) {
    if (!matches.includes(element)) matches.push(element);
  }
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot) findElementsDeep(element.shadowRoot, selector, matches);
  }
  return matches;
}

function waitFor(check, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const result = check();
      if (result) {
        resolve(result);
        return;
      }
      if (Date.now() - started >= timeout) {
        reject(new Error("Zeitüberschreitung beim Laden der Home-Assistant-Oberfläche."));
        return;
      }
      window.setTimeout(poll, 40);
    };
    poll();
  });
}

export const DEFAULT_CONFIG = Object.freeze({
  configured: false,
  enabled: false,
  views: [],
  idle_time: 60,
  display_time: 15,
  transition_time: 1.5,
  colors: [],
  panel_order: [],
  shuffle: false,
  schedule_enabled: false,
  schedule_start: "22:00",
  schedule_end: "06:00",
  schedule_mode: "black",
  schedule_panel: "",
  dashboard_brightness: 100,
  screensaver_brightness: 100,
  brightness_schedule_enabled: false,
  brightness_schedule_start: "22:00",
  brightness_schedule_end: "06:00",
  brightness_schedule_dashboard: 30,
  brightness_schedule_screensaver: 10,
  show_progress: false,
  hide_cursor: true,
  cards: [],
});

function numberOption(value, fallback, name, minimum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${name} muss mindestens ${minimum} sein.`);
  }
  return parsed;
}

function brightnessOption(value, fallback, name) {
  const parsed = numberOption(value, fallback, name, 0);
  if (parsed > 100) {
    throw new Error(`${name} darf höchstens 100 sein.`);
  }
  return parsed;
}

function viewOptions(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Die Ansichten-Auswahl muss eine Liste sein.");
  }

  const views = [];
  for (const rawPath of value) {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      throw new Error("Ein Ansichten-Pfad ist ungültig.");
    }
    const path = `/${rawPath.trim().replace(/^\/+/, "").replace(/\/+$/, "")}`;
    if (/[?#]/.test(path) || path.includes("://")) {
      throw new Error("Ansichten-Pfade dürfen keine URL-Parameter enthalten.");
    }
    if (!views.includes(path)) views.push(path);
  }
  return views;
}

function rgbColor(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error("Die Vollbildfarbe muss ein RGB-Wert sein.");
  }
  return value.map((channel) => {
    const parsed = Number(channel);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
      throw new Error("RGB-Farbwerte müssen zwischen 0 und 255 liegen.");
    }
    return parsed;
  });
}

function hexColor(value) {
  if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) {
    return value.toUpperCase();
  }

  const [red, green, blue] = rgbColor(value);
  return `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

function fullscreenCardConfig(value, index) {
  let card = value;
  if (
    card &&
    typeof card === "object" &&
    !Array.isArray(card) &&
    (String(card.type || "").trim() === "panel" || card.panel === true)
  ) {
    if (!Array.isArray(card.cards) || card.cards.length !== 1) {
      throw new Error(
        `Panel-Ansicht ${index + 1} muss genau eine Dashboard-Karte enthalten.`,
      );
    }
    card = card.cards[0];
  }
  if (
    !card ||
    typeof card !== "object" ||
    Array.isArray(card) ||
    typeof card.type !== "string" ||
    !card.type.trim()
  ) {
    throw new Error(`Screensaver-Karte ${index + 1} benötigt einen Typ.`);
  }
  return { ...card };
}

function cardScale(value, index) {
  const parsed = value === undefined ? 100 : Number(value);
  if (!Number.isFinite(parsed) || parsed < 50 || parsed > 300) {
    throw new Error(
      `Die Skalierung der Screensaver-Karte ${index + 1} muss zwischen 50 und 300 Prozent liegen.`,
    );
  }
  return Math.round(parsed);
}

function timeOption(value, fallback, name) {
  const candidate = String(value === undefined ? fallback : value).trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(candidate)) {
    throw new Error(`${name} muss eine gültige Uhrzeit sein.`);
  }
  return candidate.slice(0, 5);
}

function timeMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function isMinuteInDailyRange(current, start, end) {
  const startMinute = timeMinutes(start);
  const endMinute = timeMinutes(end);
  if (startMinute === endMinute) return false;
  return startMinute < endMinute
    ? current >= startMinute && current < endMinute
    : current >= startMinute || current < endMinute;
}

function localMinutes(date, timeZone) {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(date);
      const hour = Number(parts.find((part) => part.type === "hour")?.value);
      const minute = Number(parts.find((part) => part.type === "minute")?.value);
      if (Number.isInteger(hour) && Number.isInteger(minute)) {
        return hour * 60 + minute;
      }
    } catch {
      // Fall back to the wallpanel device's local clock.
    }
  }
  return date.getHours() * 60 + date.getMinutes();
}

function orderedPanels(value, views, cards, colors) {
  let requested = value;
  if (typeof requested === "string") {
    try {
      requested = requested.trim() ? JSON.parse(requested) : [];
    } catch {
      throw new Error("Die Panel-Reihenfolge ist ungültig.");
    }
  }
  if (!Array.isArray(requested)) requested = [];

  const catalog = new Map([
    ...views.map((path) => [`view:${path}`, { kind: "view", path }]),
    ...cards.map(({ name, card, scale }, index) => [
      `card:${index}`,
      { kind: "card", name, card, scale },
    ]),
    ...colors.map(({ color }, index) => [
      `color:${index}`,
      { kind: "color", color },
    ]),
  ]);
  const order = [];
  for (const token of requested) {
    if (typeof token === "string" && catalog.has(token) && !order.includes(token)) {
      order.push(token);
    }
  }
  for (const token of catalog.keys()) {
    if (!order.includes(token)) order.push(token);
  }
  return { order, panels: order.map((token) => catalog.get(token)) };
}

export function normalizeConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Die Screensaver-Konfiguration fehlt.");
  }

  const configured = Boolean(config.configured);
  const cards = Array.isArray(config.cards)
    ? config.cards.map((item, index) => {
        const card = fullscreenCardConfig(item?.card ?? item, index);
        return {
          name: String(item?.name || `Karte ${index + 1}`),
          card,
          scale: cardScale(item?.scale, index),
        };
      })
    : [];

  const colors = Array.isArray(config.colors)
    ? config.colors.map((item, index) => {
        if (!item || typeof item !== "object" || !("color" in item)) {
          throw new Error(`Vollbildfarbe ${index + 1} benötigt einen Farbwert.`);
        }
        return {
          color: hexColor(item.color),
        };
      })
    : [];

  const views = viewOptions(config.views);
  const { order: panelOrder, panels } = orderedPanels(
    config.panel_order,
    views,
    cards,
    colors,
  );
  const scheduleStart = timeOption(
    config.schedule_start,
    DEFAULT_CONFIG.schedule_start,
    "schedule_start",
  );
  const scheduleEnd = timeOption(
    config.schedule_end,
    DEFAULT_CONFIG.schedule_end,
    "schedule_end",
  );
  const scheduleMode = String(
    config.schedule_mode ?? DEFAULT_CONFIG.schedule_mode,
  );
  if (!["black", "static", "disabled"].includes(scheduleMode)) {
    throw new Error("schedule_mode ist ungültig.");
  }
  const scheduleEnabled = Boolean(config.schedule_enabled);
  if (scheduleEnabled && scheduleStart === scheduleEnd) {
    throw new Error("Start und Ende des Zeitplans müssen unterschiedlich sein.");
  }
  const requestedSchedulePanel = String(config.schedule_panel || "");
  const schedulePanel = panelOrder.includes(requestedSchedulePanel)
    ? requestedSchedulePanel
    : panelOrder[0] || "";
  const brightnessScheduleStart = timeOption(
    config.brightness_schedule_start,
    DEFAULT_CONFIG.brightness_schedule_start,
    "brightness_schedule_start",
  );
  const brightnessScheduleEnd = timeOption(
    config.brightness_schedule_end,
    DEFAULT_CONFIG.brightness_schedule_end,
    "brightness_schedule_end",
  );
  const brightnessScheduleEnabled = Boolean(
    config.brightness_schedule_enabled,
  );
  if (
    brightnessScheduleEnabled &&
    brightnessScheduleStart === brightnessScheduleEnd
  ) {
    throw new Error(
      "Start und Ende des Helligkeitszeitplans müssen unterschiedlich sein.",
    );
  }

  if (configured && panels.length === 0) {
    throw new Error(
      "Mindestens eine Ansicht, Karte oder Vollbildfarbe wird benötigt.",
    );
  }

  const displayTime = numberOption(
    config.display_time,
    DEFAULT_CONFIG.display_time,
    "display_time",
    1,
  );
  const transitionTime = numberOption(
    config.transition_time,
    DEFAULT_CONFIG.transition_time,
    "transition_time",
    0,
  );
  if (transitionTime > displayTime) {
    throw new Error(
      "transition_time darf nicht größer als display_time sein.",
    );
  }

  return {
    configured,
    enabled: configured && Boolean(config.enabled),
    views,
    idle_time: numberOption(
      config.idle_time,
      DEFAULT_CONFIG.idle_time,
      "idle_time",
      1,
    ),
    display_time: displayTime,
    transition_time: transitionTime,
    colors,
    panel_order: panelOrder,
    shuffle: Boolean(config.shuffle),
    schedule_enabled: scheduleEnabled,
    schedule_start: scheduleStart,
    schedule_end: scheduleEnd,
    schedule_mode: scheduleMode,
    schedule_panel: schedulePanel,
    dashboard_brightness: brightnessOption(
      config.dashboard_brightness,
      DEFAULT_CONFIG.dashboard_brightness,
      "dashboard_brightness",
    ),
    screensaver_brightness: brightnessOption(
      config.screensaver_brightness,
      DEFAULT_CONFIG.screensaver_brightness,
      "screensaver_brightness",
    ),
    brightness_schedule_enabled: brightnessScheduleEnabled,
    brightness_schedule_start: brightnessScheduleStart,
    brightness_schedule_end: brightnessScheduleEnd,
    brightness_schedule_dashboard: brightnessOption(
      config.brightness_schedule_dashboard,
      DEFAULT_CONFIG.brightness_schedule_dashboard,
      "brightness_schedule_dashboard",
    ),
    brightness_schedule_screensaver: brightnessOption(
      config.brightness_schedule_screensaver,
      DEFAULT_CONFIG.brightness_schedule_screensaver,
      "brightness_schedule_screensaver",
    ),
    show_progress:
      config.show_progress === undefined
        ? DEFAULT_CONFIG.show_progress
        : Boolean(config.show_progress),
    hide_cursor:
      config.hide_cursor === undefined
        ? DEFAULT_CONFIG.hide_cursor
        : Boolean(config.hide_cursor),
    cards,
    panels,
  };
}

export class ScreensaverController {
  constructor() {
    this._config = { ...DEFAULT_CONFIG };
    this._hass = undefined;
    this._connected = false;
    this._active = false;
    this._idleTimer = undefined;
    this._rotationTimer = undefined;
    this._cursorTimer = undefined;
    this._transitionTimers = new Set();
    this._activationToken = 0;
    this._currentIndex = 0;
    this._currentSlide = undefined;
    this._activePanels = [];
    this._activeShuffle = false;
    this._scheduleStateKey = "normal";
    this._helpersPromise = undefined;
    this._lovelaceResourcesPromise = undefined;
    this._lovelaceResourceLoads = new Map();
    this._lastPointerMove = 0;
    this._pageScrollLock = undefined;
    this._pageScrollStyle = undefined;
    this._brightnessOverlay = undefined;

    this._onWindowActivity = this._onWindowActivity.bind(this);
    this._onOverlayInteraction = this._onOverlayInteraction.bind(this);
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    this._onLocationChange = this._onLocationChange.bind(this);
  }

  connect() {
    if (this._connected || !globalThis.window || !globalThis.document) return;
    this._connected = true;
    this._addActivityListeners();
    this._createBrightnessOverlay();
    this._createOverlay();
    this._syncBrightness();
    this._armIdleTimer();
  }

  disconnect() {
    if (!this._connected) return;
    this._connected = false;
    this._deactivate(false);
    this._removeActivityListeners();
    this._destroyOverlay();
    this._destroyBrightnessOverlay();
  }

  setConfig(value) {
    let config;
    try {
      config = normalizeConfig(value);
    } catch (error) {
      console.error("HA-Wallpanel: ungültige Screensaver-Konfiguration", error);
      config = { ...DEFAULT_CONFIG };
    }

    this._deactivate(false);
    this._destroyOverlay();
    this._destroyBrightnessOverlay();
    this._config = config;
    this._scheduleStateKey = this._schedulePlayback().key;
    this._createBrightnessOverlay();
    this._createOverlay();
    this._syncBrightness();
    this._armIdleTimer();
  }

  setHass(hass) {
    const hadHass = Boolean(this._hass);
    this._hass = hass;
    this._syncBrightness();
    if (this._surface) {
      for (const slide of this._surface.children) {
        if (slide._screensaverCard) slide._screensaverCard.hass = hass;
      }
    }
    if (!hadHass) this._armIdleTimer();
  }

  showScreensaver() {
    this._activate();
  }

  hideScreensaver() {
    this._deactivate(true);
  }

  get active() {
    return this._active;
  }

  get config() {
    return this._config;
  }

  syncSchedule(now = new Date()) {
    this._syncBrightness(now);
    const playback = this._schedulePlayback(now);
    if (playback.key === this._scheduleStateKey) return;
    const previousKey = this._scheduleStateKey;
    this._scheduleStateKey = playback.key;

    if (this._active) {
      this._deactivate(false);
      if (playback.key !== "disabled") this._activate();
      return;
    }
    if (playback.key === "disabled") {
      this._clearIdleTimer();
    } else if (previousKey === "disabled" || this._idleTimer === undefined) {
      this._armIdleTimer();
    }
  }

  _schedulePlayback(now = new Date()) {
    const normal = {
      key: "normal",
      panels: this._config.panels || [],
      shuffle: Boolean(this._config.shuffle),
    };
    if (!this._config.schedule_enabled) return normal;

    const currentMinute = localMinutes(now, this._hass?.config?.time_zone);
    if (
      !isMinuteInDailyRange(
        currentMinute,
        this._config.schedule_start,
        this._config.schedule_end,
      )
    ) {
      return normal;
    }

    if (this._config.schedule_mode === "disabled") {
      return { key: "disabled", panels: [], shuffle: false };
    }
    if (this._config.schedule_mode === "black") {
      return {
        key: "black",
        panels: [{ kind: "color", color: "#000000" }],
        shuffle: false,
      };
    }

    const index = this._config.panel_order.indexOf(
      this._config.schedule_panel,
    );
    const panel = this._config.panels[index] || this._config.panels[0];
    return {
      key: `static:${this._config.schedule_panel}`,
      panels: panel ? [panel] : [],
      shuffle: false,
    };
  }

  _isEligible() {
    const playback = this._schedulePlayback();
    return Boolean(
      this._connected &&
        this._hass &&
        this._config.configured &&
        this._config.enabled &&
        playback.key !== "disabled" &&
        hasKioskParameter() &&
        !hasEmbeddedParameter(),
    );
  }

  _isWallpanelSession() {
    return Boolean(
      this._connected &&
        this._hass &&
        this._config.configured &&
        this._config.enabled &&
        hasKioskParameter() &&
        !hasEmbeddedParameter(),
    );
  }

  _brightnessLevels(now = new Date()) {
    const scheduled = Boolean(
      this._config.brightness_schedule_enabled &&
        isMinuteInDailyRange(
          localMinutes(now, this._hass?.config?.time_zone),
          this._config.brightness_schedule_start,
          this._config.brightness_schedule_end,
        ),
    );
    return {
      scheduled,
      dashboard: scheduled
        ? this._config.brightness_schedule_dashboard
        : this._config.dashboard_brightness,
      screensaver: scheduled
        ? this._config.brightness_schedule_screensaver
        : this._config.screensaver_brightness,
    };
  }

  _syncBrightness(now = new Date()) {
    this._createBrightnessOverlay();
    const levels = this._brightnessLevels(now);
    const dashboardOpacity = Math.max(0, Math.min(1, 1 - levels.dashboard / 100));
    const screensaverOpacity = Math.max(
      0,
      Math.min(1, 1 - levels.screensaver / 100),
    );

    if (this._brightnessOverlay) {
      const visible = this._isWallpanelSession() && !this._active && dashboardOpacity > 0;
      this._brightnessOverlay.hidden = !visible;
      this._brightnessOverlay.style.setProperty(
        "--dashboard-dim-opacity",
        String(dashboardOpacity),
      );
    }
    this._overlayHost?.style?.setProperty(
      "--screensaver-dim-opacity",
      String(screensaverOpacity),
    );
  }

  _addActivityListeners() {
    window.addEventListener("pointerdown", this._onWindowActivity, true);
    window.addEventListener("pointermove", this._onWindowActivity, {
      capture: true,
      passive: true,
    });
    window.addEventListener("keydown", this._onWindowActivity, true);
    // Observe the result of scrolling instead of every wheel packet. In
    // particular Safari keeps high-frequency wheel listeners on the critical
    // path of Home Assistant's virtualized card picker even when they are
    // passive. The screensaver overlay still owns wheel-to-wake while active.
    window.addEventListener("scroll", this._onWindowActivity, {
      capture: true,
      passive: true,
    });
    window.addEventListener("location-changed", this._onLocationChange);
    window.addEventListener("popstate", this._onLocationChange);
    document.addEventListener(
      "visibilitychange",
      this._onVisibilityChange,
      true,
    );
  }

  _removeActivityListeners() {
    window.removeEventListener("pointerdown", this._onWindowActivity, true);
    window.removeEventListener("pointermove", this._onWindowActivity, true);
    window.removeEventListener("keydown", this._onWindowActivity, true);
    window.removeEventListener("scroll", this._onWindowActivity, true);
    window.removeEventListener("location-changed", this._onLocationChange);
    window.removeEventListener("popstate", this._onLocationChange);
    document.removeEventListener(
      "visibilitychange",
      this._onVisibilityChange,
      true,
    );
  }

  _onWindowActivity(event) {
    if (this._active) {
      // Programmatic scrolling behind the overlay must not dismiss it. Actual
      // wheel/touch interaction is captured directly by the overlay.
      if (event.type === "scroll") return;
      if (event.type === "keydown") {
        event.preventDefault();
        event.stopPropagation();
      }
      this._deactivate(true);
      return;
    }
    if (!this._isEligible()) return;

    if (event.type === "pointermove") {
      const now = Date.now();
      if (now - this._lastPointerMove < 750) return;
      this._lastPointerMove = now;
    }
    this._armIdleTimer();
  }

  _onLocationChange() {
    this._syncBrightness();
    if (!this._isEligible()) {
      this._deactivate(false);
      this._clearIdleTimer();
      return;
    }
    this._armIdleTimer();
  }

  _onVisibilityChange() {
    if (document.hidden) {
      this._deactivate(false);
      this._clearIdleTimer();
      return;
    }
    this._armIdleTimer();
  }

  _onOverlayInteraction(event) {
    if (!this._overlayHost || this._overlayHost.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    if (this._active) this._deactivate(true);
  }

  _armIdleTimer() {
    this._clearIdleTimer();
    if (
      !this._isEligible() ||
      this._active ||
      globalThis.document?.hidden
    ) {
      return;
    }
    this._idleTimer = window.setTimeout(
      () => this._activate(),
      this._config.idle_time * 1000,
    );
  }

  _clearIdleTimer() {
    if (this._idleTimer !== undefined && globalThis.window) {
      window.clearTimeout(this._idleTimer);
    }
    this._idleTimer = undefined;
  }

  _closeMoreInfoDialogs() {
    if (!globalThis.document) return 0;
    let closed = 0;
    for (const dialog of findElementsDeep(document, "ha-more-info-dialog")) {
      if (typeof dialog.closeDialog !== "function") continue;
      dialog.closeDialog();
      closed += 1;
    }
    return closed;
  }

  _lockPageScroll() {
    if (this._pageScrollLock || !globalThis.document) return;

    const elements = [document.documentElement, document.body].filter(
      (element) => element?.style,
    );
    this._pageScrollLock = elements.map((element) => ({
      element,
      overflow: {
        value: element.style.getPropertyValue("overflow"),
        priority: element.style.getPropertyPriority("overflow"),
      },
      overscrollBehavior: {
        value: element.style.getPropertyValue("overscroll-behavior"),
        priority: element.style.getPropertyPriority("overscroll-behavior"),
      },
    }));

    for (const { element } of this._pageScrollLock) {
      element.style.setProperty("overflow", "hidden", "important");
      element.style.setProperty("overscroll-behavior", "none", "important");
    }

    const target = document.head || document.documentElement || document.body;
    if (typeof target?.appendChild !== "function") return;

    const style = document.createElement("style");
    style.setAttribute(SCREENSAVER_SCROLL_LOCK_STYLE_ATTRIBUTE, "true");
    style.textContent = `html, body {
      overflow: hidden !important;
      overscroll-behavior: none !important;
      scrollbar-width: none !important;
      -ms-overflow-style: none !important;
    }
    html::-webkit-scrollbar,
    body::-webkit-scrollbar {
      width: 0 !important;
      height: 0 !important;
      display: none !important;
    }`;
    target.appendChild(style);
    this._pageScrollStyle = style;
  }

  _unlockPageScroll() {
    for (const saved of this._pageScrollLock || []) {
      for (const [property, original] of [
        ["overflow", saved.overflow],
        ["overscroll-behavior", saved.overscrollBehavior],
      ]) {
        if (original.value) {
          saved.element.style.setProperty(
            property,
            original.value,
            original.priority,
          );
        } else {
          saved.element.style.removeProperty(property);
        }
      }
    }
    this._pageScrollLock = undefined;
    this._pageScrollStyle?.remove?.();
    this._pageScrollStyle = undefined;
  }

  _createBrightnessOverlay() {
    if (
      this._brightnessOverlay ||
      !this._config.configured ||
      !globalThis.document?.body
    ) {
      return;
    }

    const overlay = document.createElement("div");
    overlay.id = "ha-wallpanel-dashboard-brightness-overlay";
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    const shadow = overlay.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          inset: 0;
          z-index: 2147483646;
          display: block;
          width: 100vw;
          height: 100vh;
          height: 100dvh;
          overflow: hidden;
          background: #000;
          opacity: var(--dashboard-dim-opacity, 0);
          pointer-events: none;
          touch-action: none;
          transition: opacity 200ms linear;
        }
        :host([hidden]) { display: none; }
        @media (prefers-reduced-motion: reduce) {
          :host { transition-duration: 0.01ms; }
        }
      </style>
    `;
    document.body.appendChild(overlay);
    this._brightnessOverlay = overlay;
  }

  _destroyBrightnessOverlay() {
    this._brightnessOverlay?.remove?.();
    this._brightnessOverlay = undefined;
  }

  _createOverlay() {
    if (
      this._overlayHost ||
      !this._config.configured ||
      !globalThis.document?.body
    ) {
      return;
    }

    const host = document.createElement("div");
    host.id = "ha-wallpanel-screensaver-overlay";
    host.hidden = true;
    host.tabIndex = -1;
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    host.setAttribute("aria-label", "Bildschirmschoner");
    host.setAttribute("aria-hidden", "true");
    host.style.setProperty(
      "--screensaver-transition",
      `${this._config.transition_time}s`,
    );
    host.style.setProperty("--screensaver-background", "#050505");
    host.style.setProperty(
      "--screensaver-cursor",
      this._config.hide_cursor ? "none" : "default",
    );
    host.style.setProperty("--screensaver-dim-opacity", "0");

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          display: block;
          box-sizing: border-box;
          width: 100vw;
          height: 100vh;
          height: 100dvh;
          overflow: hidden;
          opacity: 0;
          background: var(--screensaver-background, #050505);
          color: var(--primary-text-color, #fff);
          cursor: var(--screensaver-cursor, none);
          touch-action: none;
          overscroll-behavior: none;
          user-select: none;
          transition: opacity var(--screensaver-transition, 1.5s) ease;
        }

        :host([hidden]) { display: none; }
        :host(.visible) { opacity: 1; }

        :host,
        :host * {
          cursor: var(--screensaver-cursor, none) !important;
        }

        .surface,
        .slide {
          position: absolute;
          inset: 0;
          box-sizing: border-box;
        }

        .surface { overflow: hidden; }

        .slide {
          overflow: hidden;
          opacity: 0;
          transform: scale(0.985);
          transition:
            opacity var(--screensaver-transition, 1.5s) ease,
            transform var(--screensaver-transition, 1.5s) ease;
        }

        .slide.visible {
          opacity: 1;
          transform: scale(1);
        }

        .panel-frame {
          position: absolute;
          inset: 0;
          box-sizing: border-box;
          width: 100%;
          height: 100%;
        }

        .card-frame {
          overflow: auto;
          padding: 0;
          scrollbar-width: none;
          --ha-card-border-radius: var(--ha-border-radius-square, 0px);
          --ha-card-border-width: 0;
          --ha-card-box-shadow: none;
        }

        .card-frame::-webkit-scrollbar { display: none; }
        .card-frame > * {
          display: block;
          box-sizing: border-box;
          width: 100%;
          height: 100%;
          min-height: 100%;
        }

        .view-frame iframe {
          display: block;
          width: 100%;
          height: 100%;
          border: 0;
          background: var(--screensaver-background, #050505);
          pointer-events: none;
        }

        .loading,
        .error {
          box-sizing: border-box;
          width: 100%;
          padding: 24px;
          border-radius: 12px;
          color: #fff;
          background: rgba(255, 255, 255, 0.08);
          font: 500 16px/1.5 system-ui, sans-serif;
          text-align: center;
        }

        .loading::before {
          content: "";
          display: block;
          width: 28px;
          height: 28px;
          margin: 0 auto;
          border: 3px solid rgba(255, 255, 255, 0.25);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }

        .indicator {
          position: absolute;
          z-index: 2;
          left: 50%;
          bottom: max(12px, env(safe-area-inset-bottom));
          display: flex;
          gap: 8px;
          transform: translateX(-50%);
          pointer-events: none;
        }

        .indicator[hidden] { display: none; }

        .brightness-overlay {
          position: absolute;
          z-index: 3;
          inset: 0;
          background: #000;
          opacity: var(--screensaver-dim-opacity, 0);
          pointer-events: none;
          transition: opacity 200ms linear;
        }

        .dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.35);
          transition: width 180ms ease, background 180ms ease;
        }

        .dot.active {
          width: 20px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.9);
        }

        @keyframes spin { to { transform: rotate(360deg); } }

        @media (prefers-reduced-motion: reduce) {
          :host, .slide, .dot { transition-duration: 0.01ms !important; }
        }
      </style>
      <main class="surface" aria-live="off"></main>
      <nav class="indicator" aria-hidden="true"></nav>
      <div class="brightness-overlay" aria-hidden="true"></div>
    `;

    this._overlayHost = host;
    this._surface = shadow.querySelector(".surface");
    this._indicator = shadow.querySelector(".indicator");
    this._configureIndicator(this._config.panels);

    host.addEventListener("pointerdown", this._onOverlayInteraction, true);
    host.addEventListener("touchstart", this._onOverlayInteraction, {
      capture: true,
      passive: false,
    });
    host.addEventListener("wheel", this._onOverlayInteraction, {
      capture: true,
      passive: false,
    });
    host.addEventListener("click", this._onOverlayInteraction, true);
    document.body.appendChild(host);
  }

  _configureIndicator(panels) {
    if (!this._indicator) return;
    this._indicator.replaceChildren();
    this._indicator.hidden = !this._config.show_progress || panels.length < 2;
    this._dots = panels.map(() => {
      const dot = document.createElement("span");
      dot.className = "dot";
      this._indicator.appendChild(dot);
      return dot;
    });
  }

  _destroyOverlay() {
    this._clearRotationTimer();
    this._clearTransitionTimers();
    this._clearCursorTimer();
    this._unlockPageScroll();

    if (this._overlayHost) {
      this._overlayHost.removeEventListener(
        "pointerdown",
        this._onOverlayInteraction,
        true,
      );
      this._overlayHost.removeEventListener(
        "touchstart",
        this._onOverlayInteraction,
        true,
      );
      this._overlayHost.removeEventListener(
        "wheel",
        this._onOverlayInteraction,
        true,
      );
      this._overlayHost.removeEventListener(
        "click",
        this._onOverlayInteraction,
        true,
      );
      this._overlayHost.remove();
    }

    this._overlayHost = undefined;
    this._surface = undefined;
    this._indicator = undefined;
    this._dots = undefined;
    this._currentSlide = undefined;
    this._activePanels = [];
  }

  _activate() {
    if (this._active || !this._isEligible() || globalThis.document?.hidden) {
      return;
    }

    this._createOverlay();
    if (!this._overlayHost || !this._surface) return;

    const playback = this._schedulePlayback();
    if (playback.panels.length === 0) return;

    this._closeMoreInfoDialogs();
    this._lockPageScroll();
    this._clearIdleTimer();
    this._clearRotationTimer();
    this._activationToken += 1;
    this._active = true;
    this._syncBrightness();
    this._scheduleStateKey = playback.key;
    this._activePanels = playback.panels;
    this._activeShuffle = playback.shuffle;
    this._configureIndicator(this._activePanels);
    this._currentIndex = this._activeShuffle
      ? Math.floor(Math.random() * this._activePanels.length)
      : 0;
    this._surface.replaceChildren();
    this._currentSlide = undefined;

    this._overlayHost.hidden = false;
    this._overlayHost.setAttribute("aria-hidden", "false");
    this._startCursorGuard();
    requestAnimationFrame(() => {
      if (this._active) this._overlayHost?.classList.add("visible");
    });

    this._renderSlide(this._currentIndex, this._activationToken);
    this._overlayHost.focus({ preventScroll: true });
    this._emitActiveChanged(true);
  }

  _deactivate(rearm) {
    if (!this._active) {
      this._unlockPageScroll();
      this._syncBrightness();
      if (rearm) this._armIdleTimer();
      return;
    }

    this._activationToken += 1;
    this._active = false;
    this._syncBrightness();
    this._clearRotationTimer();
    this._clearTransitionTimers();
    this._clearCursorTimer();
    this._unlockPageScroll();
    this._overlayHost?.classList.remove("visible");
    if (this._overlayHost) {
      this._overlayHost.hidden = true;
      this._overlayHost.setAttribute("aria-hidden", "true");
    }
    this._surface?.replaceChildren();
    this._currentSlide = undefined;
    this._emitActiveChanged(false);
    if (rearm) this._armIdleTimer();
  }

  async _renderSlide(index, token) {
    if (!this._active || token !== this._activationToken || !this._surface) {
      return;
    }

    const slide = document.createElement("section");
    slide.className = "slide";
    const frame = document.createElement("div");
    frame.className = "panel-frame";
    const loading = document.createElement("div");
    loading.className = "loading";
    loading.setAttribute("aria-label", "Panel wird geladen");
    frame.appendChild(loading);
    slide.appendChild(frame);

    const outgoing = this._currentSlide;
    this._surface.appendChild(slide);
    this._currentSlide = slide;
    this._currentIndex = index;
    this._updateIndicator(index);

    requestAnimationFrame(() => {
      if (!this._active || token !== this._activationToken) return;
      slide.classList.add("visible");
      outgoing?.classList.remove("visible");
    });
    if (outgoing) this._setTransitionTimer(() => outgoing.remove());

    try {
      const panel = this._activePanels[index];
      if (panel.kind === "view") {
        frame.classList.add("view-frame");
        this._mountView(frame, panel);
      } else if (panel.kind === "color") {
        frame.classList.add("color-frame");
        frame.style.background = panel.color;
        frame.replaceChildren();
      } else {
        frame.classList.add("card-frame");
        const card = await this._instantiateCard(panel.card);
        if (!this._active || token !== this._activationToken || !slide.isConnected) {
          slide.remove();
          return;
        }
        this._mountCard(
          frame,
          slide,
          card,
          panel.card,
          panel.scale,
          token,
        );
      }
    } catch (error) {
      if (!this._active || token !== this._activationToken) return;
      const message = document.createElement("div");
      message.className = "error";
      message.textContent = `Panel konnte nicht geladen werden: ${
        error instanceof Error ? error.message : String(error)
      }`;
      frame.replaceChildren(message);
    }

    if (this._active && token === this._activationToken) {
      this._scheduleRotation(token);
    }
  }

  async _instantiateCard(cardConfig) {
    await this._ensureCustomCardAvailable(cardConfig);
    if (
      globalThis.document?.createElement &&
      globalThis.customElements?.get?.("hui-card")
    ) {
      const wrapper = document.createElement("hui-card");
      wrapper.hass = this._hass;
      wrapper.config = cardConfig;
      wrapper.preview = false;
      wrapper.layout = "panel";
      wrapper.load();
      this._applyPanelCardContext(wrapper);
      return wrapper;
    }
    if (typeof globalThis.window?.loadCardHelpers !== "function") {
      throw new Error("Home-Assistant-Kartenhelfer sind nicht verfügbar.");
    }
    this._helpersPromise ??= window.loadCardHelpers();
    const helpers = await this._helpersPromise;
    const card = helpers.createCardElement(cardConfig);
    card.hass = this._hass;
    this._applyPanelCardContext(card);
    return card;
  }

  async _ensureCustomCardAvailable(cardConfig) {
    const type = String(cardConfig?.type || "");
    if (!type.startsWith("custom:")) return;

    const elementName = type.slice("custom:".length).trim();
    if (!elementName || globalThis.customElements?.get?.(elementName)) return;

    await this._ensureLovelaceResources(elementName);
    if (!globalThis.customElements?.get?.(elementName)) {
      throw new Error(
        `Die Custom Card ${elementName} ist nicht geladen. ` +
          "Prüfe ihre Lovelace-Ressource in Home Assistant.",
      );
    }
  }

  async _ensureLovelaceResources(elementName) {
    const hass = this._hass;
    const sendMessage = hass?.connection?.sendMessagePromise?.bind(
      hass.connection,
    );
    if (!sendMessage) return;
    if (!this._lovelaceResourcesPromise) {
      this._lovelaceResourcesPromise = (async () => {
        const resources = await sendMessage({ type: "lovelace/resources" });
        return Array.isArray(resources) ? resources : [];
      })().catch((error) => {
        this._lovelaceResourcesPromise = undefined;
        console.warn(
          "HA-Wallpanel: Lovelace-Ressourcen konnten für den Screensaver nicht geladen werden",
          error,
        );
        return [];
      });
    }
    const resources = await this._lovelaceResourcesPromise;
    const normalizedName = String(elementName || "").toLowerCase();
    const shortName = normalizedName.replace(/-card$/, "");
    const ordered = resources
      .map((resource, index) => {
        const url = String(resource?.url || "").toLowerCase();
        const score = url.includes(normalizedName)
          ? 2
          : shortName && url.includes(shortName)
            ? 1
            : 0;
        return { resource, index, score };
      })
      .sort((left, right) => right.score - left.score || left.index - right.index);

    for (const { resource } of ordered) {
      try {
        await this._loadLovelaceResource(resource, hass);
      } catch {
        // A stale unrelated resource must not prevent the selected card loading.
      }
      if (globalThis.customElements?.get?.(elementName)) return;
    }
  }

  _loadLovelaceResource(resource, hass) {
    if (!resource || typeof resource.url !== "string") {
      return Promise.resolve();
    }
    const baseUrl =
      hass.auth?.data?.hassUrl || globalThis.location?.origin || "http://localhost";
    const url = new URL(resource.url, baseUrl).toString();
    const type = String(resource.type || "module");
    const key = `${type}:${url}`;
    if (this._lovelaceResourceLoads.has(key)) {
      return this._lovelaceResourceLoads.get(key);
    }

    let load;
    if (type === "module") {
      load = import(url);
    } else if ((type === "js" || type === "css") && globalThis.document) {
      const isScript = type === "js";
      const element = document.createElement(isScript ? "script" : "link");
      if (isScript) {
        element.src = url;
      } else {
        element.rel = "stylesheet";
        element.href = url;
      }
      load = new Promise((resolve, reject) => {
        element.addEventListener("load", resolve, { once: true });
        element.addEventListener(
          "error",
          () => reject(new Error(`Ressource konnte nicht geladen werden: ${url}`)),
          { once: true },
        );
        (document.head || document.documentElement).appendChild(element);
      });
    } else {
      load = Promise.resolve();
    }

    const guardedLoad = load.catch((error) => {
      console.error(
        `HA-Wallpanel: Lovelace-Ressource ${url} (${type}) konnte nicht geladen werden`,
        error,
      );
      throw error;
    });
    this._lovelaceResourceLoads.set(key, guardedLoad);
    return guardedLoad;
  }

  _applyPanelCardContext(card) {
    try {
      card.layout = "panel";
    } catch {
      // Some third-party cards expose layout as a read-only property.
    }
    try {
      card.isPanel = true;
    } catch {
      // isPanel is Home Assistant's legacy panel-mode flag.
    }
    try {
      card.preview = false;
      card.editMode = false;
    } catch {
      // Preview flags are optional for custom cards.
    }
    card.style?.setProperty?.("display", "block");
    card.style?.setProperty?.("box-sizing", "border-box");
    card.style?.setProperty?.("width", "100%");
    card.style?.setProperty?.("height", "100%");
    card.style?.setProperty?.("min-height", "100%");
    card.style?.setProperty?.(
      "--ha-card-border-radius",
      "var(--ha-border-radius-square, 0px)",
    );
    card.style?.setProperty?.("--ha-card-border-width", "0");
    card.style?.setProperty?.("--ha-card-box-shadow", "none");
  }

  _mountView(frame, panel) {
    const url = new URL(panel.path, window.location.origin);
    url.searchParams.set("kiosk", "");
    url.searchParams.set("ha-wallpanel-embedded", "1");

    const iframe = document.createElement("iframe");
    iframe.src = `${url.pathname}${url.search}${url.hash}`;
    iframe.title = `Home-Assistant-Ansicht ${panel.path}`;
    iframe.loading = "eager";
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    frame.replaceChildren(iframe);
  }

  _mountCard(frame, slide, card, cardConfig, scale, token) {
    const factor = cardScale(scale, 0) / 100;
    const inverseSize = `${100 / factor}%`;
    frame.style.setProperty("display", "flex");
    frame.style.setProperty("align-items", "center");
    frame.style.setProperty("justify-content", "center");
    card.style?.setProperty?.("flex", "0 0 auto");
    card.style?.setProperty?.("width", inverseSize);
    card.style?.setProperty?.("height", inverseSize);
    card.style?.setProperty?.("min-height", inverseSize);
    card.style?.setProperty?.("transform", `scale(${factor})`);
    card.style?.setProperty?.("transform-origin", "center center");
    frame.replaceChildren(card);
    slide._screensaverCard = card;
    card.addEventListener(
      "ll-rebuild",
      async (event) => {
        event.stopPropagation();
        if (!this._active || token !== this._activationToken || !slide.isConnected) {
          return;
        }
        try {
          const replacement = await this._instantiateCard(cardConfig);
          if (this._active && token === this._activationToken && slide.isConnected) {
            this._mountCard(
              frame,
              slide,
              replacement,
              cardConfig,
              scale,
              token,
            );
          }
        } catch {
          // Home Assistant keeps the existing error card visible.
        }
      },
      { once: true },
    );
  }

  _scheduleRotation(token) {
    this._clearRotationTimer();
    if (this._activePanels.length < 2) return;
    this._rotationTimer = window.setTimeout(() => {
      if (!this._active || token !== this._activationToken) return;
      const nextIndex = this._nextPanelIndex();
      this._renderSlide(nextIndex, token);
    }, this._config.display_time * 1000);
  }

  _nextPanelIndex(random = Math.random) {
    const count = this._activePanels.length;
    if (count < 2) return 0;
    if (!this._activeShuffle) return (this._currentIndex + 1) % count;
    const candidate = Math.floor(random() * (count - 1));
    return candidate >= this._currentIndex ? candidate + 1 : candidate;
  }

  _clearRotationTimer() {
    if (this._rotationTimer !== undefined && globalThis.window) {
      window.clearTimeout(this._rotationTimer);
    }
    this._rotationTimer = undefined;
  }

  _startCursorGuard() {
    this._clearCursorTimer();
    if (!this._config.hide_cursor || !this._overlayHost) return;

    const refresh = () => {
      if (!this._active || !this._config.hide_cursor) return;
      this._overlayHost?.style.setProperty(
        "--screensaver-cursor",
        "none",
      );
      this._applyHiddenCursor(this._overlayHost);
      this._cursorTimer = window.setTimeout(refresh, 250);
    };
    this._overlayHost.style.setProperty("--screensaver-cursor", "default");
    this._cursorTimer = window.setTimeout(
      refresh,
      this._config.transition_time * 1000,
    );
  }

  _applyHiddenCursor(root) {
    root?.style?.setProperty("cursor", "none", "important");
    const searchRoot = root?.shadowRoot || root;
    if (!searchRoot?.querySelectorAll) return;
    for (const element of searchRoot.querySelectorAll("*")) {
      element.style?.setProperty("cursor", "none", "important");
      if (element.shadowRoot) this._applyHiddenCursor(element.shadowRoot);
    }
  }

  _clearCursorTimer() {
    if (this._cursorTimer !== undefined && globalThis.window) {
      window.clearTimeout(this._cursorTimer);
    }
    this._cursorTimer = undefined;
  }

  _setTransitionTimer(callback) {
    const duration = Math.max(this._config.transition_time * 1000, 20);
    const timer = window.setTimeout(() => {
      this._transitionTimers.delete(timer);
      callback();
    }, duration);
    this._transitionTimers.add(timer);
  }

  _clearTransitionTimers() {
    if (globalThis.window) {
      for (const timer of this._transitionTimers) window.clearTimeout(timer);
    }
    this._transitionTimers.clear();
  }

  _updateIndicator(index) {
    this._dots?.forEach((dot, dotIndex) => {
      dot.classList.toggle("active", dotIndex === index);
    });
  }

  _emitActiveChanged(active) {
    if (!globalThis.window || typeof globalThis.CustomEvent !== "function") return;
    window.dispatchEvent(
      new CustomEvent(EVENT_NAME, {
        detail: { active, version: VERSION },
      }),
    );
  }
}

export function hasKioskParameter(search = globalThis.location?.search || "") {
  return new URLSearchParams(search).has("kiosk");
}

export function hasEmbeddedParameter(
  search = globalThis.location?.search || "",
) {
  return new URLSearchParams(search).has("ha-wallpanel-embedded");
}

export class KioskModeController {
  constructor() {
    this._connected = false;
    this._sessionActive = hasKioskParameter();
    this._embeddedSession = hasEmbeddedParameter();
    this._savedStyles = new Map();
    this._scrollbarStyles = new Map();
    this._markerBody = undefined;
    this._markerValue = undefined;
    this._onNavigation = this._onNavigation.bind(this);
  }

  connect() {
    if (this._connected || !globalThis.window || !globalThis.document) return;
    this._connected = true;
    window.addEventListener("location-changed", this._onNavigation);
    window.addEventListener("popstate", this._onNavigation);
    window.navigation?.addEventListener?.("navigate", this._onNavigation);
    this.sync();
  }

  disconnect() {
    if (!this._connected) return;
    this._connected = false;
    window.removeEventListener("location-changed", this._onNavigation);
    window.removeEventListener("popstate", this._onNavigation);
    window.navigation?.removeEventListener?.("navigate", this._onNavigation);
    this._restore();
  }

  enable() {
    this._sessionActive = true;
    this._ensureUrlParameter();
    this.sync();
  }

  disable() {
    this._sessionActive = false;
    this._removeUrlParameter();
    this._restore();
  }

  get active() {
    return this._sessionActive;
  }

  sync() {
    if (!globalThis.window || !globalThis.document) return;
    if (hasKioskParameter()) this._sessionActive = true;
    if (!this._sessionActive) {
      this._restore();
      return;
    }

    this._ensureUrlParameter();
    const elements = this._findHomeAssistantElements();
    if (!elements) return;

    let changed = false;
    changed =
      this._setStyle(
        elements.main,
        "--ha-sidebar-width",
        "env(safe-area-inset-left)",
      ) || changed;
    changed =
      this._setStyle(
        elements.main,
        "--mdc-drawer-width",
        "env(safe-area-inset-left)",
      ) || changed;

    if (elements.sidebar) {
      changed = this._setStyle(elements.sidebar, "opacity", "0") || changed;
      changed = this._setStyle(elements.sidebar, "max-width", "0px") || changed;
      changed =
        this._setStyle(elements.sidebar, "pointer-events", "none") || changed;
    }
    if (elements.menuButton) {
      changed = this._setStyle(elements.menuButton, "display", "none") || changed;
    }
    if (elements.toolbar) {
      changed = this._setStyle(elements.toolbar, "display", "none") || changed;
    }
    if (elements.view) {
      changed = this._setStyle(elements.view, "min-height", "100vh") || changed;
      changed = this._setStyle(elements.view, "margin-top", "0px") || changed;
      changed = this._setStyle(elements.view, "padding-top", "0px") || changed;
      changed = this._setStyle(elements.view, "scrollbar-width", "none") || changed;
    }

    changed = this._hideScrollbars(elements.styleRoots) || changed;

    const body = document.body;
    if (body && this._markerBody !== body) {
      this._restoreMarker();
      this._markerBody = body;
      this._markerValue = body.getAttribute("data-ha-wallpanel-kiosk");
      body.setAttribute("data-ha-wallpanel-kiosk", "true");
      changed = true;
    }

    if (changed) window.dispatchEvent(new Event("resize"));
  }

  _findHomeAssistantElements() {
    const homeAssistant =
      document.querySelector("body > home-assistant") ||
      document.querySelector("home-assistant");
    const main = homeAssistant?.shadowRoot?.querySelector("home-assistant-main");
    const mainRoot = main?.shadowRoot;
    if (!main || !mainRoot) return undefined;

    const drawer = mainRoot.querySelector("ha-drawer");
    const drawerRoot = drawer?.shadowRoot;
    const sidebar =
      mainRoot.querySelector("ha-sidebar") ||
      drawerRoot?.querySelector(".sidebar-shell") ||
      drawerRoot?.querySelector("aside");

    const resolver = mainRoot.querySelector("partial-panel-resolver");
    const activePanel =
      resolver?.lastElementChild || mainRoot.querySelector("ha-panel-lovelace");
    const panelRoot = activePanel?.shadowRoot;
    const huiRoot = panelRoot?.querySelector("hui-root");
    const huiRootShadow = huiRoot?.shadowRoot;
    const path = globalThis.location?.pathname
      ?.split("/")
      .filter(Boolean)[0];
    const component =
      homeAssistant?.hass?.panels?.[path]?.component_name ||
      activePanel?.localName?.replace(/^ha-panel-/, "");
    const isDashboardPanel = DASHBOARD_PANEL_COMPONENTS.has(component);

    return {
      main,
      sidebar,
      menuButton: huiRootShadow?.querySelector("ha-menu-button"),
      toolbar:
        huiRootShadow?.querySelector("app-toolbar") ||
        huiRootShadow?.querySelector("div.toolbar"),
      view: huiRootShadow?.querySelector("#view"),
      // Scrollbars belong to dashboard views. Do not leave these broad CSS
      // rules active after navigating from kiosk mode into HA settings.
      styleRoots: isDashboardPanel
        ? [document, panelRoot, huiRootShadow].filter(Boolean)
        : [],
    };
  }

  _hideScrollbars(roots = []) {
    if (typeof document.createElement !== "function") return false;

    let changed = false;
    const activeRoots = new Set(roots);
    for (const [root, style] of [...this._scrollbarStyles]) {
      if (activeRoots.has(root)) continue;
      if (typeof style.remove === "function") {
        style.remove();
      } else {
        style.parentNode?.removeChild?.(style);
      }
      this._scrollbarStyles.delete(root);
      changed = true;
    }

    for (const root of activeRoots) {
      if (this._scrollbarStyles.has(root)) continue;

      const target =
        root === document
          ? document.head || document.documentElement || document.body
          : root;
      if (typeof target?.appendChild !== "function") continue;

      const style = document.createElement("style");
      style.setAttribute(KIOSK_SCROLLBAR_STYLE_ATTRIBUTE, "true");
      style.textContent =
        root === document
          ? `html, body, * {
              scrollbar-width: none !important;
              -ms-overflow-style: none !important;
            }
            html::-webkit-scrollbar,
            body::-webkit-scrollbar,
            *::-webkit-scrollbar {
              width: 0 !important;
              height: 0 !important;
              display: none !important;
              background: transparent !important;
            }`
          : `:host, * {
              scrollbar-width: none !important;
              -ms-overflow-style: none !important;
            }
            :host::-webkit-scrollbar,
            *::-webkit-scrollbar {
              width: 0 !important;
              height: 0 !important;
              display: none !important;
              background: transparent !important;
            }`;
      target.appendChild(style);
      this._scrollbarStyles.set(root, style);
      changed = true;
    }
    return changed;
  }

  _setStyle(element, property, value) {
    let saved = this._savedStyles.get(element);
    if (!saved) {
      saved = new Map();
      this._savedStyles.set(element, saved);
    }
    if (!saved.has(property)) {
      saved.set(property, {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      });
    }
    if (
      element.style.getPropertyValue(property) === value &&
      element.style.getPropertyPriority(property) === "important"
    ) {
      return false;
    }
    element.style.setProperty(property, value, "important");
    return true;
  }

  _restore() {
    let changed = false;
    for (const [element, properties] of this._savedStyles) {
      for (const [property, original] of properties) {
        if (original.value) {
          element.style.setProperty(property, original.value, original.priority);
        } else {
          element.style.removeProperty(property);
        }
        changed = true;
      }
    }
    this._savedStyles.clear();
    for (const style of this._scrollbarStyles.values()) {
      if (typeof style.remove === "function") {
        style.remove();
      } else {
        style.parentNode?.removeChild?.(style);
      }
      changed = true;
    }
    this._scrollbarStyles.clear();
    changed = this._restoreMarker() || changed;
    if (changed && globalThis.window) window.dispatchEvent(new Event("resize"));
  }

  _restoreMarker() {
    if (!this._markerBody) return false;
    if (this._markerValue === null) {
      this._markerBody.removeAttribute("data-ha-wallpanel-kiosk");
    } else {
      this._markerBody.setAttribute("data-ha-wallpanel-kiosk", this._markerValue);
    }
    this._markerBody = undefined;
    this._markerValue = undefined;
    return true;
  }

  _ensureUrlParameter() {
    const additions = [];
    if (!hasKioskParameter()) additions.push("kiosk");
    if (this._embeddedSession && !hasEmbeddedParameter()) {
      additions.push("ha-wallpanel-embedded=1");
    }
    if (additions.length === 0) return;
    const separator = window.location.search ? "&" : "?";
    const target = `${window.location.pathname}${window.location.search}${separator}${additions.join("&")}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", target);
  }

  _removeUrlParameter() {
    if (!hasKioskParameter()) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("kiosk");
    const search = url.searchParams.toString();
    const target = `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
    window.history.replaceState(window.history.state, "", target);
  }

  _onNavigation() {
    if (this._sessionActive) this._ensureUrlParameter();
    window.requestAnimationFrame(() => this.sync());
    window.setTimeout(() => this.sync(), 250);
  }
}

export class WallpanelSettingsController {
  constructor() {
    this._activeFlow = undefined;
    this._scrollDialogs = new Map();
    this._cardButtons = new Map();
    this._flowHooks = new Map();
    this._knownFlows = new WeakSet();
    this._openingCardBrowser = false;
    this._openingCardEditor = false;
    this._openingCardDesigner = false;
    this._activeCardDesigner = undefined;
    this._activeCardScaleDialog = undefined;
    this._lovelaceLoadPromise = undefined;
    this._lovelaceTranslationPromise = undefined;
    this._lovelaceResourcesPromise = undefined;
    this._lovelaceResourceLoads = new Map();
    this._cardBrowserHassProxy = undefined;
  }

  sync() {
    this._removeDisconnectedHooks();
    let flow = this._activeFlow;
    if (!flow || flow.isConnected === false) {
      flow = findElementsDeep(document, "dialog-data-entry-flow").find(
        (element) =>
          this._knownFlows.has(element) || this._isWallpanelFlow(element),
      );
      this._activeFlow = flow;
    }
    if (!flow) return;
    this._knownFlows.add(flow);
    this._enableAutoClose(flow);
    if (flow._step?.type === "create_entry") {
      this._closeSettingsFlow(flow);
      return;
    }

    const dialog = flow.shadowRoot?.querySelector("ha-dialog");
    if (dialog) this._enableDialogScroll(dialog);

    const cardSelector = findElementsDeep(
      flow.shadowRoot,
      "ha-selector-object",
    ).find((element) => Boolean(element.selector?.object?.fields?.card));
    if (cardSelector) this._enableNativeCardAdd(cardSelector);

    const colorSelector = findElementsDeep(
      flow.shadowRoot,
      "ha-selector-object",
    ).find((element) => Boolean(element.selector?.object?.fields?.color));
    if (colorSelector) this._enhanceColorPreviews(colorSelector);

    this._setupPanelEditor(flow);
    this._compactTimeFields(flow);
  }

  stop() {
    this._activeFlow = undefined;
    for (const [dialog, hook] of this._scrollDialogs) {
      hook.body.removeEventListener("wheel", hook.listener, true);
      this._restoreStyles(dialog, hook.dialogStyles);
      this._restoreStyles(hook.body, hook.bodyStyles);
    }
    this._scrollDialogs.clear();

    for (const [button, hook] of this._cardButtons) {
      button.removeEventListener("click", hook.listener, true);
    }
    this._cardButtons.clear();

    for (const [flow, listener] of this._flowHooks) {
      flow.removeEventListener("flow-update", listener, true);
    }
    this._flowHooks.clear();

    this._activeCardDesigner?.close?.();
    this._activeCardDesigner = undefined;
    this._activeCardScaleDialog?.close?.();
    this._activeCardScaleDialog = undefined;
  }

  _isWallpanelFlow(flow) {
    const directMatch =
      flow?._handler === DOMAIN ||
      flow?._step?.handler === DOMAIN ||
      flow?._params?.startFlowHandler === DOMAIN;
    if (directMatch) return true;

    // Options flows use the config-entry id as their handler. The complete,
    // domain-specific field set therefore identifies an already configured
    // HA-Wallpanel entry without relying on a translated title.
    const fields = new Set(
      Array.isArray(flow?._step?.data_schema)
        ? flow._step.data_schema.map((item) => item?.name)
        : [],
    );
    return [
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
      "dashboard_brightness",
      "screensaver_brightness",
      "brightness_schedule_enabled",
      "brightness_schedule_start",
      "brightness_schedule_end",
      "brightness_schedule_dashboard",
      "brightness_schedule_screensaver",
      "idle_time",
      "display_time",
      "transition_time",
      "shuffle",
      "show_progress",
      "hide_cursor",
    ].every((name) => fields.has(name));
  }

  _enableAutoClose(flow) {
    if (this._flowHooks.has(flow)) return;
    const listener = (event) => {
      const result = event.detail?.stepPromise || event.detail?.step;
      if (!result) return;
      Promise.resolve(result).then((step) => {
        if (step?.type !== "create_entry") return;
        // Let dialog-data-entry-flow finish its own asynchronous _processStep
        // first. Closing it earlier would still classify the old form as dirty.
        window.setTimeout(() => this._closeSettingsFlow(flow), 100);
      });
    };
    flow.addEventListener("flow-update", listener, true);
    this._flowHooks.set(flow, listener);
  }

  _closeSettingsFlow(flow) {
    flow.closeDialog?.();
  }

  _setupPanelEditor(flow) {
    const form = findElementsDeep(flow.shadowRoot, "ha-form")[0];
    const root = form?.shadowRoot?.querySelector(".root");
    if (!root) return;

    const fields = new Map(
      [...root.children]
        .filter((field) => typeof field.name === "string")
        .map((field) => [field.name, field]),
    );
    const enabledField = fields.get("enabled");
    const viewField = fields.get("views");
    const cardField = fields.get("cards");
    const colorField = fields.get("colors");
    const orderField = fields.get("panel_order");
    const scheduleEnabledField = fields.get("schedule_enabled");
    const scheduleStartField = fields.get("schedule_start");
    const scheduleEndField = fields.get("schedule_end");
    const scheduleModeField = fields.get("schedule_mode");
    const schedulePanelField = fields.get("schedule_panel");
    const dashboardBrightnessField = fields.get("dashboard_brightness");
    const screensaverBrightnessField = fields.get("screensaver_brightness");
    const brightnessScheduleEnabledField = fields.get(
      "brightness_schedule_enabled",
    );
    const brightnessScheduleStartField = fields.get("brightness_schedule_start");
    const brightnessScheduleEndField = fields.get("brightness_schedule_end");
    const brightnessScheduleDashboardField = fields.get(
      "brightness_schedule_dashboard",
    );
    const brightnessScheduleScreensaverField = fields.get(
      "brightness_schedule_screensaver",
    );
    if (!enabledField || !viewField || !cardField || !colorField || !orderField) {
      return;
    }

    const viewSelector = findElementsDeep(
      viewField.shadowRoot,
      "ha-selector-select",
    )[0];
    const cardSelector = findElementsDeep(
      cardField.shadowRoot,
      "ha-selector-object",
    )[0];
    const colorSelector = findElementsDeep(
      colorField.shadowRoot,
      "ha-selector-object",
    )[0];
    if (!viewSelector || !cardSelector || !colorSelector) return;

    for (const field of [
      viewField,
      cardField,
      colorField,
      orderField,
      schedulePanelField,
    ]) {
      if (!field) continue;
      this._hideSourceField(field);
    }

    let editor = root.querySelector("[data-ha-wallpanel-panel-editor]");
    if (!editor) {
      editor = this._createPanelEditor();
      enabledField.after(editor);
    } else if (enabledField.nextElementSibling !== editor) {
      enabledField.after(editor);
    }

    const views = Array.isArray(viewField.value) ? [...viewField.value] : [];
    const cards = Array.isArray(cardSelector.value)
      ? cardSelector.value.map((item) => ({ ...item }))
      : [];
    const colors = Array.isArray(colorSelector.value)
      ? colorSelector.value.map((item) => ({ ...item }))
      : [];
    const order = this._canonicalPanelOrder(
      orderField.value,
      views,
      cards,
      colors,
    );
    const serializedOrder = JSON.stringify(order);
    if (String(orderField.value || "") !== serializedOrder) {
      this._dispatchValue(orderField, serializedOrder);
    }

    editor._wallpanelState = {
      viewField,
      cardField,
      colorField,
      orderField,
      viewSelector,
      cardSelector,
      colorSelector,
      views,
      cards,
      colors,
      order,
      scheduleEnabledField,
      scheduleStartField,
      scheduleEndField,
      scheduleModeField,
      schedulePanelField,
      dashboardBrightnessField,
      screensaverBrightnessField,
      brightnessScheduleEnabledField,
      brightnessScheduleStartField,
      brightnessScheduleEndField,
      brightnessScheduleDashboardField,
      brightnessScheduleScreensaverField,
    };
    this._renderPanelEditor(editor);
    this._setupBrightnessEditor(root, editor);
    this._setupScheduleEditor(root, editor);
  }

  _setupBrightnessEditor(root, editor) {
    const state = editor._wallpanelState;
    if (
      !state?.dashboardBrightnessField ||
      !state.screensaverBrightnessField ||
      !state.brightnessScheduleEnabledField ||
      !state.brightnessScheduleStartField ||
      !state.brightnessScheduleEndField ||
      !state.brightnessScheduleDashboardField ||
      !state.brightnessScheduleScreensaverField
    ) {
      return;
    }

    let heading = root.querySelector("[data-ha-wallpanel-brightness-heading]");
    if (!heading) {
      heading = document.createElement("div");
      heading.dataset.haWallpanelBrightnessHeading = "";
      const title = document.createElement("div");
      title.textContent = "Helligkeit";
      Object.assign(title.style, {
        color: "var(--primary-text-color)",
        fontSize: "18px",
        fontWeight: "500",
      });
      const description = document.createElement("div");
      description.textContent =
        "Dashboard und Screensaver werden getrennt über berührungslose Overlays abgedunkelt.";
      Object.assign(description.style, {
        color: "var(--secondary-text-color)",
        fontSize: "13px",
        lineHeight: "1.4",
        marginTop: "4px",
      });
      Object.assign(heading.style, {
        margin: "4px 0 14px",
        minWidth: "0",
      });
      heading.append(title, description);
    }
    if (state.dashboardBrightnessField.previousElementSibling !== heading) {
      state.dashboardBrightnessField.before(heading);
    }

    let scheduleHeading = root.querySelector(
      "[data-ha-wallpanel-brightness-schedule-heading]",
    );
    if (!scheduleHeading) {
      scheduleHeading = document.createElement("div");
      scheduleHeading.dataset.haWallpanelBrightnessScheduleHeading = "";
      scheduleHeading.textContent = "Zeitgesteuerte Helligkeit";
      Object.assign(scheduleHeading.style, {
        color: "var(--primary-text-color)",
        fontSize: "16px",
        fontWeight: "500",
        margin: "8px 0 8px",
        minWidth: "0",
      });
    }
    if (
      state.brightnessScheduleEnabledField.previousElementSibling !==
      scheduleHeading
    ) {
      state.brightnessScheduleEnabledField.before(scheduleHeading);
    }

    const scheduledFields = [
      state.brightnessScheduleStartField,
      state.brightnessScheduleEndField,
      state.brightnessScheduleDashboardField,
      state.brightnessScheduleScreensaverField,
    ];
    const updateVisibility = () => {
      const visible = Boolean(state.brightnessScheduleEnabledField.value);
      for (const field of scheduledFields) {
        field.hidden = !visible;
        field.style.setProperty(
          "display",
          visible ? "block" : "none",
          "important",
        );
      }
    };
    if (!state.brightnessScheduleEnabledField._wallpanelBrightnessListener) {
      const listener = () => {
        if (globalThis.window?.requestAnimationFrame) {
          window.requestAnimationFrame(updateVisibility);
        } else {
          updateVisibility();
        }
      };
      state.brightnessScheduleEnabledField.addEventListener(
        "value-changed",
        listener,
      );
      state.brightnessScheduleEnabledField._wallpanelBrightnessListener =
        listener;
    }
    updateVisibility();
  }

  _setupScheduleEditor(root, editor) {
    const state = editor._wallpanelState;
    if (
      !state?.scheduleEnabledField ||
      !state.scheduleStartField ||
      !state.scheduleEndField ||
      !state.scheduleModeField ||
      !state.schedulePanelField
    ) {
      return;
    }

    let heading = root.querySelector("[data-ha-wallpanel-schedule-heading]");
    if (!heading) {
      heading = document.createElement("div");
      heading.dataset.haWallpanelScheduleHeading = "";
      const title = document.createElement("div");
      title.textContent = "Täglicher Zeitplan";
      Object.assign(title.style, {
        color: "var(--primary-text-color)",
        fontSize: "18px",
        fontWeight: "500",
      });
      const description = document.createElement("div");
      description.textContent =
        "Der Zeitraum darf über Mitternacht gehen. Danach läuft wieder die normale Rotation.";
      Object.assign(description.style, {
        color: "var(--secondary-text-color)",
        fontSize: "13px",
        lineHeight: "1.4",
        marginTop: "4px",
      });
      Object.assign(heading.style, {
        margin: "4px 0 14px",
        minWidth: "0",
      });
      heading.append(title, description);
    }
    if (state.scheduleEnabledField.previousElementSibling !== heading) {
      state.scheduleEnabledField.before(heading);
    }

    let panelPicker = root.querySelector(
      "[data-ha-wallpanel-schedule-panel-picker]",
    );
    if (!panelPicker) {
      panelPicker = document.createElement("label");
      panelPicker.dataset.haWallpanelSchedulePanelPicker = "";
      const label = document.createElement("span");
      label.textContent = "Statisches Panel";
      Object.assign(label.style, {
        display: "block",
        color: "var(--primary-text-color)",
        fontSize: "12px",
        marginBottom: "6px",
      });
      const select = document.createElement("select");
      select.setAttribute("aria-label", "Statisches Panel");
      Object.assign(select.style, {
        display: "block",
        width: "100%",
        height: "48px",
        padding: "0 12px",
        border: "1px solid var(--outline-color, var(--divider-color))",
        borderRadius: "10px",
        boxSizing: "border-box",
        color: "var(--primary-text-color)",
        background: "var(--card-background-color)",
        font: "inherit",
      });
      select.addEventListener("change", () => {
        const currentState = editor._wallpanelState;
        if (!currentState?.schedulePanelField) return;
        this._dispatchValue(currentState.schedulePanelField, select.value);
      });
      panelPicker.append(label, select);
      panelPicker._wallpanelSelect = select;
      Object.assign(panelPicker.style, {
        display: "block",
        marginBottom: "16px",
        minWidth: "0",
      });
      const updateVisibility = () => {
        const mode = editor._wallpanelState?.scheduleModeField?.value;
        this._setSchedulePanelVisibility(panelPicker, mode);
      };
      panelPicker._wallpanelUpdateVisibility = updateVisibility;
      state.scheduleModeField.addEventListener("value-changed", () => {
        window.requestAnimationFrame(updateVisibility);
      });
    }
    if (state.scheduleModeField.nextElementSibling !== panelPicker) {
      state.scheduleModeField.after(panelPicker);
    }

    const select = panelPicker._wallpanelSelect;
    const current = String(state.schedulePanelField.value || "");
    const optionsKey = JSON.stringify(
      state.order.map((token) => [
        token,
        this._panelDescriptor(state, token).label,
      ]),
    );
    if (panelPicker._wallpanelOptionsKey !== optionsKey) {
      panelPicker._wallpanelOptionsKey = optionsKey;
      select.replaceChildren();
      for (const token of state.order) {
        const descriptor = this._panelDescriptor(state, token);
        const option = document.createElement("option");
        option.value = token;
        option.textContent = `${descriptor.kindLabel}: ${descriptor.label}`;
        select.appendChild(option);
      }
    }
    const value = state.order.includes(current) ? current : state.order[0] || "";
    select.value = value;
    select.disabled = state.order.length === 0;
    panelPicker._wallpanelUpdateVisibility?.();
    if (value && current !== value) {
      this._dispatchValue(state.schedulePanelField, value);
    }
  }

  _setSchedulePanelVisibility(panelPicker, mode) {
    const visible = mode === "static";
    panelPicker.hidden = !visible;
    panelPicker.style.setProperty(
      "display",
      visible ? "block" : "none",
      "important",
    );
  }

  _hideSourceField(field) {
    field.setAttribute("aria-hidden", "true");
    field.style.setProperty("position", "fixed", "important");
    field.style.setProperty("left", "-10000px", "important");
    field.style.setProperty("top", "0", "important");
    field.style.setProperty("width", "480px", "important");
    field.style.setProperty("height", "1px", "important");
    field.style.setProperty("margin", "0", "important");
    field.style.setProperty("overflow", "hidden", "important");
    field.style.setProperty("pointer-events", "none", "important");
  }

  _createPanelEditor() {
    const editor = document.createElement("section");
    editor.dataset.haWallpanelPanelEditor = "";
    editor.style.setProperty("display", "block", "important");
    editor.style.setProperty("min-width", "0", "important");
    editor.style.setProperty("margin", "4px 0 18px", "important");

    const responsiveStyle = document.createElement("style");
    responsiveStyle.textContent = `
      [data-ha-wallpanel-panel-editor] .ha-wallpanel-panel-actions > ha-button {
        flex: 0 0 48px !important;
        width: 48px !important;
        min-width: 0 !important;
      }
      [data-ha-wallpanel-panel-editor] .ha-wallpanel-action-icon {
        display: inline-flex !important;
      }
      @media (max-width: 600px) {
        [data-ha-wallpanel-panel-editor] .ha-wallpanel-panel-toolbar {
          display: grid !important;
          grid-template-columns: minmax(0, 1fr) !important;
          width: 100% !important;
        }
        [data-ha-wallpanel-panel-editor] .ha-wallpanel-panel-toolbar > ha-button {
          width: 100% !important;
          min-width: 0 !important;
        }
        [data-ha-wallpanel-panel-editor] .ha-wallpanel-panel-item {
          flex-direction: column !important;
          align-items: stretch !important;
          gap: 4px !important;
          padding: 10px 0 !important;
        }
        [data-ha-wallpanel-panel-editor] .ha-wallpanel-panel-summary {
          width: 100% !important;
        }
        [data-ha-wallpanel-panel-editor] .ha-wallpanel-panel-actions {
          display: flex !important;
          flex-wrap: nowrap !important;
          justify-content: flex-end !important;
          width: 100% !important;
          gap: 4px !important;
        }
        [data-ha-wallpanel-panel-editor] .ha-wallpanel-panel-actions > ha-button {
          flex: 0 0 48px !important;
          width: 48px !important;
          min-width: 0 !important;
        }
      }
    `;

    const toolbar = document.createElement("div");
    toolbar.className = "ha-wallpanel-panel-toolbar";
    Object.assign(toolbar.style, {
      display: "flex",
      flexWrap: "wrap",
      gap: "10px",
      margin: "0 0 18px",
    });

    const actions = [
      ["view", "Ansicht hinzufügen"],
      ["card", "Dashboard-Karte hinzufügen"],
      ["color", "Farbe hinzufügen"],
    ];
    for (const [action, label] of actions) {
      const button = document.createElement("ha-button");
      button.dataset.action = action;
      button.textContent = label;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._handlePanelAdd(editor, action, button);
      });
      toolbar.appendChild(button);
    }

    const heading = document.createElement("div");
    heading.textContent = "Screensaver-Reihenfolge";
    Object.assign(heading.style, {
      color: "var(--primary-text-color)",
      fontSize: "16px",
      fontWeight: "500",
      margin: "0 0 8px",
    });

    const empty = document.createElement("div");
    empty.className = "ha-wallpanel-panel-empty";
    empty.textContent = "Noch keine Screensaver-Elemente hinzugefügt.";
    Object.assign(empty.style, {
      color: "var(--secondary-text-color)",
      padding: "12px 0",
    });

    const sortable = document.createElement("ha-sortable");
    sortable.className = "ha-wallpanel-panel-list";
    sortable.setAttribute("handle-selector", ".ha-wallpanel-panel-handle");
    sortable.setAttribute("draggable-selector", ".ha-wallpanel-panel-item");
    sortable.rollback = false;
    sortable.addEventListener("item-moved", (event) => {
      this._movePanel(editor, event.detail?.oldIndex, event.detail?.newIndex);
    });
    const sortableContainer = document.createElement("div");
    sortableContainer.className = "ha-wallpanel-panel-list-content";
    sortable.appendChild(sortableContainer);

    editor.append(responsiveStyle, toolbar, heading, empty, sortable);
    editor._wallpanelElements = {
      toolbar,
      heading,
      empty,
      sortable,
      sortableContainer,
    };
    return editor;
  }

  _handlePanelAdd(editor, action, button) {
    const state = editor._wallpanelState;
    if (!state) return;
    if (action === "view") {
      const picker = findElementsDeep(
        state.viewSelector.shadowRoot,
        "ha-generic-picker",
      )[0];
      if (picker) {
        picker.popoverAnchor = button;
        picker.open?.();
        return;
      }
      findElementsDeep(state.viewSelector.shadowRoot, "ha-select")[0]?.click?.();
      return;
    }
    if (action === "card") {
      void this._openNativeCardBrowser(state.cardSelector);
      return;
    }
    this._openColorAddDialog(state.colorSelector);
  }

  _openColorAddDialog(selector) {
    const addButton = selector.shadowRoot?.querySelector(
      ".items-container > ha-button",
    );
    if (!addButton) return;

    const seedBlack = (event) => {
      if (event.detail?.dialogTag !== "dialog-form") return;
      const params = event.detail.dialogParams;
      const schema = Array.isArray(params?.schema) ? params.schema : [];
      if (!schema.some((field) => field?.name === "color")) return;
      event.detail.dialogParams = {
        ...params,
        data: { color: "#000000", ...(params.data || {}) },
      };
    };
    // Home Assistant's object selector opens its form dialog synchronously.
    // Seeding the data is necessary because an untouched <input type="color">
    // visually shows black but otherwise submits no value for the required field.
    window.addEventListener("show-dialog", seedBlack, true);
    try {
      addButton.click();
    } finally {
      window.removeEventListener("show-dialog", seedBlack, true);
    }
  }

  _decodePanelOrder(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" || !value.trim()) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  _canonicalPanelOrder(value, views, cards, colors) {
    const valid = new Set([
      ...views.map((path) => `view:${path}`),
      ...cards.map((_, index) => `card:${index}`),
      ...colors.map((_, index) => `color:${index}`),
    ]);
    const order = [];
    for (const token of this._decodePanelOrder(value)) {
      if (valid.has(token) && !order.includes(token)) order.push(token);
    }
    for (const token of valid) {
      if (!order.includes(token)) order.push(token);
    }
    return order;
  }

  _panelDescriptor(state, token) {
    if (token.startsWith("view:")) {
      const path = token.slice(5);
      const options = state.viewSelector.selector?.select?.options || [];
      const option = options.find((item) =>
        typeof item === "string" ? item === path : item?.value === path,
      );
      return {
        kind: "view",
        kindLabel: "Ansicht",
        label: typeof option === "string" ? option : option?.label || path,
        index: state.views.indexOf(path),
      };
    }
    const [kind, rawIndex] = token.split(":");
    const index = Number(rawIndex);
    if (kind === "card") {
      const card = state.cards[index];
      return {
        kind,
        kindLabel: `Dashboard-Karte · ${cardScale(card?.scale, index)} %`,
        label: String(card?.name || card?.card?.title || `Karte ${index + 1}`),
        index,
      };
    }
    const color = String(state.colors[index]?.color || "#000000").toUpperCase();
    return { kind: "color", kindLabel: "Farbe", label: color, color, index };
  }

  _renderPanelEditor(editor) {
    const state = editor._wallpanelState;
    const elements = editor._wallpanelElements;
    if (!state || !elements) return;
    const key = JSON.stringify({
      order: state.order,
      views: state.views,
      cards: state.cards,
      colors: state.colors,
    });
    if (editor._wallpanelRenderKey === key) return;
    editor._wallpanelRenderKey = key;
    elements.empty.hidden = state.order.length > 0;
    elements.sortableContainer.replaceChildren();

    for (const token of state.order) {
      const descriptor = this._panelDescriptor(state, token);
      const row = document.createElement("div");
      row.className = "ha-wallpanel-panel-item";
      row.dataset.token = token;
      Object.assign(row.style, {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        minHeight: "52px",
        padding: "6px 0",
        borderBottom: "1px solid var(--divider-color)",
        boxSizing: "border-box",
      });

      const summary = document.createElement("div");
      summary.className = "ha-wallpanel-panel-summary";
      Object.assign(summary.style, {
        display: "flex",
        flex: "1 1 auto",
        alignItems: "center",
        gap: "10px",
        minWidth: "0",
      });

      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "ha-wallpanel-panel-handle";
      handle.textContent = "⠿";
      handle.title = "Reihenfolge ändern";
      handle.setAttribute("aria-label", "Reihenfolge ändern");
      Object.assign(handle.style, {
        flex: "0 0 34px",
        width: "34px",
        height: "34px",
        border: "0",
        borderRadius: "50%",
        color: "var(--secondary-text-color)",
        background: "transparent",
        cursor: "grab",
        fontSize: "24px",
        lineHeight: "1",
      });

      if (descriptor.color) {
        const swatch = document.createElement("span");
        swatch.setAttribute("aria-hidden", "true");
        Object.assign(swatch.style, {
          flex: "0 0 26px",
          width: "26px",
          height: "26px",
          border: "1px solid var(--divider-color)",
          borderRadius: "6px",
          boxSizing: "border-box",
          backgroundColor: descriptor.color,
        });
        summary.append(handle, swatch);
      } else {
        summary.append(handle);
      }

      const text = document.createElement("div");
      text.style.flex = "1 1 auto";
      text.style.minWidth = "0";
      const label = document.createElement("div");
      label.textContent = descriptor.label;
      Object.assign(label.style, {
        overflow: "hidden",
        color: "var(--primary-text-color)",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      });
      const kind = document.createElement("div");
      kind.textContent = descriptor.kindLabel;
      Object.assign(kind.style, {
        color: "var(--secondary-text-color)",
        fontSize: "12px",
        marginTop: "2px",
      });
      text.append(label, kind);
      summary.append(text);
      row.append(summary);

      const actions = document.createElement("div");
      actions.className = "ha-wallpanel-panel-actions";
      Object.assign(actions.style, {
        display: "flex",
        flex: "0 0 auto",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: "4px",
        minWidth: "0",
      });

      if (descriptor.kind === "card") {
        const currentScale = cardScale(
          state.cards[descriptor.index]?.scale,
          descriptor.index,
        );
        actions.append(
          this._createPanelIconButton(
            "mdi:resize",
            `Kartengröße einstellen (${currentScale} %)`,
            () => this._openCardScaleDialog(editor, descriptor.index),
          ),
        );
      }

      if (descriptor.kind !== "view") {
        actions.append(
          this._createPanelIconButton("mdi:pencil", "Bearbeiten", () =>
            this._editPanel(editor, token),
          ),
        );
      }

      if (
        descriptor.kind === "card" &&
        this._dashboardDesignerAdapter(state.cards[descriptor.index]?.card)
      ) {
        actions.append(
          this._createPanelIconButton(
            "mdi:palette",
            "Karteneigenen Designer öffnen",
            () => void this._openDashboardCardDesigner(editor, descriptor.index),
          ),
        );
      }

      actions.append(
        this._createPanelIconButton("mdi:delete", "Entfernen", () =>
          this._removePanel(editor, token),
        ),
      );
      row.append(actions);
      elements.sortableContainer.appendChild(row);
    }
  }

  _createPanelIconButton(iconName, label, action) {
    const button = document.createElement("ha-button");
    button.className = "ha-wallpanel-panel-action";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("appearance", "plain");
    const icon = document.createElement("ha-icon");
    icon.className = "ha-wallpanel-action-icon";
    icon.setAttribute("icon", iconName);
    button.append(icon);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return button;
  }

  _editPanel(editor, token) {
    const state = editor._wallpanelState;
    const descriptor = this._panelDescriptor(state, token);
    if (descriptor.kind === "card") {
      void this._openNativeCardEditor(editor, descriptor.index);
      return;
    }
    const selector = state.colorSelector;
    const item = selector.shadowRoot?.querySelectorAll(".item")?.[descriptor.index];
    const buttons = item?.querySelectorAll("ha-icon-button, mwc-icon-button") || [];
    buttons[0]?.click();
  }

  _openCardScaleDialog(editor, index) {
    if (this._activeCardScaleDialog) return;
    const state = editor?._wallpanelState;
    const storedCard = state?.cards?.[index];
    if (!storedCard) return;

    const initialScale = cardScale(storedCard.scale, index);
    const host = document.createElement("dialog");
    host.className = "ha-wallpanel-card-scale-dialog";
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    Object.assign(host.style, {
      width: "min(420px, calc(100vw - 32px))",
      maxWidth: "420px",
      margin: "auto",
      padding: "0",
      border: "0",
      borderRadius: "24px",
      boxSizing: "border-box",
      overflow: "hidden",
      color: "var(--primary-text-color)",
      background: "var(--card-background-color, #1c1c1c)",
      boxShadow: "0 12px 42px rgba(0, 0, 0, 0.45)",
    });

    const dialogStyle = document.createElement("style");
    dialogStyle.textContent = `
      .ha-wallpanel-card-scale-dialog::backdrop {
        background: rgba(0, 0, 0, 0.55);
      }
      .ha-wallpanel-card-scale-dialog input[type="range"] {
        width: 100%;
        margin: 18px 0 8px;
        accent-color: var(--primary-color, #03a9f4);
      }
    `;

    const body = document.createElement("div");
    Object.assign(body.style, {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      padding: "24px",
      boxSizing: "border-box",
    });

    const title = document.createElement("h2");
    title.id = "ha-wallpanel-card-scale-title";
    title.textContent = "Kartengröße";
    Object.assign(title.style, {
      margin: "0",
      fontSize: "22px",
      fontWeight: "500",
    });
    host.setAttribute("aria-labelledby", title.id);

    const cardName = document.createElement("div");
    cardName.textContent = String(
      storedCard.name || storedCard.card?.title || `Karte ${index + 1}`,
    );
    Object.assign(cardName.style, {
      overflow: "hidden",
      color: "var(--secondary-text-color)",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });

    const value = document.createElement("output");
    value.textContent = `${initialScale} %`;
    Object.assign(value.style, {
      marginTop: "12px",
      color: "var(--primary-text-color)",
      fontSize: "32px",
      fontWeight: "500",
      textAlign: "center",
    });

    const range = document.createElement("input");
    range.type = "range";
    range.min = "50";
    range.max = "300";
    range.step = "25";
    range.value = String(initialScale);
    range.setAttribute("aria-label", "Kartengröße in Prozent");
    range.addEventListener("input", () => {
      value.textContent = `${range.value} %`;
    });

    const limits = document.createElement("div");
    Object.assign(limits.style, {
      display: "flex",
      justifyContent: "space-between",
      color: "var(--secondary-text-color)",
      fontSize: "12px",
    });
    const minimum = document.createElement("span");
    minimum.textContent = "50 %";
    const maximum = document.createElement("span");
    maximum.textContent = "300 %";
    limits.append(minimum, maximum);

    const actions = document.createElement("div");
    Object.assign(actions.style, {
      display: "flex",
      justifyContent: "flex-end",
      gap: "8px",
      marginTop: "18px",
    });
    const cancel = document.createElement("ha-button");
    cancel.textContent = "Abbrechen";
    cancel.setAttribute("appearance", "plain");
    const save = document.createElement("ha-button");
    save.textContent = "Übernehmen";
    actions.append(cancel, save);
    body.append(title, cardName, value, range, limits, actions);
    host.append(dialogStyle, body);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      host.removeEventListener("cancel", onCancel);
      if (host.open && typeof host.close === "function") host.close();
      host.remove();
      if (this._activeCardScaleDialog?.host === host) {
        this._activeCardScaleDialog = undefined;
      }
    };
    const onCancel = (event) => {
      event.preventDefault();
      close();
    };
    cancel.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      close();
    });
    save.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this._setCardScale(editor, index, Number(range.value));
      close();
    });
    host.addEventListener("cancel", onCancel);

    const mountRoot = document.body || this._getDialogMountRoot();
    if (!mountRoot) return;
    this._activeCardScaleDialog = { host, close };
    mountRoot.appendChild(host);
    if (typeof host.showModal === "function") host.showModal();
    else host.setAttribute("open", "");
    window.requestAnimationFrame(() => range.focus());
  }

  _setCardScale(editor, index, scale) {
    const state = editor._wallpanelState;
    if (!state?.cards?.[index]) return;
    const nextScale = Math.max(50, Math.min(300, Math.round(scale / 25) * 25));
    state.cards = state.cards.map((item, itemIndex) =>
      itemIndex === index ? { ...item, scale: nextScale } : item,
    );
    this._dispatchValue(state.cardSelector, state.cards);
    editor._wallpanelRenderKey = undefined;
    this._renderPanelEditor(editor);
  }

  _dashboardDesignerAdapter(cardConfig) {
    const type = String(cardConfig?.type || "").trim().toLowerCase();
    return DASHBOARD_DESIGNER_ADAPTERS[type];
  }

  async _openDashboardCardDesigner(editor, index) {
    if (this._openingCardDesigner || this._activeCardDesigner) return;
    const state = editor._wallpanelState;
    const cardConfig = state?.cards?.[index]?.card;
    const adapter = this._dashboardDesignerAdapter(cardConfig);
    if (!state || !cardConfig || !adapter) return;
    const hass =
      state.cardSelector?.hass || document.querySelector("home-assistant")?.hass;
    if (!hass) return;

    this._openingCardDesigner = true;
    let surface;
    try {
      await this._prepareCardBrowserContext(hass);
      await waitFor(() => customElements.get(adapter.elementName), 5000);
      surface = this._createDashboardDesignerSurface(
        editor,
        index,
        cardConfig,
        adapter,
        this._createCardBrowserHass(hass),
      );
      // Safari can size a modal dialog against the wrong containing block when
      // it is opened from inside Home Assistant's nested shadow roots. A native
      // dialog mounted at document level still enters the top layer and uses the
      // real viewport as its containing block.
      const mountRoot = document.body || this._getDialogMountRoot();
      if (!mountRoot) {
        throw new Error("Home Assistants Dialogbereich ist nicht verfügbar.");
      }
      mountRoot.appendChild(surface.host);
      if (typeof surface.host.showModal === "function") {
        surface.host.showModal();
      } else {
        surface.host.setAttribute("open", "");
      }
      surface.fitToViewport?.();
      await surface.activate?.();
      this._activeCardDesigner = surface;
    } catch (error) {
      surface?.host?.remove();
      console.error("HA-Wallpanel: Kartendesigner konnte nicht geöffnet werden", error);
      this._showCardBrowserError(
        state.cardSelector,
        "Der karteneigene Designer konnte nicht geladen werden.",
      );
    } finally {
      this._openingCardDesigner = false;
    }
  }

  _createDashboardDesignerSurface(editor, index, cardConfig, adapter, hass) {
    const workingConfig = {
      views: [
        {
          title: "HA-Wallpanel",
          path: "ha-wallpanel-card-designer",
          type: "panel",
          cards: [cardConfig],
        },
      ],
    };
    const lovelace = {
      config: workingConfig,
      rawConfig: workingConfig,
      editMode: true,
      mode: "storage",
      urlPath: "ha-wallpanel-card-designer",
      locale: hass.locale,
      saveConfig: async (newConfig) => {
        const updatedCard = newConfig?.views?.[0]?.cards?.[0];
        if (!updatedCard) {
          throw new Error("Der Kartendesigner hat keine gültige Karte gespeichert.");
        }
        this._replaceEditedCard(editor, index, updatedCard);
      },
      deleteConfig: async () => {},
      showToast: () => {},
    };
    const fakeRoot = { lovelace, ___curView: 0 };
    // A native modal dialog enters the browser's top layer. Home Assistant's
    // options dialog lives there as well, so z-index alone cannot place a normal
    // fixed element above it.
    const host = document.createElement("dialog");
    host.className = "ha-wallpanel-card-designer";
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    host.setAttribute("aria-label", "Kartendesigner");
    Object.assign(host.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      display: "flex",
      flexDirection: "column",
      minWidth: "0",
      minHeight: "0",
      width: "100vw",
      height: "100dvh",
      maxWidth: "none",
      maxHeight: "none",
      margin: "0",
      padding: "0",
      border: "0",
      boxSizing: "border-box",
      overflow: "hidden",
      color: "var(--primary-text-color)",
      background: "var(--primary-background-color, #111318)",
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      zIndex: "1",
      display: "flex",
      flex: "0 0 56px",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "16px",
      minWidth: "0",
      height: "56px",
      padding: "0 16px 0 20px",
      borderBottom: "1px solid var(--divider-color)",
      boxSizing: "border-box",
      background: "var(--app-header-background-color, var(--card-background-color, #1c1c1c))",
      boxShadow: "0 2px 8px rgba(0, 0, 0, 0.28)",
    });
    const title = document.createElement("strong");
    const storedCard = editor?._wallpanelState?.cards?.[index];
    const fallbackName = String(cardConfig.type || "Karte").replace(/^custom:/, "");
    title.textContent = `${String(storedCard?.name || cardConfig.title || fallbackName)} – Designer`;
    Object.assign(title.style, {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });
    const closeButton = document.createElement("ha-button");
    closeButton.textContent = "Speichern & schließen";
    header.append(title, closeButton);

    const body = document.createElement("div");
    Object.assign(body.style, {
      position: "relative",
      display: "block",
      flex: "1 1 auto",
      minWidth: "0",
      minHeight: "0",
      overflow: "hidden",
    });
    const card = document.createElement(adapter.elementName);
    if (typeof card.setConfig !== "function") {
      throw new Error(`Die Karte ${adapter.elementName} ist nicht vollständig geladen.`);
    }
    // This adapter deliberately emulates the two pieces of context used by the
    // card's dashboard-only designer without touching the user's real dashboard.
    card.findHuiRoot = () => fakeRoot;
    card.isPanelPlacement = () => true;
    card.hass = hass;
    card.preview = true;
    card.setConfig(cardConfig);
    Object.assign(card.style, {
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      minHeight: "0",
      maxHeight: "none",
      borderRadius: "0",
    });
    card.style.setProperty("--wcc-dashboard-edit-footer-height", "0px");
    body.appendChild(card);
    host.append(header, body);

    const fitToViewport = () => {
      for (const [property, value] of [
        ["display", "block"],
        ["position", "fixed"],
        ["inset", "0"],
        ["width", "100vw"],
        ["height", "100vh"],
        ["min-height", "100vh"],
        ["max-height", "none"],
        ["margin", "0"],
      ]) {
        host.style.setProperty(property, value, "important");
      }
      for (const [property, value] of [
        ["position", "absolute"],
        ["top", "56px"],
        ["right", "0"],
        ["bottom", "0"],
        ["left", "0"],
        ["height", "auto"],
        ["min-height", "0"],
      ]) {
        body.style.setProperty(property, value, "important");
      }
    };

    const activate = async () => {
      await card.updateComplete;
      // Wall Clock Card has a dedicated fullscreen designer mode. It removes
      // the normal dashboard-card height ceiling and anchors the designer to
      // the viewport below our own close bar.
      card.style.setProperty("--wcc-designer-top", "56px");
      card.setAttribute("designer-fullscreen", "");
      for (const [property, value] of [
        ["position", "fixed"],
        ["top", "56px"],
        ["right", "0"],
        ["bottom", "0"],
        ["left", "0"],
        ["width", "auto"],
        ["height", "auto"],
        ["min-height", "0"],
        ["max-height", "none"],
      ]) {
        card.style.setProperty(property, value, "important");
      }
      card.requestUpdate?.();
      await card.updateComplete;
      const innerDone = card.shadowRoot?.querySelector(".designer-done");
      if (innerDone) innerDone.style.setProperty("display", "none", "important");
      fitToViewport();
    };

    let closed = false;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      void close();
    };
    const onCancel = (event) => {
      event.preventDefault();
      void close();
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      closeButton.disabled = true;
      closeButton.loading = true;
      window.removeEventListener("keydown", onKeyDown, true);
      host.removeEventListener("cancel", onCancel);
      try {
        card.preview = false;
        card.requestUpdate?.("preview", true);
        await card.updateComplete;
        if (typeof card.flushLayoutAutosave === "function") {
          await card.flushLayoutAutosave("commit");
        }
      } catch (error) {
        console.warn("HA-Wallpanel: Letztes Designer-Update konnte nicht bestätigt werden", error);
      } finally {
        if (host.open && typeof host.close === "function") host.close();
        host.remove();
        if (this._activeCardDesigner?.host === host) {
          this._activeCardDesigner = undefined;
        }
      }
    };
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void close();
    });
    window.addEventListener("keydown", onKeyDown, true);
    host.addEventListener("cancel", onCancel);
    return { host, card, close, fitToViewport, activate };
  }

  async _openNativeCardEditor(editor, index) {
    if (this._openingCardEditor) return;
    const state = editor._wallpanelState;
    const cardConfig = state?.cards?.[index]?.card;
    if (!state || !cardConfig) return;
    const hass =
      state.cardSelector?.hass || document.querySelector("home-assistant")?.hass;
    if (!hass) return;

    this._openingCardEditor = true;
    let temporaryHost;
    try {
      await this._prepareCardBrowserContext(hass);
      const launchTarget = await this._createTemporaryCardView(
        this._createCardBrowserHass(hass),
        [cardConfig],
        async (newConfig) => {
          const updatedCard = newConfig?.views?.[0]?.cards?.[0];
          if (updatedCard) this._replaceEditedCard(editor, index, updatedCard);
        },
        true,
      );
      temporaryHost = launchTarget.temporaryHost;
      launchTarget.element.dispatchEvent(
        new CustomEvent("ll-edit-card", {
          detail: { path: [0, 0] },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (error) {
      console.error("HA-Wallpanel: Karteneditor konnte nicht geöffnet werden", error);
      this._showCardBrowserError(
        state.cardSelector,
        "Der visuelle Home-Assistant-Karteneditor konnte nicht geladen werden.",
      );
    } finally {
      temporaryHost?.remove();
      this._openingCardEditor = false;
    }
  }

  _replaceEditedCard(editor, index, cardConfig) {
    const state = editor._wallpanelState;
    if (!state || !state.cards[index]) return;
    const card = fullscreenCardConfig(
      globalThis.structuredClone
        ? structuredClone(cardConfig)
        : JSON.parse(JSON.stringify(cardConfig)),
      index,
    );
    const type = String(card.type || "Karte").replace(/^custom:/, "");
    const translated = state.cardSelector.hass?.localize(
      `ui.panel.lovelace.editor.card.${type}.name`,
    );
    const name = String(card.name || card.title || translated || type);
    const cards = state.cards.map((item, itemIndex) =>
      itemIndex === index
        ? { name, card, scale: cardScale(item.scale, itemIndex) }
        : item,
    );
    state.cards = cards;
    this._dispatchValue(state.cardSelector, cards);
    editor._wallpanelRenderKey = undefined;
    this._renderPanelEditor(editor);
  }

  _removePanel(editor, token) {
    const state = editor._wallpanelState;
    if (!state) return;
    const descriptor = this._panelDescriptor(state, token);
    let order = state.order.filter((item) => item !== token);
    let schedulePanel = String(state.schedulePanelField?.value || "");

    if (descriptor.kind === "view") {
      const views = state.views.filter((_, index) => index !== descriptor.index);
      this._dispatchValue(state.viewField, views);
      state.views = views;
    } else {
      const source = descriptor.kind === "card" ? state.cards : state.colors;
      const values = source.filter((_, index) => index !== descriptor.index);
      const selector =
        descriptor.kind === "card" ? state.cardSelector : state.colorSelector;
      this._dispatchValue(selector, values);
      if (descriptor.kind === "card") state.cards = values;
      else state.colors = values;
      order = order.map((item) => {
        const [kind, rawIndex] = item.split(":");
        const index = Number(rawIndex);
        return kind === descriptor.kind && index > descriptor.index
          ? `${kind}:${index - 1}`
          : item;
      });
      const [scheduledKind, scheduledRawIndex] = schedulePanel.split(":");
      const scheduledIndex = Number(scheduledRawIndex);
      if (
        scheduledKind === descriptor.kind &&
        scheduledIndex > descriptor.index
      ) {
        schedulePanel = `${scheduledKind}:${scheduledIndex - 1}`;
      }
    }

    state.order = order;
    this._dispatchValue(state.orderField, JSON.stringify(order));
    if (state.schedulePanelField) {
      if (!order.includes(schedulePanel)) schedulePanel = order[0] || "";
      this._dispatchValue(state.schedulePanelField, schedulePanel);
    }
    editor._wallpanelRenderKey = undefined;
    this._renderPanelEditor(editor);
  }

  _movePanel(editor, oldIndex, newIndex) {
    const state = editor._wallpanelState;
    if (
      !state ||
      !Number.isInteger(oldIndex) ||
      !Number.isInteger(newIndex) ||
      oldIndex === newIndex ||
      oldIndex < 0 ||
      newIndex < 0 ||
      oldIndex >= state.order.length ||
      newIndex >= state.order.length
    ) {
      return;
    }
    const order = [...state.order];
    const [moved] = order.splice(oldIndex, 1);
    order.splice(newIndex, 0, moved);
    state.order = order;
    this._dispatchValue(state.orderField, JSON.stringify(order));
    editor._wallpanelRenderKey = undefined;
    this._renderPanelEditor(editor);
  }

  _dispatchValue(element, value) {
    element.dispatchEvent(
      new CustomEvent("value-changed", {
        detail: { value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  _enableDialogScroll(dialog) {
    if (this._scrollDialogs.has(dialog)) return;
    const body = dialog.bodyContainer || dialog.shadowRoot?.querySelector(".body");
    if (!body) return;

    const dialogStyles = this._saveAndSetStyles(dialog, {
      "--ha-dialog-max-height": "calc(100dvh - 24px)",
      "--ha-dialog-min-height": "min(720px, calc(100dvh - 24px))",
    });
    const bodyStyles = this._saveAndSetStyles(body, {
      "overflow-y": "auto",
      "min-height": "0",
      "touch-action": "pan-y",
      "overscroll-behavior": "contain",
      "scrollbar-gutter": "stable",
      "-webkit-overflow-scrolling": "touch",
    });
    const listener = (event) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX)
      ) {
        return;
      }
      const path = event.composedPath?.() || [];
      const bodyIndex = path.indexOf(body);
      const innerPath = bodyIndex >= 0 ? path.slice(0, bodyIndex) : path;
      const ownsScrolling = innerPath.some((element) => {
        const name = String(
          element?.localName || element?.tagName || "",
        ).toLowerCase();
        if (
          name === "ha-dialog" ||
          name === "hui-dialog-create-card" ||
          name === "hui-dialog-edit-card" ||
          name === "hui-card-picker"
        ) {
          return true;
        }

        const scrollHeight = Number(element?.scrollHeight);
        const clientHeight = Number(element?.clientHeight);
        const scrollTop = Number(element?.scrollTop);
        if (
          !Number.isFinite(scrollHeight) ||
          !Number.isFinite(clientHeight) ||
          !Number.isFinite(scrollTop) ||
          scrollHeight <= clientHeight
        ) {
          return false;
        }
        return event.deltaY < 0
          ? scrollTop > 0
          : scrollTop + clientHeight < scrollHeight - 1;
      });
      if (ownsScrolling) return;

      const multiplier =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? body.clientHeight : 1;
      const previous = body.scrollTop;
      body.scrollTop += event.deltaY * multiplier;
      if (body.scrollTop !== previous) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    body.addEventListener("wheel", listener, { capture: true, passive: false });
    this._scrollDialogs.set(dialog, {
      body,
      listener,
      dialogStyles,
      bodyStyles,
    });
  }

  _enableNativeCardAdd(selector) {
    const button = selector.shadowRoot?.querySelector(
      ".items-container > ha-button",
    );
    if (!button || this._cardButtons.has(button)) return;

    const listener = (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void this._openNativeCardBrowser(selector);
    };
    button.addEventListener("click", listener, true);
    this._cardButtons.set(button, { listener, selector });
  }

  async _openNativeCardBrowser(selector) {
    if (this._openingCardBrowser) return;
    this._openingCardBrowser = true;
    this._showCardBrowserError(selector, "");

    let temporaryHost;
    let showDialogListener;
    const button = selector.shadowRoot?.querySelector(
      ".items-container > ha-button",
    );
    if (button) {
      button.disabled = true;
      button.loading = true;
      button.setAttribute("aria-busy", "true");
    }
    try {
      const hass =
        selector.hass || document.querySelector("home-assistant")?.hass;
      if (!hass) throw new Error("Home Assistant ist noch nicht verfügbar.");

      await this._prepareCardBrowserContext(hass);
      const launchTarget = await this._getCardLaunchTarget(hass);
      temporaryHost = launchTarget.temporaryHost;
      const saveCard = async (cardConfig) => {
        this._appendCard(selector, cardConfig);
      };
      let intercepted = false;
      showDialogListener = (event) => {
        if (event.detail?.dialogTag !== "hui-dialog-create-card") return;
        intercepted = true;
        event.detail.dialogParams = {
          ...event.detail.dialogParams,
          saveCard,
        };
      };
      window.addEventListener("show-dialog", showDialogListener, true);
      launchTarget.element.dispatchEvent(
        new CustomEvent("ll-create-card", {
          detail: {},
          bubbles: true,
          composed: true,
        }),
      );
      window.removeEventListener("show-dialog", showDialogListener, true);
      showDialogListener = undefined;

      if (!intercepted) {
        throw new Error("Der Home-Assistant-Kartenbrowser wurde nicht geöffnet.");
      }
      await this._selectCardBrowserTab(saveCard, hass);
    } catch (error) {
      console.error("HA-Wallpanel: Kartenbrowser konnte nicht geöffnet werden", error);
      this._showCardBrowserError(
        selector,
        "Der Home-Assistant-Kartenbrowser konnte nicht geladen werden. Bitte lade die Seite neu und versuche es erneut.",
      );
    } finally {
      if (showDialogListener) {
        window.removeEventListener("show-dialog", showDialogListener, true);
      }
      temporaryHost?.remove();
      if (button) {
        button.disabled = false;
        button.loading = false;
        button.removeAttribute("aria-busy");
      }
      this._openingCardBrowser = false;
    }
  }

  async _getCardLaunchTarget(hass) {
    const existingView = findElementsDeep(document, "hui-view").find(
      (view) => view._layoutElement,
    );
    if (existingView) {
      return { element: existingView._layoutElement };
    }

    await this._ensureLovelaceModule(hass);

    return this._createTemporaryCardView(hass);
  }

  async _createTemporaryCardView(
    hass,
    cards = [],
    saveConfig = async () => {},
    editMode = false,
  ) {

    const config = {
      views: [
        {
          title: "HA-Wallpanel",
          path: "ha-wallpanel-card-picker",
          type: "masonry",
          cards,
        },
      ],
    };
    const lovelace = {
      config,
      rawConfig: config,
      editMode,
      mode: "storage",
      urlPath: "ha-wallpanel-card-picker",
      locale: hass.locale,
      saveConfig,
      deleteConfig: async () => {},
      showToast: () => {},
    };
    const temporaryHost = document.createElement("div");
    temporaryHost.setAttribute("aria-hidden", "true");
    Object.assign(temporaryHost.style, {
      position: "fixed",
      left: "-10000px",
      top: "-10000px",
      width: "1px",
      height: "1px",
      overflow: "hidden",
      pointerEvents: "none",
    });
    const view = document.createElement("hui-view");
    view.hass = hass;
    view.lovelace = lovelace;
    view.index = 0;
    view.narrow = false;
    temporaryHost.appendChild(view);
    const dialogMountRoot = this._getDialogMountRoot();
    if (!dialogMountRoot) {
      throw new Error("Home Assistants Dialogbereich ist nicht verfügbar.");
    }
    dialogMountRoot.appendChild(temporaryHost);

    try {
      const element = await waitFor(() => view._layoutElement);
      return { element, temporaryHost };
    } catch (error) {
      temporaryHost.remove();
      throw error;
    }
  }

  _getDialogMountRoot() {
    const homeAssistant = document.querySelector("home-assistant");
    return homeAssistant?.shadowRoot || homeAssistant || document.body;
  }

  async _ensureLovelaceModule(hass) {
    if (customElements.get("hui-view")) return;
    if (!this._lovelaceLoadPromise) {
      this._lovelaceLoadPromise = (async () => {
        const resolver = findElementsDeep(
          document,
          "partial-panel-resolver",
        )[0];
        const dashboard = Object.values(hass.panels || {}).find(
          (panel) => panel.component_name === "lovelace",
        );
        const loader = dashboard
          ? resolver?.routerOptions?.routes?.[dashboard.url_path]?.load
          : undefined;
        if (typeof loader !== "function") {
          throw new Error("Der native Lovelace-Modullader ist nicht verfügbar.");
        }
        await loader();
        await waitFor(() => customElements.get("hui-view"), 5000);
      })().catch((error) => {
        this._lovelaceLoadPromise = undefined;
        throw error;
      });
    }
    await this._lovelaceLoadPromise;
  }

  async _prepareCardBrowserContext(hass) {
    await this._ensureLovelaceModule(hass);
    await Promise.all([
      this._ensureLovelaceTranslations(hass),
      this._ensureLovelaceResources(hass),
    ]);
  }

  async _ensureLovelaceTranslations(hass) {
    if (typeof hass.loadFragmentTranslation !== "function") return;
    if (!this._lovelaceTranslationPromise) {
      this._lovelaceTranslationPromise = hass
        .loadFragmentTranslation("lovelace")
        .catch((error) => {
          this._lovelaceTranslationPromise = undefined;
          console.debug(
            "HA-Wallpanel: Lovelace-Übersetzungen konnten nicht separat geladen werden",
            error,
          );
        });
    }
    await this._lovelaceTranslationPromise;
  }

  async _ensureLovelaceResources(hass) {
    const sendMessage = hass.connection?.sendMessagePromise?.bind(
      hass.connection,
    );
    if (!sendMessage) return;
    if (!this._lovelaceResourcesPromise) {
      this._lovelaceResourcesPromise = (async () => {
        const resources = await sendMessage({ type: "lovelace/resources" });
        if (!Array.isArray(resources)) return;
        await Promise.allSettled(
          resources.map((resource) => this._loadLovelaceResource(resource, hass)),
        );
      })().catch((error) => {
        this._lovelaceResourcesPromise = undefined;
        console.warn(
          "HA-Wallpanel: Lovelace-Ressourcen konnten nicht vorgeladen werden",
          error,
        );
      });
    }
    await this._lovelaceResourcesPromise;
  }

  _loadLovelaceResource(resource, hass) {
    if (!resource || typeof resource.url !== "string") {
      return Promise.resolve();
    }
    const baseUrl =
      hass.auth?.data?.hassUrl || globalThis.location?.origin || "http://localhost";
    const url = new URL(resource.url, baseUrl).toString();
    const type = String(resource.type || "module");
    const key = `${type}:${url}`;
    if (this._lovelaceResourceLoads.has(key)) {
      return this._lovelaceResourceLoads.get(key);
    }

    let load;
    if (type === "module") {
      load = import(url);
    } else if ((type === "js" || type === "css") && globalThis.document) {
      const isScript = type === "js";
      const element = document.createElement(isScript ? "script" : "link");
      if (isScript) {
        element.src = url;
      } else {
        element.rel = "stylesheet";
        element.href = url;
      }
      load = new Promise((resolve, reject) => {
        element.addEventListener("load", resolve, { once: true });
        element.addEventListener(
          "error",
          () => reject(new Error(`Ressource konnte nicht geladen werden: ${url}`)),
          { once: true },
        );
        (document.head || document.documentElement).appendChild(element);
      });
    } else {
      load = Promise.resolve();
    }

    const guardedLoad = load.catch((error) => {
      console.error(
        `HA-Wallpanel: Lovelace-Ressource ${url} (${type}) konnte nicht geladen werden`,
        error,
      );
      throw error;
    });
    this._lovelaceResourceLoads.set(key, guardedLoad);
    return guardedLoad;
  }

  _createCardBrowserHass(hass) {
    if (this._cardBrowserHassProxy?._haWallpanelSource === hass) {
      return this._cardBrowserHassProxy;
    }
    const humanize = (type) =>
      String(type || "Karte")
        .replace(/^custom:/, "")
        .split("-")
        .filter(Boolean)
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(" ");
    const proxy = new Proxy(hass, {
      get(target, property, receiver) {
        if (property === "_haWallpanelSource") return target;
        if (property !== "localize") return Reflect.get(target, property, receiver);
        return (key, values) => {
          const translated = target.localize?.(key, values);
          if (translated) return translated;
          const nameMatch = String(key).match(
            /^ui\.panel\.lovelace\.editor\.card\.([^.]+)\.name$/,
          );
          if (nameMatch) return humanize(nameMatch[1]);
          if (key === "ui.panel.lovelace.editor.card.generic.manual") {
            return "Manuelle Karte";
          }
          return translated;
        };
      },
    });
    this._cardBrowserHassProxy = proxy;
    return proxy;
  }

  async _selectCardBrowserTab(saveCard, hass) {
    try {
      const dialog = await waitFor(() =>
        findElementsDeep(document, "hui-dialog-create-card").find(
          (element) => element._params?.saveCard === saveCard,
        ),
      );
      dialog._currTab = "card";
      dialog.requestUpdate?.();
      const picker = await waitFor(
        () => findElementsDeep(dialog, "hui-card-picker")[0],
      );
      picker.hass = this._createCardBrowserHass(hass);
      picker._loadCards?.();
      picker.requestUpdate?.();
    } catch (error) {
      console.debug("HA-Wallpanel: Kartenbrowser-Reiter nicht umgeschaltet", error);
    }
  }

  _appendCard(selector, cardConfig) {
    const cloned = globalThis.structuredClone
      ? structuredClone(cardConfig)
      : JSON.parse(JSON.stringify(cardConfig));
    const current = Array.isArray(selector.value) ? selector.value : [];
    const card = fullscreenCardConfig(cloned, current.length);
    const type = String(card.type || "Karte").replace(/^custom:/, "");
    const translated = selector.hass?.localize(
      `ui.panel.lovelace.editor.card.${type}.name`,
    );
    const name = String(card.name || card.title || translated || type);
    selector.dispatchEvent(
      new CustomEvent("value-changed", {
        detail: { value: [...current, { name, card, scale: 100 }] },
        bubbles: true,
        composed: true,
      }),
    );
  }

  _enhanceColorPreviews(selector) {
    const values = Array.isArray(selector.value) ? selector.value : [];
    const root = selector.shadowRoot;
    const items = root?.querySelectorAll(".item") || [];
    const addButton = root?.querySelector?.(".items-container > ha-button");
    addButton?.style.setProperty("margin-top", "12px", "important");
    items.forEach((item, index) => {
      const headline = item.querySelector('[slot="headline"]');
      const color = values[index]?.color;
      if (!headline || typeof color !== "string") return;

      let swatch = headline.querySelector(".ha-wallpanel-color-swatch");
      if (!swatch) {
        swatch = document.createElement("span");
        swatch.className = "ha-wallpanel-color-swatch";
        swatch.setAttribute("aria-hidden", "true");
        Object.assign(swatch.style, {
          display: "inline-block",
          flex: "0 0 22px",
          width: "22px",
          height: "22px",
          border: "1px solid var(--divider-color)",
          borderRadius: "5px",
          boxSizing: "border-box",
        });
        headline.prepend(swatch);
      }
      headline.style.display = "flex";
      headline.style.alignItems = "center";
      headline.style.gap = "10px";
      swatch.style.backgroundColor = color;
      swatch.title = color;
    });
  }

  _compactTimeFields(flow) {
    const form = findElementsDeep(flow.shadowRoot, "ha-form")[0];
    const root = form?.shadowRoot?.querySelector(".root");
    if (!root) return;

    const fields = [...root.children];
    const timeFields = fields.filter((field) =>
      ["idle_time", "display_time", "transition_time"].includes(field.name),
    );
    const scheduleTimeFields = fields.filter((field) =>
      ["schedule_start", "schedule_end"].includes(field.name),
    );
    const brightnessFields = fields.filter((field) =>
      ["dashboard_brightness", "screensaver_brightness"].includes(field.name),
    );
    const brightnessScheduleTimeFields = fields.filter((field) =>
      ["brightness_schedule_start", "brightness_schedule_end"].includes(
        field.name,
      ),
    );
    const brightnessScheduleFields = fields.filter((field) =>
      [
        "brightness_schedule_dashboard",
        "brightness_schedule_screensaver",
      ].includes(field.name),
    );
    if (timeFields.length !== 3) return;

    const wide = root.clientWidth >= 680;
    root.style.setProperty("row-gap", "0", "important");
    if (wide) {
      root.style.setProperty("display", "grid", "important");
      root.style.setProperty(
        "grid-template-columns",
        "repeat(6, minmax(0, 1fr))",
        "important",
      );
      root.style.setProperty("column-gap", "12px", "important");
      root.style.setProperty("grid-auto-flow", "row", "important");
      for (const field of fields) {
        field.style.setProperty("grid-column", "1 / -1", "important");
      }
      timeFields.forEach((field, index) => {
        field.style.setProperty(
          "grid-column",
          `${index * 2 + 1} / ${index * 2 + 3}`,
          "important",
        );
        field.style.setProperty("margin-bottom", "16px", "important");
      });
      scheduleTimeFields.forEach((field, index) => {
        field.style.setProperty(
          "grid-column",
          index === 0 ? "1 / 4" : "4 / 7",
          "important",
        );
        field.style.setProperty("margin-bottom", "8px", "important");
      });
      for (const pair of [
        brightnessFields,
        brightnessScheduleTimeFields,
        brightnessScheduleFields,
      ]) {
        pair.forEach((field, index) => {
          field.style.setProperty(
            "grid-column",
            index === 0 ? "1 / 4" : "4 / 7",
            "important",
          );
          field.style.setProperty("margin-bottom", "8px", "important");
        });
      }
    } else {
      root.style.removeProperty("display");
      root.style.removeProperty("grid-template-columns");
      root.style.removeProperty("column-gap");
      root.style.removeProperty("grid-auto-flow");
      for (const field of fields) field.style.removeProperty("grid-column");
      timeFields.forEach((field, index) => {
        field.style.setProperty(
          "margin-bottom",
          index === timeFields.length - 1 ? "16px" : "8px",
          "important",
        );
      });
      scheduleTimeFields.forEach((field) => {
        field.style.removeProperty("grid-column");
        field.style.setProperty("margin-bottom", "8px", "important");
      });
      for (const field of [
        ...brightnessFields,
        ...brightnessScheduleTimeFields,
        ...brightnessScheduleFields,
      ]) {
        field.style.removeProperty("grid-column");
        field.style.setProperty("margin-bottom", "8px", "important");
      }
    }
  }

  _showCardBrowserError(selector, message) {
    const root = selector.shadowRoot;
    if (!root) return;
    let error = root.querySelector(".ha-wallpanel-card-browser-error");
    if (!message) {
      error?.remove();
      return;
    }
    if (!error) {
      error = document.createElement("div");
      error.className = "ha-wallpanel-card-browser-error";
      error.style.color = "var(--error-color)";
      error.style.marginTop = "12px";
      root.appendChild(error);
    }
    error.textContent = message;
  }

  _removeDisconnectedHooks() {
    if (this._activeFlow?.isConnected === false) {
      this._activeFlow = undefined;
    }
    for (const [dialog, hook] of this._scrollDialogs) {
      if (dialog.isConnected) continue;
      hook.body.removeEventListener("wheel", hook.listener, true);
      this._scrollDialogs.delete(dialog);
    }
    for (const [button, hook] of this._cardButtons) {
      if (button.isConnected) continue;
      button.removeEventListener("click", hook.listener, true);
      this._cardButtons.delete(button);
    }
    for (const [flow, listener] of this._flowHooks) {
      if (flow.isConnected) continue;
      flow.removeEventListener("flow-update", listener, true);
      this._flowHooks.delete(flow);
    }
  }

  _saveAndSetStyles(element, properties) {
    const saved = new Map();
    for (const [property, value] of Object.entries(properties)) {
      saved.set(property, {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      });
      element.style.setProperty(property, value, "important");
    }
    return saved;
  }

  _restoreStyles(element, properties) {
    for (const [property, original] of properties) {
      if (original.value) {
        element.style.setProperty(property, original.value, original.priority);
      } else {
        element.style.removeProperty(property);
      }
    }
  }
}

export class ScreensaverBootstrap {
  constructor(screensaver, kiosk, settings) {
    this.screensaver = screensaver;
    this.kiosk = kiosk;
    this.settings = settings;
    this._interval = undefined;
    this._connection = undefined;
    this._unsubscribe = undefined;
    this._subscribing = false;
    this._retryAfter = 0;
  }

  start() {
    this.screensaver.connect();
    this.kiosk.connect();
    this._sync();
    this._interval = window.setInterval(() => this._sync(), 1000);
  }

  stop() {
    if (this._interval !== undefined) window.clearInterval(this._interval);
    this._interval = undefined;
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._connection = undefined;
    this.screensaver.disconnect();
    this.kiosk.disconnect();
    this.settings.stop();
  }

  retryNow() {
    this._retryAfter = 0;
    this._sync();
  }

  _sync() {
    this.kiosk.sync();
    this.settings.sync();
    const hass = document.querySelector("home-assistant")?.hass;
    if (!hass) return;
    this.screensaver.setHass(hass);
    this.screensaver.syncSchedule();

    const connection = hass.connection;
    if (!connection || this._subscribing) return;
    if (connection === this._connection && this._unsubscribe) return;
    if (Date.now() < this._retryAfter) return;
    this._subscribe(connection);
  }

  async _subscribe(connection) {
    this._subscribing = true;
    try {
      this._unsubscribe?.();
      this._unsubscribe = undefined;
      this._connection = connection;
      const unsubscribe = await connection.subscribeMessage(
        (config) => this.screensaver.setConfig(config),
        { type: WS_TYPE_SUBSCRIBE },
      );
      if (this._connection === connection) {
        this._unsubscribe = unsubscribe;
      } else {
        unsubscribe?.();
      }
    } catch (error) {
      this._connection = undefined;
      this._retryAfter = Date.now() + 5000;
      console.debug(
        "HA-Wallpanel: Konfiguration noch nicht verfügbar",
        error,
      );
    } finally {
      this._subscribing = false;
    }
  }
}

export function startHaWallpanel() {
  if (!globalThis.window || !globalThis.document) return undefined;
  if (window.haWallpanel?.screensaver) return window.haWallpanel;

  const screensaver = new ScreensaverController();
  const kiosk = new KioskModeController();
  const settings = new WallpanelSettingsController();
  const bootstrap = new ScreensaverBootstrap(screensaver, kiosk, settings);
  const api = {
    version: VERSION,
    screensaver,
    kiosk,
    settings,
    show: () => screensaver.showScreensaver(),
    hide: () => screensaver.hideScreensaver(),
    enableKiosk: () => kiosk.enable(),
    disableKiosk: () => kiosk.disable(),
    reconnect: () => bootstrap.retryNow(),
    stop: () => bootstrap.stop(),
  };
  window.haWallpanel = api;
  bootstrap.start();
  return api;
}

if (
  globalThis.window &&
  globalThis.document &&
  !globalThis.__HA_WALLPANEL_DISABLE_AUTO_START__
) {
  startHaWallpanel();
}

console.info(
  `%c HA-WALLPANEL %c v${VERSION} `,
  "color: white; background: #03a9f4; font-weight: 700;",
  "color: #03a9f4; background: white; font-weight: 700;",
);

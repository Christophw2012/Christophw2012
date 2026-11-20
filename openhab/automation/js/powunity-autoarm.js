/**
 * Biketraxx / Powunity – Auto-Arm nach Stillstand
 *
 * Ablage: $OPENHAB_CONF/automation/js/powunity-autoarm.js
 * Benötigt: JavaScript Scripting Add-on (openhab-js)
 *
 * Logik (besser als reiner Stillstand-Timer):
 * 1. Status periodisch vom HTTP-Thing (Biketraxx_StatusRaw)
 * 2. Bewegung / Geschwindigkeit / Armed aus JSON ableiten
 * 3. Auto-Arm nur wenn:
 *    - AutoArmEnabled = ON
 *    - nicht bereits armed
 *    - nicht moving für IdleTimeoutMinutes
 *    - keine Disarm-Schonzeit aktiv
 *    - optional Home != ON
 * 4. Manuelles Disarm startet Schonzeit (DisarmGraceMinutes), damit Fahren
 *    nicht sofort wieder scharf geschaltet wird.
 *
 * Status-JSON: genaue Felder je nach Powunity-Response. Unten klar markierte
 * Parser-Stellen anpassen, falls die Defaults nicht passen.
 */

const { rules, triggers, items, actions, time } = require('openhab');

const ITEM = {
  armed: 'Biketraxx_Armed',
  statusRaw: 'Biketraxx_StatusRaw',
  isMoving: 'Biketraxx_IsMoving',
  lastMotion: 'Biketraxx_LastMotion',
  summary: 'Biketraxx_StatusSummary',
  autoArm: 'Biketraxx_AutoArmEnabled',
  idleMin: 'Biketraxx_IdleTimeoutMinutes',
  graceMin: 'Biketraxx_DisarmGraceMinutes',
  graceUntil: 'Biketraxx_DisarmGraceUntil',
  home: 'Biketraxx_Home'
};

const DEFAULT_IDLE_MIN = 12;
const DEFAULT_GRACE_MIN = 30;

/**
 * --- Status-Parser (an echte API-Response anpassen) ---
 *
 * Erwartete / typische Felder (Traccar/Powunity-ähnlich):
 *   armed / attributes.armed / guard / guarded
 *   motion / attributes.motion / moving / isMoving
 *   speed / attributes.speed  (Knoten oder km/h – Schwelle unten)
 *   lat/lon oder latitude/longitude für Positionswechsel
 *
 * Wenn unbekannt: isMoving/lastMotion-Platzhalter bleiben konservativ
 * (keine Bewegung → Stillstand zählt).
 */
function parseStatus(raw) {
  const result = {
    armed: null,
    isMoving: false,
    speed: null,
    lat: null,
    lon: null,
    rawOk: false
  };

  if (!raw || raw === 'NULL' || raw === 'UNDEF') {
    return result;
  }

  let data;
  try {
    data = (typeof raw === 'object') ? raw : JSON.parse(String(raw));
  } catch (e) {
    console.warn('Biketraxx: Status ist kein JSON – Parser übersprungen:', e);
    return result;
  }

  result.rawOk = true;
  const attrs = data.attributes || data.attr || {};

  // Armed: mehrere mögliche Keys
  const armedVal =
    firstDefined(data.armed, data.guarded, data.guard, attrs.armed, attrs.guarded, attrs.guard);
  if (armedVal !== undefined) {
    result.armed = toBool(armedVal);
  }

  // Bewegung: motion-Flag und/oder Speed
  const motionVal =
    firstDefined(data.motion, data.moving, data.isMoving, attrs.motion, attrs.moving, attrs.isMoving);
  const speedVal = firstDefined(data.speed, attrs.speed);
  result.speed = (speedVal !== undefined && speedVal !== null) ? Number(speedVal) : null;

  // Speed-Schwelle: Powunity/Traccar oft Knoten; 0.1 kn ≈ still
  const SPEED_MOVING_THRESHOLD = 0.1;
  const speedMoving = result.speed !== null && !Number.isNaN(result.speed) && result.speed > SPEED_MOVING_THRESHOLD;

  if (motionVal !== undefined) {
    result.isMoving = toBool(motionVal) || speedMoving;
  } else {
    result.isMoving = speedMoving;
  }

  result.lat = firstDefined(data.latitude, data.lat, attrs.latitude, attrs.lat);
  result.lon = firstDefined(data.longitude, data.lon, attrs.longitude, attrs.lon);

  return result;
}

function firstDefined(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toLowerCase();
  return s === 'true' || s === 'on' || s === '1' || s === 'yes';
}

function numOr(itemName, fallback) {
  const it = items.getItem(itemName);
  if (!it || it.isUninitialized || it.state === 'NULL' || it.state === 'UNDEF') return fallback;
  const n = Number(it.state);
  return Number.isFinite(n) ? n : fallback;
}

function switchOn(itemName) {
  const it = items.getItem(itemName);
  return it && it.state === 'ON';
}

function ensureDefaults() {
  const auto = items.getItem(ITEM.autoArm);
  if (auto && (auto.isUninitialized || auto.state === 'NULL' || auto.state === 'UNDEF')) {
    auto.postUpdate('ON');
  }
  const idle = items.getItem(ITEM.idleMin);
  if (idle && (idle.isUninitialized || idle.state === 'NULL' || idle.state === 'UNDEF')) {
    idle.postUpdate(String(DEFAULT_IDLE_MIN));
  }
  const grace = items.getItem(ITEM.graceMin);
  if (grace && (grace.isUninitialized || grace.state === 'NULL' || grace.state === 'UNDEF')) {
    grace.postUpdate(String(DEFAULT_GRACE_MIN));
  }
  const home = items.getItem(ITEM.home);
  if (home && (home.isUninitialized || home.state === 'NULL' || home.state === 'UNDEF')) {
    home.postUpdate('OFF');
  }
}

function graceActive() {
  const it = items.getItem(ITEM.graceUntil);
  if (!it || it.isUninitialized || it.state === 'NULL' || it.state === 'UNDEF') return false;
  try {
    const until = time.toZDT(it.state);
    return time.ZonedDateTime.now().isBefore(until);
  } catch (e) {
    return false;
  }
}

function minutesSince(dtItemName) {
  const it = items.getItem(dtItemName);
  if (!it || it.isUninitialized || it.state === 'NULL' || it.state === 'UNDEF') return Infinity;
  try {
    const then = time.toZDT(it.state);
    const secs = time.ZonedDateTime.now().toEpochSecond() - then.toEpochSecond();
    return secs / 60;
  } catch (e) {
    return Infinity;
  }
}

function applyStatus(parsed) {
  const movingItem = items.getItem(ITEM.isMoving);
  if (movingItem) {
    movingItem.postUpdate(parsed.isMoving ? 'ON' : 'OFF');
  }

  if (parsed.isMoving) {
    const lm = items.getItem(ITEM.lastMotion);
    if (lm) lm.postUpdate(time.ZonedDateTime.now().toString());
  } else {
    // Erste Stationär-Erkennung: LastMotion setzen, falls noch leer
    const lm = items.getItem(ITEM.lastMotion);
    if (lm && (lm.isUninitialized || lm.state === 'NULL' || lm.state === 'UNDEF')) {
      lm.postUpdate(time.ZonedDateTime.now().toString());
    }
  }

  if (parsed.armed !== null) {
    const armed = items.getItem(ITEM.armed);
    // Nur State updaten (autoupdate=false + Channel WRITEONLY) – kein Command
    if (armed) armed.postUpdate(parsed.armed ? 'ON' : 'OFF');
  }

  const summary = items.getItem(ITEM.summary);
  if (summary) {
    const parts = [];
    if (parsed.armed !== null) parts.push(parsed.armed ? 'scharf' : 'unscharf');
    parts.push(parsed.isMoving ? 'in Bewegung' : 'still');
    if (parsed.speed !== null && !Number.isNaN(parsed.speed)) {
      parts.push('speed=' + parsed.speed);
    }
    summary.postUpdate(parts.join(', '));
  }
}

function maybeAutoArm(parsed) {
  ensureDefaults();

  if (!switchOn(ITEM.autoArm)) {
    console.debug('Biketraxx Auto-Arm: deaktiviert');
    return;
  }
  if (switchOn(ITEM.home)) {
    console.debug('Biketraxx Auto-Arm: Home=ON – übersprungen');
    return;
  }
  if (graceActive()) {
    console.debug('Biketraxx Auto-Arm: Disarm-Schonzeit aktiv');
    return;
  }

  const armedItem = items.getItem(ITEM.armed);
  const alreadyArmed = armedItem && armedItem.state === 'ON';
  if (alreadyArmed || parsed.armed === true) {
    return;
  }
  if (parsed.isMoving) {
    return;
  }

  const idleMin = numOr(ITEM.idleMin, DEFAULT_IDLE_MIN);
  const idleFor = minutesSince(ITEM.lastMotion);
  if (idleFor < idleMin) {
    console.debug('Biketraxx Auto-Arm: noch nicht idle genug (' + idleFor.toFixed(1) + '/' + idleMin + ' min)');
    return;
  }

  console.info('Biketraxx Auto-Arm: scharf schalten nach ' + idleFor.toFixed(1) + ' min Stillstand');
  armedItem.sendCommand('ON');
}

function startDisarmGrace() {
  ensureDefaults();
  const graceMin = numOr(ITEM.graceMin, DEFAULT_GRACE_MIN);
  const until = time.ZonedDateTime.now().plusMinutes(graceMin);
  const it = items.getItem(ITEM.graceUntil);
  if (it) it.postUpdate(until.toString());
  console.info('Biketraxx: Disarm-Schonzeit bis ' + until.toString() + ' (' + graceMin + ' min)');
}

// Status-Update vom HTTP-Poll
rules.JSRule({
  name: 'Biketraxx Status auswerten',
  description: 'Parst Powunity-Status, aktualisiert Bewegung/Armed, prüft Auto-Arm',
  triggers: [
    triggers.ItemStateChangeTrigger(ITEM.statusRaw),
    triggers.GenericCronTrigger('0 */1 * * * ?') // Sicherheitsnetz jede Minute
  ],
  execute: (event) => {
    ensureDefaults();
    const rawItem = items.getItem(ITEM.statusRaw);
    const raw = rawItem ? rawItem.state : null;
    const parsed = parseStatus(raw);

    if (parsed.rawOk) {
      applyStatus(parsed);
    } else if (event && event.eventType === 'TimeEvent') {
      // Cron ohne gültigen Status: mit vorhandenem IsMoving/LastMotion weiterarbeiten
      const moving = switchOn(ITEM.isMoving);
      maybeAutoArm({ armed: null, isMoving: moving });
      return;
    }

    maybeAutoArm(parsed);
  }
});

// Manuelles Disarm → Schonzeit (Fahrt ohne sofortiges Re-Arm)
rules.JSRule({
  name: 'Biketraxx Disarm Schonzeit',
  description: 'Nach manuellem Disarm Auto-Arm für Grace-Minuten unterdrücken',
  triggers: [triggers.ItemCommandTrigger(ITEM.armed, 'OFF')],
  execute: () => {
    startDisarmGrace();
  }
});

// Optional: Home ON → disarm (wenn Presence später gekoppelt wird)
rules.JSRule({
  name: 'Biketraxx Home Disarm',
  description: 'Optional: bei Home=ON entschärfen und Auto-Arm überspringen',
  triggers: [triggers.ItemStateChangeTrigger(ITEM.home, undefined, 'ON')],
  execute: () => {
    const armed = items.getItem(ITEM.armed);
    if (armed && armed.state === 'ON') {
      console.info('Biketraxx: Home=ON → Disarm');
      armed.sendCommand('OFF');
    }
  }
});

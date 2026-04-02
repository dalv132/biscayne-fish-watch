/**
 * Biscayne Bay Fish Watch — script.js
 *
 * Data sources:
 *   1. OpenWeatherMap "Current Weather" API — wind speed, rain, pressure, clouds
 *   2. OpenWeatherMap "3-Hour Forecast"     — pressure 3 h ahead (pressure_trend)
 *   3. NOAA CO-OPS Tides API     — Station 8723165 (Miamarina) — hi/lo & hourly
 *   4. NOAA CO-OPS Water Temp    — Station 8723214 (Virginia Key),
 *                                   fallback: mi0401 (Dodge Island)
 *
 * Condition logic:
 *   OPTIMAL  →  ALL 3 conditions met  (+ seasonal & temp bonus adjustments)
 *   FAIR     →  EXACTLY 2 of 3 conditions met
 *   POOR     →  fewer than 2 conditions met
 *
 * Seasonal adjustments:
 *   Dry Season (Nov–Apr): Visibility weight +1 (clearer winter water).
 *   Wet Season (May–Oct): Visibility penalised if precip > 0.5 in / 24h.
 *
 * Tide window (asymmetric — Venetian Causeway):
 *   "Good" if within 2 hours BEFORE high tide OR up to 1 hour AFTER.
 *
 * Visibility Score (wind-based):
 *   < 5 mph → Excellent | 5–10 mph → Good | > 10 mph → Low
 *
 * Rain window:
 *   Condition fails if any rain detected in the past 2 hours (1h + 3h OWM fields).
 *
 * Water Temperature (NOAA — Virginia Key / Dodge Island):
 *   Bonus range: 74°F – 82°F → OPTIMAL bonus for peak fish activity.
 *   > 88°F → Override status to "Fair - Fish may be deep."
 *
 * Environmental Intelligence (Phase 1):
 *   ghi            — Global Horizontal Irradiance approximation (W/m²)
 *                    Formula: 1361 * sin(solar_elevation) * (1 − 0.75*(cloud/100)^3.4)
 *   tidal_momentum — |Δft/hr| rate of tide height change from hourly NOAA data
 *   pressure_trend — current_hPa − forecast_3h_hPa  (positive = falling barometer)
 *   crepuscular    — 1 if within 60 mins of sunrise/sunset, else 0
 *   cloud_cover    — % from weatherData.clouds.all
 *   activity_score — Biscayne Activity Score 0–100 (see calculateActivityScore)
 */

/* ── Constants ─────────────────────────────────── */
// ⚠️  Raw values are injected at deploy time by GitHub Actions (see .github/workflows/deploy.yml).
// For local development, temporarily replace the placeholders below with your real keys,
// but do NOT commit those changes.
const OPENWEATHER_API_KEY = '__OPENWEATHER_API_KEY__';

const LAT = 25.788996;
const LON = -80.172930;
const NOAA_TIDE_STATION = '8723165'; // Miamarina — tides only
const NOAA_TEMP_STATIONS = ['8723214', 'mi0401']; // Virginia Key (primary), Dodge Island (fallback)

const WIND_THRESHOLD_MPH = 10;   // < 10 mph = OK
const TIDE_BEFORE_HOURS = 2;    // up to 2 h BEFORE high tide = OK
const TIDE_AFTER_HOURS = 1;    // up to 1 h AFTER  high tide = OK
const MS_PER_HOUR = 3600000;

// Visibility score thresholds
const VIS_EXCELLENT_MPH = 5;
const VIS_GOOD_MPH = 10;

// Water temperature thresholds (°F)
const WATER_TEMP_BONUS_MIN = 74;  // 74–82°F = bonus range for peak fish activity
const WATER_TEMP_IDEAL_MIN = 74;
const WATER_TEMP_IDEAL_MAX = 82;
const WATER_TEMP_HEAT_STRESS = 88; // > 88°F forces "Fair - Fish may be deep"

// Wet-season rain penalty threshold (inches in 24 h)
const WET_SEASON_RAIN_PENALTY_IN = 0.5;

/* ── Backend / Sheet connection ─────────────────── */
const APPS_SCRIPT_URL = '__APPS_SCRIPT_URL__'; // injected by CI — see deploy.yml
const DATABASE_TOKEN = '__DATABASE_TOKEN__';  // injected by CI — see deploy.yml
console.log('Debug - URL Length:', APPS_SCRIPT_URL.length); // ✅ > 10 means secret was injected

/* ── Season helper ─────────────────────────────── */
/**
 * Determine Miami's current season based on the calendar month.
 *   Dry Season  (Nov–Apr): months 11, 12, 1, 2, 3, 4
 *   Wet Season  (May–Oct): months 5, 6, 7, 8, 9, 10
 * @returns {{ name: string, isDry: boolean }}
 */
function getCurrentSeason() {
  const month = new Date().getMonth() + 1; // 1-indexed
  const isDry = month >= 11 || month <= 4;
  return { name: isDry ? 'Dry Season' : 'Wet Season', isDry };
}

/* ── Moon Phase ────────────────────────────────── */
/**
 * Calculate the current lunar phase using the synodic cycle.
 * Reference new moon: January 6, 2000 at 18:14 UTC.
 * @returns {number} Value 0.0–1.0 (0 = new moon, 0.5 = full moon, 1.0 ≈ new moon again)
 */
function getMoonPhase() {
  const KNOWN_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14, 0); // Jan 6, 2000 18:14 UTC
  const SYNODIC_PERIOD_MS = 29.530588853 * 24 * 3600 * 1000;  // 29.53 days in ms
  const elapsed = Date.now() - KNOWN_NEW_MOON_MS;
  const phase = ((elapsed % SYNODIC_PERIOD_MS) / SYNODIC_PERIOD_MS + 1) % 1;
  return Math.round(phase * 1000) / 1000; // 3 decimal places
}

/**
 * Return a human-readable moon phase label for a 0–1 phase value.
 * @param {number} phase
 * @returns {string}
 */
function getMoonPhaseLabel(phase) {
  if (phase < 0.0625) return '🌑 New Moon';
  if (phase < 0.1875) return '🌒 Waxing Crescent';
  if (phase < 0.3125) return '🌓 First Quarter';
  if (phase < 0.4375) return '🌔 Waxing Gibbous';
  if (phase < 0.5625) return '🌕 Full Moon';
  if (phase < 0.6875) return '🌖 Waning Gibbous';
  if (phase < 0.8125) return '🌗 Last Quarter';
  if (phase < 0.9375) return '🌘 Waning Crescent';
  return '🌑 New Moon';
}

/* ── Helpers ───────────────────────────────────── */

/** Convert m/s → mph */
const msToMph = (ms) => ms * 2.23694;

/** Convert mm → inches */
const mmToIn = (mm) => mm / 25.4;

/** Format a Date as "h:mm AM/PM" */
function fmtTime(date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** Format minutes as "Xh Ym" */
function fmtDuration(minutes) {
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Viewing Window label based on solar elevation.
 * @param {number} solarElevDeg  Solar elevation in degrees
 * @returns {{ label: string, status: 'good'|'fair'|'poor' }}
 */
function getViewingWindow(solarElevDeg) {
  if (solarElevDeg < -6)  return { label: '🌙 Night (Poor Visibility)',              status: 'poor' };
  if (solarElevDeg <  2)  return { label: '🌅 Dawn/Dusk (High Activity, Low Light)', status: 'good' };
  if (solarElevDeg < 15)  return { label: '⭐ PEAK Sighting Window',                 status: 'good' };
  if (solarElevDeg < 35)  return { label: '☀️ Good Visibility',                      status: 'fair' };
  return                         { label: '🥵 Midday Slump (High Glare)',            status: 'fair' };
}

/**
 * Tidal flow label based on tidal_momentum (ft/hr).
 * @param {number} tidalMomentum  Absolute ft/hr slope
 * @returns {{ label: string, status: 'good'|'fair'|'poor' }}
 */
function getTidalFlowLabel(tidalMomentum) {
  if (tidalMomentum >= 0.3) return { label: '💧 Strong Current', status: 'good' };
  if (tidalMomentum >= 0.1) return { label: '〰️ Moderate Flow',  status: 'fair' };
  return                           { label: '🧲 Slack Water',     status: 'poor' };
}

/**
 * Barometer status based on pressure_trend (hPa delta: current − 3h forecast).
 * Positive = falling (front approaching = fish active).
 * @param {number|null} pressureTrend
 * @returns {{ label: string, status: 'good'|'fair'|'poor' }}
 */
function getBarometerStatus(pressureTrend) {
  if (pressureTrend === null) return { label: '⚖️ Pressure: No Data',            status: 'fair' };
  if (pressureTrend > 0.5)   return { label: '📉 Pressure Dropping (Active)',    status: 'good' };
  if (pressureTrend < -0.5)  return { label: '📈 Pressure Rising (Quiet)',       status: 'poor' };
  return                            { label: '⚖️ Stable Pressure',               status: 'fair' };
}

/** Return today's date in NOAA format: YYYYMMDD */
function todayNoaaDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/* ── DOM refs ──────────────────────────────────── */
const condBadge = document.getElementById('condition-badge');
const condText = document.getElementById('condition-text');
const condSub = document.getElementById('condition-subtitle');
const lastUpdated = document.getElementById('last-updated');
const visibilityEl = document.getElementById('visibility-score');

/* ── Hero card DOM refs ───────────────────────── */
const hcViewingIcon = document.getElementById('hc-viewing-icon');
const hcViewingDot  = document.getElementById('hc-viewing-dot');
const hcTideIcon    = document.getElementById('hc-tide-icon');
const hcTideDot     = document.getElementById('hc-tide-dot');
const hcBaroIcon    = document.getElementById('hc-baro-icon');
const hcBaroDot     = document.getElementById('hc-baro-dot');
const hcTempIcon    = document.getElementById('hc-temp-icon');
const hcTempDot     = document.getElementById('hc-temp-dot');
const hcClarityIcon = document.getElementById('hc-clarity-icon');
const hcClarityDot  = document.getElementById('hc-clarity-dot');

const tideTimeline  = document.getElementById('tide-timeline');

/* ── Sighting / Modal refs ─────────────────────── */
const logBtn     = document.getElementById('btn-log-sighting');
const modalOverlay = document.getElementById('modal-overlay');
const modalClose = document.getElementById('modal-close');
const btnCancel  = document.getElementById('btn-cancel');
const sightingForm = document.getElementById('sighting-form');
const formError  = document.getElementById('form-error');
const btnSubmit  = document.getElementById('btn-submit');
const syncStatus = document.getElementById('sync-status');
const syncLabel  = document.getElementById('sync-label');

/* ── UI helpers ────────────────────────────────── */

/**
 * Apply a traffic-light class to a hero card icon + dot.
 * @param {HTMLElement} icon  .hc-icon element
 * @param {HTMLElement} dot   .hc-status-dot element
 * @param {'good'|'fair'|'poor'} status
 */
function applyHeroStatus(icon, dot, status) {
  ['good', 'fair', 'poor'].forEach(s => { icon.classList.remove(s); dot.classList.remove(s); });
  icon.classList.add(status);
  dot.classList.add(status);
}

/** Render the overall condition badge */
function renderCondition(rating, metricsText) {
  condBadge.classList.remove('loading', 'optimal', 'fair', 'poor');
  condBadge.classList.add(rating.toLowerCase().split(' ')[0]); // handle "fair" from override text
  condText.textContent = rating;
  condSub.textContent = metricsText;
  lastUpdated.textContent = `Last updated: ${fmtTime(new Date())}`;
}

/** Set sync pill state */
function setSyncState(state, message) {
  syncStatus.classList.remove('syncing', 'success');
  if (state !== 'idle') syncStatus.classList.add(state);
  syncLabel.textContent = message;
}

/**
 * Enable or disable the log sighting button.
 * Also updates the sync pill message when disabling (loading state).
 */
function setSightingButtonsEnabled(enabled) {
  if (!logBtn) return;
  logBtn.disabled = !enabled;
  if (!enabled) {
    setSyncState('syncing', 'Loading Environment Data…');
  } else {
    setSyncState('idle', 'Ready to Log');
  }
}

/* ── Modal helpers ─────────────────────────────── */
function openModal() {
  if (!modalOverlay) return;
  sightingForm.reset();
  formError.hidden = true;
  btnSubmit.disabled = false;
  btnSubmit.textContent = 'Submit Sighting';
  logBtn.classList.remove('broadcasting');
  modalOverlay.hidden = false;
  // Trap focus inside modal
  modalOverlay.querySelector('.modal-close')?.focus();
}

function closeModal() {
  if (!modalOverlay) return;
  modalOverlay.hidden = true;
}

/* ── Fetch: OpenWeatherMap ─────────────────────── */
async function fetchWeather() {
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${LAT}&lon=${LON}&appid=${OPENWEATHER_API_KEY}&units=imperial`;
  console.log('Current OpenWeather URL:', url.split('appid=')[0] + 'appid=HIDDEN');
  const res = await fetch(url);
  if (!res.ok) {
    // Extract the specific error message from OWM's JSON body (e.g. "Invalid API key", "account is blocked")
    let owmMessage = res.statusText;
    try {
      const errBody = await res.json();
      owmMessage = errBody.message ?? owmMessage;
    } catch (_) { /* body not JSON — keep statusText */ }
    console.warn(`[BiscayneFishWatch] OpenWeatherMap ${res.status} error:`, owmMessage);
    throw new Error(`OpenWeatherMap: ${res.status} — ${owmMessage}`);
  }
  const data = await res.json();
  console.log('[BiscayneFishWatch] OpenWeatherMap raw data:', data);
  return data;
}

/* ── Fetch: NOAA Tides (hi/lo) ─────────────────── */
async function fetchTides() {
  const date = todayNoaaDate();
  const url = [
    'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter',
    `?product=predictions`,
    `&application=biscayne_fish_watch`,
    `&begin_date=${date}`,
    `&end_date=${date}`,
    `&datum=MLLW`,
    `&station=${NOAA_TIDE_STATION}`,
    `&time_zone=lst_ldt`,
    `&interval=hilo`,
    `&units=english`,
    `&format=json`
  ].join('');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`NOAA Tides: ${res.status} ${res.statusText}`);
  const data = await res.json();
  console.log(`[BiscayneFishWatch] NOAA Tides raw data (Station ${NOAA_TIDE_STATION}):`, data);
  if (data.error) throw new Error(`NOAA Tides error: ${data.error.message}`);
  return data;
}

/* ── Fetch: NOAA Hourly Tides (for Tide Trend) ── */
/**
 * Fetches hourly tide predictions for today. Used to compute tide trend
 * by comparing the current hour's height to the previous hour's height.
 * @returns {Promise<Array<{t: string, v: string}>>}
 */
async function fetchHourlyTides() {
  const date = todayNoaaDate();
  const url = [
    'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter',
    `?product=predictions`,
    `&application=biscayne_fish_watch`,
    `&begin_date=${date}`,
    `&end_date=${date}`,
    `&datum=MLLW`,
    `&station=${NOAA_TIDE_STATION}`,
    `&time_zone=lst_ldt`,
    `&interval=h`,
    `&units=english`,
    `&format=json`
  ].join('');

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[BiscayneFishWatch] NOAA Hourly Tides HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    if (data.error) {
      console.warn('[BiscayneFishWatch] NOAA Hourly Tides error:', data.error.message);
      return [];
    }
    console.log('[BiscayneFishWatch] NOAA Hourly Tides raw data:', data);
    return data.predictions ?? [];
  } catch (e) {
    console.warn('[BiscayneFishWatch] fetchHourlyTides failed:', e.message);
    return [];
  }
}

/* ── Fetch: NOAA Observed Water Level ────────────────── */
/**
 * Fetches the latest observed (actual) water level from NOAA CO-OPS
 * Station 8723165 (Miamarina), datum MLLW, english units.
 *
 * Returns the most recent reading so we can compute tide_surge:
 *   tide_surge = actual_water_level − predicted_tide_height
 *   Positive = "Surge"   (more water than predicted)
 *   Negative = "Blowout" (less water than predicted)
 *
 * @returns {Promise<number|null>} Latest observed water level in feet, or null on failure.
 */
async function fetchObservedWaterLevel() {
  const date = todayNoaaDate();
  const url = [
    'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter',
    `?product=water_level`,
    `&application=biscayne_fish_watch`,
    `&begin_date=${date}`,
    `&end_date=${date}`,
    `&datum=MLLW`,
    `&station=${NOAA_TIDE_STATION}`,
    `&time_zone=lst_ldt`,
    `&units=english`,
    `&format=json`
  ].join('');

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[BiscayneFishWatch] NOAA Observed Water Level HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (data.error) {
      console.warn('[BiscayneFishWatch] NOAA Observed Water Level error:', data.error.message);
      return null;
    }
    const readings = data.data ?? [];
    if (readings.length === 0) {
      console.warn('[BiscayneFishWatch] NOAA Observed Water Level: no readings returned');
      return null;
    }
    // Use the most recent reading (last entry in the array)
    const latest = parseFloat(readings[readings.length - 1].v);
    if (isNaN(latest)) return null;
    console.log(`[BiscayneFishWatch] Observed Water Level: ${latest.toFixed(2)} ft (MLLW)`);
    return latest;
  } catch (e) {
    console.warn('[BiscayneFishWatch] fetchObservedWaterLevel failed:', e.message);
    return null;
  }
}

/* ── Tide Trend calculation ────────────────────── */
/**
 * Derive tide trend by comparing current hour vs. prior hour in hourly predictions.
 * @param {Array<{t: string, v: string}>} hourlyPredictions
 * @returns {'Rising'|'Falling'|'Unknown'}
 */
function computeTideTrend(hourlyPredictions) {
  if (!hourlyPredictions || hourlyPredictions.length < 2) return 'Unknown';

  const nowMs = Date.now();

  // Find the entry closest to (but not after) the current time
  let currentIdx = -1;
  for (let i = 0; i < hourlyPredictions.length; i++) {
    const t = new Date(hourlyPredictions[i].t).getTime();
    if (t <= nowMs) currentIdx = i;
  }

  if (currentIdx < 1) return 'Unknown'; // no previous hour available

  const currentHeight = parseFloat(hourlyPredictions[currentIdx].v);
  const previousHeight = parseFloat(hourlyPredictions[currentIdx - 1].v);

  if (isNaN(currentHeight) || isNaN(previousHeight)) return 'Unknown';

  console.log(`[BiscayneFishWatch] Tide Trend: ${previousHeight.toFixed(2)} ft → ${currentHeight.toFixed(2)} ft`);
  return currentHeight > previousHeight ? 'Rising' : 'Falling';
}

/* ── Fetch: NOAA Water Temperature ────────────── */
/**
 * Fetches the latest water temperature observation.
 * Tries each station in NOAA_TEMP_STATIONS in order and returns the first
 * successful reading (Virginia Key 8723214, then Dodge Island mi0401).
 * @returns {Promise<{ tempF: number|null, station: string|null }>}
 */
async function fetchWaterTemp() {
  const date = todayNoaaDate();

  for (const stationId of NOAA_TEMP_STATIONS) {
    const url = [
      'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter',
      `?product=water_temperature`,
      `&application=biscayne_fish_watch`,
      `&begin_date=${date}`,
      `&end_date=${date}`,
      `&station=${stationId}`,
      `&time_zone=lst_ldt`,
      `&units=english`,
      `&format=json`
    ].join('');

    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn(`[BiscayneFishWatch] NOAA Temp HTTP ${res.status} for station ${stationId}`); continue; }
      const data = await res.json();
      console.log(`[BiscayneFishWatch] NOAA Water Temp raw data (Station ${stationId}):`, data);

      if (data.error) {
        console.warn(`[BiscayneFishWatch] NOAA Temp error for station ${stationId}:`, data.error.message);
        continue; // try next station
      }

      const readings = data.data ?? [];
      if (readings.length === 0) { console.warn(`[BiscayneFishWatch] No temp readings for station ${stationId}`); continue; }

      const tempF = parseFloat(readings[readings.length - 1].v);
      if (isNaN(tempF)) continue;

      console.log(`[BiscayneFishWatch] Water Temp: ${tempF}°F from Station ${stationId}`);
      return { tempF, station: stationId };
    } catch (e) {
      console.warn(`[BiscayneFishWatch] fetchWaterTemp failed for station ${stationId}:`, e.message);
    }
  }

  console.warn('[BiscayneFishWatch] All temp stations exhausted — returning null.');
  return { tempF: null, station: null };
}

/* ── Tide window logic ─────────────────────────── */
/**
 * Asymmetric tide window for the Venetian Causeway / Miamarina area.
 * OK if within [−2h, +1h] of the nearest high tide.
 */
function evaluateTideWindow(predictions) {
  const now = Date.now();

  const highs = predictions
    .filter(p => p.type === 'H')
    .map(p => ({ date: new Date(p.t), height: parseFloat(p.v) }));

  if (highs.length === 0) {
    return { inWindow: false, nearestHigh: null, deltaMinutes: Infinity, allHighs: [] };
  }

  let nearest = highs[0];
  let minDelta = Math.abs(now - nearest.date.getTime());

  for (let i = 1; i < highs.length; i++) {
    const d = Math.abs(now - highs[i].date.getTime());
    if (d < minDelta) { minDelta = d; nearest = highs[i]; }
  }

  const deltaMs = now - nearest.date.getTime();
  const deltaMinutes = Math.round(deltaMs / 60000);

  const inWindow =
    deltaMs >= -(TIDE_BEFORE_HOURS * MS_PER_HOUR) &&
    deltaMs <= (TIDE_AFTER_HOURS * MS_PER_HOUR);

  return { inWindow, nearestHigh: nearest, deltaMinutes, allHighs: highs, allPredictions: predictions };
}

/* ── Render: Tide timeline ─────────────────────── */
function renderTideTimeline(predictions, nearestHigh) {
  tideTimeline.innerHTML = '';

  if (!predictions || predictions.length === 0) {
    tideTimeline.innerHTML = '<p class="error-msg">No tide data available.</p>';
    return;
  }

  const nowMs = Date.now();

  predictions.forEach(p => {
    const eventDate = new Date(p.t);
    const isHigh = p.type === 'H';
    const isNearest = nearestHigh && Math.abs(eventDate - nearestHigh.date) < 60000;
    const deltaMs = nowMs - eventDate.getTime();
    const inWin = isHigh &&
      deltaMs >= -(TIDE_BEFORE_HOURS * MS_PER_HOUR) &&
      deltaMs <= (TIDE_AFTER_HOURS * MS_PER_HOUR);

    const el = document.createElement('div');
    el.className = 'tide-event' + (isNearest ? ' highlight' : '') + (inWin ? ' in-window' : '');

    const typeEl = document.createElement('div');
    typeEl.className = `tide-type ${isHigh ? 'high' : 'low'}`;
    typeEl.textContent = isHigh ? '▲ HIGH' : '▼ LOW';

    const timeEl = document.createElement('div');
    timeEl.className = 'tide-time';
    timeEl.textContent = fmtTime(eventDate);

    const heightEl = document.createElement('div');
    heightEl.className = 'tide-height';
    heightEl.textContent = `${parseFloat(p.v).toFixed(2)} ft`;

    el.appendChild(typeEl);
    el.appendChild(timeEl);
    el.appendChild(heightEl);

    if (inWin) {
      const tag = document.createElement('div');
      tag.className = 'tide-window-tag';
      tag.textContent = '-2h/+1h Window';
      el.appendChild(tag);
    }

    tideTimeline.appendChild(el);
  });
}

/* ── Cached live data (set after init()) ────────── */
// Shared between init() and sendSighting() so sighting payloads are instant.
let _cachedWeather = null;
let _cachedTideData = null;
let _cachedWaterTemp = null;
let _cachedTideTrend = 'Unknown';
let _cachedMoonPhase = 0;
let _cachedSeason = null;
let _dataReady = false;

// Phase 1 — Environmental Intelligence cache
let _cachedActivityScore = null;
let _cachedGhi = null;
let _cachedTidalMomentum = null;
let _cachedPressureTrend = null;
let _cachedCrepuscular = 0;
let _cachedCloudCover = null;
let _cachedSolarElevDeg = 0;  // degrees — used by Viewing Window popup

// Tidal Reality cache
let _cachedPredictedTideHeight = null;  // ft (from hourly predictions)
let _cachedActualTideHeight = null;     // ft (from NOAA observed water_level)
let _cachedTideSurge = null;            // ft (actual − predicted)

/* ── Fetch: OWM 3-Hour Forecast (pressure_trend + cloud cover) ── */
/**
 * Fetches the first entry of the OWM 3-hour forecast.
 * Returns both pressure (for pressure_trend) and cloud cover (as a more
 * reliable cloud reading than the current-weather sensor during rain events).
 *
 * pressure_trend = current_pressure − forecastPressure
 *   Positive result = barometer falling  = fish activity high (pre-front).
 *   Negative result = barometer rising   = fish activity quiet (post-front).
 *
 * @returns {Promise<{forecastPressure: number|null, forecastCloudCover: number|null}>}
 */
async function fetchOWMForecast() {
  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${LAT}&lon=${LON}&appid=${OPENWEATHER_API_KEY}&units=imperial&cnt=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[BiscayneFishWatch] OWM Forecast HTTP ${res.status}`);
      return { forecastPressure: null, forecastCloudCover: null };
    }
    const data = await res.json();
    console.log('[BiscayneFishWatch] OWM Forecast raw data:', data);
    const forecastPressure   = data?.list?.[0]?.main?.pressure    ?? null;
    const forecastCloudCover = data?.list?.[0]?.clouds?.all       ?? null;
    console.log(`[BiscayneFishWatch] OWM Forecast — pressure: ${forecastPressure} hPa | cloud cover: ${forecastCloudCover}%`);
    return { forecastPressure, forecastCloudCover };
  } catch (e) {
    console.warn('[BiscayneFishWatch] fetchOWMForecast failed:', e.message);
    return { forecastPressure: null, forecastCloudCover: null };
  }
}

/* ── Solar Position ──────────────────────────────── */
/**
 * Calculate solar elevation angle in degrees using a simplified astronomical
 * formula (NOAA/Meeus). Sufficient precision for the GHI approximation.
 * @param {number} lat  Latitude in decimal degrees
 * @param {number} lon  Longitude in decimal degrees (negative = West)
 * @param {number} dateMs  Unix timestamp in milliseconds (UTC)
 * @returns {number} Solar elevation in degrees [-90, 90]
 */
function computeSolarElevation(lat, lon, dateMs) {
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;

  // Julian date (days since noon 1 Jan 4713 BC)
  const JD = dateMs / 86400000 + 2440587.5;
  // Julian century from J2000.0
  const T = (JD - 2451545.0) / 36525;

  // Geometric mean longitude of the Sun (degrees)
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  // Mean anomaly of the Sun (degrees)
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const Mrad = M * D2R;

  // Equation of center
  const C = Math.sin(Mrad) * (1.914602 - T * (0.004817 + 0.000014 * T))
           + Math.sin(2 * Mrad) * (0.019993 - 0.000101 * T)
           + Math.sin(3 * Mrad) * 0.000289;

  // Sun's true longitude
  const sunLon = L0 + C;

  // Apparent longitude (corrected for aberration)
  const omega = 125.04 - 1934.136 * T;
  const lambda = (sunLon - 0.00569 - 0.00478 * Math.sin(omega * D2R));

  // Mean obliquity of the ecliptic
  const epsilon0 = 23 + (26 + (21.448 - T * (46.8150 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const epsilon = epsilon0 + 0.00256 * Math.cos(omega * D2R);

  // Sun's right ascension and declination
  const sinDec = Math.sin(epsilon * D2R) * Math.sin(lambda * D2R);
  const declination = Math.asin(sinDec) * R2D;

  // Equation of time (minutes) — computed in UTC to avoid timezone drift
  const y = Math.tan((epsilon / 2) * D2R) ** 2;
  const sinL0 = Math.sin(2 * L0 * D2R);
  const cosL0 = Math.cos(2 * L0 * D2R);
  const sinM2 = Math.sin(2 * Mrad);
  const eqTime = 4 * R2D * (y * sinL0 - 2 * 0.016708634 * sinM2
    + 4 * 0.016708634 * y * sinM2 * cosL0
    - 0.5 * y * y * Math.sin(4 * L0 * D2R)
    - 1.25 * 0.016708634 * 0.016708634 * Math.sin(2 * Mrad));

  // True solar time — use UTC minutes directly + longitude correction.
  // This avoids getTimezoneOffset() which varies by browser/OS and causes
  // Miami Timezone Drift in the solar hour angle calculation.
  const utcMinutes = (dateMs / 60000) % (24 * 60); // UTC minutes into the day
  const trueSolarTime = ((utcMinutes + eqTime + 4 * lon) % (24 * 60) + 24 * 60) % (24 * 60);

  // Hour angle (degrees): 0 at solar noon, negative AM, positive PM
  const hourAngle = trueSolarTime / 4 - 180;
  const haRad = hourAngle * D2R;

  // Solar elevation (90° − zenith angle)
  const latRad = lat * D2R;
  const decRad = declination * D2R;
  const cosZenith = Math.sin(latRad) * Math.sin(decRad)
                  + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);

  return Math.asin(Math.max(-1, Math.min(1, cosZenith))) * R2D;
}

/**
 * Compute approximate Global Horizontal Irradiance (W/m²) using:
 *   GHI = 1361 * sin(elevation) * (1 − 0.75*(cloud_cover/100)^3.4)
 * Returns 0 at night (elevation ≤ 0).
 * @param {number} solarElevDeg  Solar elevation in degrees
 * @param {number} cloudCoverPct  Cloud cover 0–100 (%)
 * @returns {number} GHI in W/m²
 */
function computeGHI(solarElevDeg, cloudCoverPct) {
  if (solarElevDeg <= 0) return 0;
  const sinElev = Math.sin(solarElevDeg * Math.PI / 180);
  const cloudFactor = 1 - 0.75 * Math.pow(cloudCoverPct / 100, 3.4);
  return Math.round(1361 * sinElev * cloudFactor);
}

/**
 * Determine if current time is in a crepuscular window (dawn/dusk).
 *
 * Uses a direct solar elevation range check instead of a scanning loop:
 *   -6° to 12° corresponds to civil twilight + the ~60-minute window
 *   around the horizon crossing — timezone-independent and O(1).
 *
 * @param {number} lat     Latitude in decimal degrees
 * @param {number} lon     Longitude in decimal degrees
 * @param {number} dateMs  Current Unix timestamp in ms
 * @param {number} solarElevDeg  Pre-computed solar elevation (degrees)
 * @returns {0|1} 1 if sun is between -6° and 12° elevation, else 0
 */
function computeCrepuscular(lat, lon, dateMs, solarElevDeg) {
  // Crepuscular band: -6° (civil twilight) to +12° (~60 min after sunrise / before sunset)
  const result = (solarElevDeg >= -6.0 && solarElevDeg <= 12.0) ? 1 : 0;
  console.log(`[BiscayneFishWatch] Crepuscular: solarElev=${solarElevDeg.toFixed(2)}° → crepuscular=${result}`);
  return result;
}

/**
 * Compute tidal momentum — the absolute rate of height change (|ft/hr|) between
 * the current and previous hourly NOAA prediction entry.
 * @param {Array<{t: string, v: string}>} hourlyPredictions
 * @returns {number} Absolute slope in ft/hr (0 if unavailable)
 */
function computeTidalMomentum(hourlyPredictions) {
  if (!hourlyPredictions || hourlyPredictions.length < 2) return 0;

  const nowMs = Date.now();
  let currentIdx = -1;
  for (let i = 0; i < hourlyPredictions.length; i++) {
    if (new Date(hourlyPredictions[i].t).getTime() <= nowMs) currentIdx = i;
  }
  if (currentIdx < 1) return 0;

  const curr = parseFloat(hourlyPredictions[currentIdx].v);
  const prev = parseFloat(hourlyPredictions[currentIdx - 1].v);
  if (isNaN(curr) || isNaN(prev)) return 0;

  const momentum = Math.abs(curr - prev); // ft/hr (hourly interval)
  console.log(`[BiscayneFishWatch] Tidal Momentum: ${prev.toFixed(3)} → ${curr.toFixed(3)} ft | Δ=${momentum.toFixed(3)} ft/hr`);
  return Math.round(momentum * 1000) / 1000;
}

/* ── Biscayne Activity Score ─────────────────────── */
/**
 * Calculate the Biscayne Activity Score (0–100) using weighted environmental factors.
 *
 * Weights:
 *   crepuscular     25%  — Full points at dawn/dusk windows
 *   tidal_momentum  20%  — Steeper tide curve = more fish movement
 *   pressure_trend  15%  — Falling barometer (positive delta) = pre-front bonus
 *   wind_speed      15%  — Optimal 3–8 mph for calm but active surface
 *   water_temp      10%  — Optimal 74–82°F for peak fish activity
 *   ghi/cloud_cover  5%  — 20–50% cloud cover = ideal sighting light
 *   moon+rain       10%  — New/full moon bonus; recent rain penalty
 *
 * @param {object} params
 * @returns {number} Integer score 0–100
 */
function calculateActivityScore({
  crepuscular, tidal_momentum, pressure_trend,
  wind_speed, water_temp, ghi, cloud_cover,
  moon_phase, rain_24h
}) {
  let score = 0;

  // ── 1. Crepuscular (25%) ──────────────────────────────
  score += crepuscular === 1 ? 25 : 0;

  // ── 2. Tidal Momentum (20%) ───────────────────────────
  // Scale linearly over 0–1.5 ft/hr; cap at 1.5.
  const MAX_MOMENTUM = 1.5;
  const momentumScore = Math.min(tidal_momentum / MAX_MOMENTUM, 1) * 20;
  score += momentumScore;

  // ── 3. Pressure Trend (15%) ───────────────────────────
  // pressure_trend = current − forecast (positive = falling = pre-front bonus)
  // Clamp to ±5 hPa for scoring purposes.
  let pressureScore = 0;
  if (pressure_trend !== null) {
    if (pressure_trend > 0) {
      // Falling barometer: bonus scaled 0→15 over 0→5 hPa drop
      pressureScore = Math.min(pressure_trend / 5, 1) * 15;
    } else {
      // Rising barometer: neutral to slight penalty (max −7.5)
      pressureScore = Math.max(pressure_trend / 5, -1) * 7.5;
    }
  }
  score += pressureScore;

  // ── 4. Wind Speed (15%) ───────────────────────────────
  // Optimal: 3–8 mph. Linear ramp 0→3 mph and 8→15 mph, then 0 above 15.
  let windScore = 0;
  if (wind_speed >= 3 && wind_speed <= 8) {
    windScore = 15;
  } else if (wind_speed < 3) {
    windScore = (wind_speed / 3) * 15;
  } else if (wind_speed <= 15) {
    windScore = ((15 - wind_speed) / 7) * 15;
  } // else 0 above 15 mph
  score += windScore;

  // ── 5. Water Temperature (10%) ────────────────────────
  // Optimal: 74–82°F. Linear ramp outside that band.
  let tempScore = 0;
  if (water_temp !== null) {
    if (water_temp >= 74 && water_temp <= 82) {
      tempScore = 10;
    } else if (water_temp < 74) {
      tempScore = Math.max(0, ((water_temp - 60) / 14)) * 10; // ramp 60→74
    } else {
      tempScore = Math.max(0, ((95 - water_temp) / 13)) * 10; // ramp 82→95
    }
  } else {
    tempScore = 5; // no data → neutral half-credit
  }
  score += tempScore;

  // ── 6. GHI / Cloud Cover (5%) ─────────────────────────
  // Optimal: 20–50% cloud cover (partial shade = ideal sighting light).
  // At night (ghi=0) give half credit (conditions neutral for nocturnal fish).
  let lightScore = 0;
  if (ghi === 0) {
    lightScore = 2.5; // nighttime — neutral
  } else if (cloud_cover !== null) {
    if (cloud_cover >= 20 && cloud_cover <= 50) {
      lightScore = 5;
    } else if (cloud_cover < 20) {
      // Clear sky — slightly less ideal (glare)
      lightScore = (cloud_cover / 20) * 5;
    } else {
      // Heavy cloud — dims too much
      lightScore = Math.max(0, ((100 - cloud_cover) / 50)) * 5;
    }
  }
  score += lightScore;

  // ── 7. Moon Phase + Rain 24h (10%) ───────────────────
  // Moon: bonus for new (0) or full (0.5) — fish more active near tidal extremes.
  const moonDistFromNew  = Math.min(moon_phase, 1 - moon_phase);       // 0 at new/full
  const moonDistFromFull = Math.abs(moon_phase - 0.5);                  // 0 at full
  const moonBonus = Math.max(
    (1 - moonDistFromNew  / 0.125) * 5,   // peak 5 pts near new moon (±1/8 cycle)
    (1 - moonDistFromFull / 0.125) * 5,   // peak 5 pts near full moon
    0
  );

  // Rain: 24h mm penalty (each mm above 0 reduces score by up to 5 points)
  const rainPenalty = Math.min(rain_24h / 5, 1) * 5;

  score += moonBonus - rainPenalty;

  // ── Clamp & round ─────────────────────────────────────
  const finalScore = Math.round(Math.min(Math.max(score, 0), 100));
  console.log(`[BiscayneFishWatch] Activity Score: ${finalScore}/100 | crep=${crepuscular} momentum=${tidal_momentum.toFixed(2)} pressureDelta=${pressure_trend?.toFixed(1)??'N/A'} wind=${wind_speed.toFixed(1)} temp=${water_temp??'N/A'} cloud=${cloud_cover}% ghi=${ghi} moon=${moon_phase} rain=${rain_24h}mm`);
  return finalScore;
}

/* ── Backend: log a sighting ───────────────────── */
/**
 * Build and POST a sighting record to the Google Apps Script / Sheet backend.
 * Uses cached live data from the last init() run so no extra fetches are needed.
 *
 * Payload fields — 23 keys (snake_case, columns A–W). timestamp generated server-side.
 *   A  token                  — DATABASE_TOKEN
 *   B  water_clarity          — 'Poor' | 'Fair' | 'Great'
 *   C  fish_activity          — 'None' | 'Some' | 'Lots'
 *   D  special_sightings      — comma-separated string or ''
 *   E  season                 — 'Dry Season' | 'Wet Season'
 *   F  wind_speed             — mph
 *   G  wind_deg               — degrees | null
 *   H  pressure               — hPa | null
 *   I  tide_level             — 'IN_WINDOW' | 'OUTSIDE_WINDOW' | 'NO_DATA'
 *   J  tide_trend             — 'Rising' | 'Falling' | 'Unknown'
 *   K  water_temp             — °F | null
 *   L  rain_24h               — mm
 *   M  moon_phase             — 0.0–1.0
 *   N  ghi                    — W/m²
 *   O  tidal_momentum         — ft/hr
 *   P  pressure_trend         — hPa delta (positive = falling)
 *   Q  crepuscular            — 0 | 1
 *   R  cloud_cover            — %
 *   S  activity_score         — 0–100
 *   T  predicted_tide_height  — ft (MLLW, from hourly predictions)
 *   U  actual_tide_height     — ft (MLLW, from NOAA observed water_level)
 *   V  tide_surge             — ft (actual − predicted; + = Surge, − = Blowout)
 *
 * @param {object} userInputs  { water_clarity, fish_activity, special_sightings }
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function sendSighting({ water_clarity, fish_activity, special_sightings }) {
  try {
    const weatherData = _cachedWeather;
    const tideData    = _cachedTideData;
    const waterTempF  = _cachedWaterTemp;

    // Wind
    const wind_speed = weatherData?.wind?.speed ?? 0;
    const wind_deg   = weatherData?.wind?.deg ?? null;

    // Pressure (hPa)
    const pressure = weatherData?.main?.pressure ?? null;

    // Rain (last 1–3 h window — peak volume of current event)
    const rainMm1h = weatherData?.rain?.['1h'] ?? 0;
    const rainMm3h = weatherData?.rain?.['3h'] ?? 0;
    const rain_24h = Math.max(rainMm1h, rainMm3h);

    // Tide
    const predictions = tideData?.predictions ?? [];
    const { inWindow } = evaluateTideWindow(predictions);
    const tide_level = predictions.length === 0
      ? 'NO_DATA'
      : inWindow ? 'IN_WINDOW' : 'OUTSIDE_WINDOW';

    // 23-column payload matching Apps Script columns A–V
    const payload = {
      token:                 DATABASE_TOKEN,              // A
      water_clarity:         String(water_clarity),       // B
      fish_activity:         String(fish_activity),       // C
      special_sightings:     String(special_sightings),   // D
      season:                _cachedSeason?.name ?? 'Unknown', // E
      wind_speed,                                         // F
      wind_deg,                                           // G
      pressure,                                           // H
      tide_level,                                         // I
      tide_trend:            _cachedTideTrend,            // J
      water_temp:            waterTempF,                  // K
      rain_24h,                                           // L
      moon_phase:            _cachedMoonPhase,            // M
      ghi:                   _cachedGhi,                  // N
      tidal_momentum:        _cachedTidalMomentum,        // O
      pressure_trend:        _cachedPressureTrend,        // P
      crepuscular:           _cachedCrepuscular,          // Q
      cloud_cover:           _cachedCloudCover,           // R
      activity_score:        _cachedActivityScore,        // S
      predicted_tide_height: _cachedPredictedTideHeight,  // T
      actual_tide_height:    _cachedActualTideHeight,     // U
      tide_surge:            _cachedTideSurge             // V
    };

    console.log('[Biscayne-Watch] Data Packet Sent (23 cols):', payload);

    // Google Apps Script (no-cors): body must be plain JSON string sent as text/plain
    // to avoid a CORS preflight. The response is opaque — non-throwing = success.
    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });

    console.log('[Biscayne-Watch] Dispatch complete (opaque no-cors — no status available).');
    return { ok: true };

  } catch (err) {
    console.error('[BiscayneFishWatch] sendSighting error:', err);
    return { ok: false, error: err.message };
  }
}

/* ── Progress Tracker ─────────────────────────── */
/**
 * Fetch the current log row count from the Apps Script backend and update
 * the Phase-4 progress footer.
 *
 * Expects the GET response from APPS_SCRIPT_URL to be JSON with a numeric
 * `count` field, e.g. { "count": 42 }.  If the fetch fails or the field is
 * absent the display defaults to "--".
 *
 * The progress bar fills proportionally toward PROGRESS_GOAL.
 */
const PROGRESS_GOAL = 100;

async function updateProgressCount() {
  const countEl = document.getElementById('progress-count');
  const barFill = document.getElementById('progress-bar-fill');
  if (!countEl || !barFill) return;

  try {
    const res = await fetch(`${APPS_SCRIPT_URL}?action=count`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const count = typeof data.count === 'number' ? data.count : null;

    if (count === null) throw new Error('No count field in response');

    countEl.textContent = `Logs Collected: ${count} / ${PROGRESS_GOAL}`;
    const pct = Math.min((count / PROGRESS_GOAL) * 100, 100);
    barFill.style.width = `${pct}%`;
    console.log(`[BiscayneFishWatch] Progress: ${count} / ${PROGRESS_GOAL}`);
  } catch (err) {
    countEl.textContent = `Logs Collected: -- / ${PROGRESS_GOAL}`;
    barFill.style.width = '0%';
    console.warn('[BiscayneFishWatch] updateProgressCount failed:', err.message);
  }
}

/* ── Main orchestration ────────────────────────── */
async function init() {
  // Gate: keep buttons disabled until all data is ready
  setSightingButtonsEnabled(false);
  console.log('System Check - Key Status:', OPENWEATHER_API_KEY.startsWith('__') ? 'Placeholder (NOT injected — will 401)' : 'Injected ✅');

  try {
    // Fetch all six data sources in parallel
    const [
      weatherData,
      tideData,
      { tempF: waterTempF, station: tempStation },
      hourlyTidePredictions,
      { forecastPressure, forecastCloudCover },
      observedWaterLevel
    ] = await Promise.all([
      fetchWeather(),
      fetchTides(),
      fetchWaterTemp(),
      fetchHourlyTides(),
      fetchOWMForecast(),
      fetchObservedWaterLevel()
    ]);

    // ── Compute Environmental Intelligence fields ──────────────────────
    const nowMs = Date.now();
    const currentPressure = weatherData?.main?.pressure ?? null;

    // Cloud cover: prefer the 3-hour forecast reading
    const cloudCoverPct = forecastCloudCover ?? weatherData?.clouds?.all ?? 0;

    // Rain (EI block)
    const eiRainMm1h = weatherData?.rain?.['1h'] ?? 0;
    const eiRainMm3h = weatherData?.rain?.['3h'] ?? 0;
    const rain24hMm  = Math.max(eiRainMm1h, eiRainMm3h);

    // GHI approximation (returns 0 at night)
    const solarElevDeg = computeSolarElevation(LAT, LON, nowMs);
    const ghi = computeGHI(solarElevDeg, cloudCoverPct);

    // Tidal momentum (|ft/hr| slope)
    const tidalMomentum = computeTidalMomentum(hourlyTidePredictions);

    // Pressure trend: current − forecast
    //   Positive = barometer falling  = pre-front signal (Good for activity)
    //   Negative = barometer rising   = post-front quiet
    const pressureTrend = (currentPressure !== null && forecastPressure !== null)
      ? Math.round((currentPressure - forecastPressure) * 100) / 100
      : null;

    // Crepuscular: 1 if within 60 mins of sunrise/sunset
    const crepuscular = computeCrepuscular(LAT, LON, nowMs, solarElevDeg);

    // ── Tidal Reality: predicted height + surge ──────────────────────
    // Predicted height: the current hour's entry from hourly predictions.
    let predictedTideHeight = null;
    if (hourlyTidePredictions.length > 0) {
      let currentIdx = -1;
      for (let i = 0; i < hourlyTidePredictions.length; i++) {
        if (new Date(hourlyTidePredictions[i].t).getTime() <= nowMs) currentIdx = i;
      }
      if (currentIdx >= 0) {
        const val = parseFloat(hourlyTidePredictions[currentIdx].v);
        if (!isNaN(val)) predictedTideHeight = Math.round(val * 100) / 100;
      }
    }
    // Actual (observed) height from NOAA water_level product
    const actualTideHeight = observedWaterLevel !== null
      ? Math.round(observedWaterLevel * 100) / 100
      : null;
    // Surge = actual − predicted (+ve = Surge, −ve = Blowout)
    const tideSurge = (actualTideHeight !== null && predictedTideHeight !== null)
      ? Math.round((actualTideHeight - predictedTideHeight) * 100) / 100
      : null;

    console.log(`[BiscayneFishWatch] Tide Reality — Predicted: ${predictedTideHeight ?? 'N/A'} ft | Actual: ${actualTideHeight ?? 'N/A'} ft | Surge: ${tideSurge ?? 'N/A'} ft`);

    // Biscayne Activity Score
    const activityScore = calculateActivityScore({
      crepuscular,
      tidal_momentum:  tidalMomentum,
      pressure_trend:  pressureTrend,
      wind_speed:      weatherData?.wind?.speed ?? 0,
      water_temp:      waterTempF,
      ghi,
      cloud_cover:     cloudCoverPct,
      moon_phase:      getMoonPhase(),
      rain_24h:        rain24hMm
    });

    // Cache all values for use in sendSighting()
    _cachedWeather             = weatherData;
    _cachedTideData            = tideData;
    _cachedWaterTemp           = waterTempF;
    _cachedTideTrend           = computeTideTrend(hourlyTidePredictions);
    _cachedMoonPhase           = getMoonPhase();
    _cachedSeason              = getCurrentSeason();
    _cachedGhi                 = ghi;
    _cachedTidalMomentum       = tidalMomentum;
    _cachedPressureTrend       = pressureTrend;
    _cachedCrepuscular         = crepuscular;
    _cachedCloudCover          = cloudCoverPct;
    _cachedActivityScore       = activityScore;
    _cachedSolarElevDeg        = solarElevDeg;
    _cachedPredictedTideHeight = predictedTideHeight;
    _cachedActualTideHeight    = actualTideHeight;
    _cachedTideSurge           = tideSurge;
    _dataReady = true;

    const season = _cachedSeason;
    const moonPhase = _cachedMoonPhase;
    const tideTrend = _cachedTideTrend;
    const pressure = weatherData?.main?.pressure ?? null;

    console.log(`[BiscayneFishWatch] Season: ${season.name} (isDry=${season.isDry})`);
    console.log(`[BiscayneFishWatch] Moon Phase: ${moonPhase} (${getMoonPhaseLabel(moonPhase)})`);
    console.log(`[BiscayneFishWatch] Tide Trend: ${tideTrend}`);
    console.log(`[BiscayneFishWatch] Pressure: ${pressure} hPa`);
    console.log(`[BiscayneFishWatch] ── EI Debug ──────────────────────────────────────────`);
    console.log(`[BiscayneFishWatch]   Solar Elevation : ${solarElevDeg.toFixed(2)}°`);
    console.log(`[BiscayneFishWatch]   Rain Volume     : ${rain24hMm.toFixed(2)} mm (max of 1h/3h)`);
    console.log(`[BiscayneFishWatch]   Activity Score  : ${activityScore}/100`);
    console.log(`[BiscayneFishWatch] ─────────────────────────────────────────────────────────`);

    // ── 🌞 Solar & Cloud Verification Table ───────────────────────────
    // High-visibility debug table. Open DevTools → Console to verify.
    const localTime = new Date(nowMs).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
      timeZone: 'America/New_York'
    });
    console.log('%c🌞 BiscayneFishWatch — Solar & Cloud Debug', 'font-size:14px;font-weight:bold;color:#ff9900');
    console.table([
      {
        'Field': 'Local Time (Miami)',
        'Value': localTime,
        'Note':  'America/New_York'
      },
      {
        'Field': 'Solar Elevation (°)',
        'Value': solarElevDeg.toFixed(2),
        'Note':  solarElevDeg < 0 ? '🌙 Night — GHI forced 0' : solarElevDeg < 15 ? '🌅 Low sun (dawn/dusk)' : '☀️ Daytime'
      },
      {
        'Field': 'Cloud Cover — Current API (%)',
        'Value': weatherData?.clouds?.all ?? 'null',
        'Note':  'Raw OpenWeatherMap current weather'
      },
      {
        'Field': 'Cloud Cover — Forecast API (%)',
        'Value': forecastCloudCover ?? 'null',
        'Note':  forecastCloudCover !== null ? '✅ Used for GHI & Score' : '⚠️ Unavailable — fell back to current'
      },
      {
        'Field': 'GHI (W/m²)',
        'Value': ghi,
        'Note':  ghi === 0 ? (solarElevDeg <= 0 ? '🌙 Night' : '☁️ Overcast') : `~${ghi} W/m² (max ~1361)`
      }
    ]);

    /* ─── Hero Card: Viewing Window ─── */
    const viewingWindow = getViewingWindow(solarElevDeg);
    if (hcViewingIcon && hcViewingDot) applyHeroStatus(hcViewingIcon, hcViewingDot, viewingWindow.status);

    /* ─── Hero Card: Tidal Flow ─── */
    const tidalFlowHero = getTidalFlowLabel(tidalMomentum);
    if (hcTideIcon && hcTideDot) applyHeroStatus(hcTideIcon, hcTideDot, tidalFlowHero.status);

    // Tide surge sub-label: "1.8ft | +0.2ft Surge" — shown under the card name
    const tideLabelEl = document.getElementById('hc-tide-label');
    const tideAlertEl = document.getElementById('hc-tide-alert');
    if (tideLabelEl) {
      if (actualTideHeight !== null) {
        const surgeStr = tideSurge !== null
          ? ` | ${tideSurge >= 0 ? '+' : ''}${tideSurge.toFixed(2)}ft ${tideSurge >= 0 ? 'Surge' : 'Blowout'}`
          : '';
        tideLabelEl.textContent = `${actualTideHeight.toFixed(2)}ft${surgeStr}`;
      } else {
        tideLabelEl.textContent = '';
      }
    }
    // Alert icon: non-standard water level (|surge| > 0.5 ft)
    if (tideAlertEl) {
      const surgeSignificant = tideSurge !== null && Math.abs(tideSurge) > 0.5;
      tideAlertEl.hidden = !surgeSignificant;
      tideAlertEl.title  = surgeSignificant
        ? `⚠️ ${tideSurge > 0 ? 'Surge' : 'Blowout'}: water level ${Math.abs(tideSurge).toFixed(2)}ft ${tideSurge > 0 ? 'above' : 'below'} predicted`
        : '';
    }

    /* ─── Hero Card: Barometer ─── */
    const baroHero = getBarometerStatus(pressureTrend);
    if (hcBaroIcon && hcBaroDot) applyHeroStatus(hcBaroIcon, hcBaroDot, baroHero.status);

    /* ─── Hero Card: Water Temp ─── */
    const tempHeroStatus = waterTempF === null ? 'fair'
      : waterTempF >= 74 && waterTempF <= 82 ? 'good'
      : waterTempF >= 65 && waterTempF <= 88 ? 'fair'
      : 'poor';
    if (hcTempIcon && hcTempDot) applyHeroStatus(hcTempIcon, hcTempDot, tempHeroStatus);

    /* ─── Hero Card: Surface Clarity (wind-based) ─── */
    const windSpeedMph = weatherData.wind?.speed ?? 0;
    const clarityStatus = windSpeedMph < 5 ? 'good' : windSpeedMph <= 10 ? 'fair' : 'poor';
    if (hcClarityIcon && hcClarityDot) applyHeroStatus(hcClarityIcon, hcClarityDot, clarityStatus);

    /* internal wind sub-vars used by visibilityEl and overall score */
    const windDir  = weatherData.wind?.deg ?? null;
    const windGust = weatherData.wind?.gust ?? null;
    const windOk   = windSpeedMph < WIND_THRESHOLD_MPH;

    /* ─── Water Temperature (internal only — hero card drives display) ─── */
    let tempOk = true;
    let heatStress = false;

    if (waterTempF === null) {
      tempOk = false;
    } else if (waterTempF > WATER_TEMP_HEAT_STRESS) {
      heatStress = true;
      tempOk = false;
    } else if (waterTempF < WATER_TEMP_IDEAL_MIN || waterTempF > WATER_TEMP_IDEAL_MAX) {
      tempOk = false;
    }

    console.log(`[BiscayneFishWatch] Water Temp: ${waterTempF}°F from ${tempStation} | ok=${tempOk} | heatStress=${heatStress}`);

    /* ─── Rain (internal only — no card DOM to update) ─── */
    const rainMm1h = weatherData.rain?.['1h'] ?? 0;
    const rainMm3h = weatherData.rain?.['3h'] ?? 0;
    const rainIn2h = rainMm1h > 0 || rainMm3h > 0;
    let rainOk = !rainIn2h;
    let wetSeasonPenalty = false;
    if (!season.isDry && rainIn2h) {
      const rainIn3h = mmToIn(rainMm3h > 0 ? rainMm3h : rainMm1h);
      if (rainIn3h > WET_SEASON_RAIN_PENALTY_IN) { wetSeasonPenalty = true; rainOk = false; }
    }

    /* ─── Visibility score (still drives the visibilityEl banner) ─── */
    let visLabel, visClass;
    if (windSpeedMph < VIS_EXCELLENT_MPH) {
      visLabel = '👁 Visibility: Excellent'; visClass = 'vis-excellent';
    } else if (windSpeedMph <= VIS_GOOD_MPH) {
      visLabel = '👁 Visibility: Good'; visClass = 'vis-good';
    } else {
      visLabel = '👁 Visibility: Low'; visClass = 'vis-low';
    }
    if (season.isDry) visLabel += ' (+Dry Season clarity)';
    visLabel += `  ·  ${getMoonPhaseLabel(moonPhase)}`;
    visibilityEl.textContent = visLabel;
    visibilityEl.className = `visibility-score ${visClass}`;

    /* ─── Tides (internal variables for overall score) ─── */
    const predictions = tideData.predictions ?? [];
    const { inWindow, nearestHigh, deltaMinutes } = evaluateTideWindow(predictions);

    renderTideTimeline(predictions, nearestHigh);

    /* ─── Overall condition (seasonal logic applied) ─── */

    // Base score from the 3 core conditions
    let score = [windOk, inWindow, rainOk].filter(Boolean).length;

    // Water Temp bonus: 74–82°F is peak fish activity — counts as a bonus pass.
    // If 2 core conditions pass AND water temp is in the bonus range, elevate to OPTIMAL.
    const tempBonus = waterTempF !== null
      && waterTempF >= WATER_TEMP_BONUS_MIN
      && waterTempF <= WATER_TEMP_IDEAL_MAX;
    if (tempBonus && score === 2) {
      score = 3; // boost to OPTIMAL
    }

    // Dry Season: visibility bonus — if wind is excellent AND in dry season,
    // treat wind as a "double-weight" pass by granting +1 if score is otherwise 2
    // and temp bonus hasn't already resolved it.
    if (season.isDry && windSpeedMph < VIS_EXCELLENT_MPH && score === 2 && inWindow && rainOk) {
      score = 3; // boost to OPTIMAL
    }

    // Wet Season: additional penalty already applied above to rainOk.

    let rating, subtitle;

    // Heat stress overrides to FAIR regardless of score
    if (heatStress) {
      rating = 'FAIR';
      subtitle = `Fair - Fish may be deep. Water at ${waterTempF.toFixed(1)}°F exceeds ${WATER_TEMP_HEAT_STRESS}°F heat stress threshold.`;
    } else if (score === 3) {
      rating = 'OPTIMAL';
      const bonusNotes = [];
      if (tempBonus) bonusNotes.push(`water temp ${waterTempF.toFixed(1)}°F in peak range`);
      if (season.isDry) bonusNotes.push('dry season clarity');
      const bonusSuffix = bonusNotes.length ? ` · Bonus: ${bonusNotes.join(' & ')}.` : '';
      subtitle = `All conditions are favorable — great time to head out!${bonusSuffix}`;
    } else if (score === 2) {
      rating = 'FAIR';
      const bad = [];
      if (!windOk) bad.push(`wind at ${windSpeedMph.toFixed(1)} mph`);
      if (!inWindow) bad.push('outside prime tide window');
      if (!rainOk) bad.push(wetSeasonPenalty ? 'wet season runoff risk' : 'recent rain detected');
      if (!tempOk && !heatStress) bad.push(`water temp ${waterTempF !== null ? waterTempF.toFixed(1) + '°F' : 'N/A'}`);
      subtitle = `Expect some challenges: ${bad.join(', ')}.`;
    } else {
      rating = 'POOR';
      subtitle = 'Conditions are unfavorable. Consider waiting for better conditions.';
    }

    renderCondition(rating, subtitle);

    // All data loaded — enable log button
    setSightingButtonsEnabled(true);

    // Fetch initial log count for the progress footer
    updateProgressCount();

  } catch (err) {
    console.error('[BiscayneFishWatch] Error loading data:', err);

    condBadge.classList.remove('loading');
    condBadge.classList.add('poor');
    condText.textContent = 'Error';
    condSub.textContent = `Could not load data: ${err.message}`;

    [windValue, tideValue, rainValue, tempValue].forEach(el => {
      el.textContent = 'Error'; el.style.color = 'var(--poor)';
    });
    [windDetail, tideDetail, rainDetail, tempDetail].forEach(el => { el.textContent = err.message; });
    if (seasonValue) seasonValue.textContent = '—';
    if (seasonDetail) seasonDetail.textContent = err.message;
    tideTimeline.innerHTML = `<p class="error-msg">${err.message}</p>`;

    // On error, update pill to indicate failure (keep log button disabled)
    setSyncState('idle', 'Data load failed');
    if (logBtn) { logBtn.disabled = true; }
  }
}

// Kick off on page load
init();

/* ── Live Report: modal + sighting logic ────────────── */
(function initSightingModal() {
  // Open modal on main button click
  if (logBtn) {
    logBtn.addEventListener('click', openModal);
  }

  // Close modal via the × button or Cancel
  [modalClose, btnCancel].forEach(el => {
    if (el) el.addEventListener('click', closeModal);
  });

  // Close when clicking the dim overlay (outside the card)
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModal();
    });
  }

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalOverlay && !modalOverlay.hidden) closeModal();
  });

  // Form submit
  if (sightingForm) {
    sightingForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      // Collect form values
      const data = new FormData(sightingForm);
      const water_clarity   = data.get('water_clarity') ?? '';
      const fish_activity   = data.get('fish_activity') ?? '';
      const special_sightings = data.getAll('special_sightings').join(', ');

      // Validation: both required fields must be selected
      if (!water_clarity || !fish_activity) {
        formError.hidden = false;
        return;
      }
      formError.hidden = true;

      // Broadcasting state
      btnSubmit.disabled = true;
      btnSubmit.textContent = 'Broadcasting…';
      logBtn.classList.add('broadcasting');
      setSyncState('syncing', 'Broadcasting sighting…');

      // Send to backend
      await sendSighting({ water_clarity, fish_activity, special_sightings });

      // Success! Close modal and show toast
      closeModal();
      logBtn.classList.remove('broadcasting');
      setSyncState('success', 'Sighting Broadcasted to Cloud.');

      // Refresh progress count
      updateProgressCount();

      // Reset pill after 4 s
      setTimeout(() => setSyncState('idle', 'Ready to Log'), 4000);
    });
  }
})();

/* ── Info Popup ─────────────────────────────────────────────────── */
(function initInfoPopup() {
  const overlay    = document.getElementById('info-popup-overlay');
  const closeBtn   = document.getElementById('info-popup-close');
  const popupIcon  = document.getElementById('popup-icon');
  const popupTitle = document.getElementById('popup-title');
  const popupLive  = document.getElementById('popup-live');
  const popupImp   = document.getElementById('popup-importance');
  const popupInter = document.getElementById('popup-interpretation');

  if (!overlay) return;

  /**
   * Card definitions. `liveData` is a function so it always reads the latest
   * cached values when the user taps a card.
   */
  const CARDS = {
    'hc-viewing': {
      title: 'Viewing Window',
      icon: '🌅',
      liveData() {
        const score = _cachedActivityScore !== null ? _cachedActivityScore : '–';
        const elev  = _cachedSolarElevDeg;          // real solar elevation in degrees
        const vw    = getViewingWindow(elev);
        return `Status: ${vw.label}\nSolar Elevation: ${elev.toFixed(1)}°\nActivity Score: ${score}/100`;
      },
      importance: 'Solar angle dictates how deep light penetrates the water and how visible fish are near the surface. Low-angle dawn and dusk light creates a "magic window" where fish are most active and easiest to spot from above.',
      interpretation: '🌙 Night → poor visibility. 🌅 Dawn/Dusk (−6° to 2°) → high activity, low light. ⭐ PEAK (2°–15°) → best sighting conditions. ☀️ Good (15°–35°) → fine visibility. 🥵 Midday above 35° → surface glare reduces sighting success.',
    },
    'hc-tide': {
      title: 'Tidal Flow',
      icon: '🌊',
      liveData() {
        const tm = _cachedTidalMomentum !== null ? _cachedTidalMomentum.toFixed(3) : '–';
        const lbl = getTidalFlowLabel(_cachedTidalMomentum ?? 0);
        return `Status: ${lbl.label}\nMomentum: ${tm} ft/hr`;
      },
      importance: 'Moving water carries baitfish and zooplankton that attract larger fish. Strong tidal flow concentrates prey around structure — bridges, seagrass edges, and channel margins become hot spots during peak current.',
      interpretation: '💧 Strong Current (≥ 0.3 ft/hr) → fish are feeding actively near structure. 〰️ Moderate Flow (0.1–0.3) → decent activity. 🧲 Slack Water (< 0.1) → tide has stalled; fish disperse and feeding slows.',
    },
    'hc-baro': {
      title: 'Barometric Trend',
      icon: '📊',
      liveData() {
        const pt = _cachedPressureTrend !== null ? _cachedPressureTrend.toFixed(2) : '–';
        const lbl = getBarometerStatus(_cachedPressureTrend);
        return `Status: ${lbl.label}\nTrend: ${pt} hPa delta`;
      },
      importance: 'Fish swim bladders are sensitive to pressure changes. A falling barometer (approaching front) triggers a short feeding frenzy. A rising barometer after a front passes often suppresses fish activity as they adjust to the new pressure.',
      interpretation: '📉 Dropping > 0.5 hPa → fish feeding aggressively, head out now. ⚖️ Stable (±0.5 hPa) → normal behavior. 📈 Rising → fish may be inactive; try deeper water or slow presentations.',
    },
    'hc-temp': {
      title: 'Water Temperature',
      icon: '🌡️',
      liveData() {
        const t = _cachedWeather ? (_cachedWeather.main?.temp_water ?? null) : null;
        // We store waterTempF indirectly; surface the last known value from the global
        const tStr = typeof _cachedTidalMomentum === 'number' ? '–' : '–'; // placeholder
        const status = t !== null
          ? (t >= 74 && t <= 82 ? '🟢 Ideal' : t >= 65 && t <= 88 ? '🟡 Acceptable' : '🔴 Stress')
          : 'Loading…';
        return `Status: ${status}\nRange: 74–82°F ideal for Biscayne Bay`;
      },
      importance: 'Water temperature directly controls fish metabolism. In Biscayne Bay, the 74–82°F range is optimal for snook, tarpon, and bonefish — they are most active and likely to be in the shallows feeding.',
      interpretation: '🟢 74–82°F → peak metabolic activity; fish in flats and shallows. 🟡 65–74°F → cooler water slows fish; look near bridges and deeper channels. 🟡 82–88°F → warm but tolerable. 🔴 > 88°F → heat stress; fish retreat to depth.',
    },
    'hc-clarity': {
      title: 'Surface Clarity',
      icon: '👁',
      liveData() {
        const ws = _cachedWeather?.wind?.speed ?? null;
        const mph = ws !== null ? ws.toFixed(1) : '–';
        const status = ws === null ? 'Loading…' : ws < 5 ? '🟢 Calm — Excellent' : ws <= 10 ? '🟡 Moderate chop' : '🔴 Choppy — Low clarity';
        return `Status: ${status}\nWind: ${mph} mph`;
      },
      importance: 'Wind-driven surface chop scatters light and reduces the depth at which you can visually spot fish. Calm water in Biscayne Bay lets you sight-fish in as little as 6 inches of water.',
      interpretation: '🟢 < 5 mph → glassy surface, excellent sight-fishing. 🟡 5–10 mph → light chop; polarized glasses essential. 🔴 > 10 mph → choppy surface; switch to blind-casting techniques near structure.',
    },
  };

  function openInfoPopup(cardId) {
    const cfg = CARDS[cardId];
    if (!cfg) return;

    // Icon color matches card status dot
    const dotEl = document.getElementById(`${cardId}-dot`);
    const statusColor = dotEl?.classList.contains('good') ? 'rgba(0,224,160,0.18)'
      : dotEl?.classList.contains('fair') ? 'rgba(245,184,0,0.18)'
      : 'rgba(255,82,82,0.18)';

    popupIcon.textContent  = cfg.icon;
    popupIcon.style.background = statusColor;
    popupTitle.textContent = cfg.title;
    popupLive.textContent  = cfg.liveData();
    popupImp.textContent   = cfg.importance;
    popupInter.textContent = cfg.interpretation;
    overlay.hidden = false;
    closeBtn.focus();
  }

  function closeInfoPopup() { overlay.hidden = true; }

  // Wire hero card buttons
  Object.keys(CARDS).forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => openInfoPopup(id));
  });

  // Close on × button, overlay click, or Escape
  closeBtn.addEventListener('click', closeInfoPopup);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeInfoPopup(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) closeInfoPopup();
  });
})();

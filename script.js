/**
 * Biscayne Bay Fish Watch — script.js
 *
 * Data sources:
 *   1. OpenWeatherMap "Current Weather" API — wind speed, rain, pressure
 *   2. NOAA CO-OPS Tides API     — Station 8723165 (Miamarina) — hi/lo & hourly
 *   3. NOAA CO-OPS Water Temp    — Station 8723214 (Virginia Key),
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
 * Deep Data additions:
 *   Pressure    — main.pressure from OpenWeatherMap (hPa)
 *   Tide Trend  — "Rising" / "Falling" from hourly NOAA predictions
 *   Moon Phase  — 0.0–1.0 via synodic cycle calculation
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

const windValue = document.getElementById('wind-value');
const windDetail = document.getElementById('wind-detail');
const windDot = document.getElementById('wind-status-dot');
const windCard = document.getElementById('wind-card');

const tideValue = document.getElementById('tide-value');
const tideDetail = document.getElementById('tide-detail');
const tideDot = document.getElementById('tide-status-dot');
const tideCard = document.getElementById('tide-card');

const rainValue = document.getElementById('rain-value');
const rainDetail = document.getElementById('rain-detail');
const rainDot = document.getElementById('rain-status-dot');
const rainCard = document.getElementById('rain-card');

// New: Season & Water Temp cards
const seasonValue = document.getElementById('season-value');
const seasonDetail = document.getElementById('season-detail');
const seasonDot = document.getElementById('season-status-dot');
const seasonCard = document.getElementById('season-card');

const tempValue = document.getElementById('temp-value');
const tempDetail = document.getElementById('temp-detail');
const tempDot = document.getElementById('temp-status-dot');
const tempCard = document.getElementById('temp-card');

const tideTimeline = document.getElementById('tide-timeline');

/* ── Sighting button refs ──────────────────────── */
const allSightingBtns = document.querySelectorAll('.sighting-btn');
const syncStatus = document.getElementById('sync-status');
const syncLabel = document.getElementById('sync-label');

/* ── UI helpers ────────────────────────────────── */

/**
 * Apply a traffic-light class to a card and dot.
 * @param {'good'|'fair'|'poor'} status
 */
function applyStatus(card, dot, status) {
  ['good', 'fair', 'poor'].forEach(s => {
    card.classList.remove(s);
    dot.classList.remove(s);
  });
  card.classList.add(status);
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
 * Enable or disable all sighting buttons.
 * Also updates the sync pill message when disabling (loading state).
 */
function setSightingButtonsEnabled(enabled) {
  allSightingBtns.forEach(btn => {
    btn.disabled = !enabled;
    if (!enabled) {
      btn.style.opacity = '0.45';
      btn.style.cursor = 'not-allowed';
    } else {
      btn.style.opacity = '';
      btn.style.cursor = '';
    }
  });

  if (!enabled) {
    setSyncState('syncing', 'Loading Environment Data…');
  } else {
    setSyncState('idle', 'Ready to Log');
  }
}

/* ── Fetch: OpenWeatherMap ─────────────────────── */
async function fetchWeather() {
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${LAT}&lon=${LON}&appid=${OPENWEATHER_API_KEY}&units=imperial`;
  console.log('Current OpenWeather URL:', url.split('appid=')[0] + 'appid=HIDDEN');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenWeatherMap: ${res.status} ${res.statusText}`);
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

/* ── Backend: log a sighting ───────────────────── */
/**
 * Build and POST a sighting record to the Google Apps Script / Sheet backend.
 * Uses cached live data from the last init() run so no extra fetches are needed.
 *
 * Payload fields (Deep Data):
 *   token      — DATABASE_TOKEN for server-side verification
 *   label      — sighting label (e.g. 'No Fish', 'Some Fish', 'Lots of Fish')
 *   timestamp  — ISO-8601 string (local device time)
 *   season     — 'Dry Season' | 'Wet Season'
 *   windSpeed  — mph (number)
 *   windDeg    — degrees (number | null)
 *   pressure   — hPa from OpenWeatherMap main.pressure (number | null)
 *   tideLevel  — 'IN_WINDOW' | 'OUTSIDE_WINDOW' | 'NO_DATA'
 *   tideTrend  — 'Rising' | 'Falling' | 'Unknown'
 *   waterTemp  — °F (number | null)
 *   rain24h    — mm rain detected in last 1–3 h window (number)
 *   moonPhase  — 0.0–1.0 synodic phase
 *
 * @param {string} label  A short description of the sighting.
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
async function sendSighting(label) {
  try {
    // Use cached data if available; otherwise re-fetch
    const weatherData = _cachedWeather;
    const tideData = _cachedTideData;
    const waterTempF = _cachedWaterTemp;

    // Wind
    const windSpeed = weatherData?.wind?.speed ?? 0;   // mph (imperial)
    const windDeg = weatherData?.wind?.deg ?? null;

    // Pressure (hPa)
    const pressure = weatherData?.main?.pressure ?? null;

    // Rain (last 1–3 h window)
    const rainMm1h = weatherData?.rain?.['1h'] ?? 0;
    const rainMm3h = weatherData?.rain?.['3h'] ?? 0;
    const rain24h = rainMm1h > 0 ? rainMm1h : rainMm3h;

    // Tide
    const predictions = tideData?.predictions ?? [];
    const { inWindow } = evaluateTideWindow(predictions);
    const tideLevel = predictions.length === 0
      ? 'NO_DATA'
      : inWindow ? 'IN_WINDOW' : 'OUTSIDE_WINDOW';

    const payload = {
      token: DATABASE_TOKEN,
      label: String(label),
      timestamp: new Date().toISOString(),
      season: _cachedSeason?.name ?? 'Unknown',
      windSpeed,
      windDeg,
      pressure,
      tideLevel,
      tideTrend: _cachedTideTrend,
      waterTemp: waterTempF,
      rain24h,
      moonPhase: _cachedMoonPhase
    };

    console.log('[Biscayne-Watch] Data Packet Sent:', payload);

    // Google Apps Script (no-cors): body must be plain JSON string sent as text/plain
    // to avoid a CORS preflight. The response is opaque — we cannot read status or
    // body, so a non-throwing fetch is treated as a successful dispatch.
    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });

    console.log('[Biscayne-Watch] Dispatch complete (opaque no-cors response — no status available).');
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

  try {
    // Fetch all four data sources in parallel
    const [weatherData, tideData, { tempF: waterTempF, station: tempStation }, hourlyTidePredictions] = await Promise.all([
      fetchWeather(),
      fetchTides(),
      fetchWaterTemp(),
      fetchHourlyTides()
    ]);

    // Cache for use in sendSighting()
    _cachedWeather = weatherData;
    _cachedTideData = tideData;
    _cachedWaterTemp = waterTempF;
    _cachedTideTrend = computeTideTrend(hourlyTidePredictions);
    _cachedMoonPhase = getMoonPhase();
    _cachedSeason = getCurrentSeason();
    _dataReady = true;

    const season = _cachedSeason;
    const moonPhase = _cachedMoonPhase;
    const tideTrend = _cachedTideTrend;
    const pressure = weatherData?.main?.pressure ?? null;

    console.log(`[BiscayneFishWatch] Season: ${season.name} (isDry=${season.isDry})`);
    console.log(`[BiscayneFishWatch] Moon Phase: ${moonPhase} (${getMoonPhaseLabel(moonPhase)})`);
    console.log(`[BiscayneFishWatch] Tide Trend: ${tideTrend}`);
    console.log(`[BiscayneFishWatch] Pressure: ${pressure} hPa`);

    /* ─── Season ─── */
    // Season card: informational — always "good" (just a label)
    seasonValue.textContent = season.isDry ? '☀️ Dry' : '🌧️ Wet';
    seasonDetail.textContent = season.isDry
      ? 'Nov–Apr · Clearer water, calmer winds'
      : 'May–Oct · Rain runoff risk higher';
    applyStatus(seasonCard, seasonDot, season.isDry ? 'good' : 'fair');

    /* ─── Water Temperature ─── */
    let tempOk = true;   // true = within ideal range
    let heatStress = false;  // > 88°F override
    let tempLabel, tempDetailText, tempCardStatus;

    if (waterTempF === null) {
      tempLabel = 'N/A';
      tempDetailText = 'No data from Virginia Key or Dodge Island sensors';
      tempCardStatus = 'fair';
      tempOk = false;
    } else if (waterTempF > WATER_TEMP_HEAT_STRESS) {
      heatStress = true;
      tempOk = false;
      tempLabel = `${waterTempF.toFixed(1)}°F`;
      tempDetailText = `⚠️ Heat stress > ${WATER_TEMP_HEAT_STRESS}°F — fish likely deep`;
      tempCardStatus = 'poor';
    } else if (waterTempF >= WATER_TEMP_IDEAL_MIN && waterTempF <= WATER_TEMP_IDEAL_MAX) {
      tempLabel = `${waterTempF.toFixed(1)}°F`;
      tempDetailText = `Ideal range ${WATER_TEMP_IDEAL_MIN}–${WATER_TEMP_IDEAL_MAX}°F — peak fish activity`;
      tempCardStatus = 'good';
    } else {
      // Outside ideal but not heat stress
      tempOk = false;
      tempLabel = `${waterTempF.toFixed(1)}°F`;
      tempDetailText = waterTempF < WATER_TEMP_IDEAL_MIN
        ? `Cool — below ideal ${WATER_TEMP_IDEAL_MIN}°F min`
        : `Warm — above ideal ${WATER_TEMP_IDEAL_MAX}°F max`;
      tempCardStatus = 'fair';
    }

    // Append sensor source to detail text
    const stationLabel = tempStation === '8723214' ? 'Virginia Key' : tempStation === 'mi0401' ? 'Dodge Island' : tempStation;
    if (waterTempF !== null && stationLabel) {
      tempDetailText += ` · ${stationLabel} sensor`;
    }

    tempValue.textContent = tempLabel;
    tempDetail.textContent = tempDetailText;
    applyStatus(tempCard, tempDot, tempCardStatus);

    console.log(`[BiscayneFishWatch] Water Temp: ${waterTempF}°F from ${tempStation} | ok=${tempOk} | heatStress=${heatStress}`);

    /* ─── Weather: wind ─── */
    const windSpeedMph = weatherData.wind?.speed ?? 0;
    const windDir = weatherData.wind?.deg ?? null;
    const windGust = weatherData.wind?.gust ?? null;
    const windOk = windSpeedMph < WIND_THRESHOLD_MPH;

    windValue.textContent = `${windSpeedMph.toFixed(1)} mph`;
    windDetail.textContent = windDir !== null
      ? `Direction: ${windDir}°${windGust ? ` · Gusts ${windGust.toFixed(1)} mph` : ''}${pressure ? ` · ${pressure} hPa` : ''}`
      : `Direction unavailable${pressure ? ` · ${pressure} hPa` : ''}`;
    applyStatus(windCard, windDot, windOk ? 'good' : 'poor');

    /* ─── Visibility Score (wind-based + seasonal weights) ─── */
    let visLabel, visClass;
    if (windSpeedMph < VIS_EXCELLENT_MPH) {
      visLabel = '👁 Visibility: Excellent'; visClass = 'vis-excellent';
    } else if (windSpeedMph <= VIS_GOOD_MPH) {
      visLabel = '👁 Visibility: Good'; visClass = 'vis-good';
    } else {
      visLabel = '👁 Visibility: Low'; visClass = 'vis-low';
    }

    // Dry season: note bonus clarity
    if (season.isDry) {
      visLabel += ' (+Dry Season clarity)';
    }

    // Moon phase note
    visLabel += `  ·  ${getMoonPhaseLabel(moonPhase)}`;

    visibilityEl.textContent = visLabel;
    visibilityEl.className = `visibility-score ${visClass}`;

    /* ─── Weather: rain (2-hour window + 24h conversion for penalty) ─── */
    const rainMm1h = weatherData.rain?.['1h'] ?? 0;
    const rainMm3h = weatherData.rain?.['3h'] ?? 0;
    const rainIn2h = rainMm1h > 0 || rainMm3h > 0;
    let rainOk = !rainIn2h;
    const displayRain = rainMm1h > 0 ? rainMm1h : rainMm3h;

    // Wet-season penalty: if precip exceeds 0.5 in in last 24h equivalent
    // OWM's "3h" field is the closest proxy for a short accumulation window.
    // We apply the penalty when in wet season AND rain is detected.
    let wetSeasonPenalty = false;
    if (!season.isDry && rainIn2h) {
      const rainIn3h = mmToIn(rainMm3h > 0 ? rainMm3h : rainMm1h);
      // Scale to estimate 24-h: if 3h reading already exceeds threshold, flag it
      if (rainIn3h > WET_SEASON_RAIN_PENALTY_IN) {
        wetSeasonPenalty = true;
        rainOk = false; // explicit penalty
      }
    }

    rainValue.textContent = rainIn2h ? `${displayRain.toFixed(1)} mm` : 'None';
    rainDetail.textContent = rainOk
      ? 'No precipitation in the last 2 hours'
      : wetSeasonPenalty
        ? `🌧 Wet Season runoff risk — ${displayRain.toFixed(1)} mm detected`
        : `Rain detected — ${displayRain.toFixed(1)} mm (last 1–3 hrs)`;
    applyStatus(rainCard, rainDot, rainOk ? 'good' : displayRain < 1 ? 'fair' : 'poor');

    /* ─── Tides ─── */
    const predictions = tideData.predictions ?? [];
    const { inWindow, nearestHigh, deltaMinutes } = evaluateTideWindow(predictions);

    let tideValText, tideDetText;
    if (!nearestHigh) {
      tideValText = 'N/A';
      tideDetText = 'No high tide data today';
    } else {
      const absDelta = Math.abs(deltaMinutes);
      const direction = deltaMinutes > 0 ? 'after' : 'before';
      tideValText = inWindow ? `-2h/+1h ✓` : `Outside window`;
      tideDetText = absDelta < 1
        ? `High tide is now (${fmtTime(nearestHigh.date)})`
        : `${fmtDuration(absDelta)} ${direction} high at ${fmtTime(nearestHigh.date)}`;
    }

    // Append tide trend
    if (tideTrend !== 'Unknown') {
      tideDetText += ` · ${tideTrend === 'Rising' ? '↑' : '↓'} ${tideTrend}`;
    }

    tideValue.textContent = tideValText;
    tideDetail.textContent = tideDetText;
    applyStatus(tideCard, tideDot, inWindow ? 'good' : 'poor');

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

    // All data loaded — enable sighting buttons
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

    // On error, update pill to indicate failure (keep buttons disabled)
    setSyncState('idle', 'Data load failed');
    allSightingBtns.forEach(btn => {
      btn.disabled = true;
      btn.style.opacity = '0.45';
      btn.style.cursor = 'not-allowed';
    });
  }
}

// Kick off on page load
init();

/* ── Live Report: sighting button logic ─────────────── */
(function initSightingButtons() {
  const LOCK_MS = 5000; // 5 s lock to prevent duplicate entries

  allSightingBtns.forEach(btn => {
    // Store original inner HTML to restore after success
    btn.addEventListener('click', async () => {
      const value = parseInt(btn.dataset.value, 10);
      const labels = { 0: 'No Fish', 1: 'Some Fish', 2: 'Lots of Fish' };
      const label = labels[value] ?? String(value);

      // Disable all buttons for LOCK_MS to prevent duplicate entries
      allSightingBtns.forEach(b => { b.disabled = true; b.style.opacity = '0.45'; b.style.cursor = 'not-allowed'; });

      // UI feedback: show "Syncing..." on the clicked button
      const originalHTML = btn.innerHTML;
      btn.innerHTML = `<span class="sighting-emoji">⏳</span><span class="sighting-label">Syncing…</span>`;
      setSyncState('syncing', 'Broadcasting sighting…');

      // Fire-and-forget — no-cors hides the server response so we treat
      // any non-throwing dispatch as success.
      await sendSighting(label);

      // UI feedback: show "Success!" on the clicked button
      btn.innerHTML = `<span class="sighting-emoji">✅</span><span class="sighting-label">Success!</span>`;

      // Refresh progress count after a successful sighting
      updateProgressCount();

      // Green pulse: add class to the clicked button for 2 s
      btn.classList.add('btn-broadcast');
      setTimeout(() => btn.classList.remove('btn-broadcast'), 2000);

      // Sync pill: show success message
      setSyncState('success', 'Sighting Broadcasted to Cloud.');

      // After LOCK_MS re-enable buttons and reset pill
      setTimeout(() => {
        // Restore original HTML
        btn.innerHTML = originalHTML;
        allSightingBtns.forEach(b => { b.disabled = false; b.style.opacity = ''; b.style.cursor = ''; });
        setSyncState('idle', 'Ready to Log');
      }, LOCK_MS);
    });
  });
})();

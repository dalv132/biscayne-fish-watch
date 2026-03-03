/**
 * Biscayne Bay Fish Watch — script.js
 *
 * Data sources:
 *   1. OpenWeatherMap "Current Weather" API — wind speed & rain
 *   2. NOAA CO-OPS Tides API — Station 8723214 (Virginia Key)
 *
 * Condition logic:
 *   OPTIMAL  →  ALL 3 conditions met
 *   FAIR     →  EXACTLY 2 of 3 conditions met
 *   POOR     →  fewer than 2 conditions met
 *
 * Tide window:
 *   "Good" if current time is within ±2 hours of the nearest HIGH tide event.
 */

/* ── Constants ─────────────────────────────────── */
const OPENWEATHER_API_KEY = '0494e55eedb7fc261cf895d4c4118b25';

const LAT = 25.788996;
const LON = -80.172930;
const NOAA_STATION = '8723214'; // Virginia Key

const WIND_THRESHOLD_MPH = 12;   // below = OK
const TIDE_WINDOW_HOURS = 2;    // ±2 h around high tide = OK
const MS_PER_HOUR = 3600000;

/* ── Helpers ───────────────────────────────────── */

/** Convert m/s → mph */
const msToMph = (ms) => ms * 2.23694;

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

const tideTimeline = document.getElementById('tide-timeline');

/* ── UI helpers ────────────────────────────────── */

/**
 * Apply a traffic-light class to a card, dot, and value.
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
  condBadge.classList.add(rating.toLowerCase());
  condText.textContent = rating;
  condSub.textContent = metricsText;
  lastUpdated.textContent = `Last updated: ${fmtTime(new Date())}`;
}

/* ── Fetch: OpenWeatherMap ─────────────────────── */
async function fetchWeather() {
  const key = OPENWEATHER_API_KEY;
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${LAT}&lon=${LON}&appid=${key}&units=imperial`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenWeatherMap: ${res.status} ${res.statusText}`);
  const data = await res.json();

  // 🔍 Debug: raw OpenWeatherMap response
  console.log('[BiscayneFishWatch] OpenWeatherMap raw data:', data);

  return data;
}

/* ── Fetch: NOAA Tides ─────────────────────────── */
async function fetchTides() {
  const date = todayNoaaDate();
  const url = [
    'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter',
    `?product=predictions`,
    `&application=biscayne_fish_watch`,
    `&begin_date=${date}`,
    `&end_date=${date}`,
    `&datum=MLLW`,
    `&station=${NOAA_STATION}`,
    `&time_zone=lst_ldt`,  // local standard/daylight time
    `&interval=hilo`,       // high/low events only
    `&units=english`,
    `&format=json`
  ].join('');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`NOAA: ${res.status} ${res.statusText}`);
  const data = await res.json();

  // 🔍 Debug: raw NOAA tide response
  console.log('[BiscayneFishWatch] NOAA Tides raw data:', data);

  if (data.error) throw new Error(`NOAA error: ${data.error.message}`);
  return data;
}

/* ── Tide window logic ─────────────────────────── */
/**
 * Given an array of NOAA tide predictions, find the nearest HIGH tide
 * and determine whether the current time is within ±TIDE_WINDOW_HOURS of it.
 *
 * NOAA returns predictions in this shape:
 *   { t: "2025-03-02 06:42", v: "1.245", type: "H" }
 *
 * We parse the "t" string as a local date, compute the delta in milliseconds
 * between now and that high-tide moment, then check if |delta| ≤ window.
 *
 * @param {Array} predictions  - NOAA hilo predictions array
 * @returns {{ inWindow: boolean, nearestHigh: Date|null, deltaMinutes: number, allHighs: Date[] }}
 */
function evaluateTideWindow(predictions) {
  const now = Date.now();

  // Filter to HIGH tide events and parse their times
  const highs = predictions
    .filter(p => p.type === 'H')
    .map(p => ({
      date: new Date(p.t),   // "YYYY-MM-DD HH:MM" parsed as local time
      height: parseFloat(p.v)
    }));

  if (highs.length === 0) {
    return { inWindow: false, nearestHigh: null, deltaMinutes: Infinity, allHighs: [] };
  }

  // Find the high tide whose time is closest to now
  let nearest = highs[0];
  let minDelta = Math.abs(now - nearest.date.getTime());

  for (let i = 1; i < highs.length; i++) {
    const d = Math.abs(now - highs[i].date.getTime());
    if (d < minDelta) {
      minDelta = d;
      nearest = highs[i];
    }
  }

  const deltaMs = now - nearest.date.getTime();  // positive = past high tide
  const deltaMinutes = Math.round(deltaMs / 60000);
  const inWindow = Math.abs(deltaMs) <= TIDE_WINDOW_HOURS * MS_PER_HOUR;

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
    const inWin = isHigh && Math.abs(deltaMs) <= TIDE_WINDOW_HOURS * MS_PER_HOUR;

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
      tag.textContent = '±2h Window';
      el.appendChild(tag);
    }

    tideTimeline.appendChild(el);
  });
}

/* ── Main orchestration ────────────────────────── */
async function init() {
  try {
    // Fetch both APIs in parallel
    const [weatherData, tideData] = await Promise.all([fetchWeather(), fetchTides()]);

    /* ─── Weather: wind ─── */
    const windSpeedMph = weatherData.wind?.speed ?? 0;   // OWM imperial already returns mph
    const windDir = weatherData.wind?.deg ?? null;
    const windGust = weatherData.wind?.gust ?? null;

    const windOk = windSpeedMph < WIND_THRESHOLD_MPH;

    windValue.textContent = `${windSpeedMph.toFixed(1)} mph`;
    windDetail.textContent = windDir !== null
      ? `Direction: ${windDir}° ${windGust ? `· Gusts ${windGust.toFixed(1)} mph` : ''}`
      : 'Direction unavailable';
    applyStatus(windCard, windDot, windOk ? 'good' : 'poor');

    /* ─── Weather: rain ─── */
    // OWM "rain" object: { "1h": mm_in_last_hour, "3h": ... }
    const rainMm1h = weatherData.rain?.['1h'] ?? 0;
    const rainOk = rainMm1h === 0;

    rainValue.textContent = rainMm1h > 0 ? `${rainMm1h.toFixed(1)} mm` : 'None';
    rainDetail.textContent = rainOk
      ? 'No precipitation in the last hour'
      : `${rainMm1h.toFixed(1)} mm in past hour`;
    applyStatus(rainCard, rainDot, rainOk ? 'good' : rainMm1h < 2 ? 'fair' : 'poor');

    /* ─── Tides ─── */
    const predictions = tideData.predictions ?? [];
    const { inWindow, nearestHigh, deltaMinutes, allHighs } = evaluateTideWindow(predictions);

    let tideValText, tideDetText;

    if (!nearestHigh) {
      tideValText = 'N/A';
      tideDetText = 'No high tide data today';
    } else {
      const absDelta = Math.abs(deltaMinutes);
      const direction = deltaMinutes > 0 ? 'after' : 'before';
      tideValText = inWindow ? `±${TIDE_WINDOW_HOURS}h ✓` : `Outside window`;
      tideDetText = absDelta < 1
        ? `High tide is now (${fmtTime(nearestHigh.date)})`
        : `${fmtDuration(absDelta)} ${direction} high at ${fmtTime(nearestHigh.date)}`;
    }

    tideValue.textContent = tideValText;
    tideDetail.textContent = tideDetText;
    applyStatus(tideCard, tideDot, inWindow ? 'good' : 'poor');

    renderTideTimeline(predictions, nearestHigh);

    /* ─── Overall condition ─── */
    const score = [windOk, inWindow, rainOk].filter(Boolean).length;

    let rating, subtitle;
    if (score === 3) {
      rating = 'OPTIMAL';
      subtitle = 'All conditions are favorable — great time to head out!';
    } else if (score === 2) {
      rating = 'FAIR';
      const bad = [];
      if (!windOk) bad.push(`wind at ${windSpeedMph.toFixed(1)} mph`);
      if (!inWindow) bad.push('outside prime tide window');
      if (!rainOk) bad.push('recent rain detected');
      subtitle = `Expect some challenges: ${bad.join(', ')}.`;
    } else {
      rating = 'POOR';
      subtitle = 'Conditions are unfavorable. Consider waiting for better conditions.';
    }

    renderCondition(rating, subtitle);

  } catch (err) {
    console.error('[BiscayneFishWatch] Error loading data:', err);

    condBadge.classList.remove('loading');
    condBadge.classList.add('poor');
    condText.textContent = 'Error';
    condSub.textContent = `Could not load data: ${err.message}`;

    [windValue, tideValue, rainValue].forEach(el => { el.textContent = 'Error'; el.style.color = 'var(--poor)'; });
    [windDetail, tideDetail, rainDetail].forEach(el => { el.textContent = err.message; });
    tideTimeline.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

// Kick off on page load
init();

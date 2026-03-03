/**
 * Biscayne Bay Fish Watch — script.js
 *
 * Data sources:
 *   1. OpenWeatherMap "Current Weather" API — wind speed & rain
 *   2. NOAA CO-OPS Tides API — Station 8723165 (Miamarina)
 *
 * Condition logic:
 *   OPTIMAL  →  ALL 3 conditions met
 *   FAIR     →  EXACTLY 2 of 3 conditions met
 *   POOR     →  fewer than 2 conditions met
 *
 * Tide window (asymmetric — Venetian Causeway):
 *   "Good" if within 2 hours BEFORE high tide OR up to 1 hour AFTER
 *   (incoming ocean water brings clarity; outgoing clears quickly).
 *
 * Visibility Score:
 *   < 5 mph → Excellent | 5–10 mph → Good | > 10 mph → Low
 *
 * Rain window:
 *   Condition fails if any rain detected in the past 2 hours (1h + 3h OWM fields).
 */

/* ── Constants ─────────────────────────────────── */
const OPENWEATHER_API_KEY = '0494e55eedb7fc261cf895d4c4118b25';

const LAT = 25.788996;
const LON = -80.172930;
const NOAA_STATION = '8723165'; // Miamarina — Venetian Causeway

const WIND_THRESHOLD_MPH = 10;   // < 10 mph = OK (choppy near causeway)
const TIDE_BEFORE_HOURS = 2;    // up to 2 h BEFORE high tide = OK
const TIDE_AFTER_HOURS = 1;    // up to 1 h AFTER  high tide = OK
const MS_PER_HOUR = 3600000;

// Visibility score thresholds
const VIS_EXCELLENT_MPH = 5;
const VIS_GOOD_MPH = 10;

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

  // 🔍 Debug: raw NOAA Tides response (Station 8723165 — Miamarina)
  console.log('[BiscayneFishWatch] NOAA Tides raw data (Station 8723165):', data);

  if (data.error) throw new Error(`NOAA error: ${data.error.message}`);
  return data;
}

/* ── Tide window logic ─────────────────────────── */
/**
 * Asymmetric tide window for the Venetian Causeway / Miamarina area.
 *
 * NOAA returns predictions in this shape:
 *   { t: "2026-03-03 06:42", v: "1.245", type: "H" }
 *
 * Signed delta:  deltaMs = now − highTideTime
 *   negative → tide is upcoming (incoming / flooding)
 *   positive → tide has passed  (outgoing / ebbing)
 *
 * Window rule:
 *   OK if  -(TIDE_BEFORE_HOURS * MS_PER_HOUR) ≤ deltaMs ≤ (TIDE_AFTER_HOURS * MS_PER_HOUR)
 *   i.e.  up to 2 h BEFORE high tide  OR  up to 1 h AFTER high tide.
 *
 * Rationale: incoming ocean water pushes clear water through the causeway
 * for ~2 h before peak; clarity drops quickly once the tide turns outward.
 *
 * @param {Array} predictions  - NOAA hilo predictions array
 * @returns {{ inWindow: boolean, nearestHigh: object|null, deltaMinutes: number, allHighs: Array }}
 */
function evaluateTideWindow(predictions) {
  const now = Date.now();

  // Filter to HIGH tide events and parse their timestamps
  const highs = predictions
    .filter(p => p.type === 'H')
    .map(p => ({
      date: new Date(p.t),  // "YYYY-MM-DD HH:MM" parsed as local time
      height: parseFloat(p.v)
    }));

  if (highs.length === 0) {
    return { inWindow: false, nearestHigh: null, deltaMinutes: Infinity, allHighs: [] };
  }

  // Find the high tide whose absolute time-distance from now is smallest
  let nearest = highs[0];
  let minDelta = Math.abs(now - nearest.date.getTime());

  for (let i = 1; i < highs.length; i++) {
    const d = Math.abs(now - highs[i].date.getTime());
    if (d < minDelta) { minDelta = d; nearest = highs[i]; }
  }

  // Signed delta: negative = tide upcoming, positive = tide passed
  const deltaMs = now - nearest.date.getTime();
  const deltaMinutes = Math.round(deltaMs / 60000);

  // Asymmetric check: must be within [−2h, +1h] of high tide
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
    // Asymmetric window check mirroring evaluateTideWindow
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

/* ── Main orchestration ────────────────────────── */
async function init() {
  try {
    // Fetch both APIs in parallel
    const [weatherData, tideData] = await Promise.all([fetchWeather(), fetchTides()]);

    /* ─── Weather: wind ─── */
    const windSpeedMph = weatherData.wind?.speed ?? 0;  // OWM imperial returns mph
    const windDir = weatherData.wind?.deg ?? null;
    const windGust = weatherData.wind?.gust ?? null;

    const windOk = windSpeedMph < WIND_THRESHOLD_MPH;

    windValue.textContent = `${windSpeedMph.toFixed(1)} mph`;
    windDetail.textContent = windDir !== null
      ? `Direction: ${windDir}° ${windGust ? `· Gusts ${windGust.toFixed(1)} mph` : ''}`
      : 'Direction unavailable';
    applyStatus(windCard, windDot, windOk ? 'good' : 'poor');

    /* ─── Visibility Score (wind-based) ─── */
    let visLabel, visClass;
    if (windSpeedMph < VIS_EXCELLENT_MPH) {
      visLabel = '👁 Visibility: Excellent'; visClass = 'vis-excellent';
    } else if (windSpeedMph <= VIS_GOOD_MPH) {
      visLabel = '👁 Visibility: Good'; visClass = 'vis-good';
    } else {
      visLabel = '👁 Visibility: Low'; visClass = 'vis-low';
    }
    visibilityEl.textContent = visLabel;
    visibilityEl.className = `visibility-score ${visClass}`;

    /* ─── Weather: rain (2-hour window) ─── */
    // OWM provides "1h" (last hour) and "3h" (last 3 hours) rain in mm.
    // Fail if ANY rain in either field (covers the 2-hour requirement).
    const rainMm1h = weatherData.rain?.['1h'] ?? 0;
    const rainMm3h = weatherData.rain?.['3h'] ?? 0;
    const rainIn2h = rainMm1h > 0 || rainMm3h > 0;
    const rainOk = !rainIn2h;
    const displayRain = rainMm1h > 0 ? rainMm1h : rainMm3h;

    rainValue.textContent = rainIn2h ? `${displayRain.toFixed(1)} mm` : 'None';
    rainDetail.textContent = rainOk
      ? 'No precipitation in the last 2 hours'
      : `Rain detected — ${displayRain.toFixed(1)} mm (last 1–3 hrs)`;
    applyStatus(rainCard, rainDot, rainOk ? 'good' : displayRain < 1 ? 'fair' : 'poor');

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
      tideValText = inWindow ? `-2h/+1h ✓` : `Outside window`;
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

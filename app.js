/* ============================================================
   Options Lab — app.js
   Black-Scholes call + put pricing · Greeks · P&L grid
   Sliders · Presets · Moneyness filter
   ============================================================ */

// ─── State ───────────────────────────────────────────────────
let premiumMode     = 'theoretical'; // 'theoretical' | 'manual'
let optionType      = 'calls';       // 'calls' | 'puts' | 'both'
let pnlMode         = 'flat';        // 'flat' | 'pct'
let moneynessFilter = 'all';         // 'all' | 'itm' | 'otm'
let lastOptions     = null;
let lastParams      = null;

// ─── Presets ─────────────────────────────────────────────────
const PRESET_KEY = 'optionslab_presets_v2';

const BUILTIN_PRESETS = [
  {
    name: '📊 Default',
    data: { stockPrice: '100', iv: '30', riskFreeRate: '5', numStrikes: '6',
            strikeStep: '5', spotStep: '', spotRangePct: '20', weeksToExpiry: 4,
            optionType: 'calls', premiumMode: 'theoretical', pnlMode: 'flat', moneynessFilter: 'all' },
  },
  {
    name: '📈 High IV Earnings',
    data: { stockPrice: '100', iv: '80', riskFreeRate: '5', numStrikes: '8',
            strikeStep: '2.5', spotStep: '', spotRangePct: '35', weeksToExpiry: 2,
            optionType: 'both', premiumMode: 'theoretical', pnlMode: 'pct', moneynessFilter: 'all' },
  },
  {
    name: '🎰 Deep OTM Lottery',
    data: { stockPrice: '100', iv: '30', riskFreeRate: '5', numStrikes: '8',
            strikeStep: '5', spotStep: '', spotRangePct: '40', weeksToExpiry: 4,
            optionType: 'calls', premiumMode: 'theoretical', pnlMode: 'pct', moneynessFilter: 'otm' },
  },
  {
    name: '📅 Weekly Scalp',
    data: { stockPrice: '100', iv: '25', riskFreeRate: '5', numStrikes: '6',
            strikeStep: '1', spotStep: '1', spotRangePct: '10', weeksToExpiry: 1,
            optionType: 'calls', premiumMode: 'theoretical', pnlMode: 'flat', moneynessFilter: 'all' },
  },
  {
    name: '🛡️ Protective Put',
    data: { stockPrice: '100', iv: '25', riskFreeRate: '5', numStrikes: '6',
            strikeStep: '5', spotStep: '', spotRangePct: '30', weeksToExpiry: 8,
            optionType: 'puts', premiumMode: 'theoretical', pnlMode: 'flat', moneynessFilter: 'itm' },
  },
];

// All presets (builtin + user) stored here for index-based access
let _allPresets = [];

function getStoredPresets() {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '[]'); }
  catch { return []; }
}

function renderPresets() {
  const stored = getStoredPresets();
  _allPresets  = [...BUILTIN_PRESETS, ...stored];
  const row    = document.getElementById('presetsRow');

  row.innerHTML = _allPresets.map((p, i) => {
    const isBuiltin = i < BUILTIN_PRESETS.length;
    return `
    <div class="preset-chip${isBuiltin ? ' builtin' : ''}">
      <button class="preset-load-btn" onclick="loadPresetByIndex(${i})">${p.name}</button>
      ${!isBuiltin ? `<button class="preset-delete-btn" onclick="deletePreset(${i})" title="Delete">×</button>` : ''}
    </div>`;
  }).join('');
}

function loadPresetByIndex(i) {
  const p = _allPresets[i];
  if (p) applyConfig(p.data);
}

function savePreset() {
  const name = document.getElementById('presetName').value.trim();
  if (!name) { alert('Please enter a name for this preset.'); return; }
  const data    = captureCurrentConfig();
  const stored  = getStoredPresets();
  const existing = stored.findIndex(p => p.name === name);
  if (existing >= 0) {
    if (!confirm(`Overwrite preset "${name}"?`)) return;
    stored[existing].data = data;
  } else {
    stored.push({ name, data });
  }
  localStorage.setItem(PRESET_KEY, JSON.stringify(stored));
  document.getElementById('presetName').value = '';
  renderPresets();
}

function deletePreset(globalIndex) {
  const p = _allPresets[globalIndex];
  if (!p || !confirm(`Delete preset "${p.name}"?`)) return;
  const stored = getStoredPresets().filter(s => s.name !== p.name);
  localStorage.setItem(PRESET_KEY, JSON.stringify(stored));
  renderPresets();
}

function captureCurrentConfig() {
  const expiryVal = document.getElementById('expiryDate').value;
  const days      = expiryVal ? daysToExpiry(expiryVal) : 0;
  return {
    stockPrice:    document.getElementById('stockPrice').value,
    expiryDate:    expiryVal,
    weeksToExpiry: Math.round(days / 7),
    iv:            document.getElementById('iv').value,
    riskFreeRate:  document.getElementById('riskFreeRate').value,
    numStrikes:    document.getElementById('numStrikes').value,
    strikeStep:    document.getElementById('strikeStep').value,
    spotStep:      document.getElementById('spotStep').value,
    spotRangePct:  document.getElementById('spotRangePct').value,
    optionType, premiumMode, pnlMode, moneynessFilter,
  };
}

function applyConfig(data) {
  if (data.stockPrice !== undefined)  {
    document.getElementById('stockPrice').value  = data.stockPrice;
    initStockSliderRange();
  }
  // Prefer weeksToExpiry for built-in presets (more portable), fall back to date string
  if (data.weeksToExpiry > 0) {
    setExpiryFromWeeks(data.weeksToExpiry);
  } else if (data.expiryDate) {
    document.getElementById('expiryDate').value = data.expiryDate;
    syncWeeksFromDate();
    updateDaysHint();
  }
  if (data.iv !== undefined)           { document.getElementById('iv').value           = data.iv;           clampSlider('iv','sliderIV'); }
  if (data.riskFreeRate !== undefined) { document.getElementById('riskFreeRate').value = data.riskFreeRate; clampSlider('riskFreeRate','sliderRiskFree'); }
  if (data.numStrikes !== undefined)   { document.getElementById('numStrikes').value   = data.numStrikes;   clampSlider('numStrikes','sliderNumStrikes'); }
  if (data.strikeStep !== undefined)   { document.getElementById('strikeStep').value   = data.strikeStep;   clampSlider('strikeStep','sliderStrikeStep'); }
  if (data.spotStep !== undefined)     { document.getElementById('spotStep').value      = data.spotStep;     if (data.spotStep) clampSlider('spotStep','sliderSpotStep'); }
  if (data.spotRangePct !== undefined) { document.getElementById('spotRangePct').value = data.spotRangePct; clampSlider('spotRangePct','sliderSpotRange'); }
  if (data.optionType)      setOptionType(data.optionType);
  if (data.premiumMode)     setPremiumMode(data.premiumMode);
  if (data.pnlMode)         setPnlMode(data.pnlMode);
  if (data.moneynessFilter) setMoneynessFilter(data.moneynessFilter);
}

function togglePresets() {
  const body    = document.getElementById('presetsBody');
  const chevron = document.getElementById('presetsChevron');
  const isOpen  = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  chevron.classList.toggle('open', !isOpen);
}

// ─── Slider Sync Helpers ─────────────────────────────────────

/** Clamp a number input value to fit the slider range, then sync */
function clampSlider(inputId, sliderId) {
  const inp    = document.getElementById(inputId);
  const slider = document.getElementById(sliderId);
  const val    = parseFloat(inp.value);
  if (!isFinite(val)) return;
  const clamped = Math.min(parseFloat(slider.max), Math.max(parseFloat(slider.min), val));
  slider.value  = clamped;
}

/** Stock price input → recalculate slider range ±50%, keep thumb at current value */
function onStockPriceInput() {
  initStockSliderRange();
}

function initStockSliderRange() {
  const val    = parseFloat(document.getElementById('stockPrice').value);
  if (!isFinite(val) || val <= 0) return;
  const slider = document.getElementById('sliderStockPrice');
  const lo     = Math.max(0.01, val * 0.5);
  const hi     = val * 1.5;
  const st     = Math.max(0.01, parseFloat((val * 0.01).toFixed(2))); // ~1% step
  slider.min   = lo.toFixed(2);
  slider.max   = hi.toFixed(2);
  slider.step  = st.toFixed(2);
  slider.value = val;
}

/** Stock slider moved → push value back to number input */
function onStockSlider() {
  const val = parseFloat(document.getElementById('sliderStockPrice').value);
  document.getElementById('stockPrice').value = val.toFixed(2);
  // Don't re-init range here or the thumb would snap mid-drag
}

/** Weeks slider → set expiry date */
function onWeeksSlider() {
  const weeks = parseInt(document.getElementById('sliderWeeks').value, 10);
  setExpiryFromWeeks(weeks);
}

function setExpiryFromWeeks(weeks) {
  const today  = new Date(); today.setHours(0,0,0,0);
  const target = new Date(today);
  target.setDate(target.getDate() + weeks * 7);
  document.getElementById('expiryDate').value  = toDateInputValue(target);
  document.getElementById('sliderWeeks').value = weeks;
  updateDaysHint();
}

/** Date input changed → sync weeks slider (clamped 1-52) */
function onExpiryDateInput() {
  syncWeeksFromDate();
  updateDaysHint();
}

function syncWeeksFromDate() {
  const days  = daysToExpiry(document.getElementById('expiryDate').value);
  const weeks = Math.max(1, Math.min(52, Math.round(days / 7)));
  document.getElementById('sliderWeeks').value = weeks;
}

/** Clear spot step (set to auto / blank) */
function clearSpotStep() {
  document.getElementById('spotStep').value = '';
}

// ─── Date Helpers ─────────────────────────────────────────────
function toDateInputValue(d) { return d.toISOString().split('T')[0]; }

function updateDaysHint() {
  const val  = document.getElementById('expiryDate').value;
  const hint = document.getElementById('daysHint');
  if (!val) { hint.textContent = '— days to expiry · slider = weeks (1–52)'; return; }
  const days = daysToExpiry(val);
  hint.textContent = days <= 0
    ? '⚠️ Date is in the past · slider = weeks (1–52)'
    : `${days} calendar day${days !== 1 ? 's' : ''} to expiry · slider = weeks`;
}

function daysToExpiry(dateStr) {
  const now    = new Date(); now.setHours(0,0,0,0);
  const expiry = new Date(dateStr + 'T00:00:00');
  return Math.round((expiry - now) / 86400000);
}

// ─── Toggle Handlers ─────────────────────────────────────────
function setOptionType(type) {
  optionType = type;
  ['calls','puts','both'].forEach(t => {
    document.getElementById('btn' + t.charAt(0).toUpperCase() + t.slice(1))
            .classList.toggle('active', t === type);
  });
}

function setPremiumMode(mode) {
  premiumMode = mode;
  document.getElementById('btnTheoretical').classList.toggle('active', mode === 'theoretical');
  document.getElementById('btnManual').classList.toggle('active',      mode === 'manual');
  const mh = document.getElementById('manualPremiumHeader');
  if (mh) mh.style.display = mode === 'manual' ? '' : 'none';
}

function setPnlMode(mode) {
  pnlMode = mode;
  document.getElementById('btnFlat').classList.toggle('active', mode === 'flat');
  document.getElementById('btnPct').classList.toggle('active',  mode === 'pct');
  if (lastOptions && lastParams) reRenderAll();
}

function setMoneynessFilter(filter) {
  moneynessFilter = filter;
  document.getElementById('btnAll').classList.toggle('active', filter === 'all');
  document.getElementById('btnITM').classList.toggle('active', filter === 'itm');
  document.getElementById('btnOTM').classList.toggle('active', filter === 'otm');
  if (lastOptions && lastParams) reRenderAll();
}

// ─── Normal Distribution ──────────────────────────────────────
function normCDF(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return 0.5 * (1 + sign * y);
}
function normPDF(x) { return Math.exp(-0.5*x*x) / Math.sqrt(2*Math.PI); }

// ─── Black-Scholes ────────────────────────────────────────────
function blackScholesCall(S, K, T, r, σ) {
  if (T <= 0) return { price: Math.max(S-K,0), delta: S>=K?1:0, gamma:0, theta:0, vega:0 };
  const sqT=Math.sqrt(T), d1=(Math.log(S/K)+(r+.5*σ*σ)*T)/(σ*sqT), d2=d1-σ*sqT;
  const Nd1=normCDF(d1), Nd2=normCDF(d2), nd1=normPDF(d1), eRt=Math.exp(-r*T);
  return {
    price: S*Nd1 - K*eRt*Nd2,
    delta: Nd1,
    gamma: nd1/(S*σ*sqT),
    theta: (-(S*nd1*σ)/(2*sqT) - r*K*eRt*Nd2)/365,
    vega:  S*nd1*sqT*0.01,
  };
}

function blackScholesPut(S, K, T, r, σ) {
  if (T <= 0) return { price: Math.max(K-S,0), delta: S<=K?-1:0, gamma:0, theta:0, vega:0 };
  const sqT=Math.sqrt(T), d1=(Math.log(S/K)+(r+.5*σ*σ)*T)/(σ*sqT), d2=d1-σ*sqT;
  const Nm1=normCDF(-d1), Nm2=normCDF(-d2), nd1=normPDF(d1), eRt=Math.exp(-r*T);
  return {
    price: K*eRt*Nm2 - S*Nm1,
    delta: Nm1-1,
    gamma: nd1/(S*σ*sqT),
    theta: (-(S*nd1*σ)/(2*sqT) + r*K*eRt*Nm2)/365,
    vega:  S*nd1*sqT*0.01,
  };
}

// ─── Moneyness helpers ────────────────────────────────────────
function moneynessLabel(S, K) {
  const pct = (S - K) / K * 100;
  if (Math.abs(pct) < 1) return { label:'ATM',            cls:'badge-atm', isATM:true,  itmCall:false, otmCall:false };
  if (pct > 0)            return { label:`ITM ${fmt(pct,1)}%`,  cls:'badge-itm', isATM:false, itmCall:true,  otmCall:false };
  return                         { label:`OTM ${fmt(-pct,1)}%`, cls:'badge-otm', isATM:false, itmCall:false, otmCall:true  };
}

/**
 * Filter an option array by moneyness.
 * ATM is always included.
 * Calls: ITM = itmCall=true, OTM = otmCall=true
 * Puts:  ITM = otmCall=true (K>S), OTM = itmCall=true (K<S)  ← reversed
 */
function filterByMoneyness(options, side, filter) {
  if (filter === 'all') return options;
  return options.filter(opt => {
    if (opt.isATM) return true;
    if (filter === 'itm') return side === 'call' ? opt.itmCall : opt.otmCall;
    if (filter === 'otm') return side === 'call' ? opt.otmCall : opt.itmCall;
    return true;
  });
}

// ─── Formatters ───────────────────────────────────────────────
function fmt(n, dec=2)  { return isFinite(n) ? n.toFixed(dec) : '—'; }
function fmtDollar(n) {
  if (!isFinite(n)) return '—';
  const abs = Math.abs(n);
  const s = abs >= 1000 ? abs.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : abs.toFixed(2);
  return (n < 0 ? '-$' : '$') + s;
}
function fmtShort(n) {
  if (!isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000) return (n<0?'-':'')+'$'+(abs/1000).toFixed(1)+'k';
  return fmtDollar(n);
}
function fmtPct(pnl, premium) {
  if (!isFinite(pnl) || premium <= 0) return '—';
  const pct = (pnl / (premium * 100)) * 100;
  if (!isFinite(pct)) return '—';
  const abs=Math.abs(pct), sign=pct>=0?'+':'';
  if (abs>=10000) return sign+(pct/1000).toFixed(0)+'k%';
  if (abs>=1000)  return sign+(pct/1000).toFixed(1)+'k%';
  return sign+pct.toFixed(0)+'%';
}

// ─── Read Inputs ──────────────────────────────────────────────
function readInputs() {
  const S            = parseFloat(document.getElementById('stockPrice').value);
  const expDate      = document.getElementById('expiryDate').value;
  const ivPct        = parseFloat(document.getElementById('iv').value);
  const rPct         = parseFloat(document.getElementById('riskFreeRate').value);
  const nStr         = parseInt(document.getElementById('numStrikes').value);
  const step         = parseFloat(document.getElementById('strikeStep').value);
  const spotStepRaw  = document.getElementById('spotStep').value.trim();
  const spotStep     = spotStepRaw ? parseFloat(spotStepRaw) : null;
  const spotRangePct = parseFloat(document.getElementById('spotRangePct').value) || 20;
  const days         = daysToExpiry(expDate);

  const errors = [];
  if (isNaN(S) || S <= 0)          errors.push('Stock price must be > 0');
  if (!expDate)                    errors.push('Please choose an expiration date');
  if (days <= 0)                   errors.push('Expiration date must be in the future');
  if (isNaN(ivPct) || ivPct <= 0)  errors.push('IV must be > 0');
  if (isNaN(rPct))                 errors.push('Risk-free rate is invalid');
  if (isNaN(nStr) || nStr < 2)    errors.push('Need at least 2 strikes');
  if (isNaN(step) || step <= 0)   errors.push('Strike step must be > 0');
  if (spotStep !== null && (isNaN(spotStep) || spotStep <= 0))
                                   errors.push('Spot step must be > 0 or left blank');
  if (errors.length) { alert('Input errors:\n• ' + errors.join('\n• ')); return null; }
  return { S, T: days/365, σ: ivPct/100, r: rPct/100, nStrikes: nStr, step, spotStep, spotRangePct, days };
}

// ─── Strike Generation (FIXED for filter) ────────────────────
/**
 * When filter is 'all': generate nStrikes centered around ATM.
 * When filter is 'itm' or 'otm': generate nStrikes on EACH side (2N+1 total),
 *   so after filtering, each side has nStrikes + ATM visible.
 */
function generateStrikes(S, nStrikes, step, filter) {
  const atm = Math.round(S / step) * step;

  if (filter === 'all') {
    const half = Math.floor(nStrikes / 2);
    const result = [];
    for (let i = -half; i <= nStrikes - half - 1; i++) {
      const K = atm + i * step;
      if (K > 0) result.push(parseFloat(K.toFixed(4)));
    }
    return result;
  }

  // Generate nStrikes on each side of ATM → 2*nStrikes + 1 total
  const result = [];
  for (let i = -nStrikes; i <= nStrikes; i++) {
    const K = atm + i * step;
    if (K > 0) result.push(parseFloat(K.toFixed(4)));
  }
  return result;
}

// ─── Spot Range Generation ────────────────────────────────────
function generateSpotRange(S, customStep, rangePct) {
  const pct  = (rangePct ?? 20) / 100;
  const low  = Math.max(0.01, S * (1 - pct));
  const high = S * (1 + pct);

  const stepToUse = customStep ?? niceNumber((high - low) / 12);
  const start     = Math.ceil(low / stepToUse) * stepToUse;
  const spots     = [];
  let   cur       = parseFloat(start.toFixed(6));

  while (cur <= high + stepToUse * 0.5) {
    spots.push(parseFloat(cur.toFixed(4)));
    cur = parseFloat((cur + stepToUse).toFixed(6));
  }

  // Always include exact current price as reference column
  if (!spots.some(p => Math.abs(p - S) < stepToUse * 0.1)) {
    spots.push(S);
    spots.sort((a, b) => a - b);
  }
  return spots;
}

function niceNumber(rough) {
  if (rough <= 0) return 1;
  const exp  = Math.floor(Math.log10(rough));
  const frac = rough / Math.pow(10, exp);
  const nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  return nice * Math.pow(10, exp);
}

// ─── Main Calculate ───────────────────────────────────────────
function calculate() {
  const p = readInputs();
  if (!p) return;
  const { S, T, σ, r, nStrikes, step } = p;

  const strikePrices = generateStrikes(S, nStrikes, step, moneynessFilter);

  const callOptions = strikePrices.map(K => {
    const bs  = blackScholesCall(S, K, T, r, σ);
    const mon = moneynessLabel(S, K);
    return { K, ...bs, ...mon };
  });
  const putOptions = strikePrices.map(K => {
    const bs  = blackScholesPut(S, K, T, r, σ);
    const mon = moneynessLabel(S, K);
    return { K, ...bs, ...mon };
  });

  lastParams  = p;
  lastOptions = { callOptions, putOptions };

  renderGreeks(optionType === 'puts' ? putOptions : callOptions, optionType);
  renderStrikesTable(callOptions, putOptions, S);
  renderAllPnLGrids(document.getElementById('pnlGridContainer'), { callOptions, putOptions }, p);

  ['greeksBar','strikesSection','pnlSection'].forEach(id => {
    const el = document.getElementById(id);
    el.style.display = '';
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  });

  setTimeout(() => {
    document.getElementById('greeksBar').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

function reRenderAll() {
  if (!lastOptions || !lastParams) return;
  const { callOptions, putOptions } = lastOptions;
  renderGreeks(optionType === 'puts' ? putOptions : callOptions, optionType);
  renderStrikesTable(callOptions, putOptions, lastParams.S);
  renderAllPnLGrids(document.getElementById('pnlGridContainer'), lastOptions, lastParams);
}
function reRenderGrid() { reRenderAll(); }

// ─── Greeks Bar ───────────────────────────────────────────────
function renderGreeks(options, displayType) {
  const S   = lastParams.S;
  const atm = options.reduce((a, b) => Math.abs(b.K-S) < Math.abs(a.K-S) ? b : a);
  const lbl = displayType === 'puts' ? 'Put' : 'Call';
  const items = [
    { label:`ATM ${lbl} Strike`, value:`$${fmt(atm.K)}`,          sub:'' },
    { label:'Theo. Price',       value:`$${fmt(atm.price)}`,       sub:'per share' },
    { label:'Contract Cost',     value:`$${fmt(atm.price*100)}`,   sub:'100 shares' },
    { label:'Delta (Δ)',         value:fmt(atm.delta,3),           sub:displayType==='puts'?'≈ −P(profit at exp)':'≈ P(ITM at exp)' },
    { label:'Gamma (Γ)',         value:fmt(atm.gamma,4),           sub:'Δ change per $1' },
    { label:'Theta (Θ)',         value:fmt(atm.theta,4),           sub:'per day (decay)' },
    { label:'Vega (ν)',          value:fmt(atm.vega,4),            sub:'per 1% IV change' },
    { label:'Days to Exp.',      value:`${lastParams.days}`,       sub:'calendar days' },
  ];
  document.getElementById('greeksGrid').innerHTML = items.map(it => `
    <div class="greek-item">
      <div class="greek-label">${it.label}</div>
      <div class="greek-value">${it.value}</div>
      ${it.sub ? `<div class="greek-sub">${it.sub}</div>` : ''}
    </div>`).join('');
}

// ─── Strikes Table ────────────────────────────────────────────
function renderStrikesTable(callOptions, putOptions, S) {
  const showCalls  = optionType !== 'puts';
  const showPuts   = optionType !== 'calls';
  const showManual = premiumMode === 'manual';

  // Merge: union of strikes visible under current filter for calls and puts
  const filteredCallKs = new Set(filterByMoneyness(callOptions,'call',moneynessFilter).map(o=>o.K));
  const filteredPutKs  = new Set(filterByMoneyness(putOptions, 'put', moneynessFilter).map(o=>o.K));
  const visibleKs      = new Set([
    ...(showCalls ? filteredCallKs : []),
    ...(showPuts  ? filteredPutKs  : []),
  ]);
  const rows = callOptions.filter(o => visibleKs.has(o.K));

  document.getElementById('strikesBody').innerHTML = rows.map(callOpt => {
    const i      = callOptions.indexOf(callOpt);
    const putOpt = putOptions[i];
    const isAtm  = callOpt.isATM;
    const callCells = showCalls ? `
      <td>$${fmt(callOpt.price)}</td><td>${fmt(callOpt.delta,4)}</td><td>${fmt(callOpt.gamma,5)}</td><td>${fmt(callOpt.theta,5)}</td><td>${fmt(callOpt.vega,5)}</td>
      ${showManual?`<td><input class="premium-input-cell" type="number" id="manualCallPrem_${i}" value="${fmt(callOpt.price)}" step="0.01" min="0" onchange="reRenderGrid()"/></td>`:''}
    ` : '';
    const putCells = showPuts ? `
      <td>$${fmt(putOpt.price)}</td><td>${fmt(putOpt.delta,4)}</td><td>${fmt(putOpt.gamma,5)}</td><td>${fmt(putOpt.theta,5)}</td><td>${fmt(putOpt.vega,5)}</td>
      ${showManual?`<td><input class="premium-input-cell" type="number" id="manualPutPrem_${i}" value="${fmt(putOpt.price)}" step="0.01" min="0" onchange="reRenderGrid()"/></td>`:''}
    ` : '';
    return `
    <tr class="${isAtm?'atm-row':''}">
      <td>${i+1}${isAtm?' ⭐':''}</td>
      <td>$${fmt(callOpt.K)}</td>
      <td><span class="badge ${callOpt.cls}">${callOpt.label}</span></td>
      ${callCells}${putCells}
    </tr>`;
  }).join('');

  document.querySelector('#strikesTable thead tr').innerHTML = `
    <th>#</th><th>Strike (K)</th><th>Moneyness</th>
    ${showCalls?`<th>Call Price</th><th>Δ Call</th><th>Γ</th><th>Θ/day</th><th>ν/1%</th>${showManual?'<th>Call Prem.</th>':''}`:''}
    ${showPuts ?`<th>Put Price</th><th>Δ Put</th><th>Γ</th><th>Θ/day</th><th>ν/1%</th>${showManual?'<th>Put Prem.</th>':''}`:''}
  `;
}

// ─── P&L Grid ─────────────────────────────────────────────────
function renderAllPnLGrids(container, { callOptions, putOptions }, p) {
  const { S, spotStep, spotRangePct } = p;
  const spots = generateSpotRange(S, spotStep, spotRangePct);
  container.innerHTML = '';

  if (optionType === 'calls' || optionType === 'both') {
    const filtered = filterByMoneyness(callOptions, 'call', moneynessFilter);
    if (filtered.length > 0) {
      const lbl = Object.assign(document.createElement('div'), { className:'pnl-type-label calls-label', textContent:'📈 Calls — Long Call P&L' });
      container.appendChild(lbl);
      container.appendChild(buildPnLTable(filtered, callOptions, spots, S, 'call'));
    } else container.appendChild(emptyNote('calls'));
  }

  if (optionType === 'puts' || optionType === 'both') {
    const filtered = filterByMoneyness(putOptions, 'put', moneynessFilter);
    if (filtered.length > 0) {
      const lbl = Object.assign(document.createElement('div'), { className:'pnl-type-label puts-label', textContent:'📉 Puts — Long Put P&L' });
      container.appendChild(lbl);
      container.appendChild(buildPnLTable(filtered, putOptions, spots, S, 'put'));
    } else container.appendChild(emptyNote('puts'));
  }
}

function emptyNote(side) {
  const d = document.createElement('p');
  d.style.cssText = 'color:var(--text-muted);font-size:0.85rem;padding:10px 0 6px';
  d.textContent = `No ${side} match the current moneyness filter.`;
  return d;
}

function getManualPremium(side, gi, def) {
  if (premiumMode !== 'manual') return def;
  const el = document.getElementById(side==='call'?`manualCallPrem_${gi}`:`manualPutPrem_${gi}`);
  if (el) { const v=parseFloat(el.value); if (isFinite(v)&&v>=0) return v; }
  return def;
}

function buildPnLTable(filteredOptions, allOptions, spots, S, side) {
  let maxAbs = 0;
  const matrix = filteredOptions.map(opt => {
    const gi      = allOptions.indexOf(opt);
    const premium = getManualPremium(side, gi, opt.price);
    return spots.map(spot => {
      const intrinsic = side==='call' ? Math.max(spot-opt.K,0) : Math.max(opt.K-spot,0);
      const pnl = (intrinsic - premium) * 100;
      if (Math.abs(pnl) > maxAbs) maxAbs = Math.abs(pnl);
      return { pnl, premium };
    });
  });

  const wrapper = document.createElement('div');
  wrapper.className = 'table-scroll';
  wrapper.style.marginBottom = '8px';

  const table = document.createElement('table');
  table.className = 'pnl-table';

  let thead = '<thead><tr><th>Strike ↓ / Spot at Exp. →</th>';
  spots.forEach(spot => {
    const isCur = Math.abs(spot - S) < 0.001;
    const cls   = isCur ? ' current-price-col' : '';
    thead += `<th class="${cls}">${isCur?`<strong>$${fmt(spot)}<br><small>now</small></strong>`:`$${fmt(spot)}`}</th>`;
  });
  thead += '</tr></thead>';

  let tbody = '<tbody>';
  filteredOptions.forEach((opt, ri) => {
    const gi      = allOptions.indexOf(opt);
    const premium = getManualPremium(side, gi, opt.price);
    const lbl     = opt.isATM
      ? `<span class="strike-row-label strike-atm-label">K=$${fmt(opt.K)} ⭐</span>`
      : `<span class="strike-row-label">K=$${fmt(opt.K)}</span>`;
    tbody += '<tr>';
    tbody += `<td>${lbl}<br><small style="color:var(--text-muted);font-family:var(--font-mono);font-size:0.7rem">prem $${fmt(premium)}</small></td>`;
    matrix[ri].forEach(({ pnl, premium: prem }, ci) => {
      const isCur = Math.abs(spots[ci]-S) < 0.001;
      tbody += `<td class="${pnlCellClass(pnl,maxAbs)}${isCur?' current-price-col':''}">${pnlMode==='pct'?fmtPct(pnl,prem):fmtShort(pnl)}</td>`;
    });
    tbody += '</tr>';
  });
  tbody += '</tbody>';

  table.innerHTML = thead + tbody;
  wrapper.appendChild(table);
  return wrapper;
}

function pnlCellClass(pnl, maxAbs) {
  if (Math.abs(pnl) <= maxAbs * 0.04) return 'pnl-be';
  if (pnl > 0) {
    const t = pnl / maxAbs;
    return t>0.6?'pnl-profit-4':t>0.35?'pnl-profit-3':t>0.15?'pnl-profit-2':'pnl-profit-1';
  } else {
    const t = -pnl / maxAbs;
    return t>0.6?'pnl-loss-4':t>0.35?'pnl-loss-3':t>0.15?'pnl-loss-2':'pnl-loss-1';
  }
}

// ─── Init ─────────────────────────────────────────────────────
(function init() {
  // Set default expiry to 4 weeks out
  setExpiryFromWeeks(4);
  // Init stock price slider range
  initStockSliderRange();
  // Render presets
  renderPresets();
})();

// Enter key shortcut
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !['BUTTON','INPUT'].includes(e.target.tagName)) calculate();
});

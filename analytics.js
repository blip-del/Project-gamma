// analytics.js
// Northstar Trading Journal v2 - Chart.js Visualization Module

(function() {
  let charts = {}; // { chartId: Chart instance }

  // Destroy existing chart instance to prevent memory leaks and overlapping renders
  function destroyChart(id) {
    if (charts[id]) {
      charts[id].destroy();
      delete charts[id];
    }
  }

  // Get theme colors from CSS variables
  function getThemeColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      ACCENT: style.getPropertyValue('--accent').trim() || '#176b4c',
      RED: style.getPropertyValue('--red').trim() || '#af3e39',
      INK: style.getPropertyValue('--ink').trim() || '#13251f',
      MUTED: style.getPropertyValue('--muted').trim() || '#66746d',
      LINE: style.getPropertyValue('--line').trim() || '#dce4df',
      MINT: style.getPropertyValue('--mint').trim() || '#d8f0df',
      PAPER: style.getPropertyValue('--paper').trim() || '#f8faf8',
      FONT: style.getPropertyValue('--font-sans').trim() || "'DM Sans', sans-serif"
    };
  }

  const PREFS_KEY = 'northstar-chart-prefs';
  const SCOPE_PREFS_KEY = 'northstar-analysis-scope';
  const SCOPE_COLLAPSE_KEY = 'northstar-analysis-collapse';
  const collapsedScopePositions = new Set();
  let collapsePrefsLoaded = false;
  let closedPositionsCollapsed = true;
  const CHARTS = [
    { id: 'waterfall', label: 'Effective entry', defaultOn: true },
    { id: 'premium', label: 'Premium by month', defaultOn: true },
    { id: 'portfolio', label: 'Portfolio value', defaultOn: true },
    { id: 'breakdown', label: 'Position breakdown', defaultOn: true },
    { id: 'allocation', label: 'Allocation', defaultOn: true },
    { id: 'unrealized', label: 'Unrealized P&L', defaultOn: false },
    { id: 'dividends', label: 'Dividends', defaultOn: false },
    { id: 'cashflow', label: 'Cash flow', defaultOn: false },
    { id: 'activity', label: 'Activity', defaultOn: false },
    { id: 'expiry', label: 'Option expiries', defaultOn: false }
  ];

  let pickerReady = false;
  let scopeReady = false;

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
    } catch (err) {
      return {};
    }
  }

  function isChartEnabled(id) {
    const prefs = loadPrefs();
    if (Object.prototype.hasOwnProperty.call(prefs, id)) return !!prefs[id];
    const def = CHARTS.find(c => c.id === id);
    return def ? def.defaultOn : true;
  }

  function setChartEnabled(id, on) {
    const prefs = loadPrefs();
    prefs[id] = on;
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }

  function monthKey(dateStr) {
    const d = new Date(`${dateStr}T12:00:00`);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthLabel(key) {
    const [y, m] = key.split('-');
    return new Date(y, m - 1).toLocaleString('default', { month: 'short', year: 'numeric' });
  }

  function euroTick() {
    return { callback: (val) => '€' + val };
  }

  function setChartVisible(panelId, chartId, enabled, hasData) {
    const panel = document.getElementById(panelId);
    if (!panel) return false;
    if (!enabled) {
      panel.classList.add('hidden');
      destroyChart(chartId);
      return false;
    }
    panel.classList.remove('hidden');
    const empty = panel.querySelector('.chart-empty');
    const container = panel.querySelector('.chart-container');
    if (!hasData) {
      destroyChart(chartId);
      if (empty) empty.classList.remove('hidden');
      if (container) container.classList.add('hidden');
      return false;
    }
    if (empty) empty.classList.add('hidden');
    if (container) container.classList.remove('hidden');
    return true;
  }

  function renderPicker() {
    const el = document.getElementById('chartPicker');
    if (!el) return;
    if (!pickerReady) {
      el.replaceChildren();
      CHARTS.forEach(c => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chart-toggle';
        btn.dataset.chart = c.id;
        btn.textContent = c.label;
        btn.addEventListener('click', () => {
          setChartEnabled(c.id, !isChartEnabled(c.id));
          renderAnalytics();
        });
        el.appendChild(btn);
      });
      pickerReady = true;
    }
    el.querySelectorAll('.chart-toggle').forEach(btn => {
      const on = isChartEnabled(btn.dataset.chart);
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function applyChartDefaults() {
    const theme = getThemeColors();
    if (Chart.defaults) {
      Chart.defaults.font.family = theme.FONT;
      Chart.defaults.color = theme.MUTED;
      Chart.defaults.scale.grid.color = theme.LINE;
      
      if (Chart.defaults.plugins && Chart.defaults.plugins.tooltip) {
        Chart.defaults.plugins.tooltip.backgroundColor = theme.INK;
        Chart.defaults.plugins.tooltip.padding = 10;
        Chart.defaults.plugins.tooltip.cornerRadius = 6;
      }
    }
  }

  function loadScopePrefs() {
    try {
      return JSON.parse(localStorage.getItem(SCOPE_PREFS_KEY) || '{}') || {};
    } catch (err) {
      return {};
    }
  }

  function saveScopePrefs(prefs) {
    localStorage.setItem(SCOPE_PREFS_KEY, JSON.stringify(prefs));
  }

  function scopeDisabled(key) {
    return !!loadScopePrefs().disabled?.[key];
  }

  function loadCollapsePrefs(state) {
    if (collapsePrefsLoaded) return;
    try {
      const prefs = JSON.parse(localStorage.getItem(SCOPE_COLLAPSE_KEY) || 'null');
      if (Array.isArray(prefs?.positions)) prefs.positions.forEach(id => collapsedScopePositions.add(id));
      else (state.positions || []).forEach(pos => collapsedScopePositions.add(pos.id));
      if (typeof prefs?.closed === 'boolean') closedPositionsCollapsed = prefs.closed;
    } catch (err) {
      (state.positions || []).forEach(pos => collapsedScopePositions.add(pos.id));
    }
    collapsePrefsLoaded = true;
  }

  function saveCollapsePrefs() {
    localStorage.setItem(SCOPE_COLLAPSE_KEY, JSON.stringify({
      positions: [...collapsedScopePositions],
      closed: closedPositionsCollapsed
    }));
  }

  function setScopeEnabled(key, enabled) {
    const prefs = loadScopePrefs();
    prefs.disabled = prefs.disabled || {};
    if (enabled) delete prefs.disabled[key];
    else prefs.disabled[key] = true;
    saveScopePrefs(prefs);
  }

  function scopeKey(type, id = '') {
    return id ? `${type}:${id}` : type;
  }

  function scopeStrategyLabel(strategyType) {
    return String(strategyType || 'unclassified')
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function cycleGroupType(cycle, transactions) {
    if (cycle && cycle.groupType) return cycle.groupType;
    const tx = transactions.find(item => item.cycleId === cycle.id);
    return tx ? tx.groupType || 'unclassified' : 'unclassified';
  }

  function makeScopeCheckbox(label, key, onChange, className = '') {
    const wrapper = document.createElement('div');
    wrapper.className = `scope-check ${className}`.trim();
    const labelEl = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !scopeDisabled(key);
    input.addEventListener('change', () => onChange(key, input.checked));
    const text = document.createElement('span');
    text.textContent = label;
    labelEl.append(input, text);
    wrapper.appendChild(labelEl);
    return wrapper;
  }

  function knownScopeKeys(state) {
    const keys = [scopeKey('cash')];
    (state.positions || []).forEach(pos => {
      keys.push(scopeKey('position', pos.id), scopeKey('stock', pos.id), scopeKey('dividends', pos.id));
      ['direct', 'indirect', 'unclassified'].forEach(group => keys.push(scopeKey(group, pos.id)));
      (state.optionCycles || []).filter(cycle => cycle.positionId === pos.id).forEach(cycle => keys.push(scopeKey('cycle', cycle.id)));
    });
    return keys;
  }

  function renderScopeControls(state) {
    const tree = document.getElementById('analysisScopeTree');
    if (!tree) return;
    loadCollapsePrefs(state);
    tree.replaceChildren();

    const table = document.createElement('div');
    table.className = 'scope-table';
    const header = document.createElement('div');
    header.className = 'scope-table-header';
    ['Enabled', 'Category', 'Details', 'Actions'].forEach(text => {
      const cell = document.createElement('span');
      cell.textContent = text;
      header.appendChild(cell);
    });
    table.appendChild(header);

    const appendRow = ({ key, category, detail, level = 0, action = null, position = false }) => {
      const row = document.createElement('div');
      row.className = `scope-table-row${position ? ' scope-position-row' : ''}${level ? ' scope-level-' + level : ''}`;
      const enabled = document.createElement('div');
      enabled.className = 'scope-table-enabled';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !scopeDisabled(key);
      input.setAttribute('aria-label', `${category}: ${detail}`);
      input.addEventListener('change', () => {
        setScopeEnabled(key, input.checked);
        renderAnalytics();
      });
      enabled.appendChild(input);
      const categoryCell = document.createElement('div');
      categoryCell.className = 'scope-table-category';
      categoryCell.textContent = category;
      const detailCell = document.createElement('div');
      detailCell.className = 'scope-table-detail';
      detailCell.textContent = detail;
      const actionCell = document.createElement('div');
      actionCell.className = 'scope-table-actions';
      if (action) actionCell.appendChild(action);
      row.append(enabled, categoryCell, detailCell, actionCell);
      return row;
    };

    table.appendChild(appendRow({
      key: scopeKey('cash'),
      category: 'Cash & transfers',
      detail: 'Deposits, withdrawals, dividends cash, and FX'
    }));

    const appendPositionSection = (pos, bucket) => {
      const section = document.createElement('section');
      section.className = 'scope-position-section';
      const collapsed = collapsedScopePositions.has(pos.id);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'scope-collapse';
      toggle.textContent = collapsed ? 'Expand' : 'Collapse';
      toggle.addEventListener('click', () => {
        if (collapsedScopePositions.has(pos.id)) collapsedScopePositions.delete(pos.id);
        else collapsedScopePositions.add(pos.id);
        saveCollapsePrefs();
        renderAnalytics();
      });
      const positionRow = appendRow({
        key: scopeKey('position', pos.id),
        category: 'Position',
        detail: `${pos.label || pos.symbol} · ${pos.symbol}`,
        action: toggle,
        position: true
      });
      section.appendChild(positionRow);
      if (!collapsed) {
        const rows = document.createElement('div');
        rows.className = 'scope-position-rows';
        const positionTransactions = (state.transactions || []).filter(tx => tx.positionId === pos.id);
        rows.appendChild(appendRow({ key: scopeKey('stock', pos.id), category: 'Stock trades', detail: `${positionTransactions.filter(tx => tx.instrument === 'stock').length} records`, level: 1 }));
        rows.appendChild(appendRow({ key: scopeKey('dividends', pos.id), category: 'Dividends', detail: `${positionTransactions.filter(tx => tx.instrument === 'dividend').length} records`, level: 1 }));
        ['direct', 'indirect', 'unclassified'].forEach(group => {
          const groupCycles = (state.optionCycles || []).filter(cycle => cycle.positionId === pos.id && cycleGroupType(cycle, state.transactions || []) === group);
          const groupLabel = group === 'direct' ? 'Direct options' : group === 'indirect' ? 'Indirect options' : 'Unclassified options';
          rows.appendChild(appendRow({ key: scopeKey(group, pos.id), category: groupLabel, detail: `${groupCycles.length} cycle${groupCycles.length === 1 ? '' : 's'}`, level: 1 }));
          groupCycles.forEach(cycle => {
            const inspect = document.createElement('button');
            inspect.type = 'button';
            inspect.className = 'scope-inspect';
            inspect.textContent = 'Inspect';
            inspect.addEventListener('click', event => {
              event.preventDefault();
              event.stopPropagation();
              window.NorthstarApp.showCycleDetail(pos.id, cycle.id);
            });
            const count = positionTransactions.filter(tx => tx.cycleId === cycle.id).length;
            rows.appendChild(appendRow({
              key: scopeKey('cycle', cycle.id),
              category: 'Option cycle',
              detail: `${cycle.label || 'Unnamed cycle'} · ${scopeStrategyLabel(cycle.strategyType)} · ${count} legs`,
              level: 2,
              action: inspect
            }));
          });
        });
        section.appendChild(rows);
      }
      bucket.appendChild(section);
    };

    const activeBucket = document.createElement('div');
    activeBucket.className = 'scope-position-bucket';
    const activeHeading = document.createElement('div');
    activeHeading.className = 'scope-bucket-heading';
    activeHeading.textContent = 'Active positions';
    activeBucket.appendChild(activeHeading);
    (state.positions || []).filter(pos => pos.status !== 'closed').forEach(pos => appendPositionSection(pos, activeBucket));
    table.appendChild(activeBucket);

    const closedPositions = (state.positions || []).filter(pos => pos.status === 'closed');
    if (closedPositions.length) {
      const closedBucket = document.createElement('div');
      closedBucket.className = 'scope-position-bucket';
      const closedHeading = document.createElement('div');
      closedHeading.className = 'scope-bucket-heading scope-closed-heading';
      const closedTitle = document.createElement('span');
      closedTitle.textContent = `Closed positions · ${closedPositions.length}`;
      const closedToggle = document.createElement('button');
      closedToggle.type = 'button';
      closedToggle.className = 'scope-collapse';
      closedToggle.textContent = closedPositionsCollapsed ? 'Show' : 'Hide';
      closedToggle.addEventListener('click', () => {
        closedPositionsCollapsed = !closedPositionsCollapsed;
        saveCollapsePrefs();
        renderAnalytics();
      });
      closedHeading.append(closedTitle, closedToggle);
      closedBucket.appendChild(closedHeading);
      if (!closedPositionsCollapsed) closedPositions.forEach(pos => appendPositionSection(pos, closedBucket));
      table.appendChild(closedBucket);
    }
    tree.appendChild(table);

    const selectAll = document.getElementById('scopeSelectAll');
    const clearAll = document.getElementById('scopeClearAll');
    if (!scopeReady) {
      selectAll?.addEventListener('click', () => {
        saveScopePrefs({ disabled: {} });
        renderAnalytics();
      });
      clearAll?.addEventListener('click', () => {
        const current = window.NorthstarApp.getState();
        const disabled = {};
        knownScopeKeys(current).forEach(key => { disabled[key] = true; });
        saveScopePrefs({ disabled });
        renderAnalytics();
      });
      scopeReady = true;
    }
  }

  function isTransactionInScope(tx, state) {
    if (tx.instrument === 'cash') return !scopeDisabled(scopeKey('cash'));
    if (!tx.positionId || scopeDisabled(scopeKey('position', tx.positionId))) return false;
    if (tx.instrument === 'stock') return !scopeDisabled(scopeKey('stock', tx.positionId));
    if (tx.instrument === 'dividend') return !scopeDisabled(scopeKey('dividends', tx.positionId));
    if (tx.instrument !== 'option') return true;
    const group = tx.groupType || 'unclassified';
    if (scopeDisabled(scopeKey(group, tx.positionId))) return false;
    if (tx.cycleId && scopeDisabled(scopeKey('cycle', tx.cycleId))) return false;
    return true;
  }

  function scopedTransactions(state) {
    return (state.transactions || []).filter(tx => isTransactionInScope(tx, state));
  }

  function scopedPositions(state) {
    return (state.positions || []).filter(pos => !scopeDisabled(scopeKey('position', pos.id)));
  }

  function cashByCurrency(transactions, asOfDate = null) {
    return transactions
      .filter(tx => tx.instrument === 'cash' && (!asOfDate || tx.date <= asOfDate))
      .reduce((cash, tx) => {
        const currency = tx.currency || 'EUR';
        cash[currency] = (cash[currency] || 0) + window.NorthstarApp.cashFlow(tx);
        return cash;
      }, { EUR: 0, USD: 0 });
  }

  function formatEur(value) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(value || 0);
  }

  function renderScopeSummary(state, selectedTransactions) {
    const el = document.getElementById('scopeSummary');
    if (!el) return;
    const latest = state.snapshots && state.snapshots.length ? state.snapshots[0] : null;
    const selectedPositions = (state.positions || []).filter(pos => !scopeDisabled(scopeKey('position', pos.id)));
    let stockRealized = 0;
    let stockUnrealized = 0;
    let directRealized = 0;
    let directUnrealized = 0;
    let indirectRealized = 0;
    let indirectUnrealized = 0;
    let dividends = 0;

    selectedPositions.forEach(pos => {
      const txs = selectedTransactions.filter(tx => tx.positionId === pos.id);
      const metrics = window.NorthstarApp.calcPositionMetrics(pos, txs, latest);
      stockRealized += metrics.stockRealizedPnl || 0;
      stockUnrealized += metrics.stockUnrealizedPnl || 0;
      dividends += metrics.totalDividends || 0;
      const direct = window.NorthstarApp.calculateOptionPnl(txs.filter(tx => tx.instrument === 'option' && (tx.groupType || 'unclassified') === 'direct'), latest);
      const indirect = window.NorthstarApp.calculateOptionPnl(txs.filter(tx => tx.instrument === 'option' && (tx.groupType || 'unclassified') === 'indirect'), latest);
      directRealized += direct.realizedPnl || 0;
      directUnrealized += direct.unrealizedPnl || 0;
      indirectRealized += indirect.realizedPnl || 0;
      indirectUnrealized += indirect.unrealizedPnl || 0;
    });

    const realized = stockRealized + directRealized + indirectRealized + dividends;
    const unrealized = stockUnrealized + directUnrealized + indirectUnrealized;
    const cashFlow = selectedTransactions.reduce((sum, tx) => {
      const rate = state.snapshots && state.snapshots.length ? window.NorthstarApp.latestEurUsdRate() : null;
      return sum + window.NorthstarApp.toHomeSafe(window.NorthstarApp.cashFlow(tx), tx.currency || 'EUR', rate);
    }, 0);
    const metrics = [
      ['Records', selectedTransactions.length, value => String(value)],
      ['Realized P&L', realized, formatEur],
      ['Unrealized P&L', unrealized, formatEur],
      ['Stock P&L', stockRealized + stockUnrealized, formatEur],
      ['Direct options', directRealized + directUnrealized, formatEur],
      ['Indirect options', indirectRealized + indirectUnrealized, formatEur],
      ['Dividends', dividends, formatEur],
      ['Net cash flow', cashFlow, formatEur]
    ];
    el.replaceChildren();
    metrics.forEach(([label, value, formatter]) => {
      const metric = document.createElement('div');
      metric.className = 'scope-metric';
      const labelEl = document.createElement('span');
      labelEl.textContent = label;
      const valueEl = document.createElement('strong');
      valueEl.textContent = formatter(value);
      valueEl.style.color = typeof value === 'number' && value < 0 ? 'var(--red)' : '';
      metric.append(labelEl, valueEl);
      el.appendChild(metric);
    });
  }

  function renderDataIntegrity(state) {
    const panel = document.getElementById('dataIntegrityPanel');
    if (!panel) return;
    const transactions = state.transactions || [];
    const positions = state.positions || [];
    const cycles = state.optionCycles || [];
    const relations = state.relationships || [];
    const positionIds = new Set(positions.map(pos => pos.id));
    const txById = new Map(transactions.map(tx => [tx.id, tx]));
    const cycleById = new Map(cycles.map(cycle => [cycle.id, cycle]));
    const issues = [];

    transactions.forEach(tx => {
      if (tx.instrument !== 'cash' && tx.positionId && !positionIds.has(tx.positionId)) {
        issues.push(`Transaction ${String(tx.id).slice(0, 8)} points to a missing position.`);
      }
      if (tx.instrument === 'option' && tx.cycleId) {
        const cycle = cycleById.get(tx.cycleId);
        if (!cycle) issues.push(`Option ${String(tx.id).slice(0, 8)} points to a missing cycle.`);
        else if (cycle.positionId !== tx.positionId || String(cycle.symbol).toUpperCase() !== String(tx.symbol).toUpperCase()) {
          issues.push(`Option ${String(tx.id).slice(0, 8)} does not match its cycle position or symbol.`);
        }
      }
      if (tx.sourceOptionTransactionId && !txById.has(tx.sourceOptionTransactionId)) {
        issues.push(`Generated event ${String(tx.id).slice(0, 8)} points to a missing option.`);
      }
    });

    relations.forEach(relation => {
      const source = relation.sourceId ? txById.get(relation.sourceId) : null;
      if (!source) issues.push(`Relationship ${String(relation.id).slice(0, 8)} points to a missing transaction.`);
      if (relation.targetId && !positionIds.has(relation.targetId)) issues.push(`Relationship ${String(relation.id).slice(0, 8)} points to a missing position.`);
      if (!['coverage', 'hedge'].includes(relation.type)) issues.push(`Relationship ${String(relation.id).slice(0, 8)} has an unknown type.`);
      if (source && source.groupType !== 'direct') issues.push(`Relationship ${String(relation.id).slice(0, 8)} belongs to a non-direct option.`);
      if (source && relation.type === 'coverage') {
        const capacity = (Number(source.quantity) || 0) * (Number(source.multiplier) || 1);
        if (Number(relation.quantity) > capacity + 1e-8) issues.push(`Relationship ${String(relation.id).slice(0, 8)} exceeds contract capacity.`);
      }
      if (source && relation.cycleId !== (source.cycleId || null)) issues.push(`Relationship ${String(relation.id).slice(0, 8)} has a stale cycle reference.`);
    });

    panel.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'panel-heading';
    const title = document.createElement('h3');
    title.textContent = 'Data integrity';
    const status = document.createElement('strong');
    status.textContent = issues.length ? `${issues.length} issue${issues.length === 1 ? '' : 's'}` : 'No issues detected';
    status.className = issues.length ? 'integrity-warning' : 'integrity-good';
    heading.append(title, status);
    panel.appendChild(heading);
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'Read-only checks for links, cycles, positions, and coverage. No automatic repairs are performed.';
    panel.appendChild(note);
    if (issues.length) {
      const list = document.createElement('ul');
      list.className = 'integrity-issues';
      issues.slice(0, 20).forEach(issue => {
        const item = document.createElement('li');
        item.textContent = issue;
        list.appendChild(item);
      });
      if (issues.length > 20) {
        const more = document.createElement('li');
        more.textContent = `${issues.length - 20} additional issue(s) not shown.`;
        list.appendChild(more);
      }
      panel.appendChild(list);
    }
  }

  function cycleContractKey(tx) {
    return [tx.symbol, tx.right, Number(tx.strike) || 0, tx.expiry, Number(tx.multiplier) || 1, tx.optionSide || 'unclassified'].join('|');
  }

  function remainingCycleLegs(transactions) {
    const queues = new Map();
    const ordered = [...transactions].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const consume = (tx, quantity) => {
      const queue = queues.get(cycleContractKey(tx)) || [];
      let remaining = quantity;
      while (remaining > 0 && queue.length) {
        const open = queue[0];
        const matched = Math.min(remaining, open.remaining);
        open.remaining -= matched;
        remaining -= matched;
        if (open.remaining <= 1e-8) queue.shift();
      }
    };
    ordered.forEach(tx => {
      const quantity = Math.max(0, Number(tx.quantity) || 0);
      if (!quantity) return;
      const role = tx.lifecycleRole;
      if (role === 'open') {
        const key = cycleContractKey(tx);
        if (!queues.has(key)) queues.set(key, []);
        queues.get(key).push({ tx, remaining: quantity });
        if (tx.eventType || ['expired', 'assigned', 'exercised'].includes(tx.status)) consume(tx, quantity);
      } else if (role === 'close') {
        consume(tx, quantity);
      } else if (['expire', 'assign', 'exercise'].includes(tx.eventType)) {
        consume(tx, quantity);
      }
    });
    return [...queues.values()].flat().filter(open => open.remaining > 1e-8);
  }

  function optionIntrinsic(tx, underlyingPrice) {
    const leg = tx.tx || tx;
    const strike = Number(leg.strike) || 0;
    const intrinsic = leg.right === 'call'
      ? Math.max(0, underlyingPrice - strike)
      : Math.max(0, strike - underlyingPrice);
    const direction = leg.optionSide === 'short' ? -1 : 1;
    return intrinsic * openQuantity(tx) * (Number(leg.multiplier) || 1) * direction;
  }

  function openQuantity(open) {
    return Number(open.remaining || open.quantity || 0);
  }

  function payoffAtUnderlying(remaining, netCash, underlyingPrice) {
    return netCash + remaining.reduce((sum, open) => sum + optionIntrinsic(open, underlyingPrice), 0);
  }

  function calculateRiskProfile(remaining, optionTransactions, netCash, points) {
    let longCalls = 0;
    let shortCalls = 0;
    remaining.forEach(open => {
      const leg = open.tx || open;
      if (leg.right !== 'call') return;
      const exposure = openQuantity(open) * (Number(leg.multiplier) || 1);
      if (leg.optionSide === 'short') shortCalls += exposure;
      else longCalls += exposure;
    });

    const epsilon = 1e-8;
    const netShortCalls = shortCalls > longCalls + epsilon;
    const netLongCalls = longCalls > shortCalls + epsilon;
    const strikes = optionTransactions.map(tx => Number(tx.strike) || 0).filter(Boolean);
    const maxStrike = strikes.length ? Math.max(...strikes) : 1;
    const criticalPrices = [0, ...strikes, Math.max(maxStrike * 2, maxStrike + 1)];
    const criticalPayoffs = [...new Set(criticalPrices.map(value => Number(value.toFixed(8))))]
      .map(price => payoffAtUnderlying(remaining, netCash, price));

    let label = 'Bounded payoff';
    if (netShortCalls && netLongCalls) label = 'Unbounded upside profit and loss';
    else if (netShortCalls) label = 'Unbounded upside loss';
    else if (netLongCalls) label = 'Unbounded upside profit';

    return {
      label,
      maxProfit: netLongCalls ? null : Math.max(...criticalPayoffs),
      maxLoss: netShortCalls ? null : Math.min(...criticalPayoffs),
      maxSampledProfit: Math.max(...points.map(point => point.payoff)),
      maxSampledLoss: Math.min(...points.map(point => point.payoff)),
      netLongCalls,
      netShortCalls
    };
  }

  function calculateCyclePayoff(transactions) {
    const optionTransactions = transactions.filter(tx => tx.instrument === 'option');
    const remaining = remainingCycleLegs(optionTransactions);
    const strikes = optionTransactions.map(tx => Number(tx.strike) || 0).filter(Boolean);
    const minStrike = strikes.length ? Math.min(...strikes) : 0;
    const maxStrike = strikes.length ? Math.max(...strikes) : 1;
    const lower = Math.max(0, minStrike * 0.7);
    const upper = Math.max(lower + 1, maxStrike * 1.3);
    const points = [];
    const netCash = optionTransactions.reduce((sum, tx) => sum + window.NorthstarApp.cashFlow(tx), 0);
    const pointCount = 61;
    for (let i = 0; i < pointCount; i += 1) {
      const underlying = lower + ((upper - lower) * i / (pointCount - 1));
      const payoff = payoffAtUnderlying(remaining, netCash, underlying);
      points.push({ underlying, payoff });
    }
    const breakEven = [];
    for (let i = 1; i < points.length; i += 1) {
      const previous = points[i - 1];
      const current = points[i];
      if (previous.payoff === 0) breakEven.push(previous.underlying);
      if ((previous.payoff < 0 && current.payoff > 0) || (previous.payoff > 0 && current.payoff < 0)) {
        const proportion = Math.abs(previous.payoff) / (Math.abs(previous.payoff) + Math.abs(current.payoff));
        breakEven.push(previous.underlying + (current.underlying - previous.underlying) * proportion);
      }
    }
    const risk = calculateRiskProfile(remaining, optionTransactions, netCash, points);
    return {
      points,
      netCash,
      openLegs: remaining,
      maxSampledProfit: risk.maxSampledProfit,
      maxSampledLoss: risk.maxSampledLoss,
      risk,
      breakEven: [...new Set(breakEven.map(value => Number(value.toFixed(2))))]
    };
  }

  function renderCyclePayoff(positionId, cycleId) {
    const state = window.NorthstarApp.getState();
    const transactions = (state.transactions || []).filter(tx => tx.positionId === positionId && tx.cycleId === cycleId);
    const payoff = calculateCyclePayoff(transactions);
    const currency = (transactions[0] && transactions[0].currency) || 'EUR';
    const risk = document.getElementById('cyclePayoffRisk');
    if (risk) {
      const cells = [
        ['Net cash invested', window.NorthstarApp.money(payoff.netCash, currency)],
        ['Risk profile', payoff.risk.label],
        ['Max profit', payoff.risk.maxProfit === null ? 'Unbounded' : window.NorthstarApp.money(payoff.risk.maxProfit, currency)],
        ['Max loss', payoff.risk.maxLoss === null ? 'Unbounded' : window.NorthstarApp.money(payoff.risk.maxLoss, currency)],
        ['Displayed-range best', window.NorthstarApp.money(payoff.maxSampledProfit, currency)],
        ['Displayed-range worst', window.NorthstarApp.money(payoff.maxSampledLoss, currency)],
        ['Break-even', payoff.breakEven.length ? payoff.breakEven.map(value => window.NorthstarApp.money(value, currency)).join(', ') : '—'],
        ['Open legs', payoff.openLegs.length]
      ];
      risk.replaceChildren();
      cells.forEach(([label, value]) => {
        const cell = document.createElement('div');
        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        const valueEl = document.createElement('strong');
        valueEl.textContent = value;
        cell.append(labelEl, valueEl);
        risk.appendChild(cell);
      });
    }
    if (!window.Chart) return;
    const canvas = document.getElementById('cyclePayoffChart');
    if (!canvas) return;
    destroyChart('cyclePayoffChart');
    const theme = getThemeColors();
    charts.cyclePayoffChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: payoff.points.map(point => point.underlying.toFixed(2)),
        datasets: [
          {
            label: 'Expiration payoff',
            data: payoff.points.map(point => point.payoff),
            borderColor: theme.ACCENT,
            backgroundColor: theme.MINT,
            fill: true,
            tension: 0.15,
            pointRadius: 0
          },
          {
            label: 'Break-even line',
            data: payoff.points.map(() => 0),
            borderColor: theme.MUTED,
            borderDash: [5, 5],
            borderWidth: 1,
            pointRadius: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true },
          tooltip: { callbacks: { label: context => `${context.dataset.label}: ${window.NorthstarApp.money(context.raw, currency)}` } }
        },
        scales: {
          x: { title: { display: true, text: 'Underlying price at expiry' }, ticks: { maxTicksLimit: 8 } },
          y: { title: { display: true, text: `P&L (${currency})` }, ticks: { callback: value => window.NorthstarApp.money(value, currency) } }
        }
      }
    });
  }

  // Data preparation for the Effective Entry Waterfall Chart
  function calculateWaterfallData(positionId, transactions, latestSnapshot) {
    const state = window.NorthstarApp.getState();
    const pos = (state.positions || []).find(p => p.id === positionId);
    if (!pos) return null;

    const posTxs = transactions
      .filter(t => t.positionId === positionId)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const metrics = window.NorthstarApp.calcPositionMetrics(pos, posTxs, latestSnapshot);
    if (!metrics || metrics.sharesHeld <= 0) return null;

    const shares = metrics.sharesHeld;
    const avgStockPrice = metrics.stockCost / shares;
    const theme = getThemeColors();
    const labels = ['Remaining stock cost'];
    const data = [[0, avgStockPrice]];
    const colors = [theme.INK + '80'];
    let currentLevel = avgStockPrice;

    posTxs.filter(t => t.instrument === 'option' && t.status === 'open').forEach(t => {
      const amount = window.NorthstarApp.cashFlow(t);
      const premiumPerShare = amount / shares;
      const nextLevel = currentLevel - premiumPerShare;
      const labelAction = t.action === 'sell' ? 'Sold' : 'Bought';
      const right = t.right ? t.right.toUpperCase() : 'OPT';
      const strikeStr = t.strike ? String(t.strike) : '';
      labels.push(`${labelAction} ${right} ${strikeStr}`.trim());
      data.push([currentLevel, nextLevel]);
      colors.push(t.action === 'sell' ? theme.ACCENT : theme.RED);
      currentLevel = nextLevel;
    });

    if (metrics.totalDividends) {
      const nextLevel = currentLevel - (metrics.totalDividends / shares);
      labels.push('Dividends');
      data.push([currentLevel, nextLevel]);
      colors.push(theme.ACCENT);
      currentLevel = nextLevel;
    }

    labels.push('Effective Entry');
    data.push([0, currentLevel]);
    colors.push(theme.ACCENT);

    return { labels, data, colors, currentPrice: metrics.currentPrice };
  }

  // Render a specific waterfall chart (can be used in main Analytics or Position Detail)
  function renderWaterfallChart(positionId, transactions, snapshots, canvasId, chartId) {
    const latestSnapshot = snapshots && snapshots.length > 0 ? snapshots[0] : null;
    const dataObj = calculateWaterfallData(positionId, transactions, latestSnapshot);
    if (!dataObj) return;
    
    // Determine position currency from its transactions
    const posTxs = transactions.filter(t => t.positionId === positionId);
    const posCurrency = (posTxs.length > 0 && posTxs[0].currency) || 'EUR';
    const curSymbol = posCurrency === 'USD' ? '$' : '€';
    
    const theme = getThemeColors();
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    
    destroyChart(chartId);
    
    const datasets = [{
      label: 'Effective Entry',
      type: 'bar',
      data: dataObj.data,
      backgroundColor: dataObj.colors,
      borderWidth: 0,
      borderRadius: 2
    }];
    
    if (dataObj.currentPrice !== null) {
      datasets.push({
        label: 'Current Price',
        type: 'line',
        data: dataObj.labels.map(() => dataObj.currentPrice),
        borderColor: theme.MUTED,
        borderDash: [5, 5],
        borderWidth: 2,
        pointRadius: 0,
        fill: false
      });
    }
    
    charts[chartId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: dataObj.labels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function(context) {
                if (context.dataset.type === 'line') {
                  return 'Current Price: ' + window.NorthstarApp.money(context.raw, posCurrency);
                }
                const val = context.raw; // val is [start, end]
                const diff = Math.abs(val[0] - val[1]);
                if (context.dataIndex === 0) {
                  return 'Cost: ' + window.NorthstarApp.money(val[1], posCurrency);
                } else if (context.dataIndex === context.chart.data.labels.length - 1) {
                  return 'Effective Entry: ' + window.NorthstarApp.money(val[1], posCurrency);
                } else {
                  const type = val[0] > val[1] ? 'Premium Received: ' : 'Cost Paid: ';
                  return type + window.NorthstarApp.money(diff, posCurrency);
                }
              }
            }
          }
        },
        scales: {
          y: { 
            ticks: { callback: (val) => curSymbol + val } 
          }
        }
      }
    });
  }

  // Initialize the dropdown for the main waterfall chart
  function initWaterfallDropdown(positions, transactions, snapshots) {
    const select = document.getElementById('waterfallPosition');
    const panel = document.getElementById('waterfallPanel');
    if (!select || !panel) return;

    const enabled = isChartEnabled('waterfall');
    const latestSnap = snapshots && snapshots[0];
    const posWithStocks = positions.filter(p => {
      const txs = transactions.filter(t => t.positionId === p.id);
      const metrics = window.NorthstarApp.calcPositionMetrics(p, txs, latestSnap);
      return metrics.sharesHeld > 0;
    });

    if (!setChartVisible('waterfallPanel', 'waterfallChart', enabled, posWithStocks.length > 0)) {
      return;
    }
    
    const currentVal = select.value;
    select.innerHTML = '';
    
    posWithStocks.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label || p.symbol;
      select.appendChild(opt);
    });
    
    if (currentVal && posWithStocks.some(p => p.id === currentVal)) {
      select.value = currentVal;
    }
    
    select.onchange = (e) => {
      renderWaterfallChart(e.target.value, window.NorthstarApp.getState().transactions, window.NorthstarApp.getState().snapshots, 'waterfallChart', 'waterfallChart');
    };
    
    if (select.value) {
      renderWaterfallChart(select.value, transactions, snapshots, 'waterfallChart', 'waterfallChart');
    }
  }

  // Chart 2: Premium Collected by Month
  function renderPremiumChart(transactions) {
    const optionSells = transactions.filter(t => t.instrument === 'option' && t.action === 'sell');
    if (!setChartVisible('premiumPanel', 'premiumChart', isChartEnabled('premium'), optionSells.length > 0)) {
      return;
    }
    
    const months = {};
    const rate = window.NorthstarApp.latestEurUsdRate();
    optionSells.forEach(t => {
      const key = monthKey(t.date);
      months[key] = (months[key] || 0) + window.NorthstarApp.toHomeSafe(
        window.NorthstarApp.cashFlow(t),
        t.currency || 'EUR',
        rate
      );
    });
    
    const sortedKeys = Object.keys(months).sort();
    const labels = sortedKeys.map(monthLabel);
    const data = sortedKeys.map(k => months[k]);
    
    const theme = getThemeColors();
    const ctx = document.getElementById('premiumChart');
    destroyChart('premiumChart');
    
    charts['premiumChart'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Premium Collected',
          data,
          backgroundColor: theme.ACCENT,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => window.NorthstarApp.money(ctx.raw, 'EUR') } }
        },
        scales: {
          y: { 
            beginAtZero: true, 
            ticks: { callback: (val) => '€' + val } 
          }
        }
      }
    });
  }

  // Chart 3: Portfolio P&L Over Time
  function renderPlChart(positions, transactions, snapshots) {
    const hasSnaps = snapshots && snapshots.length > 0;
    if (!setChartVisible('plPanel', 'plChart', isChartEnabled('portfolio'), hasSnaps)) {
      return;
    }
    
    const sortedSnapshots = [...snapshots].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    const labels = sortedSnapshots.map(s => {
      const d = new Date(s.timestamp);
      return d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric' });
    });
    
    const data = sortedSnapshots.map(snapshot => scopedPortfolioValue(snapshot, positions, transactions));
    
    const theme = getThemeColors();
    const ctx = document.getElementById('plChart');
    destroyChart('plChart');
    
    charts['plChart'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Selected value (EUR)',
          data,
          borderColor: theme.ACCENT,
          backgroundColor: theme.MINT,
          fill: {
            target: 'origin',
            above: theme.MINT,
            below: theme.RED + '40'
          },
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0.2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => window.NorthstarApp.money(ctx.raw, 'EUR') } }
        },
        scales: {
          y: { ticks: euroTick() }
        }
      }
    });
  }

  function scopedPortfolioValue(snapshot, positions, transactions) {
    if (!snapshot) return 0;
    const asOfDate = snapshot.timestamp ? snapshot.timestamp.slice(0, 10) : null;
    const rate = window.NorthstarApp.snapshotEurUsdRate(snapshot) || window.NorthstarApp.latestEurUsdRate();
    const cash = cashByCurrency(transactions, asOfDate);
    const cashValue = (cash.EUR || 0) + window.NorthstarApp.toHomeSafe(cash.USD || 0, 'USD', rate);
    const positionValue = positions.reduce((sum, position) => {
      const txs = transactions.filter(tx => tx.positionId === position.id);
      return sum + positionMarketEur(position, txs, snapshot, rate, asOfDate);
    }, 0);
    return cashValue + positionValue;
  }

  // Chart 4: Position Breakdown
  function renderBreakdownChart(positions, transactions, snapshots) {
    const openPositions = positions.filter(p => p.status === 'open');
    const canRender = openPositions.length > 0 && snapshots && snapshots.length > 0;
    if (!setChartVisible('breakdownPanel', 'breakdownChart', isChartEnabled('breakdown'), canRender)) {
      return;
    }
    
    // snapshots are sorted newest-first by app.js, so [0] is the latest
    const latestSnapshot = snapshots[0];
    const rate = window.NorthstarApp.snapshotEurUsdRate(latestSnapshot) || window.NorthstarApp.latestEurUsdRate();
    const labels = [];
    const costBasisData = [];
    const currentValueData = [];
    const currentColors = [];
    
    const theme = getThemeColors();
    
    openPositions.forEach(p => {
      const posTxs = transactions.filter(t => t.positionId === p.id);
      const metrics = window.NorthstarApp.calcPositionMetrics(p, posTxs, latestSnapshot);
      const cur = p.currency || 'EUR';
      
      const shares = metrics.sharesHeld || 0;
      if (shares > 0) {
        labels.push(p.label || p.symbol);
        
        const costBasis = window.NorthstarApp.toHomeSafe(metrics.effectiveEntry * shares, cur, rate);
        const currentPrice = (latestSnapshot.stockPrices && latestSnapshot.stockPrices[p.symbol]) ? Number(latestSnapshot.stockPrices[p.symbol]) : 0;
        const currentValue = window.NorthstarApp.toHomeSafe(currentPrice * shares, cur, rate);
        
        costBasisData.push(costBasis);
        currentValueData.push(currentValue);
        
        currentColors.push(currentValue >= costBasis ? theme.ACCENT : theme.RED);
      }
    });
    
    if (labels.length === 0) {
      setChartVisible('breakdownPanel', 'breakdownChart', true, false);
      return;
    }
    
    const ctx = document.getElementById('breakdownChart');
    destroyChart('breakdownChart');
    
    charts['breakdownChart'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Cost Basis',
            data: costBasisData,
            backgroundColor: theme.MUTED,
            borderRadius: 4
          },
          {
            label: 'Current Value',
            data: currentValueData,
            backgroundColor: currentColors,
            borderRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: {
            callbacks: {
              label: (ctx) => ctx.dataset.label + ': ' + window.NorthstarApp.money(ctx.raw, 'EUR')
            }
          }
        },
        scales: {
          y: { 
            beginAtZero: true, 
            ticks: { callback: (val) => '€' + val } 
          }
        }
      }
    });
  }

  function positionMarketEur(pos, txs, snapshot, rate, asOfDate = null) {
    const metrics = window.NorthstarApp.calcPositionMetrics(pos, txs, snapshot, asOfDate);
    const cur = pos.currency || 'EUR';
    let posValue = 0;
    if (metrics.sharesHeld > 0 && metrics.currentPrice !== null) {
      posValue += metrics.sharesHeld * metrics.currentPrice;
    }
    if (snapshot) {
      metrics.openOptions.forEach(opt => {
        const premium = snapshot.optionPrices && snapshot.optionPrices[opt.id] !== undefined
          ? snapshot.optionPrices[opt.id] : 0;
        const optValue = premium * opt.quantity * opt.multiplier;
        posValue += opt.action === 'buy' ? optValue : -optValue;
      });
    }
    return window.NorthstarApp.toHomeSafe(posValue, cur, rate);
  }

  function renderAllocationChart(positions, snapshots, transactions = window.NorthstarApp.getState().transactions) {
    const rate = window.NorthstarApp.latestEurUsdRate();
    const cash = cashByCurrency(transactions);
    const latest = snapshots && snapshots[0];
    const theme = getThemeColors();
    const labels = [];
    const data = [];
    const colors = [];

    if (Math.abs(cash.EUR || 0) > 0.005) {
      labels.push('Cash EUR');
      data.push(cash.EUR);
      colors.push(theme.ACCENT);
    }
    if (rate && Math.abs(cash.USD || 0) > 0.005) {
      labels.push('Cash USD');
      data.push(window.NorthstarApp.toHomeSafe(cash.USD, 'USD', rate));
      colors.push(theme.INK);
    }
    if (latest) {
      const palette = [theme.MUTED, theme.RED, theme.MINT, theme.ACCENT];
      positions.filter(p => p.status === 'open').forEach((p, i) => {
        const txs = transactions.filter(t => t.positionId === p.id);
        const val = positionMarketEur(p, txs, latest, rate);
        if (Math.abs(val) < 0.005) return;
        labels.push(p.label || p.symbol);
        data.push(val);
        colors.push(palette[i % palette.length]);
      });
    }

    if (!setChartVisible('allocationPanel', 'allocationChart', isChartEnabled('allocation'), data.length > 0)) {
      return;
    }

    const ctx = document.getElementById('allocationChart');
    destroyChart('allocationChart');
    charts['allocationChart'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Value (EUR)',
          data,
          backgroundColor: colors,
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => window.NorthstarApp.money(c.raw, 'EUR') } }
        },
        scales: {
          x: { ticks: euroTick() }
        }
      }
    });
  }

  function renderUnrealizedChart(positions, snapshots, transactions = window.NorthstarApp.getState().transactions) {
    const latest = snapshots && snapshots[0];
    const rate = window.NorthstarApp.latestEurUsdRate();
    const labels = [];
    const data = [];
    const colors = [];
    const theme = getThemeColors();

    if (latest) {
      positions.filter(p => p.status === 'open').forEach(p => {
        const txs = transactions.filter(t => t.positionId === p.id);
        const metrics = window.NorthstarApp.calcPositionMetrics(p, txs, latest);
        if (metrics.unrealizedPL === null) return;
        labels.push(p.label || p.symbol);
        const val = window.NorthstarApp.toHomeSafe(metrics.unrealizedPL, p.currency || 'EUR', rate);
        data.push(val);
        colors.push(val >= 0 ? theme.ACCENT : theme.RED);
      });
    }

    if (!setChartVisible('unrealizedPanel', 'unrealizedChart', isChartEnabled('unrealized'), data.length > 0)) {
      return;
    }

    const ctx = document.getElementById('unrealizedChart');
    destroyChart('unrealizedChart');
    charts['unrealizedChart'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Unrealized P&L (EUR)',
          data,
          backgroundColor: colors,
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => window.NorthstarApp.money(c.raw, 'EUR') } }
        },
        scales: {
          x: { ticks: euroTick() }
        }
      }
    });
  }

  function renderDividendsChart(transactions) {
    const dividends = transactions.filter(t => t.instrument === 'dividend');
    if (!setChartVisible('dividendsPanel', 'dividendsChart', isChartEnabled('dividends'), dividends.length > 0)) {
      return;
    }

    const rate = window.NorthstarApp.latestEurUsdRate();
    const months = {};
    dividends.forEach(t => {
      const key = monthKey(t.date);
      months[key] = (months[key] || 0) + window.NorthstarApp.toHomeSafe(
        window.NorthstarApp.cashFlow(t), t.currency || 'EUR', rate
      );
    });
    const sortedKeys = Object.keys(months).sort();
    const theme = getThemeColors();
    const ctx = document.getElementById('dividendsChart');
    destroyChart('dividendsChart');
    charts['dividendsChart'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: sortedKeys.map(monthLabel),
        datasets: [{
          label: 'Dividends (EUR)',
          data: sortedKeys.map(k => months[k]),
          backgroundColor: theme.ACCENT,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => window.NorthstarApp.money(c.raw, 'EUR') } }
        },
        scales: {
          y: { beginAtZero: true, ticks: euroTick() }
        }
      }
    });
  }

  function renderCashflowChart(transactions) {
    const flows = transactions.filter(t => t.instrument === 'cash' && !t.fxGroupId);
    if (!setChartVisible('cashflowPanel', 'cashflowChart', isChartEnabled('cashflow'), flows.length > 0)) {
      return;
    }

    const rate = window.NorthstarApp.latestEurUsdRate();
    const months = {};
    flows.forEach(t => {
      const key = monthKey(t.date);
      if (!months[key]) months[key] = { in: 0, out: 0 };
      const amt = window.NorthstarApp.toHomeSafe(
        Math.abs(window.NorthstarApp.cashFlow(t)), t.currency || 'EUR', rate
      );
      if (t.action === 'deposit') months[key].in += amt;
      else months[key].out += amt;
    });
    const sortedKeys = Object.keys(months).sort();
    const theme = getThemeColors();
    const ctx = document.getElementById('cashflowChart');
    destroyChart('cashflowChart');
    charts['cashflowChart'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: sortedKeys.map(monthLabel),
        datasets: [
          {
            label: 'Deposits',
            data: sortedKeys.map(k => months[k].in),
            backgroundColor: theme.ACCENT,
            borderRadius: 4
          },
          {
            label: 'Withdrawals',
            data: sortedKeys.map(k => months[k].out),
            backgroundColor: theme.RED,
            borderRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + window.NorthstarApp.money(c.raw, 'EUR') } }
        },
        scales: {
          y: { beginAtZero: true, ticks: euroTick() }
        }
      }
    });
  }

  function renderActivityChart(transactions) {
    if (!setChartVisible('activityPanel', 'activityChart', isChartEnabled('activity'), transactions.length > 0)) {
      return;
    }

    const months = {};
    const kinds = ['stock', 'option', 'cash', 'dividend'];
    transactions.forEach(t => {
      const key = monthKey(t.date);
      if (!months[key]) months[key] = { stock: 0, option: 0, cash: 0, dividend: 0 };
      const inst = kinds.includes(t.instrument) ? t.instrument : 'cash';
      months[key][inst] += 1;
    });
    const sortedKeys = Object.keys(months).sort();
    const theme = getThemeColors();
    const ctx = document.getElementById('activityChart');
    destroyChart('activityChart');
    charts['activityChart'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: sortedKeys.map(monthLabel),
        datasets: [
          { label: 'Stock', data: sortedKeys.map(k => months[k].stock), backgroundColor: theme.INK, borderRadius: 2 },
          { label: 'Option', data: sortedKeys.map(k => months[k].option), backgroundColor: theme.ACCENT, borderRadius: 2 },
          { label: 'Cash', data: sortedKeys.map(k => months[k].cash), backgroundColor: theme.MUTED, borderRadius: 2 },
          { label: 'Dividend', data: sortedKeys.map(k => months[k].dividend), backgroundColor: theme.MINT, borderRadius: 2 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { stacked: true },
          y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }
        }
      }
    });
  }

  function renderExpiryChart(transactions) {
    const openOpts = transactions.filter(t => t.instrument === 'option' && t.status === 'open' && t.expiry);
    if (!setChartVisible('expiryPanel', 'expiryChart', isChartEnabled('expiry'), openOpts.length > 0)) {
      return;
    }

    const buckets = {};
    openOpts.forEach(t => {
      const key = t.expiry.slice(0, 7);
      buckets[key] = (buckets[key] || 0) + Number(t.quantity || 0);
    });
    const sortedKeys = Object.keys(buckets).sort();
    const theme = getThemeColors();
    const ctx = document.getElementById('expiryChart');
    destroyChart('expiryChart');
    charts['expiryChart'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: sortedKeys.map(monthLabel),
        datasets: [{
          label: 'Contracts',
          data: sortedKeys.map(k => buckets[k]),
          backgroundColor: theme.ACCENT,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => c.raw + ' contract(s)' } }
        },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } }
        }
      }
    });
  }

  // XIRR Calculation (Newton-Raphson)
  // All flows are consolidated to EUR (home currency) using the provided exchange rate.
  // External flows: deposits (negative = money in), withdrawals (positive = money out),
  // plus a terminal value representing current portfolio worth in EUR (positive).
  function calculateXIRR(transactions, currentPortfolioValueEur, eurUsdRate) {
    const flows = [];
    
    // Helper: convert to EUR
    function toEur(amount, currency) {
      if (window.NorthstarApp && window.NorthstarApp.toHomeSafe) {
        return window.NorthstarApp.toHomeSafe(amount, currency, eurUsdRate);
      }
      if (!currency || currency === 'EUR') return amount;
      if (currency === 'USD' && eurUsdRate && eurUsdRate > 0) return amount / eurUsdRate;
      return 0;
    }

    // Extract external cash flows (deposits / withdrawals only, NOT FX exchanges)
    transactions
      .filter(tx => tx.instrument === 'cash' && !tx.fxGroupId)
      .forEach(tx => {
        const date = new Date(`${tx.date}T12:00:00`);
        const amount = Number(tx.price) - Number(tx.fees || 0);
        const amountEur = toEur(amount, tx.currency || 'EUR');
        if (tx.action === 'deposit') {
          flows.push({ date, amount: -amountEur }); // Money going IN = negative for investor
        } else if (tx.action === 'withdrawal') {
          flows.push({ date, amount: amountEur });  // Money coming OUT = positive for investor
        }
      });

    if (flows.length === 0) return null; // No external flows → can't compute

    // Terminal value: current portfolio value in EUR as of today
    flows.push({ date: new Date(), amount: currentPortfolioValueEur });

    // Sort chronologically
    flows.sort((a, b) => a.date - b.date);

    // Need at least some time elapsed
    const daySpan = (flows[flows.length - 1].date - flows[0].date) / (24 * 60 * 60 * 1000);
    if (daySpan < 1) return null;

    const d0 = flows[0].date;
    const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

    function npv(rate) {
      return flows.reduce((sum, cf) => {
        const years = (cf.date - d0) / MS_PER_YEAR;
        return sum + cf.amount / Math.pow(1 + rate, years);
      }, 0);
    }

    function npvDeriv(rate) {
      return flows.reduce((sum, cf) => {
        const years = (cf.date - d0) / MS_PER_YEAR;
        return sum + (-cf.amount * years) / Math.pow(1 + rate, years + 1);
      }, 0);
    }

    // Newton-Raphson iteration
    let rate = 0.1; // Initial guess: 10%
    for (let i = 0; i < 300; i++) {
      const f = npv(rate);
      const df = npvDeriv(rate);
      if (Math.abs(df) < 1e-12) break;

      let newRate = rate - f / df;

      // Clamp to prevent divergence
      if (newRate < -0.99) newRate = -0.99;
      if (newRate > 100) newRate = rate * 0.5;

      if (Math.abs(newRate - rate) < 1e-9) return newRate;
      rate = newRate;
    }

    // Verify convergence
    return Math.abs(npv(rate)) < 0.01 ? rate : null;
  }

  // Main Entry Point
  function renderAnalytics() {
    if (!window.NorthstarApp) return;
    
    applyChartDefaults();
    renderPicker();
    
    const state = window.NorthstarApp.getState();
    const { transactions, positions, snapshots } = state;
    const selectedTransactions = scopedTransactions(state);
    const selectedPositions = scopedPositions(state);
    renderScopeControls(state);
    renderScopeSummary(state, selectedTransactions);
    renderDataIntegrity(state);

    const emptyState = document.getElementById('emptyAnalytics');
    const content = document.getElementById('analyticsContent');
    const snapshotInfo = document.getElementById('snapshotInfo');
    const hint = document.getElementById('chartsOffHint');
    const picker = document.getElementById('chartPicker');

    if (picker) picker.classList.remove('hidden');

    if (!transactions || transactions.length === 0) {
      if (emptyState) emptyState.classList.remove('hidden');
      if (content) content.classList.add('hidden');
      if (hint) hint.classList.add('hidden');
      if (snapshotInfo) snapshotInfo.textContent = '';
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');
    if (content) content.classList.remove('hidden');
    if (hint) hint.classList.toggle('hidden', CHARTS.some(c => isChartEnabled(c.id)));

    if (snapshotInfo) {
      if (snapshots && snapshots.length > 0) {
        const latest = snapshots[0];
        const d = new Date(latest.timestamp);
        const dateString = d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        snapshotInfo.textContent = `Latest snapshot: ${dateString}`;
      } else {
        snapshotInfo.textContent = 'No price snapshots yet — click Update Prices';
      }
    }

    initWaterfallDropdown(selectedPositions, selectedTransactions, snapshots);
    renderPremiumChart(selectedTransactions);
    renderPlChart(selectedPositions, selectedTransactions, snapshots);
    renderBreakdownChart(selectedPositions, selectedTransactions, snapshots);
    renderAllocationChart(selectedPositions, snapshots, selectedTransactions);
    renderUnrealizedChart(selectedPositions, snapshots, selectedTransactions);
    renderDividendsChart(selectedTransactions);
    renderCashflowChart(selectedTransactions);
    renderActivityChart(selectedTransactions);
    renderExpiryChart(selectedTransactions);
  }

  // Position specific Entry Point for the Position Detail Dialog
  function renderPositionWaterfall(positionId) {
    if (!window.NorthstarApp) return;
    applyChartDefaults();
    const state = window.NorthstarApp.getState();
    renderWaterfallChart(positionId, state.transactions, state.snapshots, 'posDetailWaterfall', 'posDetailWaterfall');
  }

  // Expose to global scope for App.js to consume
  window.NorthstarAnalytics = {
    renderAnalytics,
    renderPositionWaterfall,
    renderCyclePayoff,
    calculateXIRR
  };
})();

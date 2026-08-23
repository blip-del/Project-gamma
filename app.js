const DB_NAME = 'northstar-trading-journal';
const DB_VERSION = 4;

let transactions = [];
let positions = [];
let snapshots = [];
let tradeGroups = [];
let optionCycles = [];
let relationships = [];
let editingTxId = null;
let cycleDetailContext = null;
let relationshipEditTxId = null;
let cycleMoveTxId = null;

// Helper Functions
const $ = selector => document.querySelector(selector);
const money = (n, cur = 'EUR') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n || 0);
const dateText = d => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${d}T12:00:00`));
const dateTimeText = iso => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric' }).format(new Date(iso));

function snapshotEurUsdRate(snapshot) {
  const rate = snapshot && snapshot.exchangeRates && Number(snapshot.exchangeRates.EURUSD);
  return rate > 0 ? rate : null;
}

// Newest snapshot that actually stored a rate (snapshots are newest-first)
function latestEurUsdRate() {
  for (const snap of snapshots) {
    const rate = snapshotEurUsdRate(snap);
    if (rate) return rate;
  }
  return null;
}

// Convert an amount to home currency (EUR). rate = EURUSD (1 EUR = rate USD)
function toHome(amount, currency, rate) {
  if (!currency || currency === 'EUR') return amount;
  if (currency === 'USD' && rate && rate > 0) return amount / rate;
  return amount;
}

// USD omitted from EUR totals until a manual rate exists — never treat dollars as euros
function toHomeSafe(amount, currency, rate) {
  if (!currency || currency === 'EUR') return Number(amount) || 0;
  if (currency === 'USD' && rate && rate > 0) return Number(amount) / rate;
  return 0;
}

function getCashByCurrency(asOfDate) {
  const cashByCur = { EUR: 0, USD: 0 };
  transactions.forEach(tx => {
    if (asOfDate && tx.date > asOfDate) return;
    const cur = tx.currency || 'EUR';
    cashByCur[cur] = (cashByCur[cur] || 0) + cashFlow(tx);
  });
  return cashByCur;
}

function cashFlow(record) {
  const gross = Number(record.quantity) * Number(record.price) * (record.instrument === 'option' ? Number(record.multiplier) : 1);
  // Actions that bring money IN: sell, deposit, receive (dividend)
  if (record.action === 'sell' || record.action === 'deposit' || record.action === 'receive') {
    return gross - Number(record.fees);
  }
  // Actions that take money OUT: buy, withdrawal
  return -(gross + Number(record.fees));
}

function normalizeTransaction(record) {
  const normalized = { ...record };
  normalized.groupType = normalized.groupType || (normalized.instrument === 'option' ? 'unclassified' : normalized.instrument === 'stock' ? 'stock' : 'portfolio');
  normalized.cycleId = normalized.cycleId || null;
  normalized.lifecycleRole = normalized.lifecycleRole || (normalized.instrument === 'option' ? 'unclassified' : null);
  normalized.optionSide = normalized.optionSide || (normalized.instrument === 'option' ? 'unclassified' : null);
  normalized.stockLinkType = normalized.stockLinkType || (normalized.instrument === 'option' ? 'none' : null);
  normalized.coveredShares = Number(normalized.coveredShares) || 0;
  normalized.eventType = normalized.eventType || null;
  normalized.eventDate = normalized.eventDate || null;
  normalized.legOrder = Number.isFinite(Number(normalized.legOrder)) ? Number(normalized.legOrder) : null;
  return normalized;
}

function normalizePosition(position, positionTransactions = []) {
  const normalized = { ...position };
  if (!normalized.positionDate) {
    const dates = positionTransactions.map(tx => tx.date).filter(Boolean).sort();
    normalized.positionDate = dates[0] || (normalized.createdAt ? normalized.createdAt.slice(0, 10) : null);
  }
  normalized.positionDate = normalized.positionDate || null;
  return normalized;
}

function optionContractKey(tx) {
  return [
    String(tx.symbol || '').toUpperCase(),
    String(tx.right || '').toLowerCase(),
    Number(tx.strike) || 0,
    String(tx.expiry || ''),
    Number(tx.multiplier) || 1,
    String(tx.currency || 'EUR')
  ].join('|');
}

function optionLifecycleTransactions(optionTransactions) {
  const byCycle = new Map();
  optionTransactions.forEach(tx => {
    const key = tx.cycleId || `legacy:${tx.id}`;
    if (!byCycle.has(key)) byCycle.set(key, []);
    byCycle.get(key).push(tx);
  });
  return [...byCycle.entries()].map(([cycleId, txs]) => ({
    cycleId: cycleId.startsWith('legacy:') ? null : cycleId,
    transactions: [...txs].sort((a, b) => {
      const byDate = String(a.date).localeCompare(String(b.date));
      return byDate || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    })
  }));
}

function optionTerminalEffective(tx, asOfDate = null) {
  if (!['expired', 'assigned', 'exercised'].includes(tx.status)) return false;
  if (!asOfDate) return true;
  const eventDate = tx.eventDate || tx.expiry || tx.date;
  return !eventDate || eventDate <= asOfDate;
}

function calculateOptionPnl(optionTransactions, latestSnapshot = null, asOfDate = null) {
  const cycles = [];
  const totals = {
    realizedPnl: 0,
    unrealizedPnl: 0,
    openQuantity: 0,
    unmatchedQuantity: 0
  };

  optionLifecycleTransactions(optionTransactions.filter(tx => tx.instrument === 'option' && (!asOfDate || tx.date <= asOfDate))).forEach(group => {
    const opens = new Map();
    const realizedMatches = [];
    const errors = [];
    let realizedPnl = 0;
    let unrealizedPnl = 0;
    let openQuantity = 0;
    let unmatchedQuantity = 0;

    const addOpen = (tx, quantity) => {
      const key = `${optionContractKey(tx)}|${tx.optionSide || 'unclassified'}`;
      if (!opens.has(key)) opens.set(key, []);
      opens.get(key).push({ tx, remaining: quantity });
    };

    const consumeOpen = (tx, quantity, closeCashFlow, outcome) => {
      const key = `${optionContractKey(tx)}|${tx.optionSide || 'unclassified'}`;
      const queue = opens.get(key) || [];
      let remaining = quantity;
      const closeUnitCash = quantity > 0 ? closeCashFlow / quantity : 0;

      while (remaining > 0 && queue.length > 0) {
        const opening = queue[0];
        const matched = Math.min(remaining, opening.remaining);
        const openUnitCash = opening.tx.quantity ? cashFlow(opening.tx) / Number(opening.tx.quantity) : 0;
        const matchPnl = (openUnitCash + closeUnitCash) * matched;
        realizedPnl += matchPnl;
        realizedMatches.push({
          openingTransactionId: opening.tx.id,
          closingTransactionId: tx.id,
          quantity: matched,
          outcome,
          pnl: matchPnl
        });
        opening.remaining -= matched;
        remaining -= matched;
        if (opening.remaining <= 1e-8) queue.shift();
      }

      if (remaining > 1e-8) {
        unmatchedQuantity += remaining;
        errors.push(`No matching opening quantity for ${tx.id}: ${remaining} contract(s)`);
      }
    };

    group.transactions.forEach(tx => {
      const qty = Math.max(0, Number(tx.quantity) || 0);
      const role = tx.lifecycleRole;
      const eventType = tx.eventType || '';
      if (!qty || !role && !['expire', 'assign', 'exercise'].includes(eventType)) return;

      if (role === 'open') {
        addOpen(tx, qty);
        const terminalOutcome = eventType || (optionTerminalEffective(tx, asOfDate) ? tx.status : '');
        if (terminalOutcome) consumeOpen(tx, qty, 0, terminalOutcome);
      } else if (role === 'close') {
        consumeOpen(tx, qty, cashFlow(tx), 'closed');
      } else if (['expire', 'assign', 'exercise'].includes(eventType)) {
        consumeOpen(tx, qty, 0, eventType);
      }
    });

    opens.forEach(queue => queue.forEach(opening => {
      if (opening.remaining <= 1e-8) return;
      openQuantity += opening.remaining;
      const mark = latestSnapshot && latestSnapshot.optionPrices && latestSnapshot.optionPrices[opening.tx.id] !== undefined
        ? Number(latestSnapshot.optionPrices[opening.tx.id]) : null;
      const openCash = opening.tx.quantity ? cashFlow(opening.tx) * (opening.remaining / Number(opening.tx.quantity)) : 0;
      if (mark !== null && Number.isFinite(mark)) {
        const direction = opening.tx.optionSide === 'short' ? -1 : 1;
        unrealizedPnl += openCash + direction * mark * opening.remaining * (Number(opening.tx.multiplier) || 1);
      }
    }));

    const cycleRecord = optionCycles.find(cycle => cycle.id === group.cycleId);
    cycles.push({
      id: group.cycleId,
      label: cycleRecord ? cycleRecord.label : null,
      strategyType: cycleRecord ? cycleRecord.strategyType || 'single-leg' : 'unclassified',
      groupType: cycleRecord ? cycleRecord.groupType || 'unclassified' : 'unclassified',
      transactions: group.transactions,
      realizedPnl,
      unrealizedPnl,
      openQuantity,
      unmatchedQuantity,
      realizedMatches,
      errors,
      status: openQuantity > 0 ? 'open' : 'closed'
    });
    totals.realizedPnl += realizedPnl;
    totals.unrealizedPnl += unrealizedPnl;
    totals.openQuantity += openQuantity;
    totals.unmatchedQuantity += unmatchedQuantity;
  });

  return { cycles, ...totals };
}

function details(record) {
  if (record.instrument === 'stock') return `${record.symbol} stock`;
  if (record.instrument === 'cash') {
    if (record.fxGroupId) return `FX Exchange`;
    return record.action === 'deposit' ? 'Deposit' : 'Withdrawal';
  }
  if (record.instrument === 'dividend') return `${record.symbol} dividend`;
  const right = record.right ? record.right.toUpperCase() : '';
  const strike = money(record.strike || 0, record.currency || 'EUR');
  return `${record.symbol} · ${right} ${strike} · ${record.expiry}`;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
    el.classList.add('hidden');
  }, 2600);
}

// DB Operations
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion;
      
      if (oldVersion < 1) {
        const txStore = db.createObjectStore('transactions', { keyPath: 'id' });
        txStore.createIndex('date', 'date');
      }
      
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains('transactions')) {
            const txStore = db.createObjectStore('transactions', { keyPath: 'id' });
            txStore.createIndex('date', 'date');
            txStore.createIndex('positionId', 'positionId');
        } else {
            const txStore = e.target.transaction.objectStore('transactions');
            if (!txStore.indexNames.contains('positionId')) {
                txStore.createIndex('positionId', 'positionId');
            }
        }
        
        if (!db.objectStoreNames.contains('positions')) {
          const posStore = db.createObjectStore('positions', { keyPath: 'id' });
          posStore.createIndex('symbol', 'symbol');
          posStore.createIndex('status', 'status');
        }
        
        if (!db.objectStoreNames.contains('snapshots')) {
          const snapStore = db.createObjectStore('snapshots', { keyPath: 'id' });
          snapStore.createIndex('timestamp', 'timestamp');
        }
      }

      if (oldVersion < 3) {
        const txStore = e.target.transaction.objectStore('transactions');
        [['instrument', 'instrument'], ['symbol', 'symbol'], ['cycleId', 'cycleId'], ['groupType', 'groupType']].forEach(([name, keyPath]) => {
          if (!txStore.indexNames.contains(name)) txStore.createIndex(name, keyPath);
        });

        if (!db.objectStoreNames.contains('tradeGroups')) {
          const groupStore = db.createObjectStore('tradeGroups', { keyPath: 'id' });
          groupStore.createIndex('positionId', 'positionId');
          groupStore.createIndex('groupType', 'groupType');
          groupStore.createIndex('parentId', 'parentId');
        }

        if (!db.objectStoreNames.contains('optionCycles')) {
          const cycleStore = db.createObjectStore('optionCycles', { keyPath: 'id' });
          cycleStore.createIndex('positionId', 'positionId');
          cycleStore.createIndex('groupId', 'groupId');
          cycleStore.createIndex('status', 'status');
          cycleStore.createIndex('symbol', 'symbol');
        }

        if (!db.objectStoreNames.contains('relationships')) {
          const relationStore = db.createObjectStore('relationships', { keyPath: 'id' });
          relationStore.createIndex('positionId', 'positionId');
          relationStore.createIndex('type', 'type');
          relationStore.createIndex('sourceId', 'sourceId');
          relationStore.createIndex('targetId', 'targetId');
          relationStore.createIndex('cycleId', 'cycleId');
        }
      }

      if (oldVersion < 4) {
        const txStore = e.target.transaction.objectStore('transactions');
        [['sourceOptionTransactionId', 'sourceOptionTransactionId'], ['eventType', 'eventType']].forEach(([name, keyPath]) => {
          if (!txStore.indexNames.contains(name)) txStore.createIndex(name, keyPath);
        });
      }
    };
    
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbGetAll(storeName) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
}

function dbPut(storeName, item) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(item);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
}

function dbRemove(storeName, id) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
}

async function syncOptionRelationships(record) {
  const previous = relationships.filter(relation => relation.sourceType === 'transaction' && relation.sourceId === record.id);
  for (const relation of previous) await dbRemove('relationships', relation.id);

  if (record.instrument !== 'option' || record.groupType !== 'direct' || record.stockLinkType === 'none') return;

  const relation = {
    id: crypto.randomUUID(),
    type: record.stockLinkType,
    positionId: record.positionId,
    sourceType: 'transaction',
    sourceId: record.id,
    targetType: 'position',
    targetId: record.positionId,
    cycleId: record.cycleId || null,
    quantity: record.stockLinkType === 'coverage' ? Math.max(0, Number(record.coveredShares) || 0) : 0,
    createdAt: new Date().toISOString(),
    notes: ''
  };
  await dbPut('relationships', relation);
}

function assignmentStockAction(optionTx) {
  const isPut = String(optionTx.right || '').toLowerCase() === 'put';
  const isShort = optionTx.optionSide === 'short';
  return (isShort && isPut) || (!isShort && !isPut) ? 'buy' : 'sell';
}

async function ensureAssignmentStockEvent(optionTx, status) {
  if (!['assigned', 'exercised'].includes(status) || optionTx.instrument !== 'option') return;
  if (!optionTx.positionId || !optionTx.optionSide || optionTx.optionSide === 'unclassified') return;

  const eventType = status === 'assigned' ? 'assign' : 'exercise';
  const existing = transactions.find(tx => tx.sourceOptionTransactionId === optionTx.id && tx.eventType === eventType);
  if (existing) {
    const eventDate = optionTx.eventDate || optionTx.expiry || optionTx.date;
    if (existing.date !== eventDate) {
      existing.date = eventDate;
      await dbPut('transactions', existing);
    }
    return;
  }

  const shares = Math.max(0, Number(optionTx.quantity) || 0) * (Number(optionTx.multiplier) || 1);
  if (!shares) return;

  const stockEvent = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    date: optionTx.eventDate || optionTx.expiry || optionTx.date,
    instrument: 'stock',
    action: assignmentStockAction(optionTx),
    symbol: optionTx.symbol,
    quantity: shares,
    price: Number(optionTx.strike) || 0,
    fees: 0,
    tag: status === 'assigned' ? 'Assignment' : 'Exercise',
    notes: `Generated from option ${optionTx.id}`,
    currency: optionTx.currency || 'EUR',
    multiplier: 1,
    right: '',
    strike: 0,
    expiry: '',
    positionId: optionTx.positionId,
    status: undefined,
    groupType: 'stock',
    cycleId: null,
    lifecycleRole: null,
    optionSide: null,
    stockLinkType: null,
    coveredShares: 0,
    eventType,
    sourceOptionTransactionId: optionTx.id,
    eventDate: null
  };
  await dbPut('transactions', stockEvent);
}

function optionAttributionFactor(tx) {
  if (tx.instrument !== 'option' || tx.groupType !== 'direct') return 0;
  const links = relationships.filter(relation => relation.sourceType === 'transaction' && relation.sourceId === tx.id);
  if (links.some(relation => relation.type === 'hedge')) return 1;
  const coverage = links.find(relation => relation.type === 'coverage');
  if (!coverage) return 0;
  const contracts = Math.max(0, Number(tx.quantity) || 0);
  const multiplier = Math.max(1, Number(tx.multiplier) || 1);
  const coveredShares = Math.max(0, Number(coverage.quantity) || 0);
  return contracts > 0 ? Math.min(1, coveredShares / (contracts * multiplier)) : 0;
}

function attributedDirectOptionTransactions(optionTransactions) {
  return optionTransactions
    .filter(tx => tx.instrument === 'option')
    .map(tx => {
      const factor = optionAttributionFactor(tx);
      if (factor <= 0) return null;
      return {
        ...tx,
        quantity: Number(tx.quantity) * factor,
        fees: Number(tx.fees || 0) * factor
      };
    })
    .filter(Boolean);
}

function dbClear(storeName) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
}

function dbClearJournalData() {
  const stores = ['transactions', 'positions', 'snapshots', 'tradeGroups', 'optionCycles', 'relationships'];
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    stores.forEach(storeName => tx.objectStore(storeName).clear());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

async function loadAll() {
  try {
    transactions = (await dbGetAll('transactions')).map(normalizeTransaction);
    const rawPositions = await dbGetAll('positions');
    positions = rawPositions.map(position => normalizePosition(position, transactions.filter(tx => tx.positionId === position.id)));
    snapshots = await dbGetAll('snapshots');
    tradeGroups = await dbGetAll('tradeGroups');
    optionCycles = await dbGetAll('optionCycles');
    relationships = await dbGetAll('relationships');
    
    transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    snapshots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch (err) {
    console.error(err);
    toast("Failed to load data");
  }
}

// Navigation
document.querySelectorAll('.nav-link[data-view]').forEach(link => {
  link.addEventListener('click', (e) => {
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    e.target.classList.add('active');
    
    const view = e.target.getAttribute('data-view');
    document.querySelectorAll('.view-section').forEach(sec => sec.classList.add('hidden'));
    $(`#view-${view}`).classList.remove('hidden');
    
    if (view === 'analytics' && window.NorthstarAnalytics) {
      window.NorthstarAnalytics.renderAnalytics();
    }
  });
});

// Render Overview
function renderOverview() {
  const cashByCur = getCashByCurrency();
  const latestSnapshot = snapshots.length > 0 ? snapshots[0] : null;
  const eurUsdRate = latestEurUsdRate();
  
  const cashParts = [];
  if (cashByCur.EUR !== 0 || cashByCur.USD === 0) cashParts.push(money(cashByCur.EUR, 'EUR'));
  if (cashByCur.USD !== 0) cashParts.push(money(cashByCur.USD, 'USD'));
  $('#netCash').replaceChildren();
  cashParts.forEach((part, i) => {
    if (i > 0) $('#netCash').appendChild(document.createElement('br'));
    $('#netCash').appendChild(document.createTextNode(part));
  });
  const totalCashEur = cashByCur.EUR + toHomeSafe(cashByCur.USD, 'USD', eurUsdRate);
  $('#netCash').style.color = totalCashEur >= 0 ? 'var(--accent)' : 'var(--red)';
  $('#netCash').className = 'value';
  $('#netCash').style.fontSize = cashParts.length > 1 ? '1.5rem' : '';
  
  // Remaining capital in open positions, EUR (USD via last manual rate)
  const cap = positions
    .filter(pos => pos.status === 'open')
    .reduce((sum, pos) => {
      const txs = transactions.filter(t => t.positionId === pos.id);
      const metrics = calcPositionMetrics(pos, txs, latestSnapshot);
      let remaining = metrics.stockCost;
      metrics.openOptions.forEach(opt => {
        if (opt.action === 'buy') remaining += Math.abs(cashFlow(opt));
      });
      return sum + toHomeSafe(remaining, pos.currency || 'EUR', eurUsdRate);
    }, 0);
  $('#capitalDeployed').textContent = money(cap, 'EUR');
  
  const prem = transactions
    .filter(tx => tx.instrument === 'option')
    .reduce((sum, tx) => sum + toHomeSafe(cashFlow(tx), tx.currency || 'EUR', eurUsdRate), 0);
  $('#premiumCollected').textContent = money(prem, 'EUR');
  
  $('#activityCount').textContent = transactions.length;
  
  // Risk Lens panel
  renderRiskLens(cashByCur);
  
  // Recent activity
  const tbody = $('#recentRows');
  tbody.innerHTML = '';
  
  const recent = transactions.slice(0, 4);
  if (recent.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-inline muted">No recent activity</td></tr>';
    return;
  }
  
  recent.forEach(tx => {
    const pos = positions.find(p => p.id === tx.positionId);
    const posLabel = pos ? pos.label : '—';
    const cf = cashFlow(tx);
    const cur = tx.currency || 'EUR';
    const actionDesc = tx.fxGroupId ? 'FX EXCHANGE' : `${tx.action.toUpperCase()} ${tx.instrument}`;
    
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td');
    tdDate.textContent = dateText(tx.date);
    const tdPos = document.createElement('td');
    tdPos.textContent = posLabel;
    const tdAct = document.createElement('td');
    tdAct.textContent = actionDesc;
    const tdCash = document.createElement('td');
    tdCash.textContent = money(cf, cur);
    tdCash.style.color = cf >= 0 ? 'var(--accent)' : 'var(--red)';
    tr.append(tdDate, tdPos, tdAct, tdCash);
    tbody.appendChild(tr);
  });
}

// Calculate total market value of all open positions (stocks + options) from a snapshot
function calcPositionMarketValue(snapshot, eurUsdRate, asOfDate) {
  if (!snapshot) return 0;
  let value = 0;
  const openPos = positions.filter(p => p.status === 'open');
  
  openPos.forEach(pos => {
    const txs = transactions.filter(t => t.positionId === pos.id);
    const metrics = calcPositionMetrics(pos, txs, snapshot, asOfDate);
    const cur = pos.currency || 'EUR';
    
    let posValue = 0;
    // Stock value
    if (metrics.sharesHeld > 0 && metrics.currentPrice !== null) {
      posValue += metrics.sharesHeld * metrics.currentPrice;
    }
    
    // Open option values
    metrics.openOptions.forEach(opt => {
      const premium = snapshot.optionPrices && snapshot.optionPrices[opt.id] !== undefined
        ? snapshot.optionPrices[opt.id] : 0;
      const optValue = premium * opt.quantity * opt.multiplier;
      if (opt.action === 'buy') {
        posValue += optValue;
      } else {
        posValue -= optValue;
      }
    });
    
    // Convert to EUR
    value += toHomeSafe(posValue, cur, eurUsdRate);
  });
  
  return value;
}

function portfolioValueEur(snapshot) {
  const rate = snapshotEurUsdRate(snapshot) || latestEurUsdRate();
  const asOf = snapshot ? snapshot.timestamp.slice(0, 10) : null;
  const cash = getCashByCurrency(asOf);
  const cashEur = cash.EUR + toHomeSafe(cash.USD, 'USD', rate);
  return cashEur + calcPositionMarketValue(snapshot, rate, asOf);
}

// Populate the Risk Lens panel with XIRR, net deposits, portfolio value, total return
function renderRiskLens(cashByCur) {
  const lensContent = document.querySelector('.lens-content');
  if (!lensContent) return;
  
  const latestSnapshot = snapshots.length > 0 ? snapshots[0] : null;
  const eurUsdRate = latestEurUsdRate();
  const usdCashUnconverted = cashByCur.USD !== 0 && !eurUsdRate;
  const usdPosUnconverted = positions.some(p => p.status === 'open' && (p.currency || 'EUR') === 'USD') && !eurUsdRate;
  
  const depositsByCur = { EUR: 0, USD: 0 };
  transactions.filter(tx => tx.instrument === 'cash' && !tx.fxGroupId).forEach(tx => {
    const cur = tx.currency || 'EUR';
    depositsByCur[cur] = (depositsByCur[cur] || 0) + cashFlow(tx);
  });
  const netDepositsEur = depositsByCur.EUR + toHomeSafe(depositsByCur.USD, 'USD', eurUsdRate);
  
  const totalCashEur = cashByCur.EUR + toHomeSafe(cashByCur.USD, 'USD', eurUsdRate);
  const positionValue = calcPositionMarketValue(latestSnapshot, eurUsdRate);
  const portfolioValue = totalCashEur + positionValue;
  const canShowPortfolio = !usdCashUnconverted && !usdPosUnconverted;
  
  const hasDeposits = (depositsByCur.EUR !== 0 || depositsByCur.USD !== 0);
  const totalReturn = hasDeposits && canShowPortfolio ? portfolioValue - netDepositsEur : null;
  const totalReturnPct = totalReturn !== null && netDepositsEur !== 0 ? ((portfolioValue / netDepositsEur) - 1) * 100 : null;
  
  let xirrValue = null;
  if (window.NorthstarAnalytics && hasDeposits && canShowPortfolio) {
    xirrValue = window.NorthstarAnalytics.calculateXIRR(transactions, portfolioValue, eurUsdRate);
  }
  
  const xirrColor = xirrValue !== null ? (xirrValue >= 0 ? 'var(--accent)' : 'var(--red)') : '';
  const retColor = totalReturn !== null ? (totalReturn >= 0 ? 'var(--accent)' : 'var(--red)') : '';
  
  let retText = '—';
  if (totalReturn !== null) {
    retText = money(totalReturn, 'EUR');
    if (totalReturnPct !== null) {
      retText += ` (${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(1)}%)`;
    }
  }
  
  const rateText = eurUsdRate ? `1 EUR = ${eurUsdRate.toFixed(4)} USD` : 'not set';
  const notes = [];
  if (usdCashUnconverted || usdPosUnconverted) {
    notes.push('USD amounts are excluded from EUR totals until you save an EUR/USD rate in Update Prices.');
  }
  if (!latestSnapshot && positions.some(p => p.status === 'open')) {
    notes.push('Open positions are unmarked — click Update Prices for market value.');
  }
  
  lensContent.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'pos-metrics';
  grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
  const cells = [
    ['XIRR', xirrValue !== null ? (xirrValue * 100).toFixed(1) + '%' : '—', xirrColor],
    ['Net Deposits', money(netDepositsEur, 'EUR'), ''],
    ['Portfolio Value (EUR)', canShowPortfolio ? money(portfolioValue, 'EUR') : '—', ''],
    ['Total Return', retText, retColor]
  ];
  cells.forEach(([label, value, color]) => {
    const cell = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    if (color) strong.style.color = color;
    cell.append(span, strong);
    grid.appendChild(cell);
  });
  lensContent.appendChild(grid);
  
  const rateP = document.createElement('p');
  rateP.className = 'muted';
  rateP.style.marginTop = '12px';
  rateP.style.fontSize = '0.8rem';
  rateP.textContent = `EUR/USD: ${rateText}`;
  lensContent.appendChild(rateP);
  
  notes.forEach(text => {
    const p = document.createElement('p');
    p.className = 'muted';
    p.style.fontSize = '0.85rem';
    p.textContent = text;
    lensContent.appendChild(p);
  });
}

// Render Ledger
function renderLedger() {
  const search = $('#search').value.toLowerCase();
  const instFilter = $('#instrumentFilter').value;
  const posFilter = $('#positionFilter').value;
  
  let filtered = transactions;
  
  if (search) {
    filtered = filtered.filter(tx => {
      const pos = positions.find(p => p.id === tx.positionId);
      const hay = [
        tx.symbol,
        tx.notes,
        tx.tag,
        tx.action,
        pos && pos.label,
        tx.fxGroupId ? 'fx exchange' : ''
      ].join(' ').toLowerCase();
      return hay.includes(search);
    });
  }
  
  if (instFilter !== 'all') {
    filtered = filtered.filter(tx => tx.instrument === instFilter);
  }
  
  if (posFilter !== 'all') {
    filtered = filtered.filter(tx => tx.positionId === posFilter);
  }
  
  const tbody = $('#ledgerRows');
  tbody.innerHTML = '';
  
  if (filtered.length === 0) {
    $('#ledgerRows').parentElement.classList.add('hidden');
    $('#emptyLedger').classList.remove('hidden');
    const virgin = transactions.length === 0;
    const msg = $('#emptyLedgerText');
    if (msg) msg.textContent = virgin ? 'No transactions found.' : 'No transactions match these filters.';
    const addBtn = $('#emptyLedgerAdd') || document.querySelector('#emptyLedger .empty-add');
    if (addBtn) addBtn.classList.toggle('hidden', !virgin);
  } else {
    $('#ledgerRows').parentElement.classList.remove('hidden');
    $('#emptyLedger').classList.add('hidden');
    
    const template = $('#rowTemplate');
    filtered.forEach(tx => {
      const clone = template.content.cloneNode(true);
      
      const pos = positions.find(p => p.id === tx.positionId);
      
      clone.querySelector('.date').textContent = dateText(tx.date);
      clone.querySelector('.position-cell').textContent = pos ? pos.label : '—';
      
      const instBadge = document.createElement('span');
      instBadge.textContent = tx.instrument;
      instBadge.className = 'eyebrow';
      clone.querySelector('.instrument').appendChild(instBadge);
      
      const actionCell = clone.querySelector('.action-cell');
      actionCell.textContent = tx.action.toUpperCase();
      actionCell.style.color = (tx.action === 'buy' || tx.action === 'withdrawal') ? 'var(--red)' : 'var(--accent)';
      actionCell.style.fontWeight = 'bold';
      
      clone.querySelector('.details').textContent = details(tx);
      
      const qtyStr = tx.instrument === 'option' ? `${tx.quantity} contract(s)` :
                     (tx.instrument === 'cash' || tx.instrument === 'dividend') ? '—' : tx.quantity;
      clone.querySelector('.quantity').textContent = qtyStr;
      
      const cf = cashFlow(tx);
      const cashCell = clone.querySelector('.cash');
      cashCell.textContent = money(cf, tx.currency || 'EUR');
      cashCell.style.color = cf >= 0 ? 'var(--accent)' : 'var(--red)';
      
      const statusCell = clone.querySelector('.status-cell');
      if (tx.instrument === 'option') {
        const select = document.createElement('select');
        select.className = 'status-select';
        ['open', 'closed', 'expired', 'assigned', 'exercised'].forEach(opt => {
          const option = document.createElement('option');
          option.value = opt;
          option.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
          if (tx.status === opt) option.selected = true;
          select.appendChild(option);
        });
        select.addEventListener('change', async (e) => {
          tx.status = e.target.value;
          if (['expired', 'assigned', 'exercised'].includes(tx.status) && !tx.eventDate) {
            tx.eventDate = tx.expiry || tx.date;
          }
          await dbPut('transactions', tx);
          await ensureAssignmentStockEvent(tx, e.target.value);
          await loadAll();
          renderAll();
        });
        statusCell.appendChild(select);
      }
      
      const noteCell = clone.querySelector('.note');
      noteCell.textContent = '';
      if (tx.tag) {
        const tagEl = document.createElement('strong');
        tagEl.textContent = tx.tag;
        noteCell.appendChild(tagEl);
      }
      if (tx.notes) {
        if (tx.tag) noteCell.appendChild(document.createTextNode(' · '));
        noteCell.appendChild(document.createTextNode(tx.notes));
      }
      
      const actionsCell = clone.querySelector('.row-actions');
      
      const editBtn = document.createElement('button');
      editBtn.className = 'edit-btn';
      editBtn.innerHTML = '✎';
      editBtn.title = "Edit";
      editBtn.onclick = () => openEditDialog(tx);
      actionsCell.appendChild(editBtn);
      
      const delBtn = document.createElement('button');
      delBtn.className = 'edit-btn delete';
      delBtn.innerHTML = '×';
      delBtn.title = "Delete";
      delBtn.onclick = async () => {
        const linkedEvents = transactions.filter(item => item.sourceOptionTransactionId === tx.id);
        const extra = tx.fxGroupId ? ' This FX exchange has two legs; both will be deleted.' :
          linkedEvents.length ? ' This will also delete its generated assignment/exercise event.' : '';
        if (confirm('Delete this transaction?' + extra)) {
          if (tx.fxGroupId) {
            const pair = transactions.filter(t => t.fxGroupId === tx.fxGroupId);
            for (const leg of pair) await dbRemove('transactions', leg.id);
          } else {
            await dbRemove('transactions', tx.id);
          }
          for (const event of linkedEvents) await dbRemove('transactions', event.id);
          const linkedRelations = relationships.filter(relation => relation.sourceId === tx.id);
          for (const relation of linkedRelations) await dbRemove('relationships', relation.id);
          await loadAll();
          renderAll();
          toast('Transaction deleted');
        }
      };
      actionsCell.appendChild(delBtn);
      
      tbody.appendChild(clone);
    });
  }
  
  // Rebuild position filter
  const currentPosFilter = $('#positionFilter').value;
  $('#positionFilter').innerHTML = '<option value="all">All positions</option>';
  positions.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    if (p.id === currentPosFilter) opt.selected = true;
    $('#positionFilter').appendChild(opt);
  });
}

function calcPositionMetrics(position, txsForPosition, latestSnapshot, asOfDate) {
  const txs = [...txsForPosition]
    .filter(tx => !asOfDate || tx.date <= asOfDate)
    .sort((a, b) => {
      const byDate = String(a.date).localeCompare(String(b.date));
      if (byDate) return byDate;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });

  let sharesHeld = 0;
  let remainingStockCost = 0;
  let stockSaleProceeds = 0;
  let stockRealizedPnl = 0;
  let netPremium = 0;
  let openPremium = 0;
  let closedPremium = 0;
  let totalDividends = 0;
  const openOptions = [];

  txs.forEach(tx => {
    const cf = cashFlow(tx);
    if (tx.instrument === 'stock') {
      const qty = Number(tx.quantity) || 0;
      if (tx.action === 'buy') {
        sharesHeld += qty;
        remainingStockCost += Math.abs(cf);
      } else {
        const avg = sharesHeld > 0 ? remainingStockCost / sharesHeld : 0;
        const costRemoved = avg * qty;
        remainingStockCost = Math.max(0, remainingStockCost - costRemoved);
        sharesHeld -= qty;
        stockSaleProceeds += cf;
        stockRealizedPnl += cf - costRemoved;
      }
    } else if (tx.instrument === 'option') {
      netPremium += cf;
      if (tx.status === 'open' || (tx.instrument === 'option' && !optionTerminalEffective(tx, asOfDate))) {
        openPremium += cf;
        openOptions.push(tx);
      } else {
        closedPremium += cf;
      }
    } else if (tx.instrument === 'dividend') {
      totalDividends += cf;
    }
  });

  if (Math.abs(sharesHeld) < 1e-8) sharesHeld = 0;

  const optionPnl = calculateOptionPnl(txs, latestSnapshot, asOfDate);
  const directOptionTxs = attributedDirectOptionTransactions(txs);
  const directOptionPnl = calculateOptionPnl(directOptionTxs, latestSnapshot, asOfDate);
  const directOptionCashflow = directOptionTxs.reduce((sum, tx) => sum + cashFlow(tx), 0);
  const currentDirectIncome = directOptionCashflow + totalDividends;
  const realizedDirectIncome = directOptionPnl.realizedPnl + totalDividends;
  const effectiveEntry = sharesHeld > 0 ? (remainingStockCost - currentDirectIncome) / sharesHeld : 0;
  const effectiveEntryRealized = sharesHeld > 0 ? (remainingStockCost - realizedDirectIncome) / sharesHeld : 0;

  let currentPrice = null;
  if (latestSnapshot && latestSnapshot.stockPrices && latestSnapshot.stockPrices[position.symbol] !== undefined) {
    currentPrice = latestSnapshot.stockPrices[position.symbol];
  }

  let unrealizedPL = null;
  let stockUnrealizedPnl = null;
  if (currentPrice !== null && sharesHeld > 0) {
    stockUnrealizedPnl = (currentPrice * sharesHeld) - remainingStockCost;
    unrealizedPL = stockUnrealizedPnl + totalDividends + directOptionPnl.unrealizedPnl;
  }

  return {
    sharesHeld,
    stockCost: remainingStockCost,
    stockSaleProceeds,
    stockRealizedPnl,
    stockUnrealizedPnl,
    netPremium,
    openPremium,
    closedPremium,
    totalDividends,
    optionPnl,
    directOptionPnl,
    directOptionCashflow,
    effectiveEntry,
    effectiveEntryRealized,
    currentPrice,
    unrealizedPL,
    openOptions
  };
}

function strategyLabel(strategyType) {
  return String(strategyType || 'unclassified')
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// Render Positions
function renderPositions() {
  const statusFilter = $('#positionStatusFilter').value;
  let filtered = positions;
  
  if (statusFilter !== 'all') {
    filtered = filtered.filter(p => p.status === statusFilter);
  }
  
  const container = $('#positionCards');
  container.innerHTML = '';
  
  if (filtered.length === 0) {
    $('#emptyPositions').classList.remove('hidden');
  } else {
    $('#emptyPositions').classList.add('hidden');
    const latestSnapshot = snapshots.length > 0 ? snapshots[0] : null;
    
    filtered.forEach(pos => {
      const txs = transactions.filter(t => t.positionId === pos.id);
      const metrics = calcPositionMetrics(pos, txs, latestSnapshot);
      
      const card = document.createElement('div');
      card.className = 'panel position-card';
      
      const cur = pos.currency || 'EUR';
      const plColor = metrics.unrealizedPL >= 0 ? 'var(--accent)' : 'var(--red)';
      
      let optionsHtml = '';
      if (metrics.openOptions.length > 0) {
        optionsHtml = `<div class="pos-options">`;
        metrics.openOptions.forEach(opt => {
          optionsHtml += `
            <div class="option-row">
              <span>${opt.right.toUpperCase()} $${opt.strike} exp ${opt.expiry}</span>
              <strong>${opt.action === 'buy' ? 'Long' : 'Short'}</strong>
            </div>
          `;
        });
        optionsHtml += `</div>`;
      }

      let cyclesHtml = '';
      const cycleSummaries = metrics.optionPnl.cycles.filter(cycle => cycle.id);
      if (cycleSummaries.length > 0) {
        cyclesHtml = `<div class="pos-options"><div class="eyebrow" style="margin-bottom:8px">Option cycles</div>`;
        cycleSummaries.forEach(cycle => {
          const cycleColor = cycle.realizedPnl >= 0 ? 'var(--accent)' : 'var(--red)';
          cyclesHtml += `
            <div class="option-row">
              <button type="button" class="cycle-inspector-btn" data-cycle-id="${cycle.id}" data-position-id="${pos.id}">
                <span>${cycle.label || 'Unnamed cycle'} · ${strategyLabel(cycle.strategyType)}</span>
                <strong style="color:${cycleColor}">${money(cycle.realizedPnl, cur)} realized</strong>
              </button>
            </div>`;
        });
        cyclesHtml += `</div>`;
      }
      
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <div>
            <h3 style="font-family:var(--font-serif);font-weight:500">${pos.label}</h3>
            <span class="eyebrow">${pos.symbol}</span>
          </div>
          <span class="status-pill-${pos.status}">${pos.status.toUpperCase()}</span>
        </div>
        <div class="pos-metrics">
          <div><span>Shares</span><strong>${metrics.sharesHeld}</strong></div>
          <div><span>Remaining cost</span><strong>${money(metrics.stockCost, cur)}</strong></div>
          <div><span>Net Premium</span><strong>${money(metrics.netPremium, cur)}</strong></div>
          <div><span>Dividends</span><strong>${money(metrics.totalDividends, cur)}</strong></div>
          <div><span>Effective Entry</span><strong>${money(metrics.effectiveEntry, cur)}</strong></div>
          <div><span>Realized Entry</span><strong>${money(metrics.effectiveEntryRealized, cur)}</strong></div>
          <div><span>Direct Option P&amp;L</span><strong>${money(metrics.directOptionPnl.realizedPnl, cur)}</strong></div>
          <div><span>Current Price</span><strong>${metrics.currentPrice !== null ? money(metrics.currentPrice, cur) : '—'}</strong></div>
          <div><span>Unrealized P&L</span><strong style="color: ${plColor}">${metrics.unrealizedPL !== null ? money(metrics.unrealizedPL, cur) : '—'}</strong></div>
        </div>
        ${optionsHtml}
        ${cyclesHtml}
        <div class="pos-actions">
          <button class="quiet toggle-status-btn">Close/Reopen</button>
          <button class="quiet details-btn">Details</button>
        </div>
      `;
      
      card.querySelector('.toggle-status-btn').addEventListener('click', async () => {
        pos.status = pos.status === 'open' ? 'closed' : 'open';
        await dbPut('positions', pos);
        await loadAll();
        renderAll();
      });
      
      card.querySelector('.details-btn').addEventListener('click', () => {
        showPositionDetail(pos, metrics);
      });
      card.querySelectorAll('.cycle-inspector-btn').forEach(button => {
        button.addEventListener('click', () => showCycleDetail(button.dataset.positionId, button.dataset.cycleId));
      });
      
      container.appendChild(card);
    });
  }
}

function showPositionDetail(pos, metrics) {
  $('#posDetailTitle').textContent = pos.label;
  
  const content = $('#posDetailContent');
  const cycleDetail = metrics.optionPnl.cycles.filter(cycle => cycle.id).map(cycle => `
    <div><span>${cycle.label || 'Option cycle'} (${strategyLabel(cycle.strategyType)})</span><strong>${money(cycle.realizedPnl, pos.currency || 'EUR')} realized · ${money(cycle.unrealizedPnl, pos.currency || 'EUR')} open</strong></div>
  `).join('');
  content.innerHTML = `
    <div><span>Symbol</span><strong>${pos.symbol}</strong></div>
    <div><span>Status</span><strong>${pos.status.toUpperCase()}</strong></div>
    <div><span>Shares Held</span><strong>${metrics.sharesHeld}</strong></div>
    <div><span>Effective Entry</span><strong>${money(metrics.effectiveEntry, pos.currency || 'EUR')}</strong></div>
    <div><span>Realized Entry</span><strong>${money(metrics.effectiveEntryRealized, pos.currency || 'EUR')}</strong></div>
    <div><span>Direct Option P&amp;L</span><strong>${money(metrics.directOptionPnl.realizedPnl, pos.currency || 'EUR')}</strong></div>
    ${cycleDetail}
    <div><span>Unrealized P&L</span><strong>${metrics.unrealizedPL !== null ? money(metrics.unrealizedPL, pos.currency || 'EUR') : '—'}</strong></div>
  `;
  
  $('#positionDetailDialog').showModal();
  
  if (window.NorthstarAnalytics) {
    window.NorthstarAnalytics.renderPositionWaterfall(pos.id);
  }
}

function showCycleDetail(positionId, cycleId) {
  const pos = positions.find(item => item.id === positionId);
  const cycle = optionCycles.find(item => item.id === cycleId);
  if (!pos || !cycle) return;

  const txs = transactions
    .filter(tx => tx.positionId === positionId && tx.instrument === 'option' && tx.cycleId === cycleId)
    .sort((a, b) => {
      const orderA = a.legOrder === null ? Number.MAX_SAFE_INTEGER : a.legOrder;
      const orderB = b.legOrder === null ? Number.MAX_SAFE_INTEGER : b.legOrder;
      return orderA - orderB || String(a.date).localeCompare(String(b.date)) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
  const latestSnapshot = snapshots.length ? snapshots[0] : null;
  const pnl = calculateOptionPnl(txs, latestSnapshot).cycles.find(item => item.id === cycleId) || {
    realizedPnl: 0, unrealizedPnl: 0, openQuantity: 0, unmatchedQuantity: 0, realizedMatches: []
  };
  const currency = pos.currency || (txs[0] && txs[0].currency) || 'EUR';
  cycleDetailContext = { positionId, cycleId };
  const coverage = relationships
    .filter(relation => relation.positionId === positionId && relation.cycleId === cycleId)
    .reduce((result, relation) => {
      if (relation.type === 'coverage') result.coveredShares += Number(relation.quantity) || 0;
      if (relation.type === 'hedge') result.hedges += 1;
      return result;
    }, { coveredShares: 0, hedges: 0 });

  $('#cycleDetailTitle').textContent = cycle.label || `${pos.symbol} option cycle`;
  $('#cycleDetailSummary').innerHTML = `
    <div><span>Underlying</span><strong>${pos.symbol}</strong></div>
    <div><span>Strategy</span><strong>${strategyLabel(cycle.strategyType)}</strong></div>
    <div><span>Relationship</span><strong>${cycle.groupType || 'unclassified'}</strong></div>
    <div><span>Legs</span><strong>${txs.length}</strong></div>
    <div><span>Realized P&amp;L</span><strong>${money(pnl.realizedPnl, currency)}</strong></div>
    <div><span>Open P&amp;L</span><strong>${money(pnl.unrealizedPnl, currency)}</strong></div>
    <div><span>Open quantity</span><strong>${pnl.openQuantity}</strong></div>
    <div><span>Matched portions</span><strong>${pnl.realizedMatches.length}</strong></div>
    <div><span>Covered shares</span><strong>${coverage.coveredShares || '—'}</strong></div>
    <div><span>Hedge links</span><strong>${coverage.hedges || '—'}</strong></div>
  `;
  $('#cycleLabelEdit').value = cycle.label || '';
  $('#cycleStrategyEdit').value = cycle.strategyType || 'single-leg';

  const audit = $('#cycleRelationshipAudit');
  if (audit) {
    const warnings = [];
    const groups = [...new Set(txs.map(tx => tx.groupType || 'unclassified'))];
    if (groups.length > 1) warnings.push(`Mixed leg relationships: ${groups.join(', ')}`);
    txs.forEach(tx => {
      const links = relationships.filter(relation => relation.sourceType === 'transaction' && relation.sourceId === tx.id);
      if (tx.groupType === 'direct' && !links.length) warnings.push(`${tx.id.slice(0, 8)} has direct classification but no stock link`);
      if (tx.groupType !== 'direct' && links.length) warnings.push(`${tx.id.slice(0, 8)} has a stock link but is not classified direct`);
      const coverageLink = links.find(relation => relation.type === 'coverage');
      const maxShares = (Number(tx.quantity) || 0) * (Number(tx.multiplier) || 1);
      if (coverageLink && Number(coverageLink.quantity) > maxShares + 1e-8) {
        warnings.push(`${tx.id.slice(0, 8)} covers more shares than its contract capacity`);
      }
    });
    audit.replaceChildren();
    if (!warnings.length) {
      audit.className = 'cycle-relationship-audit is-good';
      audit.textContent = 'Relationship audit: no inconsistencies detected.';
    } else {
      audit.className = 'cycle-relationship-audit is-warning';
      const title = document.createElement('strong');
      title.textContent = 'Relationship audit';
      audit.appendChild(title);
      const list = document.createElement('ul');
      warnings.forEach(warning => {
        const item = document.createElement('li');
        item.textContent = warning;
        list.appendChild(item);
      });
      audit.appendChild(list);
    }
  }

  const rows = $('#cycleLegRows');
  rows.replaceChildren();
  txs.forEach((tx, index) => {
    const row = document.createElement('tr');
    const orderCell = document.createElement('td');
    orderCell.className = 'cycle-leg-order';
    const upButton = document.createElement('button');
    upButton.type = 'button';
    upButton.className = 'quiet cycle-leg-move';
    upButton.textContent = '↑';
    upButton.title = 'Move leg up';
    upButton.disabled = index === 0;
    upButton.addEventListener('click', () => moveCycleLeg(positionId, cycleId, index, -1));
    const downButton = document.createElement('button');
    downButton.type = 'button';
    downButton.className = 'quiet cycle-leg-move';
    downButton.textContent = '↓';
    downButton.title = 'Move leg down';
    downButton.disabled = index === txs.length - 1;
    downButton.addEventListener('click', () => moveCycleLeg(positionId, cycleId, index, 1));
    orderCell.append(index + 1, upButton, downButton);
    row.appendChild(orderCell);
    const links = relationships.filter(relation => relation.sourceType === 'transaction' && relation.sourceId === tx.id);
    const coverageLink = links.find(relation => relation.type === 'coverage');
    const relationshipText = tx.groupType || 'unclassified';
    const linkText = coverageLink
      ? `Coverage · ${Number(coverageLink.quantity) || 0} shares`
      : links.some(relation => relation.type === 'hedge') ? 'Hedge' : 'No stock link';
    const values = [
      dateText(tx.date),
      `${tx.action.toUpperCase()} · ${tx.optionSide || 'unclassified'} · ${tx.lifecycleRole || 'unclassified'}`,
      `${String(tx.right || '').toUpperCase()} ${money(tx.strike || 0, currency)} exp ${tx.expiry || '—'}`,
      `${tx.quantity} contract(s)`,
      money(cashFlow(tx), tx.currency || currency),
      tx.status || '—',
      relationshipText,
      linkText
    ];
    values.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    });
    const actionsCell = document.createElement('td');
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'quiet cycle-leg-edit';
    editButton.textContent = 'Edit';
    editButton.addEventListener('click', () => {
      $('#cycleDetailDialog').close();
      openEditDialog(tx);
    });
    actionsCell.appendChild(editButton);
    const linkButton = document.createElement('button');
    linkButton.type = 'button';
    linkButton.className = 'quiet cycle-leg-edit';
    linkButton.textContent = 'Link';
    linkButton.addEventListener('click', () => openRelationshipEditor(tx));
    actionsCell.appendChild(linkButton);
    const moveButton = document.createElement('button');
    moveButton.type = 'button';
    moveButton.className = 'quiet cycle-leg-edit';
    moveButton.textContent = 'Move';
    moveButton.addEventListener('click', () => openCycleMoveEditor(tx));
    actionsCell.appendChild(moveButton);
    row.appendChild(actionsCell);
    rows.appendChild(row);
  });
  $('#cycleDetailDialog').showModal();
  if (window.NorthstarAnalytics && window.NorthstarAnalytics.renderCyclePayoff) {
    window.NorthstarAnalytics.renderCyclePayoff(positionId, cycleId);
  }
}

function openRelationshipEditor(tx) {
  relationshipEditTxId = tx.id;
  $('#relationshipGroupType').value = tx.groupType || 'unclassified';
  $('#relationshipLinkType').value = tx.stockLinkType || 'none';
  $('#relationshipCoveredShares').value = tx.coveredShares || 0;
  updateRelationshipEditorFields();
  $('#relationshipEditDialog').showModal();
}

function openCycleMoveEditor(tx) {
  cycleMoveTxId = tx.id;
  const select = $('#cycleMoveTarget');
  select.replaceChildren();
  const none = document.createElement('option');
  none.value = '__none__';
  none.textContent = '— No cycle —';
  select.appendChild(none);
  optionCycles
    .filter(cycle => cycle.positionId === tx.positionId && String(cycle.symbol).toUpperCase() === String(tx.symbol).toUpperCase())
    .forEach(cycle => {
      const option = document.createElement('option');
      option.value = cycle.id;
      option.textContent = `${cycle.label || 'Unnamed cycle'} · ${strategyLabel(cycle.strategyType)}`;
      option.selected = cycle.id === tx.cycleId;
      select.appendChild(option);
    });
  $('#cycleMoveDialog').showModal();
}

function openAddLegForCycle() {
  if (!cycleDetailContext) return;
  const cycle = optionCycles.find(item => item.id === cycleDetailContext.cycleId);
  const position = positions.find(item => item.id === cycleDetailContext.positionId);
  if (!cycle || !position) return;
  $('#cycleDetailDialog').close();
  openAddDialog();
  $('#instrument').value = 'option';
  $('#instrument').dispatchEvent(new Event('change'));
  $('#symbol').value = position.symbol;
  $('#symbol').dispatchEvent(new Event('input'));
  buildPositionSelect(position.symbol, position.id);
  $('#positionSelect').value = position.id;
  handlePositionSelectChange();
  buildOptionCycleSelect(position.id, cycle.id);
  $('#groupType').value = cycle.groupType || 'unclassified';
  $('#groupType').dispatchEvent(new Event('change'));
}

async function saveCycleMove() {
  const tx = transactions.find(item => item.id === cycleMoveTxId);
  if (!tx) return;
  const targetId = $('#cycleMoveTarget').value;
  const nextCycleId = targetId === '__none__' ? null : targetId;
  if (nextCycleId === (tx.cycleId || null)) {
    $('#cycleMoveDialog').close();
    return;
  }
  const target = nextCycleId ? optionCycles.find(cycle => cycle.id === nextCycleId) : null;
  if (target && (target.positionId !== tx.positionId || String(target.symbol).toUpperCase() !== String(tx.symbol).toUpperCase())) {
    toast('A leg can move only to a cycle on the same position and symbol');
    return;
  }
  if (!confirm('Move this option leg to the selected cycle?')) return;
  tx.cycleId = nextCycleId;
  await dbPut('transactions', tx);
  await syncOptionRelationships(tx);
  await loadAll();
  $('#cycleMoveDialog').close();
  renderAll();
  if (cycleDetailContext) showCycleDetail(cycleDetailContext.positionId, cycleDetailContext.cycleId);
  toast('Option leg moved');
}

function updateRelationshipEditorFields() {
  const direct = $('#relationshipGroupType').value === 'direct';
  $('#relationshipLinkType').disabled = !direct;
  $('#relationshipCoveredShares').disabled = !direct || $('#relationshipLinkType').value !== 'coverage';
  if (!direct) {
    $('#relationshipLinkType').value = 'none';
    $('#relationshipCoveredShares').value = 0;
  }
}

async function saveRelationshipEdit() {
  const tx = transactions.find(item => item.id === relationshipEditTxId);
  if (!tx) return;
  const direct = $('#relationshipGroupType').value === 'direct';
  const linkType = direct ? $('#relationshipLinkType').value : 'none';
  const coveredShares = linkType === 'coverage' ? Math.max(0, Number($('#relationshipCoveredShares').value) || 0) : 0;
  const maxShares = (Number(tx.quantity) || 0) * (Number(tx.multiplier) || 1);
  if (coveredShares > maxShares + 1e-8) {
    toast(`Coverage cannot exceed ${maxShares} shares for this leg`);
    return;
  }
  tx.groupType = $('#relationshipGroupType').value;
  tx.stockLinkType = linkType;
  tx.coveredShares = coveredShares;
  await dbPut('transactions', tx);
  await syncOptionRelationships(tx);
  await loadAll();
  $('#relationshipEditDialog').close();
  renderAll();
  if (cycleDetailContext) showCycleDetail(cycleDetailContext.positionId, cycleDetailContext.cycleId);
  toast('Relationship updated');
}

async function saveCycleMetadata() {
  if (!cycleDetailContext) return;
  const cycle = optionCycles.find(item => item.id === cycleDetailContext.cycleId);
  if (!cycle) return;
  const label = $('#cycleLabelEdit').value.trim();
  if (!label) {
    toast('Cycle name is required');
    return;
  }
  cycle.label = label;
  cycle.strategyType = $('#cycleStrategyEdit').value || 'single-leg';
  await dbPut('optionCycles', cycle);
  await loadAll();
  renderAll();
  showCycleDetail(cycleDetailContext.positionId, cycleDetailContext.cycleId);
  toast('Option cycle updated');
}

async function deleteCurrentCycle() {
  if (!cycleDetailContext) return;
  const cycle = optionCycles.find(item => item.id === cycleDetailContext.cycleId);
  if (!cycle) return;
  const legCount = transactions.filter(tx => tx.instrument === 'option' && tx.cycleId === cycle.id).length;
  if (legCount > 0) {
    toast('Move or unassign all legs before deleting this cycle');
    return;
  }
  if (!confirm(`Delete empty cycle "${cycle.label || 'Unnamed cycle'}"?`)) return;
  await dbRemove('optionCycles', cycle.id);
  await loadAll();
  $('#cycleDetailDialog').close();
  renderAll();
  toast('Empty cycle deleted');
}

function openCycleMergeEditor() {
  if (!cycleDetailContext) return;
  const source = optionCycles.find(item => item.id === cycleDetailContext.cycleId);
  if (!source) return;
  const legCount = transactions.filter(tx => tx.instrument === 'option' && tx.cycleId === source.id).length;
  if (!legCount) {
    toast('This cycle is empty; delete it instead');
    return;
  }
  const select = $('#cycleMergeTarget');
  select.replaceChildren();
  optionCycles
    .filter(cycle => cycle.id !== source.id && cycle.positionId === source.positionId && String(cycle.symbol).toUpperCase() === String(source.symbol).toUpperCase())
    .forEach(cycle => {
      const option = document.createElement('option');
      option.value = cycle.id;
      option.textContent = `${cycle.label || 'Unnamed cycle'} · ${strategyLabel(cycle.strategyType)}`;
      select.appendChild(option);
    });
  if (!select.options.length) {
    toast('No compatible destination cycles exist');
    return;
  }
  $('#cycleMergeDialog').showModal();
}

async function mergeCurrentCycle() {
  if (!cycleDetailContext) return;
  const source = optionCycles.find(item => item.id === cycleDetailContext.cycleId);
  const targetId = $('#cycleMergeTarget').value;
  const target = optionCycles.find(item => item.id === targetId);
  if (!source || !target) return;
  if (source.positionId !== target.positionId || String(source.symbol).toUpperCase() !== String(target.symbol).toUpperCase()) {
    toast('Cycles must belong to the same position and symbol');
    return;
  }
  const sourceLegs = transactions.filter(tx => tx.instrument === 'option' && tx.cycleId === source.id);
  const targetLegs = transactions.filter(tx => tx.instrument === 'option' && tx.cycleId === target.id);
  if (!sourceLegs.length) {
    toast('This cycle has no legs to merge');
    return;
  }
  if (!confirm(`Merge ${sourceLegs.length} leg(s) into "${target.label || 'Unnamed cycle'}"?`)) return;
  sourceLegs.forEach((tx, index) => {
    tx.cycleId = target.id;
    tx.legOrder = targetLegs.length + index;
  });
  for (const tx of sourceLegs) {
    await dbPut('transactions', tx);
    await syncOptionRelationships(tx);
  }
  await dbRemove('optionCycles', source.id);
  await loadAll();
  $('#cycleMergeDialog').close();
  renderAll();
  showCycleDetail(target.positionId, target.id);
  toast('Option cycles merged');
}

function openCycleSplitEditor() {
  if (!cycleDetailContext) return;
  const source = optionCycles.find(item => item.id === cycleDetailContext.cycleId);
  if (!source) return;
  const legs = transactions
    .filter(tx => tx.instrument === 'option' && tx.cycleId === source.id)
    .sort((a, b) => (a.legOrder ?? Number.MAX_SAFE_INTEGER) - (b.legOrder ?? Number.MAX_SAFE_INTEGER) || String(a.date).localeCompare(String(b.date)));
  if (legs.length < 2) {
    toast('At least two legs are required to split a cycle');
    return;
  }
  const list = $('#cycleSplitLegs');
  list.replaceChildren();
  legs.forEach((tx, index) => {
    const label = document.createElement('label');
    label.className = 'cycle-split-leg';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = tx.id;
    checkbox.dataset.index = index;
    const text = document.createElement('span');
    text.textContent = `${index + 1}. ${tx.action.toUpperCase()} ${String(tx.right || '').toUpperCase()} ${tx.strike} · ${tx.quantity} contract(s) · ${tx.date}`;
    label.append(checkbox, text);
    list.appendChild(label);
  });
  $('#cycleSplitLabel').value = `${source.label || 'Option cycle'} · split`;
  $('#cycleSplitStrategy').value = 'custom';
  $('#cycleSplitDialog').showModal();
}

async function splitCurrentCycle() {
  if (!cycleDetailContext) return;
  const source = optionCycles.find(item => item.id === cycleDetailContext.cycleId);
  if (!source) return;
  const selectedIds = [...document.querySelectorAll('#cycleSplitLegs input:checked')].map(input => input.value);
  const sourceLegs = transactions.filter(tx => tx.instrument === 'option' && tx.cycleId === source.id);
  if (!selectedIds.length || selectedIds.length >= sourceLegs.length) {
    toast('Select some, but not all, legs to create a split');
    return;
  }
  const label = $('#cycleSplitLabel').value.trim();
  if (!label) {
    toast('New cycle name is required');
    return;
  }
  if (!confirm(`Move ${selectedIds.length} leg(s) into a new cycle named "${label}"?`)) return;
  const newCycle = {
    id: crypto.randomUUID(),
    positionId: source.positionId,
    groupId: source.groupId || null,
    groupType: source.groupType || 'unclassified',
    symbol: source.symbol,
    label,
    strategyType: $('#cycleSplitStrategy').value || 'custom',
    status: 'open',
    openedAt: null,
    createdAt: new Date().toISOString(),
    notes: `Split from cycle ${source.id}`
  };
  await dbPut('optionCycles', newCycle);
  const selected = sourceLegs.filter(tx => selectedIds.includes(tx.id));
  const remaining = sourceLegs.filter(tx => !selectedIds.includes(tx.id));
  selected.forEach((tx, index) => {
    tx.cycleId = newCycle.id;
    tx.legOrder = index;
  });
  remaining.forEach((tx, index) => { tx.legOrder = index; });
  for (const tx of [...selected, ...remaining]) {
    await dbPut('transactions', tx);
    if (selected.includes(tx)) await syncOptionRelationships(tx);
  }
  await loadAll();
  $('#cycleSplitDialog').close();
  renderAll();
  showCycleDetail(source.positionId, source.id);
  toast('Option cycle split');
}

async function moveCycleLeg(positionId, cycleId, index, direction) {
  const cycleTxs = transactions
    .filter(tx => tx.positionId === positionId && tx.instrument === 'option' && tx.cycleId === cycleId)
    .sort((a, b) => {
      const orderA = a.legOrder === null ? Number.MAX_SAFE_INTEGER : a.legOrder;
      const orderB = b.legOrder === null ? Number.MAX_SAFE_INTEGER : b.legOrder;
      return orderA - orderB || String(a.date).localeCompare(String(b.date)) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= cycleTxs.length) return;
  [cycleTxs[index], cycleTxs[targetIndex]] = [cycleTxs[targetIndex], cycleTxs[index]];
  for (let i = 0; i < cycleTxs.length; i += 1) {
    cycleTxs[i].legOrder = i;
    await dbPut('transactions', cycleTxs[i]);
  }
  await loadAll();
  renderAll();
  showCycleDetail(positionId, cycleId);
}

$('#closePositionDetail').addEventListener('click', () => $('#positionDetailDialog').close());
$('#closePositionDetail2').addEventListener('click', () => $('#positionDetailDialog').close());
$('#closeCycleDetail').addEventListener('click', () => $('#cycleDetailDialog').close());
$('#closeCycleDetail2').addEventListener('click', () => $('#cycleDetailDialog').close());
$('#saveCycleMetadata').addEventListener('click', saveCycleMetadata);
$('#deleteCycle').addEventListener('click', deleteCurrentCycle);
$('#mergeCycle').addEventListener('click', openCycleMergeEditor);
$('#saveCycleMerge').addEventListener('click', mergeCurrentCycle);
$('#closeCycleMerge').addEventListener('click', () => $('#cycleMergeDialog').close());
$('#cancelCycleMerge').addEventListener('click', () => $('#cycleMergeDialog').close());
$('#splitCycle').addEventListener('click', openCycleSplitEditor);
$('#addCycleLeg').addEventListener('click', openAddLegForCycle);
$('#saveCycleSplit').addEventListener('click', splitCurrentCycle);
$('#closeCycleSplit').addEventListener('click', () => $('#cycleSplitDialog').close());
$('#cancelCycleSplit').addEventListener('click', () => $('#cycleSplitDialog').close());
$('#relationshipGroupType').addEventListener('change', updateRelationshipEditorFields);
$('#relationshipLinkType').addEventListener('change', updateRelationshipEditorFields);
$('#saveRelationshipEdit').addEventListener('click', saveRelationshipEdit);
$('#closeRelationshipEdit').addEventListener('click', () => $('#relationshipEditDialog').close());
$('#cancelRelationshipEdit').addEventListener('click', () => $('#relationshipEditDialog').close());
$('#saveCycleMove').addEventListener('click', saveCycleMove);
$('#closeCycleMove').addEventListener('click', () => $('#cycleMoveDialog').close());
$('#cancelCycleMove').addEventListener('click', () => $('#cycleMoveDialog').close());

function closeWipeDialogs() {
  ['userOptionsDialog', 'advancedOptionsDialog', 'wipeFirstDialog', 'wipeFinalDialog'].forEach(id => {
    const dialog = $(`#${id}`);
    if (dialog.open) dialog.close();
  });
}

$('#userMenuBtn').addEventListener('click', () => $('#userOptionsDialog').showModal());
$('#closeUserOptions').addEventListener('click', () => $('#userOptionsDialog').close());
$('#openAdvancedOptions').addEventListener('click', () => {
  $('#userOptionsDialog').close();
  $('#advancedOptionsDialog').showModal();
});
$('#closeAdvancedOptions').addEventListener('click', () => $('#advancedOptionsDialog').close());
$('#startDataWipe').addEventListener('click', () => {
  $('#advancedOptionsDialog').close();
  $('#wipeFirstDialog').showModal();
});
['cancelWipeFirst', 'cancelWipeFirst2'].forEach(id => {
  $(`#${id}`).addEventListener('click', () => $('#wipeFirstDialog').close());
});
$('#continueWipe').addEventListener('click', () => {
  $('#wipeFirstDialog').close();
  $('#wipeConfirmationText').value = '';
  $('#confirmDataWipe').disabled = true;
  $('#wipeFinalDialog').showModal();
});
['cancelWipeFinal', 'cancelWipeFinal2'].forEach(id => {
  $(`#${id}`).addEventListener('click', () => $('#wipeFinalDialog').close());
});
$('#wipeConfirmationText').addEventListener('input', event => {
  $('#confirmDataWipe').disabled = event.target.value.trim().toUpperCase() !== 'WIPE';
});
$('#confirmDataWipe').addEventListener('click', async () => {
  if ($('#wipeConfirmationText').value.trim().toUpperCase() !== 'WIPE') return;
  const button = $('#confirmDataWipe');
  button.disabled = true;
  try {
    await dbClearJournalData();
    editingTxId = null;
    cycleDetailContext = null;
    relationshipEditTxId = null;
    cycleMoveTxId = null;
    await loadAll();
    renderAll();
    closeWipeDialogs();
    toast('All manual journal data has been wiped');
  } catch (err) {
    console.error(err);
    button.disabled = false;
    toast('Data wipeout failed');
  }
});

function renderAll() {
  renderOverview();
  renderLedger();
  renderPositions();
  const analyticsView = $('#view-analytics');
  if (analyticsView && !analyticsView.classList.contains('hidden') && window.NorthstarAnalytics) {
    window.NorthstarAnalytics.renderAnalytics();
  }
}

$('#search').addEventListener('input', renderLedger);
$('#instrumentFilter').addEventListener('change', renderLedger);
$('#positionFilter').addEventListener('change', renderLedger);
$('#positionStatusFilter').addEventListener('change', renderPositions);

// Dialog Handling
function buildPositionSelect(symbolStr, selectedId = null) {
  const select = $('#positionSelect');
  select.innerHTML = '<option value="__new__">— New position —</option>';
  
  const sym = symbolStr.trim().toUpperCase();
  if (sym) {
    const matching = positions.filter(p => p.symbol === sym && p.status === 'open');
    matching.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      select.appendChild(opt);
    });
  }
  
  if (selectedId) {
    select.value = selectedId;
  }
  
  handlePositionSelectChange();
}

function buildOptionCycleSelect(positionId, selectedId = null) {
  const select = $('#optionCycleSelect');
  if (!select) return;
  const previousValue = select.value;
  select.innerHTML = '<option value="__none__">— No cycle —</option><option value="__new__">＋ New cycle —</option>';
  optionCycles
    .filter(cycle => cycle.positionId === positionId)
    .sort((a, b) => String(a.openedAt || a.createdAt || '').localeCompare(String(b.openedAt || b.createdAt || '')))
    .forEach(cycle => {
      const option = document.createElement('option');
      option.value = cycle.id;
      option.textContent = cycle.label || `${cycle.symbol || ''} cycle`;
      select.appendChild(option);
    });
  const preferredValue = selectedId || previousValue;
  select.value = [...select.options].some(option => option.value === preferredValue) ? preferredValue : '__none__';
  handleOptionCycleSelectChange();
}

function handleOptionCycleSelectChange() {
  const select = $('#optionCycleSelect');
  const labelGroup = $('#optionCycleLabelGroup');
  const strategyGroup = $('#optionStrategyTypeGroup');
  if (!select || !labelGroup || !strategyGroup) return;
  const isNew = select.value === '__new__';
  labelGroup.classList.toggle('hidden', !isNew);
  strategyGroup.classList.toggle('hidden', !isNew);
  if (!isNew && select.value !== '__none__') {
    const cycle = optionCycles.find(item => item.id === select.value);
    if (cycle && cycle.strategyType) $('#optionStrategyType').value = cycle.strategyType;
  }
}

function updateStockLinkFields() {
  const isOption = $('#instrument').value === 'option';
  const isDirect = isOption && $('#groupType').value === 'direct';
  const linkType = $('#stockLinkType').value;
  $('#stockLinkTypeGroup').classList.toggle('hidden', !isDirect);
  $('#coveredSharesGroup').classList.toggle('hidden', !isDirect || linkType !== 'coverage');
}

function handlePositionSelectChange() {
  const val = $('#positionSelect').value;
  const grp = $('#positionLabelGroup');
  if (val === '__new__') {
    grp.classList.remove('hidden');
    
    // Auto-generate label
    const sym = $('#symbol').value.trim().toUpperCase();
    if (sym) {
      const count = positions.filter(p => p.symbol === sym).length;
      $('#positionLabel').value = `${sym} #${count + 1}`;
    }
  } else {
    grp.classList.add('hidden');
  }
  if ($('#instrument').value === 'option') {
    buildOptionCycleSelect(val === '__new__' ? null : val);
  }
}

$('#symbol').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
  buildPositionSelect(e.target.value);
});
$('#positionSelect').addEventListener('change', handlePositionSelectChange);
$('#optionCycleSelect').addEventListener('change', handleOptionCycleSelectChange);
$('#groupType').addEventListener('change', updateStockLinkFields);
$('#stockLinkType').addEventListener('change', updateStockLinkFields);

function recalcPreview() {
  const qty = parseFloat($('#quantity').value) || 0;
  const price = parseFloat($('#price').value) || 0;
  const fees = parseFloat($('#fees').value) || 0;
  const inst = $('#instrument').value;
  const act = $('#action').value;
  const mult = parseFloat($('#multiplier').value) || 100;
  
  const gross = qty * price * (inst === 'option' ? mult : 1);
  const cf = act === 'buy' ? -(gross + fees) : (gross - fees);
  
  const prev = $('#cashPreview');
  const cur = $('#currency') ? $('#currency').value : 'EUR';
  prev.textContent = money(cf, cur);
  prev.style.color = cf >= 0 ? 'var(--accent)' : 'var(--red)';
}

['action', 'quantity', 'price', 'fees', 'multiplier', 'instrument', 'currency'].forEach(id => {
  $(`#${id}`).addEventListener('input', recalcPreview);
});

$('#instrument').addEventListener('change', (e) => {
  const inst = e.target.value;
  
  // Option fields: only for options
  $('#optionFields').classList.toggle('hidden', inst !== 'option');
  if (inst !== 'option') {
    $('#optionCycleLabelGroup').classList.add('hidden');
    $('#optionStrategyTypeGroup').classList.add('hidden');
  } else if (!editingTxId) {
    $('#optionCycleSelect').value = '__new__';
    handleOptionCycleSelectChange();
  }
  updateStockLinkFields();
  
  // Action dropdown: update options based on instrument
  const actionSelect = $('#action');
  actionSelect.innerHTML = '';
  if (inst === 'cash') {
    actionSelect.innerHTML = '<option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option>';
  } else if (inst === 'dividend') {
    actionSelect.innerHTML = '<option value="receive">Receive</option>';
  } else {
    actionSelect.innerHTML = '<option value="buy">Buy</option><option value="sell">Sell</option>';
  }
  
  // Symbol field: hide for cash, show for others
  const symbolField = $('#symbol').closest('.field');
  if (inst === 'cash') {
    symbolField.classList.add('hidden');
    $('#symbol').value = 'CASH';
    $('#symbol').removeAttribute('required');
  } else {
    symbolField.classList.remove('hidden');
    if ($('#symbol').value === 'CASH') $('#symbol').value = '';
    $('#symbol').setAttribute('required', '');
  }
  
  // Quantity field: hide for cash and dividend (auto = 1)
  const qtyField = $('#quantity').closest('.field');
  if (inst === 'cash' || inst === 'dividend') {
    qtyField.classList.add('hidden');
    $('#quantity').value = 1;
  } else {
    qtyField.classList.remove('hidden');
  }
  
  // Price label: "Amount" for cash/dividend, "Price" for stock/option
  const priceLabel = document.querySelector('label[for="price"]');
  priceLabel.textContent = (inst === 'cash' || inst === 'dividend') ? 'Amount' : 'Price';
  
  // Position selector: hide for cash, show for others
  const posField = $('#positionSelect').closest('.field');
  const posLabelField = $('#positionLabelGroup');
  if (inst === 'cash') {
    posField.classList.add('hidden');
    posLabelField.classList.add('hidden');
  } else {
    posField.classList.remove('hidden');
    buildPositionSelect($('#symbol').value);
  }
  
  recalcPreview();
});

function openAddDialog() {
  editingTxId = null;
  $('#dialogHeading').textContent = 'Add Record';
  $('#saveBtn').textContent = 'Save';
  $('#transactionForm').reset();
  $('#date').value = new Date().toISOString().split('T')[0];
  $('#multiplier').value = 100;
  $('#quantity').value = 1;
  $('#optionSide').value = 'long';
  $('#lifecycleRole').value = 'open';
  $('#groupType').value = 'unclassified';
  $('#stockLinkType').value = 'none';
  $('#coveredShares').value = 0;
  $('#optionCycleLabel').value = '';
  $('#optionStrategyType').value = 'single-leg';
  // Reset instrument to stock and trigger change to restore all field states
  $('#instrument').value = 'stock';
  $('#currency').value = 'EUR';
  $('#instrument').dispatchEvent(new Event('change'));
  buildPositionSelect('');
  $('#transactionDialog').showModal();
}

function openEditDialog(tx) {
  editingTxId = tx.id;
  $('#dialogHeading').textContent = 'Edit Record';
  $('#saveBtn').textContent = 'Update';
  
  $('#date').value = tx.date;
  $('#instrument').value = tx.instrument;
  $('#action').value = tx.action;
  $('#symbol').value = tx.symbol;
  $('#quantity').value = tx.quantity;
  $('#price').value = tx.price;
  $('#fees').value = tx.fees;
  $('#tag').value = tx.tag || '';
  $('#notes').value = tx.notes || '';
  $('#currency').value = tx.currency || 'EUR';
  
  if (tx.instrument === 'option') {
    $('#right').value = tx.right;
    $('#strike').value = tx.strike;
    $('#expiry').value = tx.expiry;
    $('#optionEventDate').value = tx.eventDate || '';
    $('#multiplier').value = tx.multiplier;
    $('#optionSide').value = tx.optionSide || 'unclassified';
    $('#lifecycleRole').value = tx.lifecycleRole || 'unclassified';
    $('#groupType').value = tx.groupType || 'unclassified';
    $('#stockLinkType').value = tx.stockLinkType || 'none';
    $('#coveredShares').value = tx.coveredShares || 0;
  }
  
  // Trigger change to set up form fields for this instrument type
  $('#instrument').dispatchEvent(new Event('change'));
  // For non-cash instruments, restore the action value after the change handler reset it
  if (tx.instrument !== 'cash' && tx.instrument !== 'dividend') {
    $('#action').value = tx.action;
  }
  if (tx.instrument !== 'cash') {
    buildPositionSelect(tx.symbol, tx.positionId);
  }
  if (tx.instrument === 'option') {
    buildOptionCycleSelect(tx.positionId, tx.cycleId);
    const cycle = optionCycles.find(item => item.id === tx.cycleId);
    if (cycle && cycle.strategyType) $('#optionStrategyType').value = cycle.strategyType;
  }
  updateStockLinkFields();
  
  $('#transactionDialog').showModal();
}

$('#newTransaction').addEventListener('click', openAddDialog);
document.querySelectorAll('.empty-add').forEach(btn => btn.addEventListener('click', openAddDialog));

$('#closeDialog').addEventListener('click', () => $('#transactionDialog').close());
$('#cancelDialog').addEventListener('click', () => $('#transactionDialog').close());

$('#transactionForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const record = {
    date: $('#date').value,
    instrument: $('#instrument').value,
    action: $('#action').value,
    symbol: $('#symbol').value.toUpperCase(),
    quantity: parseFloat($('#quantity').value),
    price: parseFloat($('#price').value),
    fees: parseFloat($('#fees').value) || 0,
    tag: $('#tag').value,
    notes: $('#notes').value,
    currency: $('#currency').value || 'EUR'
  };
  
  if (record.instrument === 'option') {
    record.right = $('#right').value;
    record.strike = parseFloat($('#strike').value);
    record.expiry = $('#expiry').value;
    record.eventDate = $('#optionEventDate').value || null;
    record.multiplier = parseFloat($('#multiplier').value);
    record.optionSide = $('#optionSide').value;
    record.lifecycleRole = $('#lifecycleRole').value;
    record.groupType = $('#groupType').value;
    record.stockLinkType = $('#stockLinkType').value;
    record.coveredShares = parseFloat($('#coveredShares').value) || 0;
  } else {
    record.right = "";
    record.strike = 0;
    record.expiry = "";
    record.multiplier = 1;
    record.optionSide = null;
    record.lifecycleRole = null;
    record.groupType = record.instrument === 'stock' ? 'stock' : 'portfolio';
    record.stockLinkType = null;
    record.coveredShares = 0;
    record.eventDate = null;
  }
  
  // Position handling — cash has no position
  if (record.instrument === 'cash') {
    record.positionId = '';
  } else {
    const posSelect = $('#positionSelect').value;
    if (posSelect === '__new__') {
      const pos = {
        id: crypto.randomUUID(),
        symbol: record.symbol,
        label: $('#positionLabel').value.trim() || `${record.symbol} #1`,
        status: 'open',
        positionDate: record.date,
        currency: record.currency || 'EUR',
        createdAt: new Date().toISOString(),
        notes: ''
      };
      await dbPut('positions', pos);
      record.positionId = pos.id;
    } else {
      record.positionId = posSelect;
    }
  }

  if (record.instrument === 'option') {
    const cycleChoice = $('#optionCycleSelect').value;
    const existingCycle = optionCycles.find(cycle => cycle.id === cycleChoice);
    if (existingCycle && (existingCycle.positionId !== record.positionId || String(existingCycle.symbol).toUpperCase() !== record.symbol)) {
      toast('This option cycle belongs to another position or symbol.');
      return;
    }
    if (cycleChoice === '__new__') {
      const cycle = {
        id: crypto.randomUUID(),
        positionId: record.positionId,
        groupId: null,
        groupType: record.groupType,
        symbol: record.symbol,
        label: $('#optionCycleLabel').value.trim() || `${record.symbol} option cycle`,
        strategyType: $('#optionStrategyType').value || 'single-leg',
        status: 'open',
        openedAt: record.lifecycleRole === 'open' ? record.date : null,
        createdAt: new Date().toISOString(),
        notes: ''
      };
      await dbPut('optionCycles', cycle);
      record.cycleId = cycle.id;
    } else if (cycleChoice === '__none__') {
      record.cycleId = null;
    } else {
      record.cycleId = cycleChoice;
    }
  }
  
  if (editingTxId) {
    const existing = transactions.find(t => t.id === editingTxId);
    record.id = existing.id;
    record.createdAt = existing.createdAt;
    record.status = existing.status;
    if (record.instrument !== 'option') {
      record.groupType = record.instrument === 'stock' ? 'stock' : 'portfolio';
      record.cycleId = null;
      record.lifecycleRole = null;
      record.optionSide = null;
      record.stockLinkType = null;
      record.coveredShares = 0;
    }
  } else {
    record.id = crypto.randomUUID();
    record.createdAt = new Date().toISOString();
    record.status = record.instrument === 'option' ? 'open' : undefined;
    record.groupType = record.groupType || (record.instrument === 'option' ? 'unclassified' : record.instrument === 'stock' ? 'stock' : 'portfolio');
    record.cycleId = record.cycleId || null;
    record.lifecycleRole = record.lifecycleRole || (record.instrument === 'option' ? 'unclassified' : null);
    record.optionSide = record.optionSide || (record.instrument === 'option' ? 'unclassified' : null);
  }
  
  await dbPut('transactions', record);
  await syncOptionRelationships(record);
  await loadAll();
  renderAll();
  
  $('#transactionDialog').close();
  toast(editingTxId ? 'Record updated' : 'Record added');
});

// Snapshot Logic
$('#snapshotBtn').addEventListener('click', () => {
  const fieldsContainer = $('#snapshotFields');
  fieldsContainer.innerHTML = '';
  
  const openPositions = positions.filter(p => p.status === 'open');
  const symbols = [...new Set(openPositions.map(p => p.symbol))];
  
  const latestSnapshot = snapshots.length > 0 ? snapshots[0] : null;
  const lastRate = latestEurUsdRate() || '';
  
  const rateGroup = document.createElement('div');
  rateGroup.className = 'snapshot-symbol-group';
  rateGroup.innerHTML = `
    <h3>Exchange Rate</h3>
    <div class="snapshot-row">
      <label>EUR/USD (1 EUR = ? USD)</label>
      <input type="number" step="0.0001" min="0" data-type="rate" data-pair="EURUSD" value="${lastRate}" placeholder="1.0850">
    </div>
  `;
  fieldsContainer.appendChild(rateGroup);
  
  symbols.forEach(sym => {
    const group = document.createElement('div');
    group.className = 'snapshot-symbol-group';
    
    group.innerHTML = `<h3>${sym} — Stock Price</h3>`;
    
    const stockRow = document.createElement('div');
    stockRow.className = 'snapshot-row';
    const lastStockPrice = latestSnapshot && latestSnapshot.stockPrices && latestSnapshot.stockPrices[sym] !== undefined ? latestSnapshot.stockPrices[sym] : '';
    stockRow.innerHTML = `
      <label>Stock price</label>
      <input type="number" step="0.01" min="0" data-type="stock" data-symbol="${sym}" value="${lastStockPrice}" required>
    `;
    group.appendChild(stockRow);
    
    const posIds = openPositions.filter(p => p.symbol === sym).map(p => p.id);
    const openOpts = transactions.filter(t => posIds.includes(t.positionId) && t.instrument === 'option' && t.status === 'open');
    
    openOpts.forEach(opt => {
      const optRow = document.createElement('div');
      optRow.className = 'snapshot-row';
      const lastOptPrice = latestSnapshot && latestSnapshot.optionPrices && latestSnapshot.optionPrices[opt.id] !== undefined ? latestSnapshot.optionPrices[opt.id] : '';
      optRow.innerHTML = `
        <label>${opt.right.toUpperCase()} $${opt.strike} exp ${opt.expiry}</label>
        <input type="number" step="0.01" min="0" data-type="option" data-id="${opt.id}" value="${lastOptPrice}" required>
      `;
      group.appendChild(optRow);
    });
    
    fieldsContainer.appendChild(group);
  });
  
  $('#snapshotForm').querySelector('button[type="submit"]').disabled = false;
  if (symbols.length === 0) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'No open positions. You can still save an EUR/USD rate to convert USD cash into EUR totals.';
    fieldsContainer.appendChild(note);
  }
  
  $('#snapshotDialog').showModal();
});

$('#closeSnapshot').addEventListener('click', () => $('#snapshotDialog').close());
$('#cancelSnapshot').addEventListener('click', () => $('#snapshotDialog').close());

$('#snapshotForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const snap = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    stockPrices: {},
    optionPrices: {}
  };
  
  snap.exchangeRates = {};
  
  document.querySelectorAll('#snapshotFields input').forEach(input => {
    const val = parseFloat(input.value) || 0;
    if (input.dataset.type === 'stock') {
      snap.stockPrices[input.dataset.symbol] = val;
    } else if (input.dataset.type === 'rate') {
      if (val > 0) snap.exchangeRates[input.dataset.pair] = val;
    } else if (input.dataset.type === 'option') {
      snap.optionPrices[input.dataset.id] = val;
    }
  });
  
  if (!snap.exchangeRates.EURUSD) {
    const prev = latestEurUsdRate();
    if (prev) snap.exchangeRates.EURUSD = prev;
  }
  
  await dbPut('snapshots', snap);
  await loadAll();
  renderAll();
  $('#snapshotDialog').close();
  toast('Prices updated');
});

// Export / Import
$('#exportBtn').addEventListener('click', () => {
  const data = {
    format: 'northstar-journal',
    version: 4,
    exportedAt: new Date().toISOString(),
    transactions,
    positions,
    snapshots,
    tradeGroups,
    optionCycles,
    relationships
  };
  
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `northstar-export-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('#importInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const data = JSON.parse(event.target.result);
      if (data.format !== 'northstar-journal') {
        throw new Error("Invalid format");
      }
      
      const v = data.version || 1;
      const replace = confirm('Replace all current data with this file?\n\nOK = replace\nCancel = merge (may duplicate records)');
      if (replace) {
        await dbClear('transactions');
        await dbClear('positions');
        await dbClear('snapshots');
        await dbClear('tradeGroups');
        await dbClear('optionCycles');
        await dbClear('relationships');
      }
      
      if (v === 1) {
        for (const tx of data.transactions) {
          tx.positionId = "";
          if (tx.instrument === 'option') tx.status = 'open';
          await dbPut('transactions', normalizeTransaction(tx));
        }
      } else {
        if (data.positions) {
          for (const p of data.positions) await dbPut('positions', p);
        }
        if (data.snapshots) {
          for (const s of data.snapshots) await dbPut('snapshots', s);
        }
        if (data.transactions) {
          for (const t of data.transactions) await dbPut('transactions', normalizeTransaction(t));
        }
        if (data.tradeGroups) {
          for (const group of data.tradeGroups) await dbPut('tradeGroups', group);
        }
        if (data.optionCycles) {
          for (const cycle of data.optionCycles) await dbPut('optionCycles', cycle);
        }
        if (data.relationships) {
          for (const relation of data.relationships) await dbPut('relationships', relation);
        }
      }
      
      await loadAll();
      renderAll();
      toast('Import successful');
    } catch (err) {
      console.error(err);
      toast('Import failed');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
});

// FX Exchange Dialog
$('#fxBtn').addEventListener('click', () => {
  $('#fxForm').reset();
  $('#fxDate').value = new Date().toISOString().split('T')[0];
  $('#fxFromCurrency').value = 'EUR';
  $('#fxToCurrency').value = 'USD';
  updateFxRate();
  $('#fxDialog').showModal();
});

function updateFxRate() {
  const fromAmt = parseFloat($('#fxFromAmount').value) || 0;
  const toAmt = parseFloat($('#fxToAmount').value) || 0;
  const fromCur = $('#fxFromCurrency').value;
  const toCur = $('#fxToCurrency').value;
  
  if (fromAmt > 0 && toAmt > 0 && fromCur !== toCur) {
    const rate = toAmt / fromAmt;
    $('#fxRateDisplay').textContent = `Rate: 1 ${fromCur} = ${rate.toFixed(4)} ${toCur}`;
  } else {
    $('#fxRateDisplay').textContent = 'Rate: \u2014';
  }
}

['fxFromAmount', 'fxToAmount', 'fxFromCurrency', 'fxToCurrency'].forEach(id => {
  $(`#${id}`).addEventListener('input', updateFxRate);
  $(`#${id}`).addEventListener('change', updateFxRate);
});

$('#fxForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const fromCur = $('#fxFromCurrency').value;
  const toCur = $('#fxToCurrency').value;
  
  if (fromCur === toCur) {
    toast('Currencies must be different');
    return;
  }
  
  const fxGroupId = crypto.randomUUID();
  const date = $('#fxDate').value;
  const fromAmt = parseFloat($('#fxFromAmount').value);
  const toAmt = parseFloat($('#fxToAmount').value);
  const notes = $('#fxNotes').value || `FX ${fromCur}\u2192${toCur} @${(toAmt / fromAmt).toFixed(4)}`;
  
  // Withdrawal from source currency
  const withdrawal = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    date,
    instrument: 'cash',
    action: 'withdrawal',
    symbol: 'CASH',
    quantity: 1,
    price: fromAmt,
    fees: 0,
    tag: 'FX Exchange',
    notes,
    multiplier: 1,
    right: '',
    strike: 0,
    expiry: '',
    positionId: '',
    status: 'open',
    currency: fromCur,
    fxGroupId
  };
  
  // Deposit to target currency
  const deposit = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    date,
    instrument: 'cash',
    action: 'deposit',
    symbol: 'CASH',
    quantity: 1,
    price: toAmt,
    fees: 0,
    tag: 'FX Exchange',
    notes,
    multiplier: 1,
    right: '',
    strike: 0,
    expiry: '',
    positionId: '',
    status: 'open',
    currency: toCur,
    fxGroupId
  };
  
  await dbPut('transactions', withdrawal);
  await dbPut('transactions', deposit);
  
  await loadAll();
  renderAll();
  $('#fxDialog').close();
  toast(`Exchanged ${money(fromAmt, fromCur)} \u2192 ${money(toAmt, toCur)}`);
});

$('#closeFx').addEventListener('click', () => $('#fxDialog').close());
$('#cancelFx').addEventListener('click', () => $('#fxDialog').close());

// Initialization
window.NorthstarApp = {
  getState: () => ({ transactions, positions, snapshots, tradeGroups, optionCycles, relationships }),
  cashFlow,
  money,
  dateText,
  toHome,
  toHomeSafe,
  latestEurUsdRate,
  snapshotEurUsdRate,
  getCashByCurrency,
  calcPositionMetrics,
  calculateOptionPnl,
  showCycleDetail,
  calcPositionMarketValue,
  portfolioValueEur
};

async function init() {
  try {
    $('#date').value = new Date().toISOString().split('T')[0];
    await loadAll();
    renderAll();
  } catch (err) {
    console.error('Initialization failed:', err);
    toast('Could not open local storage.');
  }
}

// Handle both cases: script loaded before or after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

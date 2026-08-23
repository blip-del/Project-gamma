# Project State
Last updated: 2026-08-20

## Current status
Northstar Trading Journal — local-first ledger with:
- Stock, option, cash, dividend, plus paired FX exchange legs
- EUR home totals: USD cash and USD positions convert with the last manual EUR/USD rate from Update Prices
- FX Exchange records how much of one currency became the other; Update Prices is only for marks and the conversion rate
- Remaining average cost after partial stock sales
- Charts and Risk Lens portfolio value in EUR
- Analytics chart picker (on/off, remembered in the browser) plus allocation, P&L, dividends, cash flow, activity, expiries
- Phase 1 relationship foundation: IndexedDB v3 now includes trade groups, option cycles, and generic relationships; transactions carry future classification/lifecycle fields and positions carry a position date
- Version 3 backups preserve transactions, positions, snapshots, trade groups, option cycles, and relationships
- Phase 2 option lifecycle support: long/short and open/close fields, cycle selection/creation, direct/indirect classification, partial lifecycle matching, realized/unrealized option P&L, and realized versus current adjusted entry
- Phase 3 relationship support: direct coverage or hedge links, prorated direct attribution for partial coverage, and generated assignment/exercise stock events linked to their source option transaction; assignment/exercise can use a separate event date
- Multi-leg strategy support: named option cycles for single legs, vertical spreads, iron condors, iron butterflies, and custom strategies; cycle-level realized/open P&L summaries are visible on position cards and details
- Analysis scope controls: grouped position scope matrix with stock, dividends, direct options, indirect options, unclassified options, and individual cycle toggles; positions start collapsed, closed positions have a separate collapsed section, and scope/collapse preferences are persisted in browser preferences
- Scoped portfolio history: the portfolio value chart now recalculates historical cash and marked position value from the selected scope; official account snapshots and XIRR remain unchanged
- Option cycle inspector: strategy metadata, leg-by-leg lifecycle and cash-flow table, matched portions, realized/open P&L, and coverage/hedge links are available from position and scope views
- Cycle leg management: cycle legs can be reordered for presentation and edited directly from the inspector; transaction dates still control lifecycle matching and P&L chronology
- Cycle metadata editing: cycle names and strategy labels can be updated from the inspector without rewriting any option legs
- Relationship audit: cycle details now flag mixed direct/indirect legs, missing stock links, classification conflicts, and over-coverage without changing data automatically
- Cycle leg relationship visibility: each leg now displays its direct/indirect classification and coverage/hedge link state in the inspector table
- Controlled relationship editing: a leg can update only its direct/indirect classification and coverage/hedge fields, with capacity validation before saving
- Data integrity audit: Analytics includes read-only checks for orphaned positions, cycles, relationships, generated events, stale cycle references, and invalid coverage
- Regression checklist: complex stock, option, assignment, relationship, cycle, scope, backup, and scale scenarios are documented in REGRESSION_CHECKLIST.md
- User advanced options: a two-step Data wipeout clears all locally stored manual journal records, positions, snapshots, groups, cycles, and relationships after typing WIPE; display preferences remain intact
- Safe cycle reassignment: individual option legs can move between compatible same-position/symbol cycles with confirmation; relationship records are synchronized
- Safe cycle deletion: only empty cycles can be deleted, with confirmation; cycles containing legs are protected
- Controlled cycle merge: all legs can be moved into a compatible same-position/symbol cycle with confirmation, relationship synchronization, and source-cycle cleanup
- Controlled cycle split: selected legs can move into a newly named cycle while the remaining source legs and their ordering are preserved
- Cycle leg entry shortcut: the inspector can open a new option record with the current position, symbol, relationship group, and cycle preselected
- Strategy visualization: cycle inspector includes sampled expiration payoff, break-even estimates, bounded/unbounded risk classification, and guaranteed bounds where mathematically available; allocation and unrealized charts now follow selected analysis scope

## Known issues
- No live quotes — prices and EUR/USD are manual
- Expiration is still represented by the option status rather than a separate journal event, but its lifecycle event date now controls historical option matching
- Snapshot FX rate is applied to historical EUR totals (not each past FX trade's own rate)
- Multi-leg bulk add/remove convenience beyond the guided add-leg flow is not implemented yet
- Automated/browser regression execution is not yet available in this environment; the checklist currently requires manual verification

// battery-bank-card.js
// Custom Lovelace card — multi-battery status with power averaging and projections

const VERSION = '1.0.0';

console.info(
  `%c Battery Bank Card %c ${VERSION} `,
  'background-color:#555;color:#fff;padding:3px 2px 3px 3px;border-radius:14px 0 0 14px;font-family:DejaVu Sans,Verdana,Geneva,sans-serif;text-shadow:0 1px 0 rgba(1,1,1,0.3)',
  'background-color:#506eac;color:#fff;padding:3px 3px 3px 2px;border-radius:0 14px 14px 0;font-family:DejaVu Sans,Verdana,Geneva,sans-serif;text-shadow:0 1px 0 rgba(1,1,1,0.3)'
);
//
// Add to resources:
//   url: /local/battery-bank-card.js
//   type: module
//
// Card config example:
//
// type: custom:battery-bank-card
// title: Battery Bank              # optional
// avg_count: 5                     # optional, 2–20, number of readings for power average
// batteries:
//   - name: Battery 1              # optional label
//     entity_soc:   sensor.marstek_battery_1_usable_soc
//     entity_power: sensor.marstek_venus_e_v3_0_1_battery_power
//     soc_floor:    0              # optional, default 0
//                                  # if 0 (or omitted): entity reports 0-100% usable SoC,
//                                  #   capacity_kwh is the usable capacity
//                                  # if > 0 (e.g. 12): entity reports RAW SoC (e.g. 12-100%),
//                                  #   capacity_kwh is the TOTAL physical capacity —
//                                  #   the card converts internally and only shows/uses usable portion
//     capacity_kwh: 4.4
//   - name: Battery 2 (raw sensor example)
//     entity_soc:   sensor.marstek_venus_e_v3_0_2_battery_soc   # reports 12-100%
//     entity_power: sensor.marstek_venus_e_v3_0_2_battery_power
//     soc_floor:    12             # 12% = physical empty
//     capacity_kwh: 5.0            # total physical kWh

const MIN_READINGS = 2;   // minimum readings before showing prediction

class BatteryBankCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._history = [];   // rolling power buffers per battery
  }

  static getStubConfig() {
    return {
      title: 'Battery Bank',
      avg_count: 5,
      show_predictions: true,
      show_raw_soc: false,
      batteries: [
        { name: 'Battery 1', entity_soc: '', entity_power: '', soc_floor: 0, capacity_kwh: 4.4 }
      ]
    };
  }

  static getConfigElement() {
    return document.createElement('battery-bank-card-editor');
  }

  setConfig(config) {
    if (!config.batteries || !config.batteries.length)
      throw new Error('battery-bank-card: at least one battery required');
    if (config.batteries.length > 6)
      throw new Error('battery-bank-card: maximum 6 batteries');
    this._config  = config;
    this._history  = config.batteries.map(() => ({ readings: [], lastDir: null, stale: true }));
    this._lastSeen = config.batteries.map(() => 0); // timestamp of last entity update
    this._build();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;

    // Always collect rolling power readings at full speed
    this._collectReadings();

    // Skip DOM update if nothing we care about changed
    if (!this._hasRelevantChange()) return;

    // Throttle DOM redraws: at most one per 125ms, but never delay the first one
    const now = Date.now();
    const elapsed = now - (this._lastDrawTime ?? 0);

    if (elapsed >= 125) {
      // Draw immediately
      this._lastDrawTime = now;
      if (this._updateTimer) { clearTimeout(this._updateTimer); this._updateTimer = null; }
      this._update();
    } else if (!this._updateTimer) {
      // Schedule trailing draw for when the 125ms window expires
      this._updateTimer = setTimeout(() => {
        this._updateTimer = null;
        this._lastDrawTime = Date.now();
        this._update();
      }, 125 - elapsed);
    }
  }

  // Collect rolling power readings from current hass state (runs at full speed)
  _collectReadings() {
    const maxH = this._config?.avg_count ?? 5;
    const now  = Date.now();
    (this._config?.batteries ?? []).forEach((cfg, i) => {
      const hist     = this._history[i];
      const powerRaw = this._val(cfg.entity_power);
      if (powerRaw === null || !hist) return;
      // Track that we received a value — even if unchanged
      if (!this._lastSeen) this._lastSeen = this._config.batteries.map(() => 0);
      this._lastSeen[i] = now;
      const dir = powerRaw > 5 ? 'discharge' : powerRaw < -5 ? 'charge' : 'idle';
      if (hist.lastDir !== null && hist.lastDir !== 'idle' && dir !== 'idle' && dir !== hist.lastDir) {
        hist.readings = [];
        hist.stale = true;
      }
      hist.lastDir = dir;
      hist.readings.push(powerRaw);
      if (hist.readings.length > maxH) hist.readings.shift();
      if (hist.readings.length >= MIN_READINGS) hist.stale = false;
    });
  }

  // Check whether any watched entity state value has changed
  _hasRelevantChange() {
    if (!this._hass) return true;
    const fp = (this._config?.batteries ?? []).map(b =>
      (this._hass.states[b.entity_soc]?.state        ?? '') + '|' +
      (this._hass.states[b.entity_power]?.state       ?? '') + '|' +
      (this._hass.states[b.entity_energy_in]?.state   ?? '') + '|' +
      (this._hass.states[b.entity_energy_out]?.state  ?? '')
    ).join(',');
    if (fp === this._lastFingerprint) return false;
    this._lastFingerprint = fp;
    return true;
  }

  getCardSize() { return Math.ceil(this._config?.batteries?.length ?? 1) + 2; }

  // ─── helpers ───────────────────────────────────────────────────────────────

  _val(eid) {
    const s = this._hass?.states[eid];
    if (!s || ['unknown','unavailable','none',''].includes(s.state)) return null;
    const v = parseFloat(s.state);
    return isNaN(v) ? null : v;
  }

  _fmt(h) {
    // Format decimal hours → "1h 23m" or "45m"
    if (h === null || !isFinite(h) || h < 0) return null;
    const total = Math.round(h * 60);
    const hh = Math.floor(total / 60), mm = total % 60;
    if (hh === 0) return `${mm}m`;
    if (mm === 0) return `${hh}h`;
    return `${hh}h ${mm}m`;
  }

  _avgPower(hist) {
    if (!hist.readings.length) return null;
    return hist.readings.reduce((a, b) => a + b, 0) / hist.readings.length;
  }

  // ─── build DOM once ────────────────────────────────────────────────────────

  _build() {
    const bats = this._config.batteries;

    this.shadowRoot.innerHTML = `
      <style>
        :host { font-family: inherit; }
        ha-card { padding: 0; box-sizing: border-box; }

        .card-header {
          padding: var(--ha-card-header-padding, 16px 16px 0);
        }
        .card-title {
          font-family: var(--ha-card-header-font-family, inherit);
          font-size: var(--ha-card-header-font-size, 1.25rem);
          font-weight: var(--ha-card-header-font-weight, 500);
          color: var(--ha-card-header-color, var(--primary-text-color));
          line-height: 1.2;
          padding: 0;
          margin: 0;
        }

        .card-body { padding: 12px 16px 16px; }

        /* Summary row */
        .summary {
          display: grid;
          grid-template-columns: repeat(var(--sum-cols, 3), minmax(0, 1fr));
          gap: 8px; margin-bottom: 16px;
        }
        .sum-tile {
          background: var(--secondary-background-color);
          border: 1px solid var(--divider-color);
          border-radius: var(--ha-card-border-radius, 12px); padding: 10px 12px;
          min-width: 0;
        }
        .sum-val { font-size: 15px; font-weight: 700;
                   white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sum-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
                   color: var(--secondary-text-color); margin-top: 2px;
                   white-space: nowrap; }

        /* Battery grid */
        .bat-grid {
          display: grid;
          grid-template-columns: repeat(var(--bat-cols, 3), minmax(0, 1fr));
          gap: 10px;
        }

        /* Battery tile */
        .bat-tile {
          background: var(--secondary-background-color);
          border: 1px solid var(--divider-color);
          border-radius: var(--ha-card-border-radius, 12px); padding: 12px 12px 10px;
          display: flex; flex-direction: column; gap: 8px;
          transition: border-color 0.3s;
        }

        /* Solo mode: single battery, no title — tile IS the card */
        :host(.solo) ha-card { border: none; box-shadow: none; }
        :host(.solo) .card-body { padding: 0; }
        :host(.solo) .bat-tile {
          background: transparent;
          border: none;
          border-radius: 0;
          padding: 0;
        }
        :host(.solo) .bat-grid { padding: 12px 12px 10px; }
        :host(.solo) ha-card:has(.bat-tile.charging)    { border-color: var(--info-color, #60a5fa); }
        :host(.solo) ha-card:has(.bat-tile.discharging) { border-color: var(--warning-color, #f97316); }
        :host(.solo) ha-card:has(.bat-tile.stale)       { border-color: var(--error-color, #ef4444); }
        .bat-tile.charging    { border-color: var(--info-color, #60a5fa); }
        .bat-tile.discharging { border-color: var(--warning-color, #f97316); }
        .bat-tile.idle        { border-color: var(--divider-color); }
        .bat-tile.stale       { border-color: var(--error-color, #ef4444); }
        .stale-indicator {
          font-size: 10px; color: var(--error-color, #ef4444);
          font-weight: 600; letter-spacing: 0.04em;
        }

        .bat-header {
          display: flex; align-items: center; justify-content: space-between;
        }
        .bat-name { font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
                    text-transform: uppercase;
                    color: var(--secondary-text-color); }
        .bat-power-pill {
          font-size: 10px; font-weight: 700;
          padding: 2px 7px; border-radius: 20px; letter-spacing: 0.04em;
        }
        .charging-pill    { background: color-mix(in srgb, var(--info-color, #60a5fa) 15%, transparent);
                            color: var(--info-color, #60a5fa); }
        .discharging-pill { background: color-mix(in srgb, var(--warning-color, #f97316) 15%, transparent);
                            color: var(--warning-color, #f97316); }
        .idle-pill        { background: color-mix(in srgb, var(--secondary-text-color) 15%, transparent);
                            color: var(--secondary-text-color); }

        /* SoC + bar row */
        .soc-row { display: flex; align-items: center; gap: 10px; }

        .bat-icon {
          width: 28px; flex-shrink: 0;
          display: flex; flex-direction: column; align-items: center; gap: 2px;
        }
        .bat-icon-cap {
          width: 12px; height: 4px; border-radius: 1px;
          background: var(--divider-color); margin-bottom: 1px;
        }
        .bat-icon-body {
          width: 24px; height: 56px;
          border: 2px solid var(--divider-color);
          border-radius: 4px; overflow: hidden;
          position: relative; display: flex; flex-direction: column; justify-content: flex-end;
        }
        .bat-icon-fill {
          width: 100%; transition: height 0.5s ease, background 0.4s;
          border-radius: 2px;
        }

        .soc-info { flex: 1; min-width: 0; }
        .soc-pct {
          font-size: 28px; font-weight: 700; line-height: 1;
          letter-spacing: -0.02em;
          transition: color 0.4s;
        }
        .soc-kwh {
          font-size: 11px;
          color: var(--secondary-text-color);
          margin-top: 2px;
        }
        .soc-raw {
          font-size: 11px;
          color: var(--disabled-text-color);
          margin-top: 1px;
        }

        /* Daily energy section */
        .energy-row {
          display: flex; gap: 10px; flex-wrap: wrap;
          padding: 6px 8px;
          background: color-mix(in srgb, var(--secondary-text-color) 6%, transparent);
          border-radius: calc(var(--ha-card-border-radius, 12px) / 2);
          font-size: 12px; font-weight: 600;
        }

        /* Avg power */
        .avg-row {
          font-size: 11px;
          color: var(--secondary-text-color);
          display: flex; align-items: center; gap: 4px;
        }
        .avg-val { font-weight: 700; }

        /* Projection */
        .proj {
          font-size: 11px;
          border-radius: calc(var(--ha-card-border-radius, 12px) / 2); padding: 5px 8px;
          line-height: 1.5;
        }
        .proj.charging    { background: color-mix(in srgb, var(--info-color, #60a5fa) 10%, transparent);
                            color: var(--info-color, #60a5fa); }
        .proj.discharging { background: color-mix(in srgb, var(--warning-color, #f97316) 10%, transparent);
                            color: var(--warning-color, #f97316); }
        .proj.stale       { background: color-mix(in srgb, var(--secondary-text-color) 8%, transparent);
                            color: var(--disabled-text-color);
                            font-style: italic; }
        .proj-arrow { font-size: 13px; margin-right: 3px; }
        .proj-time  { font-weight: 700; font-size: 13px; }
        .proj-label { opacity: 0.75; }

      </style>

      <ha-card>
        <div class="card-header">
          <h1 class="card-title" id="card-title"></h1>
        </div>
        <div class="card-body">
          <div class="summary" id="summary"></div>
          <div class="bat-grid" id="bat-grid"></div>
        </div>
      </ha-card>
    `;

    const titleEl = this.shadowRoot.getElementById('card-title');
    if (this._config.title) {
      titleEl.textContent = this._config.title;
      titleEl.parentElement.style.display = '';
    } else {
      titleEl.parentElement.style.display = 'none';
    }

    // Solo mode: single battery + no title → tile IS the card
    this._updateSoloMode();
  }

  _updateSoloMode() {
    const solo = !this._config.title && (this._config.batteries?.length ?? 0) === 1;
    this.classList.toggle('solo', solo);
  }

  // ─── update ────────────────────────────────────────────────────────────────

  _update() {
    if (!this._hass || !this._config) return;

    const bats = this._config.batteries;
    let totalKwhStored = 0, totalKwhUsable = 0;
    let totalPowerW = 0, totalPowerValid = 0;

    // ── Collect per-battery data ──────────────────────────────────────────────
    const data = bats.map((cfg, i) => {
      const soc      = this._val(cfg.entity_soc);       // 0–100 %
      const powerRaw = this._val(cfg.entity_power);     // W, negative=charge
      const floor    = cfg.soc_floor ?? 0;              // %
      const capKwh   = cfg.capacity_kwh ?? 4.4;

      // Rolling history is collected in _collectReadings (runs at full speed)
      const hist    = this._history[i];
      const avgPwr  = this._avgPower(hist);

      // ── Floor-aware SoC and kWh conversion ──────────────────────────────────
      // If soc_floor == 0 (default): entity already reports usable 0-100%,
      //   capacity_kwh is the usable capacity — no conversion needed.
      // If soc_floor > 0: entity reports raw SoC (e.g. 12-100%),
      //   capacity_kwh is the TOTAL physical capacity.
      //   usable range = (100 - floor)%, usable capacity = capacity_kwh * (100-floor)/100
      const rawSoc     = soc ?? 0;                    // as reported by entity
      let usableSocPct, usableCapKwh;
      if (floor > 0) {
        // Clamp raw below floor to 0, above to 100
        const clampedRaw = Math.min(100, Math.max(floor, rawSoc));
        usableSocPct  = Math.round(((clampedRaw - floor) / (100 - floor)) * 100);
        usableCapKwh  = capKwh * (100 - floor) / 100;
      } else {
        usableSocPct  = Math.round(Math.min(100, Math.max(0, rawSoc)));
        usableCapKwh  = capKwh;
      }

      const storedKwh = (usableSocPct / 100) * usableCapKwh;
      const emptyKwh  = usableCapKwh - storedKwh;   // kWh headroom to full

      totalKwhStored += storedKwh;
      totalKwhUsable += usableCapKwh;
      if (powerRaw !== null) { totalPowerW += powerRaw; totalPowerValid++; }

      // Projection
      let proj = null; // { dir, timeH, timeStr } or null
      if (!hist.stale && avgPwr !== null && Math.abs(avgPwr) > 5) {
        if (avgPwr < 0) {
          // Charging — time to full
          const rateKwh = Math.abs(avgPwr) / 1000;
          const timeH   = emptyKwh / rateKwh;
          proj = { dir: 'charge', timeH, timeStr: this._fmt(timeH), kwhLeft: emptyKwh };
        } else {
          // Discharging — time to empty
          const rateKwh = avgPwr / 1000;
          const timeH   = storedKwh / rateKwh;
          proj = { dir: 'discharge', timeH, timeStr: this._fmt(timeH), kwhLeft: storedKwh };
        }
      }

      return {
        cfg, rawSoc, soc: usableSocPct, powerRaw, avgPwr,
        storedKwh, capKwh: usableCapKwh, totalCapKwh: capKwh,
        proj, hist, floor,
        energyIn:  this._val(cfg.entity_energy_in)  ?? null,
        energyOut: this._val(cfg.entity_energy_out) ?? null,
        isStale: (Date.now() - (this._lastSeen?.[i] ?? 0)) > 60000,
      };
    });

    // ── Summary row ───────────────────────────────────────────────────────────
    const totalSocPct = totalKwhUsable > 0
      ? Math.round((totalKwhStored / totalKwhUsable) * 100) : 0;

    let sumPowerW = 0, anyPowerValid = false;
    let totalEnergyIn = 0, totalEnergyOut = 0, anyEnergy = false;
    data.forEach(d => {
      const pw = d.avgPwr ?? d.powerRaw;
      if (pw !== null) { sumPowerW += pw; anyPowerValid = true; }
      if (d.energyIn  !== null) { totalEnergyIn  += d.energyIn;  anyEnergy = true; }
      if (d.energyOut !== null) { totalEnergyOut += d.energyOut; anyEnergy = true; }
    });
    const totalSumPwr = anyPowerValid ? sumPowerW : null;

    const powerColor = totalSumPwr === null ? 'var(--secondary-text-color)'
      : totalSumPwr < -5  ? 'var(--info-color, #60a5fa)'
      : totalSumPwr > 5   ? 'var(--warning-color, #f97316)' : 'var(--secondary-text-color)';
    const powerStr = totalSumPwr !== null
      ? (totalSumPwr < 0 ? '↓ ' : totalSumPwr > 5 ? '↑ ' : '~ ')
        + Math.abs(Math.round(totalSumPwr)) + ' W' : '— W';

    const allHaveBothEnergy = data.every(d => d.cfg.entity_energy_in && d.cfg.entity_energy_out);

    const energySummaryTile = allHaveBothEnergy ? `
      <div class="sum-tile">
        <div class="sum-val" style="font-size:12px;line-height:1.5">
          <span style="color:var(--info-color,#60a5fa)">↓ ${totalEnergyIn.toFixed(2)} kWh</span><br>
          <span style="color:var(--warning-color,#f97316)">↑ ${totalEnergyOut.toFixed(2)} kWh</span>
        </div>
        <div class="sum-lbl">Energy today</div>
      </div>` : '';

    // Set summary column count based on whether energy tile is shown
    const summaryEl = this.shadowRoot.getElementById('summary');

    if (data.length <= 1) {
      summaryEl.innerHTML = '';
      summaryEl.style.display = 'none';
    } else {
      summaryEl.style.display = '';
      summaryEl.style.setProperty('--sum-cols', energySummaryTile ? 4 : 3);
      summaryEl.innerHTML = `
      <div class="sum-tile">
        <div class="sum-val" style="color:${this._socColor(totalSocPct)}">${totalSocPct}%</div>
        <div class="sum-lbl">Combined SoC</div>
      </div>
      <div class="sum-tile">
        <div class="sum-val">${totalKwhStored.toFixed(2)} kWh</div>
        <div class="sum-lbl">Stored</div>
      </div>
      <div class="sum-tile">
        <div class="sum-val" style="color:${powerColor}">${powerStr}</div>
        <div class="sum-lbl">Total power</div>
      </div>
      ${energySummaryTile}
    `;
    } // end else (data.length > 1)

    // ── Battery tiles ─────────────────────────────────────────────────────────
    const grid = this.shadowRoot.getElementById('bat-grid');

    // Columns: 1 bat → 1 col, 2 → 2, 3–4 → 3, 5–6 → 3 (wraps to 2 rows)
    const cols = data.length <= 2 ? data.length : 3;
    grid.style.setProperty('--bat-cols', cols);

    // Rebuild tiles or update in place
    if (grid.children.length !== data.length) {
      grid.innerHTML = '';
      data.forEach((_, i) => {
        const div = document.createElement('div');
        div.id = `bat-tile-${i}`;
        div.className = 'bat-tile';
        grid.appendChild(div);
      });
    }

    data.forEach((d, i) => {
      const tile = this.shadowRoot.getElementById(`bat-tile-${i}`);
      if (!tile) return;

      const dir = d.powerRaw === null ? 'idle'
        : d.powerRaw < -5 ? 'charging'
        : d.powerRaw > 5  ? 'discharging' : 'idle';

      tile.className = `bat-tile ${d.isStale ? 'stale' : dir}`;

      const fillColor  = this._socColor(d.soc);
      const dirColor   = this._dirColor(dir);
      const fillH      = Math.max(2, Math.round((d.soc / 100) * 52));

      const powerPillClass = dir === 'charging' ? 'charging-pill'
        : dir === 'discharging' ? 'discharging-pill' : 'idle-pill';
      const powerSign = dir === 'charging' ? '↓ ' : dir === 'discharging' ? '↑ ' : '~ ';
      const powerDisp = d.powerRaw !== null
        ? powerSign + Math.abs(Math.round(d.powerRaw)) + ' W' : '— W';

      const avgSign = d.avgPwr !== null
        ? (d.avgPwr < 0 ? '↓' : d.avgPwr > 5 ? '↑' : '~') : '~';
      const avgDisp = d.avgPwr !== null
        ? avgSign + ' ' + Math.abs(Math.round(d.avgPwr)) + ' W avg'
        : 'no data';

      // Projection block
      const maxH    = this._config.avg_count ?? 5;
      const showPred = this._config.show_predictions !== false;
      const readings = d.hist.readings;
      let projHTML = '';
      if (showPred) {
        if (d.hist.stale) {
          projHTML = `<div class="proj stale">collecting data… (${readings.length}/${maxH})</div>`;
        } else if (!d.proj) {
          projHTML = `<div class="proj stale">idle / stable</div>`;
        } else if (d.proj.dir === 'charge') {
          projHTML = `
            <div class="proj charging">
              <span class="proj-arrow">⚡</span>
              <span class="proj-time">${d.proj.timeStr ?? '—'}</span>
              <span class="proj-label"> to full</span><br>
              <span class="proj-label">${d.proj.kwhLeft.toFixed(2)} kWh left</span>
            </div>`;
        } else {
          projHTML = `
            <div class="proj discharging">
              <span class="proj-arrow">▸</span>
              <span class="proj-time">${d.proj.timeStr ?? '—'}</span>
              <span class="proj-label"> to empty</span><br>
              <span class="proj-label">${d.proj.kwhLeft.toFixed(2)} kWh left</span>
            </div>`;
        }
      }

      // Energy today section
      const hasEnergy = d.energyIn !== null || d.energyOut !== null;
      const energyHTML = hasEnergy ? `
        <div class="energy-row">
          ${d.energyIn  !== null ? `<span style="color:var(--info-color,#60a5fa)">↓ ${d.energyIn.toFixed(2)} kWh</span>` : ''}
          ${d.energyOut !== null ? `<span style="color:var(--warning-color,#f97316)">↑ ${d.energyOut.toFixed(2)} kWh</span>` : ''}
        </div>` : '';

      const showRaw = this._config.show_raw_soc === true;

      tile.innerHTML = `
        <div class="bat-header">
          <span class="bat-name">${d.cfg.name ?? `Battery ${i + 1}`}</span>
          ${d.isStale
            ? `<span class="stale-indicator">⚠ no data</span>`
            : `<span class="bat-power-pill ${powerPillClass}">${powerDisp}</span>`}
        </div>

        <div class="soc-row">
          <div class="bat-icon">
            <div class="bat-icon-cap"></div>
            <div class="bat-icon-body">
              <div class="bat-icon-fill" style="height:${fillH}px;background:${fillColor};"></div>
            </div>
          </div>
          <div class="soc-info">
            <div class="soc-pct" style="color:${fillColor}">${Math.round(d.soc)}%</div>
            <div class="soc-kwh">${d.storedKwh.toFixed(2)} / ${d.capKwh.toFixed(1)} kWh</div>
            ${showRaw && d.floor > 0 ? `<div class="soc-raw">raw ${Math.round(d.rawSoc)}%</div>` : ''}
          </div>
        </div>

        <div class="avg-row">
          <span class="avg-val" style="color:${dirColor}">${avgDisp}</span>
          <span style="opacity:0.4;font-size:9px">(${readings.length}/${maxH})</span>
        </div>

        ${energyHTML}
        ${projHTML}
      `;
    });
  }

  _socColor(pct) {
    if (pct >= 60) return 'var(--success-color, #22c55e)';
    if (pct >= 30) return 'var(--warning-color, #f59e0b)';
    return 'var(--error-color, #ef4444)';
  }

  _dirColor(dir) {
    if (dir === 'charging')    return 'var(--info-color, #60a5fa)';
    if (dir === 'discharging') return 'var(--warning-color, #f97316)';
    return 'var(--secondary-text-color)';
  }
}

customElements.define('battery-bank-card', BatteryBankCard);

// ── Editor ─────────────────────────────────────────────────────────────────────

class BatteryBankCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
  }

  // Build the ha-form schema for one battery slot
  _batSchema(i) {
    return [
      { name: `bat_${i}_name`,           selector: { text: {} } },
      { name: `bat_${i}_entity_soc`,     selector: { entity: {} } },
      { name: `bat_${i}_entity_power`,   selector: { entity: {} } },
      { name: `bat_${i}_entity_energy_in`,  selector: { entity: {} } },
      { name: `bat_${i}_entity_energy_out`, selector: { entity: {} } },
      { name: `bat_${i}_soc_floor`,      selector: { number: { min: 0, max: 50, step: 1, mode: 'box', unit_of_measurement: '%' } } },
      { name: `bat_${i}_capacity_kwh`,   selector: { number: { min: 0.1, max: 100, step: 0.1, mode: 'box', unit_of_measurement: 'kWh' } } },
    ];
  }

  // Flatten config batteries into flat keys for ha-form
  _toFormData() {
    const d = {
      title:            this._config.title            ?? '',
      avg_count:        this._config.avg_count        ?? 5,
      show_predictions: this._config.show_predictions !== false,
      show_raw_soc:     this._config.show_raw_soc     === true,
    };
    (this._config.batteries ?? []).forEach((b, i) => {
      d[`bat_${i}_name`]              = b.name              ?? `Battery ${i + 1}`;
      d[`bat_${i}_entity_soc`]        = b.entity_soc        ?? '';
      d[`bat_${i}_entity_power`]      = b.entity_power      ?? '';
      d[`bat_${i}_entity_energy_in`]  = b.entity_energy_in  ?? '';
      d[`bat_${i}_entity_energy_out`] = b.entity_energy_out ?? '';
      d[`bat_${i}_soc_floor`]         = b.soc_floor         ?? 0;
      d[`bat_${i}_capacity_kwh`]      = b.capacity_kwh      ?? 4.4;
    });
    return d;
  }

  // Reconstruct config from flat ha-form values
  _fromFormData(data) {
    // Use form value as-is if present (including ''); only fall back if key is absent
    const get = (key, fallback) => key in data ? data[key] : fallback;
    const cleanEnt = v => (v === '' ? undefined : v);
    const bats = (this._config.batteries ?? []).map((b, i) => {
      const o = {
        name:              get(`bat_${i}_name`,              b.name              ?? `Battery ${i + 1}`),
        entity_soc:        get(`bat_${i}_entity_soc`,        b.entity_soc        ?? ''),
        entity_power:      get(`bat_${i}_entity_power`,      b.entity_power      ?? ''),
        entity_energy_in:  get(`bat_${i}_entity_energy_in`,  b.entity_energy_in  ?? ''),
        entity_energy_out: get(`bat_${i}_entity_energy_out`, b.entity_energy_out ?? ''),
        soc_floor:         get(`bat_${i}_soc_floor`,         b.soc_floor         ?? 0),
        capacity_kwh:      get(`bat_${i}_capacity_kwh`,      b.capacity_kwh      ?? 4.4),
      };
      // Remove optional entity fields if empty so they don't pollute the config
      if (!o.entity_energy_in)  delete o.entity_energy_in;
      if (!o.entity_energy_out) delete o.entity_energy_out;
      return o;
    });
    return {
      ...this._config,
      title:            get('title',            this._config.title            ?? ''),
      avg_count:        get('avg_count',        this._config.avg_count        ?? 5),
      show_predictions: get('show_predictions', this._config.show_predictions !== false),
      show_raw_soc:     get('show_raw_soc',     this._config.show_raw_soc     === true),
      batteries: bats,
    };
  }

  // Human-readable labels for ha-form fields
  _computeLabel(schema) {
    const labels = {
      title:            'Card title',
      avg_count:        'Power average — number of readings',
      show_predictions: 'Show time-to-full / time-to-empty predictions',
      show_raw_soc:     'Show raw SoC % (only relevant when floor > 0)',
    };
    const key = schema.name.replace(/^bat_\d+_/, '');
    const batLabels = {
      name:              'Name',
      entity_soc:        'SoC entity',
      entity_power:      'AC power entity (negative = charging)',
      entity_energy_in:  'Energy charged today (kWh) — optional',
      entity_energy_out: 'Energy discharged today (kWh) — optional',
      soc_floor:         'Floor % — lowest the battery will go',
      capacity_kwh:      'Full capacity incl. unusable part',
    };
    return labels[schema.name] ?? batLabels[key] ?? schema.name;
  }

  setConfig(config) {
    const prevBatCount = this._config?.batteries?.length ?? -1;
    this._config = JSON.parse(JSON.stringify(config));
    const newBatCount = this._config.batteries?.length ?? 0;

    if (!this.shadowRoot.getElementById('form-card')) {
      // First time — build full DOM and wire everything
      this._render();
    } else if (newBatCount !== prevBatCount) {
      // Battery count changed — structural rebuild needed
      this._render();
    } else {
      // Only data changed — just sync form .data, no DOM touch
      this._syncFormData();
    }
  }

  set hass(hass) {
    this._hass = hass;
    this.shadowRoot.querySelectorAll('ha-form').forEach(f => { f.hass = hass; });
  }

  _fire(config) {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config },
      bubbles: true,
      composed: true
    }));
  }

  // Only update form .data — never touch DOM structure or listeners
  _syncFormData() {
    const fd = this._toFormData();
    const cardForm = this.shadowRoot.getElementById('form-card');
    if (cardForm) cardForm.data = fd;
    (this._config.batteries ?? []).forEach((_, i) => {
      const form = this.shadowRoot.getElementById(`form-bat-${i}`);
      if (form) form.data = fd;
    });
  }

  _render() {
    const bats   = this._config.batteries ?? [];
    const canAdd = bats.length < 6;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .section {
          font-size: 12px; font-weight: 600; letter-spacing: 0.06em;
          text-transform: uppercase; color: var(--secondary-text-color);
          margin: 16px 0 4px;
        }
        .section:first-child { margin-top: 0; }
        .bat-block {
          border: 1px solid var(--divider-color);
          border-radius: var(--ha-card-border-radius, 10px);
          padding: 12px; margin-bottom: 10px;
        }
        .bat-header {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 8px;
        }
        .bat-title {
          font-size: 12px; font-weight: 600; letter-spacing: 0.05em;
          text-transform: uppercase; color: var(--secondary-text-color);
        }
        .btn-remove {
          background: none; border: none; cursor: pointer;
          color: var(--error-color, #ef4444); font-size: 18px;
          padding: 0; line-height: 1; display: flex; align-items: center;
        }
        .btn-add {
          width: 100%; padding: 10px;
          background: none;
          border: 1px dashed var(--divider-color);
          border-radius: var(--ha-card-border-radius, 10px);
          color: var(--primary-color);
          font-size: 13px; font-family: inherit;
          cursor: pointer; margin-top: 4px;
        }
      </style>

      <div class="section">Card</div>
      <ha-form id="form-card"></ha-form>

      <div class="section">Batteries</div>
      ${bats.map((_, i) => `
        <div class="bat-block">
          <div class="bat-header">
            <span class="bat-title">Battery ${i + 1}</span>
            <button class="btn-remove" data-idx="${i}">
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          <ha-form id="form-bat-${i}"></ha-form>
        </div>
      `).join('')}
      ${canAdd ? `<button class="btn-add" id="btn-add">+ Add battery</button>` : ''}
    `;

    // ── Card-level form — wired once ───────────────────────────────────────
    const cardForm = this.shadowRoot.getElementById('form-card');
    cardForm.schema = [
      { name: 'title',            selector: { text: {} } },
      { name: 'avg_count',        selector: { number: { min: 2, max: 20, step: 1, mode: 'slider' } } },
      { name: 'show_predictions', selector: { boolean: {} } },
      { name: 'show_raw_soc',     selector: { boolean: {} } },
    ];
    cardForm.computeLabel = (s) => this._computeLabel(s);
    if (this._hass) cardForm.hass = this._hass;
    cardForm.addEventListener('value-changed', e => {
      this._config = this._fromFormData({ ...this._toFormData(), ...e.detail.value });
      this._fire(this._config);
    });

    // ── Per-battery forms — wired once each ────────────────────────────────
    bats.forEach((_, i) => {
      const form = this.shadowRoot.getElementById(`form-bat-${i}`);
      if (!form) return;
      form.schema = this._batSchema(i);
      form.computeLabel = (s) => this._computeLabel(s);
      if (this._hass) form.hass = this._hass;
      form.addEventListener('value-changed', e => {
        this._config = this._fromFormData({ ...this._toFormData(), ...e.detail.value });
        this._fire(this._config);
      });
    });

    // ── Structural buttons ─────────────────────────────────────────────────
    this.shadowRoot.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        const b   = JSON.parse(JSON.stringify(this._config.batteries ?? []));
        b.splice(idx, 1);
        this._config = { ...this._config, batteries: b };
        this._fire(this._config);
        this._render();
        if (this._hass) this.hass = this._hass;
      });
    });

    this.shadowRoot.getElementById('btn-add')?.addEventListener('click', () => {
      const b = JSON.parse(JSON.stringify(this._config.batteries ?? []));
      b.push({ name: `Battery ${b.length + 1}`, entity_soc: '', entity_power: '', soc_floor: 0, capacity_kwh: 4.4 });
      this._config = { ...this._config, batteries: b };
      this._fire(this._config);
      this._render();
      if (this._hass) this.hass = this._hass;
    });

    // Set data last, after listeners are attached
    this._syncFormData();
  }
}

customElements.define('battery-bank-card-editor', BatteryBankCardEditor);

// Register in HA card picker
window.customCards = window.customCards ?? [];
window.customCards.push({
  type:        'battery-bank-card',
  name:        'Battery Bank',
  description: 'Multi-battery status with power averaging and projections',
  version:     VERSION,
  preview:     false,
});

// ═══════════════════════════════════════════════════════════════
//  STOCKWISE — Live Tracker
//  track: coins or stocks, sparklines, chart modals, alerts
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';

// ─── STATE ───────────────────────────────────────────────────
   let allCoins       = [];
   let allStocks      = [];
   let chartInstance  = null;
   let currentCoinId  = '';
   let currentSort    = 'mcap';
   let favMode        = false;
   let currentType    = 'all';
   let currentCryptoCategory = '';
   let currentStockCategory  = 'all';
   let favSet         = JSON.parse(localStorage.getItem('sw_favs') || '[]');
    let lastQueriedChartCoin = null;

   // Indicator state tracking
   let activeIndicators = { ohlc: true, sma: true, ema: false, rsi: false, bb: false, volume: false };
    let indicatorPeriods = { sma: 20, ema: 20, rsi: 14, bb: 20 };

    // Live USD→INR rate for consistent INR pricing (derived from USDT)
    let usdInrRate = 83.5;
    let usdInrRateTime = 0;

   // ─── DOM HELPER ──────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  // ─── COINGECKO CATEGORY MAP ─────────────────────────────────
  const CATEGORY_MAP = {
    'all':              '',
    'hot':              'trending',
    'trending':         'trending',
    'defi':             'decentralized-finance-defi',
    'decentralized-finance-defi': 'decentralized-finance-defi',
    'meme':             'meme-token',
    'meme-token':       'meme-token',
    'meme-tokens':      'meme-token',
    'meme coin':        'meme-token',
    'nft':              'non-fungible-tokens-nft',
    'layer-1':          'layer-1',
    'layer1':           'layer-1',
    'layer-2':          'layer-2',
    'layer2':           'layer-2',
    'gaming':           'gaming',
    'exchange':         'exchange-tokens',
    'exchange token':   'exchange-tokens',
    'privacy':          'privacy-coins',
    'smart-contract':   'smart-contract-platforms',
    'smart contract':   'smart-contract-platforms',
    'stablecoins':      'stablecoins',
    'stablecoin':       'stablecoins',
    'artificial-intelligence': 'artificial-intelligence',
    'ai':               'artificial-intelligence',
    'real-world-assets':'real-world-assets',
    'rwa':              'real-world-assets',
  };

  function resolveCat(raw) {
    const key = String(raw || '').trim().toLowerCase();
    if (CATEGORY_MAP[key] !== undefined) return CATEGORY_MAP[key];
    for (const [k, v] of Object.entries(CATEGORY_MAP)) {
      if (k === key || k === key + 's' || k + 's' === key) return v;
    }
    return raw;
  }

  async function getUsdInrRate(force = false) {
    const now = Date.now();
    if (!force && usdInrRateTime && (now - usdInrRateTime) < 60000) return usdInrRate;
    try {
      const r = await fetch('/api/rates', { credentials: 'include' });
      const j = await r.json();
      if (j && j.usd_inr) {
        usdInrRate = j.usd_inr;
        usdInrRateTime = now;
      }
    } catch {}
    return usdInrRate;
  }

  function renderShimmer() {
    const el = $('shimmerGrid');
    if (!el) return;
    el.innerHTML = Array(9).fill(0).map(() => '<div class="skel-card skel-block"></div>').join('');
  }

  function showShimmer() {
    const sg = $('shimmerGrid'); if (sg) sg.style.display = 'grid';
    const cg = $('coinsGrid'); if (cg) cg.style.display = 'none';
    renderShimmer();
  }

  function hideShimmerAndShowGrid() {
    const sg = $('shimmerGrid'); if (sg) sg.style.display = 'none';
    const cg = $('coinsGrid'); if (cg) cg.style.display = 'grid';
  }

  async function loadPrices(category, forceFresh = false) {
    showShimmer();
    try {
      const currency = $('currencySelect')?.value || 'usd';
      let data;

      let vs = currency === 'usdt' ? 'usd' : currency;
      const rawCat = category ?? currentCryptoCategory ?? '';
      const cat = resolveCat(rawCat);
      const queryParams = new URLSearchParams({
        per_page: 250,
        order: 'market_cap_desc',
        sparkline: 'true',
        price_change_percentage: '1h,24h,7d',
        vs_currency: vs,
      });
      if (cat) queryParams.set('category', cat);
      if (forceFresh) queryParams.set('fresh', '1');

      const cgUrl = `/api/markets?${queryParams.toString()}`;
      const cgRes = await fetch(cgUrl, { credentials: 'include' });
      data = await cgRes.json();
      if (data.error) throw new Error(data.error);
      if (!Array.isArray(data)) throw new Error('Malformed response');

      if (currency === 'inr') {
        const dcxParams = new URLSearchParams({ vs_currency: 'inr' });
        if (forceFresh) dcxParams.set('fresh', '1');
        const dcxUrl = `/api/coindcx/markets?${dcxParams.toString()}`;
        const dcxRes = await fetch(dcxUrl, { credentials: 'include' });
        const dcxData = await dcxRes.json();

        if (Array.isArray(dcxData)) {
          const dcxMap = {};
          dcxData.forEach(d => { if (d.symbol) dcxMap[d.symbol.toUpperCase()] = d; });
          data = data.map(coin => {
            const sym = (coin.symbol || '').toUpperCase();
            const dcx = dcxMap[sym];
            if (dcx && dcx.current_price != null) {
              return {
                ...coin,
                current_price: dcx.current_price,
                price_change_percentage_24h: dcx.price_change_percentage_24h ?? coin.price_change_percentage_24h,
                total_volume: dcx.total_volume || coin.total_volume
              };
            }
            return coin;
          });
        }
      }

      allCoins = data;
      updateLastRefresh();
      filterTable();
    } catch (err) {
      console.error('[markets]', err);
      const sg = $('shimmerGrid');
      if (sg) {
        sg.innerHTML = `
          <div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--red)">
            ⚠ Failed to load prices — ${escHtml(err.message)}.
            <button class="cbtn" onclick="loadPrices('${escAttr(currentCryptoCategory || '')}')" style="margin-top:0.75rem">Retry</button>
          </div>`;
      }
    }
  }

  async function loadStocks(category, forceFresh = false) {
    showShimmer();
    try {
      const cat = (category ?? currentStockCategory) || 'all';
      let url = `/api/stocks?category=${encodeURIComponent(cat)}`;
      if (forceFresh) url += '&fresh=1';
      const res = await fetch(url, { credentials: 'include' });
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Malformed response');
      allStocks = data;
      updateLastRefresh();
      filterTable();
    } catch (err) {
      console.error('[stocks]', err);
      const sg = $('shimmerGrid');
      if (sg) {
        sg.innerHTML = `
          <div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--red)">
            ⚠ Failed to load stocks — ${escHtml(err.message)}.
            <button class="cbtn" onclick="loadStocks('${escAttr(currentStockCategory || 'all')}')" style="margin-top:0.75rem">Retry</button>
          </div>`;
      }
    }
  }

  function updateLastRefresh() {
    const el = $('lastUpdate'); if (el) el.textContent = new Date().toLocaleTimeString();
  }

  function updateCategoryBar(type) {
    const cb = $('categoryBar'); if (cb) cb.style.display = type === 'all' ? 'none' : 'block';
    const cc = $('cryptoCats'); if (cc) cc.style.display = type === 'crypto' ? 'inline-flex' : 'none';
    const sc = $('stockCats'); if (sc) sc.style.display = type === 'stock' ? 'inline-flex' : 'none';
  }

  function switchType(type, btn) {
    currentType = type;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    btn?.classList.add('active');
    updateCategoryBar(type);
    if (type === 'stock') {
      loadStocks(currentStockCategory);
    } else if (type === 'crypto') {
      loadPrices(currentCryptoCategory);
    } else {
      loadAll();
    }
  }

  function changeCryptoCategory(rawCat, btn) {
    const resolved = resolveCat(rawCat);
    currentCryptoCategory = resolved;
    document.querySelectorAll('#cryptoCats .cat-pill').forEach(b => b.classList.remove('active'));
    btn?.classList.add('active');
    loadPrices(resolved);
  }

  function changeStockCategory(cat, btn) {
    currentStockCategory = cat;
    document.querySelectorAll('#stockCats .cat-pill').forEach(b => b.classList.remove('active'));
    btn?.classList.add('active');
    loadStocks(cat);
  }

  function setSort(mode, btn) {
    currentSort = mode;
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    btn?.classList.add('active');
    filterTable();
  }

  function sortCoins(coins) {
    return [...coins].sort((a, b) => {
      switch (currentSort) {
        case 'gainers': return (b.price_change_percentage_24h || 0) - (a.price_change_percentage_24h || 0);
        case 'losers': return (a.price_change_percentage_24h || 0) - (b.price_change_percentage_24h || 0);
        case 'volume': return (b.total_volume || 0) - (a.total_volume || 0);
        case 'mcap': return (b.market_cap || 0) - (a.market_cap || 0);
        default: return 0;
      }
    });
  }

  function toggleFavMode() {
    favMode = !favMode;
    const el = $('favToggle'); if (el) el.classList.toggle('active', favMode);
    filterTable();
  }

  function toggleFav(sym) {
    if (favMode) return;
    const idx = favSet.indexOf(sym);
    favSet[idx === -1 ? 'push' : 'splice'](idx, 1);
    localStorage.setItem('sw_favs', JSON.stringify(favSet));
    filterTable();
  }

  function isFav(sym) { return favSet.includes(sym); }

  function sparkPath(points, w, h) {
    if (!points?.length) return '';
    const mn = Math.min(...points), mx = Math.max(...points);
    const rng = mx - mn || 1;
    const step = w / (points.length - 1 || 1);
    return points.map((p, i) => {
      const x = i * step;
      const y = h - ((p - mn) / rng) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
    }).join('').trim();
  }

  function sparkColor(chg) {
    if (chg > 0) return 'rgba(0,229,160,0.7)';
    if (chg < 0) return 'rgba(255,71,87,0.7)';
    return 'rgba(255,255,255,0.3)';
  }

  function filterTable() {
    const q = ($('searchInput')?.value || '').toLowerCase().trim();
    let coins;
    if (currentType === 'stock') {
      coins = allStocks.filter(c => c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q));
    } else {
      coins = allCoins.filter(c => c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q));
      if (currentType === 'all') {
        coins.push(...allStocks.filter(c => c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q)));
      }
    }
    if (favMode) coins = coins.filter(c => isFav(c.symbol.toUpperCase()));
    coins = sortCoins(coins);
    renderTable(coins);
  }

  function renderTable(coins) {
    const grid = $('coinsGrid'); if (!grid) { console.warn('[tracker] #coinsGrid missing, retrying'); setTimeout(filterTable, 200); return; }
    hideShimmerAndShowGrid();

    if (!coins.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:2.5rem;color:var(--text2);font-size:0.92rem">${favMode ? 'No assets in your Watchlist yet — click ★ on any card.' : 'No results found.'}</div>`;
      const cc = $('coinCount'); if (cc) cc.textContent = '0 assets';
      return;
    }

    const currency = $('currencySelect')?.value || 'usd';
    const isStock = currentType === 'stock';

    grid.innerHTML = coins.map((c) => {
      const sym = (c.symbol || '').toUpperCase();
      const h1 = c.price_change_percentage_1h_in_currency ?? 0;
      const h24 = c.price_change_percentage_24h ?? 0;
      const h7 = c.price_change_percentage_7d_in_currency ?? 0;
      const price = fmtPrice(c.current_price ?? 0, currency);
      const pfx = currency === 'inr' ? '₹' : currency === 'usdt' ? '₮' : '$';
      const sign24 = h24 > 0 ? '+' : '';
      const clsPill = h24 === 0 ? 'ct-neutral' : h24 > 0 ? 'ct-up' : 'ct-down';
      const mcap = fmtM(c.market_cap, currency);
      const vol = fmtM(c.total_volume, currency);
      const fav = isFav(sym);
      const coinId = escAttr(c.id || '');
      const coinName = escAttr(c.name || '');
      const img = escHtml(c.image || `https://www.google.com/s2/favicons?domain=${sym.toLowerCase()}&sz=64`);

      const src = c.sparkline_in_7d?.price;
      const SW = 120;
      const SH = 32;
      const spark = (Array.isArray(src) && src.length)
        ? (() => {
            const d = sparkPath(src, SW, SH);
            if (!d) return '';
            return `<svg class="ct-spark" viewBox="0 0 ${SW} ${SH}" preserveAspectRatio="none" role="img" aria-label="${sym} 7-day sparkline"><path d="${d}" fill="none" stroke="${sparkColor(h24)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
          })()
        : `<svg class="ct-spark" viewBox="0 0 ${SW} ${SH}" preserveAspectRatio="none" style="opacity:.2" role="img" aria-label="No data"><line x1="0" y1="${SH/2}" x2="${SW}" y2="${SH/2}" stroke="var(--text2)" stroke-width="1" stroke-dasharray="3,3"/></svg>`;

      const chg1Cls = h1 === 0 ? 'neutral' : h1 > 0 ? 'positive' : 'negative';
      const chg24Cls = h24 === 0 ? 'neutral' : h24 > 0 ? 'positive' : 'negative';
      const chg7Cls = h7 === 0 ? 'neutral' : h7 > 0 ? 'positive' : 'negative';

      return `
        <div class="cr${fav ? ' is-fav' : ''}" role="row" tabindex="0" title="${escAttr(c.name)} (${sym})">
          <div class="cr-top">
            <div class="cr-asset">
              <img class="cr-icon" src="${img}" alt="${sym}" loading="lazy" onerror="this.src='https://ui-avatars.com/api/?name=${escAttr(sym)}&background=111927&color=888888&size=96'">
              <div class="cr-name-box">
                <div class="cr-name">${escHtml(c.name)}</div>
                <div class="cr-symbol">${sym}</div>
              </div>
            </div>
            <button class="fav-trig${fav ? ' on' : ''}" onclick="event.stopPropagation();toggleFav('${sym}')" title="Watchlist" aria-label="Watchlist ${sym}" style="background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;color:var(--text2);transition:all .2s">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style="display:block">
                <path fill="${fav ? '#ffd43b' : 'currentColor'}" d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z"/>
              </svg>
            </button>
          </div>
          <div class="cr-price-box">
            <div class="cr-price-label">Price</div>
            <div class="cr-price" onclick="openChartModal('${coinId}','${coinName}')" style="cursor:pointer;transition:color .2s" title="Click to view chart">${pfx}${price}</div>
          </div>
          <div class="cr-chg-row" style="position:relative;z-index:1">
            <div class="chg-box"><div class="lbl">1H</div><div class="val ${chg1Cls}">${h1 > 0 ? '+' : ''}${h1.toFixed(2)}%</div></div>
            <div class="chg-box"><div class="lbl">24H</div><div class="val ${chg24Cls}">${sign24}${h24.toFixed(2)}%</div></div>
            <div class="chg-box"><div class="lbl">7D</div><div class="val ${chg7Cls}">${h7 > 0 ? '+' : ''}${h7.toFixed(2)}%</div></div>
          </div>
          <div class="cr-stats-row" style="position:relative;z-index:1">
            <div class="stat-box" title="Market Capitalization"><span class="lbl">MCap</span><span class="val">${mcap}</span></div>
            <div class="stat-box" title="24h Trading Volume"><span class="lbl">Volume</span><span class="val">${vol}</span></div>
          </div>
          <div style="height:32px;margin:0.5rem 0;position:relative;z-index:1;width:100%;overflow:hidden">${spark}</div>
          <div class="cr-actions" style="position:relative;z-index:2">
            <button class="cr-act-btn" onclick="event.stopPropagation();openAlertModal('${sym}',${c.current_price || 0})" title="Set price alert">🔔 Alert</button>
            <button class="cr-act-btn" onclick="event.stopPropagation();openChartModal('${coinId}','${coinName}')" title="View detailed chart">📊 Chart</button>
          </div>
        </div>`;
    }).join('');

    const cc = $('coinCount'); if (cc) cc.textContent = `${coins.length} assets`;
  }

  window.$$refreshTicker = () => {};

  function calcSMA(prices, period = 20) {
    const sma = [];
    for (let i = 0; i < prices.length; i++) {
      sma.push(i < period - 1 ? null : prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
    }
    return sma;
  }

  function calcEMA(prices, period = 20) {
    const k = 2 / (period + 1);
    let prev = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const ema = [prev];
    for (let i = period; i < prices.length; i++) {
      prev = prices[i] * k + prev * (1 - k);
      ema.push(prev);
    }
    return ema;
  }

  function calcRSI(prices, period = 14) {
    const rsi = [];
    let gains = 0, losses = 0;
    for (let i = 1; i < prices.length; i++) {
      const d = prices[i] - prices[i - 1];
      gains += d > 0 ? d : 0;
      losses += d < 0 ? -d : 0;
      if (i >= period) {
        rsi.push(100 - 100 / (1 + (gains / losses || 0)));
        const pv = prices[i - period + 1] - prices[i - period];
        gains -= pv > 0 ? pv : 0;
        losses += pv < 0 ? -pv : 0;
      }
    }
    return rsi;
  }

  function calcBollingerBands(prices, period = 20, stdDev = 2) {
    const upper = [], middle = [], lower = [];
    for (let i = 0; i < prices.length; i++) {
      if (i < period - 1) {
        upper.push(null); middle.push(null); lower.push(null);
      } else {
        const slice = prices.slice(i - period + 1, i + 1);
        const avg = slice.reduce((a, b) => a + b, 0) / period;
        const variance = slice.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / period;
        const std = Math.sqrt(variance);
        middle.push(avg);
        upper.push(avg + stdDev * std);
        lower.push(avg - stdDev * std);
      }
    }
    return { upper, middle, lower };
  }

  function calcOHLC(prices, groupSize = 24) {
    const ohlc = [];
    const period = Math.max(1, groupSize | 0);
    for (let i = 0; i < prices.length; i += period) {
      const slice = prices.slice(i, Math.min(i + period, prices.length));
      if (slice.length === 0) continue;
      ohlc.push({ open: slice[0], high: Math.max(...slice), low: Math.min(...slice), close: slice[slice.length - 1] });
    }
    return ohlc;
  }

  async function loadChart() {
    if (!lastQueriedChartCoin) return;
    const currency = $('chartCurrency')?.value || 'usd';
    const vsCurr = currency === 'usdt' ? 'usd' : currency;
    const range = $('chartRange')?.value || '7';
    const isStock = currentType === 'stock';
    const url = isStock ? `/api/stocks/${lastQueriedChartCoin}/chart?days=${range}` : `/api/coins/${lastQueriedChartCoin}/chart?days=${range}&currency=${vsCurr}`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.prices?.length) throw new Error('No chart data');
      const prices = data.prices.map(p => p[1]);

      if (!isStock && prices.length > 0) {
        const currentCoin = allCoins.find(c => (c.id && c.id === lastQueriedChartCoin) || (c.symbol && c.symbol.toLowerCase() === lastQueriedChartCoin));
        if (currentCoin && currentCoin.current_price != null) {
          const lastChartPrice = prices[prices.length - 1];
          if (lastChartPrice > 0) {
            const ratio = currentCoin.current_price / lastChartPrice;
            for (let i = 0; i < prices.length; i++) prices[i] *= ratio;
          }
        }
      }

      const timestamps = data.prices.map(p => p[0]);
      const volumes = (data.total_volumes || []).map(v => v[1]);
      const r = parseInt(range, 10) || 7;
      const labels = timestamps.map(ts => {
        const d = new Date(ts);
        if (r <= 1) return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
        else if (r <= 7) return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
        else return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
      });

      const pfx = currency === 'inr' ? '₹' : currency === 'usdt' ? '₮' : '$';

      const sma20 = activeIndicators.sma ? calcSMA(prices, indicatorPeriods.sma) : null;
      const ema20 = activeIndicators.ema ? calcEMA(prices, indicatorPeriods.ema) : null;
      const rsi = activeIndicators.rsi ? calcRSI(prices, indicatorPeriods.rsi) : null;
      const bb = activeIndicators.bb ? calcBollingerBands(prices, indicatorPeriods.bb) : null;

      const targetCandles = 48;
      const groupSize = Math.max(1, Math.floor(prices.length / targetCandles));
      const ohlc = activeIndicators.ohlc ? calcOHLC(prices, groupSize) : null;

      let indText = [];
      if (activeIndicators.sma && sma20) indText.push(`SMA(${indicatorPeriods.sma}): ${sma20.at(-1)?.toFixed(2) ?? 'N/A'}`);
      if (activeIndicators.ema && ema20) indText.push(`EMA(${indicatorPeriods.ema}): ${ema20.at(-1)?.toFixed(2) ?? 'N/A'}`);
      if (activeIndicators.rsi && rsi) indText.push(`RSI(${indicatorPeriods.rsi}): ${rsi.at(-1)?.toFixed(1) ?? 'N/A'}`);
      if (activeIndicators.volume && volumes && volumes.length) {
        const lastVol = volumes[volumes.length - 1];
        indText.push(`Vol: ${(lastVol / 1e6).toFixed(1)}M`);
      }
      const indEl = $('indicatorValues');
      if (indEl) indEl.innerHTML = indText.join(' &nbsp;&nbsp;·&nbsp;&nbsp; ');

      if (chartInstance) chartInstance.destroy();
      const priceChartEl = $('priceChart');
      if (!priceChartEl) return;

      const datasets = [];

      if (activeIndicators.ohlc && ohlc && ohlc.length > 0) {
        const highSeries = [];
        const lowSeries = [];
        ohlc.forEach((c, i) => {
          const idx = Math.min(i * groupSize, labels.length - 1);
          highSeries[idx] = c.high;
          lowSeries[idx] = c.low;
        });
        datasets.push({ label: 'Price', data: prices, borderColor: '#00e5a0', backgroundColor: 'rgba(0,229,160,0.08)', borderWidth: 2.5, fill: true, tension: 0.2, pointRadius: 0 });
        datasets.push({ label: 'High', data: highSeries, borderColor: 'rgba(0, 191, 255, 0.55)', borderWidth: 1, borderDash: [2, 3], pointRadius: 0, fill: false });
        datasets.push({ label: 'Low', data: lowSeries, borderColor: 'rgba(255, 71, 87, 0.55)', borderWidth: 1, borderDash: [2, 3], pointRadius: 0, fill: false });
      } else {
        datasets.push({ label: 'Price', data: prices, borderColor: '#00e5a0', backgroundColor: 'rgba(0,229,160,0.07)', borderWidth: 2, fill: true, tension: 0.25, pointRadius: 0 });
      }

      if (activeIndicators.sma && sma20) datasets.push({ label: 'SMA', type: 'line', data: sma20, borderColor: '#00bfff', borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0, fill: false });
      if (activeIndicators.ema && ema20) datasets.push({ label: 'EMA', type: 'line', data: ema20, borderColor: '#ff6b6b', borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0, fill: false });
      if (activeIndicators.bb && bb) {
        datasets.push({ label: 'BB Upper', type: 'line', data: bb.upper, borderColor: 'rgba(168,85,247,0.65)', borderWidth: 1, borderDash: [2, 4], pointRadius: 0, fill: false });
        datasets.push({ label: 'BB Mid', type: 'line', data: bb.middle, borderColor: 'rgba(168,85,247,0.4)', borderWidth: 1, borderDash: [2, 2], pointRadius: 0, fill: false });
        datasets.push({ label: 'BB Lower', type: 'line', data: bb.lower, borderColor: 'rgba(168,85,247,0.65)', borderWidth: 1, borderDash: [2, 4], pointRadius: 0, fill: false });
      }

      if (activeIndicators.volume && volumes && volumes.length > 0) {
        const volData = volumes.map((v, i) => ({ x: labels[Math.min(i, labels.length - 1)], y: v }));
        datasets.push({ label: 'Volume', type: 'bar', data: volData, backgroundColor: 'rgba(100, 149, 237, 0.25)', borderColor: 'rgba(100, 149, 237, 0.5)', borderWidth: 1, yAxisID: 'volume', barThickness: 3 });
      }

      const crosshairPlugin = {
        id: 'crosshair',
        afterDatasetsDraw(chart) {
          const { ctx, tooltip, chartArea } = chart;
          if (!tooltip || !tooltip._active || !tooltip._active.length) return;
          const activePoint = tooltip._active[0];
          const x = activePoint.element.x;
          const y = activePoint.element.y;
          ctx.save();
          ctx.strokeStyle = 'rgba(0, 229, 160, 0.4)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y); ctx.stroke();
          ctx.restore();
        }
      };

      chartInstance = new Chart(priceChartEl, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#e8f0fe', font: { size: 10, family: 'DM Sans' } }, onClick: Chart.defaults.plugins.legend.onClick },
            tooltip: {
              mode: 'index',
              intersect: false,
              backgroundColor: 'rgba(14,12,20,0.94)',
              titleColor: '#00e5a0',
              bodyColor: '#e8f0fe',
              borderColor: 'rgba(0,229,160,0.3)',
              borderWidth: 1,
              callbacks: { label(ctx) { const val = ctx.raw; const num = (typeof val === 'number') ? val : (val && val.y != null ? val.y : val); return `${ctx.dataset.label}: ${pfx}${Number(num).toLocaleString('en-US', { maximumFractionDigits: 2 })}`; } }
            }
          },
          scales: {
            x: { grid: { color: 'rgba(255,255,255,0.05)' }, offset: true, ticks: { color: '#7a8fa6', maxRotation: 0, autoSkip: true, maxTicksLimit: (r <= 1 ? 10 : r <= 7 ? 8 : r <= 30 ? 7 : 6), padding: 8, font: { size: 10, family: 'DM Sans' } }, border: { display: false } },
            y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#7a8fa6', callback: v => `${pfx}${v.toLocaleString()}` }, border: { display: false }, position: 'left' },
            volume: { type: 'linear', position: 'right', grid: { color: 'rgba(255,255,255,0.03)', drawOnChartArea: false }, ticks: { color: '#7a8fa6', callback: v => (v / 1e6).toFixed(1) + 'M' }, border: { display: false }, display: activeIndicators.volume }
          },
          interaction: { mode: 'nearest', axis: 'x' }
        },
        plugins: [crosshairPlugin]
      });
    } catch (err) {
      console.error('[chart]', err);
      const indEl = $('indicatorValues');
      if (indEl) indEl.textContent = 'Chart unavailable — try a different range.';
    }
  }

  function toggleIndicator(ind, btn) {
    const wasActive = activeIndicators[ind];
    document.querySelectorAll('.ind-btn').forEach(b => b.classList.remove('active'));
    if (!wasActive) {
      activeIndicators[ind] = true;
      btn.classList.add('active');
    } else {
      activeIndicators[ind] = false;
    }
    if (document.querySelectorAll('.ind-btn.active').length === 0) {
      activeIndicators.ohlc = true;
      const def = document.querySelector('.ind-btn[data-indicator="ohlc"]');
      if (def) def.classList.add('active');
    }
    loadChart();
  }

  async function openChartModal(coinId, coinName) {
    lastQueriedChartCoin = coinId;
    const ct = $('chartTitle');
    if (ct) ct.textContent = `${coinName} — Live Chart`;
    activeIndicators = { ohlc: true, sma: true, ema: false, rsi: false, bb: false, volume: false };
    document.querySelectorAll('.ind-btn').forEach(btn => {
      const key = btn.getAttribute('data-indicator');
      btn.classList.toggle('active', !!activeIndicators[key]);
    });
    $('chartModal')?.classList.add('open');
    await loadChart();
  }

  function closeChartModal() {
    $('chartModal')?.classList.remove('open');
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    lastQueriedChartCoin = null;
  }

  let currentAlertSymbol = '';

  function openAlertModal(sym, price) {
    if (!window.stockwise?.currentUser()) { window.stockwise?.openAuth('login'); return; }
    currentAlertSymbol = sym;
    const sl = $('alertSymbolLabel'); if (sl) sl.textContent = sym;
    const ap = $('alertPrice'); if (ap) ap.value = price ?? '';
    const ae = $('alertErr'); if (ae) ae.textContent = '';
    $('alertModal')?.classList.add('open');
  }

  function closeAlertModal() { $('alertModal')?.classList.remove('open'); }

  async function saveAlert() {
    const price = parseFloat($('alertPrice')?.value);
    const dir = $('alertDir')?.value;
    const errEl = $('alertErr'); if (!errEl) return;
    if (!price || price <= 0) { errEl.textContent = 'Enter a valid price'; return; }
    const res = await fetch('/api/alerts', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: currentAlertSymbol, target_price: price, direction: dir }) });
    const data = await res.json();
    if (data.success) { closeAlertModal(); window.stockwise?.toast(`Alert set for ${currentAlertSymbol} 🔔`, 'success'); }
    else { errEl.textContent = data.error || 'Failed to save alert'; }
  }

  function fmtPrice(p, currency) {
    if (p == null || p === '') return '\u2014';
    const locale = currency === 'inr' ? 'en-IN' : 'en-US';
    if (p >= 10000) return p.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    if (p >= 1000) return p.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p >= 1) return p.toFixed(4);
    return p.toFixed(6);
  }

  function fmtM(n, currency) {
    const pfx = currency === 'inr' ? '₹' : currency === 'usdt' ? '₮' : '$';
    if (!n || n === 0) return pfx + '0';
    if (n >= 1e12) return pfx + (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return pfx + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return pfx + (n / 1e6).toFixed(2) + 'M';
    return pfx + n.toLocaleString();
  }

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function escAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadProfileSidebar() {
    try {
      const res = await fetch('/api/me', { credentials: 'include' });
      const me = await res.json();
      if (!res.ok || !me.loggedIn) return;
      const pn = $('profileName'); if (pn) pn.textContent = me.username || 'User';
      const pe = $('profileEmail'); if (pe) pe.textContent = me.email || '';
      const avEl = $('profileAvatar');
      if (avEl && window.stockwise?.auSvg) {
        const av = me.avatar || {};
        avEl.innerHTML = window.stockwise.auSvg(me.username || 'U', { bg_color: av.bg_color || '#00e5a0', texture: av.texture || 'solid', accessory: av.accessory || 'none', energy: av.energy || 'none' });
        avEl.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:0;border-radius:16px;background:transparent;';
      }
      const [pRes, aRes] = await Promise.all([fetch('/api/portfolio', { credentials: 'include' }), fetch('/api/alerts', { credentials: 'include' })]);
      const portfolios = pRes.ok ? await pRes.json() : [];
      const alerts = aRes.ok ? await aRes.json() : [];
      const sp = $('sStatPortfolio'); if (sp) sp.textContent = portfolios.length;
      const sa = $('sStatAlerts'); if (sa) sa.textContent = alerts.length;
      if (me.created_at) {
        const days = Math.max(1, Math.floor((Date.now() - new Date(me.created_at)) / 864e5));
        const el = $('sStatDays'); if (el) el.textContent = days + (days === 1 ? ' day' : ' days');
      }
    } catch (_) {}
  }

  function onDocumentKeydown(e) {
    if (e.key === 'Escape') { closeAlertModal(); closeChartModal(); }
  }

  function setAutoRefresh() {
    setInterval(() => {
      if (currentType === 'stock') loadStocks(currentStockCategory, true);
      else loadPrices(currentCryptoCategory, true);
    }, 25000);
  }

  async function loadAll() {
    showShimmer();
    await Promise.allSettled([loadPrices(currentCryptoCategory, true), loadStocks(currentStockCategory, true)]);
    filterTable();
  }

  function boot() {
    loadProfileSidebar();
    const p = new URLSearchParams(location.search);
    const initType = (p.get('type') === 'stock' || p.get('type') === 'crypto') ? p.get('type') : 'all';
    document.querySelectorAll('.view-btn').forEach(b => {
      const t = b.getAttribute('onclick') || '';
      b.classList.toggle('active', t.includes(`'${initType}'`));
    });
    if (initType === 'stock') { currentType = 'stock'; loadStocks(); }
    else if (initType === 'crypto') { currentType = 'crypto'; loadPrices(); }
    else { currentType = 'all'; loadAll(); }
    updateCategoryBar(currentType);
    setAutoRefresh();
  }

  document.addEventListener('DOMContentLoaded', boot);
  document.addEventListener('keydown', onDocumentKeydown, true);

  window.$$sort = setSort;
  window.$$switchType = switchType;
  window.$$setCryptoCat = (cat, btn) => { changeCryptoCategory(cat, btn); };
  window.$$setStockCat = (cat, btn) => { changeStockCategory(cat, btn); };
  window.$$changeCurrency = changeCurrency;
  window.$$toggleFav = toggleFavMode;
  window.$$filter = filterTable;
  window.$$renderTable = renderTable;

  window.loadPrices = loadPrices;
  window.loadStocks = loadStocks;
  window.openChartModal = openChartModal;
  window.closeChartModal = closeChartModal;
  window.loadChart = loadChart;
  window.openAlertModal = openAlertModal;
  window.closeAlertModal = closeAlertModal;
  window.saveAlert = saveAlert;
  window.toggleFav = toggleFav;
  window.toggleFavMode = toggleFavMode;
  window.setSort = setSort;
  window.switchType = switchType;
  window.changeCryptoCategory = changeCryptoCategory;
  window.changeStockCategory = changeStockCategory;
  window.filterTable = filterTable;
  window.changeCurrency = changeCurrency;
  window.toggleIndicator = toggleIndicator;
  window.forceFreshRefresh = forceFreshRefresh;

  function changeCurrency() {
    if (currentType === 'stock') loadStocks(null, true);
    else loadPrices(currentCryptoCategory, true);
  }
  window.changeCurrency = changeCurrency;

  function forceFreshRefresh() {
    if (currentType === 'stock') loadStocks(currentStockCategory, true);
    else if (currentType === 'crypto') loadPrices(currentCryptoCategory, true);
    else loadAllWithFresh();
  }

  async function loadAllWithFresh() {
    showShimmer();
    await Promise.allSettled([loadPrices(currentCryptoCategory, true), loadStocks(currentStockCategory, true)]);
    filterTable();
  }

})();

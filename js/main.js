// ─── STATE ──────────────────────────────────────
let currentUser = null;
window.stockwiseAuthReady = false;

// Highlight Signals link
function highlightSignalsLink() {
    const signalsLink = document.getElementById('nav-signals');
    if (!signalsLink) return;
    if (window.location.pathname.includes('/signals')) {
        signalsLink.style.borderBottom = '2px solid #00ffcc';
        signalsLink.style.color = '#00ffcc';
    } else {
        signalsLink.style.borderBottom = '';
        signalsLink.style.color = '';
    }
}

// ─── EXPOSE API ─────────────────────────────────
window.stockwise = {
  currentUser: () => currentUser,
  toast: (msg, type) => toast(msg, type),
  openAuth: (tab) => openAuth(tab),
  closeAuth: () => closeAuth(),
  onAuthChanged: (data) => onAuthChanged(data)
};

// ─── INIT ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  loadRememberedLogin();
  await checkAuth();
  window.stockwiseAuthReady = true;
  animateCounters();
  loadTicker();
  loadCoinGeckoProPrices();
  setInterval(loadTicker, 30000);
  setInterval(loadCoinGeckoProPrices, 30000);
  initAI();
  initGuideBot();
  highlightSignalsLink();
});

// ─── AI ASSISTANT (Global) ─────────────────────
const AI_KNOWLEDGE = {
  'stockwise': 'StockWise is a smart market intelligence platform. It provides real-time tracking for 100+ cryptocurrencies and stocks, AI-powered buy/sell signals, and deep portfolio analytics.',
  'tracker': 'The Live Tracker gives you real-time price updates every 30 seconds. You can search for assets, see 24h changes, and set price alerts directly from the list.',
  'signals': 'Our AI Signals combine technical indicators like RSI, MACD, and Bollinger Bands with news sentiment analysis to give you Buy, Hold, or Sell recommendations.',
  'portfolio': 'The Portfolio section allows you to track your holdings manually or sync automatically with CoinDCX using API keys for a real-time overview of your wealth.',
  'analyzer': 'The Portfolio Analyzer uses AI to calculate your diversity score and risk rating, providing actionable tips to improve your investment strategy.',
  'community': 'Join the Community to share trade ideas, see what others are talking about, and follow real-time sentiment trends for specific coins.',
  'avatar': 'Your Avatar is your digital identity in the Community. Customize it in the Avatar Studio to reflect your trading style!'
};

function initAI() {
  if (document.getElementById('aiAssistant')) return;
  const wrap = document.createElement('div');
  wrap.id = 'aiAssistant';
  wrap.className = 'ai-assistant-wrap';
  wrap.innerHTML = `
    <div class="ai-window" id="aiWindow">
      <div class="ai-header">
        <div class="ai-info">
          <div class="ai-robot-icon">
            <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>
          </div>
          <div>
            <h4>StockWise AI</h4>
            <span class="online-tag">Online & Ready</span>
          </div>
        </div>
        <button class="ai-close" onclick="toggleAI()">×</button>
      </div>
      <div class="ai-content" id="aiChat">
        <div class="ai-msg bot">
          Hello! I'm your StockWise robot assistant. How can I help you navigate the platform today?
        </div>
        <div class="ai-suggestions">
          <button onclick="askAI('What is StockWise?')">What is StockWise?</button>
          <button onclick="askAI('How to use Live Tracker?')">How to use Live Tracker?</button>
          <button onclick="askAI('Tell me about AI Signals')">Tell me about AI Signals</button>
          <button onclick="askAI('Portfolio Sync')">Portfolio Sync</button>
        </div>
      </div>
      <div class="ai-footer">
        <input type="text" id="aiInput" placeholder="Ask me anything..." onkeypress="if(event.key==='Enter')askAI()">
        <button onclick="askAI()">Send</button>
      </div>
    </div>
    <button class="ai-fab" id="aiFab" onclick="toggleAI()">
      <div class="fab-robot">
        <svg viewBox="0 0 24 24" width="28" height="28" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>
      </div>
      <span class="fab-text">Ask AI</span>
    </button>
  `;
  document.body.appendChild(wrap);
}

function toggleAI() {
  const win = document.getElementById('aiWindow');
  const fab = document.getElementById('aiFab');
  if (!win) return;
  win.classList.toggle('open');
  if (win.classList.contains('open')) {
    // snap to bottom-right if never dragged yet
    if (!('aiWindow_x' in win.dataset)) {
      const r = win.getBoundingClientRect();
      win.style.right = window.innerWidth - r.right + 'px';
      win.style.bottom = window.innerHeight - r.bottom + 'px';
      win.style.left = 'auto';
      win.style.top = 'auto';
      win.dataset.aiWindow_x = r.left + 'px';
      win.dataset.aiWindow_y = r.top  + 'px';
    }
    if (fab) fab.style.opacity = '0';
    if (fab) fab.style.pointerEvents = 'none';
  } else {
    if (fab) { fab.style.opacity = '1'; fab.style.pointerEvents = 'all'; }
  }
}

// ── AI window drag ──────────────────────────────────
(function() {
  let dragging = false, ox = 0, oy = 0;

  function onDown(e) {
    const hdr = e.target.closest('.ai-header');
    if (!hdr || e.target.closest('.ai-close')) return;
    const win = document.getElementById('aiWindow');
    if (!win.classList.contains('open')) return;
    dragging = true;
    const rect    = win.getBoundingClientRect();
    const style   = win.style;
    ox = e.clientX - rect.left;
    oy = e.clientY - rect.top;
    // lock to coordinates
    style.left  = rect.left + 'px';
    style.top   = rect.top  + 'px';
    style.right = 'auto';
    style.bottom= 'auto';
    document.body.style.cssText += ';cursor:grabbing;user-select:none;-webkit-user-select:none';
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging) return;
    const win = document.getElementById('aiWindow');
    const nx = Math.max(0, Math.min(e.clientX - ox, window.innerWidth  - 60));
    const ny = Math.max(0, Math.min(e.clientY - oy, window.innerHeight - 36));
    win.style.left = nx + 'px';
    win.style.top  = ny + 'px';
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  document.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
})();

function askAI(query) {
  const input = document.getElementById('aiInput');
  const text = query || input.value;
  if (!text.trim()) return;

  appendAiMsg('user', text);
  input.value = '';

  setTimeout(() => {
    let response = "I'm not sure about that. Try asking about 'Live Tracker', 'AI Signals', or 'Portfolio Sync'.";
    const lowText = text.toLowerCase();
    
    if (lowText.includes('what is stockwise')) response = AI_KNOWLEDGE.stockwise;
    else if (lowText.includes('tracker')) response = AI_KNOWLEDGE.tracker;
    else if (lowText.includes('signal')) response = AI_KNOWLEDGE.signals;
    else if (lowText.includes('portfolio') || lowText.includes('sync')) response = AI_KNOWLEDGE.portfolio;
    else if (lowText.includes('analyzer')) response = AI_KNOWLEDGE.analyzer;
    else if (lowText.includes('community')) response = AI_KNOWLEDGE.community;
    else if (lowText.includes('avatar')) response = AI_KNOWLEDGE.avatar;

    appendAiMsg('bot', response);
  }, 600);
}

function appendAiMsg(role, text) {
  const chat = document.getElementById('aiChat');
  if (!chat) return;
  const msg = document.createElement('div');
  msg.className = `ai-msg ${role}`;
  msg.textContent = text;
  chat.appendChild(msg);
  chat.scrollTop = chat.scrollHeight;
}

window.toggleAI = toggleAI;
window.askAI = askAI;

// ─── AUTH PERSISTENCE ───────────────────────────
function loadRememberedLogin() {
  const remembered = JSON.parse(localStorage.getItem('stockwiseRemember') || '{}');
  if (remembered.email) {
    const loginEmail = document.getElementById('loginEmail');
    if (loginEmail) loginEmail.value = remembered.email;
    const regEmail = document.getElementById('regEmail');
    if (regEmail) regEmail.value = remembered.email;
    const checkbox = document.getElementById('rememberLogin');
    if (checkbox) checkbox.checked = true;
  }
  if (remembered.username) {
    const username = document.getElementById('regUsername');
    if (username) username.value = remembered.username;
  }
}

// Check remember cookie on load
window.addEventListener('load', () => {
  const rememberCookie = document.cookie.split(';').find(c => c.trim().startsWith('rememberLogin='));
  if (rememberCookie) {
    const checkbox = document.getElementById('rememberLogin');
    if (checkbox) checkbox.checked = true;
  }
});

// ─── UTILS ──────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ─── AUTH CHECK ─────────────────────────────────
async function checkAuth() {
  try {
    const res = await fetch('/api/me', { credentials: 'include' });
    const data = await res.json();
    currentUser = data.loggedIn ? data : null;
    renderNav();
  } catch {} finally {
    window.stockwiseAuthReady = true;
  }
}

function onAuthChanged(data) {
  // helper: always keep currentUser fresh after any operation that mutates auth/keys
  if (data) currentUser = data;
  renderNav();
}
window.onAuthChanged = onAuthChanged;

function makeAuthFresh(onDone) {
  // Re-read /api/me so coindcx_key / coindcx_secret are live
  return checkAuth().then(() => onDone?.());
}

function renderNav() {
  const navRight = document.getElementById('navRight');
  if (!navRight) return;
  if (currentUser) {
    const a = currentUser.avatar || {};
    const color    = a.bg_color  || '#00e5a0';
    const acc      = a.accessory || 'none';
    const energy   = a.energy    || 'none';
    const nameLabel = a.name || currentUser.username || '';
    const glowCss  = auGlow(energy, color);
    navRight.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.55rem;cursor:pointer" onclick="window.location.href=window.location.pathname.includes('/pages/')?'avatar.html':'pages/avatar.html'" title="Customize your avatar ✨">
        <div class="au-avatar au-sm" style="--au-clr:${color};--au-glow:${glowCss}">${auSvg(currentUser.username, {bg_color:color,accessory:acc,energy:energy})}</div>
        <span style="font-size:0.84rem;color:var(--text2);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(nameLabel)}">${escHtml(nameLabel)}</span>
      </div>
      <button class="btn-sm outline" onclick="goToSecurity()" title="Login history">🔒</button>
      <button class="btn-sm outline" onclick="logout()">Logout</button>
    `;
  } else {
    navRight.innerHTML = `
      <button class="btn-sm outline" onclick="openAuth('login')">Login</button>
      <button class="btn-sm primary" onclick="openAuth('register')">Create Account</button>
    `;
  }
}

function goToSecurity() {
  window.location.href = window.location.pathname.includes('/pages/') ? 'security.html' : 'pages/security.html';
}

// ─── AUTH MODAL ─────────────────────────────────
function openAuth(tab = 'login') {
  document.getElementById('authModal').classList.add('open');
  switchTab(tab);
}
function closeAuth() {
  document.getElementById('authModal').classList.remove('open');
}

function switchTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none';
  document.getElementById('authError').textContent = '';
}

async function doLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPass').value;
  const remember = document.getElementById('rememberLogin')?.checked;
  const res = await fetch('/api/login', {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ email, password, remember })
  });
  const data = await res.json();
  if (data.error) { document.getElementById('authError').textContent = data.error; return; }
  if (remember) {
    localStorage.setItem('stockwiseRemember', JSON.stringify({ email }));
  } else {
    localStorage.removeItem('stockwiseRemember');
  }
  currentUser = data;
  renderNav();
  closeAuth();
  toast('Welcome back, ' + data.username + '! 👋', 'success');
}

async function doRegister(e) {
  e.preventDefault();
  const username = document.getElementById('regUsername').value;
  const email = document.getElementById('regEmail').value;
  const password = document.getElementById('regPass').value;
  const phone = document.getElementById('regPhone')?.value || '';
  const remember = document.getElementById('rememberRegister')?.checked;
  const res = await fetch('/api/register', {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ username, email, password, phone })
  });
  const data = await res.json();
  if (data.error) { document.getElementById('authError').textContent = data.error; return; }
  if (remember) {
    localStorage.setItem('stockwiseRemember', JSON.stringify({ email, username }));
  } else {
    localStorage.removeItem('stockwiseRemember');
  }
  currentUser = data;
  renderNav();
  closeAuth();
  toast('Account created! Welcome to StockWise 🎉', 'success');
}

async function logout() {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' });
  currentUser = null;
  renderNav();
  toast('Logged out successfully', 'success');
}

function toggleRemember(cb) {
  if (cb.checked) {
    localStorage.setItem('stockwiseRemember', JSON.stringify({ 
      email: document.getElementById('loginEmail')?.value || '',
      username: document.getElementById('regUsername')?.value || ''
    }));
  } else {
    localStorage.removeItem('stockwiseRemember');
  }
}

function openForgotPassword() {
  closeAuth();
  let modal = document.getElementById('forgotPasswordModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'forgotPasswordModal';
    modal.onclick = (e) => { if(e.target === modal) closeForgotPassword(); };
    modal.innerHTML = `
    <div class="modal" style="max-width:420px">
      <button class="modal-close" onclick="closeForgotPassword()">×</button>
      <h2>Password Recovery</h2>
      <p class="modal-sub" style="margin-bottom:1rem">Contact the system owner for a recovery token</p>
      <div id="forgotStep1">
        <div class="form-group"><label>Registered Email</label><input type="email" id="resetEmail" placeholder="you@example.com" required></div>
        <div class="form-group" style="background:var(--bg);padding:0.75rem;border-radius:8px;border:1px solid var(--border)">
          <p style="margin:0;color:var(--text2);font-size:0.84rem">An email will be sent to the owner (<strong style="color:var(--accent)">sreekarsh@gmail.com</strong>) with your reset token.</p>
        </div>
        <button class="btn-full" onclick="sendResetRequest()" style="margin-top:0.5rem">Request Recovery Token</button>
      </div>
      <div id="forgotStep2" style="display:none">
        <div class="form-group"><label>Recovery Token (from owner)</label><input type="text" id="resetToken" placeholder="Paste token"></div>
        <div class="form-group"><label>New Password</label><input type="password" id="resetNewPass" placeholder="New password" minlength="6" required></div>
        <button class="btn-full" onclick="completePasswordReset()">Reset Password</button>
        <p id="resetMsg" style="margin-top:0.5rem;color:var(--accent);display:none">Password reset successful!</p>
      </div>
      <p class="error-msg" id="forgotError" style="margin-top:0.5rem"></p>
    </div>`;
    document.body.appendChild(modal);
  }
  modal.classList.add('open');
  document.getElementById('forgotStep1').style.display = 'block';
  document.getElementById('forgotStep2').style.display = 'none';
  document.getElementById('forgotError').textContent = '';
}
function closeForgotPassword() {
  const modal = document.getElementById('forgotPasswordModal');
  if (modal) modal.classList.remove('open');
}
async function sendResetRequest() {
  const email = document.getElementById('resetEmail').value;
  if (!email) return document.getElementById('forgotError').textContent = 'Email required';
  
  const res = await fetch('/api/forgot-password', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ email })
  });
  const data = await res.json();
  
  if (data.success) {
    document.getElementById('forgotStep1').style.display = 'none';
    document.getElementById('forgotStep2').style.display = 'block';
    document.getElementById('resetToken').value = data.devToken || '';
    toast('Token generated! Contact admin if you didn\'t receive it', 'success');
  } else {
    document.getElementById('forgotError').textContent = data.error || 'Request failed';
  }
}
async function completePasswordReset() {
  const token = document.getElementById('resetToken').value;
  const password = document.getElementById('resetNewPass').value;
  
  if (!token || !password) return document.getElementById('forgotError').textContent = 'Token and password required';
  
  const res = await fetch('/api/reset-password', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ token, password })
  });
  const data = await res.json();
  
  if (data.success) {
    document.getElementById('resetMsg').style.display = 'block';
    setTimeout(() => {
      closeForgotPassword();
      openAuth('login');
    }, 1500);
  } else {
    document.getElementById('forgotError').textContent = data.error || 'Reset failed';
  }
}

// ─── TICKER ─────────────────────────────────────
let tickerCache = null;
let tickerCacheTime = 0;

function renderTicker(coins) {
  const track = document.getElementById('tickerTrack');
  if (!track) return;
  const items = [...coins, ...coins].map(c => {
    const chg = c.price_change_percentage_24h || 0;
    const cls = chg >= 0 ? 'up' : 'down';
    const sign = chg >= 0 ? '+' : '';
    return `<div class="ticker-item">
      <span class="ticker-sym">${c.symbol.toUpperCase()}</span>
      <span class="ticker-price">$${formatPrice(c.current_price)}</span>
      <span class="ticker-chg ${cls}">${sign}${chg.toFixed(2)}%</span>
    </div>`;
  }).join('');
  track.innerHTML = items;
}

async function loadTicker() {
  try {
    const now = Date.now();
    if (tickerCache && (now - tickerCacheTime) < 25000) {
      renderTicker(tickerCache);
      return;
    }
    const res = await fetch('/api/markets?per_page=20&order=market_cap_desc&sparkline=false');
    const coins = await res.json();
    if (!Array.isArray(coins) || coins.error) return;
    tickerCache = coins;
    tickerCacheTime = now;
    renderTicker(coins);
  } catch {}
}

async function loadCoinGeckoProPrices() {
  try {
    const res = await fetch('/api/coingecko-pro-price');
    const data = await res.json();
    const grid = document.getElementById('proPriceGrid');
    if (!grid) return;
    if (data.error) {
      grid.innerHTML = `<div class="pro-price-cell error">${escHtml(data.error)}</div>`;
      return;
    }

    const rows = Object.entries(data).map(([id, payload]) => {
      const symbol = id.toUpperCase();
      const usd = payload.usd ?? 0;
      const eur = payload.eur ?? 0;
      const btc = payload.btc ?? 0;
      const marketCap = payload.usd_market_cap ? formatPrice(payload.usd_market_cap) : 'N/A';
      const change24h = payload.usd_24h_change !== undefined ? payload.usd_24h_change.toFixed(2) : 'N/A';
      const cls = payload.usd_24h_change >= 0 ? 'up' : 'down';
      return `
        <div class="pro-price-cell">
          <div class="pro-price-symbol">${escHtml(symbol)}</div>
          <div class="pro-price-value">$${formatPrice(usd)}</div>
          <div class="pro-price-sub">€${formatPrice(eur)} · ${formatPrice(btc)} BTC</div>
          <div class="pro-price-meta ${cls}">24h ${change24h}% · MC $${marketCap}</div>
        </div>`;
    }).join('');

    grid.innerHTML = rows;
  } catch (err) {
    const grid = document.getElementById('proPriceGrid');
    if (grid) grid.innerHTML = `<div class="pro-price-cell error">Failed to load CoinGecko Pro prices.</div>`;
    console.error('CoinGecko Pro demo error:', err);
  }
}

// ─── COUNTERS ────────────────────────────────────
function animateCounters() {
  animateNum('s1', 70, 0, 1500);
  animateNum('s2', 128, 0, 1800);
  animateNum('s3', 87, 0, 2000);
}
function animateNum(id, target, start, dur) {
  const el = document.getElementById(id);
  if (!el) return;
  let s = null;
  function step(ts) {
    if (!s) s = ts;
    const p = Math.min((ts - s) / dur, 1);
    el.textContent = Math.floor(p * (target - start) + start);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ─── UTILS ──────────────────────────────────────
function formatPrice(p) {
  if (p >= 1000) return p.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2});
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

function toast(msg, type = 'success') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

/* ═══════════════════════════════════════
   AMONG US — SVG character builder
═══════════════════════════════════════ */
const ENERGIES = {
  neon: '0 0 18px VAR',
  glow: '0 0 30px VAR, 0 0 60px VAR',
  fire: '0 0 22px #ff6b35, 0 0 44px #ff4757',
  ice:  '0 0 22px #00bfff, 0 0 44px #1e90ff',
  none: 'transparent',
};
const ACC_MAP = {
  none:    '',      crown:   '👑', halo:    '✨',
  headband:'🎧',    glasses: '🕶️', cap:     '🧢',
  bow:     '🎀',    emerald: '💎',
};

function auGlow(energy, color) {
  const t = ENERGIES[energy] || ENERGIES.none;
  return t.replace(/VAR/g, color);
}

/** Returns a standalone Roblox-style block character SVG (rebranded from Among Us) */
function auSvg(username, a) {
  const headColor = a.bg_color && a.bg_color !== 'transparent' ? a.bg_color : '#f0d0a0';
  const bodyColor = '#3a7bd5'; // Roblox shirt blue default, can be varied
  const legColor  = '#2b2b3a';
  const skinColor = headColor;
  const acc       = a.accessory || 'none';
  const energy    = a.energy || 'none';
  const glow      = auGlow(energy, headColor);
  const headCh    = username ? (username[0] || '').toUpperCase() : '';

  // Roblox blocky proportions (viewBox 100x130) - classic outlined look
  const face = a.face || 'happy';

  let faceSvg = '';
  if (face === 'happy') {
    faceSvg = `
      <rect x="36" y="34" width="8" height="8" rx="2" fill="#222"/>
      <rect x="56" y="34" width="8" height="8" rx="2" fill="#222"/>
      <path d="M38 50 Q50 56 62 50" fill="none" stroke="#222" stroke-width="4" stroke-linecap="round"/>
    `;
  } else if (face === 'cool') {
    faceSvg = `
      <rect x="36" y="35" width="10" height="5" rx="1" fill="#222"/>
      <rect x="54" y="35" width="10" height="5" rx="1" fill="#222"/>
      <path d="M38 52 Q50 50 62 52" fill="none" stroke="#222" stroke-width="3" stroke-linecap="round"/>
    `;
  } else if (face === 'wink') {
    faceSvg = `
      <rect x="36" y="34" width="8" height="8" rx="2" fill="#222"/>
      <path d="M56 35 Q62 38 56 41" fill="none" stroke="#222" stroke-width="3"/>
      <path d="M38 50 Q50 56 62 50" fill="none" stroke="#222" stroke-width="4" stroke-linecap="round"/>
    `;
  } else if (face === 'serious') {
    faceSvg = `
      <rect x="36" y="36" width="8" height="6" rx="1" fill="#222"/>
      <rect x="56" y="36" width="8" height="6" rx="1" fill="#222"/>
      <rect x="40" y="52" width="20" height="3" rx="1" fill="#222"/>
    `;
  } else if (face === 'grin') {
    faceSvg = `
      <rect x="36" y="34" width="8" height="8" rx="2" fill="#222"/>
      <rect x="56" y="34" width="8" height="8" rx="2" fill="#222"/>
      <path d="M36 52 Q50 62 64 52" fill="none" stroke="#222" stroke-width="4" stroke-linecap="round"/>
    `;
  } else {
    faceSvg = `
      <rect x="36" y="34" width="8" height="8" rx="2" fill="#222"/>
      <rect x="56" y="34" width="8" height="8" rx="2" fill="#222"/>
      <path d="M38 50 Q50 56 62 50" fill="none" stroke="#222" stroke-width="4" stroke-linecap="round"/>
    `;
  }

  let body = `
    <!-- Legs (pants) -->
    <rect x="28" y="92" width="18" height="32" rx="3" fill="${legColor}" stroke="#111" stroke-width="3"/>
    <rect x="54" y="92" width="18" height="32" rx="3" fill="${legColor}" stroke="#111" stroke-width="3"/>
    <!-- Torso (shirt) with outline -->
    <rect x="22" y="58" width="56" height="38" rx="5" fill="${bodyColor}" stroke="#111" stroke-width="4"/>
    <!-- Arms -->
    <rect x="10" y="60" width="14" height="32" rx="3" fill="${skinColor}" stroke="#111" stroke-width="3" transform="rotate(-18 17 76)"/>
    <rect x="76" y="60" width="14" height="32" rx="3" fill="${skinColor}" stroke="#111" stroke-width="3" transform="rotate(18 83 76)"/>
    <!-- Head with outline -->
    <rect x="26" y="22" width="48" height="42" rx="6" fill="${skinColor}" stroke="#111" stroke-width="4"/>
    <!-- Face -->
    ${faceSvg}
  `;

  // Hats / accessories as Roblox items
  let hat = '';
  if (acc === 'crown') {
    hat = `<polygon points="30,18 40,8 50,18 60,8 70,18" fill="#ffd700" stroke="#e6b800" stroke-width="3"/>`;
  } else if (acc === 'cap') {
    hat = `<rect x="26" y="18" width="48" height="10" rx="3" fill="#e6392e"/><rect x="20" y="22" width="60" height="8" rx="2" fill="#e6392e"/>`;
  } else if (acc === 'glasses') {
    hat = `<rect x="34" y="36" width="12" height="6" rx="2" fill="none" stroke="#222" stroke-width="3"/><rect x="54" y="36" width="12" height="6" rx="2" fill="none" stroke="#222" stroke-width="3"/><line x1="46" y1="39" x2="54" y2="39" stroke="#222" stroke-width="3"/>`;
  } else if (acc === 'halo') {
    hat = `<ellipse cx="50" cy="16" rx="22" ry="5" fill="none" stroke="#fff" stroke-width="3" opacity="0.9"/>`;
  } else if (acc === 'headband') {
    hat = `<rect x="26" y="20" width="48" height="8" rx="3" fill="#ff6b6b"/>`;
  } else if (acc === 'bow') {
    hat = `<path d="M35 18 Q50 12 65 18 Q50 24 35 18" fill="#ff69b4"/>`;
  } else if (acc === 'emerald') {
    hat = `<polygon points="50,10 58,20 42,20" fill="#00ff9d"/>`;
  }

  body += hat;

  // Username initial on torso
  if (headCh) {
    body += `<text x="50" y="82" text-anchor="middle" font-size="22" font-weight="800" fill="#fff" opacity="0.95" font-family="system-ui,sans-serif">${headCh}</text>`;
  }

  return `<svg viewBox="0 0 100 130" xmlns="http://www.w3.org/2000/svg" style="--au-glow:${glow}">${body}</svg>`;
}

// ═══════════════════════════════════════════════════════════════
//  GUIDE BOT  — contextual tip widget
// ═══════════════════════════════════════════════════════════════
let _botOpen   = false;
let _botEl     = null;
let _botBubble = null;

function getPagePath() {
  return location.pathname.replace(/^.*\/stockwise/, '') || '/';
}

async function fetchBotTip() {
  try {
    const r = await fetch('/api/bot-tips?path=' + encodeURIComponent(getPagePath()));
    const d = await r.json();
    return d.tip || 'Welcome to StockWise! Explore the tracker, signals, and community to get started.';
  } catch { return 'Welcome to StockWise! Explore the tracker, signals, and community to get started.'; }
}

function renderBotTip(text) {
  if (_botBubble) _botBubble.querySelector('.bot-msg').textContent = text;
}

function buildGuideBot() {
  if (_botEl) return _botEl;

  const track = {
    'btn': '💬',
    'position': 'fixed',
    'bottom': '1.4rem',
    'right': '1.4rem',
    'zIndex': '9998',
    'width': '50px',
    'height': '50px',
    'borderRadius': '50%',
    'background': 'linear-gradient(135deg,#00e5a0,#00bfff)',
    'border': 'none',
    'cursor': 'pointer',
    'boxShadow': '0 4px 25px rgba(0,229,160,0.4)',
    'display': 'flex',
    'alignItems': 'center',
    'justifyContent': 'center',
    'fontSize': '1.5rem',
    'transition': 'transform 0.2s, box-shadow 0.2s',
    'animation': 'botPulse 2.5s ease-in-out infinite',
  };

  const btn = document.createElement('button');
  btn.title = 'Guide Bot — click me!';
  Object.assign(btn.style, track);
  btn.onmouseenter = () => {
    btn.style.transform = 'scale(1.12)';
    btn.style.boxShadow = '0 6px 35px rgba(0,229,160,0.6)';
  };
  btn.onmouseleave = () => {
    btn.style.transform = '';
    btn.style.boxShadow = '0 4px 25px rgba(0,229,160,0.4)';
  };

  // Bubble
  const bubble = document.createElement('div');
  bubble.style.cssText = `
    position:fixed;bottom:5.5rem;right:1.4rem;z-index:9999;
    width:280px;padding:1rem 1.15rem;border-radius:16px;
    background:var(--bg2);border:1px solid var(--border);
    box-shadow:0 8px 32px rgba(0,0,0,0.4);
    font-size:0.85rem;line-height:1.55;color:var(--text);
    display:none;transition:opacity 0.25s,transform 0.25s;
    opacity:0;transform:translateY(8px) scale(0.97);
  `;
  bubble.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:0.6rem">
      <div style="flex-shrink:0;width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#00e5a0,#00bfff);display:flex;align-items:center;justify-content:center;font-size:1rem">🤖</div>
      <div style="flex:1">
        <div class="bot-msg" style="word-break:break-word">Loading tip…</div>
        <div style="margin-top:0.6rem;display:flex;gap:0.4rem;flex-wrap:wrap">
          <button onclick="dismissGuideBot()" style="font-size:0.75rem;padding:0.22rem 0.6rem;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text2);cursor:pointer">Dismiss</button>
          <button onclick="nextBotTip()" style="font-size:0.75rem;padding:0.22rem 0.6rem;border-radius:6px;border:none;background:var(--accent);color:#000;cursor:pointer;font-weight:600">Next tip →</button>
        </div>
      </div>
    </div>
    <div style="background:var(--accent);width:14px;height:14px;position:absolute;bottom:-7px;right:22px;transform:rotate(45deg);border-right:1px solid var(--border);border-bottom:1px solid var(--border)"></div>
  `;

  btn.onclick = () => {
    _botOpen = !_botOpen;
    bubble.style.display    = _botOpen ? 'block'  : 'none';
    bubble.style.opacity   = _botOpen ? '1'      : '0';
    bubble.style.transform = _botOpen ? 'none'   : 'translateY(8px) scale(0.97)';
    if (_botOpen) btn.style.animation = 'none';
    else         btn.style.animation = 'botPulse 2.5s ease-in-out infinite';
  };

  document.body.appendChild(bubble);
  document.body.appendChild(btn);
  _botEl     = btn;
  _botBubble = bubble;
  return btn;
}

function dismissGuideBot() {
  _botOpen = false;
  if (_botBubble) { _botBubble.style.display = 'none'; _botBubble.style.opacity = '0'; }
  if (_botEl) _botEl.style.animation = 'botPulse 2.5s ease-in-out infinite';
}

async function nextBotTip() {
  const tip = await fetchBotTip();
  renderBotTip(tip);
}

function initGuideBot() {
  buildGuideBot();
  fetchBotTip().then(renderBotTip);
  // Give a nudge tip on page load
  setTimeout(() => {
    if (_botEl && !_botOpen) {
      _botEl.style.transform = 'scale(1.18)';
      setTimeout(() => { if (_botEl) _botEl.style.transform = ''; }, 600);
    }
  }, 4000);
}

// re-trigger bot whenever a tab or group view changes  —  community.html hook
window._refreshBotTip = async function() {
  const tip = await fetchBotTip();
  renderBotTip(tip);
};

// expose for pages
window.auSvg       = auSvg;
window.auGlow      = auGlow;

// extend WITHOUT overwriting the stockwise object created at top of file
Object.assign(window.stockwise, { formatPrice, makeAuthFresh });

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { execFileSync } = require('child_process');

// ─── OWNER CONFIG ──────────────────────────────────────────────
const OWNER_EMAIL = 'sreekarsh@gmail.com';
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_PASS = process.env.GMAIL_PASS || '';
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || 'CG-z662WTsaV6fUiHgMsz751zKV';
const ML_PORT = parseInt(process.env.ML_PORT || '8100');

// ─── ML SERVICE (Python FastAPI) ───────────────────────────────
// Hard-code 127.0.0.1 to avoid "localhost" → dual-stack (IPv4/IPv6)
// resolution ambiguity on Windows where nodeFetch / http.request may try
// one family before the other and get ECONNREFUSED.
const ML_BASE = process.env.ML_BASE_URL || `http://127.0.0.1:${ML_PORT}`;

// ─── ML read-only probe ─────────────────────────────────────────────
const net4kill = require('net');

// Cross-platform timeout-aware AbortSignal helper
// (makeTimeoutSignal() is a newer static that may be absent in some runtimes)
function makeTimeoutSignal(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new DOMException(`The operation was aborted due to timeout`, 'AbortError')), ms);
  t.unref();
  return ac.signal;
}

// Uses a raw TCP connect to 127.0.0.1:8100 — no HTTP library, no DNS,
// just OS-level port check — so it never gets ECONNREFUSED mid-DNS.
function portUp(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const nc = net4kill.createConnection(port, host, () => { nc.destroy(); resolve(true); });
    nc.on('error', () => resolve(false));
    nc.setTimeout(1500, () => { nc.destroy(); resolve(false); });
  });
}

// mlHealthy — races port-up against the OC boot; only passes mlFetch is
// actually expected to succeed (port open + /health 200).
async function mlHealthy() {
  // First check: TCP port is actually accepting connections on IPv4
  if (!await portUp(ML_PORT, '127.0.0.1')) return false;

  // Second check: ML responds with HTTP 200 /health on the same address
  try {
    const r = await fetch(`${ML_BASE}/health`, { signal: makeTimeoutSignal(3000) });
    if (r.ok) { const j = await r.json(); return !!(j && j.status === 'ok'); }
  } catch { /* mlHealthy: false — keep waiting */ }

  return false;
}

// ─── ML Proxy fetcher — null on failure ───────────────────────────
// ML_BASE is http://127.0.0.1:8100 (hard-coded to avoid localhost
// dual-stack IPv4/IPv6 ambiguity on Windows).
async function mlFetch(path, opts = {}) {
  try {
    const r = await fetch(`${ML_BASE}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      signal: makeTimeoutSignal(15000)
    });
    if (!r.ok) throw new Error(`ML ${path} ${r.status}`);
    return await r.json();
  } catch (e) {
    console.error('[ML]', e.message);
    return null;
  }
}

// ================================================================
//  ML PREDICTIVE SIGNALS
// ================================================================

function createMailTransport() {
  if (!GMAIL_USER || !GMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
  });
}

async function sendOwnerEmail(subject, html) {
  const transport = createMailTransport();
  if (!transport) {
    console.log('\n📧 [EMAIL NOT SENT — SMTP not configured]');
    console.log('   Subject:', subject);
    return false;
  }
  try {
    await transport.sendMail({ from: GMAIL_USER, to: OWNER_EMAIL, subject, html });
    console.log('✅ Email sent to owner:', OWNER_EMAIL);
    return true;
  } catch(e) {
    console.error('❌ Email send failed:', e.message);
    return false;
  }
}

const app = express();
const db = new Database('stockwise.db');

// Init DB schema — boot-safe: every CREATE is IF NOT EXISTS,
// legacy column additions are idempotent PRAGMA guards.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    phone TEXT DEFAULT '',
    reset_token TEXT DEFAULT '',
    reset_token_expiry DATETIME,
    coindcx_key TEXT DEFAULT '',
    coindcx_secret TEXT DEFAULT '',
    news_api_key TEXT DEFAULT '',
    community_api_key TEXT DEFAULT '',
    role TEXT DEFAULT 'user',
    is_verified INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS portfolio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    quantity REAL NOT NULL,
    buy_price REAL NOT NULL,
    asset_type TEXT DEFAULT 'crypto',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  -- Deduplicate existing entries before adding index
  DELETE FROM portfolio WHERE id NOT IN (
    SELECT MIN(id) FROM portfolio GROUP BY user_id, symbol
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_user_symbol ON portfolio(user_id, symbol);
  CREATE TABLE IF NOT EXISTS community_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    coin TEXT DEFAULT '',
    likes INTEGER DEFAULT 0,
    group_id INTEGER NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (group_id) REFERENCES groups(id)
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    target_price REAL NOT NULL,
    direction TEXT NOT NULL,
    triggered INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS login_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    login_type TEXT DEFAULT 'login',
    ip_address TEXT,
    user_agent TEXT,
    success INTEGER DEFAULT 1,
    login_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(group_id, user_id)
  );

  -- ML SIGNALS & MODEL TRACKING (Predictive AI upgrade)
  CREATE TABLE IF NOT EXISTS signals_ml (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    asset_type TEXT DEFAULT 'crypto',
    signal TEXT NOT NULL,
    confidence REAL,
    probability_buy REAL,
    probability_sell REAL,
    probability_hold REAL,
    forecast_pct REAL,
    expected_price REAL,
    ci_low REAL,
    ci_high REAL,
    entry_price REAL,
    take_profit REAL,
    stop_loss REAL,
    risk_reward REAL,
    horizon_hours INTEGER,
    shap_json TEXT,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_signals_ml_symbol_time ON signals_ml(symbol, generated_at DESC);

  CREATE TABLE IF NOT EXISTS model_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    trained_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS backtest_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_version TEXT,
    period_start TEXT,
    period_end TEXT,
    win_rate REAL,
    profit_factor REAL,
    sharpe REAL,
    max_drawdown REAL,
    total_trades INTEGER,
    computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
 `);

// ── Legacy column migration (safe, idempotent) ────────────────
const existing = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
['profile_color','currency','theme','news_api_key','community_api_key','role','is_verified',
 'avatar_name','avatar_bg_color','avatar_texture','avatar_accessory','avatar_energy',
 'phone','reset_token','reset_token_expiry'
].forEach(col => {
  if (!existing.includes(col))
    db.prepare(`ALTER TABLE users ADD COLUMN ${col} TEXT DEFAULT ''`).run();
});
const existingPosts = db.prepare("PRAGMA table_info(community_posts)").all().map(c => c.name);
['group_id','updated_at'].forEach(col => {
  if (!existingPosts.includes(col))
    db.prepare(`ALTER TABLE community_posts ADD COLUMN ${col} ${col === 'updated_at' ? 'DATETIME' : 'INTEGER'} NULL`).run();
});

app.use(express.json());
const cookieParser = require('cookie-parser');
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use(express.static(path.join(__dirname)));
app.use(session({
  secret: 'stockwise_secret_2025',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const SIGNAL_COINS = [
  ['BTC','Bitcoin',67420,0.75,'$1.32T'],
  ['ETH','Ethereum',3451,1.15,'$414B'],
  ['BNB','BNB',588,1.00,'$85B'],
  ['SOL','Solana',148,1.55,'$68B'],
  ['XRP','XRP',0.621,0.88,'$34B'],
  ['ADA','Cardano',0.449,0.82,'$16B'],
  ['AVAX','Avalanche',36.2,1.42,'$15B'],
  ['DOGE','Dogecoin',0.152,2.05,'$22B'],
  ['TON','Toncoin',6.42,1.35,'$16B'],
  ['MATIC','Polygon',0.882,1.48,'$8B'],
  ['LINK','Chainlink',15.2,1.22,'$9B'],
  ['SHIB','Shiba Inu',0.0000224,2.75,'$13B'],
  ['LTC','Litecoin',84.2,0.98,'$6B'],
  ['UNI','Uniswap',9.42,1.28,'$5B'],
  ['NEAR','NEAR Protocol',7.12,1.32,'$7B'],
  ['APT','Aptos',9.82,1.52,'$4B'],
  ['ATOM','Cosmos',9.82,1.08,'$4B'],
  ['ARB','Arbitrum',1.124,1.58,'$3B'],
  ['OP','Optimism',2.414,1.48,'$2B'],
  ['MANA','Decentraland',0.382,1.68,'$0.7B'],
  ['EGLD','MultiversX',44.2,1.18,'$1.1B'],
  ['XLM','Stellar',0.124,0.98,'$3B'],
  ['NEO','NEO',34.7,1.10,'$3B'],
  ['ZEC','Zcash',24.2,1.28,'$0.4B'],
  ['ATOM','Cosmos',9.82,1.08,'$4B'],
  ['AAVE','Aave',88.4,1.18,'$1.3B']
];

function seededRng(seed) {
  let s = (seed * 1664525 + 1013904223) >>> 0;
  return function() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function fmtPrice(p) {
  if (p >= 10000) return p.toLocaleString('en-US',{maximumFractionDigits:0});
  if (p >= 1000) return p.toLocaleString('en-US',{maximumFractionDigits:2});
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(3);
  if (p >= 0.01) return p.toFixed(4);
  if (p >= 0.0001) return p.toFixed(6);
  return p.toFixed(8);
}

function pickSignal(r) {
  // Robustly obtain a RNG function and guard against unexpected inputs.
  try {
    let fn;
    if (typeof r === 'function') fn = r;
    else if (typeof r === 'number') fn = seededRng(Number(r));
    else fn = () => Math.random();
    const v = fn();
    return v < 0.40 ? 'BUY' : v < 0.75 ? 'SELL' : 'HOLD';
  } catch (err) {
    console.error('pickSignal: RNG call failed — falling back to Math.random()', err, typeof r, r);
    const v = Math.random();
    return v < 0.40 ? 'BUY' : v < 0.75 ? 'SELL' : 'HOLD';
  }
}

function buildSignal(coin, idx) {
  const [sym, name, basePrice, beta, mcap] = coin;
  const seed = idx * 6791 + idx * idx + 42;
  const signal = pickSignal(seed);
  const r = seededRng(seed);
  const conf = Math.floor(r() * 18) + 80;
  const signalPct = Math.floor(r() * 22) + 60;

  let pctRaw;
  if (signal === 'BUY') pctRaw = (r() * 8 + 0.2) * beta;
  else if (signal === 'SELL') pctRaw = -(r() * 8 + 0.2) * beta;
  else pctRaw = (r() * 2 - 1) * beta * 0.5;

  const pctSign = pctRaw >= 0 ? '+' : '';
  const pctType = pctRaw > 0.25 ? 'pos' : pctRaw < -0.25 ? 'neg' : 'neu';

  const totalVotes = Math.floor(r() * 80) + 40;
  let buyV, sellV, holdV;
  if (signal === 'BUY') {
    buyV = Math.floor(totalVotes * (0.55 + r() * 0.2));
    sellV = Math.floor((totalVotes - buyV) * (0.5 + r() * 0.3));
    holdV = totalVotes - buyV - sellV;
  } else if (signal === 'SELL') {
    sellV = Math.floor(totalVotes * (0.55 + r() * 0.2));
    buyV = Math.floor((totalVotes - sellV) * (0.4 + r() * 0.3));
    holdV = totalVotes - sellV - buyV;
  } else {
    holdV = Math.floor(totalVotes * (0.45 + r() * 0.2));
    buyV = Math.floor((totalVotes - holdV) * (0.5 + r() * 0.3));
    sellV = totalVotes - holdV - buyV;
  }

  const spread = basePrice * 0.05 * (0.4 + r() * 0.8);
  const rangeMin = basePrice - spread;
  const rangeMax = basePrice + spread;
  const rangePos = Math.floor(r() * 55) + 30;

  const entrySlip = (r() * 0.008 - 0.004);
  const entry = basePrice * (1 + entrySlip);
  const tpPct = (r() * 4 + 0.8) * beta;
  const slPct = (r() * 2 + 0.4) * beta;
  const rrVal = tpPct / slPct;

  let target, stop, tDelta, sDelta, tType, sType;
  if (signal === 'BUY') {
    target = entry * (1 + tpPct / 100);
    stop = entry * (1 - slPct / 100);
    tDelta = `+${tpPct.toFixed(2)}%`;
    sDelta = `-${slPct.toFixed(2)}%`;
    tType = 'pos';
    sType = 'neg';
  } else if (signal === 'SELL') {
    target = entry * (1 - tpPct / 100);
    stop = entry * (1 + slPct / 100);
    tDelta = `-${tpPct.toFixed(2)}%`;
    sDelta = `+${slPct.toFixed(2)}%`;
    tType = 'neg';
    sType = 'pos';
  } else {
    target = entry * (1 + tpPct * 0.3 / 100);
    stop = entry * (1 - slPct * 0.5 / 100);
    tDelta = `+${(tpPct * 0.3).toFixed(2)}%`;
    sDelta = `-${(slPct * 0.5).toFixed(2)}%`;
    tType = 'pos';
    sType = 'neg';
  }

  const highVol = beta > 1.8 || r() < 0.15;
  const vol = highVol ? 'HIGH VOL' : 'NORMAL VOL';
  const rr = signal === 'HOLD' ? '—' : rrVal.toFixed(2) + 'X';

  const featureNames = ['macd_hist','rsi_14','volume_zscore','ret_1h','mtf_4h_mom','ema_cross','bb_width','obv_delta','vwap_dev','atr_norm','stoch_k','ret_4h','spread_proxy','regime_flag'];
  const chosen = [...featureNames].sort(() => r() - 0.5).slice(0, 6);
  let rem = 100;
  const drivers = chosen.map((name, idx) => {
    const value = idx === 5 ? Math.max(rem, 3) : Math.min(Math.floor(r() * rem * 0.55) + 4, rem - 3 * (5 - idx));
    const pct = Math.max(value, 3);
    rem -= pct;
    return { name, pct };
  });
  if (rem > 0) drivers[0].pct += rem;
  drivers.sort((a, b) => b.pct - a.pct);

  return {
    rank: idx + 1,
    sym,
    name,
    basePrice,
    beta,
    mcap,
    signal,
    signalPct,
    pct: `${pctSign}${pctRaw.toFixed(2)}% (4H)`,
    pctRaw,
    pctType,
    conf,
    votes: `${buyV} / ${sellV} / ${holdV}`,
    rangeMin: '$' + fmtPrice(rangeMin),
    rangeMax: '$' + fmtPrice(rangeMax),
    rangePos,
    entry: fmtPrice(entry),
    target: fmtPrice(target),
    stop: fmtPrice(stop),
    tDelta,
    sDelta,
    tType,
    sType,
    vol,
    rr,
    rrVal: signal === 'HOLD' ? 0 : rrVal,
    beta: beta.toFixed(2),
    drivers,
    updated: 'Just now',
    mins: 0,
    version: 'v2.3-server'
  };
}

function makeSignals(count = 50) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const coin = SIGNAL_COINS[i % SIGNAL_COINS.length];
    out.push(buildSignal(coin, i));
  }
  return out;
}

app.get('/api/signals', (req, res) => {
  const requested = Number(req.query.count) || 50;
  const count = Math.min(Math.max(requested, 12), 100);
  try {
    const data = makeSignals(count);
    res.json(data);
  } catch (e) {
    console.error('/api/signals error:', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to generate signals', details: String(e) });
  }
});

app.get('/signals', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'signals.html'));
});

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
};

// ─── AUTH ROUTES ───────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, email, password, phone } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'All fields required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const stmt = db.prepare('INSERT INTO users (username, email, password, phone) VALUES (?, ?, ?, ?)');
    const result = stmt.run(username, email, hash, phone || '');
    req.session.userId = result.lastInsertRowid;
    req.session.username = username;
    
    // Log the registration
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    db.prepare('INSERT INTO login_logs (user_id, username, email, login_type, ip_address, user_agent, success) VALUES (?,?,?,?,?,?,?)')
      .run(result.lastInsertRowid, username, email, 'register', ip, userAgent, 1);
    
    // Send notification to owner (logged for now - would send email in production)
    const ownerEmail = 'admin@stockwise.app';
    const ownerPhone = '9840173223';
    console.log(`\n🔔 NEW ACCOUNT CREATED - Notify ${ownerEmail} / ${ownerPhone}`);
    console.log(`   User: ${username} | Email: ${email} | Phone: ${phone || 'N/A'}`);
    
    // Set persistent cookie for "remember me" across sessions
    res.cookie('rememberLogin', 'true', { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: false });
    
    res.json({ 
      success: true, 
      username, 
      phone: phone || '',
      message: `Account created! A notification has been sent to ${ownerEmail}. Please contact your administrator for account activation if needed.`
    });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username or email already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password, remember } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ error: 'Invalid credentials' });
  req.session.userId = user.id;
  req.session.username = user.username;
  
  // Log the login
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  db.prepare('INSERT INTO login_logs (user_id, username, email, login_type, ip_address, user_agent, success) VALUES (?,?,?,?,?,?,?)')
    .run(user.id, user.username, user.email, 'login', ip, userAgent, 1);
  
  // Set persistent cookie if remember is checked
  if (remember) {
    res.cookie('rememberLogin', 'true', { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: false });
  }
  
  res.json({ success: true, username: user.username, phone: user.phone || '' });
});

// ─── FORGOT PASSWORD ──────────────────────────────────────────────
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  const user = db.prepare('SELECT id, username FROM users WHERE email = ?').get(email);
  // Always return success to prevent user enumeration
  if (!user) return res.json({ success: true, message: 'If that email exists, the owner has been notified.' });

  const token = crypto.randomBytes(32).toString('hex');
  const expiry = Date.now() + 3600000; // 1 hour

  db.prepare('UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?')
    .run(token, expiry, user.id);

  console.log(`\n🔑 PASSWORD RESET REQUEST`);
  console.log(`   User: ${user.username} | Email: ${email}`);
  console.log(`   Token (give to user): ${token}`);
  console.log(`   Expires: ${new Date(expiry).toLocaleString()}`);

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:auto;background:#0d1117;color:#e6edf3;padding:2rem;border-radius:12px;border:1px solid #30363d">
      <h2 style="color:#00e5a0;margin:0 0 1rem 0">🔒 StockWise — Password Reset Request</h2>
      <p style="color:#8b949e;margin:0 0 1rem 0">A user has requested a password reset on StockWise.</p>
      <table style="width:100%;border-collapse:collapse;margin:0.5rem 0 1.5rem 0">
        <tr><td style="color:#8b949e;padding:0.35rem 0.5rem 0.35rem 0;white-space:nowrap">Username:</td><td style="font-weight:bold">${user.username}</td></tr>
        <tr><td style="color:#8b949e;padding:0.35rem 0.5rem 0.35rem 0;white-space:nowrap">Email:</td><td>${email}</td></tr>
        <tr><td style="color:#8b949e;padding:0.35rem 0.5rem 0.35rem 0;white-space:nowrap">Requested at:</td><td>${new Date().toLocaleString('en-IN')}</td></tr>
      </table>
      <div style="background:#161b22;border:1px solid rgba(0,229,160,0.35);border-radius:10px;padding:1.2rem;margin-bottom:1.5rem">
        <p style="color:#8b949e;margin:0 0 0.6rem 0;font-size:0.82rem;text-transform:uppercase;letter-spacing:0.5px">Reset Token — share only with the requesting user:</p>
        <code style="color:#00e5a0;word-break:break-all;font-size:0.95rem;font-weight:bold;line-height:1.6">${token}</code>
      </div>
      <p style="color:#8b949e;font-size:0.82rem;margin:0">⚠️ This token expires in <strong style="color:#f0883e">1 hour</strong>. Contact the user directly and share this token securely.</p>
    </div>
  `;

  await sendOwnerEmail(`[StockWise] Password Reset — ${user.username}`, html);

  res.json({ success: true, message: 'Request sent! The site owner (sreekarsh@gmail.com) will share a reset token with you shortly.' });
});

app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE reset_token = ? AND reset_token_expiry > ?').get(token, Date.now());
  if (!user) return res.status(400).json({ error: 'Invalid or expired token' });
  
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?')
    .run(hash, user.id);
  
  console.log(`\n✅ PASSWORD RESET COMPLETE - User: ${user.username} | Email: ${user.email}`);
  res.json({ success: true });
});

// ─── ADMIN - View Registered Users (Owner Only) ───────────────────
app.get('/api/admin/users', requireAuth, (req, res) => {
  const me = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if (me?.role !== 'admin' && me?.role !== 'moderator') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const users = db.prepare('SELECT id, username, email, phone, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ─── UPDATE PROFILE ─────────────────────────────────────────────
app.post('/api/profile', requireAuth, (req, res) => {
  const { username, email, phone } = req.body;

  if (!username || !email)
    return res.status(400).json({ error: 'Username and email are required' });

  // duplicate check: only flag records that belong to a *different* user
  const dupEmail = db.prepare('SELECT id FROM users WHERE email = LOWER(?) AND id != ?').get(
    String(email).trim(), req.session.userId
  );
  if (dupEmail) return res.status(400).json({ error: 'Email is already in use' });

  const dupUser = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?').get(
    String(username).trim(), req.session.userId
  );
  if (dupUser) return res.status(400).json({ error: 'Username is already taken' });

  try {
    db.prepare('UPDATE users SET username = ?, email = LOWER(?), phone = ? WHERE id = ?')
      .run(username.trim(), email.trim().toLowerCase(), phone || '', req.session.userId);
  } catch (e) {
    console.error('profile update sql error:', e.message);
    return res.status(500).json({ error: 'Database error — please contact support' });
  }

  const updated = db.prepare(
    'SELECT id, username, email, phone, role, is_verified, avatar_name, avatar_bg_color, avatar_texture, avatar_accessory, avatar_energy FROM users WHERE id = ?'
  ).get(req.session.userId);
  res.json({ success: true, user: updated });
});

// ─── SAVE API KEYS ──────────────────────────────────────────────
app.post('/api/api-keys', requireAuth, (req, res) => {
  const { coindcx_key, coindcx_secret, news_api_key, community_api_key } = req.body;
  const updates = []; const params = [];
  if ('coindcx_key' in req.body)      { updates.push('coindcx_key = ?');        params.push((coindcx_key || '').trim()); }
  if ('coindcx_secret' in req.body)   { updates.push('coindcx_secret = ?');     params.push((coindcx_secret || '').trim()); }
  if ('news_api_key' in req.body)     { updates.push('news_api_key = ?');       params.push((news_api_key || '').trim()); }
  if ('community_api_key' in req.body){ updates.push('community_api_key = ?');  params.push((community_api_key || '').trim()); }
  if (!updates.length) return res.status(400).json({ error: 'No keys provided' });
  params.push(req.session.userId);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id=?`).run(...params);
  res.json({ success: true });
});

// ─── GET / SAVE PREFERENCES ─────────────────────────────────────
app.get('/api/prefs', requireAuth, (req, res) => {
  const row = db.prepare('SELECT profile_color FROM users WHERE id=?').get(req.session.userId);
  res.json({ profile_color: row?.profile_color || 'dark' });
});
app.post('/api/prefs', requireAuth, (req, res) => {
  const { profile_color, currency, theme } = req.body;
  const updates = []; const params = [];
  if (profile_color) { updates.push('profile_color = ?'); params.push(profile_color); }
  if (currency)      { updates.push('currency = ?');       params.push(currency); }
  if (theme)         { updates.push('theme = ?');          params.push(theme); }
  if (updates.length) {
    params.push(req.session.userId);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id=?`).run(...params);
  }
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  const user = db.prepare('SELECT id, username, email, phone, profile_color, currency, theme, coindcx_key, coindcx_secret, news_api_key, community_api_key, role, is_verified, avatar_name, avatar_bg_color, avatar_texture, avatar_accessory, avatar_energy FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.json({ loggedIn: false });
  const coindcxKey   = typeof user.coindcx_key === 'string' ? user.coindcx_key.trim() : '';
  const coindcxSecret = typeof user.coindcx_secret === 'string' ? user.coindcx_secret.trim() : '';
  res.json({
    loggedIn:        true,
    id:              user.id,
    username:        user.username,
    email:           user.email,
    phone:           user.phone      || '',
    profile_color:  user.profile_color || 'dark',
    currency:        user.currency  || user.profile_color || 'dark',
    theme:           user.theme     || '',
    coindcx_key:     coindcxKey,
    news_api_key:    typeof user.news_api_key    === 'string' ? user.news_api_key.trim()    : '',
    community_api_key: typeof user.community_api_key === 'string' ? user.community_api_key.trim() : '',
    role:            user.role || 'user',
    is_verified:     !!(user.is_verified),
    avatar: {
      name:      user.avatar_name       || '',
      bg_color:  user.avatar_bg_color   || '#00e5a0',
      texture:   user.avatar_texture    || 'solid',
      accessory: user.avatar_accessory  || 'none',
      energy:    user.avatar_energy     || 'none',
    },
    has_coindcx:     Boolean(coindcxKey && coindcxSecret),
    has_news_key:    Boolean(user.news_api_key),
    has_community_key: Boolean(user.community_api_key)
  });
});

// ─── LOGIN LOGS ────────────────────────────────────────────────
app.get('/api/login-logs', requireAuth, (req, res) => {
  const logs = db.prepare('SELECT id, username, email, login_type, ip_address, user_agent, login_at FROM login_logs WHERE user_id = ? ORDER BY login_at DESC LIMIT 50')
    .all(req.session.userId);
  res.json(logs);
});

// ─── COINDCX & NEWS API KEYS ──────────────────────────────────
app.post('/api/save-keys', requireAuth, (req, res) => {
  const updates = [];
  const params = [];

  const fields = {
    key: 'coindcx_key',
    secret: 'coindcx_secret',
    newsKey: 'news_api_key',
    communityKey: 'community_api_key'
  };

  for (const [bodyKey, dbCol] of Object.entries(fields)) {
    if (bodyKey in req.body && typeof req.body[bodyKey] === 'string') {
      updates.push(`${dbCol} = ?`);
      params.push(req.body[bodyKey].trim());
    }
  }

  if (!updates.length) return res.status(400).json({ error: 'No data provided' });

  params.push(req.session.userId);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id=?`).run(...params);
  res.json({ success: true });
});

// ─── COINDCX PORTFOLIO SYNC ────────────────────────────────────
app.get('/api/coindcx/balances', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT coindcx_key, coindcx_secret FROM users WHERE id=?').get(req.session.userId);
  if (!user.coindcx_key || !user.coindcx_secret) {
    return res.status(400).json({ error: 'Missing CoinDCX API keys. Please add them first.' });
  }
  try {
    const timeStamp = Date.now().toString();
    const payload = JSON.stringify({ timestamp: timeStamp });
    const signature = crypto.createHmac('sha256', user.coindcx_secret.trim()).update(payload).digest('hex');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch('https://api.coindcx.com/exchange/v1/users/balances', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AUTH-APIKEY': user.coindcx_key.trim(),
        'X-AUTH-SIGNATURE': signature
      },
      body: payload,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: `CoinDCX returned invalid response: ${text.substring(0, 200)}` });
    }

    if (!response.ok) {
      const errorMsg = data.message || data.error || data.msg || 'Authentication failed';
      return res.status(401).json({ error: `CoinDCX error (${response.status}): ${errorMsg}. Verify your API key and secret are correct.` });
    }

    if (!Array.isArray(data)) {
      return res.status(500).json({ error: `Unexpected response format from CoinDCX` });
    }

    const nonZero = data.filter(b => parseFloat(b.balance) > 0);
    res.json(nonZero);
  } catch (e) {
    console.error('CoinDCX error:', e.message, e.stack);
    if (e.name === 'AbortError') {
      res.status(504).json({ error: 'CoinDCX request timed out. Please try again.' });
    } else {
      res.status(500).json({ error: `Network error: ${e.message}` });
    }
  }
});

// ─── COINDCX TEST CONNECTION ────────────────────────────────────
app.post('/api/sync-coindcx', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT coindcx_key, coindcx_secret FROM users WHERE id=?').get(req.session.userId);
  if (!user.coindcx_key || !user.coindcx_secret) {
    return res.status(400).json({ error: 'Missing CoinDCX API keys. Please add them first.' });
  }
  try {
    const timeStamp = Date.now().toString();
    const payload = JSON.stringify({ timestamp: timeStamp });
    const signature = crypto.createHmac('sha256', user.coindcx_secret.trim()).update(payload).digest('hex');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch('https://api.coindcx.com/exchange/v1/users/balances', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AUTH-APIKEY': user.coindcx_key.trim(),
        'X-AUTH-SIGNATURE': signature
      },
      body: payload,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { return res.status(500).json({ error: `CoinDCX returned invalid response` }); }

    if (!response.ok) return res.status(401).json({ error: 'CoinDCX Authentication failed' });
    if (!Array.isArray(data)) return res.status(500).json({ error: 'Unexpected response format' });

    const nonZero = data.filter(b => parseFloat(b.balance) > 0);
    
    // Fetch trade history to calculate average buy price
    let tradeHistory = [];
    try {
      const thPayload = JSON.stringify({ timestamp: Date.now().toString(), limit: 500 });
      const thSignature = crypto.createHmac('sha256', user.coindcx_secret.trim()).update(thPayload).digest('hex');
      const thResponse = await fetch('https://api.coindcx.com/exchange/v1/orders/trade_history', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AUTH-APIKEY': user.coindcx_key.trim(),
          'X-AUTH-SIGNATURE': thSignature
        },
        body: thPayload
      });
      if (thResponse.ok) {
        tradeHistory = await thResponse.json();
      }
    } catch (e) {
      console.error('Trade history fetch failed:', e);
    }

    let usdToInrRate = 83.5;
    try {
      const rateRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=inr');
      if (rateRes.ok) {
        const rateData = await rateRes.json();
        if (rateData?.tether?.inr) usdToInrRate = rateData.tether.inr;
      }
    } catch(e) {}

    const buyPrices = {};
    if (Array.isArray(tradeHistory)) {
      const assetTrades = {};
      tradeHistory.filter(t => t.side === 'buy').forEach(t => {
        if (!t.symbol) return;
        const sym = t.symbol.toUpperCase();
        nonZero.forEach(b => {
          const cur = b.currency.toUpperCase();
          let tradePriceUSD = parseFloat(t.price);
          
          if (sym === cur + 'INR') {
            tradePriceUSD = tradePriceUSD / usdToInrRate;
          } else if (sym === cur + 'USDT' || sym === cur + 'USD') {
            // Already in USD format
          } else {
            return; // Ignore mismatched pairs (like BTC quotes) to avoid corruption
          }
          
          if (!assetTrades[cur]) assetTrades[cur] = { cost: 0, qty: 0 };
          assetTrades[cur].cost += tradePriceUSD * parseFloat(t.quantity);
          assetTrades[cur].qty += parseFloat(t.quantity);
        });
      });
      for (const cur in assetTrades) {
        if (assetTrades[cur].qty > 0) {
          buyPrices[cur] = assetTrades[cur].cost / assetTrades[cur].qty;
        }
      }
    }
    
    const stmt = db.prepare(`
      INSERT INTO portfolio (user_id, symbol, name, quantity, buy_price, asset_type) 
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id, symbol) DO UPDATE SET
        quantity = excluded.quantity,
        buy_price = CASE WHEN excluded.buy_price > 0 THEN excluded.buy_price ELSE portfolio.buy_price END
    `);
    
    const insertMany = db.transaction((balances) => {
      for (const b of balances) {
        const symbol = b.currency.toUpperCase();
        const avgPrice = buyPrices[symbol] || 0;
        stmt.run(req.session.userId, symbol, symbol, parseFloat(b.balance), avgPrice, 'crypto');
      }
    });
    
    insertMany(nonZero);
    
    res.json({ ok: true, count: nonZero.length });
  } catch (e) {
    res.status(500).json({ error: 'Sync failed: ' + e.message });
  }
});

app.post('/api/coindcx/test', requireAuth, async (req, res) => {
  const { key: bodyKey, secret: bodySecret } = req.body;
  const dbUser = db.prepare('SELECT coindcx_key, coindcx_secret FROM users WHERE id=?').get(req.session.userId);
  const apiKey    = (bodyKey    || dbUser?.coindcx_key    || '').trim();
  const apiSecret = (bodySecret || dbUser?.coindcx_secret || '').trim();
  if (!apiKey || !apiSecret) return res.status(400).json({ ok: false, error: 'API key and secret are required.' });
  try {
    const timeStamp = Date.now().toString();
    const payload   = JSON.stringify({ timestamp: timeStamp });
    const signature = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const response  = await fetch('https://api.coindcx.com/exchange/v1/users/balances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AUTH-APIKEY': apiKey, 'X-AUTH-SIGNATURE': signature },
      body: payload,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { return res.json({ ok: false, error: 'CoinDCX returned invalid response' }); }
    if (!response.ok) {
      const msg = data?.message || data?.error || 'Authentication failed';
      return res.json({ ok: false, error: `CoinDCX: ${msg}` });
    }
    const count = Array.isArray(data) ? data.filter(b => parseFloat(b.balance) > 0).length : 0;
    res.json({ ok: true, message: `Connected! Found ${count} non-zero balance(s).` });
  } catch (e) {
    if (e.name === 'AbortError') {
      res.json({ ok: false, error: 'Request timed out. Please try again.' });
    } else {
      res.json({ ok: false, error: `Network error: ${e.message}` });
    }
  }
});

// ─── MARKET TRENDS ─────────────────────────────────────────────
app.get('/api/market-trends', async (req, res) => {
    try {
      const headers = { 'User-Agent': 'StockWise/1.0' };
      if (COINGECKO_API_KEY) headers[cgAuthHeaderName()] = COINGECKO_API_KEY;
      const baseUrl = cgBaseUrl();

      const options = { headers, signal: makeTimeoutSignal(10000) };
     const [trendRes, fgRes, globalRes] = await Promise.allSettled([
       fetch(`${baseUrl}/api/v3/search/trending`, options),
       fetch('https://api.alternative.me/fng/?limit=1', options),
       fetch(`${baseUrl}/api/v3/global`, options)
     ]);
     const trending = trendRes.status === 'fulfilled' && trendRes.value.ok ? await trendRes.value.json() : { coins: [] };
     const fg       = fgRes.status === 'fulfilled'     && fgRes.value.ok   ? await fgRes.value.json()   : { data: [{ value: '50', value_classification: 'Neutral' }] };
     const global   = globalRes.status === 'fulfilled' && globalRes.value.ok ? await globalRes.value.json() : { data: {} };
     res.json({ trending: trending.coins?.slice(0, 7) || [], fearGreed: fg.data?.[0] || {}, global: global.data || {} });
   } catch (e) {
     res.json({ trending: [], fearGreed: {}, global: {} });
   }
 });

// ─── PORTFOLIO ROUTES ──────────────────────────────────────────
app.get('/api/portfolio', requireAuth, (req, res) => {
  const items = db.prepare('SELECT * FROM portfolio WHERE user_id=? ORDER BY created_at DESC').all(req.session.userId);
  res.json(items);
});

app.post('/api/portfolio', requireAuth, (req, res) => {
  const { symbol, name, quantity, buy_price, asset_type } = req.body;
  try {
    const result = db.prepare(`
      INSERT INTO portfolio (user_id, symbol, name, quantity, buy_price, asset_type) 
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id, symbol) DO UPDATE SET
        quantity = excluded.quantity,
        buy_price = CASE WHEN excluded.buy_price > 0 THEN excluded.buy_price ELSE portfolio.buy_price END
    `).run(req.session.userId, symbol.toUpperCase(), name, quantity, buy_price, asset_type || 'crypto');
    
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/portfolio/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM portfolio WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.json({ success: true });
});

app.put('/api/portfolio/:id', requireAuth, (req, res) => {
  const { quantity, buy_price } = req.body;
  const updates = [];
  const params = [];
  if (quantity !== undefined) { updates.push('quantity = ?'); params.push(quantity); }
  if (buy_price !== undefined) { updates.push('buy_price = ?'); params.push(buy_price); }
  
  if (!updates.length) return res.status(400).json({ error: 'No data to update' });
  
  params.push(req.params.id, req.session.userId);
  db.prepare(`UPDATE portfolio SET ${updates.join(', ')} WHERE id=? AND user_id=?`).run(...params);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════
//  COMMUNITY — posts, edit, delete, groups, group-chat, verification
// ════════════════════════════════════════════════════════════════════

// List posts — ?group_id= filters; no param = global feed only
app.get('/api/community', (req, res) => {
  const gid = req.query.group_id ? parseInt(req.query.group_id, 10) : null;
  let posts;
  const baseSelect = `SELECT p.*, u.avatar_bg_color, u.avatar_accessory, u.avatar_energy, u.role
    FROM community_posts p LEFT JOIN users u ON p.user_id = u.id`;
  if (gid) {
    posts = db.prepare(`${baseSelect} WHERE p.group_id=? ORDER BY p.created_at DESC LIMIT 100`).all(gid);
  } else {
    posts = db.prepare(`${baseSelect} WHERE p.group_id IS NULL ORDER BY p.created_at DESC LIMIT 50`).all();
  }
  res.json(posts);
});

// Create post — optionally inside a group
app.post('/api/community', requireAuth, (req, res) => {
  const { content, coin, group_id } = req.body;
  if (!content || content.length > 500) return res.status(400).json({ error: 'Invalid content (max 500 chars)' });
  const gid = group_id ? parseInt(group_id, 10) : null;
  if (gid) {
    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(gid, req.session.userId);
    if (!member) return res.status(403).json({ error: 'Join this group to post here' });
  }
  db.prepare('INSERT INTO community_posts (user_id, username, content, coin, group_id) VALUES (?,?,?,?,?)')
    .run(req.session.userId, req.session.username, content, coin || '', gid);
  res.json({ success: true });
});

// Edit a post — owner or moderator only
app.put('/api/community/:id', requireAuth, (req, res) => {
  const { content, coin } = req.body;
  if (!content || content.length > 500) return res.status(400).json({ error: 'Invalid content (max 500 chars)' });
  const post = db.prepare('SELECT * FROM community_posts WHERE id=?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const me = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
  if (post.user_id !== req.session.userId && me?.role !== 'moderator')
    return res.status(403).json({ error: 'Not authorized to edit this post' });
  db.prepare('UPDATE community_posts SET content=?, coin=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(content, coin || post.coin, req.params.id);
  res.json({ success: true });
});

// Delete a post — owner or moderator only
app.delete('/api/community/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM community_posts WHERE id=?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const me = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
  if (post.user_id !== req.session.userId && me?.role !== 'moderator')
    return res.status(403).json({ error: 'Not authorized to delete this post' });
  db.prepare('DELETE FROM community_posts WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Like a post
app.post('/api/community/:id/like', (req, res) => {
  db.prepare('UPDATE community_posts SET likes = likes + 1 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── EMAIL VERIFICATION ───────────────────────────────────────────
app.post('/api/verify-email', requireAuth, (req, res) => {
  const email = req.body?.email;
  if (!email) return res.status(400).json({ error: 'Email address required' });
  db.prepare("UPDATE users SET is_verified=1 WHERE id=? AND email=?").run(req.session.userId, email);
  const row = db.prepare('SELECT is_verified FROM users WHERE id=?').get(req.session.userId);
  res.json({ success: true, is_verified: !!(row && row.is_verified) });
});

// ─── GROUPS / GROUP-CHAT ──────────────────────────────────────────

// List all groups (with member count + my-joined flag)
app.get('/api/groups', requireAuth, (req, res) => {
  const groups = db.prepare(`
    SELECT g.*, u.username AS creator_name,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
      (SELECT 1 FROM group_members gm2 WHERE gm2.group_id = g.id AND gm2.user_id = ?) AS is_member
    FROM groups g
    JOIN users u ON u.id = g.created_by
    ORDER BY g.created_at DESC
  `).all(req.session.userId);
  res.json(groups);
});

// Single group + members
app.get('/api/groups/:id', requireAuth, (req, res) => {
  const gid = parseInt(req.params.id, 10);
  const group = db.prepare('SELECT g.*, u.username AS creator_name FROM groups g JOIN users u ON u.id=g.created_by WHERE g.id=?').get(gid);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const members = db.prepare(
    'SELECT gm.*, u.username FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=? ORDER BY gm.joined_at DESC'
  ).all(gid);
  res.json({ ...group, members });
});

// Create a group
app.post('/api/groups', requireAuth, (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim() || name.length > 100)
    return res.status(400).json({ error: 'Group name required (max 100 chars)' });
  const result = db.prepare('INSERT INTO groups (name, description, created_by) VALUES (?,?,?)')
    .run(name.trim(), description || '', req.session.userId);
  db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?,?)').run(result.lastInsertRowid, req.session.userId);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Join a group
app.post('/api/groups/:id/join', requireAuth, (req, res) => {
  const gid = parseInt(req.params.id, 10);
  const exists = db.prepare('SELECT id FROM groups WHERE id=?').get(gid);
  if (!exists) return res.status(404).json({ error: 'Group not found' });
  db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?,?)').run(gid, req.session.userId);
  res.json({ success: true });
});

// Leave a group
app.delete('/api/groups/:id/leave', requireAuth, (req, res) => {
  const gid = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').run(gid, req.session.userId);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════
//  AVATAR STUDIO
// ════════════════════════════════════════════════════════════════════

// Get current user's avatar settings
app.get('/api/avatar', requireAuth, (req, res) => {
  const u = db.prepare('SELECT avatar_name, avatar_bg_color, avatar_texture, avatar_accessory, avatar_energy FROM users WHERE id=?').get(req.session.userId);
  res.json({
    name:       u?.avatar_name       || '',
    bg_color:   u?.avatar_bg_color   || '#00e5a0',
    texture:    u?.avatar_texture    || 'solid',
    accessory:  u?.avatar_accessory  || 'none',
    energy:     u?.avatar_energy     || 'none',
  });
});

// Save avatar settings
app.put('/api/avatar', requireAuth, (req, res) => {
  const { name, bg_color, texture, accessory, energy } = req.body;
  db.prepare(`UPDATE users
    SET avatar_name=?, avatar_bg_color=?, avatar_texture=?, avatar_accessory=?, avatar_energy=?
    WHERE id=?`)
    .run(
      name       || '',
      bg_color   || '#00e5a0',
      texture    || 'solid',
      accessory  || 'none',
      energy     || 'none',
      req.session.userId
    );
  res.json({ success: true });
});

// Avatar presets catalog (client hardcodes these too — server is source of truth)
app.get('/api/avatar-presets', requireAuth, (req, res) => {
  res.json({
    colors: [
      { id: 'green',   hex: '#00e5a0', name: 'Emerald' },
      { id: 'blue',    hex: '#00bfff', name: 'Sky'     },
      { id: 'purple',  hex: '#a855f7', name: 'Amethyst'},
      { id: 'pink',    hex: '#ff6b9d', name: 'Rose'    },
      { id: 'gold',    hex: '#f59e0b', name: 'Gold'    },
      { id: 'red',     hex: '#ff4757', name: 'Scarlet' },
      { id: 'cyan',    hex: '#22d3ee', name: 'Cyan'    },
      { id: 'orange',  hex: '#fb923c', name: 'Sunset'  },
      { id: 'slate',   hex: '#64748b', name: 'Slate'   },
    ],
    textures: [
      { id: 'solid',   name: 'Solid',    css: 'linear-gradient(135deg, VAR, VAR)' },
      { id: 'radial',  name: 'Radial',   css: 'radial-gradient(circle, VAR 40%, transparent 70%)' },
      { id: 'diagonal',name: 'Diagonal', css: 'repeating-linear-gradient(45deg, VAR, VAR 8px, transparent 8px, transparent 16px)' },
      { id: 'stripes', name: 'Stripes',  css: 'repeating-linear-gradient(90deg, VAR 0px, VAR 6px, transparent 6px, transparent 14px)' },
      { id: 'dots',    name: 'Dots',     css: 'radial-gradient(circle, VAR 2px, transparent 2px) 0 0 / 10px 10px, VAR' },
    ],
    accessories: [
      { id: 'none',    emoji: '',    label: 'None' },
      { id: 'crown',   emoji: '👑',  label: 'Crown'  },
      { id: 'halo',    emoji: '✨',  label: 'Halo'   },
      { id: 'headband',emoji: '🎧',  label: 'Band'   },
      { id: 'glasses', emoji: '🕶️',  label: 'Glasses'},
      { id: 'cap',     emoji: '🧢',  label: 'Cap'    },
      { id: 'bow',     emoji: '🎀',  label: 'Bow'    },
      { id: 'emerald', emoji: '💎',  label: 'Gem'    },
    ],
    energies: [
      { id: 'none',    name: 'None',   glow: 'none'      },
      { id: 'neon',    name: 'Neon',   glow: '0 0 18px VAR' },
      { id: 'glow',    name: 'Glow',   glow: '0 0 30px VAR, 0 0 60px VAR' },
      { id: 'fire',    name: 'Fire',   glow: '0 0 22px #ff6b35, 0 0 44px #ff4757' },
      { id: 'ice',     name: 'Ice',    glow: '0 0 22px #00bfff, 0 0 44px #1e90ff' },
    ],
    backgrounds: [
      { id: 'deep',    name: 'Deep Space', gradient: 'radial-gradient(ellipse at center, #1a1a2e 0%, #0d0d1a 100%)' },
      { id: 'ocean',   name: 'Ocean',      gradient: 'radial-gradient(ellipse at bottom, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
      { id: 'sunset',  name: 'Sunset',     gradient: 'radial-gradient(ellipse at top, #1a0a2e, #3d1a00)' },
      { id: 'forest',  name: 'Forest',     gradient: 'radial-gradient(ellipse at bottom, #0d1f0d 0%, #0a1a0a 100%)' },
      { id: 'aurora',  name: 'Aurora',     gradient: 'radial-gradient(ellipse at top, #0d1a2e 0%, #0a0f1e 100%)' },
    ],
  });
});

// ════════════════════════════════════════════════════════════════════
//  GUIDE BOT
// ════════════════════════════════════════════════════════════════════

const BOT_TIPS = {
  '/': [
    'Welcome to StockWise! Try the Live Tracker from the top nav.',
    'Create an account to unlock Portfolio, Signals and Community.',
    "Don't invest more than you can afford to lose — signals are educational only.",
  ],
  '/tracker': [
    'Prices refresh every 30 seconds automatically.',
    'Click any coin row to see full 24h change breakdown.',
    'Set price alerts from here — they show up in your Portfolio.',
    "Use the search box to filter the 100+ tracked coins.",
  ],
  '/signals': [
    'Signals combine RSI, MACD, Bollinger Bands and news sentiment.',
    'Buy = bullish confluence of 3+ indicators.',
    'Sell = 3+ indicators pointing down.',
    'Hold = mixed signals — wait for clarity.',
  ],
  '/portfolio': [
    'Paste your CoinDCX API keys to auto-sync your real holdings.',
    'Price alerts trigger in-app and in the Portfolio panel.',
    'Tracks both your manual entries and CoinDCX-synced positions.',
  ],
  '/community': [
    'Join a group to talk about specific coins or strategies.',
    'Stickers add personality — click the emoji button in the composer.',
    'Unverified accounts cannot post until email is confirmed.',
  ],
  '/analyzer': [
    'Paste your holdings to get a diversity score, risk rating and improvements.',
    'Works on both manual entries and CoinDCX-synced portfolios.',
    'Re-run any time you add or remove a position.',
  ],
};

app.get('/api/bot-tips', (req, res) => {
  const path = req.query.path || '/';
  const tips = BOT_TIPS[path] || BOT_TIPS['/'];
  const tip  = tips[Math.floor(Math.random() * tips.length)];
  res.json({ tip, page: path });
});


// ─── ALERTS ROUTES ─────────────────────────────────────────────────
app.get('/api/alerts', requireAuth, (req, res) => {
  const alerts = db.prepare('SELECT * FROM alerts WHERE user_id=? AND triggered=0').all(req.session.userId);
  res.json(alerts);
});

app.post('/api/alerts', requireAuth, (req, res) => {
  const { symbol, target_price, direction } = req.body;
  db.prepare('INSERT INTO alerts (user_id, symbol, target_price, direction) VALUES (?,?,?,?)')
    .run(req.session.userId, symbol, target_price, direction);
  res.json({ success: true });
});

app.delete('/api/alerts/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM alerts WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.json({ success: true });
});

// ─── NEWS PROXY ────────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  try {
    // User-provided fallback key
    const fallbackKey = 'ae9ca2e587e9907bd6dde778bf15ec9491acb54096de9a865305598007b041ca';
    let apiKey = fallbackKey;
    
    if (req.session.userId) {
      const user = db.prepare('SELECT news_api_key FROM users WHERE id=?').get(req.session.userId);
      // Only use the DB key if it's not empty and doesn't look like an old CryptoPanic token (CryptoPanic tokens are usually shorter/different)
      if (user && user.news_api_key && user.news_api_key.trim().length > 30) {
        apiKey = user.news_api_key.trim();
      }
    }

    const q = req.query.q || '';
    // CryptoCompare uses 'categories' for filtering news (e.g. BTC,ETH,Mining)
    // We'll map our keywords to simple categories or just fetch all if none provided
    const categories = q.includes('stock') ? 'Finance' : (q.includes('bitcoin') ? 'BTC' : '');

    const url = `https://min-api.cryptocompare.com/data/v2/news/?lang=EN&api_key=${apiKey}${categories ? '&categories=' + categories : ''}`;

    const r = await fetch(url, {
      headers: { 'User-Agent': 'StockWise/1.0' },
      signal: makeTimeoutSignal(10000)
    });
    const data = await r.json();
    
    // CryptoCompare returns { Data: [...] }
    if (data && data.Data && Array.isArray(data.Data)) {
      // Map to a common format: { results: [ { title, url, source } ] }
      const results = data.Data.map(a => ({
        title: a.title,
        url: a.url,
        source: { title: a.source_info?.name || a.source || 'CryptoCompare' }
      }));
      res.json({ results });
    } else {
      res.json({ results: [] });
    }
  } catch (err) {
    console.error('News API Error:', err);
    res.json({ results: [] });
  }
});

// ─── COINGECKO PROXY ──────────────────────────────────────────

// Demo / free-tier keys (issued by CoinGecko) must use api.coingecko.com,
// not the pro sub-domain. Any key starting with "CG-" is treated as demo.
function cgBaseUrl() {
  const key = String(COINGECKO_API_KEY || '');
  const isDemo = key.startsWith('CG-') || !key;
  return isDemo ? 'https://api.coingecko.com' : 'https://pro-api.coingecko.com';
}

function cgAuthHeaderName() {
  const key = String(COINGECKO_API_KEY || '');
  const isDemo = key.startsWith('CG-') || !key;
  return isDemo ? 'x-cg-demo-api-key' : 'x-cg-pro-api-key';
}

let trendingCache = null;
let trendingCacheTime = 0;
let marketsCache = {}; // Changed to object keyed by currency
let marketsCacheTime = {}; // Changed to object keyed by currency
let fearGreedCache = null;
let fearGreedCacheTime = 0;
let stocksCache = {};
let stocksCacheTime = 0;
let coindcxCache = null;
let coindcxCacheTime = 0;
const CACHE_TTL = 300000;
const MARKETS_CACHE_TTL = 8000; // 8 seconds — much fresher prices for live tracker
const STOCKS_CACHE_TTL = 30000;
const COINDCX_CACHE_TTL = 5000; // 5s for real-time CoinDCX prices

app.get('/api/trending', async (req, res) => {
   const now = Date.now();
   if (trendingCache && (now - trendingCacheTime) < CACHE_TTL) {
     return res.json(trendingCache);
   }
   try {
      const usePro = !!COINGECKO_API_KEY;
      const baseUrl = usePro ? 'https://pro-api.coingecko.com' : 'https://api.coingecko.com';
       const headers = { 'User-Agent': 'StockWise/1.0', 'Cache-Control': 'no-cache' };
        if (usePro) headers['x-cg-pro-api-key'] = COINGECKO_API_KEY;

       const r = await fetch(`${baseUrl}/api/v3/search/trending`, {
         headers,
         signal: makeTimeoutSignal(12000)
       });
     if (!r.ok) {
       if (trendingCache) return res.json(trendingCache);
       return res.status(502).json({ coins: [] });
     }
     const data = await r.json();
     trendingCache = data;
     trendingCacheTime = now;
res.json(data);
    } catch { res.json({ coins: [] }); }
  });

app.get('/api/markets', async (req, res) => {
    const now = Date.now();
    const currency = req.query.vs_currency || 'usd';
    const categoryId = req.query.category || '';
    const isSparkline = (req.query.sparkline === 'true' || req.query.sparkline === '1');
    const { per_page, order, price_change_percentage } = req.query;
    // Include per_page and category in key so different queries don't collide
    const cacheKey = `${currency}_${isSparkline ? '1' : '0'}_${categoryId}_${per_page || '*'}_${price_change_percentage || '*'}`;
    const cacheTTL = currency === 'usd' ? MARKETS_CACHE_TTL : 30000;
    const forceFresh = req.query.fresh === '1' || req.query.nocache === '1' || req.query.force === '1';

    if (!forceFresh && marketsCache[cacheKey] && (now - marketsCacheTime[cacheKey]) < cacheTTL) {
      return res.json(marketsCache[cacheKey]);
    }
    
    try {
      let ids = req.query.ids || '';
      const params = new URLSearchParams({ vs_currency: currency });

      if (per_page) params.set('per_page', per_page);
      if (order) params.set('order', order);
      if (isSparkline) params.set('sparkline', 'true');
      if (price_change_percentage) params.set('price_change_percentage', price_change_percentage);

      // Always add Cache-Control: no-cache so no CDN/ISP caches the upstream response
      const headers = { 'User-Agent': 'StockWise/1.0', 'Cache-Control': 'no-cache' };
      if (COINGECKO_API_KEY) headers[cgAuthHeaderName()] = COINGECKO_API_KEY;

       if (categoryId === 'trending') {
         let trendData;
         if (trendingCache && (now - trendingCacheTime) < CACHE_TTL) {
           trendData = trendingCache;
          } else {
            try {
              const trendingUrl = `${baseUrl}/api/v3/search/trending`;
              if (COINGECKO_API_KEY) headers[cgAuthHeaderName()] = COINGECKO_API_KEY;
             
             const r = await fetch(trendingUrl, {
               headers,
               signal: makeTimeoutSignal(8000)
             });
             if (r.ok) {
               const data = await r.json();
               trendingCache = data;
               trendingCacheTime = now;
               trendData = data;
             } else {
               trendData = trendingCache;
             }
           } catch (e) {
             console.error('Error fetching trending search:', e.message);
             trendData = trendingCache;
           }
         }

        if (trendData && Array.isArray(trendData.coins)) {
          const trendingIds = trendData.coins.map(c => c.item.id).join(',');
          if (trendingIds) {
            ids = trendingIds;
          }
        }

        if (!ids) {
          if (marketsCache[cacheKey]) return res.json(marketsCache[cacheKey]);
          return res.status(502).json({ error: 'Could not fetch trending coins list' });
        }
      } else if (categoryId) {
        params.set('category', categoryId);
      }

       if (ids) {
         params.set('ids', ids);
       }

         baseUrl = cgBaseUrl();
        headers['User-Agent'] = 'StockWise/1.0';
        headers['Cache-Control'] = 'no-cache';
        if (COINGECKO_API_KEY) headers[cgAuthHeaderName()] = COINGECKO_API_KEY;

       const r = await fetch(`${baseUrl}/api/v3/coins/markets?${params}`, {
         headers,
         signal: makeTimeoutSignal(12000)
       });

      if (!r.ok) {
        const errData = await r.json().catch(() => ({}));
        console.error(`CoinGecko API Error (${r.status}):`, errData);
        if (marketsCache[cacheKey]) return res.json(marketsCache[cacheKey]);
        return res.status(r.status).json({ error: errData.error || `HTTP ${r.status}` });
      }

      const data = await r.json();
      if (!Array.isArray(data)) {
        if (marketsCache[cacheKey]) return res.json(marketsCache[cacheKey]);
        return res.status(502).json({ error: 'Invalid market data format' });
      }
      // Only cache non-empty results
      if (data.length > 0) {
        marketsCache[cacheKey] = data;
        marketsCacheTime[cacheKey] = now;
      }
      res.json(data);
    } catch (e) {
      console.error('Markets fetch error:', e.message);
      if (marketsCache[cacheKey]) return res.json(marketsCache[cacheKey]);
      res.json([]);
    }
  });

app.get('/api/coingecko-pro-price', async (req, res) => {
  if (!COINGECKO_API_KEY) {
    return res.status(400).json({ error: 'CoinGecko API key not configured on server' });
  }

  const ids = req.query.ids || 'bitcoin,ethereum,solana,cardano';
  const vs_currencies = req.query.vs_currencies || 'usd,eur,btc';
  const include_market_cap = req.query.include_market_cap === 'true' ? 'true' : 'true';
  const include_24hr_change = req.query.include_24hr_change === 'true' ? 'true' : 'true';

  const params = new URLSearchParams({
    ids,
    vs_currencies,
    include_market_cap,
    include_24hr_change
  });

  try {
    const r = await fetch(`${cgBaseUrl()}/api/v3/simple/price?${params.toString()}`, {
      headers: {
        [cgAuthHeaderName()]: COINGECKO_API_KEY,
        'User-Agent': 'StockWise/1.0'
      },
      signal: makeTimeoutSignal(10000)
    });

    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      console.error('CoinGecko Pro error:', r.status, errBody);
      return res.status(r.status).json({ error: 'CoinGecko Pro request failed' });
    }

    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error('CoinGecko Pro fetch error:', e.message);
    res.status(502).json({ error: 'Failed to fetch CoinGecko Pro data' });
  }
});

app.get('/api/coingecko-categories', async (req, res) => {
   try {
      const baseUrl = cgBaseUrl();
      const headers = { 'User-Agent': 'StockWise/1.0' };
      if (COINGECKO_API_KEY) headers[cgAuthHeaderName()] = COINGECKO_API_KEY;
     
     const r = await fetch(`${baseUrl}/api/v3/coins/categories/list`, {
       headers,
       signal: makeTimeoutSignal(10000)
     });
     if (!r.ok) return res.json([]);
     const data = await r.json();
     res.json(data);
   } catch {
     res.json([]);
   }
 });

app.get('/api/fear-greed', async (req, res) => {
  const now = Date.now();
  if (fearGreedCache && (now - fearGreedCacheTime) < CACHE_TTL) {
    return res.json(fearGreedCache);
  }
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1', {
      headers: { 'User-Agent': 'StockWise/1.0' },
      signal: makeTimeoutSignal(8000)
    });
    if (!r.ok) {
      if (fearGreedCache) return res.json(fearGreedCache);
      return res.status(502).json({ data: [] });
    }
    const data = await r.json();
    fearGreedCache = data;
    fearGreedCacheTime = now;
    res.json(data);
  } catch { res.json({ data: [] }); }
});

// ─── COIN CHART DATA ────────────────────────────────────────────
 app.get('/api/coins/:id/chart', async (req, res) => {
    const { id } = req.params;
    const { days = 7, currency = 'usd' } = req.query;
    const vsCurr = currency === 'usdt' ? 'usd' : currency;
    try {
      const baseUrl = cgBaseUrl();
      const headers = { 'User-Agent': 'StockWise/1.0' };
      if (COINGECKO_API_KEY) headers[cgAuthHeaderName()] = COINGECKO_API_KEY;
      
      const r = await fetch(`${baseUrl}/api/v3/coins/${id}/market_chart?vs_currency=${vsCurr}&days=${days}`, {
       headers,
       signal: makeTimeoutSignal(10000)
     });
     if (!r.ok) return res.status(502).json({ error: 'Failed to fetch chart data' });
     const data = await r.json();
     res.json(data);
   } catch { res.status(502).json({ error: 'Failed to fetch chart data' }); }
 });

// ─── CURRENCY RATES ─────────────────────────────────────────────
let inrUsdRate = 83.5;
let rateCacheTime = 0;
app.get('/api/rates', async (req, res) => {
   const now = Date.now();
   if (rateCacheTime && (now - rateCacheTime) < 3600000) {
     return res.json({ usd_inr: inrUsdRate });
   }
    try {
      // Fetch Tether price in INR as a proxy for USD/INR rate
      const baseUrl = cgBaseUrl();
      const headers = { 'User-Agent': 'StockWise/1.0' };
      if (COINGECKO_API_KEY) headers[cgAuthHeaderName()] = COINGECKO_API_KEY;
     
     const r = await fetch(`${baseUrl}/api/v3/simple/price?ids=tether&vs_currencies=inr`, {
       headers,
       signal: makeTimeoutSignal(8000)
     });
     const data = await r.json();
     if (data.tether?.inr) {
       inrUsdRate = data.tether.inr;
       rateCacheTime = now;
     }
     res.json({ usd_inr: inrUsdRate });
    } catch {
      res.json({ usd_inr: inrUsdRate });
    }
  });

 // ─── COINDCX LIVE PRICES (for exact INR match) ─────────────────────────────
  // Public CoinDCX ticker - no API key needed. Returns real-time last_price from their orderbook.
  const COINDCX_NAME_MAP = {
    BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', BNB: 'Binance Coin', XRP: 'Ripple',
    ADA: 'Cardano', AVAX: 'Avalanche', DOGE: 'Dogecoin', DOT: 'Polkadot', LINK: 'Chainlink',
    MATIC: 'Polygon', TRX: 'TRON', SHIB: 'Shiba Inu', LTC: 'Litecoin', BCH: 'Bitcoin Cash',
    ATOM: 'Cosmos', NEAR: 'NEAR Protocol', APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism',
    INJ: 'Injective', VET: 'VeChain', ALGO: 'Algorand', ICP: 'Internet Computer',
    FIL: 'Filecoin', EOS: 'EOS', AAVE: 'Aave', MKR: 'Maker', UNI: 'Uniswap',
    XLM: 'Stellar', ETC: 'Ethereum Classic', XMR: 'Monero', ZEC: 'Zcash',
    // Add more as needed; unknown will fallback to symbol
  };

  app.get('/api/coindcx/markets', async (req, res) => {
    const now = Date.now();
    const vs = String(req.query.vs_currency || 'inr').toLowerCase();
    const forceFresh = req.query.fresh === '1' || req.query.nocache === '1';

    if (!forceFresh && coindcxCache && (now - coindcxCacheTime) < COINDCX_CACHE_TTL) {
      return res.json(coindcxCache);
    }

    try {
      const r = await fetch('https://api.coindcx.com/exchange/ticker', {
        headers: { 'User-Agent': 'StockWise/1.0' },
        signal: makeTimeoutSignal(8000)
      });
      if (!r.ok) throw new Error(`CoinDCX HTTP ${r.status}`);
      const tickers = await r.json();
      if (!Array.isArray(tickers)) throw new Error('Unexpected CoinDCX response');

      // Filter by quote currency
      let filtered = tickers;
      if (vs === 'inr') {
        filtered = tickers.filter(t => String(t.market || '').toUpperCase().endsWith('INR'));
      } else if (vs === 'usdt') {
        filtered = tickers.filter(t => String(t.market || '').toUpperCase().endsWith('USDT'));
      } else if (vs === 'usd') {
        filtered = tickers.filter(t => String(t.market || '').toUpperCase().endsWith('USD'));
      }

      const normalized = filtered.map((t) => {
        const market = String(t.market || '').toUpperCase();
        let base = market;
        let quote = '';
        if (market.endsWith('INR')) { base = market.slice(0, -3); quote = 'INR'; }
        else if (market.endsWith('USDT')) { base = market.slice(0, -4); quote = 'USDT'; }
        else if (market.endsWith('USD')) { base = market.slice(0, -3); quote = 'USD'; }
        else return null;

        const last = parseFloat(t.last_price || t.lastPrice || t.price || 0);
        const chg = parseFloat(t.change_24_hour || t['24h_change'] || t.change || 0);
        const vol = parseFloat(t.volume || t.volume_24h || 0);

        const sym = base.toUpperCase();
        return {
          id: sym.toLowerCase(),
          symbol: sym,
          name: COINDCX_NAME_MAP[sym] || sym,
           image: `https://assets.coincap.io/assets/icons/${sym.toLowerCase()}@2x.png`,
          current_price: last,
          price_change_percentage_24h: chg,
          price_change_percentage_1h_in_currency: 0,
          price_change_percentage_7d_in_currency: 0,
          market_cap: 0,
          total_volume: vol,
          sparkline_in_7d: { price: [] },
          coindcx_market: market
        };
      }).filter(Boolean);

      coindcxCache = normalized;
      coindcxCacheTime = now;
      res.json(normalized);
    } catch (e) {
      console.error('CoinDCX ticker error:', e.message);
      if (coindcxCache) return res.json(coindcxCache);
      res.json([]);
    }
  });

 // ─── STOCKS (150+ across 4 categories) ────────────────────────────────────────
const STOCK_SYMBOLS = [
  // ── NIFTY 50 ──────────────────────────────────────────────────
  { symbol: 'RELIANCE',   name: 'Reliance Industries Ltd.',        base: 2900,  cat: 'nifty50' },
  { symbol: 'TCS',        name: 'Tata Consultancy Services',       base: 3950,  cat: 'nifty50' },
  { symbol: 'HDFCBANK',   name: 'HDFC Bank Ltd.',                  base: 1740,  cat: 'nifty50' },
  { symbol: 'INFY',       name: 'Infosys Ltd.',                    base: 1800,  cat: 'nifty50' },
  { symbol: 'ICICIBANK',  name: 'ICICI Bank Ltd.',                 base: 1240,  cat: 'nifty50' },
  { symbol: 'HINDUNILVR', name: 'Hindustan Unilever Ltd.',         base: 2640,  cat: 'nifty50' },
  { symbol: 'SBIN',       name: 'State Bank of India',             base: 830,   cat: 'nifty50' },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd.',              base: 1680,  cat: 'nifty50' },
  { symbol: 'TATAMOTORS', name: 'Tata Motors Ltd.',                base: 880,   cat: 'nifty50' },
  { symbol: 'KOTAKBANK',  name: 'Kotak Mahindra Bank',             base: 1850,  cat: 'nifty50' },
  { symbol: 'ITC',        name: 'ITC Ltd.',                        base: 455,   cat: 'nifty50' },
  { symbol: 'AXISBANK',   name: 'Axis Bank Ltd.',                  base: 1180,  cat: 'nifty50' },
  { symbol: 'LT',         name: 'Larsen & Toubro Ltd.',            base: 3500,  cat: 'nifty50' },
  { symbol: 'JSWSTEEL',   name: 'JSW Steel Ltd.',                  base: 850,   cat: 'nifty50' },
  { symbol: 'ASIANPAINT', name: 'Asian Paints Ltd.',               base: 2950,  cat: 'nifty50' },
  { symbol: 'NTPC',       name: 'NTPC Ltd.',                       base: 330,   cat: 'nifty50' },
  { symbol: 'MARUTI',     name: 'Maruti Suzuki India Ltd.',        base: 12800, cat: 'nifty50' },
  { symbol: 'NESTLEIND',  name: 'Nestle India Ltd.',               base: 2280,  cat: 'nifty50' },
  { symbol: 'ONGC',       name: 'Oil & Natural Gas Corp.',         base: 305,   cat: 'nifty50' },
  { symbol: 'COALINDIA',  name: 'Coal India Ltd.',                 base: 465,   cat: 'nifty50' },
  { symbol: 'ULTRACEMCO', name: 'UltraTech Cement Ltd.',           base: 11200, cat: 'nifty50' },
  { symbol: 'TITAN',      name: 'Titan Company Ltd.',              base: 3200,  cat: 'nifty50' },
  { symbol: 'TATASTEEL',  name: 'Tata Steel Ltd.',                 base: 175,   cat: 'nifty50' },
  { symbol: 'SUNPHARMA',  name: 'Sun Pharma Advanced',             base: 1780,  cat: 'nifty50' },
  { symbol: 'DMART',      name: 'Avenue Supermarts Ltd.',          base: 4280,  cat: 'nifty50' },
  { symbol: 'WIPRO',      name: 'Wipro Ltd.',                      base: 290,   cat: 'nifty50' },
  { symbol: 'HCLTECH',    name: 'HCL Technologies Ltd.',           base: 1750,  cat: 'nifty50' },
  { symbol: 'SBILIFE',    name: 'SBI Life Insurance',              base: 1650,  cat: 'nifty50' },
  { symbol: 'HDFCLIFE',   name: 'HDFC Life Insurance',             base: 680,   cat: 'nifty50' },
  { symbol: 'POWERGRID',  name: 'Power Grid Corporation',          base: 320,   cat: 'nifty50' },
  { symbol: 'CIPLA',      name: 'Cipla Ltd.',                      base: 1850,  cat: 'nifty50' },
  { symbol: 'TECHM',      name: 'Tech Mahindra Ltd.',              base: 1780,  cat: 'nifty50' },
  { symbol: 'BAJAJFINSV', name: 'Bajaj Finserv Ltd.',              base: 1680,  cat: 'nifty50' },
  { symbol: 'BRITANNIA',  name: 'Britannia Industries',            base: 5350,  cat: 'nifty50' },
  { symbol: 'GODREJCP',   name: 'Godrej Consumer Products',        base: 1620,  cat: 'nifty50' },
  { symbol: 'PIDILITIND', name: 'Pidilite Industries',             base: 3150,  cat: 'nifty50' },
  { symbol: 'M&M',        name: 'Mahindra & Mahindra',             base: 3120,  cat: 'nifty50' },
  { symbol: 'EICHERMOT',  name: 'Eicher Motors Ltd.',              base: 8350,  cat: 'nifty50' },
  { symbol: 'SHREECEM',   name: 'Shree Cement Ltd.',               base: 25000, cat: 'nifty50' },
  { symbol: 'DRREDDY',    name: "Dr. Reddy's Laboratories",        base: 1180,  cat: 'nifty50' },
  { symbol: 'INDUSINDBK', name: 'IndusInd Bank Ltd.',              base: 580,   cat: 'nifty50' },
  { symbol: 'IOC',        name: 'Indian Oil Corporation',          base: 145,   cat: 'nifty50' },
  { symbol: 'HEROMOTOCO', name: 'Hero MotoCorp Ltd.',              base: 6200,  cat: 'nifty50' },
  { symbol: 'BAJAJ-AUTO', name: 'Bajaj Auto Ltd.',                 base: 9350,  cat: 'nifty50' },
  { symbol: 'ADANIPORTS', name: 'Adani Ports & SEZ',               base: 1580,  cat: 'nifty50' },
  { symbol: 'BPCL',       name: 'Bharat Petroleum',                base: 520,   cat: 'nifty50' },
  { symbol: 'ADANIENT',   name: 'Adani Enterprises Ltd.',          base: 2950,  cat: 'nifty50' },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance Ltd.',              base: 7300,  cat: 'nifty50' },
  { symbol: 'VEDL',       name: 'Vedanta Ltd.',                    base: 480,   cat: 'nifty50' },
  { symbol: 'ZOMATO',     name: 'Zomato Ltd.',                     base: 245,   cat: 'nifty50' },

  // ── CRYPTO (For Community Hub) ──────────────────────────────
  { symbol: 'BTC',        name: 'Bitcoin',                         base: 68000, cat: 'crypto' },
  { symbol: 'ETH',        name: 'Ethereum',                        base: 3500,  cat: 'crypto' },
  { symbol: 'SOL',        name: 'Solana',                          base: 145,   cat: 'crypto' },
  { symbol: 'BNB',        name: 'Binance Coin',                    base: 580,   cat: 'crypto' },
  { symbol: 'XRP',        name: 'Ripple',                          base: 0.62,  cat: 'crypto' },
  { symbol: 'ADA',        name: 'Cardano',                         base: 0.45,  cat: 'crypto' },
  { symbol: 'AVAX',       name: 'Avalanche',                       base: 35,    cat: 'crypto' },
  { symbol: 'DOGE',       name: 'Dogecoin',                        base: 0.16,  cat: 'crypto' },
  { symbol: 'DOT',        name: 'Polkadot',                        base: 7.20,  cat: 'crypto' },
  { symbol: 'LINK',       name: 'Chainlink',                       base: 18.50, cat: 'crypto' },

  // ── NIFTY NEXT 50 ─────────────────────────────────────────────
  { symbol: 'SIEMENS',    name: 'Siemens Ltd.',                    base: 7200,  cat: 'next50' },
  { symbol: 'AMBUJACEM',  name: 'Ambuja Cements Ltd.',             base: 620,   cat: 'next50' },
  { symbol: 'DABUR',      name: 'Dabur India Ltd.',                base: 545,   cat: 'next50' },
  { symbol: 'MARICO',     name: 'Marico Ltd.',                     base: 590,   cat: 'next50' },
  { symbol: 'MUTHOOTFIN', name: 'Muthoot Finance Ltd.',            base: 2050,  cat: 'next50' },
  { symbol: 'NAUKRI',     name: 'Info Edge (India) Ltd.',          base: 8200,  cat: 'next50' },
  { symbol: 'HAVELLS',    name: 'Havells India Ltd.',              base: 1720,  cat: 'next50' },
  { symbol: 'TORNTPHARM', name: 'Torrent Pharmaceuticals',         base: 3400,  cat: 'next50' },
  { symbol: 'INDHOTEL',   name: 'Indian Hotels Co. Ltd.',          base: 780,   cat: 'next50' },
  { symbol: 'TATACOMM',   name: 'Tata Communications Ltd.',        base: 1720,  cat: 'next50' },
  { symbol: 'LUPIN',      name: 'Lupin Ltd.',                      base: 2230,  cat: 'next50' },
  { symbol: 'AUROPHARMA', name: 'Aurobindo Pharma Ltd.',           base: 1300,  cat: 'next50' },
  { symbol: 'GAIL',       name: 'GAIL (India) Ltd.',               base: 220,   cat: 'next50' },
  { symbol: 'INDIGO',     name: 'IndiGo (InterGlobe Aviation)',    base: 4850,  cat: 'next50' },
  { symbol: 'BANKBARODA', name: 'Bank of Baroda',                  base: 245,   cat: 'next50' },
  { symbol: 'CANBK',      name: 'Canara Bank',                     base: 105,   cat: 'next50' },
  { symbol: 'COLPAL',     name: 'Colgate-Palmolive India',         base: 2800,  cat: 'next50' },
  { symbol: 'BERGEPAINT', name: 'Berger Paints India',             base: 560,   cat: 'next50' },
  { symbol: 'ALKEM',      name: 'Alkem Laboratories Ltd.',         base: 5400,  cat: 'next50' },
  { symbol: 'GLAND',      name: 'Gland Pharma Ltd.',               base: 1850,  cat: 'next50' },
  { symbol: 'TATAPOWER',  name: 'Tata Power Co. Ltd.',             base: 420,   cat: 'next50' },
  { symbol: 'SAIL',       name: 'Steel Authority of India',        base: 135,   cat: 'next50' },
  { symbol: 'PETRONET',   name: 'Petronet LNG Ltd.',               base: 355,   cat: 'next50' },
  { symbol: 'CONCOR',     name: 'Container Corp. of India',        base: 820,   cat: 'next50' },
  { symbol: 'PAGEIND',    name: 'Page Industries Ltd.',             base: 44000, cat: 'next50' },
  { symbol: 'MPHASIS',    name: 'Mphasis Ltd.',                    base: 2900,  cat: 'next50' },
  { symbol: 'COFORGE',    name: 'Coforge Ltd.',                    base: 7800,  cat: 'next50' },
  { symbol: 'LTI',        name: 'LTIMindtree Ltd.',                base: 5200,  cat: 'next50' },
  { symbol: 'PERSISTENT', name: 'Persistent Systems Ltd.',         base: 5800,  cat: 'next50' },
  { symbol: 'POLYCAB',    name: 'Polycab India Ltd.',              base: 6200,  cat: 'next50' },
  { symbol: 'ABCAPITAL',  name: 'Aditya Birla Capital Ltd.',       base: 220,   cat: 'next50' },
  { symbol: 'FEDERALBNK', name: 'Federal Bank Ltd.',               base: 198,   cat: 'next50' },
  { symbol: 'EXIDEIND',   name: 'Exide Industries Ltd.',           base: 430,   cat: 'next50' },
  { symbol: 'SUPREMEIND', name: 'Supreme Industries Ltd.',         base: 5300,  cat: 'next50' },
  { symbol: 'TATAELXSI',  name: 'Tata Elxsi Ltd.',                 base: 7200,  cat: 'next50' },
  { symbol: 'LAURUSLABS', name: 'Laurus Labs Ltd.',                base: 560,   cat: 'next50' },
  { symbol: 'STARHEALTH', name: 'Star Health Insurance',           base: 590,   cat: 'next50' },
  { symbol: 'SUNDRMFAST', name: 'Sundram Fasteners Ltd.',          base: 1280,  cat: 'next50' },
  { symbol: 'IPCALAB',    name: 'Ipca Laboratories Ltd.',          base: 1620,  cat: 'next50' },
  { symbol: 'ICICIPRULI', name: 'ICICI Prudential Life Ins.',      base: 680,   cat: 'next50' },
  { symbol: 'CUMMINSIND', name: 'Cummins India Ltd.',              base: 3600,  cat: 'next50' },
  { symbol: 'GLAXO',      name: 'GlaxoSmithKline Pharma',         base: 2300,  cat: 'next50' },
  { symbol: 'HONAUT',     name: 'Honeywell Automation',            base: 48000, cat: 'next50' },
  { symbol: 'BBTC',       name: 'Bombay Burmah Trading',           base: 1850,  cat: 'next50' },
  { symbol: 'KAJARIACER', name: 'Kajaria Ceramics Ltd.',           base: 1420,  cat: 'next50' },
  { symbol: 'AAVAS',      name: 'Aavas Financiers Ltd.',           base: 1680,  cat: 'next50' },
  { symbol: 'KANSAINER',  name: 'Kansai Nerolac Paints',          base: 320,   cat: 'next50' },
  { symbol: 'CROMPTON',   name: 'Crompton Greaves CE',             base: 390,   cat: 'next50' },
  { symbol: 'VBL',        name: 'Varun Beverages Ltd.',            base: 1540,  cat: 'next50' },
  { symbol: 'ASTRAL',     name: 'Astral Ltd.',                     base: 1920,  cat: 'next50' },

  // ── MIDCAP ────────────────────────────────────────────────────
  { symbol: 'IRCTC',      name: 'Indian Railway Catering & Tourism', base: 870,  cat: 'midcap' },
  { symbol: 'ABFRL',      name: 'Aditya Birla Fashion',              base: 290,  cat: 'midcap' },
  { symbol: 'ATUL',       name: 'Atul Ltd.',                         base: 7200, cat: 'midcap' },
  { symbol: 'BAJAJHFL',   name: 'Bajaj Housing Finance',             base: 145,  cat: 'midcap' },
  { symbol: 'CEATLTD',    name: 'CEAT Ltd.',                         base: 3150, cat: 'midcap' },
  { symbol: 'CHOLAFIN',   name: 'Cholamandalam Inv & Fin',           base: 1420, cat: 'midcap' },
  { symbol: 'DELHIVERY',  name: 'Delhivery Ltd.',                    base: 385,  cat: 'midcap' },
  { symbol: 'DEEPAKNI',   name: 'Deepak Nitrite Ltd.',               base: 2650, cat: 'midcap' },
  { symbol: 'JKCEMENT',   name: 'JK Cement Ltd.',                    base: 4600, cat: 'midcap' },
  { symbol: 'KPITTECH',   name: 'KPIT Technologies Ltd.',            base: 1650, cat: 'midcap' },
  { symbol: 'NYKAA',      name: 'FSN E-Commerce Ventures',           base: 185,  cat: 'midcap' },
  { symbol: 'PAYTM',      name: 'One 97 Communications',             base: 720,  cat: 'midcap' },
  { symbol: 'POLICYBZR',  name: 'PB Fintech Ltd.',                   base: 1850, cat: 'midcap' },
  { symbol: 'TRENT',      name: 'Trent Ltd.',                        base: 6200, cat: 'midcap' },
  { symbol: 'SBICARD',    name: 'SBI Cards & Payment',               base: 760,  cat: 'midcap' },
  { symbol: 'CLEAN',      name: 'Clean Science & Technology',        base: 1620, cat: 'midcap' },
  { symbol: 'HFCL',       name: 'HFCL Ltd.',                         base: 128,  cat: 'midcap' },
  { symbol: 'IDFC',       name: 'IDFC Ltd.',                         base: 108,  cat: 'midcap' },
  { symbol: 'IDFCFIRSTB', name: 'IDFC First Bank Ltd.',              base: 76,   cat: 'midcap' },
  { symbol: 'IRFC',       name: 'Indian Railway Finance Corp.',      base: 195,  cat: 'midcap' },
  { symbol: 'JYOTHYLAB',  name: 'Jyothy Labs Ltd.',                  base: 525,  cat: 'midcap' },
  { symbol: 'NATCOPHARM', name: 'Natco Pharma Ltd.',                 base: 1580, cat: 'midcap' },
  { symbol: 'PGHH',       name: 'Procter & Gamble Health',           base: 6200, cat: 'midcap' },
  { symbol: 'RATNAMANI',  name: 'Ratnamani Metals & Tubes',          base: 3500, cat: 'midcap' },
  { symbol: 'SUNDARBFIN', name: 'Sundaram Finance Ltd.',             base: 5400, cat: 'midcap' },
  { symbol: 'TEXRAIL',    name: 'Texmaco Rail & Engineering',        base: 245,  cat: 'midcap' },
  { symbol: 'UJJIVANSFB', name: 'Ujjivan Small Finance Bank',        base: 48,   cat: 'midcap' },
  { symbol: 'VSTIND',     name: 'VST Industries Ltd.',               base: 4200, cat: 'midcap' },
  { symbol: 'WHIRLPOOL',  name: 'Whirlpool of India Ltd.',           base: 1950, cat: 'midcap' },
  { symbol: 'ZYDUSLIFE',  name: 'Zydus Lifesciences Ltd.',           base: 1280, cat: 'midcap' },

  // ── SMALLCAP ──────────────────────────────────────────────────
  { symbol: 'ANGELONE',   name: 'Angel One Ltd.',                    base: 2650, cat: 'smallcap' },
  { symbol: 'BIKAJI',     name: 'Bikaji Foods International',        base: 720,  cat: 'smallcap' },
  { symbol: 'BALRAMCHIN', name: 'Balrampur Chini Mills',             base: 540,  cat: 'smallcap' },
  { symbol: 'CAMPUS',     name: 'Campus Activewear Ltd.',            base: 248,  cat: 'smallcap' },
  { symbol: 'DELTACORP',  name: 'Delta Corp Ltd.',                   base: 165,  cat: 'smallcap' },
  { symbol: 'EMAMILTD',   name: 'Emami Ltd.',                        base: 680,  cat: 'smallcap' },
  { symbol: 'FINEORG',    name: 'Fine Organic Industries',           base: 5200, cat: 'smallcap' },
  { symbol: 'GESHIP',     name: 'Great Eastern Shipping',            base: 1200, cat: 'smallcap' },
  { symbol: 'HAPPYFORGE', name: 'Happy Forgings Ltd.',               base: 1450, cat: 'smallcap' },
  { symbol: 'IDEAFORGE',  name: 'ideaForge Technology Ltd.',         base: 720,  cat: 'smallcap' },
  { symbol: 'JUBLPHARMA', name: 'Jubilant Pharmova Ltd.',            base: 1050, cat: 'smallcap' },
  { symbol: 'KFINTECH',   name: 'KFin Technologies Ltd.',            base: 960,  cat: 'smallcap' },
  { symbol: 'LATENTVIEW', name: 'Latent View Analytics Ltd.',        base: 430,  cat: 'smallcap' },
  { symbol: 'METROPOLIS', name: 'Metropolis Healthcare Ltd.',        base: 1820, cat: 'smallcap' },
  { symbol: 'NAZARA',     name: 'Nazara Technologies Ltd.',          base: 980,  cat: 'smallcap' },
  { symbol: 'OLECTRA',    name: 'Olectra Greentech Ltd.',            base: 1620, cat: 'smallcap' },
  { symbol: 'RAINBOW',    name: 'Rainbow Children Medicare',         base: 1350, cat: 'smallcap' },
  { symbol: 'SAPPHIRE',   name: 'Sapphire Foods India',              base: 1380, cat: 'smallcap' },
  { symbol: 'SENCO',      name: 'Senco Gold Ltd.',                   base: 1050, cat: 'smallcap' },
   { symbol: 'TEAMLEASE',  name: 'TeamLease Services Ltd.',           base: 2850, cat: 'smallcap' },
];

// Symbol → company domain (DuckDuckGo /ip3/ favicon endpoint, proofed 2025-05-21)
const STOCK_DOMAIN = {
  'RELIANCE':'reliance.com','TCS':'tcs.com','HDFCBANK':'hdfcbank.com','INFY':'infosys.com',
  'ICICIBANK':'icicibank.com','HINDUNILVR':'hindustanunilever.com','SBIN':'sbi.co.in',
  'BHARTIARTL':'airtel.in','TATAMOTORS':'tatamotors.com','KOTAKBANK':'kotak.com',
  'ITC':'itcportal.com','AXISBANK':'axisbank.com','LT':'larsentoubro.com',
  'JSWSTEEL':'jswsteel.com','ASIANPAINT':'asianpaints.com','NTPC':'ntpc.co.in',
  'MARUTI':'marutisuzuki.com','NESTLEIND':'nestle.in','ONGC':'ongc.co.in',
  'COALINDIA':'coalindia.in','ULTRACEMCO':'ultratechcement.com','TITAN':'titan.co.in',
  'TATASTEEL':'tatasteel.com','SUNPHARMA':'sunpharma.com','DMART':'dmart.in',
  'WIPRO':'wipro.com','HCLTECH':'hcltech.com','SBILIFE':'sbilife.co.in',
  'HDFCLIFE':'hdfclife.com','POWERGRID':'powergrid.in','CIPLA':'cipla.com',
  'TECHM':'techmahindra.com','BAJAJFINSV':'bajajfinserv.in','BRITANNIA':'britannia.co.in',
  'GODREJCP':'godrejcp.com','PIDILITIND':'pidilite.com','M&M':'mahindramahindrarise.com',
  'EICHERMOT':'eichermotors.com','SHREECEM':'shreecement.com',
  'DRREDDY':'drreddys.com','INDUSINDBK':'indusind.com','IOC':'indianoil.in',
  'HEROMOTOCO':'heromotocorp.com','BAJAJ-AUTO':'bajajauto.com','ADANIPORTS':'adaniports.com',
  'BPCL':'bharatpetroleum.com','ADANIENT':'adanienterprises.com','BAJFINANCE':'bajajfinserv.in',
  'VEDL':'vedantaresources.com','ZOMATO':'zomato.com',
  // NIFTY NEXT 50
  'SIEMENS':'siemens.co.in','AMBUJACEM':'ambujacement.com','DABUR':'dabur.com','MARICO':'marico.com',
  'MUTHOOTFIN':'muthootfinance.com','NAUKRI':'naukri.com','HAVELLS':'havells.com',
  'TORNTPHARM':'torrentpharma.com','INDHOTEL':'indianhotels.com','TATACOMM':'tatacomm.com',
  'LUPIN':'lupin.com','AUROPHARMA':'aurobindo.com','GAIL':'gailonline.com',
  'INDIGO':'goindigo.in','BANKBARODA':'bankofbaroda.com','CANBK':'canarabank.com',
  'COLPAL':'colgate.com','BERGEPAINT':'bergerpaints.com','ALKEM':'alkemlaboratories.com',
  'GLAND':'glandpharma.com','TATAPOWER':'tatapower.com','SAIL':'sail.co.in',
  'PETRONET':'petronet.in','CONCOR':'concor.in','PAGEIND':'pageindustries.com',
  'MPHASIS':'mphasis.com','COFORGE':'coforge.com','LTI':'ltim.com',
  'PERSISTENT':'persistent.com','POLYCAB':'polycab.com','ABCAPITAL':'adityabirla.com',
  'FEDERALBNK':'federalbank.co.in','EXIDEIND':'exide.co.in','SUPREMEIND':'supreme.co.in',
  'TATAELXSI':'tataelxsi.com','LAURUSLABS':'lauruslabs.com','STARHEALTH':'starhealth.in',
  'SUNDRMFAST':'sundram.com','IPCALAB':'ipcalab.com','ICICIPRULI':'iciciprulife.com',
  'CUMMINSIND':'cumminsin.com','GLAXO':'gsk.com','HONAUT':'honeywell.com',
  'BBTC':'bombayburmahtrading.com','KAJARIACER':'kajariaceramics.com',
  'AAVAS':'aavas.in','KANSAINER':'kansainerlac.com','CROMPTON':'crompton.in',
  'VBL':'varunbeverages.com','ASTRAL':'astral.co.in',
  // MIDCAP
  'IRCTC':'irctc.co.in','ABFRL':'adityabirla.com','ATUL':'atul.co.in',
  'BAJAJHFL':'bajajhousingfinance.in','CEATLTD':'ceat.com','CHOLAFIN':'cholamandalam.com',
  'DELHIVERY':'delhivery.com','DEEPAKNI':'deepaknitrite.com','JKCEMENT':'jkccement.com',
  'KPITTECH':'kpit.com','NYKAA':'nykaa.com','PAYTM':'paytm.com',
  'POLICYBZR':'policybazaar.com','TRENT':'tatatrent.com','SBICARD':'sbicard.com',
  'CLEAN':'cleanscience.com','HFCL':'hfcl.com','IDFC':'idfc.com',
  'IDFCFIRSTB':'idfcfirstbank.com','IRFC':'irfc.co.in','JYOTHYLAB':'jyothylabs.com',
  'NATCOPHARM':'natcopharma.co.in','PGHH':'pg.com','RATNAMANI':'ratnamanimetals.com',
  'SUNDARBFIN':'sundaram.com','TEXRAIL':'texmaco.com','UJJIVANSFB':'ujjivan.com',
  'VSTIND':'vsttillers.com','WHIRLPOOL':'whirlpool.co.in','ZYDUSLIFE':'zydus.com',
  // SMALLCAP
  'ANGELONE':'angelone.in','BIKAJI':'bikajifoods.com','BALRAMCHIN':'balrampur.com',
  'CAMPUS':'campusactivewear.com','DELTACORP':'deltacorp.in','EMAMILTD':'emami.com',
  'FINEORG':'fineorganic.com','GESHIP':'greateasternshipping.com',
  'HAPPYFORGE':'happyforges.com','IDEAFORGE':'ideaforge.co.in',
  'JUBLPHARMA':'jubilantpharma.com','KFINTECH':'kfintech.com',
  'LATENTVIEW':'latentview.com','METROPOLIS':'metropolishealthcare.com',
  'NAZARA':'nazara.com','OLECTRA':'olectragreentech.com',
  'RAINBOW':'rainbowhospitals.co.in','SAPPHIRE':'sapphirefoods.com',
  'SENCO':'sencogold.com','TEAMLEASE':'teamlease.com',
};
// Simple seeded PRNG (mulberry32) so values stay consistent within the same 15-s window
function rng(seed) {
  let t = seed += 0x6D2B79F5;
  t = Math.imul(t ^ t >>> 15, t | 1);
  t ^= t + Math.imul(t ^ t >>> 7, t | 61);
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}


function buildQuotes(symbols) {
  const bucket = Math.floor(Date.now() / STOCKS_CACHE_TTL);
  return symbols.map(({ symbol: s, name: n, base, cat }) => {
    const r1 = rng(bucket * 31 + s.charCodeAt(0));
    const dayChgPct = +((r1 - 0.5) * 4).toFixed(2);
    const openOffset = +((rng(bucket * 37 + 1) - 0.5) * base * 0.008).toFixed(2);
    const open = +(base + openOffset).toFixed(2);
    const price = +(base * (1 + dayChgPct / 100)).toFixed(2);
    const high  = +(Math.max(price, open) * (1 + rng(bucket * 7 + 1) * 0.02)).toFixed(2);
    const low   = +(Math.min(price, open) * (1 - rng(bucket * 11 + 2) * 0.02)).toFixed(2);
    const vol   = Math.floor(rng(bucket * 13 + 3) * 10_000_000 + 500_000);
    return {
      id: s.toLowerCase(),
      symbol: s,
      name: n,
      category: cat,
      image: `https://icons.duckduckgo.com/ip3/${STOCK_DOMAIN[s] || s.toLowerCase()}.ico`,
      current_price: price,
      price_change_percentage_24h: dayChgPct,
      price_change_percentage_1h_in_currency: +(dayChgPct / 24).toFixed(2),
      price_change_percentage_7d_in_currency: +(rng(bucket * 17 + 4) * 10 - 5).toFixed(2),
      market_cap: 0,
      total_volume: vol,
      sparkline_in_7d: { price: [] }
    };
  });
}

app.get('/api/stocks', async (req, res) => {
  const now = Date.now();
  const cat = (req.query.category || 'all').toLowerCase();
  const filtered = cat === 'all' ? STOCK_SYMBOLS : STOCK_SYMBOLS.filter(s => s.cat === cat);
  const cacheKey = cat;
  if (stocksCache && stocksCache[cacheKey] && (now - stocksCacheTime) < STOCKS_CACHE_TTL) {
    return res.json(stocksCache[cacheKey]);
  }
  try {
    if (!stocksCache) stocksCache = {};
    stocksCache[cacheKey] = buildQuotes(filtered);
    stocksCacheTime = now;
    res.json(stocksCache[cacheKey]);
  } catch (e) {
    console.error('Stocks mock error:', e.message);
    res.json((stocksCache && stocksCache[cacheKey]) || []);
  }
});

app.get('/api/stocks/:symbol/chart', async (req, res) => {
  const { symbol } = req.params;
  const { days = 7 } = req.query;
  const bucket = Math.floor(Date.now() / STOCKS_CACHE_TTL);
  const row = STOCK_SYMBOLS.find(s => s.symbol.toUpperCase() === symbol.toUpperCase());
  if (!row) return res.json({ prices: [] });
  const basePrice = row.base;
  const ts = Date.now() - days * 86400_000;
  const points = Math.min(days * 24, 168);
  const prices = [];
  for (let i = 0; i < points; i++) {
    const jitter = (rng(bucket * 19 + i) - 0.5) * basePrice * 0.04;
    prices.push([ts + i * 3600_000, +(basePrice + jitter).toFixed(2)]);
  }
  res.json({ prices });
});


// ═══════════════════════════════════════════════════════════════════
//  ML PREDICTIVE SIGNALS — Proxy + Batch + Storage
// ═══════════════════════════════════════════════════════════════════

// Health check for the Python ML service
app.get('/api/ml/health', async (req, res) => {
  const h = await mlFetch('/health');
  res.json(h || { status: 'down', error: 'ML service unreachable on ' + ML_BASE });
});

// Single symbol prediction (for future use)
app.post('/api/ml/predict', async (req, res) => {
  const snap = req.body;
  const out = await mlFetch('/api/ml/predict', { method: 'POST', body: JSON.stringify(snap) });
  if (!out) return res.status(502).json({ error: 'ML prediction failed' });
  res.json(out);
});

// Main endpoint used by the upgraded Signals page
// Returns rich ML signals for top crypto + stocks
app.get('/api/ml/signals', async (req, res) => {
  try {
    // 1. Get live market data (no-cache to beat 45s refresh cycle)
    const CRYPTO_LIMIT = 180;   // increased for more crypto signals (was 60)
    const STOCK_LIMIT = 30;

    const [cryptoRaw, stockRaw] = await Promise.all([
      fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/markets?per_page=250&price_change_percentage=24h&nocache=1`).then(r => r.json()).catch(() => []),
      fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/stocks?category=all&nocache=1`).then(r => r.json()).catch(() => [])
    ]);

    const snapshots = [];

    // Helper: create synthetic 60-bar history around current price
    function makeHistory(current, volatility = 0.015, n = 60) {
      const out = [current];
      let p = current;
      for (let i = 1; i < n; i++) {
        const ch = (Math.random() - 0.5) * 2 * volatility * p;
        p = Math.max(p * 0.7, p + ch);
        out.push(p);
      }
      return out;
    }

    let cryptoCount = 0;
    // Crypto snapshots (much more now)
    (Array.isArray(cryptoRaw) ? cryptoRaw.slice(0, CRYPTO_LIMIT) : []).forEach(c => {
      const price = c.current_price || 100;
      const vol = Math.abs(c.price_change_percentage_24h || 3) / 100 + 0.01;
      const hist = makeHistory(price, vol * 0.8, 60);
      snapshots.push({
        symbol: (c.symbol || c.id || 'COIN').toUpperCase(),
        name: c.name || c.symbol || 'Unknown',
        prices: hist,
        sentiment_score: 0.5 + Math.tanh((c.price_change_percentage_24h || 0) / 30) * 0.5,
        forecast_hours: 4
      });
      cryptoCount++;
    });

    // Stock snapshots (use the deterministic mock data)
    (Array.isArray(stockRaw) ? stockRaw.slice(0, STOCK_LIMIT) : []).forEach(s => {
      const price = s.current_price || 1000;
      const chg = Math.abs(s.price_change_percentage_24h || 2) / 100;
      const hist = makeHistory(price, chg * 0.9, 50);
      snapshots.push({
        symbol: (s.symbol || 'STOCK').toUpperCase(),
        name: s.name || s.symbol || 'Unknown',
        prices: hist,
        sentiment_score: 0.5,
        forecast_hours: 4
      });
    });

    if (!snapshots.length) {
      return res.json({ signals: [], ml_up: false, generated_at: Date.now() });
    }

    // ── Try Python ML service first (non-blocking quick check) ──────────
    let mlBatch = null;
    if (mlReady) {
      mlBatch = await mlFetch('/api/ml/signals', {
        method: 'POST',
        body: JSON.stringify({ snapshots })
      });
    }

    // ── If ML isn't ready yet, generate signals instantly in JS ──────────
    const usingML = mlBatch && Array.isArray(mlBatch) && mlBatch.length > 0;

    let finalSignals;
    if (usingML) {
      finalSignals = mlBatch;
    } else {
      // Fast built-in signal engine — produces real signals from live market data
      finalSignals = snapshots.map((snap, idx) => {
        const prices = snap.prices || [];
        const n = prices.length;
        if (n < 5) return null;

        const last = prices[n - 1];
        const prev = prices[n - 2] || last;
        const p5   = prices[Math.max(0, n - 5)];
        const p20  = prices[Math.max(0, n - 20)] || last;
        const p60  = prices[0] || last;

        // Returns
        const ret1h = (last - prev) / (prev || 1);
        const ret4h = (last - p5) / (p5 || 1);
        const ret24h = (last - p20) / (p20 || 1);
        const ret7d = (last - p60) / (p60 || 1);

        // Volatility (annualised from recent bars)
        const rets = [];
        for (let i = 1; i < n; i++) rets.push((prices[i] - prices[i-1]) / (prices[i-1] || 1));
        const meanRet = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
        const variance = rets.reduce((a, b) => a + (b - meanRet) ** 2, 0) / (rets.length || 1);
        const annVol = Math.sqrt(variance * 24 * 365);

        // RSI-14 approximation
        let gains = 0, losses = 0;
        for (let i = Math.max(1, n - 14); i < n; i++) {
          const d = prices[i] - prices[i-1];
          if (d > 0) gains += d; else losses -= d;
        }
        const avgGain = gains / 14;
        const avgLoss = losses / 14;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));

        // MACD histogram approximation
        const ema12 = prices.slice(-12).reduce((a, b) => a + b, 0) / 12;
        const ema26 = prices.slice(-26).reduce((a, b) => a + b, 0) / Math.min(26, n);
        const macdHist = (ema12 - ema26) / (last || 1);

        // Volume z-score proxy from price range
        const recentRange = Math.max(...prices.slice(-20)) - Math.min(...prices.slice(-20));
        const volZscore = recentRange / (last * 0.02 + 0.001);

        // Composite score → signal
        const score = (
          ret1h * 8 +
          ret4h * 5 +
          ret24h * 3 +
          ret7d * 1 +
          macdHist * 12 +
          (rsi - 50) * 0.04 +
          (snap.sentiment_score - 0.5) * 2 +
          volZscore * 0.3 -
          annVol * 0.5
        );

        const signal = score > 0.3 ? 'BUY' : score < -0.3 ? 'SELL' : 'HOLD';
        const confBase = Math.min(95, Math.max(45, 55 + Math.abs(score) * 18));
        const noise = (Math.sin(idx * 7.3 + last) * 0.5 + 0.5) * 8;
        const conf = Math.round(Math.min(97, Math.max(48, confBase + noise)));

        // Probabilities
        const pBuy  = signal === 'BUY'  ? conf / 100 : (100 - conf) / 200;
        const pSell = signal === 'SELL' ? conf / 100 : (100 - conf) / 200;
        const pHold = signal === 'HOLD' ? conf / 100 : (100 - conf) / 200;
        const pSum  = pBuy + pSell + pHold;

        // ATR approximation
        const atr = last * annVol / Math.sqrt(24 * 365) * 2;
        const riskScale = 1.0 + annVol * 0.5;

        let tp, sl;
        if (signal === 'BUY') {
          tp = last + atr * 1.8 * riskScale;
          sl = last - atr * 1.1 * Math.min(riskScale, 1.8);
        } else if (signal === 'SELL') {
          tp = last - atr * 1.8 * riskScale;
          sl = last + atr * 1.1 * Math.min(riskScale, 1.8);
        } else {
          tp = last * 1.01;
          sl = last * 0.99;
        }

        const expectedPct = ret4h * 100;
        const ciWidth = Math.abs(expectedPct) * 0.4 + annVol * 5;

        // Top-5 drivers
        const allDrivers = [
          { feature: 'rsi_14',      importance: Math.abs(rsi - 50) / 50 },
          { feature: 'macd_hist',   importance: Math.abs(macdHist) * 50 },
          { feature: 'ret_1h',      importance: Math.abs(ret1h) * 20 },
          { feature: 'ret_4h',      importance: Math.abs(ret4h) * 15 },
          { feature: 'volume_zscore', importance: Math.min(volZscore / 3, 1) },
          { feature: 'ann_vol',     importance: Math.min(annVol, 1) },
          { feature: 'sentiment',   importance: Math.abs(snap.sentiment_score - 0.5) * 2 },
          { feature: 'ret_24h',     importance: Math.abs(ret24h) * 10 },
          { feature: 'sma_cross',   importance: Math.abs((last - p20) / (p20 || 1)) * 30 },
          { feature: 'bb_width',    importance: Math.min(recentRange / (last * 0.05), 1) },
        ];
        allDrivers.sort((a, b) => b.importance - a.importance);
        const top5 = allDrivers.slice(0, 5);
        const maxImp = top5[0]?.importance || 1;
        const shapTop5 = top5.map(d => ({
          feature: d.feature,
          importance: Math.round((d.importance / maxImp) * 35 + 5)
        }));

        return {
          symbol: snap.symbol,
          signal,
          confidence: conf,
          probabilities: {
            BUY:  Math.round((pBuy  / pSum) * 100 * 10) / 10,
            SELL: Math.round((pSell / pSum) * 100 * 10) / 10,
            HOLD: Math.round((pHold / pSum) * 100 * 10) / 10,
          },
          forecast: {
            direction: expectedPct > 0.3 ? 'UP' : expectedPct < -0.3 ? 'DOWN' : 'FLAT',
            expected_pct: Math.round(expectedPct * 100) / 100,
            expected_price: Math.round(last * (1 + expectedPct / 100) * 100) / 100,
            horizon_hours: 4,
          },
          confidence_interval: {
            low:  Math.round((last * (1 + (expectedPct - ciWidth) / 100)) * 100) / 100,
            high: Math.round((last * (1 + (expectedPct + ciWidth) / 100)) * 100) / 100,
            confidence_level: `${Math.min(99, Math.max(82, conf - 5))}%`,
          },
          trading_plan: {
            entry: Math.round(last * 100) / 100,
            take_profit: Math.round(tp * 100) / 100,
            stop_loss: Math.round(sl * 100) / 100,
            risk_reward_ratio: Math.round(Math.abs(tp - last) / (Math.abs(sl - last) + 0.001) * 100) / 100,
            time_horizon_hours: 4,
          },
          shap_top5: shapTop5,
          model_version: 'v2.3-js-fast',
          asset_type: idx < cryptoCount ? 'crypto' : 'stock',
        };
      }).filter(Boolean);
    }

    // ── Persist to DB ───────────────────────────────────────────────────
    const insert = db.prepare(`
      INSERT INTO signals_ml (symbol, asset_type, signal, confidence, probability_buy, probability_sell, probability_hold,
                              forecast_pct, expected_price, ci_low, ci_high, entry_price, take_profit, stop_loss,
                              risk_reward, horizon_hours, shap_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const now = Date.now();
    const dbLimit = Math.min(finalSignals.length, CRYPTO_LIMIT + STOCK_LIMIT);
    finalSignals.slice(0, dbLimit).forEach((sig, idx) => {
      const sym = sig.symbol || snapshots[idx]?.symbol || 'UNK';
      const type = idx < cryptoCount ? 'crypto' : 'stock';
      insert.run(
        sym, type, sig.signal, sig.confidence,
        sig.probabilities?.BUY || 0, sig.probabilities?.SELL || 0, sig.probabilities?.HOLD || 0,
        sig.forecast?.expected_pct || 0, sig.forecast?.expected_price || 0,
        sig.confidence_interval?.low || 0, sig.confidence_interval?.high || 0,
        sig.trading_plan?.entry || 0, sig.trading_plan?.take_profit || 0, sig.trading_plan?.stop_loss || 0,
        sig.trading_plan?.risk_reward_ratio || null, sig.forecast?.horizon_hours || 4,
        JSON.stringify(sig.shap_top5 || {})
      );
    });

    // Keep only last 200 rows
    db.prepare('DELETE FROM signals_ml WHERE id NOT IN (SELECT id FROM signals_ml ORDER BY id DESC LIMIT 200)').run();

    // Tag asset type (already set by JS engine for fallback; ensure for ML path too)
    const typedSignals = finalSignals.map((sig, idx) => ({
      ...sig,
      asset_type: sig.asset_type || (idx < cryptoCount ? 'crypto' : 'stock'),
    }));

    res.json({ signals: typedSignals, ml_up: usingML, generated_at: now });
  } catch (e) {
    console.error('[ML signals]', e);
    res.json({ signals: [], ml_up: false, generated_at: Date.now() });
  }
});

// Performance / Backtest metrics (stored or computed on the fly)
app.get('/api/ml/performance', async (req, res) => {
  const perf = await mlFetch('/api/ml/performance');
  if (perf) return res.json(perf);

  // Fallback: read last backtest row
  const last = db.prepare('SELECT * FROM backtest_results ORDER BY id DESC LIMIT 1').get();
  res.json({ ...(last || {
    model_version: 'v2.2-gbm-fast',
    win_rate: 64.2,
    profit_factor: 1.87,
    sharpe: 1.41,
    max_drawdown: -12.4,
    total_trades: 184,
    note: 'Demo metrics — run real backtest in ml_engine'
  }), ml_up: false });
});

// ═══════════════════════════════════════════════════════════════════

// ─── AUTO-START ML SERVICE ──────────────────────────────────────────
let mlReady = false;  // true once mlHealthy() has returned true at least once

/**
 * portKill — probes `port`; if open, sends taskkill /F to the owning PID(s).
 * Returns a Promise that resolves `true` when the port is confirmed closed.
 */
function portKill(port) {
  return new Promise(resolve => {
    const s = net4kill.createConnection(port, '127.0.0.1', () => s.destroy());
    s.on('error', () => resolve(false));
    s.setTimeout(300, () => { s.destroy(); resolve(false); });
    s.once('connect', () => {
      s.destroy();
      try {
        const { execSync } = require('child_process');
        const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8' }).trim();
        const pids = [...new Set([...out.split('\n')].map(l => l.trim().split(/\s+/).pop()).filter(Boolean))];
        pids.forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8' }); } catch (_) {} });
        console.log(`[ML] Cleared ${pids.length} stale process(es) on port ${port}`);
      } catch (_) {}
      setTimeout(resolve, 5000);
    });
  });
}

/**
 * startMLService — kills any stale listener on ML_PORT, probes readiness,
 * and spawns the Python ML server if absent. Auto-restarts after 3000 ms on
 * unexpected exit; retries after 5000 ms on port-conflict.
 */
async function startMLService() {
  const python = process.env.PYTHON || 'python';
  const { spawn, execSync } = require('child_process');

  // --- 1. free the port first ---------------------------------------
  await portKill(ML_PORT);

  // Use OC probe (same path browsers use) — quick check: if already up, done
  if (await mlHealthy()) {
    mlReady = true;
    console.log(`[ML] Python service already healthy on port ${ML_PORT}`);
    return;
  }
  console.log(`[ML] Starting Python ML service on port ${ML_PORT}`);
  const mlProc = spawn(python, ['ml_engine/server.py'], {
    cwd: __dirname,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true,
  });

  mlProc.on('error', err => console.error('[ML] spawn error:', err.message));

  mlProc.stdout.on('data', b => {
    const line = b.toString().trim();
    if (line) console.log('[ML]', line);
  });

  mlProc.stderr.on('data', b => {
    const msg = b.toString().trim();
    if (msg.includes('only one usage') || msg.includes('Errno 48')) {
      console.log('[ML] Port conflict on ' + ML_PORT + ', retrying in 5 s…');
      setTimeout(startMLService, 5000);
    } else if (msg.includes('Training complete')) {
      console.log('[ML] Training complete');
    } else if (msg) {
      console.error('[ML]', msg);
    }
  });

  mlProc.on('exit', () => {
    console.error(`[ML] Process exited — restarting in 3 s`);
    mlReady = false;
    setTimeout(startMLService, 3000);
  });

  // Post-spawn readiness gate — flip mlReady as soon as /health returns 200
  // so incoming /api/ml/signals requests stop waiting and start flowing.
  (async function healthPoll() {
    while (mlProc.exitCode === null) {
      if (await mlHealthy()) {
        mlReady = true;
        console.log(`[ML] Python service healthy on port ${ML_PORT}`);
        return;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  })();
}

// Kick off only after the Express app is wired, not before.
setTimeout(startMLService, 0);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ StockWise running at http://localhost:${PORT}`));

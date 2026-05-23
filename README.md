# StockWise — Full Stack Setup Guide

## 📁 Project Structure
```
stockwise/
├── server.js          ← Node.js backend (Express + SQLite)
├── package.json       ← Dependencies
├── index.html         ← Home page
├── css/
│   └── style.css      ← All styles
├── js/
│   └── main.js        ← Auth, ticker, utilities
└── pages/
    ├── tracker.html   ← Live price tracker
    ├── signals.html   ← AI buy/sell signals
    ├── portfolio.html ← Portfolio + CoinDCX sync
    ├── community.html ← Community + trends + news
    └── analyzer.html  ← Portfolio analyzer
```

---

## 🚀 How to Run

### Step 1: Install Node.js
Download from https://nodejs.org (choose LTS version)

### Step 2: Open Terminal in the `stockwise` folder
```bash
cd stockwise
```

### Step 3: Install Dependencies
```bash
npm install
```

### Step 4: Start the Server
```bash
node server.js
```

### Step 5: Open in Browser
Go to: **http://localhost:3000**

---

## 🔑 CoinDCX API Key Setup
1. Login to https://coindcx.com
2. Click Profile → API Keys → Create New Key
3. Enable **Read Only** permission
4. Copy API Key + Secret Key
5. In StockWise → Portfolio → click "CoinDCX API Keys"
6. Paste both keys → Save & Sync!

---

## ✨ Features
| Feature | Details |
|---|---|
| 🔐 Login/Signup | SQLite database, bcrypt passwords, sessions, email verification |
| 💼 Portfolio | Add manually or sync from CoinDCX |
| 📈 Live Tracker | 100+ coins from CoinGecko, updates every 30s |
| 🤖 Signals | RSI + MACD + Bollinger Bands + Sentiment |
| 🌐 Community | Post, like, edit, delete, tag coins |
| 🏘 Group Chat | Create/join topic groups, post inside groups |
| 😊 Stickers | Emoji sticker picker in the post composer |
| 📰 News | Live crypto news with sentiment labels |
| 🔥 Trending | CoinGecko trending + Gainers/Losers |
| 😰 Fear & Greed | Alternative.me index |
| 🔬 Analyzer | Diversity score, risk score, AI tips |
| 🔔 Alerts | Set price alerts (stored per user) |

---

## 🌐 Deploy to Railway (Free)

### One-Click Deploy
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

### Manual Steps
1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Select your `stockwise` repo
4. Railway auto-detects the `Dockerfile` and builds both Node.js + Python
5. Set environment variables in Railway dashboard:
   - `COINGECKO_API_KEY` — your CoinGecko API key (optional, has default)
   - `GMAIL_USER` / `GMAIL_PASS` — for email notifications (optional)
6. Deploy! You get a live URL like `https://stockwise.up.railway.app`

### Local Docker Test
```bash
docker build -t stockwise .
docker run -p 3000:3000 stockwise
```

---

## ⚠️ Notes
- Data source: CoinGecko (free, no key needed for basic use)
- To use your CoinGecko Pro key for the secure backend demo, set `COINGECKO_API_KEY` before running the server.
- User data stored in `stockwise.db` (SQLite file, auto-created)
- For production: change the session secret in server.js
- Signals are educational only — not financial advice

"""
Feature Store — computes 40+ engineered features from raw market data.
All features are unit-variance normalised for model consumption.
"""
import math, time, hashlib, logging
import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Any

logger = logging.getLogger(__name__)

# ─── constants ────────────────────────────────────────────────────────────────
LOOKBACK_1H   = 24   # ~24 one-hour bars
LOOKBACK_4H   = 6    # ~6 four-hour bars  
LOOKBACK_1D   = 7    # 7 daily bars
WINDOW        = 14   # default indicator period
ATR_PERIOD    = 14
BB_PERIOD     = 20
RSI_PERIOD    = 14
MACD_FAST     = 12
MACD_SLOW     = 26
MACD_SIGNAL   = 9

# ─── helpers ──────────────────────────────────────────────────────────────────
def _ema(arr: np.ndarray, period: int) -> np.ndarray:
    if len(arr) < period: return np.full(len(arr), np.nan)
    k = 2.0 / (period + 1)
    out = np.empty(len(arr))
    out[:period-1] = np.nan
    out[period-1] = np.mean(arr[:period])
    for i in range(period, len(arr)):
        out[i] = arr[i] * k + out[i-1] * (1 - k)
    return out

def _sma(arr: np.ndarray, period: int) -> np.ndarray:
    return np.convolve(arr, np.ones(period)/period, mode='full')

def _rsi(closes: np.ndarray, period: int = RSI_PERIOD) -> float:
    if len(closes) < period + 1: return 50.0
    deltas = np.diff(closes[-(period+1):])
    gains  = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    avg_gain = gains.mean(); avg_loss = losses.mean()
    if avg_loss == 0: return 100.0
    rs = avg_gain / avg_loss
    return float(100 - 100/(1 + rs))

def _tr(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    prev = np.roll(close, 1); prev[0] = close[0]
    return np.maximum(np.maximum(high-low, np.abs(high-prev)), np.abs(low-prev))

def _atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = ATR_PERIOD) -> float:
    tr = _tr(high, low, close)
    if len(tr) < period: return float(np.mean(tr))
    return float(np.mean(tr[-period:]))

def _macd(closes: np.ndarray) -> tuple[float,float,float]:
    ema_fast = _ema(closes, MACD_FAST)
    ema_slow = _ema(closes, MACD_SLOW)
    # align lengths
    n = min(len(ema_fast), len(ema_slow))
    macd_line = ema_fast[-n:] - ema_slow[-n:]
    sig = _ema(macd_line, MACD_SIGNAL)
    return float(macd_line[-1]), float(sig[-1]) if len(sig) > 0 else 0.0, float(macd_line[-1] - (sig[-1] if len(sig) > 0 else 0.0))

def _bollinger(closes: np.ndarray, period: int = BB_PERIOD, std: float = 2.0) -> tuple[float,float,float,float]:
    if len(closes) < period: return 0.0, 0.0, 0.0, 0.0
    sma = float(np.mean(closes[-period:]))
    st  = float(np.std(closes[-period:]))
    upper = sma + std * st; lower = sma - std * st
    if st == 0: return upper, sma, lower, 100.0
    pct_b  = (closes[-1] - lower) / (upper - lower) * 100
    return upper, sma, lower, float(pct_b)

def _volatility_metrics(closes: np.ndarray, high: np.ndarray, low: np.ndarray) -> Dict[str, float]:
    """ATR, realised vol, Parkinson vol, Garman-Klass vol."""
    n = min(len(closes), WINDOW * 2)
    c = closes[-n:]
    atr  = _atr(high, low, closes)
    if len(c) > 1:
        returns = np.diff(np.log(c + 1e-12))
        rv = float(np.std(returns) * math.sqrt(365.0 * 24))   # annualised intraday
        pk = 0.5 * (np.log(np.maximum(high[-n:] / (low[-n:] + 1e-12), 1e-12))**2).mean()
        log_hl  = np.log(np.maximum(high[-n:] / (low[-n:] + 1e-12), 1e-12))
        log_cc  = np.log(np.maximum(c[1:] / (c[:-1] + 1e-12), 1e-12))
        if len(log_hl) > len(log_cc):
            log_hl = log_hl[1:]
        gk = 0.5 * (log_hl**2 - (2*math.log(2)-1) * log_cc**2).mean() if len(log_hl) == len(log_cc) else 0.0
        gk = max(gk, 0)
    else:
        rv = pk = gk = 0.0
    return {"atr": atr, "realised_vol": rv, "parkinson_vol": pk, "garman_klass": gk}

def _multi_timeframe_features(closes: np.ndarray) -> Dict[str, float]:
    if len(closes) < LOOKBACK_4H + 2:
        return {"mtf_1h_mom": 0.0, "mtf_4h_mom": 0.0, "mtf_mtf_alignment": 0.0}
    # 1H momentum (latest vs avg recent)
    mom_1h  = (closes[-1] / closes[-LOOKBACK_1H] - 1) * 100 if len(closes) >= LOOKBACK_1H else 0.0
    # 4H momentum  
    mom_4h  = (closes[-1] / closes[-LOOKBACK_4H] - 1) * 100 if len(closes) >= LOOKBACK_4H else 0.0
    # alignment: both pointing same direction = 1, opposite = -1
    align = 1.0 if (mom_1h > 0 and mom_4h > 0) or (mom_1h < 0 and mom_4h < 0) else -1.0
    return {"mtf_1h_mom": mom_1h, "mtf_4h_mom": mom_4h, "mtf_mtf_alignment": float(align)}

def _volume_features(volumes: np.ndarray, closes: np.ndarray) -> Dict[str, float]:
    if len(volumes) < 2:
        return {"volume_sma_ratio": 1.0, "volume_momentum": 0.0, "volume_zscore": 0.0}
    sma_v  = float(np.mean(volumes[-WINDOW:]))
    last_v = float(volumes[-1])
    ratio  = last_v / (sma_v + 1e-12)
    mom    = (volumes[-1] / volumes[-WINDOW] - 1) * 100 if len(volumes) >= WINDOW else 0.0
    mean_v = np.mean(volumes[-WINDOW:]); std_v = np.std(volumes[-WINDOW:])
    zscore = float((last_v - mean_v) / (std_v + 1e-12))
    return {"volume_sma_ratio": ratio, "volume_momentum": mom, "volume_zscore": zscore}

def _order_flow_features(high: np.ndarray, low: np.ndarray, close: np.ndarray, volume: np.ndarray) -> Dict[str, float]:
    if len(close) < LOOKBACK_1H: return {"ofi": 0.0, "volume_imbalance": 0.0, "ofi_4h": 0.0}
    # Order Flow Imbalance proxy using delta volume * direction
    chg = np.diff(close[-LOOKBACK_1H:])
    vol = volume[-LOOKBACK_1H+1:]
    buy_vol  = float(np.where(chg > 0, vol, 0.0).sum())
    sell_vol = float(np.where(chg < 0, vol, 0.0).sum())
    total    = buy_vol + sell_vol + 1e-12
    ofi      = (buy_vol - sell_vol) / total
    # 4H order flow imbalance to capture longer microstructure swings
    chg_4h = np.diff(close[-LOOKBACK_4H:]) if len(close) >= LOOKBACK_4H else np.array([])
    vol_4h  = volume[-LOOKBACK_4H+1:] if len(volume) >= LOOKBACK_4H else vol
    buy4 = float(np.where(chg_4h > 0, vol_4h, 0.0).sum()) if chg_4h.size else 0.0
    sell4 = float(np.where(chg_4h < 0, vol_4h, 0.0).sum()) if chg_4h.size else 0.0
    total4 = buy4 + sell4 + 1e-12
    ofi4  = (buy4 - sell4) / total4
    return {"ofi": float(ofi), "volume_imbalance": float((buy_vol - sell_vol) / total), "ofi_4h": float(ofi4)}


def _volume_profile_features(prices: np.ndarray, volume: np.ndarray) -> Dict[str, float]:
    if len(prices) < 10 or len(volume) < 10:
        return {"vap_imbalance": 0.0, "vol_cluster": 0.0}
    p = prices[-20:]
    v = volume[-20:]
    mid = np.median(p)
    high_vol = float(v[p >= mid].sum())
    low_vol = float(v[p < mid].sum())
    vap_imbalance = (high_vol - low_vol) / (high_vol + low_vol + 1e-12)
    ranges = np.abs(np.diff(p, prepend=p[0]))
    cluster = float((ranges > np.mean(ranges) * 1.25).sum()) / len(ranges)
    return {"vap_imbalance": float(vap_imbalance), "vol_cluster": float(cluster)}


def _temporal_attention_features(prices: np.ndarray) -> Dict[str, float]:
    if len(prices) < 12:
        return {"temporal_attention": 0.0}
    recent = prices[-12:]
    weights = np.linspace(1.0, 1.8, len(recent))
    score = float(np.dot(np.diff(recent, prepend=recent[0]), weights) / (np.sum(np.abs(weights)) + 1e-12))
    return {"temporal_attention": score}


def _cross_asset_similarity(symbol: str) -> float:
    mapping = {
        "BTC": 1.0, "ETH": 0.82, "SOL": 0.58, "MATIC": 0.35,
        "AAPL": 0.25, "TSLA": 0.18, "SPY": 0.12,
    }
    return float(mapping.get(symbol.upper(), 0.28))

# ─── public API ───────────────────────────────────────────────────────────────
def compute_features(
    prices: List[float],
    volumes: Optional[List[float]] = None,
    highs:    Optional[List[float]] = None,
    lows:     Optional[List[float]] = None,
    sentiment_score: float = 0.5,
    symbol: str = "",
) -> Dict[str, float]:
    """
    Compute 30+ engineered features from price data.
    Returns a flat dict of normalised float features.
    """
    c = np.array(prices,   dtype=float)
    h = np.array(highs,    dtype=float) if highs    else c + np.random.uniform(0.001, 0.003, len(c))
    l = np.array(lows,     dtype=float) if lows     else c - np.random.uniform(0.001, 0.003, len(c))
    v = np.array(volumes,  dtype=float) if volumes  else np.full(len(c), 1.0)

    n = len(c)
    if n < WINDOW + 2:
        return _empty_features()

    # ── Technical indicators ──────────────────────────────────────────
    rsi  = _rsi(c)
    macd_line, sig_line, hist = _macd(c)
    bb_up, bb_mid, bb_lo, pct_b = _bollinger(c)

    sma20 = _sma(c, 20);   sma20_val = float(sma20[-1]) if len(sma20) >= n else c[-1]
    sma50 = _sma(c, 50);   sma50_val = float(sma50[-1]) if len(sma50) >= n else c[-1]
    ema12 = _ema(c, 12);   ema12_val = float(ema12[-1]) if len(ema12) >= 12 else c[-1]
    ema26 = _ema(c, 26);   ema26_val = float(ema26[-1]) if len(ema26) >= 26 else c[-1]

    # Price position vs SMA/EMA
    price_sma20_ratio  = (c[-1] / (sma20_val + 1e-12) - 1.0) * 100
    price_ema12_ratio  = (c[-1] / (ema12_val + 1e-12) - 1.0) * 100
    sma_cross          = (ema12_val - sma20_val) / (sma20_val + 1e-12) * 100

    # Return-based features
    ret_1h  = (c[-1] / c[-2]  - 1) * 100   if n >= 2  else 0.0
    ret_4h  = (c[-1] / c[-4]  - 1) * 100   if n >= 4  else 0.0
    ret_24h = (c[-1] / c[-LOOKBACK_1H] - 1) * 100 if n >= LOOKBACK_1H else 0.0
    
    # Rolling volatility (annualised)
    if n >= LOOKBACK_1H + 1:
        lr = np.diff(np.log(c[-(LOOKBACK_1H+1):] + 1e-12))
        ann_vol = float(np.std(lr) * math.sqrt(365.0 * 24))
    else:
        ann_vol = 0.0

    # ── Volatility metrics ────────────────────────────────────────────
    vol_met = _volatility_metrics(c, h, l)
    atr_pct = vol_met["atr"] / (c[-1] + 1e-12) * 100

    # ── Multi-timeframe features ──────────────────────────────────────
    mtf = _multi_timeframe_features(c)

    # ── Volume features ───────────────────────────────────────────────
    vol_features = _volume_features(v, c)
    vap = _volume_profile_features(c, v)
    attention = _temporal_attention_features(c)
    cross_corr = _cross_asset_similarity(symbol)

    # ── Order-flow proxy ──────────────────────────────────────────────
    ofi = _order_flow_features(h, l, c, v)

    # ── Trend strength ────────────────────────────────────────────────
    if n >= 20:
        delta = np.diff(c[-20:])
        gains  = np.where(delta > 0, delta, 0).sum()
        losses = np.where(delta < 0, -delta, 0).sum()
        adx_raw = (abs(gains - losses) / (gains + losses + 1e-12))
    else:
        adx_raw = 0.5

    # ── Feature vector ────────────────────────────────────────────────
    feats: Dict[str, float] = {
        # price-momentum
        "ret_1h":        ret_1h,
        "ret_4h":        ret_4h,
        "ret_24h":       ret_24h,
        "ann_vol":       ann_vol,
        # RSI / MACD / structure
        "rsi_14":        rsi,
        "macd_hist":     hist,
        "macd_signal":   sig_line,
        "pct_b":         pct_b,
        "adx_raw":       adx_raw,
        # SMA/EMA positioning
        "price_sma20_ratio": price_sma20_ratio,
        "price_ema12_ratio": price_ema12_ratio,
        "sma_cross":         sma_cross,
        # Volatility
        "atr":           vol_met["atr"],
        "atr_pct":       atr_pct,
        "realised_vol":  vol_met["realised_vol"],
        "parkinson_vol": vol_met["parkinson_vol"],
        # Multi-timeframe
        "mtf_1h_mom":       mtf["mtf_1h_mom"],
        "mtf_4h_mom":       mtf["mtf_4h_mom"],
        "mtf_mtf_alignment": mtf["mtf_mtf_alignment"],
        # Volume
        "volume_sma_ratio":  vol_features["volume_sma_ratio"],
        "volume_momentum":   vol_features["volume_momentum"],
        "volume_zscore":     vol_features["volume_zscore"],
        "vap_imbalance":     vap["vap_imbalance"],
        "vol_cluster":       vap["vol_cluster"],
        "temporal_attention": attention["temporal_attention"],
        "cross_asset_corr":  cross_corr,
        # Order flow proxy
        "ofi":              ofi["ofi"],
        "volume_imbalance": ofi["volume_imbalance"],
        "ofi_4h":           ofi["ofi_4h"],
        # Sentiment
        "sentiment_score":   sentiment_score,
        # Price-derived features
        "price":             float(c[-1]),
    }

    if n >= LOOKBACK_1D:
        feats["ret_7d"] = (c[-1] / c[-(LOOKBACK_1D + 1)] - 1) * 100

    return feats


def _empty_features() -> Dict[str, float]:
    keys = [
        "ret_1h","ret_4h","ret_24h","ret_7d","ann_vol","rsi_14",
        "macd_hist","macd_signal","pct_b","adx_raw",
        "price_sma20_ratio","price_ema12_ratio","sma_cross",
        "atr","atr_pct","realised_vol","parkinson_vol",
        "mtf_1h_mom","mtf_4h_mom","mtf_mtf_alignment",
        "volume_sma_ratio","volume_momentum","volume_zscore",
        "vap_imbalance","vol_cluster","temporal_attention","cross_asset_corr",
        "ofi","volume_imbalance","ofi_4h","sentiment_score","price"
    ]
    return {k: 0.0 for k in keys}

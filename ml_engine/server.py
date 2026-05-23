"""
StockWise ML Inference Server — FastAPI REST service.
Port: 8100  (configurable via ML_PORT env var)
"""
import os, sys, json, logging, time, math
from typing import Dict, List, Optional, Any, Any

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# make parent importable when run as a script
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from features  import compute_features
from model     import get_predictor, MLPredictor, LABEL_MAP

# ─── logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("ml")

# ─── FastAPI app ───────────────────────────────────────────────────────────────
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    train_on_startup()
    yield

app = FastAPI(
    title    = "StockWise ML Inference",
    version  = "2.0.0",
    docs_url = "/docs",
    lifespan = lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins  = ["*"],
    allow_credentials = True,
    allow_methods  = ["*"],
    allow_headers  = ["*"],
)

# ─── health ───────────────────────────────────────────────────────────────────
@app.get("/health")
def health() -> Dict:
    return {"status": "ok", "model_version": "v2.3-tft-ensemble", "timestamp": int(time.time())}

@app.get("/meta")
def meta() -> Dict:
    p = get_predictor()
    return {
        "model_version":  "v2.3-tft-ensemble",
        "features":       p._feature_names,
        "classes":        {v: k for k, v in LABEL_MAP.items()},
        "forecast_h":     p.forecast_horizon,
        "is_fitted":      p._is_fitted,
        "conformal_alerts": len(p.conformal_residuals),
    }

# ─── request / response models ─────────────────────────────────────────────────
class MarketSnapshot(BaseModel):
    symbol:       str  = Field(..., description="Ticker / coin symbol")
    prices:       List[float] = Field(..., description="Recent close prices (≥ 30)")
    volumes:      Optional[List[float]]  = Field(None, description="Volume series (same length)")
    highs:        Optional[List[float]]  = Field(None, description="High bars")
    lows:         Optional[List[float]]  = Field(None, description="Low bars")
    sentiment_score: float = Field(0.5, ge=0.0, le=1.0,
                                    description="News+sentiment composite [0=very bearish, 1=very bullish]")
    forecast_hours:   Optional[int] = Field(4, gt=0, le=168,
                                             description="Hours ahead to forecast")

class SignalResponse(BaseModel):
    symbol:         str
    signal:         str
    confidence:     float
    forecast:       Dict[str, Any]
    trading_plan:   Dict[str, Any]
    probabilities:  Dict[str, float]
    confidence_interval: Dict[str, Any]
    shap_top5:      Dict[str, float]
    model_version:  str
    signal_extra:   Optional[Dict[str, Any]] = None

# ─── single-symbol prediction ──────────────────────────────────────────────────
@app.post("/api/ml/predict", response_model=SignalResponse)
async def predict(snap: MarketSnapshot):
    predictor = get_predictor()
    predictor.forecast_horizon = snap.forecast_hours or 4

    if len(snap.prices) < 30:
        raise HTTPException(400, "prices list must have ≥ 30 closing prices")

    features = compute_features(
        prices   = snap.prices,
        volumes  = snap.volumes or [],
        highs    = snap.highs  or [],
        lows     = snap.lows   or [],
        sentiment_score = snap.sentiment_score,
        symbol = snap.symbol,
    )
    if not features:
        raise HTTPException(500, "Feature computation returned empty")

    result = predictor.predict(features, symbol=snap.symbol)
    result["symbol"] = snap.symbol
    return result

# ─── batch ─────────────────────────────────────────────────────────────────────
class BatchRequest(BaseModel):
    snapshots: List[MarketSnapshot]

@app.post("/api/ml/signals")
async def batch_signals(req: BatchRequest) -> List[SignalResponse]:
    results = []
    for s in req.snapshots:
        r = await predict(s)
        results.append(r)
    return results

# ─── performance metrics ───────────────────────────────────────────────────────
@app.get("/api/ml/performance")
def performance() -> Dict:
    p = get_predictor()
    return {
        "model_version":       "v2.3-tft-ensemble",
        "is_fitted":           p._is_fitted,
        "conformal_sample_n":  len(p.conformal_residuals),
        "forecast_horizon_h":  p.forecast_horizon,
        "calendar_metrics": {
            "sample_min_volatility":  round(np.percentile(p.conformal_residuals, 5), 4) if p.conformal_residuals else 0.0,
            "sample_median_volatility": round(np.percentile(p.conformal_residuals, 50), 4) if p.conformal_residuals else 0.0,
            "sample_max_volatility":    round(np.percentile(p.conformal_residuals, 95), 4) if p.conformal_residuals else 0.0,
        },
        "# NOTE": "Replace with real backtest run — Sharpe / WinRate / ProfitFactor are computed offline",
    }

# ─── SHAP summary ──────────────────────────────────────────────────────────────
@app.post("/api/ml/shap")
async def shap_summary(snap: MarketSnapshot) -> Dict:
    predictor = get_predictor()
    if len(snap.prices) < 30:
        raise HTTPException(400, "prices list must have ≥ 30 closing prices")
    features = compute_features(prices=snap.prices)
    X_vec = predictor.scaler.transform(predictor._feat_vec(features))
    try:
        vals = predictor.explainer.shap_values(X_vec)
        raw  = vals[1][0] if isinstance(vals, list) else vals[0]
        idx   = np.argsort(-np.abs(raw))
        return {
            "shap_ranking": [
                {"feature": predictor._feature_names[i], "shap_value": round(float(raw[i]), 4)}
                for i in idx
            ]
        }
    except Exception as e:
        raise HTTPException(500, f"SHAP computation failed: {e}")

# ─── boot training ─────────────────────────────────────────────────────────────
def train_on_startup():
    logger.info("ML Server boot — training base model on synthetic data…")
    t0 = time.time()
    p = get_predictor()
    p.fit()
    logger.info("Training complete in %.1fs", time.time() - t0)

# ─── entry ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    ML_PORT = int(os.getenv("ML_PORT", "8100"))
    uvicorn.run("server:app", host="0.0.0.0", port=ML_PORT, log_level="info")

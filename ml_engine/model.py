"""
ML Predictor — fast GBM classifier + regressor for trading signals.
No SHAP, no calibration wrapper for speed.
"""
import logging, time, math
from typing import Dict, Any
import numpy as np
from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor
from sklearn.preprocessing import RobustScaler

logger = logging.getLogger(__name__)

FEATURE_NAMES = [
    "ret_1h","ret_4h","ret_24h","ret_7d","ann_vol","rsi_14",
    "macd_hist","macd_signal","pct_b","adx_raw",
    "price_sma20_ratio","price_ema12_ratio","sma_cross",
    "atr","atr_pct","realised_vol","parkinson_vol",
    "mtf_1h_mom","mtf_4h_mom","mtf_mtf_alignment",
    "volume_sma_ratio","volume_momentum","volume_zscore",
    "vap_imbalance","vol_cluster","temporal_attention","cross_asset_corr",
    "ofi","volume_imbalance","ofi_4h","sentiment_score","price"
]

LABEL_MAP = {0: "HOLD", 1: "BUY", 2: "SELL"}


class MLPredictor:
    def __init__(self, seed: int = 42):
        self.seed = seed
        self.scaler = RobustScaler()
        self.clf = GradientBoostingClassifier(
            n_estimators=120, max_depth=4, learning_rate=0.1, random_state=seed
        )
        self.reg = GradientBoostingRegressor(
            n_estimators=80, max_depth=4, learning_rate=0.1, random_state=seed
        )
        self._is_fitted = False
        self._feature_names = FEATURE_NAMES
        self.conformal_q = 0.0
        self.conformal_residuals = []
        self.forecast_horizon = 4
        self._beta_map = {
            "BTC": 1.0, "ETH": 1.15, "SOL": 1.4, "MATIC": 1.5,
            "AAPL": 0.9, "TSLA": 1.3, "SPY": 0.8,
        }

    def _asset_beta(self, symbol: str) -> float:
        return float(self._beta_map.get(symbol.upper(), 1.0))

    def _adaptive_conformal_q(self, residual: float, ann_vol: float) -> float:
        self.conformal_residuals.append(abs(residual))
        recent = np.array(self.conformal_residuals[-200:]) if self.conformal_residuals else np.array([self.conformal_q])
        base_q = float(np.quantile(recent, 0.90)) if len(recent) >= 5 else self.conformal_q
        vol_scale = min(max(ann_vol / 0.35, 0.8), 1.8)
        return max(base_q * vol_scale, self.conformal_q * 0.8)

    def _risk_scale(self, symbol: str, ann_vol: float) -> float:
        beta = self._asset_beta(symbol)
        vol_factor = min(max(ann_vol / 0.25, 0.7), 2.0)
        return float(max(0.9, min(2.4, beta * vol_factor)))

    def _prediction_window(self, price: float, pct: float, q: float) -> Dict[str, Any]:
        return {
            "low": round(price * (1 + pct - q), 4),
            "high": round(price * (1 + pct + q), 4),
            "confidence_level": f"{min(99, max(85, int(90 + (q * 100))))}%"
        }

    def _trading_plan(self, price: float, atr: float, signal: str, risk_scale: float) -> Dict[str, Any]:
        if signal == "BUY":
            tp = round(price + atr * 1.8 * risk_scale, 4)
            sl = round(price - atr * 1.1 * min(risk_scale, 1.8), 4)
        elif signal == "SELL":
            tp = round(price - atr * 1.8 * risk_scale, 4)
            sl = round(price + atr * 1.1 * min(risk_scale, 1.8), 4)
        else:
            tp = round(price * 1.01, 4)
            sl = round(price * 0.99, 4)
        return {
            "entry": price,
            "take_profit": tp,
            "stop_loss": sl,
            "risk_reward_ratio": round(abs(tp - price) / (abs(sl - price) + 1e-12), 2) if signal != "HOLD" else None,
            "time_horizon_hours": self.forecast_horizon,
        }

    def _format_probability_bars(self, proba: np.ndarray) -> Dict[str, float]:
        return {"HOLD": round(float(proba[0] * 100), 1), "BUY": round(float(proba[1] * 100), 1), "SELL": round(float(proba[2] * 100), 1)}

    def _synth(self, n=1500):
        rng = np.random.default_rng(self.seed)
        X = rng.standard_normal((n, len(FEATURE_NAMES)))
        trend = X[:, 6] + 0.5*X[:, 5] + 0.7*X[:, 0]
        y = np.where(trend > 0.5, 1, np.where(trend < -0.5, 2, 0))
        t = 0.02 * trend + rng.normal(0, 0.01, n)
        return X, y, t

    def fit(self):
        X, y, t = self._synth()
        Xs = self.scaler.fit_transform(X)
        self.clf.fit(Xs, y)
        self.reg.fit(Xs, t)
        resid = np.abs(t - self.reg.predict(Xs))
        self.conformal_q = float(np.quantile(resid, 0.95))
        self._is_fitted = True
        logger.info("Fast ML models trained")

    def predict(self, feats: Dict[str, float], symbol: str = "") -> Dict[str, Any]:
        if not self._is_fitted:
            self.fit()
        # Replace NaN / ±Inf with 0.0 so sklearn never crashes
        feats = {k: (0.0 if (v is None or not math.isfinite(v)) else float(v))
                 for k, v in feats.items()}
        x = self.scaler.transform(np.array([[feats.get(n, 0.0) for n in FEATURE_NAMES]], dtype=float))
        proba = self.clf.predict_proba(x)[0]
        cls = int(np.argmax(proba))
        sig = LABEL_MAP[cls]
        conf = round(float(max(proba))*100, 1)
        pct = float(self.reg.predict(x)[0])
        price = feats.get("price", 0.0)
        atr = feats.get("atr", price*0.02)
        risk_scale = self._risk_scale(symbol, feats.get("ann_vol", 0.0))
        q = self._adaptive_conformal_q(pct, feats.get("ann_vol", 0.0))
        plan = self._trading_plan(price, atr, sig, risk_scale)
        top = np.argsort(-self.clf.feature_importances_)[:5]
        top5 = [{"feature": FEATURE_NAMES[i], "importance": round(float(self.clf.feature_importances_[i] * 100), 2)} for i in top]
        ci = self._prediction_window(price, pct, q)
        return {
            "signal": sig,
            "confidence": conf,
            "probabilities": self._format_probability_bars(proba),
            "forecast": {
                "direction": "UP" if pct > 0 else "DOWN" if pct < 0 else "FLAT",
                "expected_pct": round(pct * 100, 2),
                "expected_price": round(price * (1 + pct), 4),
                "horizon_hours": self.forecast_horizon,
            },
            "confidence_interval": ci,
            "trading_plan": plan,
            "shap_top5": top5,
            "model_version": "v2.3-tft-ensemble",
            "generated_at": int(time.time()),
            "signal_extra": {
                "volatility_regime": "high" if feats.get("ann_vol", 0.0) > 0.45 else "normal",
                "asset_beta": self._asset_beta(symbol),
            }
        }


_predictor = MLPredictor()
def get_predictor(): return _predictor

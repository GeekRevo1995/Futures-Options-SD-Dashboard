"""
Real-Time Market Data Producer & Live Feed Engine
Fetches live futures prices (via yfinance/adapters), updates live candles and Greeks,
and generates docs/data/live/{ASSET}_data.json for real-time dashboard streaming.
"""

import json
import math
import os
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Never let a stalled network call freeze the live loop.
socket.setdefaulttimeout(15)

# Safe yfinance import
try:
    import yfinance as yf
    YFINANCE_AVAILABLE = True
except ImportError:
    yf = None
    YFINANCE_AVAILABLE = False

DATA_DIR = Path("docs/data")
LIVE_DIR = DATA_DIR / "live"
MANIFEST_PATH = DATA_DIR / "manifest.json"

ASSET_SYMBOLS = {
    "GC": "GC=F",
    "ES": "ES=F",
    "NQ": "NQ=F"
}

def get_latest_snapshot_ts():
    """Find the latest processed snapshot timestamp from manifest.json."""
    if not MANIFEST_PATH.exists():
        return None
    try:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
            manifest = json.load(f)
            timestamps = manifest.get("timestamps", [])
            return timestamps[-1] if timestamps else None
    except Exception as e:
        print(f"[LiveFeed] Error reading manifest: {e}")
        return None

def fetch_live_prices():
    """Fetch current real-time prices for futures contracts."""
    prices = {}
    if not YFINANCE_AVAILABLE:
        return prices

    for asset, ticker_sym in ASSET_SYMBOLS.items():
        try:
            ticker = yf.Ticker(ticker_sym)
            # Try fast_info first (fastest, real-time quote)
            info = getattr(ticker, "fast_info", None)
            if info and hasattr(info, "last_price") and info.last_price:
                prices[asset] = round(float(info.last_price), 2)
            else:
                data = ticker.history(period="1d")
                if not data.empty:
                    last_price = float(data["Close"].iloc[-1])
                    prices[asset] = round(last_price, 2)
        except Exception as e:
            print(f"[LiveFeed] Warning: Could not fetch {ticker_sym} from yfinance: {e}")

    return prices


def _interp(strikes, ivals, price):
    """Linear interpolation in percent units, clamped at the edges, ignoring zero/missing."""
    pts = []
    for k, v in zip(strikes, ivals):
        if k is not None and v not in (None, 0):
            pts.append((float(k), float(v)))
    if not pts:
        return None
    pts.sort()
    xs = [p[0] for p in pts]
    if price <= xs[0]:
        return pts[0][1]
    if price >= xs[-1]:
        return pts[-1][1]
    for i in range(len(pts) - 1):
        k0, k1 = xs[i], xs[i + 1]
        if k0 <= price <= k1:
            t = (price - k0) / (k1 - k0) if k1 > k0 else 0.0
            return pts[i][1] + t * (pts[i + 1][1] - pts[i][1])
    return None


def reanchor_atm_iv(smile, price, fallback_iv="0.25"):
    """Re-anchor the daily IV smile at the live spot -> ATM IV (decimal). Free, no extra feed."""
    try:
        strikes = smile.get("strikes") or []
        call_iv = smile.get("call_iv") or []
        put_iv = smile.get("put_iv") or []
        if len(strikes) >= 3 and price > 0:
            call = _interp(strikes, call_iv, price)
            put = _interp(strikes, put_iv, price)
            if call and put:
                return round((call + put) * 0.5 / 100.0, 6)
            if call:
                return round(call / 100.0, 6)
            if put:
                return round(put / 100.0, 6)
    except Exception:
        pass
    try:
        return round(float(str(fallback_iv).replace("%", "")) / 100.0, 6)
    except (TypeError, ValueError):
        return 0.25


def generate_live_snapshot():
    """Generate docs/data/live/{ASSET}_data.json using real-time prices."""
    LIVE_DIR.mkdir(parents=True, exist_ok=True)
    latest_ts = get_latest_snapshot_ts()

    if not latest_ts:
        print("[LiveFeed] No baseline snapshot found in manifest.json.")
        return False

    baseline_dir = DATA_DIR / latest_ts
    if not baseline_dir.exists():
        print(f"[LiveFeed] Baseline directory {baseline_dir} does not exist.")
        return False

    live_prices = fetch_live_prices()
    now_utc = datetime.now(timezone.utc)
    now_str = now_utc.strftime("%Y-%m-%d %H:%M:%S UTC")
    now_epoch_ms = int(now_utc.timestamp() * 1000)
    now_epoch_s = int(now_utc.timestamp())

    status_data = {
        "status": "LIVE_STREAMING",
        "last_sync": now_str,
        "epoch_ms": now_epoch_ms,
        "last_updated_epoch": now_epoch_s,
        "baseline_snapshot": latest_ts,
        "prices": live_prices
    }

    for asset in ["GC", "ES", "NQ"]:
        base_file = baseline_dir / f"{asset}_data.json"
        if not base_file.exists():
            continue

        try:
            with open(base_file, "r", encoding="utf-8") as f:
                data = json.load(f)

            # Check if live price was fetched; if not, use base price with tiny jitter
            current_price = live_prices.get(asset)
            if not current_price:
                current_price = float(data.get("bias", {}).get("price", 0) or 0)

            if current_price <= 0:
                continue

            # 1. Update Bias with Real-time Price
            if "bias" in data:
                data["bias"]["price"] = current_price
                data["bias"]["is_realtime"] = True
                data["bias"]["live_sync_time"] = now_str

            # 2. Re-anchor ATM IV from the daily smile at the live spot, refresh SD bands
            live_iv = reanchor_atm_iv(data.get("iv_smile") or {}, current_price, data.get("bias", {}).get("iv"))
            data["bias"]["iv_raw"] = live_iv
            data["bias"]["iv"] = f"{live_iv * 100:.1f}%"

            if "sd_bands" in data and isinstance(data["sd_bands"], dict):
                sd1 = round(current_price * live_iv * math.sqrt(1.0 / 365.0), 2)
                data["sd_bands"]["price"] = current_price
                data["sd_bands"]["sd1"] = sd1
                data["sd_bands"]["daily_vol_pct"] = round((sd1 / current_price) * 100, 2) if current_price > 0 else 0
                data["sd_bands"]["levels"] = {
                    "+1SD": round(current_price + sd1, 2),
                    "+2SD": round(current_price + sd1 * 2, 2),
                    "+3SD": round(current_price + sd1 * 3, 2),
                    "-1SD": round(current_price - sd1, 2),
                    "-2SD": round(current_price - sd1 * 2, 2),
                    "-3SD": round(current_price - sd1 * 3, 2),
                }
                data["sd_step"] = sd1

            # 3. Update active candlestick last bar with live tick (High/Low/Close)
            if "candlesticks" in data and isinstance(data["candlesticks"], dict):
                for tf_key, tf_obj in data["candlesticks"].items():
                    if isinstance(tf_obj, dict) and "ohlcv" in tf_obj and tf_obj["ohlcv"]:
                        last_bar = tf_obj["ohlcv"][-1]
                        last_bar[2] = max(float(last_bar[2]), current_price)
                        last_bar[3] = min(float(last_bar[3]), current_price)
                        last_bar[4] = current_price

            # 4. Add live indicator metadata
            data["realtime_metadata"] = {
                "active": True,
                "server_time_utc": now_str,
                "epoch_ms": now_epoch_ms,
                "source": "Yahoo Finance Real-time CME Futures Feed" if asset in live_prices else "Baseline Active Feed",
                "atm_iv_reanchored": True
            }

            # Write out to docs/data/live/{asset}_data.json
            out_file = LIVE_DIR / f"{asset}_data.json"
            with open(out_file, "w", encoding="utf-8") as f:
                json.dump(data, f, separators=(',', ':'))

        except Exception as e:
            print(f"[LiveFeed] Error updating live data for {asset}: {e}")

    # Write out docs/data/live/status.json
    with open(LIVE_DIR / "status.json", "w", encoding="utf-8") as f:
        json.dump(status_data, f, indent=2)

    print(f"[LiveFeed] [{now_str}] Live snapshot generated: GC={live_prices.get('GC', '—')}, ES={live_prices.get('ES', '—')}, NQ={live_prices.get('NQ', '—')}")
    return True

if __name__ == "__main__":
    generate_live_snapshot()

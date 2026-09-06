"""
fetch_databento_snapshot.py — Build trading_results CSVs from Databento CME data.

Replaces the Tastytrade-based Analysis_Tools/organized_analysis.py + master_report.py
so the dashboard can run with Databento alone.

Produces, for each asset (GC/ES/NQ):
  - trading_results/{date}/{hour}/{root}/{root}_data_{timestamp}.csv
      Columns: Strike,Type,OI,Volume,GEX,Vanna,DEX,Charm,IV
  - trading_results/{date}/{hour}/master_bias_report_{timestamp}.csv
      Columns: Asset,Price,Bias,Conf%,IV%,PCR(V),Skew%,Act%,GEX,Wall(R/S),QualityScore,QualityWarnings

Data source: GLBX.MDP3
  - definition  : option chain (strike, type, expiry, underlying futures)
  - ohlcv-1d    : front futures contract daily bar -> mark price
  - statistics  : official EOD figures
      stat_type 3 = settlement price, 6 = cleared volume, 7 = lowest offer,
                   8 = highest bid, 9 = open interest
Greeks are computed with Black-76 (analytics.exposure), exactly like the
Tastytrade pipeline.

Usage:
    python fetch_databento_snapshot.py            # all assets
    python fetch_databento_snapshot.py GC ES      # selected assets
"""

import asyncio
import math
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import databento as db

from config import CONTRACT_MULTIPLIERS
from analytics.exposure import (
    black76_greeks,
    calculate_dealer_exposures,
    norm_cdf,
)
from analytics.volatility import interpolate_atm_iv
from analytics.quality import score_data_quality

DATASET = "GLBX.MDP3"

OPT_PARENTS = {
    "GC": ["OG.OPT", "OG1.OPT", "OG2.OPT", "OG3.OPT", "OG4.OPT"],
    "ES": ["EW.OPT"],
    "NQ": ["NQ.OPT"],
}

STAT_SETTLEMENT = 3
STAT_VOLUME = 6
STAT_OFFER = 7
STAT_BID = 8
STAT_OI = 9


# Same rules as master_report.get_bias
def get_bias(price, call_wall, put_wall, pcr_oi, pcr_vol, gex_sum, skew):
    score = 0
    if put_wall > 0 and price > put_wall:
        score += 1
    if call_wall > 0 and price < call_wall:
        score -= 1
    if pcr_oi < 0.8:
        score += 1
    elif pcr_oi > 1.2:
        score -= 1
    if pcr_vol < 0.8:
        score += 1
    elif pcr_vol > 1.2:
        score -= 1
    if gex_sum > 0:
        score += 1
    else:
        score -= 1
    if skew > 0.05:
        score -= 1
    elif skew < -0.05:
        score += 1

    conf = min(abs(score) * 16.7, 100.0)
    conf = round(conf)

    label = "NEUTRAL"
    if score >= 3:
        label = "Strong BULL"
    elif score >= 1:
        label = "Mild BULL"
    elif score <= -3:
        label = "Strong BEAR"
    elif score <= -1:
        label = "Mild BEAR"

    return label, f"{conf}%"


def black76_price(F, K, T, sigma, r, is_call):
    if F <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        return 0.0
    discount = math.exp(-r * T)
    std = sigma * math.sqrt(T)
    d1 = (math.log(F / K) + 0.5 * sigma * sigma * T) / std
    d2 = d1 - std
    if is_call:
        return discount * (F * norm_cdf(d1) - K * norm_cdf(d2))
    return discount * (K * norm_cdf(-d2) - F * norm_cdf(-d1))


def implied_vol(F, K, T, mid, is_call, r=0.05, lo=1e-4, hi=5.0):
    """Invert Black-76 for implied vol. Returns None if no solution in range."""
    if F <= 0 or K <= 0 or T <= 0 or mid <= 0:
        return None
    intrinsic = max(0.0, F - K) if is_call else max(0.0, K - F)
    if mid < intrinsic - 1e-9:
        return None
    for _ in range(80):
        mid_p = (lo + hi) / 2.0
        px = black76_price(F, K, T, mid_p, r, is_call)
        if px > mid:
            hi = mid_p
        else:
            lo = mid_p
        if hi - lo < 1e-8:
            break
    val = (lo + hi) / 2.0
    if not math.isfinite(val) or val <= 1e-4:
        return None
    return val


def get_last_trading_day():
    """Most recent finished trading day: skip weekends; if still very early
    UTC prefer the prior trading day."""
    now = datetime.now(timezone.utc)
    d = now.date()
    if now.hour < 21:
        d -= timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.isoformat()


def yf_price(root):
    sym = {"GC": "GC=F", "ES": "ES=F", "NQ": "NQ=F"}.get(root)
    if not sym:
        return None
    try:
        hist = yf.Ticker(sym).history(period="1d")
        if not hist.empty:
            return float(hist["Close"].iloc[-1])
    except Exception:
        pass
    return None


async def futures_price(adapter, root):
    try:
        fut = await adapter.get_futures_price(root)
        p = getattr(fut, "price", 0.0) or 0.0
        return float(p) if p > 0 else None
    except Exception:
        return None


def futures_mark_from_ohlcv(client, underlying, day):
    end = (
        datetime.strptime(day, "%Y-%m-%d").date() + timedelta(days=2)
    ).isoformat()
    d = client.timeseries.get_range(
        dataset=DATASET,
        schema="ohlcv-1d",
        stype_in="raw_symbol",
        symbols=underlying,
        start=day,
        end=end,
    )
    df = d.to_df()
    if df.empty:
        return None
    last = df.iloc[-1]
    return float(last.get("close", 0.0)) or None


def fetch_definitions(client, parents, day):
    frames = []
    for sym in parents:
        try:
            data = client.timeseries.get_range(
                dataset=DATASET,
                schema="definition",
                stype_in="parent",
                symbols=sym,
                start=day,
                end=None,
            )
            df = data.to_df()
            if not df.empty:
                frames.append(df)
        except Exception as e:
            print(f"  [WARN] definitions failed for {sym}: {e}")
    if not frames:
        raise RuntimeError(f"No definitions returned for {parents}")
    return pd.concat(frames, ignore_index=True)


def fetch_statistics(client, parents, day):
    frames = []
    for sym in parents:
        try:
            data = client.timeseries.get_range(
                dataset=DATASET,
                schema="statistics",
                stype_in="parent",
                symbols=sym,
                start=day,
                end=None,
            )
            df = data.to_df()
            if not df.empty:
                frames.append(df)
        except Exception as e:
            print(f"  [WARN] statistics failed for {sym}: {e}")
    if not frames:
        raise RuntimeError(f"No statistics returned for {parents}")
    return pd.concat(frames, ignore_index=True)


def resolve_chain_universe(defs):
    """Keep C/P outright options; return nearest active expiry and the related
    subset of definitions plus the underlying futures contract."""
    opt = defs[defs["instrument_class"].isin(["C", "P"])].copy()
    if opt.empty:
        raise RuntimeError("No C/P option definitions found")

    today = date.today()
    exps = sorted({p.date() for p in opt["expiration"] if p.date() >= today})
    if not exps:
        exps = sorted({p.date() for p in opt["expiration"]})
    target = exps[0]

    chain = opt[opt["expiration"].dt.date == target].copy()
    if chain.empty:
        raise RuntimeError(f"No options for expiry {target}")

    underlyings = sorted(set(chain["underlying"].dropna().astype(str)))
    underlying = underlyings[0] if underlyings else None

    return target, chain, underlying


def build_rows(chain, stats, root, spot, day):
    multiplier = CONTRACT_MULTIPLIERS.get(root, 1)
    today = date.today()
    target = chain["expiration"].iloc[0].date()

    # EOD stats: keep the latest revision per (instrument_id, stat_type)
    s = stats[
        stats["stat_type"].isin({STAT_SETTLEMENT, STAT_VOLUME, STAT_OFFER, STAT_BID, STAT_OI})
    ]
    s = s.sort_index()
    s = s.groupby(["instrument_id", "stat_type"]).last()

    def stat_of(inst_id, stype, field):
        try:
            row = s.loc[(inst_id, stype)]
            v = row[field]
            if field == "quantity":
                return float(v) if v and v < 2**62 else 0.0
            return float(v) if v and math.isfinite(float(v)) else 0.0
        except KeyError:
            return 0.0

    rows = []
    iv_feed = []
    for _, d in chain.iterrows():
        inst_id = int(d["instrument_id"])
        strike = float(d["strike_price"])
        otype = "Call" if d["instrument_class"] == "C" else "Put"
        is_call = otype == "Call"

        oi = stat_of(inst_id, STAT_OI, "quantity")
        vol = stat_of(inst_id, STAT_VOLUME, "quantity")
        settle = stat_of(inst_id, STAT_SETTLEMENT, "price")
        bid = stat_of(inst_id, STAT_BID, "price")
        ask = stat_of(inst_id, STAT_OFFER, "price")

        T = max(1.0, float((target - today).days)) / 365.0

        mid = 0.0
        if bid > 0 and ask > 0:
            mid = (bid + ask) / 2.0
        if mid <= 0 and settle > 0:
            mid = settle

        iv = implied_vol(spot, strike, T, mid, is_call) if mid > 0 else None
        if iv is not None:
            iv_feed.append((strike, iv))

        rows.append({
            "Strike": strike,
            "Type": otype,
            "OI": oi,
            "Volume": vol,
            "IV": iv,
            "_bid": bid,
            "_ask": ask,
            "_settle": settle,
            "_T": T,
        })

    # Fill IV gaps from the ATM-implied fallback, then compute greeks/exposures
    fallback_iv = interpolate_atm_iv(spot, iv_feed) if iv_feed else 0.0
    for r in rows:
        if r["IV"] is None:
            r["IV"] = fallback_iv if fallback_iv > 0 else 0.0
        gex_val = vanna_val = dex_val = charm_val = 0.0
        if r["IV"] > 0 and r["OI"] > 0:
            type_code = "C" if r["Type"] == "Call" else "P"
            greeks = black76_greeks(
                F=spot, K=r["Strike"], T=r["_T"], sigma=r["IV"], option_type=type_code
            )
            ex = calculate_dealer_exposures(
                oi=r["OI"],
                delta=greeks["delta"],
                gamma=greeks["gamma"],
                vega=greeks["vega"],
                vanna=greeks["vanna"],
                charm=greeks["charm"],
                spot=spot,
                multiplier=multiplier,
                option_type=type_code,
                dealer_assumed_side="short",
            )
            gex_val = ex["gex"]
            vanna_val = ex["vanna_exp"]
            dex_val = ex["dex"]
            charm_val = ex["charm_exp"]
        r["GEX"] = gex_val
        r["Vanna"] = vanna_val
        r["DEX"] = dex_val
        r["Charm"] = charm_val
        r["IV"] = round(r["IV"], 8)
    return rows


def make_data_csv(rows, out_path):
    df = pd.DataFrame(
        [
            {
                "Strike": r["Strike"],
                "Type": r["Type"],
                "OI": r["OI"],
                "Volume": r["Volume"],
                "GEX": r["GEX"],
                "Vanna": r["Vanna"],
                "DEX": r["DEX"],
                "Charm": r["Charm"],
                "IV": r["IV"],
            }
            for r in rows
        ]
    ).sort_values(["Strike", "Type"], ascending=[True, True])
    df.to_csv(out_path, index=False)
    print(f"[OK] wrote {out_path} ({len(df)} rows)")


def make_bias_report(root, rows, spot):
    df_calls = [r for r in rows if r["Type"] == "Call"]
    df_puts = [r for r in rows if r["Type"] == "Put"]

    c_oi = sum(r["OI"] for r in df_calls)
    p_oi = sum(r["OI"] for r in df_puts)
    pcr_oi = p_oi / c_oi if c_oi > 0 else 0.0

    c_vol = sum(r["Volume"] for r in df_calls)
    p_vol = sum(r["Volume"] for r in df_puts)
    pcr_vol = p_vol / c_vol if c_vol > 0 else 0.0

    total_oi = c_oi + p_oi
    total_vol = c_vol + p_vol
    activity = (total_vol / total_oi * 100.0) if total_oi > 0 else 0.0

    call_wall = max(df_calls, key=lambda r: r["OI"])["Strike"] if df_calls else 0.0
    put_wall = max(df_puts, key=lambda r: r["OI"])["Strike"] if df_puts else 0.0

    def iv_at(strike):
        best = None
        for r in rows:
            if r["IV"] <= 0:
                continue
            if best is None or abs(r["Strike"] - strike) < abs(best["Strike"] - strike):
                best = r
        return best["IV"] if best else 0.0

    skew = iv_at(spot * 0.98) - iv_at(spot * 1.02)

    iv_pairs = [(r["Strike"], r["IV"]) for r in rows if r["IV"] > 0]
    atm_iv = interpolate_atm_iv(spot, iv_pairs)

    quality_inputs = [
        {
            "strike": r["Strike"],
            "type": r["Type"][0],
            "oi": r["OI"],
            "vol": r["Volume"],
            "bid": r["_settle"] or r["_bid"],
            "ask": r["_settle"] or r["_ask"],
        }
        for r in rows
    ]
    dq = score_data_quality(quality_inputs)

    gex_total = sum(r["GEX"] for r in rows)
    label, conf = get_bias(spot, call_wall, put_wall, pcr_oi, pcr_vol, gex_total, skew)

    return {
        "Asset": {"GC": "Gold", "ES": "S&P 500", "NQ": "NASDAQ"}[root],
        "Price": round(spot, 2),
        "Bias": label,
        "Conf%": conf,
        "IV%": f"{atm_iv * 100:.1f}%",
        "PCR(V)": round(pcr_vol, 2),
        "Skew%": f"{skew * 100:+.1f}%",
        "Act%": f"{activity:.1f}%",
        "GEX": "STABLE" if gex_total > 0 else "VOLTL",
        "Wall(R/S)": f"{call_wall}/{put_wall}",
        "QualityScore": dq["quality_score"],
        "QualityWarnings": "; ".join(dq["warnings"]) if dq["warnings"] else "None",
    }


async def process_asset(client, adapter, root, output_base, timestamp_hhmm):
    print(f"\nProcessing {root}...")
    day = get_last_trading_day()

    defs = await asyncio.to_thread(fetch_definitions, client, OPT_PARENTS[root], day)
    target, chain, underlying = resolve_chain_universe(defs)
    print(f"  -> target expiry {target} | underlying {underlying}")

    spot = yf_price(root)
    if not spot and underlying:
        try:
            spot = await asyncio.to_thread(
                futures_mark_from_ohlcv, client, underlying, day
            )
        except Exception as e:
            print(f"  [WARN] futures ohlcv failed for {underlying}: {e}")
            spot = None
    if not spot:
        spot = await futures_price(adapter, root)
    if not spot:
        raise RuntimeError(f"Could not determine price for {root}")
    print(f"  Spot (mark): {spot:.2f}")

    lo, hi = spot * 0.93, spot * 1.07
    chain = chain[(chain["strike_price"] >= lo) & (chain["strike_price"] <= hi)]
    if chain.empty:
        raise RuntimeError(f"No options in range [{lo:.1f}, {hi:.1f}] for {root}")

    stats = await asyncio.to_thread(fetch_statistics, client, OPT_PARENTS[root], day)
    rows = build_rows(chain, stats, root, spot, day)
    if not rows:
        raise RuntimeError(f"No chain data for {root} on {day}")

    asset_dir = output_base / root.lower()
    asset_dir.mkdir(parents=True, exist_ok=True)
    data_path = asset_dir / f"{root.lower()}_data_{timestamp_hhmm}.csv"
    make_data_csv(rows, data_path)

    report = make_bias_report(root, rows, spot)
    return report


async def main():
    assets = [a.upper() for a in sys.argv[1:]] or ["GC", "ES", "NQ"]
    for a in assets:
        if a not in OPT_PARENTS:
            print(f"[ERROR] Unsupported asset {a}. Supported: {list(OPT_PARENTS.keys())}")
            return

    key = os.getenv("DATABENTO_API_KEY")
    if not key:
        print("[ERROR] DATABENTO_API_KEY not set (check .env)")
        return

    print("=" * 60)
    print("  FETCH DATABENTO SNAPSHOT -> trading_results CSVs")
    print("=" * 60)

    client = db.Historical(key=key)

    from adapters import AdapterRegistry

    adapter = AdapterRegistry.from_env("databento")
    await adapter.connect()

    now = datetime.now()
    date_str = now.strftime("%Y-%m-%d")
    hour_str = now.strftime("%H00")
    timestamp_hhmm = now.strftime("%H%M")
    output_base = Path("trading_results") / date_str / hour_str
    output_base.mkdir(parents=True, exist_ok=True)

    results = []
    for asset in assets:
        try:
            res = await process_asset(client, adapter, asset, output_base, timestamp_hhmm)
            if res:
                results.append(res)
        except Exception as e:
            print(f"[FAIL] {asset}: {e}")

    await adapter.disconnect()

    if results:
        df_report = pd.DataFrame(results)
        df_report["IV%"] = df_report["IV%"].astype(str)
        csv_path = output_base / f"master_bias_report_{timestamp_hhmm}.csv"
        df_report.to_csv(csv_path, index=False)
        print(f"\n[OK] Master bias report -> {csv_path}")
        print(df_report.to_string(index=False))


if __name__ == "__main__":
    asyncio.run(main())
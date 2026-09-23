"""화장품 수출입 분석 모듈 (담당자 A) — 명세: src/01_home/home.md 5장

관세청 수출입실적(trade_stats 테이블)을 pandas 로 정리해 홈 왼쪽 3개 카드 데이터를 만듭니다.
결측치 처리 순서 (build_cards 안 주석 참고):
  1. 숫자 변환 실패값('-', 빈칸 등) → NaN 으로 바꾼 뒤 건수 기록
  2. 연월·국가 코드가 없는 행(총계 행 등) 제거
  3. 금액 NaN → 0 (통관 실적 없음으로 간주), 무역수지 NaN → 수출 − 수입 으로 재계산
  4. 월 × 국가 표를 만들 때 비어 있는 칸(미보고 월) → 0 으로 채우고 건수 기록
"""

from __future__ import annotations

import pandas as pd

# 관세청 HS 6단위 품목명 (5-3 표의 4단위를 세분)
HS6_NAMES = {
    "330300": "향수·화장수",
    "330410": "입술 화장품",
    "330420": "눈 화장품",
    "330430": "매니큐어",
    "330491": "파우더",
    "330499": "기초·기타 화장품",
    "330510": "샴푸",
    "330520": "퍼머넌트 제품",
    "330530": "헤어스프레이",
    "330590": "기타 두발용",
    "330710": "면도용 제품",
    "330720": "탈취제",
    "330730": "입욕제",
    "330741": "향 제품(아가르바티)",
    "330749": "기타 방향제",
    "330790": "기타 화장품",
}
TOP_N = 3            # 상위국 · 품목 표시 건수
MONTHS = 12


def _musd(v: float) -> str:
    return f"{v / 1e6:,.1f}"


def _pct(cur: float, prev: float | None) -> dict:
    """전년 대비 증감률. 비교값이 없거나 0이면 방향 flat + '—'"""
    if prev is None or pd.isna(prev) or prev == 0:
        return {"change": None, "change_text": "—", "direction": "flat"}
    ch = (cur - prev) / prev * 100
    return {"change": round(ch, 1), "change_text": f"{abs(ch):.1f}%",
            "direction": "up" if ch > 0 else ("down" if ch < 0 else "flat")}


def _prev_year(yymm: str) -> str:
    return f"{int(yymm[:4]) - 1}{yymm[4:]}"


def _month_range(end: str, n: int) -> list[str]:
    p = pd.Period(f"{end[:4]}-{end[4:]}", freq="M")
    return [(p - i).strftime("%Y%m") for i in range(n - 1, -1, -1)]


def build_cards(rows: list[dict], hs_codes: list[str]) -> dict:
    """trade_stats 행 목록 → 홈 왼쪽 카드 3개용 dict. 데이터가 없으면 ok=False"""
    empty = {"ok": False, "message": "수출입 실적을 불러오지 못했어요", "kstat_url": "https://stat.kita.net/"}
    if not rows:
        return empty

    df = pd.DataFrame(rows)
    cleaning = {"coerced": 0, "dropped": 0, "filled_grid": 0}

    # 1. 숫자 변환 — 변환 실패는 NaN
    for col in ("exp_usd", "imp_usd", "balance"):
        before = df[col].isna().sum()
        df[col] = pd.to_numeric(df[col], errors="coerce")
        cleaning["coerced"] += int(df[col].isna().sum() - before)

    # 2. 기준 연월 / 국가 코드가 없는 행 제거 (총계 행, '-' 표기 등)
    df["yymm"] = df["yymm"].astype(str).str.strip()
    df["country"] = df["country"].fillna("").astype(str).str.strip()
    df["hs_code"] = df["hs_code"].fillna("").astype(str).str.strip()
    bad = ~df["yymm"].str.fullmatch(r"\d{6}") | df["country"].isin(["", "-"])
    cleaning["dropped"] = int(bad.sum())
    df = df[~bad].copy()
    if df.empty:
        return empty

    # 3. 금액 결측 → 0, 무역수지 결측 → 수출 − 수입
    na_amt = int(df[["exp_usd", "imp_usd"]].isna().any(axis=1).sum())
    df[["exp_usd", "imp_usd"]] = df[["exp_usd", "imp_usd"]].fillna(0.0)
    df["balance"] = df["balance"].fillna(df["exp_usd"] - df["imp_usd"])
    df["country_name"] = df["country_name"].fillna(df["country"]).replace({"": None, "-": None}).fillna(df["country"])

    latest = df["yymm"].max()
    recent = _month_range(latest, MONTHS)
    prior = [_prev_year(m) for m in recent]

    # ---- 카드 1. 월간 수출입 요약 + 최근 12개월 추이 ----------------------
    # 월 × 국가 표 — 미보고 칸(NaN) → 0 (4단계)
    grid = df.pivot_table(index="yymm", columns="country", values="exp_usd", aggfunc="sum")
    grid = grid.reindex(index=recent)
    cleaning["filled_grid"] = int(grid.isna().sum().sum())
    grid = grid.fillna(0.0)

    monthly = df.groupby("yymm")[["exp_usd", "imp_usd", "balance"]].sum()
    monthly = monthly.reindex(recent + prior).fillna(0.0)
    cur = monthly.loc[latest]
    prev_m = monthly.loc[_prev_year(latest)] if _prev_year(latest) in monthly.index and monthly.loc[_prev_year(latest), "exp_usd"] > 0 else None
    peak = float(monthly.loc[recent, "exp_usd"].max()) or 1.0
    trend = [{"yymm": m, "label": f"{int(m[4:])}월", "musd": _musd(monthly.loc[m, "exp_usd"]),
              "pct": round(float(monthly.loc[m, "exp_usd"]) / peak * 100, 1)} for m in recent]

    summary = {
        "yymm": latest, "month_text": f"{int(latest[:4])}년 {int(latest[4:])}월",
        "exp_musd": _musd(cur["exp_usd"]), "imp_musd": _musd(cur["imp_usd"]), "bal_musd": _musd(cur["balance"]),
        "exp_yoy": _pct(cur["exp_usd"], prev_m["exp_usd"] if prev_m is not None else None),
        "imp_yoy": _pct(cur["imp_usd"], prev_m["imp_usd"] if prev_m is not None else None),
        "trend": trend,
        "total_12m_musd": _musd(float(monthly.loc[recent, "exp_usd"].sum())),
    }

    # ---- 카드 2. 수출 상위국 (최근 12개월 누적, 전년 같은 기간 대비) ---------
    by_c = df[df["yymm"].isin(recent)].groupby("country")["exp_usd"].sum().sort_values(ascending=False)
    by_c_prev = df[df["yymm"].isin(prior)].groupby("country")["exp_usd"].sum()
    names = df.drop_duplicates("country").set_index("country")["country_name"]
    total_c = float(by_c.sum()) or 1.0
    countries = []
    for code, val in by_c.head(TOP_N).items():
        countries.append({
            "code": code, "name": str(names.get(code, code)), "musd": _musd(val),
            "share": round(float(val) / total_c * 100, 1),
            "bar": round(float(val) / float(by_c.iloc[0]) * 100, 1) if by_c.iloc[0] else 0,
            **_pct(float(val), float(by_c_prev.get(code)) if code in by_c_prev.index else None),
        })

    # ---- 카드 3. 품목(HS 6단위)별 수출 --------------------------------------
    by_h = df[df["yymm"].isin(recent)].groupby("hs_code")["exp_usd"].sum().sort_values(ascending=False)
    by_h_prev = df[df["yymm"].isin(prior)].groupby("hs_code")["exp_usd"].sum()
    total_h = float(by_h.sum()) or 1.0
    products = []
    for code, val in by_h.head(TOP_N).items():
        products.append({
            "code": code, "name": HS6_NAMES.get(code, f"HS {code}"), "musd": _musd(val),
            "share": round(float(val) / total_h * 100, 1),
            "bar": round(float(val) / float(by_h.iloc[0]) * 100, 1) if by_h.iloc[0] else 0,
            **_pct(float(val), float(by_h_prev.get(code)) if code in by_h_prev.index else None),
        })

    period_text = f"{int(recent[0][:4])}.{int(recent[0][4:])}~{int(latest[:4])}.{int(latest[4:])}"
    cleaning_text = f"결측 {cleaning['coerced'] + na_amt}건 보정 · 제외 {cleaning['dropped']}행 · 미보고 {cleaning['filled_grid']}칸 0 처리"
    return {
        "ok": True,
        "hs_codes": hs_codes,
        "period_text": period_text,
        "cleaning": cleaning | {"na_amount": na_amt, "text": cleaning_text},
        "summary": summary,
        "countries": countries,
        "products": products,
        "kstat_url": "https://stat.kita.net/",
    }

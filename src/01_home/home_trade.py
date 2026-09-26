"""화장품 수출입 분석 모듈 (담당자 A) — 명세: src/01_home/home.md 5장

관세청 수출입실적(trade_stats 테이블)을 pandas 로 정리해 홈 왼쪽 3개 카드 데이터를 만듭니다.
결측치 처리 순서 (build_cards 안 주석 참고):
  1. 숫자 변환 실패값('-', 빈칸 등) → NaN 으로 바꾼 뒤 건수 기록
  2. 연월·국가 코드가 없는 행(총계 행 등) 제거
  3. 금액 NaN → 0 (통관 실적 없음으로 간주), 무역수지 NaN → 수출 − 수입 으로 재계산
  4. 월 × 국가 표를 만들 때 비어 있는 칸(미보고 월) → 0 으로 채우고 건수 기록
"""

from __future__ import annotations

import logging

import pandas as pd

log = logging.getLogger("cosmoa.home.trade")

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

# 상세 모달 (5-9)
HS4_NAMES = {"3303": "향수·화장수", "3304": "기초·메이크업", "3305": "두발용", "3307": "면도·탈취·입욕 등"}
PERIODS = (3, 6, 12, 24)
METRICS = {"exp": ("exp_usd", "수출"), "imp": ("imp_usd", "수입"), "bal": ("balance", "무역수지")}
DETAIL_TOP = 10


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


def _clean(rows: list[dict]):
    """5-8 결측치 처리 1~3단계. (df, cleaning, na_amt, bal_mismatch, total_rows) 또는 데이터가 없으면 None"""
    if not rows:
        return None
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
    valid_ym = df["yymm"].str.fullmatch(r"\d{6}")
    is_total = df["country"].isin(["", "-"])
    total_rows = df[valid_ym & is_total].copy()   # 관세청 '전체' 행 — 국가 합산과 교차 비교용 (5단계, 명세 13-1)
    bad = ~valid_ym | is_total
    cleaning["dropped"] = int(bad.sum())
    df = df[~bad].copy()
    if df.empty:
        return None

    # 3. 금액 결측 → 0, 무역수지 결측 → 수출 − 수입
    na_amt = int(df[["exp_usd", "imp_usd"]].isna().any(axis=1).sum())
    df[["exp_usd", "imp_usd"]] = df[["exp_usd", "imp_usd"]].fillna(0.0)
    # 3-1. 무역수지 교차 확인 — 값이 있는 행에서 (수출 − 수입)과 1달러 넘게 다르면 불일치로 기록 (값은 API 원본 유지)
    has_bal = df["balance"].notna()
    bal_mismatch = int((has_bal & ((df["balance"] - (df["exp_usd"] - df["imp_usd"])).abs() > 1.0)).sum())
    df["balance"] = df["balance"].fillna(df["exp_usd"] - df["imp_usd"])
    df["country_name"] = df["country_name"].fillna(df["country"]).replace({"": None, "-": None}).fillna(df["country"])
    return df, cleaning, na_amt, bal_mismatch, total_rows


def build_cards(rows: list[dict], hs_codes: list[str], totals: list[dict] | None = None) -> dict:
    """trade_stats 행 목록 → 홈 왼쪽 카드 3개용 dict. 데이터가 없으면 ok=False
    totals: 관세청 품목별 수출입실적(국가 구분 없는 공식 총계) 행. 있으면 국가별 합산과 교차 비교(13-1)에 씁니다."""
    empty = {"ok": False, "message": "수출입 실적을 불러오지 못했어요", "kstat_url": "https://stat.kita.net/"}
    cleaned = _clean(rows)
    if cleaned is None:
        return empty
    df, cleaning, na_amt, bal_mismatch, total_rows = cleaned
    if totals:   # 품목별 API 총계가 있으면 응답 안의 '전체' 행 대신 그것을 기준으로
        t = pd.DataFrame(totals)
        t["exp_usd"] = pd.to_numeric(t["exp_usd"], errors="coerce").fillna(0.0)
        t["yymm"] = t["yymm"].astype(str)
        total_rows = t[["yymm", "exp_usd"]].copy()

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

    # 5. 총계 행 vs 국가별 합산 교차 비교 (명세 13-1) — 1% 넘게 다른 달은 기록하고 로그 경고
    total_mismatch: list[dict] = []
    if not total_rows.empty:
        tsum = total_rows.assign(exp_usd=total_rows["exp_usd"].fillna(0.0)).groupby("yymm")["exp_usd"].sum()
        for ym in recent:
            if ym in tsum.index and tsum[ym] > 0:
                diff = abs(float(monthly.loc[ym, "exp_usd"]) - float(tsum[ym])) / float(tsum[ym]) * 100
                if diff > 1.0:
                    total_mismatch.append({"yymm": ym, "diff_pct": round(diff, 2)})
        if total_mismatch:
            log.warning("수출입 총계 행과 국가 합산 불일치: %s", total_mismatch)
    if bal_mismatch:
        log.warning("무역수지가 (수출 − 수입)과 다른 행: %d건", bal_mismatch)
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
    if bal_mismatch:
        cleaning_text += f" · 수지 불일치 {bal_mismatch}행"
    if total_mismatch:
        cleaning_text += f" · 총계 불일치 {len(total_mismatch)}개월"
    validation = {
        "ok": not total_mismatch and bal_mismatch == 0,
        "total_rows": int(len(total_rows)),            # 총계 행 수 (0이면 비교 불가). 품목별 API(5-7-1) 또는 응답 안 '전체' 행
        "total_source": "품목별 API" if totals else ("응답 전체 행" if len(total_rows) else None),
        "total_mismatch_months": total_mismatch,        # 국가 합산과 1% 넘게 다른 달
        "balance_mismatch_rows": bal_mismatch,          # 수지 ≠ 수출 − 수입 인 행 수
    }
    return {
        "ok": True,
        "hs_codes": hs_codes,
        "period_text": period_text,
        "cleaning": cleaning | {"na_amount": na_amt, "text": cleaning_text},
        "validation": validation,
        "summary": summary,
        "countries": countries,
        "products": products,
        "kstat_url": "https://stat.kita.net/",
    }


def _rank(series: pd.Series, prev: pd.Series, names, total: float, metric: str) -> list[dict]:
    """상위 목록 공용. 무역수지는 비중 대신 None"""
    out = []
    top = series.head(DETAIL_TOP)
    first = float(abs(top.iloc[0])) if len(top) and top.iloc[0] else 1.0
    for code, val in top.items():
        val = float(val)
        out.append({
            "code": code, "name": names(code), "musd": _musd(val), "value": val,
            "share": (round(val / total * 100, 1) if metric != "bal" and total else None),
            "bar": round(abs(val) / first * 100, 1),
            **_pct(val, float(prev.get(code)) if code in prev.index else None),
        })
    return out


def build_detail(rows: list[dict], hs: str = "3304", months: int = MONTHS, country: str = "", metric: str = "exp") -> dict:
    """수출입 상세 모달 (5-9): 품목(HS 4/6단위 또는 전체)·기간·국가·지표를 골라 다시 집계"""
    hs = (hs or "all").strip() or "all"
    months = months if months in PERIODS else MONTHS
    metric = metric if metric in METRICS else "exp"
    col, metric_name = METRICS[metric]
    base = {"ok": False, "hs": hs, "months": months, "country": country or "", "metric": metric,
            "periods": list(PERIODS), "metrics": [{"key": k, "name": v[1]} for k, v in METRICS.items()],
            "kstat_url": "https://stat.kita.net/"}
    cleaned = _clean(rows)
    if cleaned is None:
        return base | {"message": "수출입 실적을 불러오지 못했어요", "hs4_options": [{"code": c, "name": n, "has_data": False} for c, n in HS4_NAMES.items()]}
    df, cleaning, na_amt, bal_mismatch, total_rows = cleaned

    hs4_options = [{"code": c, "name": n, "has_data": bool(df["hs_code"].str.startswith(c).any())} for c, n in HS4_NAMES.items()]
    df_hs = df if hs == "all" else df[df["hs_code"].str.startswith(hs)]
    if df_hs.empty:
        return base | {"message": "선택한 품목의 실적이 아직 없어요", "hs4_options": hs4_options}

    latest = df_hs["yymm"].max()
    recent = _month_range(latest, months)
    prior = [_prev_year(m) for m in recent]
    has_prior = df_hs["yymm"].min() <= prior[0]          # 전년 동기 자료가 있는지 (24개월은 36개월치 필요)
    names_c = df.drop_duplicates("country").set_index("country")["country_name"]
    country = (country or "").strip().upper()
    if country and country not in set(df_hs["country"]):
        country = ""
    sub = df_hs[df_hs["country"] == country] if country else df_hs

    # KPI — 선택 조건의 기간 합계 3종 + 전년 동기 대비
    cur = sub[sub["yymm"].isin(recent)][["exp_usd", "imp_usd", "balance"]].sum()
    prv = sub[sub["yymm"].isin(prior)][["exp_usd", "imp_usd", "balance"]].sum() if has_prior else None
    summary = {
        "exp_musd": _musd(float(cur["exp_usd"])), "imp_musd": _musd(float(cur["imp_usd"])), "bal_musd": _musd(float(cur["balance"])),
        "exp_yoy": _pct(float(cur["exp_usd"]), float(prv["exp_usd"]) if prv is not None else None),
        "imp_yoy": _pct(float(cur["imp_usd"]), float(prv["imp_usd"]) if prv is not None else None),
        "bal_yoy": _pct(float(cur["balance"]), float(prv["balance"]) if prv is not None else None),
        "months_with_data": int(sub[sub["yymm"].isin(recent)]["yymm"].nunique()),
    }

    # 월별 추이 (선택 지표) — 0 기준선 포함해 0~100 으로 정규화 (무역수지는 음수 가능)
    monthly = sub.groupby("yymm")[col].sum().reindex(recent).fillna(0.0)
    prior_monthly = sub.groupby("yymm")[col].sum().reindex(prior).fillna(0.0) if has_prior else None
    vals = monthly.to_numpy(dtype=float)
    lo, hi = min(0.0, float(vals.min())), max(float(vals.max()), 0.0)
    span = (hi - lo) or 1.0
    trend = []
    for i, (m, v) in enumerate(zip(recent, vals)):
        item = {"yymm": m, "label": f"{int(m[:4]) % 100}.{int(m[4:])}", "musd": _musd(float(v)),
                "pct": round((float(v) - lo) / span * 100, 1)}
        if prior_monthly is not None:   # 전년 같은 달 (차트 비교 선)
            item["prior_yymm"] = prior[i]
            item["prior_musd"] = _musd(float(prior_monthly.iloc[i]))
        trend.append(item)
    zero_pct = round((0.0 - lo) / span * 100, 1)

    # 상위국 (품목 조건만, 국가 조건은 강조용) / 상위 품목 (품목·국가 조건 모두)
    in_recent, in_prior = df_hs["yymm"].isin(recent), df_hs["yymm"].isin(prior)
    by_c = df_hs[in_recent].groupby("country")[col].sum().sort_values(ascending=False)
    by_c_prev = df_hs[in_prior].groupby("country")[col].sum() if has_prior else pd.Series(dtype=float)
    countries = _rank(by_c, by_c_prev, lambda c: str(names_c.get(c, c)), float(by_c.sum()), metric)
    s_recent, s_prior = sub["yymm"].isin(recent), sub["yymm"].isin(prior)
    by_h = sub[s_recent].groupby("hs_code")[col].sum().sort_values(ascending=False)
    by_h_prev = sub[s_prior].groupby("hs_code")[col].sum() if has_prior else pd.Series(dtype=float)
    products = _rank(by_h, by_h_prev, lambda h: HS6_NAMES.get(h, f"HS {h}"), float(by_h.sum()), metric)

    # 선택지
    hs4 = hs[:4] if hs != "all" else None
    hs6_pool = df[df["hs_code"].str.startswith(hs4)] if hs4 else df.iloc[0:0]
    hs6_rank = hs6_pool[hs6_pool["yymm"].isin(recent)].groupby("hs_code")["exp_usd"].sum().sort_values(ascending=False)
    hs6_options = [{"code": h, "name": HS6_NAMES.get(h, f"HS {h}")} for h in hs6_rank.index]
    c_rank = df_hs[in_recent].groupby("country")["exp_usd"].sum().sort_values(ascending=False).head(30)
    country_options = [{"code": c, "name": str(names_c.get(c, c))} for c in c_rank.index]

    hs_label = "전체 화장품 (HS 3303~3307)" if hs == "all" else (
        f"{hs} {HS6_NAMES.get(hs, '')}".strip() if len(hs) == 6 else f"{hs} {HS4_NAMES.get(hs, '')}".strip())
    cleaning_text = f"결측 {cleaning['coerced'] + na_amt}건 보정 · 제외 {cleaning['dropped']}행"
    if bal_mismatch:
        cleaning_text += f" · 수지 불일치 {bal_mismatch}행"
    return base | {
        "ok": True,
        "country": country,
        "country_name": str(names_c.get(country, country)) if country else "",
        "hs_label": hs_label,
        "metric_name": metric_name,
        "period_text": f"{int(recent[0][:4])}.{int(recent[0][4:])}~{int(latest[:4])}.{int(latest[4:])}",
        "latest_text": f"{int(latest[:4])}년 {int(latest[4:])}월",
        "has_prior": bool(has_prior),
        "summary": summary,
        "trend": trend,
        "zero_pct": zero_pct,
        "countries": countries,
        "products": products,
        "hs4_options": hs4_options,
        "hs6_options": hs6_options,
        "country_options": country_options,
        "cleaning_text": cleaning_text,
    }

"""국가별 인허가 규제 — 식약처 '화장품 사용제한 원료정보' 수집 DB 읽기 전용 조회 모듈 (담당자 B).

app.py [B] 영역의 /api/regulatory/regulations?source=mfds 에서만 사용한다. 직접 검색과 파일 일괄 조회가 같은 함수를 쓴다.
수집·재수집은 mfds_use_restriction.py(별도 실행)이며, 이 모듈은 DB 를 만들거나 쓰지 않는다(mode=ro). 외부 API 호출 없음.

성분 연결 (기존 API 성분 코드는 식약처 식별자로 쓰지 않는다)
- 확정 성분의 한글명(kr_name)·영문명(inci_name)·CAS(cas_numbers) 로 레코드를 찾는다.
- 정규화는 앞뒤 공백 제거·영문 대소문자 무시·연속 공백 정리만 한다. 숫자·기호는 그대로 둔다.
- '식별자' = (INGR_STD_NAME, INGR_ENG_NAME 소문자) 조합. 이름이 정확히 일치하는 식별자가 정확히 하나면 확정(confirmed).
  둘 이상이면 확인 필요(ambiguous). 이름 일치가 없고 CAS 만 일치하면 확인 필요(자동 확정하지 않음).
  이름 일치 식별자의 CAS 와 성분의 CAS 가 둘 다 있는데 하나도 겹치지 않으면 충돌 → 확인 필요.
- 관련 항목(related): 이름을 '포함'만 하는 레코드(염류·유도체·성분군·고시원료명·이명 포함). 확정 규제와 분리해 '적용 여부 확인 필요'로만 전달한다.
  개별 이름으로 못 찾았다고 성분군 규정이 없다고 판단하지 않는다 — related 는 not_listed 일 때도 채운다.

시장 매핑 (명시적. 새 국가 추가 없음). 원본 '유럽' 은 근거가 없어 EU 에 합치지 않는다.
"""

import os
import re
import sqlite3
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
SOURCE_PAGE = "https://www.data.go.kr/data/15111772/openapi.do"
SOURCE_LABEL = "식약처 화장품 사용제한 원료정보 (공공데이터포털) 수집 DB"
DATA_SOURCE_TEXT = "식품의약품안전처 '화장품 사용제한 원료정보' 공공데이터 API 를 수집한 로컬 DB. 안내 페이지: " + SOURCE_PAGE + " (개별 법령 원문 링크 아님)"
DISCLAIMER = "규제 참고 자료입니다. 법률·규제 적합성·안전성 판단이 아니며, 수집 시각은 원천 데이터 갱신일이나 법령 개정일이 아닙니다."

# 화면 시장 코드 → 원본 COUNTRY_NAME (수집 DB 값 그대로). 'EU' 는 원본 'EU' 만 — '유럽'(54건)은 별개 값이라 포함하지 않는다.
MARKET_TO_COUNTRY = {
    "KR": ["한국"],
    "EU": ["EU"],
    "US": ["미국"],
    "CN": ["중국"],
    "JP": ["일본"],
    "ASEAN": ["아세안"],
}
COUNTRY_TO_MARKET = {c: m for m, cs in MARKET_TO_COUNTRY.items() for c in cs}
MARKET_CODES = tuple(MARKET_TO_COUNTRY.keys())
COMPLETED = ("completed", "completed_with_warnings")
MAX_RELATED = 30
CAS_RE = re.compile(r"\b\d{2,7}-\d{2}-\d\b")


class MfdsLookupError(Exception):
    """kind: db_missing(503) | db_incomplete(503) | db_error(503) | validation(400)"""

    STATUS = {"db_missing": 503, "db_incomplete": 503, "db_error": 503, "validation": 400}

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.http_status = self.STATUS.get(kind, 503)

    def to_dict(self):
        return {"kind": self.kind, "message": self.message, "source": "mfds"}


def db_path():
    return Path(os.getenv("MFDS_DB_PATH") or (BASE_DIR / "instance" / "regulatory" / "mfds_use_restriction.sqlite"))


def open_readonly(path=None):
    """읽기 전용으로 연다. 파일이 없으면 만들지 않고 db_missing."""
    p = Path(path) if path else db_path()
    if not p.is_file():
        raise MfdsLookupError("db_missing", "식약처 수집 DB 가 서버에 없어요 (instance/regulatory/mfds_use_restriction.sqlite). 수집을 먼저 실행하거나 완료된 DB 를 복사해 주세요. regulatory.md 13항 참고.")
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % p.resolve().as_posix(), uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("SELECT 1 FROM runs LIMIT 1")
        conn.execute("SELECT 1 FROM records LIMIT 1")
        return conn
    except sqlite3.Error as exc:
        raise MfdsLookupError("db_error", "식약처 수집 DB 를 읽지 못했어요 (%s). 파일이 손상되었거나 수집 스키마와 달라요." % exc.__class__.__name__)


def latest_completed_run(conn):
    """완료된 수집 실행만 서비스에 쓴다. 없으면 db_incomplete."""
    try:
        row = conn.execute("SELECT * FROM runs WHERE status IN (?, ?) ORDER BY run_id DESC LIMIT 1", COMPLETED).fetchone()
    except sqlite3.Error as exc:
        raise MfdsLookupError("db_error", "식약처 수집 DB 의 실행 기록을 읽지 못했어요 (%s)." % exc.__class__.__name__)
    if row is None:
        raise MfdsLookupError("db_incomplete", "식약처 수집 DB 에 완료된 수집 실행이 없어요. 'mfds_use_restriction.py collect' 로 수집을 끝낸 뒤 사용할 수 있어요.")
    return {"run_id": row["run_id"], "status": row["status"], "started_at": row["started_at"], "finished_at": row["finished_at"],
            "records_saved": row["records_saved"], "total_count_last": row["total_count_last"], "page_size": row["page_size"],
            "source_page": row["source_page"] or SOURCE_PAGE, "note": row["note"]}


def db_status():
    """화면·진단용 요약. 예외를 상태 dict 로 바꾼다."""
    try:
        conn = open_readonly()
        try:
            run = latest_completed_run(conn)
        finally:
            conn.close()
        return {"available": True, "run": run}
    except MfdsLookupError as exc:
        return {"available": False, "kind": exc.kind, "message": exc.message}


# ---------------------------------------------------------------------------
# 정규화·매칭
# ---------------------------------------------------------------------------

def norm_name(t):
    """안전한 정규화만: 앞뒤 공백 제거, 연속 공백 하나로, 영문 대소문자 무시. 숫자·기호·괄호는 그대로."""
    return re.sub(r"\s+", " ", (t or "").strip()).casefold()


def cas_tokens(t):
    return sorted(set(CAS_RE.findall(t or "")))


def _identity(row):
    return (row["INGR_STD_NAME"] or "", norm_name(row["INGR_ENG_NAME"]))


def _entry(row):
    limit = (row["LIMIT_COND"] or "").strip() or None
    rtype = (row["REGULATE_TYPE"] or "").strip()
    return {
        "country": row["COUNTRY_NAME"],
        "country_code": COUNTRY_TO_MARKET.get(row["COUNTRY_NAME"]),
        "regulate_type": rtype,                      # 원본 그대로 (금지 / 한도 / 한도/금지)
        "notice_ingr_name": row["NOTICE_INGR_NAME"],
        "proviso": (row["PROVIS_ATRCL"] or "").strip() or None,   # 실제 필드 PROVIS_ATRCL
        "limit_condition": limit,                    # 원문 그대로. null 이면 None
        "limit_missing": limit is None and "한도" in rtype,        # '한도'인데 제한사항 없음 → 화면 '상세 제한사항 미제공'
        "source_type": "mfds",
        "std_name": row["INGR_STD_NAME"],
        "eng_name": row["INGR_ENG_NAME"],
        "cas": row["CAS_NO"],
        "record_id": row["id"],
        "page_no": row["page_no"],
    }


def identify(conn, run_id, kr_name=None, inci_name=None, cas=None):
    """성분 식별. 반환 {"status": confirmed|ambiguous|none, "basis": [...], "identity": (std, eng_norm) | None,
    "candidates": [ {std_name, eng_name, cas, basis, markets} ], "conflict": str|None}"""
    kr = (kr_name or "").strip()
    inci_n = norm_name(inci_name)
    cas_in = cas_tokens(cas)
    rows = []
    if kr:
        rows += conn.execute("SELECT * FROM records WHERE run_id=? AND trim(INGR_STD_NAME)=?", (run_id, kr)).fetchall()
    if inci_n:
        rows += conn.execute("SELECT * FROM records WHERE run_id=? AND lower(trim(INGR_ENG_NAME))=?", (run_id, inci_n)).fetchall()
    cas_rows = []
    for tok in cas_in:
        cas_rows += conn.execute("SELECT * FROM records WHERE run_id=? AND instr(CAS_NO, ?)>0", (run_id, tok)).fetchall()
    cas_rows = [r for r in cas_rows if set(cas_tokens(r["CAS_NO"])) & set(cas_in)]

    def collect(rowlist, basis_fn):
        out = {}
        for r in rowlist:
            ident = _identity(r)
            c = out.setdefault(ident, {"std_name": r["INGR_STD_NAME"], "eng_name": r["INGR_ENG_NAME"], "cas": set(), "basis": set(), "markets": set()})
            if r["CAS_NO"]:
                c["cas"].update(cas_tokens(r["CAS_NO"]))
            c["basis"].update(basis_fn(r))
            c["markets"].add(r["COUNTRY_NAME"])
        return out

    def name_basis(r):
        b = set()
        if kr and (r["INGR_STD_NAME"] or "").strip() == kr:
            b.add("표준명")
        if inci_n and norm_name(r["INGR_ENG_NAME"]) == inci_n:
            b.add("영문명")
        return b

    by_name = collect(rows, name_basis)
    by_cas = collect(cas_rows, lambda r: {"CAS"})

    def pack(d):
        return [{"std_name": v["std_name"], "eng_name": v["eng_name"], "cas": sorted(v["cas"]), "basis": sorted(v["basis"]), "markets": sorted(v["markets"])}
                for v in d.values()]

    if len(by_name) == 1:
        ident, info = next(iter(by_name.items()))
        conflict = None
        if cas_in and info["cas"] and not (set(cas_in) & info["cas"]):
            conflict = "성분의 CAS(%s)와 이름이 일치한 레코드의 CAS(%s)가 겹치지 않아요." % (", ".join(cas_in), ", ".join(sorted(info["cas"])))
        extra = {k: v for k, v in by_cas.items() if k != ident}
        if conflict or extra:
            merged = dict(by_name)
            for k, v in extra.items():
                merged[k] = v
            return {"status": "ambiguous", "basis": sorted(info["basis"] | ({"CAS"} if set(cas_in) & info["cas"] else set())), "identity": None,
                    "candidates": pack(merged), "conflict": conflict or "이름으로 찾은 항목 외에 CAS 로 찾은 다른 항목이 있어요."}
        basis = sorted(info["basis"] | ({"CAS"} if set(cas_in) & info["cas"] else set()))
        return {"status": "confirmed", "basis": basis, "identity": ident, "candidates": pack(by_name), "conflict": None}
    if len(by_name) > 1:
        return {"status": "ambiguous", "basis": [], "identity": None, "candidates": pack(by_name), "conflict": "이름이 정확히 일치하는 항목이 %d개예요." % len(by_name)}
    if by_cas:
        return {"status": "ambiguous", "basis": ["CAS"], "identity": None, "candidates": pack(by_cas), "conflict": "이름은 일치하지 않고 CAS 만 일치해요. 자동으로 확정하지 않았어요."}
    return {"status": "none", "basis": [], "identity": None, "candidates": [], "conflict": None}


def related_items(conn, run_id, countries, kr_name=None, inci_name=None, exclude_identity=None):
    """이름을 '포함'하는 레코드 (염류·유도체·성분군·이명·고시원료명). 확정 규제와 분리해 '적용 여부 확인 필요'로만 쓴다."""
    kr = (kr_name or "").strip()
    inci_n = norm_name(inci_name)
    if not kr and not inci_n:
        return []
    marks = ",".join("?" * len(countries))
    sql = ("SELECT * FROM records WHERE run_id=? AND COUNTRY_NAME IN (%s) AND (" % marks)
    params = [run_id] + list(countries)
    conds = []
    if kr:
        conds += ["instr(INGR_STD_NAME, ?)>0", "instr(COALESCE(INGR_SYNONYM,''), ?)>0", "instr(COALESCE(NOTICE_INGR_NAME,''), ?)>0"]
        params += [kr, kr, kr]
    if inci_n:
        conds += ["instr(lower(INGR_ENG_NAME), ?)>0", "instr(lower(COALESCE(INGR_SYNONYM,'')), ?)>0", "instr(lower(COALESCE(NOTICE_INGR_NAME,'')), ?)>0"]
        params += [inci_n, inci_n, inci_n]
    sql += " OR ".join(conds) + ") ORDER BY INGR_STD_NAME, COUNTRY_NAME LIMIT ?"
    params.append(MAX_RELATED * 4)
    out, seen = [], set()
    for r in conn.execute(sql, params):
        ident = _identity(r)
        if exclude_identity is not None and ident == exclude_identity:
            continue
        key = ident + (r["COUNTRY_NAME"], r["REGULATE_TYPE"])
        if key in seen:
            continue
        seen.add(key)
        where = "표준명" if kr and kr in (r["INGR_STD_NAME"] or "") else ("영문명" if inci_n and inci_n in norm_name(r["INGR_ENG_NAME"]) else ("고시원료명" if (kr and kr in (r["NOTICE_INGR_NAME"] or "")) or (inci_n and inci_n in norm_name(r["NOTICE_INGR_NAME"])) else "이명"))
        out.append({"std_name": r["INGR_STD_NAME"], "eng_name": r["INGR_ENG_NAME"], "country": r["COUNTRY_NAME"], "regulate_type": r["REGULATE_TYPE"], "matched_in": where})
        if len(out) >= MAX_RELATED:
            break
    return out


def _now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def lookup(kr_name=None, inci_name=None, cas=None, market=None, api_code=None, path=None):
    """직접 검색·파일 일괄 조회가 공유하는 식약처 조회. 기존 API 응답과 같은 모양의 dict 를 돌려준다.

    lookup_status: found | not_listed | link_required
    """
    if market not in MARKET_TO_COUNTRY:
        raise MfdsLookupError("validation", "식약처 수집 DB 조회는 %s 시장만 연결되어 있어요." % ", ".join(MARKET_CODES))
    if not (kr_name or "").strip() and not (inci_name or "").strip():
        raise MfdsLookupError("validation", "성분 이름(한글명 또는 영문명)이 있어야 식약처 DB 에서 찾을 수 있어요.")
    conn = open_readonly(path)
    try:
        run = latest_completed_run(conn)
        rid = run["run_id"]
        countries = MARKET_TO_COUNTRY[market]
        ident = identify(conn, rid, kr_name, inci_name, cas)
        entries = []
        markets_listed = []
        if ident["status"] == "confirmed":
            std, eng_n = ident["identity"]
            rows = conn.execute(
                "SELECT * FROM records WHERE run_id=? AND INGR_STD_NAME=? AND lower(trim(INGR_ENG_NAME))=? AND COUNTRY_NAME IN (%s) ORDER BY page_no, row_index" % ",".join("?" * len(countries)),
                [rid, std, eng_n] + countries).fetchall()
            entries = [_entry(r) for r in rows]      # 같은 성분·시장의 조건별 레코드를 모두 보여준다 (합치지 않음)
            markets_listed = sorted({r["COUNTRY_NAME"] for r in conn.execute(
                "SELECT DISTINCT COUNTRY_NAME FROM records WHERE run_id=? AND INGR_STD_NAME=? AND lower(trim(INGR_ENG_NAME))=?", (rid, std, eng_n))})
            lookup_status = "found" if entries else "not_listed"
        elif ident["status"] == "ambiguous":
            lookup_status = "link_required"
        else:
            lookup_status = "not_listed"
        related = related_items(conn, rid, countries, kr_name, inci_name, exclude_identity=ident["identity"])
    finally:
        conn.close()

    if lookup_status == "found":
        note = None
    elif lookup_status == "link_required":
        note = "성분 연결 확인 필요: " + (ident["conflict"] or "")
    else:
        note = "이 출처(식약처 수집 DB)에서 이름·CAS 가 정확히 일치하는 항목을 찾지 못했어요. 허용·안전·규제 없음을 뜻하지 않아요." + (" 관련 항목 %d건은 적용 여부 확인이 필요해요." % len(related) if related else "")
    return {
        "source": "mfds",
        "source_label": SOURCE_LABEL,
        "source_page": SOURCE_PAGE,
        "collected_at": run["finished_at"],               # DB 에 기록된 수집 완료 시각 (원천 갱신일 아님)
        "collection_run": {"run_id": rid, "status": run["status"], "records": run["records_saved"], "started_at": run["started_at"], "finished_at": run["finished_at"]},
        "ingredient": {"code": api_code, "kr_name": (kr_name or "").strip() or None, "inci_name": (inci_name or "").strip() or None, "cas_numbers": (cas or "").strip() or None},
        "country": {"requested": market, "resolved": " / ".join(countries), "code": market, "country_names": countries},
        "link_status": ident["status"],
        "link_basis": ident["basis"],
        "link_conflict": ident["conflict"],
        "link_candidates": ident["candidates"],
        "matched_identity": {"std_name": ident["identity"][0], "eng_name": ident["candidates"][0]["eng_name"] if ident["candidates"] else None} if ident["identity"] else None,
        "lookup_status": lookup_status,
        "result_status": "mfds_" + lookup_status,
        "result_note": note,
        "entries": entries,
        "related": related,
        "markets_listed": markets_listed,
        "data_source": DATA_SOURCE_TEXT,
        "disclaimer": DISCLAIMER,
        "source_updated_at": None,                         # 원천 갱신일·법령 개정일은 응답에 없음 → 미제공
        "queried_at": _now_iso(),
    }

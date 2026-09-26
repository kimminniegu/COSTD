"""국가별 인허가 규제 — 식약처 '화장품 사용제한 원료정보' 공공데이터 API 수집·분석 스크립트 (담당자 B).

목적: 기존 RapidAPI 를 교체하기 전에 식약처 데이터의 국가별 범위·활용 가능성을 확인한다.
      기존 서비스 화면·조회 연결은 건드리지 않는 독립 스크립트다. app.py 에서 import 하지 않으며 자동 실행되지 않는다.

공식 안내: https://www.data.go.kr/data/15111772/openapi.do
호출:     GET https://apis.data.go.kr/1471000/CsmtcsUseRstrcInfoService/getCsmtcsUseRstrcInfoService
          ?serviceKey=<Decoding 키> &pageNo=N &numOfRows=M &type=json
확인된 응답: {"header": {"resultCode": "00", "resultMsg": "NORMAL SERVICE."},
             "body": {"pageNo", "totalCount", "numOfRows", "items": [ {REGULATE_TYPE, INGR_STD_NAME, INGR_ENG_NAME, CAS_NO,
             INGR_SYNONYM, COUNTRY_NAME, NOTICE_INGR_NAME, PROVIS_ATRCL, LIMIT_COND}, ... ]}}
  - items 는 배열이다(items.item 아님). 단서조항 필드는 PROVIS_ATRCL.
  - totalCount 는 레코드 수(성분 × 국가·조건)이며 고유 성분 수가 아니다.

미확인 사항: 공식 페이지의 요청 변수 표(numOfRows 최대값)와 호출 제한은 스크립트 렌더라 읽지 못했다. 보이는 값은
  "개발계정 트래픽 10,000" 뿐이다. 그래서 페이지 크기·요청 간격은 환경변수로 조정하며 기본값을 보수적으로 둔다.

인증키: .env 의 MFDS_API_KEY (Decoding 키). requests 의 params 인코딩에 맡겨 이중 인코딩을 피한다.
  키·키가 든 URL 은 저장·로그·오류 메시지·보고에 넣지 않는다. 브라우저로도 전달하지 않는다.

저장: instance/regulatory/mfds_use_restriction.sqlite (Git 제외 · /assets 공개 경로 아님. 기존 서비스 DB instance/cosmoa.db 와 별개)
  runs    : 수집 실행 정보 (조건·시각·상태·건수·호출 수·메모). 미완료 실행은 status 로 구분한다
  pages   : 페이지 단위 기록 (요청/응답 건수·totalCount·resultCode·HTTP 상태·내용 해시)
  records : 원본 9개 필드 그대로 + raw_json + run_id/page_no/row_index/fetched_at
  페이지 하나가 트랜잭션 단위다. 재개는 완료된 페이지 다음부터 이어받고, 조건(페이지 크기)·totalCount 변화를 확인한다.

사용법 (프로젝트 루트에서, tdenv 활성화 후):
  python src/02_regulatory/mfds_use_restriction.py probe                 # 소량(5건) 호출로 연결·구조 확인 (1회 호출)
  python src/02_regulatory/mfds_use_restriction.py collect               # 페이지 순차 수집 (진행 중 실행이 있으면 자동 재개)
  python src/02_regulatory/mfds_use_restriction.py collect --new-run     # 새 실행으로 처음부터
  python src/02_regulatory/mfds_use_restriction.py status                # 실행 목록·진행 상태
  python src/02_regulatory/mfds_use_restriction.py analyze               # 최신 완료 실행 분석 (API 호출 없음)
  python src/02_regulatory/mfds_use_restriction.py find Retinol 레티놀    # 성분 검색 (API 호출 없음)
환경변수(선택): MFDS_PAGE_SIZE(기본 100) MFDS_REQUEST_INTERVAL(초, 기본 0.3) MFDS_TIMEOUT(초, 기본 30) MFDS_MAX_RETRIES(기본 3) MFDS_DB_PATH
"""

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time
from collections import Counter, OrderedDict
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
SOURCE_PAGE = "https://www.data.go.kr/data/15111772/openapi.do"
BASE_URL = "https://apis.data.go.kr/1471000/CsmtcsUseRstrcInfoService"
ENDPOINT = "/getCsmtcsUseRstrcInfoService"
FIELDS = ("REGULATE_TYPE", "INGR_STD_NAME", "INGR_ENG_NAME", "CAS_NO", "INGR_SYNONYM",
          "COUNTRY_NAME", "NOTICE_INGR_NAME", "PROVIS_ATRCL", "LIMIT_COND")

# 공공데이터포털 공통 오류 코드 (포털 개발가이드 기준, 참고용). 인증·한도 계열은 재시도하지 않는다.
PORTAL_CODES = {
    "00": "NORMAL_SERVICE", "01": "APPLICATION_ERROR", "02": "DB_ERROR", "03": "NODATA_ERROR", "04": "HTTP_ERROR",
    "05": "SERVICETIME_OUT", "10": "INVALID_REQUEST_PARAMETER_ERROR", "11": "NO_MANDATORY_REQUEST_PARAMETERS_ERROR",
    "12": "NO_OPENAPI_SERVICE_ERROR", "20": "SERVICE_ACCESS_DENIED_ERROR", "22": "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR",
    "30": "SERVICE_KEY_IS_NOT_REGISTERED_ERROR", "31": "DEADLINE_HAS_EXPIRED_ERROR", "32": "UNREGISTERED_IP_ERROR",
    "33": "UNSIGNED_CALL_ERROR", "99": "UNKNOWN_ERROR",
}
NO_RETRY_CODES = {"20", "22", "30", "31", "32", "33", "10", "11", "12"}
TRANSIENT_CODES = {"01", "02", "04", "05", "99"}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Abort(Exception):
    """수집을 멈춰야 하는 상황. kind: config | auth | limit | http | structure | result | integrity | count_change | page_size"""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind
        self.message = message


class Transient(Exception):
    """재시도 가능한 일시 오류 (시간 초과·연결·5xx·포털 일시 오류)"""


# ---------------------------------------------------------------------------
# 설정
# ---------------------------------------------------------------------------

def load_env():
    try:
        from dotenv import load_dotenv
        load_dotenv(BASE_DIR / ".env", override=False)
    except ImportError:
        pass


def config():
    load_env()
    key = (os.getenv("MFDS_API_KEY") or "").strip()
    if not key:
        raise Abort("config", ".env 에 MFDS_API_KEY 가 없어요. Decoding 인증키를 넣어 주세요. (값은 어디에도 출력하지 않아요)")
    return {
        "key": key,
        "page_size": int(os.getenv("MFDS_PAGE_SIZE", "100")),
        "interval": float(os.getenv("MFDS_REQUEST_INTERVAL", "0.3")),
        "timeout": float(os.getenv("MFDS_TIMEOUT", "30")),
        "retries": int(os.getenv("MFDS_MAX_RETRIES", "3")),
        "db_path": Path(os.getenv("MFDS_DB_PATH") or (BASE_DIR / "instance" / "regulatory" / "mfds_use_restriction.sqlite")),
    }


def public_url():
    """저장·보고용 주소 (인증키 없음)"""
    return BASE_URL + ENDPOINT


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _http_get(session, params, timeout):
    """실제 GET. 테스트에서 이 함수를 바꿔 끼운다. (status_code, text) 반환. 예외는 Transient 로 감싼다."""
    import requests
    try:
        r = session.get(public_url(), params=params, timeout=(min(10.0, timeout), timeout))
    except requests.exceptions.Timeout:
        raise Transient("timeout")
    except requests.exceptions.RequestException:
        raise Transient("connection")
    return r.status_code, r.text


def parse_response(status, text):
    """HTTP 상태 + 본문 → {"total_count", "items", "result_code", "result_msg", "page_no", "num_rows"}.
    오류·예상 밖 구조는 '정상 빈 데이터'로 취급하지 않고 Abort/Transient 로 던진다."""
    if status in (401, 403):
        raise Abort("auth", "인증·접근 거부 응답(HTTP %d)이에요. 인증키·서비스 신청 상태를 확인해 주세요." % status)
    if status == 429:
        raise Abort("limit", "호출 한도 초과 응답(HTTP 429)이에요. 오늘은 더 호출하지 않고 진행 내용을 보존해요.")
    if status >= 500:
        raise Transient("http_%d" % status)
    if status != 200:
        raise Abort("http", "예상 밖 HTTP 상태 %d 예요." % status)
    stripped = (text or "").lstrip()
    if stripped.startswith("<"):
        # 포털 공통 오류는 type=json 이어도 XML 로 올 수 있다: <returnReasonCode>30</returnReasonCode> 등
        m = re.search(r"<returnReasonCode>\s*(\d+)\s*</returnReasonCode>", stripped)
        code = m.group(1) if m else None
        name = PORTAL_CODES.get(code, "알 수 없는 코드")
        if code in NO_RETRY_CODES:
            raise Abort("auth" if code in ("20", "30", "31", "32", "33") else ("limit" if code == "22" else "result"),
                        "포털 오류 응답(XML) returnReasonCode=%s (%s)" % (code, name))
        if code in TRANSIENT_CODES:
            raise Transient("portal_%s" % code)
        raise Abort("structure", "JSON 이 아닌 응답(XML)이 왔어요. returnReasonCode=%s" % code)
    try:
        data = json.loads(stripped)
    except ValueError:
        raise Abort("structure", "JSON 으로 해석할 수 없는 응답이에요 (길이 %d)." % len(stripped))
    if not isinstance(data, dict):
        raise Abort("structure", "응답 최상위가 객체가 아니에요.")
    header = data.get("header")
    body = data.get("body")
    if not isinstance(header, dict) or not isinstance(body, dict):
        raise Abort("structure", "응답에 header/body 가 없어요: 키=%s" % sorted(data.keys()))
    code = str(header.get("resultCode", "")).strip()
    msg = str(header.get("resultMsg", "")).strip()
    if code != "00":
        if code in NO_RETRY_CODES:
            raise Abort("auth" if code in ("20", "30", "31", "32", "33") else ("limit" if code == "22" else "result"),
                        "resultCode=%s (%s) resultMsg=%s" % (code, PORTAL_CODES.get(code, "?"), msg))
        if code in TRANSIENT_CODES:
            raise Transient("portal_%s" % code)
        raise Abort("result", "resultCode=%s resultMsg=%s — 정상 코드(00)가 아니라 중단해요." % (code, msg))
    items = body.get("items")
    if items is None or items == "":
        items = []
    if not isinstance(items, list):
        raise Abort("structure", "body.items 가 배열이 아니에요 (type=%s)." % type(items).__name__)
    for it in items:
        if not isinstance(it, dict):
            raise Abort("structure", "items 원소가 객체가 아니에요.")
    try:
        total = int(body.get("totalCount"))
    except (TypeError, ValueError):
        raise Abort("structure", "body.totalCount 를 읽을 수 없어요.")
    return {"total_count": total, "items": items, "result_code": code, "result_msg": msg,
            "page_no": body.get("pageNo"), "num_rows": body.get("numOfRows")}


def fetch_page(session, cfg, page_no, num_rows, counter):
    """한 페이지를 가져온다. 일시 오류는 제한 재시도, 인증·한도·구조 오류는 즉시 Abort. counter['calls'] 에 호출 수를 더한다."""
    params = OrderedDict([("serviceKey", cfg["key"]), ("pageNo", page_no), ("numOfRows", num_rows), ("type", "json")])
    attempt = 0
    while True:
        attempt += 1
        counter["calls"] += 1
        try:
            status, text = _http_get(session, params, cfg["timeout"])
            parsed = parse_response(status, text)
            parsed["http_status"] = status
            return parsed
        except Transient as exc:
            if attempt > cfg["retries"]:
                raise Abort("http", "일시 오류가 %d회 반복됐어요 (%s). 진행 내용은 보존했어요." % (attempt, exc))
            time.sleep(min(8.0, 1.5 * attempt))


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL,                 -- running | completed | completed_with_warnings | aborted
  source_url TEXT NOT NULL,             -- 인증키 없는 주소
  source_page TEXT NOT NULL,
  page_size INTEGER NOT NULL,
  total_count_first INTEGER, total_count_last INTEGER,
  pages_done INTEGER NOT NULL DEFAULT 0, records_saved INTEGER NOT NULL DEFAULT 0, calls_made INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE TABLE IF NOT EXISTS pages (
  run_id INTEGER NOT NULL, page_no INTEGER NOT NULL,
  fetched_at TEXT NOT NULL, http_status INTEGER, result_code TEXT, result_msg TEXT,
  num_rows_requested INTEGER, num_rows_returned INTEGER, total_count INTEGER, content_hash TEXT,
  PRIMARY KEY (run_id, page_no)
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL, page_no INTEGER NOT NULL, row_index INTEGER NOT NULL, fetched_at TEXT NOT NULL,
  REGULATE_TYPE TEXT, INGR_STD_NAME TEXT, INGR_ENG_NAME TEXT, CAS_NO TEXT, INGR_SYNONYM TEXT,
  COUNTRY_NAME TEXT, NOTICE_INGR_NAME TEXT, PROVIS_ATRCL TEXT, LIMIT_COND TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_run ON records(run_id, page_no);
CREATE INDEX IF NOT EXISTS idx_records_std ON records(INGR_STD_NAME);
CREATE INDEX IF NOT EXISTS idx_records_eng ON records(INGR_ENG_NAME);
CREATE INDEX IF NOT EXISTS idx_records_cas ON records(CAS_NO);
"""


def open_db(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def content_hash(items):
    return hashlib.sha256(json.dumps(items, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def save_page(conn, run_id, page_no, parsed, requested, fetched_at):
    """페이지 하나를 트랜잭션으로 저장한다. 이미 저장된 페이지면 저장하지 않는다(재개 시 중복 방지)."""
    items = parsed["items"]
    with conn:
        exists = conn.execute("SELECT 1 FROM pages WHERE run_id=? AND page_no=?", (run_id, page_no)).fetchone()
        if exists:
            return False
        conn.execute("INSERT INTO pages VALUES (?,?,?,?,?,?,?,?,?,?)",
                     (run_id, page_no, fetched_at, parsed.get("http_status"), parsed["result_code"], parsed["result_msg"],
                      requested, len(items), parsed["total_count"], content_hash(items)))
        conn.executemany(
            "INSERT INTO records (run_id, page_no, row_index, fetched_at, %s, raw_json) VALUES (?,?,?,?,%s,?)" % (", ".join(FIELDS), ",".join("?" * len(FIELDS))),
            [(run_id, page_no, i, fetched_at) + tuple(it.get(f) for f in FIELDS) + (json.dumps(it, ensure_ascii=False),) for i, it in enumerate(items)])
        conn.execute("UPDATE runs SET pages_done=pages_done+1, records_saved=records_saved+?, total_count_last=? WHERE run_id=?",
                     (len(items), parsed["total_count"], run_id))
    return True


def finish_run(conn, run_id, status, calls, note=None):
    with conn:
        conn.execute("UPDATE runs SET status=?, finished_at=?, calls_made=calls_made+?, note=COALESCE(?, note) WHERE run_id=?",
                     (status, now_iso(), calls, note, run_id))


# ---------------------------------------------------------------------------
# 수집
# ---------------------------------------------------------------------------

def probe(cfg, num_rows=5):
    """소량 호출 1회로 연결·응답 구조를 확인한다. 저장하지 않는다."""
    import requests
    counter = {"calls": 0}
    with requests.Session() as s:
        parsed = fetch_page(s, cfg, 1, num_rows, counter)
    print("연결 확인: HTTP %s resultCode=%s (%s)" % (parsed["http_status"], parsed["result_code"], parsed["result_msg"]))
    print("totalCount=%s, 요청 %d건 → 응답 %d건, body.pageNo=%s numOfRows=%s" % (parsed["total_count"], num_rows, len(parsed["items"]), parsed["page_no"], parsed["num_rows"]))
    if parsed["items"]:
        first = parsed["items"][0]
        print("첫 레코드 필드:", sorted(first.keys()))
        missing = [f for f in FIELDS if f not in first]
        print("확인된 9개 필드 누락:", missing or "없음")
    print("호출 횟수:", counter["calls"])
    return parsed


def collect(cfg, new_run=False, max_pages=None, allow_count_change=False, log=print):
    """페이지 순차 수집. 진행 중(running) 실행이 있고 page_size 가 같으면 이어받는다."""
    import requests
    conn = open_db(cfg["db_path"])
    page_size = cfg["page_size"]
    counter = {"calls": 0}
    run = None
    if not new_run:
        run = conn.execute("SELECT * FROM runs WHERE status='running' ORDER BY run_id DESC LIMIT 1").fetchone()
        if run and run["page_size"] != page_size:
            raise Abort("page_size", "진행 중 실행(run %d)의 페이지 크기는 %d 인데 지금 설정은 %d 예요. 섞이지 않게 --new-run 으로 새로 시작하거나 MFDS_PAGE_SIZE 를 맞춰 주세요."
                        % (run["run_id"], run["page_size"], page_size))
    with requests.Session() as session:
        try:
            if run is None:
                fetched_at = now_iso()
                first = fetch_page(session, cfg, 1, page_size, counter)
                total = first["total_count"]
                expected_first = min(page_size, total)
                if len(first["items"]) != expected_first:
                    raise Abort("page_size", "요청한 페이지 크기 %d 가 적용되지 않았어요 (응답 %d건, totalCount %d). MFDS_PAGE_SIZE 를 응답 건수 이하로 낮춰 다시 실행해 주세요."
                                % (page_size, len(first["items"]), total))
                with conn:
                    cur = conn.execute("INSERT INTO runs (started_at, status, source_url, source_page, page_size, total_count_first, total_count_last) VALUES (?,?,?,?,?,?,?)",
                                       (fetched_at, "running", public_url(), SOURCE_PAGE, page_size, total, total))
                    run_id = cur.lastrowid
                save_page(conn, run_id, 1, first, page_size, fetched_at)
                log("run %d 시작: totalCount=%d, 페이지 크기 %d → 예상 %d쪽. 1쪽 저장(%d건)" % (run_id, total, page_size, math.ceil(total / page_size), len(first["items"])))
                next_page = 2
                prev_hash = content_hash(first["items"])
                warnings = []
            else:
                run_id = run["run_id"]
                total = run["total_count_first"]
                last = conn.execute("SELECT MAX(page_no) AS p FROM pages WHERE run_id=?", (run_id,)).fetchone()["p"] or 0
                next_page = last + 1
                prev_row = conn.execute("SELECT content_hash FROM pages WHERE run_id=? AND page_no=?", (run_id, last)).fetchone()
                prev_hash = prev_row["content_hash"] if prev_row else None
                warnings = [run["note"]] if run["note"] else []
                log("run %d 재개: 완료 %d쪽까지, %d쪽부터 이어받아요 (페이지 크기 %d, 시작 totalCount %d)" % (run_id, last, next_page, page_size, total))
            total_pages = math.ceil(total / page_size)
            pages_this_call = 0
            page_no = next_page
            while page_no <= total_pages:
                if max_pages is not None and pages_this_call >= max_pages:
                    log("--max-pages %d 에 도달해 이번 실행을 멈춰요 (run 은 running 으로 남아 재개 가능)" % max_pages)
                    finish_run(conn, run_id, "running", counter["calls"])
                    return run_id
                time.sleep(cfg["interval"])
                fetched_at = now_iso()
                parsed = fetch_page(session, cfg, page_no, page_size, counter)
                if parsed["total_count"] != total:
                    msg = "totalCount 변화: 시작 %d → %d쪽 응답 %d" % (total, page_no, parsed["total_count"])
                    if run is not None and page_no == next_page and not allow_count_change:
                        # 재개 첫 페이지에서 건수가 달라지면 페이지 경계가 밀렸을 수 있어 멈춘다
                        raise Abort("count_change", msg + " — 재개 조건이 달라졌어요. --allow-count-change 로 계속하거나 --new-run 으로 새로 수집해 주세요.")
                    if msg not in warnings:
                        warnings.append(msg)
                        log("경고: " + msg)
                h = content_hash(parsed["items"])
                if parsed["items"] and h == prev_hash:
                    raise Abort("integrity", "%d쪽 내용이 직전 쪽과 같아요(반복 페이지). 페이징이 불안정할 수 있어 중단해요." % page_no)
                if not parsed["items"] and page_no < total_pages:
                    raise Abort("integrity", "%d쪽이 마지막 쪽(%d)보다 앞인데 비어 있어요(조기 빈 페이지). 중단해요." % (page_no, total_pages))
                if page_no < total_pages and len(parsed["items"]) != page_size:
                    warnings.append("%d쪽 응답 건수 %d ≠ 페이지 크기 %d" % (page_no, len(parsed["items"]), page_size))
                    log("경고: " + warnings[-1])
                save_page(conn, run_id, page_no, parsed, page_size, fetched_at)
                prev_hash = h
                pages_this_call += 1
                if page_no % 25 == 0 or page_no == total_pages:
                    log("  %d/%d쪽 저장 (호출 %d회)" % (page_no, total_pages, counter["calls"]))
                page_no += 1
            saved = conn.execute("SELECT COUNT(*) AS c FROM records WHERE run_id=?", (run_id,)).fetchone()["c"]
            last_total = conn.execute("SELECT total_count FROM pages WHERE run_id=? ORDER BY page_no DESC LIMIT 1", (run_id,)).fetchone()["total_count"]
            if saved != last_total:
                warnings.append("수집 건수 %d ≠ 마지막 totalCount %d" % (saved, last_total))
            status = "completed_with_warnings" if warnings else "completed"
            finish_run(conn, run_id, status, counter["calls"], " / ".join(warnings) if warnings else None)
            log("완료: run %d status=%s 저장 %d건, totalCount(마지막) %d, 이번 호출 %d회" % (run_id, status, saved, last_total, counter["calls"]))
            return run_id
        except Abort as exc:
            if run is not None or "run_id" in locals():
                rid = run["run_id"] if run is not None else run_id
                finish_run(conn, rid, "aborted" if exc.kind not in ("count_change",) else "running", counter["calls"], "%s: %s" % (exc.kind, exc.message))
            log("중단(%s): %s" % (exc.kind, exc.message))
            log("진행 내용은 보존했어요. 호출 %d회." % counter["calls"])
            raise
        except KeyboardInterrupt:
            finish_run(conn, run_id, "running", counter["calls"], "사용자 중단 — 재개 가능")
            log("사용자 중단. 완료한 페이지는 보존했고 다음 실행에서 이어받아요.")
            raise
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 분석 (API 호출 없음)
# ---------------------------------------------------------------------------

def latest_run(conn, include_incomplete=False):
    q = "SELECT * FROM runs ORDER BY run_id DESC"
    for r in conn.execute(q):
        if r["status"] in ("completed", "completed_with_warnings") or include_incomplete:
            return r
    return None


def status(cfg):
    conn = open_db(cfg["db_path"])
    rows = conn.execute("SELECT * FROM runs ORDER BY run_id").fetchall()
    if not rows:
        print("수집 실행 기록이 없어요. DB:", cfg["db_path"])
        return
    for r in rows:
        print("run %d | %s | 시작 %s | 종료 %s | 페이지 크기 %d | 완료 %d쪽 | 저장 %d건 | totalCount %s→%s | 호출 %d | %s"
              % (r["run_id"], r["status"], r["started_at"], r["finished_at"] or "-", r["page_size"], r["pages_done"], r["records_saved"],
                 r["total_count_first"], r["total_count_last"], r["calls_made"], r["note"] or ""))
    conn.close()


def _split_cas(cas):
    """CAS 표기 후보를 나눈다. 쉼표·슬래시·세미콜론·공백으로 나뉜 '숫자-숫자-숫자' 형태만 인정한다(그 외는 나누지 않음)."""
    if not cas:
        return []
    return re.findall(r"\b\d{2,7}-\d{2}-\d\b", cas)


def analyze(cfg, run_id=None):
    conn = open_db(cfg["db_path"])
    run = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone() if run_id else latest_run(conn)
    if run is None:
        print("완료된 수집 실행이 없어요. 먼저 collect 를 실행해 주세요. (미완료 실행은 status 로 확인)")
        return None
    rid = run["run_id"]
    q = lambda sql, *a: conn.execute(sql, a).fetchall()
    total_saved = q("SELECT COUNT(*) c FROM records WHERE run_id=?", rid)[0]["c"]
    pages = q("SELECT page_no, num_rows_returned, total_count, content_hash FROM pages WHERE run_id=? ORDER BY page_no", rid)
    out = OrderedDict()
    out["run"] = dict(run)
    out["pages"] = len(pages)
    out["records"] = total_saved
    out["total_count_first"] = run["total_count_first"]
    out["total_count_last"] = run["total_count_last"]
    out["count_match"] = total_saved == run["total_count_last"]
    # 페이지 연속성·반복
    nums = [p["page_no"] for p in pages]
    out["page_gaps"] = [n for n in range(1, (nums[-1] if nums else 0) + 1) if n not in set(nums)]
    hashes = Counter(p["content_hash"] for p in pages if p["num_rows_returned"])
    out["repeated_pages"] = [h[:12] for h, c in hashes.items() if c > 1]
    out["short_pages"] = [(p["page_no"], p["num_rows_returned"]) for p in pages[:-1] if p["num_rows_returned"] != run["page_size"]]
    out["total_count_values"] = sorted(set(p["total_count"] for p in pages))
    # 국가·유형
    out["by_country"] = q("SELECT COUNTRY_NAME, COUNT(*) c FROM records WHERE run_id=? GROUP BY COUNTRY_NAME ORDER BY c DESC", rid)
    out["by_type"] = q("SELECT REGULATE_TYPE, COUNT(*) c FROM records WHERE run_id=? GROUP BY REGULATE_TYPE ORDER BY c DESC", rid)
    out["by_country_type"] = q("SELECT COUNTRY_NAME, REGULATE_TYPE, COUNT(*) c FROM records WHERE run_id=? GROUP BY 1,2 ORDER BY 1,3 DESC", rid)
    # 고유 성분 추정 (기준별)
    out["distinct_std"] = q("SELECT COUNT(DISTINCT INGR_STD_NAME) c FROM records WHERE run_id=? AND INGR_STD_NAME IS NOT NULL AND INGR_STD_NAME<>''", rid)[0]["c"]
    out["distinct_eng"] = q("SELECT COUNT(DISTINCT lower(trim(INGR_ENG_NAME))) c FROM records WHERE run_id=? AND INGR_ENG_NAME IS NOT NULL AND INGR_ENG_NAME<>''", rid)[0]["c"]
    out["distinct_std_eng"] = q("SELECT COUNT(*) c FROM (SELECT DISTINCT INGR_STD_NAME, lower(trim(INGR_ENG_NAME)) FROM records WHERE run_id=?)", rid)[0]["c"]
    out["distinct_cas_raw"] = q("SELECT COUNT(DISTINCT CAS_NO) c FROM records WHERE run_id=? AND CAS_NO IS NOT NULL AND CAS_NO<>''", rid)[0]["c"]
    out["cas_null"] = q("SELECT COUNT(*) c FROM records WHERE run_id=? AND (CAS_NO IS NULL OR CAS_NO='')", rid)[0]["c"]
    multi = 0; cas_tokens = set()
    for r in q("SELECT CAS_NO FROM records WHERE run_id=? AND CAS_NO IS NOT NULL AND CAS_NO<>''", rid):
        toks = _split_cas(r["CAS_NO"])
        if len(toks) > 1:
            multi += 1
        cas_tokens.update(toks)
    out["cas_multi_records"] = multi
    out["distinct_cas_tokens"] = len(cas_tokens)
    out["std_null"] = q("SELECT COUNT(*) c FROM records WHERE run_id=? AND (INGR_STD_NAME IS NULL OR INGR_STD_NAME='')", rid)[0]["c"]
    out["eng_null"] = q("SELECT COUNT(*) c FROM records WHERE run_id=? AND (INGR_ENG_NAME IS NULL OR INGR_ENG_NAME='')", rid)[0]["c"]
    # 제한사항·단서조항
    out["limit_cond_present"] = q("SELECT COUNT(*) c FROM records WHERE run_id=? AND LIMIT_COND IS NOT NULL AND trim(LIMIT_COND)<>''", rid)[0]["c"]
    out["provis_present"] = q("SELECT COUNT(*) c FROM records WHERE run_id=? AND PROVIS_ATRCL IS NOT NULL AND trim(PROVIS_ATRCL)<>''", rid)[0]["c"]
    out["both_present"] = q("SELECT COUNT(*) c FROM records WHERE run_id=? AND LIMIT_COND IS NOT NULL AND trim(LIMIT_COND)<>'' AND PROVIS_ATRCL IS NOT NULL AND trim(PROVIS_ATRCL)<>''", rid)[0]["c"]
    out["prohibited_without_limit"] = q("SELECT COUNT(*) c FROM records WHERE run_id=? AND REGULATE_TYPE='금지' AND (LIMIT_COND IS NULL OR trim(LIMIT_COND)='')", rid)[0]["c"]
    # 중복: 9개 필드가 모두 같은 레코드 (원천 중복 또는 페이징 불안정 — 서로 다른 페이지에 나뉘어 있으면 후자 의심)
    dup_rows = q("SELECT %s, COUNT(*) c, COUNT(DISTINCT page_no) pages, MIN(page_no) p1, MAX(page_no) p2 FROM records WHERE run_id=? GROUP BY %s HAVING c>1" % (", ".join(FIELDS), ", ".join(FIELDS)), rid)
    out["dup_groups"] = len(dup_rows)
    out["dup_extra_records"] = sum(r["c"] - 1 for r in dup_rows)
    out["dup_same_page_groups"] = sum(1 for r in dup_rows if r["pages"] == 1)
    out["dup_cross_page_groups"] = sum(1 for r in dup_rows if r["pages"] > 1)
    out["dup_examples"] = [(r["INGR_STD_NAME"], r["COUNTRY_NAME"], r["REGULATE_TYPE"], r["c"], r["p1"], r["p2"]) for r in dup_rows[:5]]
    conn.close()
    return out


def print_analysis(out):
    if not out:
        return
    run = out["run"]
    print("== 수집 실행 run %d (%s) — %s ~ %s, 호출 %d회, 페이지 크기 %d" % (run["run_id"], run["status"], run["started_at"], run["finished_at"], run["calls_made"], run["page_size"]))
    print("   저장 %d건 / totalCount 시작 %s · 마지막 %s / 페이지 %d쪽 / 건수 일치: %s" % (out["records"], out["total_count_first"], out["total_count_last"], out["pages"], out["count_match"]))
    print("   페이지 누락:", out["page_gaps"] or "없음", "| 반복 페이지(해시 동일):", out["repeated_pages"] or "없음", "| 짧은 페이지:", out["short_pages"] or "없음", "| totalCount 값들:", out["total_count_values"])
    if run["note"]:
        print("   메모:", run["note"])
    print("== 국가별 레코드 수 (원본 COUNTRY_NAME)")
    for r in out["by_country"]:
        print("   %-12s %6d" % (r["COUNTRY_NAME"], r["c"]))
    print("== 규제 유형별 레코드 수 (원본 REGULATE_TYPE)")
    for r in out["by_type"]:
        print("   %-12s %6d" % (r["REGULATE_TYPE"], r["c"]))
    print("== 국가 × 유형")
    for r in out["by_country_type"]:
        print("   %-8s %-8s %6d" % (r["COUNTRY_NAME"], r["REGULATE_TYPE"], r["c"]))
    print("== 고유 성분 수 (기준별)")
    print("   표준명(INGR_STD_NAME) 고유 %d | 영문명 고유(대소문자·공백 무시) %d | 표준명+영문명 조합 %d" % (out["distinct_std"], out["distinct_eng"], out["distinct_std_eng"]))
    print("   CAS 원문 고유 %d | CAS 토큰(정규식 분리) 고유 %d | CAS 없음 %d건 | 복수 CAS 레코드 %d건 | 표준명 없음 %d건 | 영문명 없음 %d건"
          % (out["distinct_cas_raw"], out["distinct_cas_tokens"], out["cas_null"], out["cas_multi_records"], out["std_null"], out["eng_null"]))
    print("== 제한사항·단서조항")
    print("   LIMIT_COND 있음 %d건 | PROVIS_ATRCL 있음 %d건 | 둘 다 %d건 | '금지'인데 LIMIT_COND 없음 %d건 (제한 없음이 아님)"
          % (out["limit_cond_present"], out["provis_present"], out["both_present"], out["prohibited_without_limit"]))
    print("== 중복 (9개 필드 전부 동일)")
    print("   그룹 %d개, 추가 레코드 %d건 | 같은 페이지 안 %d그룹(원천 중복) | 여러 페이지에 걸침 %d그룹(원천 중복 또는 페이징 불안정 — 구분 불가)"
          % (out["dup_groups"], out["dup_extra_records"], out["dup_same_page_groups"], out["dup_cross_page_groups"]))
    for ex in out["dup_examples"]:
        print("   예:", ex)


def find(cfg, terms, run_id=None):
    """성분 검색. 정확 일치(표준명·영문명·CAS)와 포함 일치(표준명·영문명·이명·고시원료명)를 구분해 보여준다."""
    conn = open_db(cfg["db_path"])
    run = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone() if run_id else latest_run(conn)
    if run is None:
        print("완료된 수집 실행이 없어요.")
        return
    rid = run["run_id"]
    for term in terms:
        t = term.strip()
        low = t.lower()
        exact = conn.execute(
            "SELECT * FROM records WHERE run_id=? AND (lower(trim(INGR_STD_NAME))=? OR lower(trim(INGR_ENG_NAME))=? OR CAS_NO=?) ORDER BY COUNTRY_NAME, REGULATE_TYPE",
            (rid, low, low, t)).fetchall()
        contains = conn.execute(
            "SELECT * FROM records WHERE run_id=? AND (instr(lower(INGR_STD_NAME), ?)>0 OR instr(lower(INGR_ENG_NAME), ?)>0 OR instr(lower(INGR_SYNONYM), ?)>0 OR instr(lower(NOTICE_INGR_NAME), ?)>0) ORDER BY INGR_STD_NAME, COUNTRY_NAME",
            (rid, low, low, low, low)).fetchall()
        exact_ids = {r["id"] for r in exact}
        print("== '%s' — 정확 일치 %d건 (표준명·영문명·CAS) / 포함 일치(후보) %d건" % (t, len(exact), len([r for r in contains if r["id"] not in exact_ids])))
        for r in exact:
            basis = []
            if (r["INGR_STD_NAME"] or "").strip().lower() == low: basis.append("표준명")
            if (r["INGR_ENG_NAME"] or "").strip().lower() == low: basis.append("영문명")
            if r["CAS_NO"] == t: basis.append("CAS")
            print("   [정확·%s] %s | %s | CAS %s | %s | %s" % ("·".join(basis), r["COUNTRY_NAME"], r["REGULATE_TYPE"], r["CAS_NO"], r["INGR_STD_NAME"], r["INGR_ENG_NAME"]))
            print("      고시원료명: %s" % (r["NOTICE_INGR_NAME"] or "—"))
            print("      제한사항(LIMIT_COND): %s" % ((r["LIMIT_COND"] or "").replace("\n", " ")[:300] or "— (null)"))
            print("      단서조항(PROVIS_ATRCL): %s" % ((r["PROVIS_ATRCL"] or "").replace("\n", " ")[:300] or "— (null)"))
        seen = set()
        for r in contains:
            if r["id"] in exact_ids:
                continue
            key = (r["INGR_STD_NAME"], r["INGR_ENG_NAME"], r["COUNTRY_NAME"], r["REGULATE_TYPE"])
            if key in seen:
                continue
            seen.add(key)
            where = "표준명" if low in (r["INGR_STD_NAME"] or "").lower() else ("영문명" if low in (r["INGR_ENG_NAME"] or "").lower() else ("이명" if low in (r["INGR_SYNONYM"] or "").lower() else "고시원료명"))
            print("   [후보·%s 포함, 미확정] %s | %s | %s | %s" % (where, r["COUNTRY_NAME"], r["REGULATE_TYPE"], r["INGR_STD_NAME"], r["INGR_ENG_NAME"]))
    conn.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description="식약처 화장품 사용제한 원료정보 수집·분석 (담당자 B)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe", help="소량 호출 1회로 연결·구조 확인 (저장 안 함)")
    c = sub.add_parser("collect", help="페이지 순차 수집 (진행 중 실행 자동 재개)")
    c.add_argument("--new-run", action="store_true", help="진행 중 실행을 무시하고 새 실행으로 처음부터")
    c.add_argument("--max-pages", type=int, default=None, help="이번 실행에서 가져올 최대 페이지 수 (재개 가능)")
    c.add_argument("--allow-count-change", action="store_true", help="재개 시 totalCount 가 달라져도 계속 (경고 기록)")
    sub.add_parser("status", help="실행 목록")
    a = sub.add_parser("analyze", help="최신 완료 실행 분석 (API 호출 없음)")
    a.add_argument("--run-id", type=int, default=None)
    f = sub.add_parser("find", help="성분 검색 (API 호출 없음)")
    f.add_argument("terms", nargs="+")
    f.add_argument("--run-id", type=int, default=None)
    args = ap.parse_args(argv)
    try:
        cfg = config()
        if args.cmd == "probe":
            probe(cfg)
        elif args.cmd == "collect":
            collect(cfg, new_run=args.new_run, max_pages=args.max_pages, allow_count_change=args.allow_count_change)
        elif args.cmd == "status":
            status(cfg)
        elif args.cmd == "analyze":
            print_analysis(analyze(cfg, args.run_id))
        elif args.cmd == "find":
            find(cfg, args.terms, args.run_id)
    except Abort as exc:
        print("오류(%s): %s" % (exc.kind, exc.message))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

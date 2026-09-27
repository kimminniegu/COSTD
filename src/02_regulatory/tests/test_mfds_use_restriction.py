"""식약처 사용제한 원료정보 수집 스크립트 테스트 (담당자 B). 외부 API 를 호출하지 않는다 — 모의 응답으로 검증.

실행 (프로젝트 루트):  python -m unittest discover -s src/02_regulatory/tests -p "test_mfds*.py" -v
"""

import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("mfds", HERE.parent / "mfds_use_restriction.py")
mfds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mfds)

SAMPLE = {"REGULATE_TYPE": "금지", "INGR_STD_NAME": "2,4,5-트라이메틸아닐린", "INGR_ENG_NAME": "2,4,5-Trimethylaniline", "CAS_NO": "137-17-7",
          "INGR_SYNONYM": "2,4,5-TMA6, 2,4,5-trimethylaniline hydrochloride", "COUNTRY_NAME": "아세안",
          "NOTICE_INGR_NAME": "2,4,5-Trimethylaniline [1]; 2,4,5-trimethylaniline hydrochloride [2]", "PROVIS_ATRCL": None, "LIMIT_COND": None}


def body(page_no, num_rows, total, items):
    return json.dumps({"header": {"resultCode": "00", "resultMsg": "NORMAL SERVICE."},
                       "body": {"pageNo": page_no, "totalCount": total, "numOfRows": num_rows, "items": items}}, ensure_ascii=False)


def rec(i, country="EU", rtype="제한", limit="최대 1%"):
    r = dict(SAMPLE)
    r.update({"INGR_STD_NAME": "성분%d" % i, "INGR_ENG_NAME": "Ingredient %d" % i, "CAS_NO": "%d-00-0" % (1000 + i), "COUNTRY_NAME": country, "REGULATE_TYPE": rtype, "LIMIT_COND": limit})
    return r


class FakeServer:
    """페이지별 응답을 흉내낸다. calls 에 (pageNo, numOfRows) 를 기록한다."""

    def __init__(self, total, page_size, fail=None):
        self.total, self.page_size, self.fail = total, page_size, fail or {}
        self.calls = []

    def __call__(self, session, params, timeout):
        assert "serviceKey" in params and params["type"] == "json"
        page, n = int(params["pageNo"]), int(params["numOfRows"])
        self.calls.append((page, n))
        if page in self.fail:
            f = self.fail[page]
            if callable(f):
                return f()
            return f
        start = (page - 1) * n
        items = [rec(i) for i in range(start + 1, min(start + n, self.total) + 1)]
        return 200, body(page, n, self.total, items)


def cfg_with(tmp, page_size=10):
    return {"key": "test-key-not-real", "page_size": page_size, "interval": 0.0, "timeout": 5.0, "retries": 2, "db_path": Path(tmp) / "t.sqlite"}


class ParseTest(unittest.TestCase):
    def test_normal_and_null_fields_preserved(self):
        p = mfds.parse_response(200, body(1, 5, 31191, [SAMPLE]))
        self.assertEqual(p["total_count"], 31191)
        self.assertEqual(len(p["items"]), 1)
        self.assertIsNone(p["items"][0]["PROVIS_ATRCL"])          # null 그대로
        self.assertEqual(p["items"][0]["REGULATE_TYPE"], "금지")  # LIMIT_COND null 이어도 '금지' 유지

    def test_result_code_not_00_is_error_not_empty(self):
        text = json.dumps({"header": {"resultCode": "03", "resultMsg": "NODATA_ERROR"}, "body": {"totalCount": 0, "items": []}})
        with self.assertRaises(mfds.Abort) as ctx:
            mfds.parse_response(200, text)
        self.assertEqual(ctx.exception.kind, "result")

    def test_auth_codes_abort(self):
        for code in ("30", "31", "32", "33", "20"):
            text = json.dumps({"header": {"resultCode": code, "resultMsg": "x"}, "body": {}})
            with self.assertRaises(mfds.Abort) as ctx:
                mfds.parse_response(200, text)
            self.assertEqual(ctx.exception.kind, "auth", code)
        with self.assertRaises(mfds.Abort) as ctx:
            mfds.parse_response(200, json.dumps({"header": {"resultCode": "22", "resultMsg": "limit"}, "body": {}}))
        self.assertEqual(ctx.exception.kind, "limit")

    def test_xml_portal_error_abort(self):
        xml = '<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>'
        with self.assertRaises(mfds.Abort) as ctx:
            mfds.parse_response(200, xml)
        self.assertEqual(ctx.exception.kind, "auth")

    def test_unexpected_structure_abort(self):
        with self.assertRaises(mfds.Abort):
            mfds.parse_response(200, json.dumps({"header": {"resultCode": "00"}, "body": {"totalCount": 5, "items": {"item": []}}}))
        with self.assertRaises(mfds.Abort):
            mfds.parse_response(200, "not json")
        with self.assertRaises(mfds.Abort) as ctx:
            mfds.parse_response(403, "")
        self.assertEqual(ctx.exception.kind, "auth")
        with self.assertRaises(mfds.Abort) as ctx2:
            mfds.parse_response(429, "")
        self.assertEqual(ctx2.exception.kind, "limit")
        with self.assertRaises(mfds.Transient):
            mfds.parse_response(503, "")

    def test_empty_items_string_is_empty_list(self):
        p = mfds.parse_response(200, json.dumps({"header": {"resultCode": "00", "resultMsg": "ok"}, "body": {"totalCount": 0, "items": ""}}))
        self.assertEqual(p["items"], [])


class CollectTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cfg = cfg_with(self.tmp)

    def _run(self, server, **kw):
        with mock.patch.object(mfds, "_http_get", server):
            return mfds.collect(self.cfg, log=lambda *a: None, **kw)

    def test_full_collect_and_counts(self):
        srv = FakeServer(total=23, page_size=10)
        rid = self._run(srv)
        self.assertEqual([c[0] for c in srv.calls], [1, 2, 3])
        conn = sqlite3.connect(str(self.cfg["db_path"])); conn.row_factory = sqlite3.Row
        run = conn.execute("SELECT * FROM runs WHERE run_id=?", (rid,)).fetchone()
        self.assertEqual(run["status"], "completed")
        self.assertEqual(run["records_saved"], 23)
        self.assertEqual(run["calls_made"], 3)
        self.assertNotIn("test-key", run["source_url"])                   # 키·키 포함 URL 저장 금지
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM records").fetchone()[0], 23)
        raw = conn.execute("SELECT raw_json, PROVIS_ATRCL FROM records LIMIT 1").fetchone()
        self.assertIsNone(raw["PROVIS_ATRCL"])
        self.assertIn("INGR_STD_NAME", raw["raw_json"])
        out = mfds.analyze(self.cfg, rid)
        self.assertTrue(out["count_match"]); self.assertEqual(out["page_gaps"], []); self.assertEqual(out["dup_groups"], 0)

    def test_resume_without_duplicates(self):
        srv = FakeServer(total=35, page_size=10, fail={3: (503, "")})     # 3쪽에서 계속 5xx → 재시도 후 중단
        with self.assertRaises(mfds.Abort):
            self._run(srv)
        conn = sqlite3.connect(str(self.cfg["db_path"])); conn.row_factory = sqlite3.Row
        run = conn.execute("SELECT * FROM runs ORDER BY run_id DESC LIMIT 1").fetchone()
        self.assertEqual(run["status"], "aborted")
        self.assertEqual(run["pages_done"], 2)
        # 중단된 실행은 aborted 라 자동 재개 대상이 아니다 → running 으로 되돌려 재개 시나리오를 만든다
        conn.execute("UPDATE runs SET status='running' WHERE run_id=?", (run["run_id"],)); conn.commit(); conn.close()
        srv2 = FakeServer(total=35, page_size=10)
        rid = self._run(srv2)
        self.assertEqual([c[0] for c in srv2.calls], [3, 4])                # 완료한 1·2쪽은 다시 요청하지 않음
        conn = sqlite3.connect(str(self.cfg["db_path"]))
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM records WHERE run_id=?", (rid,)).fetchone()[0], 35)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM pages WHERE run_id=?", (rid,)).fetchone()[0], 4)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM (SELECT page_no FROM records WHERE run_id=? GROUP BY page_no HAVING COUNT(*)>10)", (rid,)).fetchone()[0], 0)

    def test_resume_detects_total_count_change(self):
        srv = FakeServer(total=35, page_size=10, fail={3: (503, "")})
        with self.assertRaises(mfds.Abort):
            self._run(srv)
        conn = sqlite3.connect(str(self.cfg["db_path"]))
        conn.execute("UPDATE runs SET status='running'"); conn.commit(); conn.close()
        srv2 = FakeServer(total=40, page_size=10)                          # 재개 시 건수 변화
        with self.assertRaises(mfds.Abort) as ctx:
            self._run(srv2)
        self.assertEqual(ctx.exception.kind, "count_change")
        self.assertEqual(len(srv2.calls), 1)                               # 1회 확인 후 중단
        rid = self._run(FakeServer(total=40, page_size=10), allow_count_change=True)
        conn = sqlite3.connect(str(self.cfg["db_path"])); conn.row_factory = sqlite3.Row
        run = conn.execute("SELECT * FROM runs WHERE run_id=?", (rid,)).fetchone()
        self.assertEqual(run["status"], "completed_with_warnings")
        self.assertIn("totalCount 변화", run["note"])

    def test_page_size_mismatch_and_new_run_isolation(self):
        srv = FakeServer(total=35, page_size=10, fail={2: (503, "")})
        with self.assertRaises(mfds.Abort):
            self._run(srv)
        conn = sqlite3.connect(str(self.cfg["db_path"])); conn.execute("UPDATE runs SET status='running'"); conn.commit(); conn.close()
        self.cfg["page_size"] = 20
        with self.assertRaises(mfds.Abort) as ctx:                         # 페이지 크기가 다르면 섞지 않는다
            self._run(FakeServer(total=35, page_size=20))
        self.assertEqual(ctx.exception.kind, "page_size")
        rid = self._run(FakeServer(total=35, page_size=20), new_run=True)  # 새 실행은 별도 run_id
        conn = sqlite3.connect(str(self.cfg["db_path"]))
        self.assertEqual(conn.execute("SELECT COUNT(DISTINCT run_id) FROM runs").fetchone()[0], 2)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM records WHERE run_id=?", (rid,)).fetchone()[0], 35)

    def test_requested_page_size_not_honored_aborts(self):
        def srv(session, params, timeout):
            return 200, body(1, 10, 100, [rec(i) for i in range(1, 6)])   # 10 요청, 5 응답
        with self.assertRaises(mfds.Abort) as ctx:
            self._run(srv)
        self.assertEqual(ctx.exception.kind, "page_size")

    def test_auth_error_no_retry_and_nothing_saved(self):
        srv = FakeServer(total=30, page_size=10, fail={1: (200, json.dumps({"header": {"resultCode": "30", "resultMsg": "key"}, "body": {}}))})
        with self.assertRaises(mfds.Abort) as ctx:
            self._run(srv)
        self.assertEqual(ctx.exception.kind, "auth")
        self.assertEqual(len(srv.calls), 1)                                # 인증 오류는 반복 요청하지 않음
        conn = sqlite3.connect(str(self.cfg["db_path"]))
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM records").fetchone()[0], 0)

    def test_rate_limit_stops_and_keeps_pages(self):
        srv = FakeServer(total=50, page_size=10, fail={3: (429, "")})
        with self.assertRaises(mfds.Abort) as ctx:
            self._run(srv)
        self.assertEqual(ctx.exception.kind, "limit")
        self.assertEqual([c[0] for c in srv.calls], [1, 2, 3])
        conn = sqlite3.connect(str(self.cfg["db_path"])); conn.row_factory = sqlite3.Row
        run = conn.execute("SELECT * FROM runs").fetchone()
        self.assertEqual(run["status"], "aborted"); self.assertEqual(run["pages_done"], 2)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM records").fetchone()[0], 20)   # 완료한 페이지는 보존

    def test_transient_retry_limited(self):
        calls = {"n": 0}
        def srv(session, params, timeout):
            calls["n"] += 1
            raise mfds.Transient("timeout")
        with mock.patch.object(mfds.time, "sleep", lambda s: None):
            with self.assertRaises(mfds.Abort) as ctx:
                self._run(srv)
        self.assertEqual(ctx.exception.kind, "http")
        self.assertEqual(calls["n"], self.cfg["retries"] + 1)

    def test_repeated_page_and_early_empty_abort(self):
        same = [rec(i) for i in range(1, 11)]
        def srv_rep(session, params, timeout):
            return 200, body(int(params["pageNo"]), 10, 30, same)          # 모든 쪽이 같은 내용
        with self.assertRaises(mfds.Abort) as ctx:
            self._run(srv_rep)
        self.assertEqual(ctx.exception.kind, "integrity")
        self.cfg["db_path"] = Path(self.tmp) / "t2.sqlite"
        def srv_empty(session, params, timeout):
            p = int(params["pageNo"])
            return 200, body(p, 10, 30, [rec(i) for i in range(1, 11)] if p == 1 else [])
        with self.assertRaises(mfds.Abort) as ctx2:
            self._run(srv_empty)
        self.assertEqual(ctx2.exception.kind, "integrity")

    def test_analyze_duplicates_and_find(self):
        items = [rec(1), rec(1), rec(2, country="미국", rtype="금지", limit=None)]
        def srv(session, params, timeout):
            return 200, body(1, 10, 3, items)
        rid = self._run(srv)
        out = mfds.analyze(self.cfg, rid)
        self.assertEqual(out["dup_groups"], 1); self.assertEqual(out["dup_same_page_groups"], 1)
        self.assertEqual(out["prohibited_without_limit"], 1)
        self.assertEqual([r["COUNTRY_NAME"] for r in out["by_country"]], ["EU", "미국"])
        self.assertEqual(mfds._split_cas("137-17-7, 68-26-8 / 11103-57-4"), ["137-17-7", "68-26-8", "11103-57-4"])
        self.assertEqual(mfds._split_cas("2,4,5-TMA6"), [])               # 이명 속 쉼표는 CAS 가 아니다


if __name__ == "__main__":
    unittest.main()

"""식약처 수집 DB 조회 모듈·Route 테스트 (담당자 B). 임시 DB(수집 스키마 재사용)와 실제 수집 DB(있을 때만)로 검증. 외부 API 호출 없음.

실행: python -m unittest discover -s src/02_regulatory/tests -p "test_mfds_lookup*.py" -v
"""

import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
REG_DIR = HERE.parent
BASE_DIR = REG_DIR.parent.parent

def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

mfds = _load("mfds_collect", REG_DIR / "mfds_use_restriction.py")
lk = _load("mfds_lookup", REG_DIR / "regulatory_mfds_lookup.py")

REAL_DB = BASE_DIR / "instance" / "regulatory" / "mfds_use_restriction.sqlite"


def rec(std, eng, country, rtype, limit=None, proviso=None, cas=None, syn=None, notice=None):
    return {"REGULATE_TYPE": rtype, "INGR_STD_NAME": std, "INGR_ENG_NAME": eng, "CAS_NO": cas, "INGR_SYNONYM": syn,
            "COUNTRY_NAME": country, "NOTICE_INGR_NAME": notice or eng, "PROVIS_ATRCL": proviso, "LIMIT_COND": limit}


FIXTURE = [
    rec("레티놀", "Retinol", "EU", "한도", "* 【Restrictions】\nProduct Type : (a) Body lotion\n* 【제한】\n제품 유형 : (a) 바디 로션", cas="11103-57-4\n68-26-8"),
    rec("레티놀", "Retinol", "캐나다", "한도", "* 【Restrictions】\nMax : 1.0%", cas="11103-57-4\n68-26-8"),
    rec("레티닐아세테이트", "Retinyl Acetate", "EU", "한도", "x", cas="127-47-9", syn="retinol acetate"),
    rec("페녹시에탄올", "Phenoxyethanol", "EU", "한도", "* 【Restrictions】\nMaximum concentration : 1.0%\n* 【제한】\n최대 농도 : 1.0%", cas="122-99-6"),
    rec("페녹시에탄올", "Phenoxyethanol", "중국", "한도", "* 【화장품 중 최대사용농도】 배합한도 : 1%", cas="122-99-6"),
    rec("페녹시에탄올", "Phenoxyethanol", "일본", "한도", "* 【100g당 최대 배합량】 : 1.0 g", cas="122-99-6"),
    rec("페녹시에탄올", "Phenoxyethanol", "아세안", "한도", "* 【Restrictions】\nMax : 1.0%", cas="122-99-6"),
    rec("2,4-다이아미노페녹시에탄올", "2,4-Diaminophenoxyethanol", "EU", "금지", None, cas="70643-19-5"),
    rec("가상금지물질", "Fictional Prohibited", "EU", "금지", None, proviso="단서 예시", cas="11-11-1"),
    rec("가상한도물질", "Fictional Limited", "EU", "한도", None, cas="22-22-2"),                        # 한도인데 제한사항 없음
    rec("복수조건물질", "Multi Condition", "EU", "한도", "* 【Restrictions】\n조건 A", cas="33-33-3"),
    rec("복수조건물질", "Multi Condition", "EU", "한도", "* 【Restrictions】\n조건 B", cas="33-33-3"),
    rec("동명물질", "Same Name A", "EU", "금지", None, cas="44-44-4"),                                  # 표준명 같고 영문명 다름 → 모호
    rec("동명물질", "Same Name B", "EU", "한도", "x", cas="55-55-5"),
    rec("유럽전용", "Europe Only", "유럽", "금지", None, cas="66-66-6"),                                 # 원본 '유럽' — EU 조회 범위 밖
]


def build_db(path, status="completed"):
    conn = mfds.open_db(path)
    with conn:
        conn.execute("INSERT INTO runs (started_at, status, source_url, source_page, page_size, total_count_first, total_count_last, pages_done, records_saved, calls_made, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                     ("2026-09-23T10:50:37+00:00", status, mfds.public_url(), mfds.SOURCE_PAGE, 100, len(FIXTURE), len(FIXTURE), 1, len(FIXTURE), 1, "2026-09-23T10:53:54+00:00"))
        rid = conn.execute("SELECT MAX(run_id) FROM runs").fetchone()[0]
        conn.executemany("INSERT INTO records (run_id, page_no, row_index, fetched_at, %s, raw_json) VALUES (?,?,?,?,%s,?)" % (", ".join(mfds.FIELDS), ",".join("?" * len(mfds.FIELDS))),
                         [(rid, 1, i, "2026-09-23T10:50:40+00:00") + tuple(r.get(f) for f in mfds.FIELDS) + (json.dumps(r, ensure_ascii=False),) for i, r in enumerate(FIXTURE)])
    conn.close()
    return rid


class LookupFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.db = Path(cls.tmp) / "fixture.sqlite"
        build_db(cls.db)

    def look(self, **kw):
        kw.setdefault("path", self.db)
        return lk.lookup(**kw)

    def test_retinol_eu_found_with_basis(self):
        r = self.look(kr_name="레티놀", inci_name="Retinol", cas="11103-57-4, 68-26-8", market="EU", api_code=5489)
        self.assertEqual(r["lookup_status"], "found")
        self.assertEqual(r["link_status"], "confirmed")
        self.assertEqual(r["link_basis"], ["CAS", "영문명", "표준명"])
        self.assertEqual(len(r["entries"]), 1)
        e = r["entries"][0]
        self.assertEqual(e["regulate_type"], "한도"); self.assertEqual(e["country"], "EU"); self.assertEqual(e["country_code"], "EU")
        self.assertIn("【Restrictions】", e["limit_condition"]); self.assertFalse(e["limit_missing"]); self.assertEqual(e["source_type"], "mfds")
        self.assertEqual(r["markets_listed"], ["EU", "캐나다"])
        self.assertEqual(r["ingredient"]["code"], 5489)                        # API 코드는 표시용으로만 전달
        self.assertEqual(r["collected_at"], "2026-09-23T10:53:54+00:00")
        self.assertIsNone(r["source_updated_at"])
        self.assertEqual(r["source_page"], lk.SOURCE_PAGE)
        # 관련 항목: 레티닐아세테이트(이명에 retinol) — 확정 규제와 분리
        self.assertTrue(any(x["std_name"] == "레티닐아세테이트" for x in r["related"]))
        self.assertTrue(all(x["std_name"] != "레티놀" for x in r["related"]))

    def test_phenoxyethanol_four_markets(self):
        for m, snippet in (("EU", "1.0%"), ("CN", "배합한도"), ("JP", "1.0 g"), ("ASEAN", "1.0%")):
            r = self.look(kr_name="페녹시에탄올", inci_name="Phenoxyethanol", cas="122-99-6", market=m)
            self.assertEqual(r["lookup_status"], "found", m)
            self.assertIn(snippet, r["entries"][0]["limit_condition"], m)
        r = self.look(kr_name="페녹시에탄올", inci_name="Phenoxyethanol", market="US")
        self.assertEqual(r["lookup_status"], "not_listed")                       # 미국 항목 없음 — 미등재 ≠ 허용
        self.assertIn("허용·안전·규제 없음을 뜻하지 않아요", r["result_note"])

    def test_not_listed_glycerin_niacinamide(self):
        for kr, en in (("글리세린", "Glycerin"), ("나이아신아마이드", "Niacinamide")):
            r = self.look(kr_name=kr, inci_name=en, market="EU")
            self.assertEqual(r["lookup_status"], "not_listed", kr)
            self.assertEqual(r["link_status"], "none")
            self.assertEqual(r["entries"], [])

    def test_case_and_whitespace_only_normalization(self):
        r = self.look(inci_name="  PHENOXYETHANOL ", market="EU")
        self.assertEqual(r["lookup_status"], "found")
        r2 = self.look(inci_name="2,4-Diaminophenoxyethanol", market="EU")   # 숫자·기호 유지
        self.assertEqual(r2["lookup_status"], "found")
        self.assertEqual(r2["entries"][0]["regulate_type"], "금지")
        self.assertIsNone(r2["entries"][0]["limit_condition"]); self.assertFalse(r2["entries"][0]["limit_missing"])   # 금지 + null ≠ 제한 없음

    def test_limited_without_limit_text_flagged(self):
        r = self.look(inci_name="Fictional Limited", market="EU")
        self.assertTrue(r["entries"][0]["limit_missing"])                        # 화면: '상세 제한사항 미제공'
        r2 = self.look(inci_name="Fictional Prohibited", market="EU")
        self.assertEqual(r2["entries"][0]["proviso"], "단서 예시")               # PROVIS_ATRCL 사용

    def test_multiple_condition_records_all_returned(self):
        r = self.look(inci_name="Multi Condition", market="EU")
        self.assertEqual(len(r["entries"]), 2)
        self.assertEqual({e["limit_condition"] for e in r["entries"]}, {"* 【Restrictions】\n조건 A", "* 【Restrictions】\n조건 B"})

    def test_ambiguous_identity_not_confirmed(self):
        r = self.look(kr_name="동명물질", market="EU")                           # 표준명 같고 영문명 둘 → 확인 필요
        self.assertEqual(r["lookup_status"], "link_required")
        self.assertEqual(len(r["link_candidates"]), 2)
        self.assertEqual(r["entries"], [])
        r2 = self.look(kr_name="레티놀", inci_name="Retinol", cas="99-99-9", market="EU")   # 이름 일치하지만 CAS 불일치 → 충돌
        self.assertEqual(r2["lookup_status"], "link_required")
        self.assertIn("겹치지 않아요", r2["link_conflict"])
        r3 = self.look(inci_name="No Such Name", cas="122-99-6", market="EU")            # CAS 만 일치 → 자동 확정 안 함
        self.assertEqual(r3["lookup_status"], "link_required")
        self.assertEqual(r3["link_candidates"][0]["std_name"], "페녹시에탄올")

    def test_substring_does_not_confirm(self):
        r = self.look(inci_name="Retinyl", market="EU")                          # 부분 문자열만 → 미등재 + 관련 항목
        self.assertEqual(r["lookup_status"], "not_listed")
        self.assertTrue(any("Retinyl Acetate" == x["eng_name"] for x in r["related"]))

    def test_eu_scope_excludes_europe_label(self):
        r = self.look(inci_name="Europe Only", market="EU")
        self.assertEqual(r["lookup_status"], "not_listed")                       # 원본 '유럽' 은 EU 조회 범위 밖 (합치지 않음)
        self.assertEqual(r["country"]["country_names"], ["EU"])
        self.assertEqual(lk.MARKET_TO_COUNTRY["EU"], ["EU"])

    def test_db_states(self):
        with self.assertRaises(lk.MfdsLookupError) as ctx:
            lk.lookup(inci_name="Retinol", market="EU", path=Path(self.tmp) / "nope.sqlite")
        self.assertEqual(ctx.exception.kind, "db_missing")
        self.assertFalse((Path(self.tmp) / "nope.sqlite").exists())            # 빈 DB 를 만들지 않는다
        inc = Path(self.tmp) / "incomplete.sqlite"; build_db(inc, status="running")
        with self.assertRaises(lk.MfdsLookupError) as ctx2:
            lk.lookup(inci_name="Retinol", market="EU", path=inc)
        self.assertEqual(ctx2.exception.kind, "db_incomplete")
        bad = Path(self.tmp) / "bad.sqlite"; bad.write_bytes(b"this is not a sqlite database at all")
        with self.assertRaises(lk.MfdsLookupError) as ctx3:
            lk.lookup(inci_name="Retinol", market="EU", path=bad)
        self.assertEqual(ctx3.exception.kind, "db_error")
        with self.assertRaises(lk.MfdsLookupError) as ctx4:
            lk.lookup(inci_name="Retinol", market="TW", path=self.db)
        self.assertEqual(ctx4.exception.kind, "validation")


class RouteSourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(); cls.db = Path(cls.tmp) / "fixture.sqlite"; build_db(cls.db)
        os.environ["MFDS_DB_PATH"] = str(cls.db)
        sys.path.insert(0, str(BASE_DIR))
        import app as flask_app
        cls.app = flask_app
        flask_app.app.config["TESTING"] = True

    def client(self):
        c = self.app.app.test_client()
        with c.session_transaction() as s:
            s["user"] = {"id": 0, "email": "t@example.invalid", "name": "t", "team": "B"}
        return c

    def test_default_source_is_mfds_and_no_api_call(self):
        svc = self.app.regulatory_service
        with mock.patch.object(svc, "_get") as get:
            res = self.client().get("/api/regulatory/regulations?code=5489&country=EU&kr_name=%EB%A0%88%ED%8B%B0%EB%86%80&inci_name=Retinol&cas=11103-57-4")
            get.assert_not_called()
        body = res.get_json()
        self.assertEqual(res.status_code, 200); self.assertEqual(body["source"], "mfds"); self.assertEqual(body["lookup_status"], "found")
        self.assertNotIn("MFDS_API_KEY", res.get_data(as_text=True))

    def test_api_source_keeps_old_behaviour_no_fallback(self):
        svc = self.app.regulatory_service
        with mock.patch.object(svc, "_get", return_value=json.load(open(REG_DIR / "test_data" / "regulations_5489_EU.json", encoding="utf-8"))["body"]) as get:
            res = self.client().get("/api/regulatory/regulations?code=5489&country=EU&source=api")
            get.assert_called_once_with("/v1/ingredient/5489/regulations", {"country": "EU"})
        self.assertEqual(res.get_json()["source"], "api")
        # api 실패 시 mfds 로 바꾸지 않는다
        with mock.patch.object(svc, "_get", side_effect=svc.RegulatoryApiError("http", "boom", 500)):
            res2 = self.client().get("/api/regulatory/regulations?code=5489&country=EU&source=api")
        self.assertEqual(res2.status_code, 502); self.assertEqual(res2.get_json()["error"]["kind"], "http")

    def test_mfds_db_missing_is_503_not_not_listed(self):
        with mock.patch.dict(os.environ, {"MFDS_DB_PATH": str(Path(self.tmp) / "missing.sqlite")}):
            res = self.client().get("/api/regulatory/regulations?code=1&country=EU&inci_name=Retinol")
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.get_json()["error"]["kind"], "db_missing")

    def test_mfds_requires_name(self):
        res = self.client().get("/api/regulatory/regulations?code=5489&country=EU")
        self.assertEqual(res.status_code, 400)

    def test_page_has_source_radio_cards(self):
        """출처 선택은 radio 카드 2개(직접 검색·파일 탭 각각), 기본 checked 는 mfds. 드롭다운(select) 아님"""
        html = self.client().get("/regulatory").get_data(as_text=True)
        for p in ("search", "file"):
            self.assertIn('<fieldset class="form-group regulatory-source" id="regulatory-%s-source"' % p, html)
            self.assertRegex(html, r'<input type="radio" id="regulatory-%s-source-mfds" name="regulatory-%s-source" value="mfds" checked>' % (p, p))
            self.assertRegex(html, r'<input type="radio" id="regulatory-%s-source-api" name="regulatory-%s-source" value="api">' % (p, p))
            self.assertIn('for="regulatory-%s-source-mfds"' % p, html); self.assertIn('for="regulatory-%s-source-api"' % p, html)
        self.assertNotRegex(html, r'<select[^>]*id="regulatory-(search|file)-source"')
        self.assertIn("K뷰티 API (RapidAPI)", html); self.assertNotIn("기존 API", html)
        self.assertEqual(html.count('value="mfds" checked'), 2); self.assertEqual(html.count('value="api" checked'), 0)


@unittest.skipUnless(REAL_DB.is_file(), "수집 DB 가 있을 때만")
class RealDbTest(unittest.TestCase):
    def test_real_records(self):
        r = lk.lookup(kr_name="레티놀", inci_name="Retinol", cas="11103-57-4, 68-26-8", market="EU", path=REAL_DB)
        self.assertEqual(r["lookup_status"], "found"); self.assertEqual(r["entries"][0]["regulate_type"], "한도")
        for m in ("EU", "CN", "JP", "ASEAN"):
            self.assertEqual(lk.lookup(kr_name="페녹시에탄올", inci_name="Phenoxyethanol", cas="122-99-6", market=m, path=REAL_DB)["lookup_status"], "found", m)
        for kr, en in (("글리세린", "Glycerin"), ("나이아신아마이드", "Niacinamide")):
            self.assertEqual(lk.lookup(kr_name=kr, inci_name=en, market="EU", path=REAL_DB)["lookup_status"], "not_listed", kr)
        self.assertEqual(lk.lookup(kr_name="레티놀", inci_name="Retinol", market="US", path=REAL_DB)["lookup_status"], "not_listed")

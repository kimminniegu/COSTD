"""국가별 인허가 규제 — 처리 로직·Route 테스트 (담당자 B).

실행 (프로젝트 루트 COSTD/ 에서):
    python -m unittest discover -s src/02_regulatory/tests -v

- 외부 API를 호출하지 않는다. test_data/ 의 실제 응답 기록과 가상 응답으로 검증한다.
- RAPIDAPI_KEY / RAPIDAPI_HOST 값이 응답·오류 메시지에 섞이지 않는지도 확인한다.
"""

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
REG_DIR = HERE.parent
BASE_DIR = REG_DIR.parent.parent
TEST_DATA = REG_DIR / "test_data"

sys.path.insert(0, str(BASE_DIR))
import app as flask_app  # noqa: E402  (app.py 가 regulatory_service 를 로드한다)

svc = flask_app.regulatory_service

FAKE_ENV = {"RAPIDAPI_KEY": "test-key-not-real-0000000000", "RAPIDAPI_HOST": "example.invalid"}


def load_body(name):
    with open(TEST_DATA / name, encoding="utf-8") as f:
        return json.load(f)["body"]


def _login(client):
    """PM 로그인 기능(src/common/auth.py) 추가 후 페이지 Route 가 @login_required 라서 테스트 세션에 사용자를 넣는다. (DB·비밀번호 불필요)"""
    with client.session_transaction() as sess:
        sess["user"] = {"id": 0, "email": "test@example.invalid", "name": "테스트", "team": "B"}


class FakeResponse:
    def __init__(self, status_code=200, body=None, text=""):
        self.status_code = status_code
        self._body = body
        self.text = text

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


# ---------------------------------------------------------------------------
# 검색 응답 정규화
# ---------------------------------------------------------------------------

class SearchNormalizeTest(unittest.TestCase):
    def test_retinol_record_is_normalized(self):
        result = svc.normalize_search_response(load_body("search_kr_retinol.json"), " 레티놀 ")
        self.assertEqual(result["query"], "레티놀")
        self.assertEqual(result["total"], 1)
        c = result["candidates"][0]
        self.assertEqual(c["code"], 5489)
        self.assertEqual(c["kr_name"], "레티놀")
        self.assertEqual(c["inci_name"], "Retinol")
        self.assertEqual(c["match_rank"], 0)
        self.assertFalse(result["truncated"])

    def test_ranking_exact_prefix_contains_and_dedupe_max10(self):
        data = [
            {"code": 1, "kr_name": "에탄올아민", "inci_name": "Ethanolamine"},
            {"code": 2, "kr_name": "변성에탄올", "inci_name": "Alcohol Denat."},
            {"code": 3, "kr_name": "에탄올", "inci_name": "Alcohol"},
            {"code": 3, "kr_name": "에탄올", "inci_name": "Alcohol"},   # 중복 code
            {"code": 4, "kr_name": "", "inci_name": "Ethanol"},          # 한글명 없음
        ] + [{"code": 100 + i, "kr_name": "무수에탄올%d" % i, "inci_name": ""} for i in range(12)]   # 포함 일치 12건
        result = svc.normalize_search_response({"success": True, "data": data}, "에탄올")
        codes = [c["code"] for c in result["candidates"]]
        self.assertEqual(codes[0], 3)                       # 정확 일치 우선
        self.assertEqual(codes[1], 1)                       # 시작 일치
        self.assertEqual(codes[2], 2)                       # 포함 일치는 API 순서 유지
        self.assertEqual(len(codes), 10)
        self.assertEqual(len(set(codes)), 10)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["total"], 16)
        kr_none = [c for c in result["candidates"] if c["code"] == 4]
        if kr_none:
            self.assertIsNone(kr_none[0]["kr_name"])        # 한글명을 만들어내지 않음

    def test_english_case_insensitive_rank(self):
        body = {"success": True, "data": [{"code": 9, "kr_name": "레티놀", "inci_name": "Retinol"}]}
        result = svc.normalize_search_response(body, "  RETINOL ")
        self.assertEqual(result["candidates"][0]["match_rank"], 0)

    def test_invalid_shape_raises_api_error(self):
        with self.assertRaises(svc.RegulatoryApiError) as ctx:
            svc.normalize_search_response({"success": False}, "레티놀")
        self.assertEqual(ctx.exception.kind, "invalid_response")


# ---------------------------------------------------------------------------
# 규제 조회 응답 정규화
# ---------------------------------------------------------------------------

class RegulationNormalizeTest(unittest.TestCase):
    def test_eu_listed_keeps_limit_condition_raw(self):
        body = load_body("regulations_5489_EU.json")
        result = svc.normalize_regulation_response(body, 5489, "EU")
        self.assertEqual(result["lookup_status"], "found")
        self.assertEqual(result["result_status"], "listed")
        self.assertEqual(len(result["entries"]), 1)
        self.assertEqual(result["entries"][0]["limit_condition"], body["data"][0]["limit_condition"])
        self.assertIn("0,3 % RE", result["entries"][0]["limit_condition"])
        self.assertEqual(result["country"]["code"], "EU")
        self.assertTrue(result["data_source"].startswith("Ministry of Food and Drug Safety"))
        self.assertIsNone(result["source_updated_at"])       # 규제 자료 갱신일 미제공
        self.assertTrue(result["queried_at"])

    def test_us_not_listed_is_no_data_not_error(self):
        body = load_body("regulations_5489_US.json")
        result = svc.normalize_regulation_response(body, 5489, "US")
        self.assertEqual(result["lookup_status"], "no_data")
        self.assertEqual(result["result_status"], "not_listed_in_country")
        self.assertEqual(result["entries"], [])
        self.assertIn("No entry for US", result["result_note"])

    def test_unknown_result_status_is_hold(self):
        body = load_body("regulations_5489_EU.json")
        body = dict(body, result_status="something_new")
        self.assertEqual(svc.normalize_regulation_response(body, 5489, "EU")["lookup_status"], "hold")

    def test_listed_but_empty_data_is_hold(self):
        body = dict(load_body("regulations_5489_EU.json"), data=[])
        self.assertEqual(svc.normalize_regulation_response(body, 5489, "EU")["lookup_status"], "hold")

    def test_ingredient_regulation_status_not_used(self):
        body = load_body("regulations_5489_US.json")
        self.assertEqual(body["ingredient"]["regulation_status"], "Restricted")
        result = svc.normalize_regulation_response(body, 5489, "US")
        self.assertEqual(result["lookup_status"], "no_data")
        self.assertNotIn("regulation_status", result["ingredient"])

    def test_success_false_raises(self):
        with self.assertRaises(svc.RegulatoryApiError):
            svc.normalize_regulation_response({"success": False, "data": []}, 5489, "EU")


# ---------------------------------------------------------------------------
# 호출·오류 분류 (requests.get 을 가짜로 대체)
# ---------------------------------------------------------------------------

class HttpErrorClassificationTest(unittest.TestCase):
    def call(self, **kwargs):
        with mock.patch.dict(os.environ, FAKE_ENV), mock.patch.object(svc.requests, "get", **kwargs):
            return svc.search_ingredients_kr("레티놀")

    def assert_error(self, kind, **kwargs):
        with self.assertRaises(svc.RegulatoryApiError) as ctx:
            self.call(**kwargs)
        self.assertEqual(ctx.exception.kind, kind)
        self.assertNotIn(FAKE_ENV["RAPIDAPI_KEY"], ctx.exception.message)
        return ctx.exception

    def test_missing_config(self):
        with mock.patch.dict(os.environ, {"RAPIDAPI_KEY": "", "RAPIDAPI_HOST": ""}):
            with mock.patch.object(svc.requests, "get") as get:
                with self.assertRaises(svc.RegulatoryApiError) as ctx:
                    svc.search_ingredients_kr("레티놀")
                get.assert_not_called()                      # 미설정이면 외부 호출 없음
        self.assertEqual(ctx.exception.kind, "config")

    def test_timeout(self):
        self.assert_error("timeout", side_effect=svc.requests.exceptions.Timeout())

    def test_connection(self):
        self.assert_error("connection", side_effect=svc.requests.exceptions.ConnectionError("x-rapidapi-key leaked?"))

    def test_auth_401_and_access_403(self):
        self.assert_error("auth", return_value=FakeResponse(401, {"message": "bad key"}))
        # 403 은 RapidAPI 가 미구독·요금제 밖 엔드포인트에도 쓰므로 '접근 제한(access)' 으로 구분한다
        self.assert_error("access", return_value=FakeResponse(403, {"message": "You are not subscribed to this API."}))

    def test_rate_limit_429(self):
        self.assert_error("rate_limit", return_value=FakeResponse(429, {"message": "Too many"}))

    def test_http_500(self):
        exc = self.assert_error("http", return_value=FakeResponse(500, None, "oops"))
        self.assertEqual(exc.http_status, 500)

    def test_non_json(self):
        self.assert_error("invalid_response", return_value=FakeResponse(200, None, "<html>"))

    def test_headers_sent_but_not_returned(self):
        with mock.patch.dict(os.environ, FAKE_ENV), mock.patch.object(svc.requests, "get") as get:
            get.return_value = FakeResponse(200, load_body("search_kr_retinol.json"))
            result = svc.search_ingredients_kr("레티놀")
            headers = get.call_args.kwargs["headers"]
            self.assertEqual(headers["x-rapidapi-key"], FAKE_ENV["RAPIDAPI_KEY"])
            self.assertEqual(get.call_args.kwargs["params"], {"q": "레티놀"})
        self.assertNotIn(FAKE_ENV["RAPIDAPI_KEY"], json.dumps(result, ensure_ascii=False))

    def test_get_regulations_validates_inputs(self):
        with self.assertRaises(ValueError):
            svc.get_regulations(5489, "XX")
        with self.assertRaises(ValueError):
            svc.get_regulations("abc", "EU")


# ---------------------------------------------------------------------------
# Flask Route (/api/regulatory/...)
# ---------------------------------------------------------------------------

class RouteTest(unittest.TestCase):
    def setUp(self):
        flask_app.app.config["TESTING"] = True
        self.client = flask_app.app.test_client()
        _login(self.client)

    def test_page_and_assets_load(self):
        for path in ("/regulatory", "/assets/02_regulatory/regulatory.css", "/assets/02_regulatory/regulatory.js"):
            res = self.client.get(path)
            self.assertEqual(res.status_code, 200, path)
            res.close()
        html = self.client.get("/regulatory").get_data(as_text=True)
        for marker in ("regulatory-search-form", "regulatory-autocomplete-options", "regulatory-search-selected",
                       'data-detail="lookup-raw"', "regulatory-result-body"):
            self.assertIn(marker, html, marker)
        self.assertNotIn("RAPIDAPI", html)

    def test_service_file_not_served_as_asset(self):
        self.assertEqual(self.client.get("/assets/02_regulatory/regulatory_service.py").status_code, 404)

    def test_ingredients_requires_q(self):
        res = self.client.get("/api/regulatory/ingredients?q=%20%20")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"]["kind"], "validation")

    def test_ingredients_ok(self):
        with mock.patch.object(svc, "_get", return_value=load_body("search_kr_retinol.json")) as get:
            res = self.client.get("/api/regulatory/ingredients?q=%20레티놀%20")
            get.assert_called_once_with("/v1/ingredient/kr", {"q": "레티놀"})
        body = res.get_json()
        self.assertEqual(res.status_code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["candidates"][0]["code"], 5489)

    def test_regulations_validation(self):
        self.assertEqual(self.client.get("/api/regulatory/regulations?code=&country=EU").status_code, 400)
        self.assertEqual(self.client.get("/api/regulatory/regulations?code=5489&country=XX").status_code, 400)
        self.assertEqual(self.client.get("/api/regulatory/regulations?code=5489").status_code, 400)

    def test_regulations_eu_found(self):
        with mock.patch.object(svc, "_get", return_value=load_body("regulations_5489_EU.json")) as get:
            res = self.client.get("/api/regulatory/regulations?code=5489&country=eu")
            get.assert_called_once_with("/v1/ingredient/5489/regulations", {"country": "EU"})
        body = res.get_json()
        self.assertEqual(res.status_code, 200)
        self.assertEqual(body["lookup_status"], "found")
        self.assertIn("【Restrictions】", body["entries"][0]["limit_condition"])

    def test_regulations_us_no_data(self):
        with mock.patch.object(svc, "_get", return_value=load_body("regulations_5489_US.json")):
            res = self.client.get("/api/regulatory/regulations?code=5489&country=US")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()["lookup_status"], "no_data")

    def test_config_error_is_503_without_key(self):
        with mock.patch.dict(os.environ, {"RAPIDAPI_KEY": "", "RAPIDAPI_HOST": ""}):
            res = self.client.get("/api/regulatory/ingredients?q=레티놀")
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.get_json()["error"]["kind"], "config")

    def test_api_error_is_502(self):
        err = svc.RegulatoryApiError("timeout", "규제 API 응답이 지연되고 있어요.")
        with mock.patch.object(svc, "_get", side_effect=err):
            res = self.client.get("/api/regulatory/regulations?code=5489&country=EU")
        self.assertEqual(res.status_code, 502)
        self.assertEqual(res.get_json()["error"]["kind"], "timeout")


if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------------------
# 4단계: 한글·영문 INCI 검색 / 자동완성용 후보 검색 (실제 호출 기록 test_data/ 로 검증, 외부 호출 없음)
# ---------------------------------------------------------------------------

class BilingualSearchTest(unittest.TestCase):
    def test_detect_search_field(self):
        self.assertEqual(svc.detect_search_field("레티"), "kr")
        self.assertEqual(svc.detect_search_field("ㄹㅔ"), "kr")          # 자모만 있어도 한글
        self.assertEqual(svc.detect_search_field("Retin"), "inci")
        self.assertEqual(svc.detect_search_field("peg-16"), "inci")
        self.assertEqual(svc.detect_search_field("레티 Retinol"), "kr")  # 혼합 입력은 한글 우선

    def test_korean_partial_uses_kr_endpoint_and_ranks_prefix(self):
        with mock.patch.object(svc, "_get", return_value=load_body("search_kr_partial_reti.json")) as get:
            result = svc.search_ingredients(" 레티 ")
            get.assert_called_once_with("/v1/ingredient/kr", {"q": "레티"})
        self.assertEqual(result["search_field"], "kr")
        self.assertEqual(result["match_mode"], "starts_with")
        self.assertEqual(result["total"], 15)
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["candidates"]), 10)
        self.assertEqual(len({c["code"] for c in result["candidates"]}), 10)   # code 기준 중복 없음
        self.assertTrue(all(c["match_rank"] == 1 for c in result["candidates"]))  # 모두 시작 일치

    def test_korean_partial_etan_exact_first(self):
        # 명세 예시: '에탄' → 등록된 '에탄올' 후보. 정확 일치 '에탄'(code 6203)이 맨 앞
        with mock.patch.object(svc, "_get", return_value=load_body("search_kr_partial_etan.json")):
            result = svc.search_ingredients("에탄")
        codes = [c["code"] for c in result["candidates"]]
        self.assertEqual(codes[0], 6203)
        self.assertIn(2093, codes)                                    # 에탄올
        self.assertEqual(result["candidates"][0]["match_rank"], 0)

    def test_english_uses_inci_endpoint_case_insensitive(self):
        with mock.patch.object(svc, "_get", return_value=load_body("search_inci_partial_retin.json")) as get:
            result = svc.search_ingredients("  retin ")
            get.assert_called_once_with("/v1/ingredient/inci", {"q": "retin"})
        self.assertEqual(result["search_field"], "inci")
        self.assertEqual(result["total"], 17)
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["candidates"]), 10)
        for c in result["candidates"]:
            self.assertTrue(c["inci_name"].lower().startswith("retin"), c["inci_name"])
        self.assertTrue(all(c["kr_name"] for c in result["candidates"]))  # 응답의 한글명 그대로 (생성 아님)

    def test_english_on_kr_endpoint_returns_nothing(self):
        # 라우팅 근거: 한글 엔드포인트에 영문을 넣으면 0건 (실제 기록)
        body = load_body("search_kr_english_retinol.json")
        self.assertTrue(body["success"])
        self.assertEqual(body["data"], [])

    def test_min_length(self):
        with self.assertRaises(ValueError):
            svc.search_ingredients("레")
        with mock.patch.object(svc, "_get") as get:
            with self.assertRaises(ValueError):
                svc.search_ingredients("  a ")
            get.assert_not_called()

    def test_legacy_kr_helper_still_works(self):
        with mock.patch.object(svc, "_get", return_value=load_body("search_kr_retinol.json")) as get:
            result = svc.search_ingredients_kr("레티놀")
            get.assert_called_once_with("/v1/ingredient/kr", {"q": "레티놀"})
        self.assertEqual(result["search_field"], "kr")


class BilingualRouteTest(unittest.TestCase):
    def setUp(self):
        flask_app.app.config["TESTING"] = True
        self.client = flask_app.app.test_client()
        _login(self.client)

    def test_route_rejects_single_char_without_external_call(self):
        with mock.patch.object(svc, "_get") as get:
            res = self.client.get("/api/regulatory/ingredients?q=%EB%A0%88")   # '레'
            get.assert_not_called()
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"]["kind"], "validation")
        self.assertNotIn("RAPIDAPI", res.get_data(as_text=True))

    def test_route_english_query(self):
        with mock.patch.object(svc, "_get", return_value=load_body("search_inci_partial_retin.json")) as get:
            res = self.client.get("/api/regulatory/ingredients?q=Retin")
            get.assert_called_once_with("/v1/ingredient/inci", {"q": "Retin"})
        body = res.get_json()
        self.assertEqual(res.status_code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["search_field"], "inci")
        self.assertLessEqual(len(body["candidates"]), 10)
        self.assertNotIn("x-rapidapi", res.get_data(as_text=True).lower())

    def test_route_korean_query_single_call(self):
        with mock.patch.object(svc, "_get", return_value=load_body("search_kr_partial_reti.json")) as get:
            res = self.client.get("/api/regulatory/ingredients?q=%EB%A0%88%ED%8B%B0")   # '레티'
            self.assertEqual(get.call_count, 1)
        self.assertEqual(res.get_json()["search_field"], "kr")

    def test_page_copy_mentions_bilingual_autocomplete(self):
        html = self.client.get("/regulatory").get_data(as_text=True)
        self.assertIn("영문 INCI", html)
        self.assertNotIn("<<<<<<<", html)


# ---------------------------------------------------------------------------
# 5단계: 파일 업로드 → 성분 추출 (텍스트 PDF · .xlsx). 외부 호출 없음. 규제 API 호출 없음.
# ---------------------------------------------------------------------------

import io as _io
import tempfile as _tempfile
import glob as _glob

rx = flask_app.regulatory_extract
SAMPLES = REG_DIR / "samples"


def _xlsx_bytes(sheets):
    """{시트명: [행, ...]} → .xlsx 바이트 (테스트 전용, 파일로 남기지 않음)"""
    from openpyxl import Workbook
    wb = Workbook()
    first = True
    for name, rows in sheets.items():
        ws = wb.active if first else wb.create_sheet()
        ws.title = name
        first = False
        for r in rows:
            ws.append(r)
    buf = _io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _pdf_blank_bytes(encrypt=None):
    from pypdf import PdfWriter
    w = PdfWriter()
    w.add_blank_page(width=200, height=200)
    if encrypt:
        w.encrypt(encrypt)
    buf = _io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def _temp_leftovers():
    return _glob.glob(os.path.join(_tempfile.gettempdir(), "cosmoa-reg-*"))


class ExtractPdfTest(unittest.TestCase):
    def test_sample_brief_extracts_only_ingredient_table(self):
        with open(SAMPLES / "EU-SER-041_development_brief.pdf", "rb") as f:
            r = rx.extract_upload("brief.pdf", f)
        self.assertEqual(r["status"], "extracted")
        names = [it["name_raw"] for it in r["items"]]
        self.assertEqual(names, ["Niacinamide", "Glycerin", "Panthenol", "Sodium Hyaluronate",
                                 "Phenoxyethanol", "Ethylhexylglycerin", "Aqua"])
        amounts = [it["amount_raw"] for it in r["items"]]
        self.assertEqual(amounts, ["4.0%", "5.0%", "0.5%", "0.10%", "0.80%", "0.30%", "q.s. to 100%"])
        self.assertTrue(all(it["location"] == "2쪽" for it in r["items"]))
        self.assertEqual(r["review_count"], 0)
        # 설명 문장·절 제목·헤더 줄이 성분으로 들어오지 않는다
        for bad in ("INCI name", "Application", "Directions for use", "Partial development brief", "DO NOT USE", "Buyer / contact"):
            self.assertNotIn(bad, names)
        self.assertNotIn("Partial development brief", " ".join(names))
        # 문서 국가·사용 조건은 원문 그대로, 시장 코드로 바꾸지 않음
        self.assertEqual(r["document_market"]["text"], "European Union: France and Germany")
        self.assertTrue(r["document_use"]["text"].startswith("Leave-on"))
        self.assertNotIn("market_code", r)
        self.assertEqual(r["file"]["kind"], "pdf")
        self.assertEqual(_temp_leftovers(), [])

    def test_scanned_like_pdf_is_unsupported_not_success(self):
        with self.assertRaises(rx.ExtractError) as ctx:
            rx.extract_upload("scan.pdf", _io.BytesIO(_pdf_blank_bytes()))
        self.assertEqual(ctx.exception.kind, "unsupported")
        self.assertEqual(ctx.exception.http_status, 415)
        self.assertIn("텍스트 PDF와 Excel", ctx.exception.message)
        self.assertEqual(_temp_leftovers(), [])

    def test_encrypted_pdf_is_unreadable(self):
        with self.assertRaises(rx.ExtractError) as ctx:
            rx.extract_upload("locked.pdf", _io.BytesIO(_pdf_blank_bytes(encrypt="secret")))
        self.assertEqual(ctx.exception.kind, "unreadable")
        self.assertEqual(_temp_leftovers(), [])

    def test_wrong_content_for_extension(self):
        with self.assertRaises(rx.ExtractError) as ctx:
            rx.extract_upload("fake.pdf", _io.BytesIO(b"this is not a pdf at all, just text"))
        self.assertEqual(ctx.exception.kind, "unreadable")
        with self.assertRaises(rx.ExtractError) as ctx2:
            rx.extract_upload("fake.xlsx", _io.BytesIO(b"%PDF-1.4 pretending"))
        self.assertEqual(ctx2.exception.kind, "unreadable")
        self.assertEqual(_temp_leftovers(), [])

    def test_page_limit(self):
        from pypdf import PdfWriter
        w = PdfWriter()
        for _ in range(rx.MAX_PDF_PAGES + 1):
            w.add_blank_page(width=100, height=100)
        buf = _io.BytesIO(); w.write(buf)
        with self.assertRaises(rx.ExtractError) as ctx:
            rx.extract_upload("big.pdf", _io.BytesIO(buf.getvalue()))
        self.assertEqual(ctx.exception.kind, "limit")


class ExtractXlsxTest(unittest.TestCase):
    def test_single_sheet_korean_header_amount_and_review_flags(self):
        data = _xlsx_bytes({"요청성분": [
            ["가상 성분표 (데모)"],
            ["대상 국가", "미국"],
            ["No", "성분명", "함량(%)", "비고"],
            [1, "나이아신아마이드", 4, "필수"],
            [2, "판테놀", "0.5", "선택"],
            [3, "정제수", "q.s.", "잔량"],
            [4, "이 성분은 바이어가 나중에 확정할 예정이며 현재는 미정입니다.", None, "메모"],
            [5, "향료", "미정", None],
            [6, None, None, "빈 행은 건너뜀"],
        ]})
        r = rx.extract_upload("demo.xlsx", _io.BytesIO(data))
        self.assertEqual(r["status"], "extracted")
        self.assertEqual([it["name_raw"] for it in r["items"]],
                         ["나이아신아마이드", "판테놀", "정제수", "이 성분은 바이어가 나중에 확정할 예정이며 현재는 미정입니다.", "향료"])
        self.assertEqual([it["amount_raw"] for it in r["items"]], ["4", "0.5", "q.s.", None, "미정"])
        self.assertEqual(r["items"][0]["amount_unit_hint"], "%")          # 열 제목의 단위만 힌트로
        self.assertEqual(r["items"][0]["location"], "요청성분!B4")
        self.assertFalse(r["items"][0]["needs_review"])
        self.assertTrue(r["items"][3]["needs_review"])                     # 문장
        self.assertTrue(r["items"][4]["needs_review"])                     # 함량 형식
        self.assertIsNone(r["items"][3]["amount_raw"])                     # 미기재는 0 이 아님
        self.assertEqual(r["review_count"], 2)
        self.assertEqual(r["document_market"]["text"], "미국")
        self.assertEqual(_temp_leftovers(), [])

    def test_multi_sheet_requires_selection_then_extracts_selected(self):
        sheets = {
            "Cover": [["FICTIONAL"], ["This sheet only has descriptions. Ingredient table is on the next sheet."]],
            "Ingredients": [["INCI name", "Requested level", "Role"], ["Niacinamide", "4.0%", "Required"], ["Aqua", "q.s. to 100%", "Balance"]],
            "Packaging": [["Item", "Spec"], ["Bottle", "30 mL"]],
        }
        data = _xlsx_bytes(sheets)
        r = rx.extract_upload("multi.xlsx", _io.BytesIO(data))
        self.assertEqual(r["status"], "sheet_required")
        self.assertEqual(r["sheets"], ["Cover", "Ingredients", "Packaging"])
        self.assertEqual(r["items"], [])
        r2 = rx.extract_upload("multi.xlsx", _io.BytesIO(data), sheet="Ingredients")
        self.assertEqual(r2["status"], "extracted")
        self.assertEqual([it["name_raw"] for it in r2["items"]], ["Niacinamide", "Aqua"])
        self.assertEqual(r2["scope"]["selected_sheet"], "Ingredients")
        # 설명만 있는 시트: 문장 속 'Ingredient' 를 헤더로 오인하지 않고 '추출 결과 없음'
        r3 = rx.extract_upload("multi.xlsx", _io.BytesIO(data), sheet="Cover")
        self.assertEqual(r3["status"], "empty")
        self.assertEqual(r3["items"], [])
        self.assertTrue(any("찾지 못했" in n for n in r3["notes"]))
        # 표 제목이 성분 표가 아닌 시트도 결과 없음
        r4 = rx.extract_upload("multi.xlsx", _io.BytesIO(data), sheet="Packaging")
        self.assertEqual(r4["status"], "empty")
        with self.assertRaises(rx.ExtractError) as ctx:
            rx.extract_upload("multi.xlsx", _io.BytesIO(data), sheet="Nope")
        self.assertEqual(ctx.exception.kind, "validation")
        self.assertEqual(_temp_leftovers(), [])

    def test_name_only_table_needs_strict_header(self):
        # 함량 열이 없어도 제목이 정확히 'INCI' 류이면 표로 인정, 함량은 None
        data = _xlsx_bytes({"S": [["INCI name", "Note"], ["Glycerin", "humectant"], ["Aqua", "solvent"]]})
        r = rx.extract_upload("names.xlsx", _io.BytesIO(data))
        self.assertEqual([it["name_raw"] for it in r["items"]], ["Glycerin", "Aqua"])
        self.assertTrue(all(it["amount_raw"] is None for it in r["items"]))
        # 'ingredients' 가 문장 속에 있는 두 칸 행은 헤더가 아님
        data2 = _xlsx_bytes({"S": [["We list ingredients below for reference only.", "x"], ["Glycerin", "5%"]]})
        r2 = rx.extract_upload("prose.xlsx", _io.BytesIO(data2))
        self.assertEqual(r2["status"], "empty")

    def test_item_cap(self):
        rows = [["성분명", "함량"]] + [["성분%d" % i, "1%"] for i in range(rx.MAX_ITEMS + 5)]
        r = rx.extract_upload("many.xlsx", _io.BytesIO(_xlsx_bytes({"S": rows})))
        self.assertEqual(len(r["items"]), rx.MAX_ITEMS)
        self.assertTrue(any("앞 %d개" % rx.MAX_ITEMS in n for n in r["notes"]))


class ExtractRouteTest(unittest.TestCase):
    def setUp(self):
        flask_app.app.config["TESTING"] = True
        self.client = flask_app.app.test_client()
        _login(self.client)

    def _post(self, filename, data, sheet=None):
        form = {"file": (_io.BytesIO(data), filename)}
        if sheet:
            form["sheet"] = sheet
        return self.client.post("/api/regulatory/extract", data=form, content_type="multipart/form-data")

    def test_no_file(self):
        res = self.client.post("/api/regulatory/extract", data={}, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"]["kind"], "validation")

    def test_image_is_415_with_guidance(self):
        res = self._post("photo.png", b"\x89PNG\r\n\x1a\n" + b"0" * 100)
        self.assertEqual(res.status_code, 415)
        body = res.get_json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["kind"], "unsupported")
        self.assertIn("텍스트 PDF와 Excel", body["error"]["message"])

    def test_pdf_route_ok_and_no_regulation_api_call(self):
        with open(SAMPLES / "EU-SER-041_development_brief.pdf", "rb") as f:
            data = f.read()
        with mock.patch.object(svc, "_get") as get:
            res = self._post("brief.pdf", data)
            get.assert_not_called()
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["status"], "extracted")
        self.assertEqual(len(body["items"]), 7)
        self.assertNotIn("RAPIDAPI", res.get_data(as_text=True))
        self.assertEqual(_temp_leftovers(), [])

    def test_xlsx_route_sheet_flow(self):
        data = _xlsx_bytes({"A": [["x"]], "B": [["성분명", "함량"], ["글리세린", "5%"]]})
        res = self._post("two.xlsx", data)
        self.assertEqual(res.get_json()["status"], "sheet_required")
        res2 = self._post("two.xlsx", data, sheet="B")
        self.assertEqual(res2.get_json()["items"][0]["name_raw"], "글리세린")
        self.assertEqual(_temp_leftovers(), [])

    def test_too_large_is_400_limit(self):
        big = b"%PDF-1.4\n" + b"0" * (rx.MAX_FILE_BYTES + 1024)
        res = self._post("big.pdf", big)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"]["kind"], "limit")
        self.assertEqual(_temp_leftovers(), [])

    def test_page_has_file_tab_elements(self):
        html = self.client.get("/regulatory").get_data(as_text=True)
        for marker in ("regulatory-file-form", "regulatory-review-body", "regulatory-review-add", "regulatory-file-result-error", "regulatory-file-empty"):
            self.assertIn(marker, html, marker)


# ---------------------------------------------------------------------------
# 조회 상태 보완 (2026-09-23 진단): not_listed / 요금제 안내문 / 403 접근 제한 — 저장된 실제 응답으로 검증
# ---------------------------------------------------------------------------

class LookupStatusDiagnosisTest(unittest.TestCase):
    def test_not_listed_is_distinct_state(self):
        r = svc.normalize_regulation_response(load_body("regulations_1941_EU_not_listed.json"), 1941, "EU")
        self.assertEqual(r["lookup_status"], "not_listed")          # no_data 도 hold 도 아님
        self.assertEqual(r["result_status"], "not_listed")          # 원문 상태값 보존
        self.assertIn("No restriction or prohibition", r["result_note"])
        self.assertFalse(r["note_mentions_plan"])
        self.assertEqual(r["entries"], [])

    def test_plan_note_flag_only_no_interpretation(self):
        r = svc.normalize_regulation_response(load_body("regulations_1013_EU_plan_note.json"), 1013, "EU")
        self.assertEqual(r["lookup_status"], "no_data")
        self.assertTrue(r["note_mentions_plan"])                    # 문구 존재 여부만
        self.assertEqual(r["markets_outside_plan"], 1)              # 원문 값 그대로
        self.assertNotIn("plan_limited", r)                         # 요금제 제한 여부를 단정하는 필드는 없음
        r2 = svc.normalize_regulation_response(load_body("regulations_5489_US.json"), 5489, "US")
        self.assertEqual(r2["lookup_status"], "no_data")
        self.assertFalse(r2["note_mentions_plan"])

    def test_route_passes_status_fields(self):
        flask_app.app.config["TESTING"] = True
        client = flask_app.app.test_client(); _login(client)
        with mock.patch.object(svc, "_get", return_value=load_body("regulations_1941_EU_not_listed.json")) as get:
            res = client.get("/api/regulatory/regulations?code=1941&country=EU")
            get.assert_called_once_with("/v1/ingredient/1941/regulations", {"country": "EU"})
        body = res.get_json()
        self.assertEqual(body["lookup_status"], "not_listed")
        self.assertEqual(body["result_status"], "not_listed")
        self.assertIn("note_mentions_plan", body)

    def test_route_403_is_access_502(self):
        flask_app.app.config["TESTING"] = True
        client = flask_app.app.test_client(); _login(client)
        with mock.patch.dict(os.environ, FAKE_ENV), mock.patch.object(svc.requests, "get", return_value=FakeResponse(403, {"message": "not subscribed"})):
            res = client.get("/api/regulatory/regulations?code=5489&country=EU")
        self.assertEqual(res.status_code, 502)
        self.assertEqual(res.get_json()["error"]["kind"], "access")
        self.assertNotIn("RAPIDAPI", res.get_data(as_text=True))

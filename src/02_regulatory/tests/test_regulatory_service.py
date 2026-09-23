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

    def test_auth_401_and_403(self):
        self.assert_error("auth", return_value=FakeResponse(401, {"message": "bad key"}))
        self.assert_error("auth", return_value=FakeResponse(403, {"message": "forbidden"}))

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

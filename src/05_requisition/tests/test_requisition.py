"""외부 API 호출 없이 업로드 경계 및 응답 스키마를 검증합니다."""
import importlib
import io
import json
import os
from pathlib import Path
import sys
import unittest
import urllib.error
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from app import app

service = importlib.import_module("src.05_requisition.service")


def extracted():
    values = {key: "" for key in service.STRING_FIELDS}
    values.update({key: [] for key in service.ARRAY_FIELDS})
    values.update(customer="Glowtree", product_name="Setting Powder", product_type="베이스 메이크업",
                  export_countries=["미국"], buyer_prohibited_ingredients=["Talc"],
                  source_language="en", is_development_request=True)
    values["evidence"] = [{"field_key": key, "source_value": str(service.get_value(values, key)), "needs_review": False}
                          for key in service.DATA_FIELDS if service.get_value(values, key)]
    return values


class RequisitionTest(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        with self.client.session_transaction() as session:
            session["user"] = {"id": 1, "name": "테스트", "email": "test@example.com", "team": "연구소"}

    def test_authentication_required(self):
        anonymous = app.test_client()
        self.assertEqual(anonymous.get("/dev-request").status_code, 302)
        with patch.object(service, "call_analysis") as provider:
            self.assertEqual(anonymous.post("/api/dev-request/convert").status_code, 401)
            provider.assert_not_called()

    def test_full_schema_and_raw_data_are_separate(self):
        result = extracted()
        fields = {
            "product_development.texture": "가벼운 파우더",
            "ingredients.necessary": ["Silica"],
            "usage.application_type": "Leave-on",
            "quality.stability.required": False,
            "quality.stability.duration": "12주",
        }
        for key, value in fields.items():
            service.set_value(result, key, value)
            result["evidence"].append({"field_key": key, "source_value": str(value), "source_page": "3", "needs_review": False})
        service.set_value(result, "quality.micro.required", True)
        service.set_value(result, "quality.micro.responsibility", "PRIVATE_MICRO_OWNER")
        result["raw_extracted_data"] = {
            "commercial_data": [{"field_key": "MOQ", "source_value": "SECRET_QUANTITY", "source_page": "2"}],
            "claim_data": [{"field_key": "Clinical Testing", "source_value": "PRIVATE_CLAIM_TEST", "source_page": "3"}],
            "other_data": [{"field_key": "Micro", "source_value": "PRIVATE_MICRO_OWNER", "source_page": "3"}],
        }
        document = service.normalize_result(result, "brief.pdf", "", "auto", "ko", [])
        for key, value in fields.items():
            self.assertEqual(service.get_value(document, key), value)
        self.assertNotIn("micro", document["quality"])
        self.assertEqual(document["raw_extracted_data"], result["raw_extracted_data"])
        self.assertNotIn("SECRET_QUANTITY", json.dumps({key: document[key] for key in ("product_development", "quality", "usage")}))
        public_document = {key: value for key, value in document.items() if key != "raw_extracted_data"}
        self.assertNotIn("PRIVATE_MICRO_OWNER", json.dumps(public_document))
        self.assertNotIn("PRIVATE_CLAIM_TEST", json.dumps(public_document))
        provenance = next(item for item in document["field_provenance"] if item["field_key"] == "quality.stability.required")
        self.assertEqual(provenance["source_page"], "3")
        self.assertEqual(provenance["review_status"], "confirmed")

    def test_nested_fields_require_evidence_and_valid_types(self):
        result = extracted()
        result["product_development"] = {"texture": "Invented"}
        document = service.normalize_result(result, "brief.pdf", "", "auto", "ko", [])
        self.assertEqual(document["product_development"]["texture"], "")
        for value in ("필요", 1, [], {}):
            result["quality"] = {"stability": {"required": value}}
            with self.assertRaises(service.ConversionError):
                service.normalize_result(result, "brief.pdf", "", "auto", "ko", [])

    def test_extraction_schema_is_strict_recursively(self):
        def check(node):
            if node["type"] == "object":
                self.assertFalse(node["additionalProperties"])
                self.assertEqual(set(node["required"]), set(node["properties"]))
                for child in node["properties"].values():
                    check(child)
            elif node["type"] == "array":
                check(node["items"])
        check(service.extraction_schema())

    def post(self, content=b"%PDF-1.7\nfixture", name="brief.pdf", **settings):
        return self.client.post("/api/dev-request/convert", data={
            "file": (io.BytesIO(content), name), "source_language": "auto", "target_language": "ko",
            "recipients": '["연구소", "공장"]', **settings,
        })

    def test_page_and_assets(self):
        response = self.client.get("/dev-request")
        self.assertEqual(response.status_code, 200)
        self.assertIn("개발요청서 분석", response.get_data(as_text=True))
        for extension in ("css", "js"):
            with self.client.get(f"/assets/05_requisition/requisition.{extension}") as asset:
                self.assertEqual(asset.status_code, 200)

    def test_missing_and_invalid_file(self):
        self.assertEqual(self.client.post("/api/dev-request/convert").status_code, 400)
        self.assertEqual(self.post(b"fake", "brief.exe").status_code, 400)
        self.assertEqual(self.post(b"fake", "brief.pdf").status_code, 400)
        self.assertEqual(self.post(b"", "brief.pdf").status_code, 413)
        self.assertEqual(self.post(b"fake", "brief.docx").status_code, 400)

    def test_size_limit(self):
        with patch.object(service, "MAX_FILE_BYTES", 10):
            self.assertEqual(self.post().status_code, 413)

    def test_office_validation(self):
        for suffix, member in [(".docx", "word/document.xml"), (".xlsx", "xl/workbook.xml")]:
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as archive:
                archive.writestr("[Content_Types].xml", "<Types/>")
                archive.writestr(member, "<document/>")
            self.assertEqual(service.validate_file("brief" + suffix, stream.getvalue()), suffix)

    def test_missing_api_key(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertIn("OPENAI_API_KEY", response.json["error"])

    def test_invalid_settings_never_call_provider(self):
        with patch.object(service, "call_analysis") as provider:
            self.assertEqual(self.post(target_language="invalid").status_code, 400)
            self.assertEqual(self.post(recipients="null").status_code, 400)
            self.assertEqual(self.post(recipients='[{}]').status_code, 400)
            self.assertEqual(self.post(customer="x" * 201).status_code, 400)
            provider.assert_not_called()

    def test_normalization_and_provenance(self):
        with patch.object(service, "call_analysis", return_value=extracted()):
            response = self.post(customer="사용자 고객사")
        self.assertEqual(response.status_code, 200)
        document = response.json["document"]
        self.assertEqual(document["customer"], "사용자 고객사")
        self.assertEqual(document["target_price_tier"], "")
        self.assertEqual(document["regulatory_restricted_ingredients"], [])
        self.assertEqual(document["creation_method"], "auto")
        self.assertEqual(document["field_provenance"][0]["source_value"], "Glowtree")
        self.assertEqual(document["field_provenance"][0]["user_value"], "사용자 고객사")
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_unsupported_or_unrelated_result(self):
        for result in (None, {"is_development_request": False}):
            with patch.object(service, "call_analysis", return_value=result):
                self.assertEqual(self.post().status_code, 422)
        result = extracted()
        result["export_countries"] = "미국"
        with patch.object(service, "call_analysis", return_value=result):
            self.assertEqual(self.post().status_code, 502)

    def test_unsourced_values_stay_empty(self):
        result = extracted()
        result.update(target_price_tier="mid", benchmark_product_name="Invented benchmark")
        normalized = service.normalize_result(result, "brief.pdf", "", "auto", "ko", [])
        self.assertEqual(normalized["target_price_tier"], "")
        self.assertEqual(normalized["benchmark_product_name"], "")

    def test_provider_errors_and_payload(self):
        result = {"status": "completed", "output": [{"type": "message", "content": [
            {"type": "output_text", "text": json.dumps(extracted())}]}]}
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-not-a-real-key"}):
            with patch.object(service.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(result).encode())) as provider:
                response = self.post()
                payload = json.loads(provider.call_args.args[0].data)
                self.assertFalse(payload["store"])
                self.assertEqual(payload["text"]["format"]["type"], "json_schema")
                self.assertEqual(response.status_code, 200)
            with patch.object(service.urllib.request, "urlopen", side_effect=TimeoutError):
                self.assertEqual(self.post().status_code, 504)

    def test_provider_errors_explain_recovery_without_exposing_response(self):
        cases = [
            (429, "insufficient_quota", 503, "크레딧"),
            (429, "rate_limit_exceeded", 503, "잠시 후"),
            (401, "invalid_api_key", 503, "OPENAI_API_KEY"),
            (403, None, 503, "접근 권한"),
            (404, "model_not_found", 503, "REQUISITION_OPENAI_MODEL"),
            (400, "context_length_exceeded", 422, "페이지나 시트"),
            (400, None, 422, "파일"),
            (500, None, 502, "처리하지 못했어요"),
        ]
        for status, code, expected_status, message in cases:
            with self.subTest(status=status, code=code):
                body = json.dumps({"error": {"code": code, "message": "secret-provider-detail"}}).encode()
                error = urllib.error.HTTPError("https://api.openai.com/v1/responses", status, "error", {}, io.BytesIO(body))
                with patch.dict(os.environ, {"OPENAI_API_KEY": "test-not-a-real-key"}), patch.object(service.urllib.request, "urlopen", side_effect=error):
                    response = self.post()
                self.assertEqual(response.status_code, expected_status)
                self.assertIn(message, response.json["error"])
                self.assertNotIn("secret-provider-detail", response.get_data(as_text=True))

    def test_non_json_provider_error(self):
        error = urllib.error.HTTPError("https://api.openai.com/v1/responses", 502, "error", {}, io.BytesIO(b"<html>Bad gateway</html>"))
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-not-a-real-key"}), patch.object(service.urllib.request, "urlopen", side_effect=error):
            response = self.post()
        self.assertEqual(response.status_code, 502)
        self.assertIn("error", response.json)


if __name__ == "__main__":
    unittest.main()

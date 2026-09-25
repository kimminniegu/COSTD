"""AI 챗봇 테스트 (담당자 F). 실행: python -m unittest src/06_chatbot/tests/test_chatbot.py -v

외부 API(OpenAI·RapidAPI)는 호출하지 않습니다. OpenAI 는 로컬 가짜 서버로 대체해 도구 호출 왕복을 검증합니다.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

BASE_DIR = Path(__file__).resolve().parents[3]
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

os.environ["CHATBOT_SECRET"] = "test-secret"
os.environ["CHATBOT_DB_PATH"] = str(Path(tempfile.mkdtemp()) / "chatbot-test.db")   # 실제 캐시 DB 를 건드리지 않음
SECRET = {"X-Chatbot-Secret": "test-secret"}
DEMO_USER = {"id": 1, "email": "demo@costd.kr", "name": "데모", "team": "해외영업팀"}


# ---------------------------------------------------------------------------
# 가짜 OpenAI Responses API: 1회차는 function_call, 2회차(도구 결과 포함)는 message
# ---------------------------------------------------------------------------
class FakeOpenAI(BaseHTTPRequestHandler):
    requests: list = []

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        FakeOpenAI.requests.append(body)
        has_tool_output = any(item.get("type") == "function_call_output" for item in body["input"])
        if not has_tool_output and body.get("tool_choice") != "none":
            output = [{"type": "function_call", "call_id": "call_1", "name": "get_local_time", "arguments": json.dumps({"country_code": "JP"})}]
        else:
            tool_out = next(item["output"] for item in body["input"] if item.get("type") == "function_call_output")
            city = json.loads(tool_out)["items"][0]["city"]
            output = [{"type": "message", "content": [{"type": "output_text", "text": "지금 %s 현지 시각을 확인했어요." % city}]}]
        payload = json.dumps({"status": "completed", "output": output}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):  # 테스트 출력 조용히
        pass


_fake = HTTPServer(("127.0.0.1", 0), FakeOpenAI)
threading.Thread(target=_fake.serve_forever, daemon=True).start()
os.environ["CHATBOT_OPENAI_URL"] = "http://127.0.0.1:%d/v1/responses" % _fake.server_port

server_mod = importlib.import_module("src.06_chatbot.server")
tools = importlib.import_module("src.06_chatbot.tools")
server_mod.app.config["TESTING"] = True


# ---------------------------------------------------------------------------
# tools.py
# ---------------------------------------------------------------------------
class ToolsTest(unittest.TestCase):
    def test_schema_is_strict_and_matches_executors(self):
        self.assertEqual({t["name"] for t in tools.TOOLS}, set(tools.EXECUTORS))
        for t in tools.TOOLS:
            params = t["parameters"]
            self.assertTrue(t["strict"])
            self.assertFalse(params["additionalProperties"])
            self.assertEqual(set(params["required"]), set(params["properties"]))   # strict 모드 요건

    def test_unknown_tool(self):
        out = json.loads(tools.execute("nope", "{}"))
        self.assertEqual(out["error"]["kind"], "unknown_tool")

    def test_bad_arguments(self):
        out = json.loads(tools.execute("get_local_time", "{not json"))
        self.assertEqual(out["error"]["kind"], "validation")     # 잘못된 JSON → 모델이 다시 호출할 수 있게 validation
        out = json.loads(tools.execute("get_local_time", json.dumps({"country_code": "ZZ"})))
        self.assertEqual(out["error"]["kind"], "validation")
        out = json.loads(tools.execute("get_local_time", json.dumps({"bogus": 1})))
        self.assertEqual(out["error"]["kind"], "validation")     # 정의에 없는 인자

    def test_local_time(self):
        out = json.loads(tools.execute("get_local_time", json.dumps({"country_code": "vn"})))
        self.assertEqual(out["items"][0]["city"], "호찌민")
        self.assertEqual(out["items"][0]["offset_from_kst_hours"], -2.0)

    def test_lookup_regulation_validation(self):
        out = json.loads(tools.execute("lookup_ingredient_regulation", json.dumps({"name": "", "market": "EU", "source": "mfds"})))
        self.assertEqual(out["error"]["kind"], "validation")
        out = json.loads(tools.execute("lookup_ingredient_regulation", json.dumps({"name": "레티놀", "market": "XX", "source": "mfds"})))
        self.assertEqual(out["error"]["kind"], "validation")

    def test_lookup_regulation_mfds_missing_db_gives_hint(self):
        with mock.patch.dict(os.environ, {"MFDS_DB_PATH": str(Path(tempfile.mkdtemp()) / "none.sqlite")}):
            out = json.loads(tools.execute("lookup_ingredient_regulation", json.dumps({"name": "레티놀", "market": "EU", "source": "mfds"})))
        self.assertEqual(out["error"]["kind"], "db_missing")
        self.assertIn("api", out["hint"])

    def test_search_ingredient_without_api_config(self):
        with mock.patch.dict(os.environ, {"RAPIDAPI_KEY": "", "RAPIDAPI_HOST": ""}):
            out = json.loads(tools.execute("search_ingredient", json.dumps({"query": "레티놀"})))
        self.assertEqual(out["error"]["kind"], "config")

    def test_regulation_news_on_empty_cache(self):
        empty = {"items": [], "checked_at": None}
        with mock.patch.object(tools.home_data, "kick_refresh", return_value=[]), \
             mock.patch.object(tools.home_data, "get_regulations", return_value=empty), \
             mock.patch.object(tools.home_data, "is_refreshing", return_value=["regulations"]):
            out = json.loads(tools.execute("search_regulation_news", json.dumps({"query": None, "country": None, "limit": 3})))
        self.assertEqual(out["count"], 0)
        self.assertIn("수집하는 중", out["note"])      # 빈 캐시 + 수집 중이면 안내 문구 (지어내지 않음)

    def test_news_tool_compacts_items(self):
        sample = {"items": [{"source": "CMN", "press": "", "title": "제목", "url": "https://x", "published_at": "2026-09-25T09:00:00+09:00",
                             "time_text": "3시간 전", "official": False, "external": False}],
                  "updated_at": "2026-09-25T10:00:00+09:00", "error": None}
        with mock.patch.object(tools.home_data, "kick_refresh", return_value=[]), \
             mock.patch.object(tools.home_data, "get_news", return_value=sample) as get_news:
            out = json.loads(tools.execute("search_news", json.dumps({"query": "선크림", "source": None, "limit": 99})))
        self.assertEqual(out["count"], 1)
        self.assertEqual(set(out["items"][0]), {"source", "press", "title", "url", "published_at"})
        self.assertEqual(get_news.call_args.kwargs["limit"], tools.MAX_LIST)      # limit 상한
        self.assertTrue(get_news.call_args.kwargs["external"])                    # 검색어가 있으면 웹 검색 포함


# ---------------------------------------------------------------------------
# server.py
# ---------------------------------------------------------------------------
class ServerTest(unittest.TestCase):
    def setUp(self):
        self.client = server_mod.app.test_client()

    def test_health(self):
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json()["ok"])

    def test_requires_secret(self):
        body = {"messages": [{"role": "user", "content": "hi"}]}
        self.assertEqual(self.client.post("/chat", json=body).status_code, 401)
        self.assertEqual(self.client.post("/chat", json=body, headers={"X-Chatbot-Secret": "wrong"}).status_code, 401)

    def test_validates_messages(self):
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}):
            self.assertEqual(self.client.post("/chat", json={}, headers=SECRET).status_code, 400)
            self.assertEqual(self.client.post("/chat", json={"messages": [{"role": "system", "content": "x"}]}, headers=SECRET).status_code, 400)
            self.assertEqual(self.client.post("/chat", json={"messages": [{"role": "assistant", "content": "x"}]}, headers=SECRET).status_code, 400)

    def test_without_openai_key(self):
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            res = self.client.post("/chat", json={"messages": [{"role": "user", "content": "hi"}]}, headers=SECRET)
        self.assertEqual(res.status_code, 503)
        self.assertIn("OPENAI_API_KEY", res.get_json()["error"])

    def test_tool_round_trip(self):
        FakeOpenAI.requests.clear()
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}):
            res = self.client.post("/chat", json={"messages": [{"role": "user", "content": "일본 지금 몇 시야?"}],
                                                 "user": {"name": "데모", "team": "해외영업팀"}}, headers=SECRET)
        data = res.get_json()
        self.assertEqual(res.status_code, 200, data)
        self.assertTrue(data["ok"])
        self.assertIn("도쿄", data["reply"])
        self.assertEqual(data["tools_used"], ["get_local_time"])
        self.assertEqual(len(FakeOpenAI.requests), 2)
        first = FakeOpenAI.requests[0]
        self.assertFalse(first["store"])
        self.assertIn("데모", first["instructions"])
        self.assertEqual({t["name"] for t in first["tools"]}, {t["name"] for t in tools.TOOLS})
        self.assertEqual(FakeOpenAI.requests[1]["input"][-1]["type"], "function_call_output")


# ---------------------------------------------------------------------------
# app.py 중계 Route + base.html 위젯
# ---------------------------------------------------------------------------
class RelayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from werkzeug.serving import make_server
        cls.upstream = make_server("127.0.0.1", 0, server_mod.app)
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.url = "http://127.0.0.1:%d" % cls.upstream.server_port
        app_mod = importlib.import_module("app")
        app_mod.app.config["TESTING"] = True
        cls.app = app_mod.app

    @classmethod
    def tearDownClass(cls):
        cls.upstream.shutdown()

    def setUp(self):
        self.client = self.app.test_client()

    def login(self):
        with self.client.session_transaction() as sess:
            sess["user"] = DEMO_USER

    def test_requires_login(self):
        res = self.client.post("/api/chatbot/message", json={"messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(res.status_code, 401)

    def test_without_config(self):
        self.login()
        with mock.patch.dict(os.environ, {"CHATBOT_URL": ""}):
            res = self.client.post("/api/chatbot/message", json={"messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(res.status_code, 503)

    def test_forwards_to_chatbot_server(self):
        self.login()
        with mock.patch.dict(os.environ, {"CHATBOT_URL": self.url, "OPENAI_API_KEY": "sk-test"}):
            res = self.client.post("/api/chatbot/message", json={"messages": [{"role": "user", "content": "일본 몇 시?"}]})
        data = res.get_json()
        self.assertEqual(res.status_code, 200, data)
        self.assertTrue(data["ok"])
        self.assertIn("도쿄", data["reply"])

    def test_upstream_error_is_forwarded(self):
        self.login()
        with mock.patch.dict(os.environ, {"CHATBOT_URL": self.url, "OPENAI_API_KEY": ""}):
            res = self.client.post("/api/chatbot/message", json={"messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(res.status_code, 503)
        self.assertFalse(res.get_json()["ok"])

    def test_widget_rendered_in_layout(self):
        self.login()
        html = self.client.get("/regulatory").get_data(as_text=True)
        self.assertIn('id="chatbot-launcher"', html)
        self.assertIn("/api/chatbot/message", html)
        self.assertIn("06_chatbot/chatbot.js", html)
        self.assertEqual(self.client.get("/assets/06_chatbot/chatbot.css").status_code, 200)
        self.assertEqual(self.client.get("/assets/06_chatbot/chatbot_widget.html").status_code, 404)   # 템플릿 원본은 제공하지 않음
        self.assertNotIn("chatbot-launcher", self.client.get("/login").get_data(as_text=True))       # 로그인 화면에는 없음


if __name__ == "__main__":
    unittest.main()

"""선택적 실제 브라우저 검증: Windows Edge + Python websockets 패키지 필요.

실행: python src/05_requisition/tests/browser_smoke.py
외부 API는 호출하지 않습니다. 테스트용 서버/브라우저는 종료 시 닫습니다.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from unittest.mock import patch

from websockets.sync.client import connect
from werkzeug.serving import make_server

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from app import app
from test_requisition import extracted, service


def main():
    browser = Path(os.environ.get("PROGRAMFILES(X86)", "C:/Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe"
    profile = Path(tempfile.mkdtemp(prefix="costd-requisition-browser-"))
    server = make_server("127.0.0.1", 0, app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    process = subprocess.Popen([
        str(browser), "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--remote-debugging-port=0", f"--user-data-dir={profile}", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        port_file = profile / "DevToolsActivePort"
        for _ in range(100):
            if port_file.exists():
                break
            time.sleep(0.1)
        port = port_file.read_text().splitlines()[0]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json") as response:
            pages = json.load(response)
        page = next(item for item in pages if item["type"] == "page")
        with connect(page["webSocketDebuggerUrl"], max_size=10 * 1024 * 1024) as ws:
            sequence = 0

            def command(method, params=None):
                nonlocal sequence
                sequence += 1
                ws.send(json.dumps({"id": sequence, "method": method, "params": params or {}}))
                while True:
                    message = json.loads(ws.recv(timeout=15))
                    if message.get("id") == sequence:
                        if "error" in message:
                            raise AssertionError(message["error"])
                        return message.get("result", {})

            def js(expression):
                result = command("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
                if "exceptionDetails" in result:
                    raise AssertionError(result["exceptionDetails"])
                return result.get("result", {}).get("value")

            def click(element):
                js(f'document.getElementById("requisition-{element}").click()')

            def fill(key, value):
                js(f'(() => {{const el=document.getElementById("requisition-input-{key}");el.value={json.dumps(value)};el.dispatchEvent(new Event("input",{{bubbles:true}}));}})()')

            command("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 1050, "deviceScaleFactor": 1, "mobile": False})
            command("Page.navigate", {"url": f"http://127.0.0.1:{server.server_port}/dev-request"})
            for _ in range(100):
                if js('Boolean(document.getElementById("requisition-manual")) && document.readyState === "complete"'):
                    break
                time.sleep(0.1)
            assert js('document.getElementById("requisition-upload").hidden') is False
            click("manual")
            click("primary")
            assert "필수 항목" in js('document.getElementById("requisition-notice").textContent')
            fill("customer", "테스트 고객사")
            fill("export_countries", "미국")
            click("auto")
            assert js('document.getElementById("requisition-upload").hidden') is False
            assert js('document.getElementById("requisition-document").hidden') is True
            js('document.getElementById("requisition-auto").dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowRight", bubbles:true}))')
            assert js('document.getElementById("requisition-manual").getAttribute("aria-selected")') == "true"
            assert js('document.getElementById("requisition-input-customer").value') == "테스트 고객사"
            assert "미국" in js('document.getElementById("requisition-field-export_countries").textContent')
            fill("product_name", "<img src=x onerror=alert(1)> 테스트 제품")
            fill("sample_request_type", "신규 샘플")
            fill("product_type", "기타")
            click("primary")
            assert js('document.activeElement.id') == "requisition-input-product_type_custom"
            fill("product_type_custom", "기타 제품")
            fill("export_countries", "미국")
            fill("buyer_prohibited_ingredients", "Talc")
            click("primary")
            assert js('document.getElementById("requisition-title").textContent') == "개발요청서"
            assert "Talc" in js('document.getElementById("requisition-field-buyer_prohibited_ingredients").textContent')
            assert js('document.querySelectorAll("#requisition-fields img").length') == 0
            click("secondary")
            fill("product_name", "취소될 수정")
            click("secondary")
            assert "취소될 수정" not in js('document.getElementById("requisition-fields").textContent')
            click("secondary")
            fill("product_name", "최종 제품명")
            click("primary")
            assert js('document.getElementById("requisition-version") === null')
            # 인쇄 대화상자를 대신해 생성된 실제 iframe 문서의 최종값을 검증합니다.
            js('window.printWatch = new MutationObserver(() => {const f=document.querySelector(".requisition-print-frame");if(f){f.contentWindow.print=()=>{};}});printWatch.observe(document.body,{childList:true});')
            click("pdf-internal")
            for _ in range(50):
                if js('Boolean(document.querySelector(".requisition-print-frame")?.contentDocument?.body?.textContent.includes("최종 제품명"))'):
                    break
                time.sleep(0.1)
            assert js('document.querySelector(".requisition-print-frame").contentDocument.body.textContent.includes("최종 제품명")')
            assert "_v2" in js('document.querySelector(".requisition-print-frame").contentDocument.title')
            screenshot = profile / "requisition-desktop.png"
            screenshot.write_bytes(base64.b64decode(command("Page.captureScreenshot", {"format": "png"})["data"]))
            command("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
            assert js('document.documentElement.scrollWidth <= window.innerWidth'), "Mobile overflow"
            # 자동변환은 실제 브라우저 fetch + Flask 경로를 사용하고 공급자 응답만 모의 처리합니다.
            js('window.confirm=()=>true')
            click("new")
            with patch.object(service, "call_analysis", return_value=extracted()):
                js('(() => {const file=new File(["%PDF-1.7 fixture"],"brief.pdf",{type:"application/pdf"});const dt=new DataTransfer();dt.items.add(file);const input=document.getElementById("requisition-file");input.files=dt.files;input.dispatchEvent(new Event("change",{bubbles:true}));})()')
                for _ in range(100):
                    if js('document.getElementById("requisition-title").textContent') == "개발요청서":
                        break
                    time.sleep(0.1)
                assert js('document.getElementById("requisition-method").textContent') == "자동변환"
                assert "Setting Powder" in js('document.getElementById("requisition-fields").textContent')
            print("PASS: tabs, keyboard navigation, draft preservation, manual, required/custom validation, pending chips, escaping, edit/cancel, version, PDF content, mobile layout, upload/result")
            print(f"Screenshot: {screenshot}")
    finally:
        process.terminate()
        process.wait(timeout=10)
        server.shutdown()


if __name__ == "__main__":
    main()

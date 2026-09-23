"""Run the real form in headless Edge, without a server or external API call."""
import importlib
import json
from pathlib import Path
import re
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from app import app

service = importlib.import_module("src.05_requisition.service")
edge = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
if not edge.exists():
    raise SystemExit("Headless Edge is not available.")

with app.test_client() as client:
    with client.session_transaction() as session:
        session["user"] = {"id": 1, "name": "Test", "email": "test@example.com", "team": "Test"}
    html = client.get("/dev-request").get_data(as_text=True)
html = re.sub(r'<script[^>]+src=[^>]+>.*?</script>', '', html, flags=re.S)
html = re.sub(r'<link[^>]+>', '', html)
script = (ROOT / "src/05_requisition/requisition.js").read_text(encoding="utf-8")
raw = {"is_development_request": True, "source_language": "en", "customer": "Auto customer",
       "product_name": "Auto product", "product_type": "립", "export_countries": ["미국"],
       "product_development": {"texture": "Auto texture"},
       "raw_extracted_data": {"commercial_data": [{"field_key": "MOQ", "source_value": "PRIVATE_SENTINEL", "source_page": "2"}]}}
raw["evidence"] = [{"field_key": key, "source_value": str(service.get_value(raw, key)), "needs_review": False}
                   for key in service.DATA_FIELDS if service.get_value(raw, key)]
fixture_document = service.normalize_result(raw, "brief.pdf", "", "auto", "ko", ["연구소", "공장"])
checks = r"""
(async () => {
window.confirm = () => true;
const by = (id) => document.getElementById('requisition-' + id);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const enter = (key, value) => {
  const el = by('input-' + key); el.value = value;
  el.dispatchEvent(new Event('input', {bubbles: true}));
};
const submit = () => by('document').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
try {
  by('manual').click();
  assert(!by('app').textContent.includes('전달 대상'), 'recipient controls removed');
  assert(!by('fields').textContent.includes('미생물'), 'microbiology fields excluded');
  assert(!by('fields').textContent.includes('클레임'), 'claim testing fields excluded');
  assert(by('step').textContent.includes('STEP 4'), 'manual step');
  const tabs = by('section-tabs').querySelectorAll('[role="tab"]');
  assert(tabs.length === 6, 'six section tabs');
  enter('customer', 'Retained customer');
  by('input-ingredients.necessary').value = 'Pending ingredient';
  tabs[5].click();
  assert(!by('section-5').hidden && by('section-0').hidden, 'reference tab visibility');
  tabs[5].dispatchEvent(new KeyboardEvent('keydown', {key: 'Home', bubbles: true}));
  assert(document.activeElement === tabs[0] && !by('section-0').hidden, 'keyboard tab navigation');
  assert(by('input-customer').value === 'Retained customer', 'values retained across tabs');
  assert(by('input-ingredients.necessary').value === 'Pending ingredient', 'pending chip retained across tabs');
  by('input-ingredients.necessary').value = '';
  enter('customer', '');
  tabs[4].click();
  submit();
  assert(!by('section-0').hidden && document.activeElement === by('input-customer'), 'validation opens missing field tab');
  assert(!by('notice').hidden, 'required fields');
  enter('customer', 'Browser customer'); enter('product_name', 'Browser product');
  enter('product_type', '기타'); submit();
  assert(!by('notice').hidden, 'custom product type required');
  enter('product_type_custom', 'Custom type');
  by('input-export_countries').value = '미국';
  enter('product_development.texture', 'Texture v1');
  enter('quality.stability.required', 'false');
  by('input-ingredients.necessary').value = 'Silica';
  submit();
  assert(by('step').textContent.includes('STEP 2'), 'result step');
  assert(!by('fields').querySelector('input,textarea,select'), 'read only');
  assert(by('fields').textContent.includes('Silica'), 'pending ingredient saved');
  assert(by('fields').textContent.includes('불필요'), 'false quality flag preserved');
  by('secondary').click(); enter('product_development.texture', 'Cancelled'); by('secondary').click();
  assert(by('fields').textContent.includes('Texture v1'), 'edit cancellation');
  by('secondary').click(); enter('product_development.texture', 'Texture v2');
  submit();
  assert(!by('version'), 'version badge removed');
  assert(by('fields').textContent.includes('Texture v2'), 'nested edit saved');
  // Suppress the native dialog while exercising the actual PDF DOM generation.
  const append = document.body.append.bind(document.body);
  document.body.append = (el) => {
    if (el.tagName === 'IFRAME') el.srcdoc = el.srcdoc.replace('<head>', '<head><script>window.print=()=>{};<\/script>');
    append(el);
  };
  submit();
  const frame = document.querySelector('.requisition-print-frame');
  assert(frame && frame.srcdoc.includes('Texture v2'), 'PDF latest values');
  assert(frame.srcdoc.includes('06 참고자료'), 'PDF sections');
  const pdf = new DOMParser().parseFromString(frame.srcdoc, 'text/html');
  assert(pdf.querySelector('h1').textContent === '제품 개발 요청서', 'formal document title');
  assert(pdf.querySelector('.document-meta').textContent.includes('연구소'), 'research recipient');
  assert(pdf.querySelectorAll('table.requirements thead').length === 5, 'all requirement tables included');
  assert(pdf.querySelector('.review-signoff').textContent.includes('검토 담당자'), 'research review area');
  assert(pdf.querySelector('footer').textContent.includes('COSTD'), 'company footer');
  assert(pdf.querySelector('.requirements').textContent.includes('Browser customer'), 'customer retained in formal PDF');
  assert(!/전달 대상|미생물|클레임/.test(frame.srcdoc), 'excluded fields absent from PDF');
  by('new').click();
  window.fetch = async () => ({ok: true, json: async () => ({document: window.fixtureDocument})});
  const files = new DataTransfer();
  files.items.add(new File(['%PDF-1.7 fixture'], 'brief.pdf', {type: 'application/pdf'}));
  by('file').files = files.files; by('file').dispatchEvent(new Event('change', {bubbles: true}));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert(by('step').textContent.includes('STEP 2'), 'upload automatically transitions');
  assert(by('fields').textContent.includes('Auto texture'), 'nested automatic conversion');
  assert(!by('fields').textContent.includes('PRIVATE_SENTINEL'), 'private data excluded from result');
  submit();
  const autoPDF = document.querySelector('.requisition-print-frame');
  assert(autoPDF.srcdoc.includes('Auto texture'), 'automatic conversion PDF');
  assert(!autoPDF.srcdoc.includes('PRIVATE_SENTINEL'), 'private data excluded from PDF');
  document.body.dataset.testResult = 'PASS';
} catch (error) { document.body.dataset.testResult = 'FAIL: ' + error.message; }
})();
"""
html = html.replace("</body>", "<script>window.fixtureDocument=" + json.dumps(fixture_document) + ";</script><script>" + script + "</script><script>" + checks + "</script></body>")
folder = ROOT / "instance" / ("requisition-browser-" + uuid.uuid4().hex)
folder.mkdir()
fixture = folder / "check.html"
fixture.write_text(html, encoding="utf-8")
result = subprocess.run([str(edge), "--headless", "--disable-gpu", "--no-first-run",
                         "--no-default-browser-check", "--disable-extensions",
                         "--user-data-dir=" + str(folder / "profile"), "--virtual-time-budget=1000", "--dump-dom", fixture.as_uri()],
                        capture_output=True, timeout=45)
output = result.stdout.decode("utf-8", errors="replace")
match = re.search(r'data-test-result="([^"]+)"', output)
print(match.group(1) if match else "No browser result: " + result.stderr.decode("utf-8", errors="replace")[-1500:])
raise SystemExit(0 if match and match.group(1) == "PASS" else 1)

(() => {
  "use strict";
  const $ = (id) => document.getElementById("requisition-" + id);
  const root = $("app");
  if (!root) return;
  const types = ["스킨케어", "베이스 메이크업", "립", "아이", "바디", "헤어", "클렌징", "선케어", "기타"];
  const tiers = { low: "저가", mid: "중가", high: "고가" };
  const labels = { customer: "고객사", product_name: "제품명", product_type: "제품 유형", target_price_tier: "목표 가격대", export_countries: "수출 대상국", buyer_prohibited_ingredients: "수출 금지 원료" };
  const countries = ["미국", "캐나다", "중국", "일본", "한국", "프랑스", "독일", "영국", "호주", "베트남", "태국", "인도네시아", "싱가포르", "인도", "아랍에미리트", "사우디아라비아"];
  const methods = { auto: "자동변환", auto_edited: "자동변환 후 수정", manual: "직접 작성", manual_edited: "직접 작성 후 수정" };
  let state = "upload", saved = null, draft = null, originalFile = null, controller = null;
  let printFrame = null;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const filled = (value) => Array.isArray(value) ? value.length > 0 : Boolean(String(value ?? "").trim());
  const editing = () => state === "edit" || state === "manual";
  const current = () => editing() ? draft : saved;
  const blank = () => ({
    document_id: crypto.randomUUID ? crypto.randomUUID() : "request-" + Date.now(),
    creation_method: "manual", customer: "", source_language: "", target_language: $("target-language").value,
    product_name: "", product_type: "", product_type_custom: "", target_price_tier: "",
    export_countries: [], buyer_prohibited_ingredients: [], regulatory_restricted_ingredients: [],
    benchmark_product_name: "", recipients: [], review_status: "needs_review",
    source_file: "", version: 1, field_provenance: []
  });
  function notice(message = "") {
    $("notice").textContent = message;
    $("notice").hidden = !message;
  }
  function missing(data) {
    return ["customer", "product_name", "product_type", "export_countries"].filter((key) =>
      !filled(data[key]) || (key === "product_type" && data.product_type === "기타" && !filled(data.product_type_custom)));
  }
  function reviews(data) {
    const result = missing(data).map((key) => labels[key]);
    if (data.creation_method.startsWith("auto") && !data.target_price_tier) result.push("목표 가격대");
    (data.field_provenance || []).filter((item) => item.review_status === "needs_review").forEach((item) => {
      if (labels[item.field_key]) result.push(labels[item.field_key]);
    });
    return [...new Set(result)];
  }
  function fieldValue(data, key) {
    if (key === "product_type") return data.product_type === "기타" ? data.product_type_custom || "확인 필요" : data.product_type;
    if (key === "target_price_tier") return tiers[data[key]] || "";
    if (key === "buyer_prohibited_ingredients") return [...data[key], ...data.regulatory_restricted_ingredients].join(", ");
    return Array.isArray(data[key]) ? data[key].join(", ") : data[key];
  }
  function input(key, placeholder = "") {
    return '<input class="form-control" id="requisition-input-' + key + '" data-field="' + key + '" maxlength="300" value="' + escape(current()[key]) + '" placeholder="' + escape(placeholder) + '">';
  }
  function chips(key, title) {
    const values = current()[key];
    const isCountry = key === "export_countries";
    return '<div class="requisition-chips">' + values.map((value, index) =>
      '<span class="multi-select__chip">' + escape(value) + '<button type="button" class="multi-select__remove" data-remove="' + key + '" data-index="' + index + '" aria-label="' + escape(value) + ' 삭제">×</button></span>').join("") +
      '</div><div class="requisition-chip-entry"><div class="requisition-chip-input"><input class="form-control form-control-sm" id="requisition-input-' + key + '" data-chip="' + key + '" maxlength="100" placeholder="' + title + '" aria-label="' + title + '"' + (isCountry ? ' role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="requisition-country-list" aria-describedby="requisition-country-help" autocomplete="off"' : "") + '>' +
      (isCountry ? '<div id="requisition-country-list" class="requisition-country-list" role="listbox" aria-label="수출 대상국" hidden></div>' : "") +
      '</div><button type="button" class="btn btn-secondary btn-sm" data-add="' + key + '">추가</button></div>' +
      (isCountry ? '<p class="form-help" id="requisition-country-help">목록에서 선택하거나, 없는 국가는 직접 입력한 뒤 Enter 또는 추가 버튼을 눌러 주세요.</p>' : "");
  }
  function field(key) {
    const data = current(), required = ["customer", "product_name", "product_type", "export_countries"].includes(key);
    let control;
    if (!editing()) {
      let value = fieldValue(data, key);
      if (key === "buyer_prohibited_ingredients") {
        value = [data.buyer_prohibited_ingredients.length ? "바이어 지정: " + data.buyer_prohibited_ingredients.join(", ") : "",
          data.regulatory_restricted_ingredients.length ? "규제 검토 대상: " + data.regulatory_restricted_ingredients.join(", ") : ""].filter(Boolean).join("\n");
      }
      control = '<p class="requisition-field-value">' + escape(value || (required ? "확인 필요" : "미입력")) + "</p>";
    } else if (key === "product_type") {
      control = '<select class="form-control" id="requisition-input-product_type" data-field="product_type" aria-required="true"><option value="">선택하세요</option>' +
        types.map((value) => '<option value="' + value + '"' + (data[key] === value ? " selected" : "") + ">" + (value === "기타" ? "기타 / 직접 입력" : value) + "</option>").join("") +
        '</select><div id="requisition-custom-wrap" class="mt-4"' + (data.product_type === "기타" ? "" : " hidden") + '><label class="form-label" for="requisition-input-product_type_custom">제품 유형 직접 입력 *</label>' + input("product_type_custom", "제품 유형을 입력하세요") + "</div>";
    } else if (key === "target_price_tier") {
      control = '<div class="requisition-options" role="group" aria-label="목표 가격대">' + [["", "미정"], ...Object.entries(tiers)].map(([value, name]) =>
        '<label class="form-check"><input type="radio" name="requisition-tier" data-field="target_price_tier" value="' + value + '"' + (data[key] === value ? " checked" : "") + ">" + name + "</label>").join("") + "</div>";
    } else if (key === "export_countries" || key === "buyer_prohibited_ingredients") {
      control = chips(key, key === "export_countries" ? "국가 선택 또는 입력" : "바이어 지정 원료 입력");
      if (key === "buyer_prohibited_ingredients") control += '<p class="form-help">바이어가 사용하지 말라고 지정한 원료를 입력해요.</p>' +
        (data.regulatory_restricted_ingredients.length ? '<p class="form-help">규제 검토 대상: ' + escape(data.regulatory_restricted_ingredients.join(", ")) + " · 규제 확인 필요</p>" : "");
    } else control = input(key, labels[key] + " 입력");
    return '<div class="form-group" id="requisition-field-' + key + '">' +
      (editing() && key !== "target_price_tier" ? '<label class="form-label" for="requisition-input-' + key + '">' : '<p class="form-label">') +
      labels[key] + (editing() && required ? ' <span class="is-required">*</span>' : "") +
      (editing() && key !== "target_price_tier" ? "</label>" : "</p>") + '<div class="requisition-field-content">' + control +
      '<p class="form-error" id="requisition-error-' + key + '" hidden></p></div></div>';
  }
  function render() {
    const choosingMode = state === "upload" || state === "manual";
    $("modes").hidden = !choosingMode;
    ["auto", "manual"].forEach((mode) => {
      const active = mode === "manual" ? state === "manual" : state === "upload";
      $(mode).classList.toggle("is-active", active);
      $(mode).setAttribute("aria-selected", String(active));
      $(mode).tabIndex = active ? 0 : -1;
    });
    $("upload").setAttribute("role", "tabpanel");
    $("upload").setAttribute("aria-labelledby", "requisition-auto");
    if (state === "manual") {
      $("document").setAttribute("role", "tabpanel");
      $("document").setAttribute("aria-labelledby", "requisition-manual");
    } else {
      $("document").removeAttribute("role");
      $("document").removeAttribute("aria-labelledby");
    }
    $("upload").hidden = state !== "upload";
    $("loading").hidden = state !== "loading";
    $("document").hidden = !["manual", "edit", "result"].includes(state);
    $("new").hidden = state !== "result";
    const headings = { upload: ["STEP 1 · 시작", "개발요청서 분석"], loading: ["STEP 1 · 자동변환", "개발요청서 분석"], result: ["STEP 2 · 결과 확인", "개발요청서"], edit: ["STEP 3 · 수정", "개발요청서 수정"], manual: ["STEP 1 · 직접 작성", "개발요청서 직접 작성"] };
    $("step").textContent = headings[state][0];
    $("title").textContent = headings[state][1];
    $("description").textContent = state === "upload" || state === "loading" ? "바이어 요청서를 변환하거나 직접 작성하여 개발팀에 전달해요." :
      editing() ? "필수 항목을 입력하고 개발팀에 전달할 요청서를 완성해요." : "내용을 확인하고 필요하면 수정한 뒤 PDF로 저장해요.";
    if (state === "upload" || state === "loading") return;
    const data = current();
    $("fields").innerHTML = Object.keys(labels).map(field).join("");
    $("panel-title").textContent = editing() ? "작성 상태" : "문서 정보";
    $("form-help").textContent = editing() ? "* 표시된 항목은 필수 입력이에요." : "개발에 필요한 핵심 정보를 확인해요.";
    $("version").textContent = "v" + data.version;
    $("benchmark").innerHTML = '<label class="form-label"' + (editing() ? ' for="requisition-input-benchmark_product_name"' : "") + '>벤치마크 제품명</label>' +
      '<div class="requisition-field-content">' + (editing() ? input("benchmark_product_name", "참고할 제품명 (선택)") : '<p class="requisition-field-value">' + escape(data.benchmark_product_name || "미입력") + "</p>") + '</div>';
    $("secondary").textContent = state === "result" ? "수정" : state === "edit" ? "수정 취소" : "작성 취소";
    $("primary").textContent = state === "result" ? "PDF로 저장" : state === "edit" ? "수정 완료" : "작성 완료";
    $("pdf-help").hidden = editing();
    updateSummary();
  }
  function updateSummary() {
    const data = current();
    if (!data) return;
    const required = missing(data), checks = reviews(data);
    $("method").textContent = methods[data.creation_method];
    $("count-label").textContent = editing() ? "채운 항목" : "입력 완료";
    $("count").textContent = Object.keys(labels).filter((key) => filled(fieldValue(data, key)) && !(key === "product_type" && required.includes(key))).length + " / 6";
    $("missing-wrap").hidden = !editing() || !required.length;
    $("missing").textContent = required.map((key) => labels[key]).join(", ");
    $("review").textContent = checks.length ? checks.length + "건 · " + checks.join(", ") : "없음";
    data.review_status = required.length || checks.length || data.export_countries.length ? "needs_review" : "complete";
  }
  function transition(next) {
    state = next;
    notice();
    render();
    $("title").focus({ preventScroll: true });
    $("title").scrollIntoView({ block: "start", behavior: "instant" });
  }
  function markEdited(key) {
    const item = (draft.field_provenance || []).find((entry) => entry.field_key === key);
    if (item) {
      item.user_value = clone(draft[key]);
      item.input_source = "user_edited";
      item.review_status = "reviewed";
    }
  }
  function addChip(key) {
    const el = $("input-" + key), value = el.value.trim();
    if (!value) return;
    if (draft[key].length >= 50) return notice("한 항목에 최대 50개까지 추가할 수 있어요.");
    if (!draft[key].some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) draft[key].push(value);
    markEdited(key);
    $("field-" + key).outerHTML = field(key);
    updateSummary();
    $("input-" + key).focus();
  }
  function closeCountries() {
    const el = $("input-export_countries"), list = $("country-list");
    if (!el || !list) return;
    list.hidden = true;
    el.setAttribute("aria-expanded", "false");
    el.removeAttribute("aria-activedescendant");
  }
  function showCountries() {
    const el = $("input-export_countries"), list = $("country-list");
    const query = el.value.trim().toLocaleLowerCase();
    const options = countries.filter((name) => name.toLocaleLowerCase().includes(query) && !draft.export_countries.includes(name));
    list.innerHTML = options.map((name, index) => '<button type="button" class="requisition-country-option" role="option" tabindex="-1" aria-selected="false" id="requisition-country-option-' + index + '" data-country="' + escape(name) + '">' + escape(name) + '</button>').join("") ||
      '<p class="requisition-country-empty">' + (query ? "목록에 없는 국가는 Enter 또는 추가 버튼으로 추가할 수 있어요." : "선택 가능한 국가가 없어요. 국가명을 직접 입력해 주세요.") + '</p>';
    list.hidden = false;
    el.setAttribute("aria-expanded", "true");
    el.removeAttribute("aria-activedescendant");
  }
  ["focusin", "input", "click"].forEach((type) => {
    $("document").addEventListener(type, (event) => {
      if (editing() && event.target.dataset.chip === "export_countries") showCountries();
    });
  });
  $("document").addEventListener("focusout", (event) => {
    if (event.target.dataset.chip === "export_countries") closeCountries();
  });
  $("document").addEventListener("mousedown", (event) => {
    if (event.target.closest("[data-country]")) event.preventDefault();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#requisition-field-export_countries")) closeCountries();
  });
  $("document").addEventListener("input", (event) => {
    const el = event.target, key = el.dataset.field;
    if (!editing() || !key) return;
    draft[key] = el.value;
    markEdited(key);
    if (key === "product_type") {
      $("custom-wrap").hidden = el.value !== "기타";
      if (el.value !== "기타") { draft.product_type_custom = ""; $("input-product_type_custom").value = ""; }
    }
    if (key === "product_type_custom") markEdited("product_type");
    el.removeAttribute("aria-invalid");
    el.classList.remove("is-error");
    updateSummary();
  });
  $("document").addEventListener("click", (event) => {
    if (!editing()) return;
    const country = event.target.closest("[data-country]");
    if (country) {
      $("input-export_countries").value = country.dataset.country;
      addChip("export_countries");
      return;
    }
    const add = event.target.closest("[data-add]"), remove = event.target.closest("[data-remove]");
    if (add) addChip(add.dataset.add);
    if (remove) {
      const key = remove.dataset.remove;
      draft[key].splice(Number(remove.dataset.index), 1);
      markEdited(key);
      const pendingValue = $("input-" + key).value;
      $("field-" + key).outerHTML = field(key);
      $("input-" + key).value = pendingValue;
      updateSummary();
      $("input-" + key).focus();
    }
  });
  $("document").addEventListener("keydown", (event) => {
    if (!editing() || event.isComposing || event.keyCode === 229) return;
    if (event.target.dataset.chip === "export_countries") {
      const el = event.target, list = $("country-list");
      if (event.key === "Escape") { event.preventDefault(); closeCountries(); return; }
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        if (list.hidden) showCountries();
        const options = [...list.querySelectorAll("[data-country]")];
        if (!options.length) return;
        const currentIndex = options.findIndex((option) => option.id === el.getAttribute("aria-activedescendant"));
        const index = currentIndex < 0 ? (event.key === "ArrowDown" ? 0 : options.length - 1) :
          (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        options.forEach((option, i) => option.setAttribute("aria-selected", String(i === index)));
        el.setAttribute("aria-activedescendant", options[index].id);
        options[index].scrollIntoView({ block: "nearest" });
        return;
      }
      if (event.key === "Enter" && !list.hidden) {
        const active = document.getElementById(el.getAttribute("aria-activedescendant"));
        if (active) el.value = active.dataset.country;
      }
    }
    if (event.key === "Enter" && event.target.dataset.chip && !event.isComposing) {
      event.preventDefault();
      addChip(event.target.dataset.chip);
    }
  });
  function selectMode(mode) {
    if (!["upload", "manual"].includes(state)) return;
    if (mode === "manual" && state !== "manual") {
      draft = draft || blank();
      transition("manual");
    } else if (mode === "auto" && state === "manual") {
      ["export_countries", "buyer_prohibited_ingredients"].forEach((key) => {
        const value = $("input-" + key).value.trim();
        if (value && draft[key].length < 50 && !draft[key].includes(value)) draft[key].push(value);
      });
      transition("upload");
    }
    $(mode).focus({ preventScroll: true });
  }
  ["auto", "manual"].forEach((mode, index) => {
    $(mode).addEventListener("click", () => selectMode(mode));
    $(mode).addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "auto" : event.key === "End" ? "manual" : ["auto", "manual"][1 - index];
      selectMode(next);
    });
  });
  $("secondary").addEventListener("click", () => {
    if (state === "result") { draft = clone(saved); transition("edit"); }
    else if (state === "edit") { draft = null; transition("result"); }
    else if (confirm("작성 중인 내용을 취소할까요?")) { draft = null; transition("upload"); }
  });
  $("new").addEventListener("click", () => {
    if (!confirm("새 요청서를 시작하면 현재 요청서가 지워져요. 계속할까요?")) return;
    saved = draft = originalFile = null;
    $("file").value = "";
    transition("upload");
  });
  $("document").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state === "result") { await printPDF(); return; }
    // 추가 버튼을 누르지 않은 마지막 국가/원료도 완료 시 반영합니다.
    const pendingChips = ["export_countries", "buyer_prohibited_ingredients"].map((key) => [key, $("input-" + key).value.trim()]);
    for (const [key, value] of pendingChips) {
      if (!value) continue;
      $("input-" + key).value = value;
      addChip(key);
    }
    for (const key of ["customer", "product_name", "product_type_custom", "benchmark_product_name"]) draft[key] = draft[key].trim();
    const absent = missing(draft);
    if (absent.length) {
      render();
      absent.forEach((key) => {
        const el = $("input-" + (key === "product_type" && draft.product_type === "기타" ? "product_type_custom" : key));
        el.classList.add("is-error");
        el.setAttribute("aria-invalid", "true");
        el.setAttribute("aria-describedby", "requisition-error-" + key);
        $("error-" + key).hidden = false;
        $("error-" + key).textContent = labels[key] + " 항목을 입력해 주세요.";
      });
      $("input-" + (absent[0] === "product_type" && draft.product_type === "기타" ? "product_type_custom" : absent[0])).focus();
      return notice("필수 항목을 확인해 주세요: " + absent.map((key) => labels[key]).join(", "));
    }
    if (state === "edit") {
      const keys = [...Object.keys(labels), "product_type_custom", "benchmark_product_name"];
      if (keys.some((key) => JSON.stringify(draft[key]) !== JSON.stringify(saved[key]))) {
        draft.creation_method = saved.creation_method.startsWith("auto") ? "auto_edited" : "manual_edited";
        draft.version = saved.version + 1;
      }
    }
    saved = clone(draft);
    draft = null;
    transition("result");
  });
  async function convert(files) {
    if (state !== "upload") return;
    notice();
    if (files.length !== 1) return notice("파일을 한 개씩 업로드해 주세요.");
    const file = files[0];
    if (!/\.(pdf|docx|xlsx|png|jpe?g|webp)$/i.test(file.name)) return notice("지원하지 않는 파일 형식이에요. PDF, DOCX, XLSX 또는 이미지를 선택해 주세요.");
    if (!file.size || file.size > 20 * 1024 * 1024) return notice("0바이트 파일은 사용할 수 없으며, 최대 용량은 20MB예요.");
    const body = new FormData();
    body.append("file", file);
    body.append("customer", $("setting-customer").value.trim());
    body.append("source_language", $("source-language").value);
    body.append("target_language", $("target-language").value);
    body.append("recipients", "[]");
    const requestController = new AbortController();
    controller = requestController;
    const timer = setTimeout(() => requestController.abort("timeout"), 150000);
    transition("loading");
    $("loading-file").textContent = file.name;
    try {
      const response = await fetch(root.dataset.convertUrl, { method: "POST", body, signal: requestController.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "변환하지 못했어요. 잠시 후 다시 시도해 주세요.");
      if (controller !== requestController) return;
      saved = payload.document;
      originalFile = file; // 원본은 페이지 메모리에서만 보존합니다.
      transition("result");
    } catch (error) {
      if (controller !== requestController) return;
      transition("upload");
      notice(requestController.signal.aborted ? "변환 시간이 초과됐어요. 다시 업로드하거나 직접 작성해 주세요." : error instanceof SyntaxError ? "서버 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요." : error.message);
    } finally {
      clearTimeout(timer);
      if (controller === requestController) controller = null;
      $("file").value = "";
    }
  }
  $("file").addEventListener("change", (event) => { if (event.target.files.length) convert([...event.target.files]); });
  $("drop").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); $("file").click(); }
  });
  $("cancel-convert").addEventListener("click", () => {
    if (controller) controller.abort();
    controller = null;
    $("file").value = "";
    transition("upload");
  });
  let dragDepth = 0;
  $("drop").addEventListener("dragenter", (event) => { event.preventDefault(); dragDepth++; $("drop").classList.add("is-dragover"); });
  $("drop").addEventListener("dragover", (event) => event.preventDefault());
  $("drop").addEventListener("dragleave", () => { if (--dragDepth <= 0) $("drop").classList.remove("is-dragover"); });
  $("drop").addEventListener("drop", (event) => {
    event.preventDefault(); dragDepth = 0; $("drop").classList.remove("is-dragover");
    convert([...event.dataTransfer.files]);
  });
  async function printPDF() {
    if (!saved || state !== "result") return;
    $("primary").disabled = true;
    try {
      const data = clone(saved);
      const date = new Date(), datePart = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("");
      const safePart = (value) => String(value || "Unknown").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, "").slice(0, 70);
      const filename = "DevelopmentRequest_" + safePart(data.customer) + "_" + safePart(data.product_name) + "_" + data.target_language.toUpperCase() + "_" + datePart + "_v" + data.version;
      const rows = [...Object.keys(labels).map((key) => [labels[key], fieldValue(data, key) || "미입력"]),
        ["벤치마크 제품명", data.benchmark_product_name || "미입력"]];
      if (data.buyer_prohibited_ingredients.length || data.regulatory_restricted_ingredients.length) {
        rows[5][1] = [
          data.buyer_prohibited_ingredients.length ? "바이어 지정: " + data.buyer_prohibited_ingredients.join(", ") : "",
          data.regulatory_restricted_ingredients.length ? "규제 검토 대상: " + data.regulatory_restricted_ingredients.join(", ") : ""
        ].filter(Boolean).join("\n");
      }
      const printHtml = '<main><h1>개발요청서</h1><dl>' +
        rows.map(([label, value]) => "<div><dt>" + escape(label) + "</dt><dd>" + escape(value) + "</dd></div>").join("") +
        "</dl><footer>v" + data.version + " · " + datePart + "<br>수출 대상국의 규제 확인이 필요해요.</footer></main>";
      const pdfRoot = document.createElement("div");
      pdfRoot.innerHTML = printHtml;
      pdfRoot.style.cssText = "position:fixed;left:-100000px;top:0;width:180mm;padding:0;background:#fff;color:#202733;font-family:Arial,sans-serif";
      pdfRoot.querySelector("main").style.cssText = "width:180mm;margin:0 auto";
      pdfRoot.querySelector("h1").style.cssText = "font-size:22px;text-align:center;margin:0 0 24px";
      pdfRoot.querySelector("dl").style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:0;border-top:2px solid #6b7280;margin:0";
      pdfRoot.querySelectorAll("dl div").forEach((row, index) => { row.style.cssText = "display:grid;grid-template-columns:30mm minmax(0,1fr);border-bottom:1px solid #d4d7dc;break-inside:avoid"; if (index % 2 === 0) row.style.borderRight = "1px solid #d4d7dc"; if (index === rows.length - 1) { row.style.gridColumn = "1 / -1"; row.style.borderRight = "0"; } });
      pdfRoot.querySelectorAll("dt").forEach((label) => { label.style.cssText = "display:block;margin:0;padding:4mm 3mm;background:#eceef1;border-right:1px solid #d4d7dc;font-size:10pt;font-weight:700"; });
      pdfRoot.querySelectorAll("dd").forEach((value) => { value.style.cssText = "margin:0;padding:4mm 3mm;min-width:0;font-size:10pt;overflow-wrap:anywhere;white-space:pre-wrap"; });
      pdfRoot.querySelector("footer").style.cssText = "font-size:9pt;margin-top:24px;color:#64748b";
      if (printFrame) printFrame.remove();
      const frame = document.createElement("iframe");
      printFrame = frame;
      frame.className = "requisition-print-frame";
      frame.title = "개발요청서 PDF 저장";
      const loaded = new Promise((resolve) => { frame.onload = resolve; });
      frame.srcdoc = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>' + escape(filename) +
        '</title><style>@page{size:A4;margin:12mm}body{margin:0;color:#202733;font-family:Arial,sans-serif}*{box-sizing:border-box;print-color-adjust:exact}</style></head><body>' +
        pdfRoot.querySelector("main").outerHTML + '</body></html>';
      document.body.append(frame);
      await loaded;
      await frame.contentDocument.fonts.ready;
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch {
      notice("인쇄 창을 열지 못했어요. 다시 시도해 주세요.");
    } finally {
      $("primary").disabled = false;
    }
  }
  window.addEventListener("beforeunload", (event) => {
    if (saved || editing() || state === "loading" || originalFile) { event.preventDefault(); event.returnValue = ""; }
  });
  render();
})();

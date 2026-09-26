(() => {
  "use strict";
  const $ = (id) => document.getElementById("requisition-" + id);
  const root = $("app");
  if (!root) return;
  const types = ["스킨케어", "베이스 메이크업", "립", "아이", "바디", "헤어", "클렌징", "선케어", "기타"];
  const tiers = { low: "저가", mid: "중가", high: "고가" };
  const sections = JSON.parse($("schema").textContent);
  const definitions = sections.flatMap(([, fields]) => fields);
  const labels = Object.fromEntries(definitions.map(([key, label]) => [key, label]));
  const kinds = Object.fromEntries(definitions.map(([key, , kind]) => [key, kind]));
  labels.reference_notes = "기타사항";
  kinds.reference_notes = "textarea";
  const chipFields = definitions.filter(([, , kind]) => kind === "list").map(([key]) => key);
  const get = (data, key) => key.split(".").reduce((value, part) => value?.[part], data);
  function set(data, key, value) {
    const parts = key.split("."), last = parts.pop();
    const parent = parts.reduce((obj, part) => (obj[part] ||= {}), data);
    parent[last] = value;
  }
  const countries = ["미국", "캐나다", "중국", "일본", "한국", "프랑스", "독일", "영국", "호주", "베트남", "태국", "인도네시아", "싱가포르", "인도", "아랍에미리트", "사우디아라비아"];
  const methods = { auto: "자동변환", auto_edited: "자동변환 후 수정", manual: "직접 작성", manual_edited: "직접 작성 후 수정" };
  let state = "upload", saved = null, draft = null, originalFile = null, controller = null;
  let printFrame = null;
  let activeSection = 0;
  const sectionTitles = [...sections.map(([title]) => title), "05 참고자료"];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const filled = (value) => Array.isArray(value) ? value.length > 0 : Boolean(String(value ?? "").trim());
  const editing = () => state === "edit" || state === "manual";
  const current = () => editing() ? draft : saved;
  const blank = () => ({
    document_id: crypto.randomUUID ? crypto.randomUUID() : "request-" + Date.now(),
    creation_method: "manual", customer: "", request_source: "", source_language: "", target_language: $("target-language").value,
    product_name: "", sample_request_type: "", product_type: "", product_type_custom: "", target_price_tier: "",
    export_countries: [], buyer_prohibited_ingredients: [], regulatory_restricted_ingredients: [],
    benchmark_product_name: "", review_status: "needs_review",
    source_file: "", version: 1, field_provenance: [], raw_extracted_data: {}, reference_files: [], reference_notes: "",
    product_development: Object.fromEntries(definitions.filter(([key]) => key.startsWith("product_development.")).map(([key]) => [key.split(".")[1], ""])),
    ingredients: { necessary: [], ideal: [], other_notes: "" },
    quality: { tests: [], additional_notes: "" }
  });
  function notice(message = "") {
    $("notice").textContent = message;
    $("notice").hidden = !message;
  }
  function missing(data) {
    return ["customer", "request_source", "product_name", "sample_request_type", "product_type", "export_countries"].filter((key) =>
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
    const value = get(data, key);
    if (kinds[key] === "required") return value === true ? "필요" : value === false ? "불필요" : "확인 필요";
    return Array.isArray(value) ? value.join(", ") : value;
  }
  function input(key, placeholder = "") {
    return '<input class="form-control" id="requisition-input-' + key + '" data-field="' + key + '" maxlength="10000" value="' + escape(get(current(), key)) + '" placeholder="' + escape(placeholder) + '">';
  }
  function chips(key, title) {
    const values = get(current(), key);
    const isCountry = key === "export_countries";
    return '<div class="requisition-chips">' + values.map((value, index) =>
      '<span class="multi-select__chip">' + escape(value) + '<button type="button" class="multi-select__remove" data-remove="' + key + '" data-index="' + index + '" aria-label="' + escape(value) + ' 삭제">×</button></span>').join("") +
      '</div><div class="requisition-chip-entry"><div class="requisition-chip-input"><input class="form-control form-control-sm" id="requisition-input-' + key + '" data-chip="' + key + '" maxlength="100" placeholder="' + title + '" aria-label="' + title + '"' + (isCountry ? ' role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="requisition-country-list" aria-describedby="requisition-country-help" autocomplete="off"' : "") + '>' +
      (isCountry ? '<div id="requisition-country-list" class="requisition-country-list" role="listbox" aria-label="수출 대상국" hidden></div>' : "") +
      '</div><button type="button" class="btn btn-secondary btn-sm" data-add="' + key + '">추가</button></div>' +
      (isCountry ? '<p class="form-help" id="requisition-country-help">목록에서 선택하거나, 없는 국가는 직접 입력한 뒤 Enter 또는 추가 버튼을 눌러 주세요.</p>' : "");
  }
  function field(key) {
    const data = current(), required = ["customer", "request_source", "product_name", "sample_request_type", "product_type", "export_countries"].includes(key);
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
    } else if (key === "request_source") {
      control = '<div class="requisition-choice-buttons" role="radiogroup" aria-label="요청 구분">' + ["고객사 요청", "자사기획"].map((value, index) =>
        '<label class="requisition-choice' + (data[key] === value ? ' is-selected' : '') + '"><input type="radio"' + (index === 0 ? ' id="requisition-input-request_source"' : '') + ' name="requisition-request-source" data-field="request_source" value="' + value + '"' + (data[key] === value ? ' checked' : '') + '><span>' + value + '</span></label>').join("") + "</div>";
    } else if (key === "sample_request_type") {
      control = '<div class="requisition-choice-buttons" role="radiogroup" aria-label="샘플 구분">' + ["신규 샘플", "개선 샘플"].map((value, index) =>
        '<label class="requisition-choice' + (data[key] === value ? ' is-selected' : '') + '"><input type="radio"' + (index === 0 ? ' id="requisition-input-sample_request_type"' : '') + ' name="requisition-sample-type" data-field="sample_request_type" value="' + value + '"' + (data[key] === value ? ' checked' : '') + '><span>' + value + '</span></label>').join("") + "</div>";
    } else if (key === "target_price_tier") {
      control = '<div class="requisition-options" role="group" aria-label="목표 가격대">' + [["", "미정"], ...Object.entries(tiers)].map(([value, name]) =>
        '<label class="form-check"><input type="radio" name="requisition-tier" data-field="target_price_tier" value="' + value + '"' + (data[key] === value ? " checked" : "") + ">" + name + "</label>").join("") + "</div>";
    } else if (kinds[key] === "required" || kinds[key] === "application") {
      const options = kinds[key] === "required" ? [["", "확인 필요"], ["true", "필요"], ["false", "불필요"]] : [["", "선택하세요"], ...["Leave-on", "Rinse-off", "기타", "확인 필요"].map((v) => [v, v])];
      control = '<select class="form-control" id="requisition-input-' + key + '" data-field="' + key + '">' + options.map(([value, label]) => '<option value="' + value + '"' + (String(get(data, key) ?? "") === value ? " selected" : "") + '>' + label + '</option>').join("") + '</select>';
    } else if (kinds[key] === "textarea") {
      control = '<textarea class="form-control" rows="4" maxlength="10000" id="requisition-input-' + key + '" data-field="' + key + '">' + escape(get(data, key)) + '</textarea>';
    } else if (chipFields.includes(key)) {
      control = chips(key, key === "export_countries" ? "국가 선택 또는 입력" : labels[key] + " 입력");
      if (key === "buyer_prohibited_ingredients") control += '<p class="form-help">바이어가 사용하지 말라고 지정한 원료를 입력해요.</p>' +
        (data.regulatory_restricted_ingredients.length ? '<p class="form-help">규제 검토 대상: ' + escape(data.regulatory_restricted_ingredients.join(", ")) + " · 규제 확인 필요</p>" : "");
    } else control = input(key, labels[key] + " 입력");
    const provenance = (data.field_provenance || []).find((item) => item.field_key === key);
    if (!editing() && provenance) {
      if (provenance.review_status === "not_applicable") control = '<p class="requisition-field-value">해당 없음</p>';
      control += '<small class="text-caption">' + ({ confirmed: "✓ 확인 완료", needs_review: "⚠ 확인 필요", missing: "미입력", not_applicable: "해당 없음", user_edited: "✓ 사용자 수정" }[provenance.review_status] || "") + '</small>';
    }
    return '<div class="form-group" id="requisition-field-' + key + '">' +
      (editing() && key !== "target_price_tier" ? '<label class="form-label" for="requisition-input-' + key + '">' : '<p class="form-label">') +
      labels[key] + (editing() && required ? ' <span class="is-required">*</span>' : "") +
      (editing() && key !== "target_price_tier" ? "</label>" : "</p>") + '<div class="requisition-field-content">' + control +
      '<p class="form-error" id="requisition-error-' + key + '" hidden></p></div></div>';
  }
  $("section-tabs").innerHTML = sectionTitles.map((title, index) =>
    '<button type="button" class="tab" id="requisition-section-tab-' + index + '" role="tab" aria-controls="requisition-section-' + index + '" aria-selected="false" tabindex="-1" data-section="' + index + '">' + escape(title) + '</button>').join("");
  function selectSection(index, focus = false) {
    activeSection = index;
    sectionTitles.forEach((title, i) => {
      const active = i === index, tab = $("section-tab-" + i);
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      $("section-" + i).hidden = !active;
    });
    $("basic-title").textContent = sectionTitles[index];
    if (focus) $("section-tab-" + index).focus({ preventScroll: true });
  }
  $("section-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-section]");
    if (tab) selectSection(Number(tab.dataset.section));
  });
  $("section-tabs").addEventListener("keydown", (event) => {
    const tab = event.target.closest("[data-section]");
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = Number(tab.dataset.section), count = sectionTitles.length;
    const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + count) % count;
    selectSection(next, true);
  });
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
    const headings = { upload: "개발요청서 분석", loading: "개발요청서 분석", result: "개발요청서", edit: "개발요청서 수정", manual: "개발요청서 직접 작성" };
    $("title").textContent = headings[state];
    $("description").textContent = state === "upload" || state === "loading" ? "바이어 요청서를 변환하거나 직접 작성하여 개발팀에 전달해요." :
      editing() ? "필수 항목을 입력하고 개발팀에 전달할 요청서를 완성해요." : "내용을 확인하고 필요하면 수정한 뒤 PDF로 저장해요.";
    if (state === "upload" || state === "loading") return;
    const data = current();
    $("fields").innerHTML = sections.map(([title, fields], index) => '<section class="requisition-section" id="requisition-section-' + index + '" role="tabpanel" aria-labelledby="requisition-section-tab-' + index + '" tabindex="0"><h2 class="card-title">' + escape(title) + '</h2><div class="requisition-fields">' + fields.map(([key]) => field(key)).join("") + '</div></section>').join("");
    selectSection(activeSection);
    renderReferences();
    $("panel-title").textContent = editing() ? "작성 상태" : "문서 정보";
    $("form-help").textContent = editing() ? "* 표시된 항목은 필수 입력이에요." : "개발에 필요한 핵심 정보를 확인해요.";
    $("secondary").textContent = state === "result" ? "수정" : state === "edit" ? "수정 취소" : "작성 취소";
    $("primary").textContent = state === "result" ? "인쇄 / PDF 저장" : state === "edit" ? "수정 완료" : "작성 완료";
    $("primary").hidden = false;
    $("erp").hidden = state !== "result";
    $("pdf-help").hidden = editing();
    updateSummary();
  }
  function updateSummary() {
    const data = current();
    if (!data) return;
    const required = missing(data), checks = reviews(data);
    $("method").textContent = methods[data.creation_method];
    $("count-label").textContent = editing() ? "채운 항목" : "입력 완료";
    $("count").textContent = Object.keys(labels).filter((key) => filled(get(data, key)) && !(key === "product_type" && required.includes(key))).length + " / " + definitions.length;
    $("export-review").textContent = data.export_countries.length ? data.export_countries.join(", ") + " · ⚠ 규제 확인 필요" : "미입력";
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
    let item = draft.field_provenance.find((entry) => entry.field_key === key);
    if (!item) {
      item = { field_key: key, source_value: "", translated_value: null, source_page: "", source_language: draft.source_language, target_language: draft.target_language };
      draft.field_provenance.push(item);
    }
    if (item) {
      item.user_value = clone(get(draft, key));
      item.input_source = "user_edited";
      item.review_status = "user_edited";
    }
  }
  function addChip(key) {
    const el = $("input-" + key), value = el.value.trim();
    if (!value) return;
    if (get(draft, key).length >= 50) return notice("한 항목에 최대 50개까지 추가할 수 있어요.");
    if (!get(draft, key).some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) get(draft, key).push(value);
    markEdited(key);
    if (key === "sample_request_type" || key === "request_source") render();
    $("field-" + key).outerHTML = field(key);
    updateSummary();
    $("input-" + key).focus();
  }
  function referenceMarkup(data, printable = false) {
    return (data.reference_files || []).map((file, index) => '<figure class="requisition-reference">' +
      (/^data:image\/(png|jpeg|webp);base64,/.test(file.data_url || "") ? '<img src="' + escape(file.data_url) + '" alt="' + escape(file.name) + '" style="max-width:100%;max-height:65mm">' : '') +
      '<figcaption>' + escape(file.name) + '</figcaption>' +
      (!printable ? '<a download="' + escape(file.name) + '" href="' + escape(file.data_url) + '">다운로드</a>' : '') +
      (!printable && editing() ? '<button type="button" class="btn btn-secondary btn-sm" data-remove-reference="' + index + '">삭제</button>' : '') + '</figure>').join("");
  }
  function renderReferences() {
    $("references").innerHTML = '<div class="requisition-reference-grid">' + referenceMarkup(current()) + '</div>' +
      (originalFile ? '<button type="button" class="btn btn-secondary" data-original-file>원본 RFP 다운로드</button>' : '') +
      (editing() ? '<div class="requisition-reference-upload"><div><p class="form-label">참고자료 추가</p><p class="form-help">PNG, JPG, WEBP, PDF, DOCX, XLSX · 파일당 5MB · 전체 20MB</p></div><input class="requisition-file-input" type="file" id="requisition-reference-input" multiple accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.xlsx"><label class="btn btn-soft" for="requisition-reference-input"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/></svg>파일 선택</label></div><p class="form-help requisition-reference-help">선택한 이미지는 PDF에 함께 표시되고, 문서는 파일명으로 표시돼요.</p>' : !(current().reference_files || []).length ? '<div class="requisition-reference-empty"><p>등록된 참고자료가 없어요.</p></div>' : '') +
      '<div class="form-group requisition-reference-notes"><label class="form-label" for="requisition-input-reference_notes">기타사항</label><div class="requisition-field-content">' +
      (editing() ? '<textarea class="form-control" rows="4" maxlength="10000" id="requisition-input-reference_notes" data-field="reference_notes">' + escape(current().reference_notes || "") + '</textarea>' : '<p class="requisition-field-value">' + escape(current().reference_notes || "미입력") + '</p>') + '</div></div>';
  }
  $("document").addEventListener("change", async (event) => {
    if (!editing()) return;
    if (event.target.id !== "requisition-reference-input") return;
    const activeDraft = draft;
    const files = [...event.target.files];
    $("primary").disabled = true;
    try {
      for (const file of files) {
        if (!/\.(png|jpe?g|webp|pdf|docx|xlsx)$/i.test(file.name) || !file.size || file.size > 5 * 1024 * 1024) throw new Error("참고자료 형식과 크기(최대 5MB)를 확인해 주세요.");
        if (activeDraft.reference_files.length >= 20 || activeDraft.reference_files.reduce((total, item) => total + item.size, 0) + file.size > 20 * 1024 * 1024) throw new Error("참고자료는 최대 20개, 전체 20MB까지 추가할 수 있어요.");
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("참고자료를 읽지 못했어요."));
          reader.readAsDataURL(file);
        });
        if (draft !== activeDraft || !editing()) return;
        activeDraft.reference_files.push({ name: file.name, size: file.size, data_url: dataUrl });
      }
      markEdited("reference_files");
    } catch (error) { notice(error.message); }
    finally { $("primary").disabled = false; if (draft === activeDraft && editing()) renderReferences(); }
  });
  $("references").addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-reference]");
    if (remove && editing()) {
      draft.reference_files.splice(Number(remove.dataset.removeReference), 1);
      markEdited("reference_files");
      renderReferences();
    }
    if (event.target.closest("[data-original-file]") && originalFile) {
      const url = URL.createObjectURL(originalFile), link = document.createElement("a");
      link.href = url; link.download = originalFile.name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });
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
    set(draft, key, kinds[key] === "required" ? (el.value === "" ? null : el.value === "true") : el.value);
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
      get(draft, key).splice(Number(remove.dataset.index), 1);
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
      if (!draft.customer) draft.customer = $("setting-customer").value.trim();
      transition("manual");
    } else if (mode === "auto" && state === "manual") {
      chipFields.forEach((key) => {
        const value = $("input-" + key).value.trim();
        if (value && get(draft, key).length < 50 && !get(draft, key).includes(value)) get(draft, key).push(value);
      });
      transition("upload");
    }
    if (state === "upload") $(mode).focus({ preventScroll: true });
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
    activeSection = 0;
    $("file").value = "";
    transition("upload");
  });
  $("erp").addEventListener("click", () => {
    alert("ERP 연동 기능은 현재 개발 중입니다.");
  });
  $("document").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state === "result") { await printPDF(); return; }
    // 추가 버튼을 누르지 않은 마지막 국가/원료도 완료 시 반영합니다.
    const pendingChips = chipFields.map((key) => [key, $("input-" + key).value.trim()]);
    for (const [key, value] of pendingChips) {
      if (!value) continue;
      $("input-" + key).value = value;
      addChip(key);
    }
    for (const key of ["customer", "product_name", "product_type_custom", "benchmark_product_name"]) draft[key] = draft[key].trim();
    const absent = missing(draft);
    if (absent.length) {
      activeSection = sections.findIndex(([, fields]) => fields.some(([key]) => key === absent[0]));
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
      const keys = [...Object.keys(labels), "product_type_custom", "benchmark_product_name", "reference_files"];
      if (keys.some((key) => JSON.stringify(get(draft, key)) !== JSON.stringify(get(saved, key)))) {
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
      const filename = "DevelopmentRequest_" + safePart(data.customer) + "_" + safePart(data.product_name) + "_" + datePart;
      const pdfValue = (key) => {
        const provenance = data.field_provenance.find((item) => item.field_key === key);
        if (provenance?.review_status === "not_applicable") return "해당 없음";
        return fieldValue(data, key) || (provenance?.review_status === "needs_review" ? "확인 필요" : "미입력");
      };
      const prohibitedIngredients = [
          data.buyer_prohibited_ingredients.length ? "바이어 지정: " + data.buyer_prohibited_ingredients.join(", ") : "",
          data.regulatory_restricted_ingredients.length ? "규제 검토 대상: " + data.regulatory_restricted_ingredients.join(", ") : ""
        ].filter(Boolean).join("\n");
      const issuedDate = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join(".");
      const row = (label, value) => '<tr><th scope="row">' + escape(label) + '</th><td>' + escape(value) + '</td></tr>';
      const printableSection = ([title, fields]) => {
        const rows = fields.map(([key, label]) => [label, key === "buyer_prohibited_ingredients" ? prohibitedIngredients : fieldValue(data, key)])
          .filter(([, value]) => filled(value));
        return rows.length ? '<section><h2>' + escape(title) + '</h2><table class="requirements"><colgroup><col class="label-column"><col></colgroup><thead><tr><th scope="col">항목</th><th scope="col">요청 내용</th></tr></thead><tbody>' +
          rows.map(([label, value]) => row(label, value)).join('') + '</tbody></table></section>' : '';
      };
      const printableReferences = referenceMarkup(data, true);
      const printableReferenceNotes = filled(data.reference_notes) ? '<table class="requirements"><tbody>' + row("기타사항", data.reference_notes) + '</tbody></table>' : '';
      const referenceSection = printableReferences || printableReferenceNotes ? '<section class="references"><h2>05 참고자료</h2>' + printableReferences + printableReferenceNotes + '</section>' : '';
      const printHtml = '<main><header class="document-header"><div class="brand">COSTD <span>COSMOA</span></div>' +
        '<p class="document-type">연구소 전달용</p><h1>제품 개발 요청서</h1><p class="subtitle">PRODUCT DEVELOPMENT REQUEST</p></header>' +
        '<table class="document-meta"><caption>문서 정보</caption><tbody>' +
        '<tr><th scope="row">문서 ID</th><td colspan="3">' + escape(data.document_id || "미지정") + '</td></tr>' +
        '<tr><th scope="row">출력일</th><td colspan="3">' + issuedDate + '</td></tr>' +
        '<tr><th scope="row">수신</th><td>연구소</td><th scope="row">작성 방식</th><td>' + escape(methods[data.creation_method] || "미지정") + '</td></tr></tbody></table>' +
        sections.map(printableSection).join('') + referenceSection +
        '<footer><strong>COSTD · COSMOA</strong><span>수출 대상국별 규제 적합성은 별도 확인이 필요합니다.</span></footer></main>';
      const printStyles = `
        @page { size: A4; margin: 14mm 14mm 16mm; }
        * { box-sizing: border-box; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
        body { margin: 0; color: #202733; background: #fff; font: 9pt/1.55 "Malgun Gothic", "Apple SD Gothic Neo", Arial, sans-serif; }
        .document-header { position: relative; border-top: 3px solid #24364b; padding: 5mm 0 6mm; }
        .brand { font-size: 15pt; font-weight: 800; letter-spacing: 1px; }
        .brand span { margin-left: 2mm; font-size: 8pt; font-weight: 400; color: #596574; }
        .document-type { position: absolute; top: 5mm; right: 0; margin: 0; font-size: 9pt; }
        h1 { margin: 4mm 0 1mm; text-align: center; font-size: 24pt; letter-spacing: 3px; }
        .subtitle { margin: 0; text-align: center; font-size: 8pt; letter-spacing: 2px; color: #596574; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        caption { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
        th, td { border: 1px solid #9ca6b1; padding: 2.5mm 3mm; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
        th { background: #eef1f4; font-weight: 700; }
        td { white-space: pre-wrap; }
        .document-meta { margin-bottom: 6mm; }
        .document-meta th { width: 26mm; }
        .label-column { width: 36mm; }
        section { margin-top: 5mm; }
        h2 { margin: 0 0 2mm; padding: 0 0 2mm; border-bottom: 2px solid #24364b; font-size: 11pt; break-after: avoid; }
        thead { display: table-header-group; }
        thead th { background: #dfe5eb; font-size: 8pt; }
        tr { break-inside: avoid; }
        p { orphans: 3; widows: 3; }
        .requisition-reference { margin: 0 0 3mm; padding: 3mm; border: 1px solid #9ca6b1; break-inside: avoid; }
        .requisition-reference img { display: block; margin: 0 auto 2mm; object-fit: contain; }
        figcaption { font-size: 8pt; overflow-wrap: anywhere; }
        .empty-reference { border: 1px solid #9ca6b1; padding: 3mm; margin: 0; color: #596574; }
        .review-signoff { break-inside: avoid; }
        .review-space { height: 22mm; }
        footer { margin-top: 6mm; padding-top: 3mm; border-top: 1px solid #24364b; font-size: 8pt; color: #596574; }
        footer span { float: right; }
      `;
      if (printFrame) printFrame.remove();
      const frame = document.createElement("iframe");
      printFrame = frame;
      frame.className = "requisition-print-frame";
      frame.title = "개발요청서 PDF 저장";
      const loaded = new Promise((resolve) => { frame.onload = resolve; });
      frame.srcdoc = '<!doctype html><html lang="' + escape(data.target_language) + '"><head><meta charset="utf-8"><title>' + escape(filename) +
        '</title><style>' + printStyles + '</style></head><body>' + printHtml + '</body></html>';
      document.body.append(frame);
      await loaded;
      await frame.contentDocument.fonts.ready;
      await Promise.all([...frame.contentDocument.images].map((img) => img.decode().catch(() => {})));
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

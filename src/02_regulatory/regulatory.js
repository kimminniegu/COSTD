/* 국가별 인허가 규제 전용 JavaScript (담당자 B)
   이 페이지에서만 필요한 로직만 작성합니다.
   다른 페이지의 JS를 수정하거나 의존하지 않습니다. 공통 동작(탭·Modal)은 src/common/common.js 를 그대로 사용합니다.

   직접 검색 (현재 구현)
   - 성분명(한글명 또는 영문 INCI명) + 시장. 서버가 언어에 맞는 엔드포인트를 고릅니다 (둘 다 '시작 일치', 영문 대소문자 무시)
   - 자동완성: 앞뒤 공백 제거 후 2글자 이상이면 입력이 멈춘 뒤 300ms 후 /api/regulatory/ingredients 로 후보 조회 → 검색창 아래 최대 10개
     · 한글 조합(IME composition) 중에는 요청하지 않고 조합이 끝난 뒤 조건을 다시 확인합니다
     · 현재 입력에 대응하는 최신 응답만 반영하고, 이전 검색어의 늦은 응답과 닫힌 목록에 도착한 응답은 무시합니다
   - 후보 선택(클릭 · ↑↓ + Enter)은 성분만 확정하고 규제 조회를 실행하지 않습니다. Esc·바깥 클릭으로 닫습니다
   - 검색어를 수정하면 확정된 성분을 해제합니다
   - 성분이 확정된 상태에서 검색 버튼 → /api/regulatory/regulations 로 선택 시장 규제 조회 → 결과 카드 + 상세 Modal
   - 후보를 고르지 않고 검색 버튼 → 후보 조회 후 입력과 정확히 일치하는 후보가 하나뿐이면 확정하고 같은 클릭에서 규제 조회,
     여러 후보면 목록을 열어 사용자 선택을 받습니다 (명세 7항 6). 임의로 첫 후보를 확정하지 않습니다
   - 결과 카드: 성분명·영문명·시장, 조회 상태, 규제 유형(원문), 규제 조건(원문을 항목별로 나눌 수 있으면 나눠서, 아니면 원문 그대로)
   - 규제 데이터 미확인(no_data) / 판단 보류(hold) / API 오류를 서로 다른 상태로 표시합니다. 적합성·안전성 판정은 하지 않습니다.
   파일로 일괄 조회 (이번 단계: 업로드 → 시트 선택 → 성분 추출 → 확인·수정)
   - POST /api/regulatory/extract 로 텍스트 PDF·.xlsx 를 보내 성분명·함량(문서에 있을 때만)을 받아 표로 표시합니다
   - 여러 시트면 서버가 sheet_required 를 돌려주고, 시트를 고르면 같은 파일을 sheet 와 함께 다시 보냅니다
   - 표에서 성분명·함량 수정, 행 추가·삭제, 조회 포함 체크. 원문값은 별도로 남겨 둡니다
   - 처리 중 / 완료 / 실패(형식 미지원·읽기 실패·제한 초과) / 추출 결과 없음을 구분합니다
   성분 확인·규제 일괄 조회 (이번 단계)
   - '성분 확인' → 조회 포함 행의 성분명으로 /api/regulatory/ingredients 를 순차 호출 (같은 이름은 1회). 정확 일치 하나만 자동 확정,
     복수 후보는 행의 select 로 사용자가 선택, 후보 없음은 '성분 확인 필요'. 성분명을 고치면 그 행의 매칭·결과를 지웁니다
   - '확정 성분 규제 조회' → 확정 행만 /api/regulatory/regulations 를 (성분 코드, 시장)당 1회 순차 호출해 각 행에 연결.
     429(rate_limit) 는 즉시 중단, 실패 행만 '실패 항목 재시도'. 시장·목록·매칭이 바뀌면 '이전 조건의 결과' 안내, 늦은 응답은 순번으로 무시
   - 결과 표: 성분명·선택 시장·조회 상태·규제 유형·상세. 상세 Modal 에 규제 조건을 영문 위·한국어 아래로 표시. 함량은 문서 참고값만, 적합 판정 없음
   OCR (이번 단계): PNG·JPG 와 텍스트 없는 PDF 쪽은 서버가 로컬 Tesseract 로 읽어 같은 표에 연결. OCR 행은 '확인 필요(OCR)' 로 표시,
     OCR 미설치는 서버 503(ocr_unavailable) + 설치 안내를 그대로 보여 주고 텍스트 PDF·Excel 은 계속 동작.
   미구현(후속): 중간 포함 검색, 함량 기준 비교(검토 상태). */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  function show(el, on) { if (el) el.hidden = !on; }

  function setText(el, text) { if (el) el.textContent = text == null || text === "" ? "—" : String(text); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function badge(text, variant) {
    return el("span", "badge" + (variant ? " badge-" + variant : ""), text);
  }

  function replaceChildren(node, child) {
    if (!node) return;
    node.innerHTML = "";
    if (child) node.appendChild(child);
  }

  function formatTime(iso) {
    if (!iso) return "—";
    return String(iso).replace("T", " ");
  }

  /* 준비 중 안내 (파일 탭 등 미구현 기능) ----------------------------------- */
  var devNotice = $("regulatory-dev-notice");

  function notReady(what) {
    if (!devNotice) return;
    var body = $("regulatory-dev-notice-body");
    if (body) { body.textContent = what + " 기능은 아직 준비 중이에요."; show(body, true); }
    devNotice.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* 서버 API 호출 ------------------------------------------------------------
     실패는 { kind, message, http_status? } 객체로 통일합니다. 서버 응답의 error 는 비밀값을 담지 않습니다. */
  function apiGet(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!body || typeof body !== "object") {
          throw { kind: "invalid_response", message: "서버 응답을 해석하지 못했어요. 잠시 후 다시 시도해 주세요." };
        }
        if (!res.ok || body.ok === false) {
          throw body.error || { kind: "http", message: "요청에 실패했어요 (HTTP " + res.status + ")." };
        }
        return body;
      });
    }, function () {
      throw { kind: "network", message: "서버에 연결하지 못했어요. 네트워크 상태를 확인해 주세요." };
    });
  }

  function apiPost(url, formData) {
    return fetch(url, { method: "POST", body: formData, headers: { Accept: "application/json" } }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!body || typeof body !== "object") {
          throw { kind: "invalid_response", message: "서버 응답을 해석하지 못했어요. 잠시 후 다시 시도해 주세요." };
        }
        if (!res.ok || body.ok === false) {
          throw body.error || { kind: "http", message: "요청에 실패했어요 (HTTP " + res.status + ")." };
        }
        return body;
      });
    }, function () {
      throw { kind: "network", message: "서버에 연결하지 못했어요. 네트워크 상태를 확인해 주세요." };
    });
  }

  /* 상세 Modal 을 body 바로 아래로 옮긴다 -------------------------------------
     공통 레이아웃의 main.container 에는 container-type: inline-size 와 진입 애니메이션(transform)이 있어
     그 안의 position: fixed 요소는 뷰포트가 아니라 컨테이너(페이지 전체 높이) 기준으로 배치된다.
     그러면 배경은 화면을 다 덮지만 Modal 창은 긴 페이지의 세로 정중앙(화면 밖)에 그려진다.
     공통 common.js 는 id 로 Modal 을 찾으므로 위치를 옮겨도 열기·닫기·ESC·배경 클릭은 그대로 동작한다. (공통 파일 수정 없음) */
  var detailModal = $("regulatory-detail-modal");
  if (detailModal && detailModal.parentNode !== document.body) document.body.appendChild(detailModal);

  /* ==========================================================================
     직접 검색: 상태
     ========================================================================== */
  var searchForm = $("regulatory-search-form");
  var input = $("regulatory-search-ingredient");
  var marketSelect = $("regulatory-search-market");
  var submitBtn = $("regulatory-search-submit");
  var submitLabel = submitBtn ? submitBtn.textContent : "";
  var optionsList = $("regulatory-autocomplete-options");
  var selectedLine = $("regulatory-search-selected");

  var state = {
    selected: null,       // 확정된 성분 후보 { code, kr_name, inci_name, ... }
    selectedText: "",     // 확정 당시 검색창 표시값 — 수정되면 선택 해제
    matchMethod: "",      // "후보 선택" | "정확 일치 자동 확정"
    candidates: [],
    activeIndex: -1,
    listOpen: false,
    lookupSeq: 0,         // 늦게 도착한 이전 응답 무시용 (검색 버튼 흐름)
    acSeq: 0,             // 자동완성 요청 순번 — 입력 변경·닫기 때마다 증가시켜 이전 응답을 무시
    acTimer: null,        // 300ms 디바운스 타이머
    composing: false,     // 한글 조합(IME) 중
    resultKey: null,      // 표시 중인 결과의 조건 키(성분 code|시장) — 현재 입력과 다르면 '이전 조건' 안내
  };

  var AC_MIN_LENGTH = 2;    // 자동완성 최소 글자 수 (앞뒤 공백 제거 후)
  var AC_DEBOUNCE_MS = 300; // 입력이 멈춘 뒤 대기 시간

  function normalize(text) { return (text || "").trim().toLowerCase(); }

  function marketLabel(code) {
    if (!marketSelect) return code;
    for (var i = 0; i < marketSelect.options.length; i++) {
      if (marketSelect.options[i].value === code) return marketSelect.options[i].text;
    }
    return code;
  }

  function setBusy(on, label) {
    if (!submitBtn) return;
    submitBtn.disabled = on;
    submitBtn.innerHTML = "";
    if (on) {
      submitBtn.appendChild(el("span", "spinner spinner-sm"));
      submitBtn.appendChild(document.createTextNode(" " + (label || "조회 중")));
    } else {
      submitBtn.textContent = submitLabel;
    }
  }

  /* 후보 목록: closed | loading | empty | error | list — 한 상태만 표시 */
  function setAutocomplete(st) {
    var list = $("regulatory-autocomplete-list");
    if (!list) return;
    var open = st !== "closed";
    if (!open) { state.acSeq++; clearTimeout(state.acTimer); }   // 닫힌 목록이 진행 중 응답으로 다시 열리지 않게
    state.listOpen = open;
    show(list, open);
    if (input) input.setAttribute("aria-expanded", String(open));
    list.querySelectorAll("[data-ac-state]").forEach(function (node) {
      show(node, open && node.getAttribute("data-ac-state") === st);
    });
    if (!open) setActive(-1);
  }

  function setActive(index) {
    state.activeIndex = index;
    if (!optionsList) return;
    var items = optionsList.querySelectorAll(".regulatory-autocomplete__option");
    items.forEach(function (li, i) {
      var active = i === index;
      li.classList.toggle("is-active", active);
      li.setAttribute("aria-selected", String(active));
      if (active) {
        if (input) input.setAttribute("aria-activedescendant", li.id);
        if (li.scrollIntoView) li.scrollIntoView({ block: "nearest" });
      }
    });
    if (index < 0 && input) input.removeAttribute("aria-activedescendant");
  }

  function renderCandidates(candidates) {
    if (!optionsList) return;
    optionsList.innerHTML = "";
    candidates.forEach(function (c, i) {
      var li = el("li", "regulatory-autocomplete__option");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.setAttribute("data-index", String(i));
      li.id = "regulatory-autocomplete-option-" + i;
      // 한글명이 있으면 한글명 + INCI명, 없으면 영문명만 (한글명을 만들지 않음)
      if (c.kr_name) li.appendChild(el("span", "regulatory-autocomplete__kr", c.kr_name));
      if (c.inci_name) li.appendChild(el("span", "regulatory-autocomplete__inci", c.inci_name));
      if (!c.kr_name && !c.inci_name) li.appendChild(el("span", "regulatory-autocomplete__inci", "이름 미제공 · code " + c.code));
      li.addEventListener("mousedown", function (e) { e.preventDefault(); });
      li.addEventListener("click", function () { selectCandidate(i, "후보 선택"); });
      optionsList.appendChild(li);
    });
  }

  function clearSelection() {
    state.selected = null;
    state.selectedText = "";
    state.matchMethod = "";
    show(selectedLine, false);
  }

  function selectCandidate(index, method) {
    var c = state.candidates[index];
    if (!c) return;
    state.selected = c;
    state.matchMethod = method;
    var display = c.kr_name || c.inci_name || ("code " + c.code);
    if (input) input.value = display;
    state.selectedText = display;
    setAutocomplete("closed");
    if (selectedLine) {
      selectedLine.textContent = "선택한 성분: " + display +
        (c.kr_name && c.inci_name ? " (" + c.inci_name + ")" : "") +
        " — 검색 버튼을 누르면 선택한 시장의 규제를 조회해요.";
      show(selectedLine, true);
    }
    refreshStale();
    if (input) input.focus();
  }

  /* 현재 입력 조건 키. 표시 중인 결과의 키와 다를 때만 '이전 조건의 결과' 안내 */
  function conditionKey(ctx) {
    return [ctx.selected ? ctx.selected.code : "", ctx.marketCode].join("|");
  }

  function refreshStale() {
    var notice = $("regulatory-stale-notice");
    if (!notice) return;
    if (state.resultKey == null) { show(notice, false); return; }
    show(notice, conditionKey(currentContext()) !== state.resultKey);
  }

  /* ==========================================================================
     직접 검색: 흐름
     ========================================================================== */
  function validateForm() {
    var ingredientEmpty = !input || !input.value.trim();
    var marketEmpty = !marketSelect || !marketSelect.value;
    if (input) input.classList.toggle("is-error", ingredientEmpty);
    show($("regulatory-search-ingredient-error"), ingredientEmpty);
    if (marketSelect) marketSelect.classList.toggle("is-error", marketEmpty);
    show($("regulatory-search-market-error"), marketEmpty);
    return !(ingredientEmpty || marketEmpty);
  }

  function fetchCandidates(query) {
    setAutocomplete("loading");
    setBusy(true, "후보 찾는 중");
    var seq = ++state.lookupSeq;
    apiGet("/api/regulatory/ingredients?q=" + encodeURIComponent(query)).then(function (body) {
      if (seq !== state.lookupSeq) return;
      setBusy(false);
      state.candidates = body.candidates || [];
      if (!state.candidates.length) { setAutocomplete("empty"); return; }

      // 입력과 정확히 일치(공백·대소문자 무시)하는 후보가 정확히 하나 → 자동 확정 후 규제 조회. 그 외에는 사용자 선택
      var exactIndex = findExactMatch(state.candidates, query);
      if (exactIndex >= 0) {
        selectCandidate(exactIndex, "정확 일치 자동 확정");
        runLookup();
        return;
      }
      renderCandidates(state.candidates);
      setAutocomplete("list");
      setActive(0);
    }).catch(function (err) {
      if (seq !== state.lookupSeq) return;
      setBusy(false);
      var msg = $("regulatory-autocomplete-error-text");
      if (msg) msg.textContent = "후보를 불러오지 못했어요. " + (err && err.message ? err.message : "잠시 후 다시 시도해 주세요.");
      setAutocomplete("error");
    });
  }

  /* 한글명 또는 INCI명이 입력과 정확히 일치하는 후보가 정확히 하나일 때 그 index, 아니면 -1 */
  function findExactMatch(candidates, query) {
    var qn = normalize(query);
    var found = -1;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (normalize(c.kr_name) === qn || normalize(c.inci_name) === qn) {
        if (found >= 0) return -1;   // 둘 이상 → 사용자 선택
        found = i;
      }
    }
    return found;
  }

  /* 자동완성 (입력 중) — 검색 버튼을 비활성화하지 않고 목록 안에서만 로딩·없음·오류를 표시 */
  function fetchAutocomplete(query) {
    var seq = ++state.acSeq;
    setAutocomplete("loading");
    apiGet("/api/regulatory/ingredients?q=" + encodeURIComponent(query)).then(function (body) {
      if (seq !== state.acSeq) return;                       // 입력이 바뀌었거나 목록이 닫힘 → 무시
      if (!input || input.value.trim() !== query) return;    // 현재 검색어와 다른 응답 → 무시
      state.candidates = body.candidates || [];
      if (!state.candidates.length) { setAutocomplete("empty"); return; }
      renderCandidates(state.candidates);
      setAutocomplete("list");
      setActive(-1);                                         // 입력 중에는 활성 후보 없음 (Enter 가 임의 선택되지 않게)
    }).catch(function (err) {
      if (seq !== state.acSeq) return;
      var msg = $("regulatory-autocomplete-error-text");
      if (msg) msg.textContent = "후보를 불러오지 못했어요. " + (err && err.message ? err.message : "잠시 후 다시 시도해 주세요.");
      setAutocomplete("error");
    });
  }

  /* 입력 변경 → 조합 중이면 대기, 2글자 미만이면 닫기, 그 외 300ms 후 조회 */
  function scheduleAutocomplete() {
    clearTimeout(state.acTimer);
    state.acSeq++;                                            // 이전 검색어의 진행 중 요청 무효화
    if (state.composing) return;
    var query = input ? input.value.trim() : "";
    if (query.length < AC_MIN_LENGTH) { setAutocomplete("closed"); return; }
    state.acTimer = setTimeout(function () {
      if (state.composing) return;
      if (!input || input.value.trim() !== query) return;
      fetchAutocomplete(query);
    }, AC_DEBOUNCE_MS);
  }

  function currentContext() {
    return {
      inputRaw: input ? input.value : "",
      marketCode: marketSelect ? marketSelect.value : "",
      marketLabel: marketLabel(marketSelect ? marketSelect.value : ""),
      selected: state.selected,
      matchMethod: state.matchMethod,
    };
  }

  function runLookup() {
    if (!state.selected || !marketSelect || !marketSelect.value) return;
    var ctx = currentContext();
    setAutocomplete("closed");
    setBusy(true, "규제 조회 중");
    setResult("loading");
    var seq = ++state.lookupSeq;
    apiGet("/api/regulatory/regulations?code=" + encodeURIComponent(state.selected.code) +
           "&country=" + encodeURIComponent(ctx.marketCode)).then(function (body) {
      if (seq !== state.lookupSeq) return;   // 늦게 도착한 이전 응답 무시
      setBusy(false);
      renderSingle(body, ctx);
    }).catch(function (err) {
      if (seq !== state.lookupSeq) return;
      setBusy(false);
      renderError(err, ctx);
    });
  }

  if (searchForm) {
    searchForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!validateForm()) return;
      var query = input.value.trim();
      clearTimeout(state.acTimer);
      if (state.selected && state.selectedText === input.value) {
        runLookup();                 // 성분 확정됨 → 규제 조회
        return;
      }
      clearSelection();
      // 자동완성 목록이 이미 현재 입력의 후보를 갖고 있으면 재요청 없이 그 안에서 정확 일치를 찾는다
      if (state.listOpen && state.candidates.length) {
        var exactIndex = findExactMatch(state.candidates, query);
        if (exactIndex >= 0) { selectCandidate(exactIndex, "정확 일치 자동 확정"); runLookup(); return; }
        setActive(state.activeIndex >= 0 ? state.activeIndex : 0);
        var hint = $("regulatory-autocomplete-hint");
        if (hint) hint.textContent = "여러 후보가 있어요. 목록에서 성분을 선택해 주세요 (↑↓ 이동 · Enter 선택 · Esc 닫기)";
        return;
      }
      fetchCandidates(query);        // 미확정 → 후보 검색 (조회 아님)
    });
  }

  if (input) {
    input.addEventListener("compositionstart", function () { state.composing = true; });
    input.addEventListener("compositionend", function () {
      state.composing = false;
      scheduleAutocomplete();        // 조합 완료 후 길이·대기 조건을 다시 적용
    });
    input.addEventListener("input", function (e) {
      input.classList.remove("is-error");
      show($("regulatory-search-ingredient-error"), false);
      if (input.value !== state.selectedText) { clearSelection(); refreshStale(); }
      if (e && e.isComposing) { state.composing = true; return; }   // 일부 브라우저는 compositionstart 전에 input 을 먼저 보냄
      scheduleAutocomplete();
    });
    input.addEventListener("keydown", function (e) {
      if (e.isComposing || e.keyCode === 229) return;                // 조합 중 키 입력은 목록 조작으로 쓰지 않음
      if (e.key === "Escape") { setAutocomplete("closed"); return; }
      if (!state.listOpen || !state.candidates.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((state.activeIndex + 1) % state.candidates.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((state.activeIndex - 1 + state.candidates.length) % state.candidates.length);
      } else if (e.key === "Enter") {
        // 활성 후보가 있으면 선택용 Enter — 폼 제출(규제 조회)로 이어지지 않음. 활성 후보가 없으면 폼 제출(검색 버튼과 동일)
        if (state.activeIndex >= 0) {
          e.preventDefault();
          selectCandidate(state.activeIndex, "후보 선택");
        }
      }
    });
    document.addEventListener("click", function (e) {
      if (e.target.closest(".regulatory-autocomplete")) return;
      setAutocomplete("closed");
    });
  }

  if (marketSelect) {
    marketSelect.addEventListener("change", function () {
      marketSelect.classList.remove("is-error");
      show($("regulatory-search-market-error"), false);
      refreshStale();
    });
  }

  var retryBtn = $("regulatory-result-retry");
  if (retryBtn) {
    retryBtn.addEventListener("click", function () {
      if (state.selected && marketSelect && marketSelect.value) runLookup();
      else setResult("hidden");
    });
  }

  /* ==========================================================================
     규제 조건 원문(limit_condition) 표시
     - 원문이 "* 【태그】 라벨 : 값" 블록 구조이면 블록별로 나누고, 언어(영문 위 → 한국어 아래)별로 적용 제품 / 최대 농도 / 사용 조건·주의 문구 / 기타 원문 으로 묶습니다.
     - 값 안의 "(a) … (b) …" 항목은 표기를 유지한 채 줄로 나눕니다. 글자 표기가 적용 제품과 최대 농도의 대응 관계입니다.
     - 블록 하나라도 "라벨 : 값" 으로 읽을 수 없으면 나누지 않고 원문 전체를 그대로 표시합니다.
     - 수치·단위·조건을 요약·환산·재해석하지 않으며, 특정 성분에 맞춘 규칙을 두지 않습니다.
     ========================================================================== */
  var CONDITION_GROUPS = [
    { key: "product", title: "적용 제품·부위", re: /product\s*type|body\s*part|제품\s*유형|사용\s*부위/i },
    { key: "concentration", title: "최대 농도", re: /max(?:imum|\.)?\s*concentration|최대\s*농도/i },
    { key: "conditions", title: "사용 조건·주의 문구", re: /conditions?\s*of\s*use|warning|사용\s*조건|주의/i },
  ];

  function parseConditionText(raw) {
    var text = String(raw || "").replace(/\r\n/g, "\n").trim();
    if (!text || !/^\*\s/.test(text)) return null;
    var chunks = text.split(/\n(?=\*\s)/);
    var blocks = [];
    for (var i = 0; i < chunks.length; i++) {
      var body = chunks[i].replace(/^\*\s*/, "").trim();
      var tag = null;
      var tagMatch = body.match(/^【([^】]*)】\s*/);
      if (tagMatch) { tag = tagMatch[1].trim(); body = body.slice(tagMatch[0].length); }
      var sep = body.match(/^([^:\n]{1,80}?)\s*:\s*([\s\S]+)$/);
      if (!sep) return null;                       // 구조 불확실 → 원문 그대로
      var label = sep[1].trim();
      var value = sep[2].trim();
      var items = value.split(/\s*(?=\([a-z]\)\s)/).map(function (s) { return s.trim(); }).filter(Boolean);
      var group = "other";
      for (var g = 0; g < CONDITION_GROUPS.length; g++) {
        if (CONDITION_GROUPS[g].re.test(label)) { group = CONDITION_GROUPS[g].key; break; }
      }
      // 언어: 라벨(없으면 태그·값)에 한글이 있으면 한국어, 아니면 영문. 한국어 문장 속 영문 성분명·단위는 분리하지 않는다.
      var probe = label || tag || value;
      var lang = /[가-힣]/.test(probe) ? "ko" : "en";
      blocks.push({ tag: tag, label: label, value: value, items: items, group: group, lang: lang, lettered: items.length > 1 && /^\([a-z]\)/.test(items[0]) });
    }
    return blocks.length ? blocks : null;
  }

  function renderRawText(raw, note) {
    var wrap = el("div", "regulatory-cond-raw");
    if (note) wrap.appendChild(el("p", "text-caption text-secondary", note));
    wrap.appendChild(el("pre", "regulatory-cond-raw__text", String(raw)));
    return wrap;
  }

  function renderConditionBlock(block) {
    var node = el("div", "regulatory-cond-block");
    var head = el("p", "regulatory-cond-block__label");
    if (block.tag) head.appendChild(el("span", "badge regulatory-cond-block__tag", block.tag));
    head.appendChild(document.createTextNode(block.label));
    node.appendChild(head);
    if (block.items.length > 1) {
      var ul = el("ul", "regulatory-cond-items");
      block.items.forEach(function (it) { ul.appendChild(el("li", null, it)); });
      node.appendChild(ul);
    } else {
      node.appendChild(el("p", "regulatory-cond-block__value", block.value));
    }
    return node;
  }

  var CONDITION_LANGS = [
    { key: "en", title: "English", sub: "API 제공 영문" },
    { key: "ko", title: "한국어", sub: "API 제공 한국어" },
  ];

  function renderConditionGroups(blocks, container) {
    // 적용 제품·부위 → 최대 농도 → 사용 조건·주의 문구 → 기타 원문 순. 분류 불확실 블록도 '기타 원문'으로 누락 없이 표시.
    var order = CONDITION_GROUPS.map(function (g) { return g.key; }).concat(["other"]);
    var lettered = 0;
    order.forEach(function (key) {
      var inGroup = blocks.filter(function (b) { return b.group === key; });
      if (!inGroup.length) return;
      var grp = el("div", "regulatory-cond-group");
      var title = key === "other" ? "기타 원문" : CONDITION_GROUPS.filter(function (g) { return g.key === key; })[0].title;
      grp.appendChild(el("p", "regulatory-cond-group__title", title));
      var hasLettered = false;
      inGroup.forEach(function (b) { grp.appendChild(renderConditionBlock(b)); if (b.lettered) hasLettered = true; });
      if (hasLettered) lettered++;
      container.appendChild(grp);
    });
    return lettered;
  }

  function renderConditionEntry(entry, index, total) {
    var wrap = el("div", "regulatory-cond-entry");
    if (total > 1) {
      wrap.appendChild(el("p", "regulatory-cond-entry__title",
        "규제 항목 " + (index + 1) + " / " + total + (entry.regulate_type ? " · " + entry.regulate_type : "") + (entry.country ? " · " + entry.country : "")));
    }
    var raw = entry.limit_condition;
    if (!raw) {
      wrap.appendChild(el("p", "text-caption text-secondary", "규제 조건 원문이 제공되지 않았어요."));
    } else {
      var blocks = parseConditionText(raw);
      if (!blocks) {
        wrap.appendChild(renderRawText(raw, "원문 구분이 확실하지 않아 그대로 표시했어요."));
      } else {
        // 영문 전체가 위, 한국어 전체가 아래. 한 언어만 있으면 그 언어만 표시. 문장은 재배치만 하고 번역·요약하지 않는다.
        var letteredMax = 0;
        CONDITION_LANGS.forEach(function (lang) {
          var inLang = blocks.filter(function (b) { return b.lang === lang.key; });
          if (!inLang.length) return;
          var section = el("section", "regulatory-cond-lang");
          section.setAttribute("data-lang", lang.key);
          var h = el("h4", "regulatory-cond-lang__title", lang.title);
          h.appendChild(el("span", "regulatory-cond-lang__sub", lang.sub));
          section.appendChild(h);
          letteredMax = Math.max(letteredMax, renderConditionGroups(inLang, section));
          wrap.appendChild(section);
        });
        if (letteredMax > 1) {
          wrap.appendChild(el("p", "text-caption text-secondary regulatory-cond-note", "(a)·(b) 같은 표기는 원문 그대로이며, 적용 제품과 최대 농도 등 항목 사이의 대응 관계를 나타내요."));
        }
      }
    }
    if (entry.proviso) {
      var pv = el("div", "regulatory-cond-group");
      pv.appendChild(el("p", "regulatory-cond-group__title", "단서 조항 (원문)"));
      pv.appendChild(renderRawText(entry.proviso));
      wrap.appendChild(pv);
    }
    return wrap;
  }

  /* 규제 조건을 지정한 컨테이너에 렌더링 (직접 검색 카드와 상세 Modal 이 공유) */
  function renderConditionsInto(res, section, body, note) {
    if (!section || !body) return;
    body.innerHTML = "";
    var entries = (res && res.entries) || [];
    if (!entries.length) { show(section, false); return; }
    entries.forEach(function (e, i) { body.appendChild(renderConditionEntry(e, i, entries.length)); });
    var structured = entries.some(function (e) { return !!parseConditionText(e.limit_condition); });
    setText(note, structured
      ? "API 원문을 언어별·항목별로 나눠 표시했어요. 번역·요약 없이 수치·단위·조건은 원문 그대로예요."
      : "API 원문 그대로예요.");
    show(section, true);
  }

  function renderConditions(res) {
    renderConditionsInto(res, $("regulatory-single-conditions"), $("regulatory-single-conditions-body"), $("regulatory-single-conditions-note"));
  }

  /* ==========================================================================
     결과 렌더링 (직접 검색 카드 + 상세 Modal)
     ========================================================================== */
  // 조회됨은 허용·안전처럼 보이지 않도록 중립(기본) 배지. 미확인·보류는 warning, 오류는 danger.
  var LOOKUP_LABEL = {
    found: { text: "규제 정보 조회됨", variant: "" },
    no_data: { text: "규제 데이터 미확인", variant: "warning" },
    not_listed: { text: "규제 목록 미등재", variant: "warning" },
    hold: { text: "판단 보류 (미확인 응답)", variant: "warning" },
    api_error: { text: "API 오류", variant: "danger" },
    access: { text: "접근 제한", variant: "danger" },
  };

  /* 오류 종류 → 화면 분류. access/auth/rate_limit 은 '접근 제한', 나머지는 'API 오류' */
  var ACCESS_KINDS = { access: "요금제(구독)·인증 확인 필요", auth: "인증 실패", rate_limit: "호출 한도 초과" };
  function errorCategory(err) { return err && ACCESS_KINDS[err.kind] ? "access" : "api_error"; }
  function errorBadge(err) {
    var cat = errorCategory(err);
    return badge(cat === "access" ? "접근 제한 · " + ACCESS_KINDS[err.kind] : "API 오류", "danger");
  }

  /* 데이터 없음 응답의 이유를 쉬운 한국어로. 확인된 문구만 근거로 쓰고 의미를 단정하지 않는다 */
  function noDataReason(res) {
    if (!res) return "";
    if (res.lookup_status === "not_listed") return "API 소스에 이 성분의 제한·금지 항목이 없다고 안내했어요. 허용·안전을 뜻하지 않아요.";
    if (res.lookup_status === "no_data") {
      return res.note_mentions_plan
        ? "선택한 시장의 항목이 없어요. API 안내문에 ‘현재 요금제 밖 시장에만 항목이 있다’는 문구가 있어요 (요금제 범위는 관리자 확인 필요)."
        : "선택한 시장의 항목이 API 소스에 없어요. 다른 시장 항목 유무는 아래 API 안내를 참고하세요.";
    }
    return "";
  }

  function lookupBadge(status) {
    var m = LOOKUP_LABEL[status] || { text: "미조회", variant: "" };
    return badge(m.text, m.variant);
  }

  function ingredientKr(res, ctx) {
    var ing = (res && res.ingredient) || ctx.selected || {};
    return ing.kr_name || ing.inci_name || ("code " + ing.code);
  }

  function ingredientInci(res, ctx) {
    var ing = (res && res.ingredient) || ctx.selected || {};
    return ing.kr_name && ing.inci_name ? ing.inci_name : "";
  }

  function ingredientFull(res, ctx) {
    var inci = ingredientInci(res, ctx);
    return ingredientKr(res, ctx) + (inci ? " (" + inci + ")" : "");
  }

  function scopeText(res, ctx) {
    if (!res) return "—";
    var code = (res.country && res.country.code) || ctx.marketCode;
    var resolved = res.country && res.country.resolved;
    return "시장 코드 " + code + (resolved ? " (" + resolved + ")" : "") +
      (res.markets_listed && res.markets_listed.length ? " · API에 등재된 시장: " + res.markets_listed.join(", ") : "");
  }

  function joinEntries(res, key) {
    if (!res || !res.entries || !res.entries.length) return "";
    return res.entries.map(function (e) { return e[key] || ""; }).filter(Boolean).join("\n\n");
  }

  function fillModal(res, ctx, err) {
    var set = function (key, value) {
      var node = document.querySelector('#regulatory-detail-modal [data-detail="' + key + '"]');
      if (!node) return;
      if (value && value.nodeType) replaceChildren(node, value);
      else setText(node, value);
    };
    setText($("regulatory-detail-title"), "성분 상세 · " + ingredientFull(res, ctx));
    set("input-raw", ctx.inputRaw);
    set("input-market", ctx.marketLabel);
    set("input-amount", ctx.amountRef ? ctx.amountRef + " — 문서에서 읽은 참고값이에요. 적합 여부는 판정하지 않아요." : "해당 없음");
    set("input-location", ctx.location || "해당 없음");
    renderConditionsInto(res, $("regulatory-detail-conditions-section"), $("regulatory-detail-conditions"), $("regulatory-detail-conditions-note"));
    var sel = ctx.selected || {};
    set("match-name", ingredientFull(res, ctx) + " · code " + sel.code);
    set("match-method", ctx.matchMethod || "—");
    set("match-updated", sel.record_updated_at ? sel.record_updated_at + " (API 레코드 updated_at)" : "미제공");

    var statusNode = el("span");
    statusNode.appendChild(res ? lookupBadge(res.lookup_status) : errorBadge(err));
    if (err && err.message) statusNode.appendChild(document.createTextNode(" " + err.message));
    if (res && noDataReason(res)) statusNode.appendChild(el("p", "text-caption text-secondary", noDataReason(res)));
    set("lookup-status", statusNode);
    set("lookup-result-status", res ? res.result_status : (err && err.kind ? "오류 종류: " + err.kind : "—"));
    set("lookup-type", joinEntries(res, "regulate_type") || (res ? "미제공" : "—"));
    set("lookup-notice-name", joinEntries(res, "notice_ingr_name") || (res ? "미제공" : "—"));
    set("lookup-raw", joinEntries(res, "limit_condition") || (res && res.lookup_status === "found" ? "미제공" : (res ? "규제 데이터 없음 (응답 상태값: " + (res.result_status || "—") + ")" : "—")));
    set("lookup-proviso", joinEntries(res, "proviso") || (res ? "미제공" : "—"));
    set("lookup-scope", scopeText(res, ctx));
    set("lookup-note", res && res.result_note ? res.result_note : "없음");

    set("source", res && res.data_source ? res.data_source : "미제공");
    set("disclaimer", res && res.disclaimer ? res.disclaimer : "미제공");
    set("source-updated", res && res.source_updated_at ? res.source_updated_at : "미제공");
    set("queried-at", formatTime(res && res.queried_at));
    set("verified-at", "미실시");
  }

  function renderSingle(res, ctx) {
    state.resultKey = conditionKey(ctx);
    setText($("regulatory-result-time"), formatTime(res.queried_at));
    setText($("regulatory-single-name"), ingredientKr(res, ctx));
    setText($("regulatory-single-inci"), ingredientInci(res, ctx) || "영문명 미제공");
    setText($("regulatory-single-market"), ctx.marketLabel);

    replaceChildren($("regulatory-single-status"), lookupBadge(res.lookup_status));
    var statusNote = "";
    if (res.lookup_status === "found") statusNote = "규제 항목 " + res.entries.length + "건 반환";
    else if (res.lookup_status === "no_data" || res.lookup_status === "not_listed") statusNote = "응답 상태값: " + (res.result_status || "—");
    else statusNote = "응답 상태값: " + (res.result_status || "—") + " (확인되지 않은 값)";
    setText($("regulatory-single-status-note"), statusNote);

    var types = res.entries.map(function (e) { return e.regulate_type || "구분 미제공"; });
    setText($("regulatory-single-type"), res.entries.length ? types.join(", ") : "—");
    setText($("regulatory-single-type-note"), res.entries.length
      ? "API 원문 표기"
      : (res.lookup_status === "no_data" ? "시장 항목 없음" : (res.lookup_status === "not_listed" ? "목록 미등재" : "판단 보류")));

    var noData = res.lookup_status === "no_data" || res.lookup_status === "not_listed";
    show($("regulatory-single-nodata"), noData);
    setText($("regulatory-single-nodata-title"), res.lookup_status === "not_listed" ? "API 규제 목록에 이 성분이 등재되어 있지 않아요" : "선택한 시장의 규제 데이터가 확인되지 않았어요");
    setText($("regulatory-single-nodata-body"), (noDataReason(res) || "허용되거나 안전하다는 뜻은 아니에요.") + " 다른 자료로 추가 확인이 필요해요.");
    var nodataNote = $("regulatory-single-nodata-note");
    if (nodataNote) { setText(nodataNote, res.result_note ? "API 안내(원문): " + res.result_note : ""); show(nodataNote, !!res.result_note); }
    show($("regulatory-single-hold"), res.lookup_status === "hold");
    setText($("regulatory-single-hold-note"), "응답 상태값 '" + (res.result_status || "—") + "'은 확인된 값이 아니에요. 임의로 해석하지 않았어요.");
    show($("regulatory-asean-notice"), ctx.marketCode === "ASEAN");

    renderConditions(res);
    setText($("regulatory-single-scope"), scopeText(res, ctx));

    fillModal(res, ctx, null);
    setResult("single");
  }

  function renderError(err, ctx) {
    state.resultKey = conditionKey(ctx);
    setText($("regulatory-result-time"), "—");
    setText($("regulatory-result-error-reason"), (err && err.message) || "잠시 후 다시 시도해 주세요.");
    setText($("regulatory-result-error-kind"),
      (errorCategory(err) === "access" ? "접근 제한 (" + ACCESS_KINDS[err.kind] + ")" : "API 오류") + " · 오류 종류: " + ((err && err.kind) || "unknown") +
      (err && err.http_status ? " · 외부 API HTTP " + err.http_status : "") + " · 입력한 조건은 그대로 남아 있어요.");
    fillModal(null, ctx, err);
    setResult("error");
  }

  /* ==========================================================================
     파일로 일괄 조회 — 업로드 → (시트 선택) → 성분 추출 → 확인·수정   (규제 일괄 조회는 다음 단계, 호출하지 않음)
     ========================================================================== */
  var fileForm = $("regulatory-file-form");
  var fileInput = $("regulatory-file-input");
  var dropzone = $("regulatory-file-dropzone");
  var fileSubmit = $("regulatory-file-submit");
  var fileSubmitLabel = fileSubmit ? fileSubmit.textContent : "";
  var reviewBody = $("regulatory-review-body");

  var FILE_OK_EXT = /\.(pdf|xlsx|png|jpe?g)$/i;
  var FILE_NOT_YET_EXT = /\.(gif|webp|tiff?|bmp|heic|xls|csv|docx?|hwp|txt)$/i;
  var FILE_MAX_BYTES = 10 * 1024 * 1024;
  var UNSUPPORTED_MESSAGE = "현재 텍스트 PDF · 스캔 PDF · PNG/JPG 이미지 · Excel(.xlsx)만 지원합니다.";
  var ERROR_KIND_LABEL = { validation: "입력 확인", limit: "제한 초과", unsupported: "형식 미지원", unreadable: "읽기 실패", network: "연결 실패", http: "서버 오류", invalid_response: "응답 오류",
                           ocr_unavailable: "OCR 준비 안 됨 (서버 설치 필요)", ocr_timeout: "OCR 시간 초과", ocr_failed: "OCR 처리 실패" };

  // items: 서버 추출값(name_raw/amount_raw/location/needs_review/review_reasons) + 화면 편집값(name/amount/include/user_added)
  var fileState = { seq: 0, items: [], nextId: 1, sheets: [], selectedSheet: null, lastFile: null, emptyResult: false,
                    doc: null,            // 추출 응답의 document_market / document_use / scope / kind
                    matching: false,      // 성분 확인 진행 중 (중복 실행 방지)
                    looking: false,       // 규제 조회 진행 중
                    batchSeq: 0,          // 늦게 도착한 이전 조회 응답 무시
                    batchResultKey: null, // 표시 중인 일괄 결과의 조건 키 (시장 + 확정 목록)
                    batchMarket: null };  // 표시 중인 결과의 시장 코드

  function currentFile() { return fileInput && fileInput.files && fileInput.files[0] ? fileInput.files[0] : null; }

  function setFileBusy(on, label) {
    if (!fileSubmit) return;
    fileSubmit.disabled = on;
    fileSubmit.innerHTML = "";
    if (on) {
      fileSubmit.appendChild(el("span", "spinner spinner-sm"));
      fileSubmit.appendChild(document.createTextNode(" " + (label || "처리 중")));
    } else {
      fileSubmit.textContent = fileSubmitLabel;
    }
    var confirmBtn = $("regulatory-sheet-confirm");
    if (confirmBtn) confirmBtn.disabled = on;
  }

  function showFileError(err) {
    var box = $("regulatory-file-result-error");
    if (!box) return;
    var kind = (err && err.kind) || "unknown";
    setText($("regulatory-file-error-title"), kind === "unsupported" ? "아직 지원하지 않는 파일이에요"
      : (kind === "ocr_unavailable" ? "이미지 인식(OCR)이 서버에 준비되지 않았어요" : (kind === "ocr_timeout" ? "이미지 인식(OCR) 시간이 초과됐어요" : "파일을 처리하지 못했어요")));
    setText($("regulatory-file-error-message"), (err && err.message) || "잠시 후 다시 시도해 주세요.");
    setText($("regulatory-file-error-kind"), "오류 종류: " + (ERROR_KIND_LABEL[kind] || kind) + " · 파일을 바꾸거나 수정한 뒤 다시 분석해 주세요.");
    show(box, true);
  }

  function hideFileError() { show($("regulatory-file-result-error"), false); }

  if (fileInput) {
    fileInput.addEventListener("change", function () {
      var f = currentFile();
      var label = $("regulatory-file-name");
      if (label) label.textContent = f ? "선택한 파일: " + f.name + " (" + Math.ceil(f.size / 1024) + " KB)" : "";
      show(label, !!f);
      if (dropzone) dropzone.classList.remove("is-error");
      show($("regulatory-file-error"), false);
      hideFileError();
      // 파일이 바뀌면 이전 시트 목록·추출 결과는 무효
      fileState.sheets = []; fileState.selectedSheet = null;
      if (fileState.lastFile && f !== fileState.lastFile) setFileStep("upload");
    });
  }

  if (dropzone) {
    ["dragenter", "dragover"].forEach(function (type) {
      dropzone.addEventListener(type, function (e) { e.preventDefault(); dropzone.classList.add("is-dragover"); });
    });
    ["dragleave", "drop"].forEach(function (type) {
      dropzone.addEventListener(type, function (e) { e.preventDefault(); dropzone.classList.remove("is-dragover"); });
    });
    dropzone.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length && fileInput) {
        fileInput.files = e.dataTransfer.files;
        fileInput.dispatchEvent(new Event("change"));
      }
    });
  }

  /* 업로드 전 확인: 확장자·용량. 서버도 같은 검증을 다시 한다 */
  function validateFileForm() {
    var f = currentFile();
    var market = $("regulatory-file-market");
    var fileEmpty = !f;
    var marketEmpty = !market || !market.value;
    if (dropzone) dropzone.classList.toggle("is-error", fileEmpty);
    show($("regulatory-file-error"), fileEmpty);
    if (market) market.classList.toggle("is-error", marketEmpty);
    show($("regulatory-file-market-error"), marketEmpty);
    if (fileEmpty || marketEmpty) return false;
    if (FILE_NOT_YET_EXT.test(f.name) || !FILE_OK_EXT.test(f.name)) {
      showFileError({ kind: "unsupported", message: UNSUPPORTED_MESSAGE });
      return false;
    }
    if (f.size > FILE_MAX_BYTES) {
      showFileError({ kind: "limit", message: "파일이 너무 커요. 10 MB 이하 파일을 올려 주세요." });
      return false;
    }
    return true;
  }

  /* 서버로 전송 → 상태별 처리. sheet 를 주면 그 시트만 추출 */
  function startExtract(sheet) {
    var f = currentFile();
    if (!f) return;
    hideFileError();
    var seq = ++fileState.seq;
    var fd = new FormData();
    fd.append("file", f, f.name);
    if (sheet) fd.append("sheet", sheet);
    setFileBusy(true, sheet ? "시트 추출 중" : "파일 분석 중");
    setFileStep("loading");
    var isImage = /\.(png|jpe?g)$/i.test(f.name);
    setText($("regulatory-file-loading-label"), sheet ? "선택한 시트에서 성분을 추출하는 중이에요"
      : (isImage ? "이미지를 인식(OCR)하는 중이에요 — 최대 25초 정도 걸릴 수 있어요" : "파일을 확인하고 성분을 추출하는 중이에요 (텍스트가 없는 쪽은 OCR 로 읽어요)"));
    apiPost("/api/regulatory/extract", fd).then(function (body) {
      if (seq !== fileState.seq) return;              // 그 사이 다른 파일·시트로 다시 보냈으면 무시
      setFileBusy(false);
      fileState.lastFile = f;
      if (body.status === "sheet_required") { renderSheets(body.sheets || []); return; }
      renderReview(body);
    }).catch(function (err) {
      if (seq !== fileState.seq) return;
      setFileBusy(false);
      setFileStep("upload");
      showFileError(err);
    });
  }

  if (fileForm) {
    fileForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!validateFileForm()) return;
      startExtract(null);
    });
  }

  /* 시트 선택 */
  function renderSheets(sheets) {
    fileState.sheets = sheets;
    var select = $("regulatory-sheet-select");
    if (select) {
      select.innerHTML = "";
      var first = el("option", null, "선택하세요"); first.value = ""; select.appendChild(first);
      sheets.forEach(function (name) { var o = el("option", null, name); o.value = name; select.appendChild(o); });
      select.classList.remove("is-error");
    }
    setFileStep("sheet");
  }

  var sheetConfirm = $("regulatory-sheet-confirm");
  if (sheetConfirm) {
    sheetConfirm.addEventListener("click", function () {
      var select = $("regulatory-sheet-select");
      var name = select ? select.value : "";
      if (!name) { if (select) select.classList.add("is-error"); return; }
      fileState.selectedSheet = name;
      startExtract(name);
    });
  }

  /* 추출 결과 → 편집 가능한 표 */
  function renderReview(result) {
    fileState.items = (result.items || []).map(function (it) {
      return {
        id: it.id, name_raw: it.name_raw || "", amount_raw: it.amount_raw, amount_unit_hint: it.amount_unit_hint || null,
        role_raw: it.role_raw || null, location: it.location || "—", source: it.source || "text", inci_raw: it.inci_raw || null,
        needs_review: !!it.needs_review, review_reasons: it.review_reasons || [],
        name: it.name_raw || "", amount: it.amount_raw || "", include: true, user_added: false, edited: false,
        match: null, result: null,      // match: 성분 확인 결과 / result: 규제 조회 결과 (행별)
      };
    });
    fileState.nextId = 1;
    fileState.doc = { kind: result.file && result.file.kind, scope: result.scope || {}, market: result.document_market || null, use: result.document_use || null };
    fileState.batchResultKey = null; fileState.batchMarket = null;
    if (!$("regulatory-result-single") || $("regulatory-result-single").hidden) setResult("hidden");

    var scopeText = "";
    var sc = result.scope || {};
    if (result.file && result.file.kind === "pdf") scopeText = "처리 범위: " + (sc.processed || (sc.pages + "쪽")) + (sc.ocr_pages && sc.ocr_pages.length ? " · OCR " + sc.ocr_pages.map(function (p) { return p + "쪽"; }).join(", ") : "");
    else if (result.file && result.file.kind === "image") scopeText = "처리 범위: " + (sc.processed || "이미지") + " · OCR";
    else if (result.file && result.file.kind === "xlsx") scopeText = "처리 범위: 시트 ‘" + (sc.selected_sheet || "") + "’ (" + (sc.scanned_rows || 0) + "행 확인" + (sc.sheets > 1 ? ", 전체 " + sc.sheets + "개 시트 중" : "") + ")";
    setText($("regulatory-review-scope"), scopeText + (result.extracted_at ? " · 추출 시각 " + formatTime(result.extracted_at) : ""));

    var docMarket = $("regulatory-file-doc-market");
    if (docMarket) docMarket.textContent = result.document_market && result.document_market.text ? result.document_market.text + " (" + result.document_market.location + ")" : "미확인";

    var notesList = $("regulatory-review-notes");
    var notes = (result.notes || []).slice();
    if (result.document_use && result.document_use.text) notes.push("문서에 적힌 제품 유형·사용 조건: " + result.document_use.text + " (" + result.document_use.location + ")");
    if (notesList) { notesList.innerHTML = ""; notes.forEach(function (n) { notesList.appendChild(el("li", null, n)); }); }
    show($("regulatory-review-partial"), notes.length > 0);

    fileState.emptyResult = result.status === "empty";
    var emptyTitle = $("regulatory-file-empty-title"), emptyBody = $("regulatory-file-empty-body");
    var outcome = result.ocr && result.ocr.outcome;
    if (result.file && result.file.kind === "image") {
      setText(emptyTitle, outcome === "no_text" ? "이미지에서 글자를 인식하지 못했어요" : "글자는 읽었지만 성분 표 구조를 찾지 못했어요");
      setText(emptyBody, outcome === "no_text"
        ? "글자가 선명하고 기울어지지 않은 이미지를 다시 올려 주세요. 스캔 해상도를 높이면 도움이 돼요."
        : "‘한글 성분명 · INCI Name · 함량’ 같은 제목 줄이 있는 표가 필요해요. 제목 줄이 선명한 이미지를 올리거나 아래 ‘행 추가’로 직접 입력해 주세요.");
    } else if (result.file && result.file.kind === "xlsx") {
      setText(emptyTitle, "성분 표를 찾지 못했어요");
      setText(emptyBody, "이 시트에는 ‘INCI name · 성분명 · 원료명’ 같은 제목이 있는 표가 없었어요. 다른 시트를 고르거나 아래 ‘행 추가’로 직접 입력해 주세요.");
    } else {
      setText(emptyTitle, "성분 표를 찾지 못했어요");
      setText(emptyBody, "파일은 읽었지만 ‘INCI name · 성분명 · 원료명’ 같은 제목이 있는 표가 없었어요. 아래 ‘행 추가’로 직접 입력하거나 다른 파일을 올려 주세요.");
    }
    if (reviewBody) { reviewBody.innerHTML = ""; fileState.items.forEach(function (it) { reviewBody.appendChild(rowElement(it)); }); }
    setFileStep("review");
    updateReviewCount();
  }

  function statusBadge(it) {
    if (it.user_added) return badge("직접 입력", "warning");
    if (it.edited) return badge("수정됨", "");
    if (it.source === "ocr") return badge("확인 필요 (OCR)", "warning");
    if (it.needs_review) return badge("확인 필요", "warning");
    return badge("추출됨", "");
  }

  function rowElement(it) {
    var tr = el("tr");
    tr.setAttribute("data-row-id", it.id);

    var tdCheck = el("td");
    var check = el("input"); check.type = "checkbox"; check.checked = it.include; check.setAttribute("aria-label", "조회 포함");
    check.addEventListener("change", function () { it.include = check.checked; updateReviewCount(); });
    var checkWrap = el("label", "form-check"); checkWrap.appendChild(check); tdCheck.appendChild(checkWrap);
    tr.appendChild(tdCheck);

    var tdName = el("td");
    tdName.appendChild(el("p", "regulatory-review-origin", "원문: " + (it.user_added ? "(직접 입력)" : (it.name_raw || "(비어 있음)")) + (it.inci_raw ? " · " + it.inci_raw : "")));
    var nameInput = el("input", "form-control form-control-sm"); nameInput.type = "text"; nameInput.value = it.name;
    nameInput.placeholder = "성분명 (한글 또는 INCI)"; nameInput.setAttribute("aria-label", "성분명 수정");
    nameInput.addEventListener("input", function () {
      it.name = nameInput.value;
      if (!it.user_added && nameInput.value.trim() !== it.name_raw) it.edited = true; else it.edited = false;
      invalidateRow(it);                       // 성분명이 바뀌면 이전 매칭·조회 결과는 무효
      replaceChildren(statusCell, statusBadge(it));
      updateReviewCount();
    });
    tdName.appendChild(nameInput);
    tr.appendChild(tdName);

    var tdAmount = el("td");
    var originText = it.user_added ? "(직접 입력)" : (it.amount_raw == null ? "미기재" : it.amount_raw + (it.amount_unit_hint && !/[%％]|ppm|mg|g\//i.test(it.amount_raw) ? " (열 제목 단위: " + it.amount_unit_hint + ")" : ""));
    tdAmount.appendChild(el("p", "regulatory-review-origin", "원문: " + originText));
    var amountInput = el("input", "form-control form-control-sm"); amountInput.type = "text"; amountInput.value = it.amount;
    amountInput.placeholder = it.amount_raw == null ? "미기재 (비워 두면 미기재)" : "원문 유지"; amountInput.setAttribute("aria-label", "함량 수정");
    amountInput.addEventListener("input", function () { it.amount = amountInput.value; if (!it.user_added && amountInput.value.trim() !== (it.amount_raw || "")) it.edited = true; else it.edited = (it.name.trim() !== it.name_raw); replaceChildren(statusCell, statusBadge(it)); });
    tdAmount.appendChild(amountInput);
    tr.appendChild(tdAmount);

    // 원문 위치(it.location)·문서 비고(it.role_raw)는 화면 열에서 제외. 데이터는 유지되어 상세 Modal 의 '원문 위치'에 표시된다.

    var statusCell = el("td");
    statusCell.appendChild(statusBadge(it));
    if (it.review_reasons.length) statusCell.appendChild(el("p", "regulatory-review-reason", it.review_reasons.join(" ")));
    tr.appendChild(statusCell);

    var tdMatch = el("td", "regulatory-match");
    it._matchCell = tdMatch;
    renderMatchCell(it);
    tr.appendChild(tdMatch);

    var tdAct = el("td", "regulatory-col-action");
    var del = el("button", "btn btn-secondary btn-sm", "삭제"); del.type = "button"; del.setAttribute("aria-label", "행 삭제");
    del.addEventListener("click", function () {
      fileState.items = fileState.items.filter(function (x) { return x !== it; });
      if (tr.parentNode) tr.parentNode.removeChild(tr);
      updateReviewCount();               // 삭제 행은 조회 대상·결과 표에서 제외
    });
    tdAct.appendChild(del);
    tr.appendChild(tdAct);
    return tr;
  }

  function updateReviewCount() {
    var total = fileState.items.length;
    var included = fileState.items.filter(function (x) { return x.include; }).length;
    var review = fileState.items.filter(function (x) { return x.needs_review && !x.edited; }).length;
    setText($("regulatory-review-count"), total + "행 · 조회 포함 " + included + " · 확인 필요 " + review);
    // 서버가 '성분 표 없음'을 돌려준 경우에만 Empty State. 행을 직접 추가하면 숨기고, 모두 지우면 다시 보인다
    show($("regulatory-file-empty"), fileState.emptyResult && total === 0);
    updateLookupSummary();
  }

  /* ---------------- 성분 확인 (API 매칭) ---------------- */
  function includedRows() { return fileState.items.filter(function (x) { return x.include && x.name.trim(); }); }
  function confirmedRows() { return includedRows().filter(function (x) { return x.match && x.match.status === "confirmed"; }); }

  function invalidateRow(it) {
    it.match = null;
    it.result = null;
    renderMatchCell(it);
    refreshBatchStale();
  }

  function updateLookupSummary() {
    var inc = includedRows();
    var confirmed = confirmedRows().length;
    var unconfirmed = inc.length - confirmed;
    var btn = $("regulatory-review-submit");
    if (btn) btn.disabled = fileState.looking || fileState.matching || confirmed === 0;
    var marketSel = $("regulatory-file-market");
    setText($("regulatory-lookup-summary"), "확정 " + confirmed + " · 미확정 " + unconfirmed + " · 조회 대상 " + confirmed +
      (confirmed ? (marketSel && marketSel.value ? " — 선택 시장: " + fileMarketLabel() : " — 국가/시장을 선택해 주세요.") : " — 성분 확인 후 조회할 수 있어요."));
    refreshBatchStale();
  }

  function fileMarketLabel() {
    var sel = $("regulatory-file-market");
    if (!sel) return "";
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === sel.value) return sel.options[i].text;
    return sel.value;
  }

  function candidateLabel(c) {
    return (c.kr_name || "") + (c.kr_name && c.inci_name ? " (" + c.inci_name + ")" : (c.inci_name || "")) + (!c.kr_name && !c.inci_name ? "code " + c.code : "");
  }

  function confirmMatch(it, c, method) {
    it.match = { status: "confirmed", code: c.code, kr_name: c.kr_name || null, inci_name: c.inci_name || null, record_updated_at: c.record_updated_at || null, method: method, candidates: it.match ? it.match.candidates : [] };
    it.result = null;
    renderMatchCell(it);
    updateLookupSummary();
  }

  function renderMatchCell(it) {
    var td = it._matchCell;
    if (!td) return;
    td.innerHTML = "";
    var m = it.match;
    if (!m) { td.appendChild(el("span", "text-caption text-secondary", "성분 확인 전")); return; }
    if (m.status === "confirmed") {
      td.appendChild(badge("확정", ""));
      td.appendChild(el("p", "regulatory-match__name", candidateLabel(m) + " · code " + m.code + " · " + m.method));
      return;
    }
    if (m.status === "choose") {
      td.appendChild(badge("성분 확인 필요", "warning"));
      var sel = el("select", "form-control form-control-sm mt-2"); sel.setAttribute("aria-label", "후보 선택");
      var o0 = el("option", null, "후보 " + m.candidates.length + "개 — 선택하세요"); o0.value = ""; sel.appendChild(o0);
      m.candidates.forEach(function (c, i) { var o = el("option", null, candidateLabel(c)); o.value = String(i); sel.appendChild(o); });
      sel.addEventListener("change", function () { var i = parseInt(sel.value, 10); if (!isNaN(i) && m.candidates[i]) confirmMatch(it, m.candidates[i], "후보 선택"); });
      td.appendChild(sel);
      td.appendChild(el("p", "regulatory-match__name", "정확히 일치하는 후보가 없거나 여러 개예요. 임의로 확정하지 않았어요."));
      return;
    }
    if (m.status === "not_found") {
      td.appendChild(badge("성분 확인 필요", "warning"));
      td.appendChild(el("p", "regulatory-match__name", "일치하는 성분이 없어요. 성분명을 수정한 뒤 다시 확인해 주세요."));
      return;
    }
    td.appendChild(badge("확인 실패", "danger"));
    td.appendChild(el("p", "regulatory-match__name", m.message || "후보를 불러오지 못했어요. 다시 확인해 주세요."));
  }

  function setMatchBusy(on, label) {
    fileState.matching = on;
    var btn = $("regulatory-review-match");
    if (btn) { btn.disabled = on; btn.textContent = on ? (label || "확인 중") : "성분 확인 (API 매칭)"; }
    updateLookupSummary();
  }

  /* 조회 포함 행을 순서대로 확인. 같은 이름(공백·대소문자 무시)은 한 번만 검색해 결과를 공유한다 */
  function runMatching() {
    if (fileState.matching || fileState.looking) return;
    var rows = includedRows().filter(function (x) { return !x.match || x.match.status !== "confirmed"; });
    var progress = $("regulatory-match-progress");
    if (!rows.length) { setText(progress, "확인할 행이 없어요. 조회 포함 행의 성분명을 입력하거나 이미 모두 확정됐어요."); return; }
    var seq = ++fileState.seq;
    var cache = {};
    var done = 0;
    setMatchBusy(true, "확인 중 0/" + rows.length);
    function next(i) {
      if (seq !== fileState.seq) return;                       // 다시 업로드 등으로 무효화
      if (i >= rows.length) {
        setMatchBusy(false);
        var c = confirmedRows().length, inc = includedRows().length;
        setText(progress, "확인 완료 — 확정 " + c + " · 미확정 " + (inc - c) + ". 미확정 행은 후보를 고르거나 성분명을 수정한 뒤 다시 확인해 주세요.");
        return;
      }
      var it = rows[i];
      var q = it.name.trim();
      var key = normalize(q);
      var p = cache[key] || (cache[key] = apiGet("/api/regulatory/ingredients?q=" + encodeURIComponent(q)).then(function (b) { return { candidates: b.candidates || [] }; }, function (err) { return { error: err }; }));
      p.then(function (r) {
        if (seq !== fileState.seq) return;
        if (!it.include || it.name.trim() !== q) { /* 진행 중에 바뀐 행은 건너뜀 */ }
        else if (r.error) it.match = { status: "error", candidates: [], message: r.error.message || "후보 검색 실패" };
        else if (!r.candidates.length) it.match = { status: "not_found", candidates: [] };
        else {
          var exact = findExactMatch(r.candidates, q);
          if (exact >= 0) { it.match = { status: "choose", candidates: r.candidates }; confirmMatch(it, r.candidates[exact], "정확 일치 자동 확정"); }
          else it.match = { status: "choose", candidates: r.candidates };
        }
        it.result = null;
        renderMatchCell(it);
        done++;
        setMatchBusy(true, "확인 중 " + done + "/" + rows.length);
        setText(progress, "성분 확인 중 " + done + "/" + rows.length + " — " + q);
        next(i + 1);
      });
    }
    next(0);
  }

  var matchBtn = $("regulatory-review-match");
  if (matchBtn) matchBtn.addEventListener("click", runMatching);

  /* ---------------- 규제 일괄 조회 ---------------- */
  function batchKey() {
    var market = $("regulatory-file-market") ? $("regulatory-file-market").value : "";
    return market + "|" + confirmedRows().map(function (x) { return x.id + ":" + x.match.code; }).join(",") +
      "|" + includedRows().filter(function (x) { return !x.match || x.match.status !== "confirmed"; }).map(function (x) { return x.id + ":" + normalize(x.name); }).join(",");
  }

  function refreshBatchStale() {
    var notice = $("regulatory-batch-stale");
    if (!notice) return;
    if (fileState.batchResultKey == null || fileState.looking) { show(notice, false); return; }
    show(notice, batchKey() !== fileState.batchResultKey);
  }

  var fileMarketSel = $("regulatory-file-market");
  if (fileMarketSel) fileMarketSel.addEventListener("change", function () { fileMarketSel.classList.remove("is-error"); show($("regulatory-file-market-error"), false); updateLookupSummary(); });

  function runBatchLookup(retryOnly) {
    if (fileState.looking || fileState.matching) return;
    var marketSel = $("regulatory-file-market");
    var market = marketSel ? marketSel.value : "";
    if (!market) { if (marketSel) marketSel.classList.add("is-error"); show($("regulatory-file-market-error"), true); return; }
    var rows = confirmedRows();
    if (retryOnly) rows = rows.filter(function (x) { return x.result && x.result.status === "api_error" && x.result.market === market; });
    if (!rows.length) return;
    // 같은 (성분 코드, 시장) 은 한 번만 호출
    var groups = {};
    rows.forEach(function (x) { var k = x.match.code + "|" + market; (groups[k] = groups[k] || { code: x.match.code, rows: [] }).rows.push(x); });
    var keys = Object.keys(groups);
    var seq = ++fileState.batchSeq;
    fileState.looking = true;
    fileState.batchMarket = market;
    updateLookupSummary();
    setText($("regulatory-result-loading-label"), "규제 정보를 조회하는 중이에요 (0/" + keys.length + ")");
    setResult("loading");
    setFileStep("lookup");
    var stopped = false;
    function finish() {
      if (seq !== fileState.batchSeq) return;
      fileState.looking = false;
      fileState.batchResultKey = batchKey();
      renderBatch(market);
      updateLookupSummary();
      setFileStep("result");
    }
    function next(i) {
      if (seq !== fileState.batchSeq) return;               // 새 조회·다시 업로드로 무효화 → 늦은 응답 무시
      if (i >= keys.length) { finish(); return; }
      var g = groups[keys[i]];
      if (stopped) {
        g.rows.forEach(function (x) { x.result = { status: "api_error", market: market, err: { kind: "rate_limit", message: "호출 한도 초과로 이 항목은 조회하지 않았어요. 잠시 후 ‘실패 항목 재시도’를 눌러 주세요." }, res: null }; });
        next(i + 1); return;
      }
      apiGet("/api/regulatory/regulations?code=" + encodeURIComponent(g.code) + "&country=" + encodeURIComponent(market)).then(function (res) {
        if (seq !== fileState.batchSeq) return;
        g.rows.forEach(function (x) { x.result = { status: res.lookup_status, market: market, res: res, err: null }; });
        setText($("regulatory-result-loading-label"), "규제 정보를 조회하는 중이에요 (" + (i + 1) + "/" + keys.length + ")");
        next(i + 1);
      }).catch(function (err) {
        if (seq !== fileState.batchSeq) return;
        g.rows.forEach(function (x) { x.result = { status: "api_error", market: market, err: err || { kind: "unknown", message: "조회 실패" }, res: null }; });
        if (err && err.kind === "rate_limit") stopped = true;   // 429: 남은 항목은 호출하지 않고 실패로 표시. 자동 재시도 없음
        next(i + 1);
      });
    }
    next(0);
  }

  var lookupBtn = $("regulatory-review-submit");
  if (lookupBtn) lookupBtn.addEventListener("click", function () { runBatchLookup(false); });
  var retryFailedBtn = $("regulatory-retry-failed");
  if (retryFailedBtn) retryFailedBtn.addEventListener("click", function () { runBatchLookup(true); });

  var BATCH_LABEL = {
    found: { text: "규제 정보 조회됨", variant: "" },
    no_data: { text: "규제 데이터 미확인", variant: "warning" },
    not_listed: { text: "규제 목록 미등재", variant: "warning" },
    hold: { text: "판단 보류 (미확인 응답)", variant: "warning" },
    api_error: { text: "API 오류", variant: "danger" },
    access: { text: "접근 제한", variant: "danger" },
    choose: { text: "성분 확인 필요", variant: "warning" },
    not_found: { text: "성분 매칭 실패", variant: "warning" },
    error: { text: "성분 확인 실패", variant: "danger" },
    unmatched: { text: "성분 확인 필요", variant: "warning" },
    pending: { text: "미조회", variant: "" },
  };

  function rowStatus(x, market) {
    if (!x.match) return "unmatched";
    if (x.match.status !== "confirmed") return x.match.status;
    if (!x.result || x.result.market !== market) return "pending";
    if (x.result.status === "api_error") return errorCategory(x.result.err);   // access | api_error
    return x.result.status;
  }

  function batchContext(x, market) {
    return {
      inputRaw: x.name.trim() + (x.name.trim() !== x.name_raw && x.name_raw ? " (원문: " + x.name_raw + ")" : ""),
      marketCode: market,
      marketLabel: fileMarketLabel(),
      selected: x.match && x.match.status === "confirmed" ? x.match : null,
      matchMethod: x.match && x.match.method ? x.match.method : (x.match ? BATCH_LABEL[x.match.status].text : "성분 확인 전"),
      amountRef: (x.amount || "").trim() || (x.amount_raw ? x.amount_raw : "") || "미기재",
      location: x.location,
    };
  }

  function renderBatch(market) {
    var rows = includedRows();
    var counts = { total: 0, found: 0, nodata: 0, access: 0, error: 0, unconfirmed: 0, hold: 0, fail: 0 };
    var body = $("regulatory-result-body");
    if (body) body.innerHTML = "";
    var reviewNames = [];
    rows.forEach(function (x) {
      var st = rowStatus(x, market);
      counts.total++;
      if (st === "found") counts.found++;
      else if (st === "no_data" || st === "not_listed") counts.nodata++;
      else if (st === "access") counts.access++;
      else if (st === "api_error") counts.error++;
      else if (st === "hold" || st === "pending") counts.hold++;
      else counts.unconfirmed++;                                   // choose · not_found · error(성분 확인 실패) · unmatched
      if (st !== "found") reviewNames.push(x.name.trim());
      if (st === "api_error" || st === "access") counts.fail++;
      if (!body) return;
      var tr = el("tr");
      var tdName = el("td");
      tdName.appendChild(el("span", null, x.name.trim() || "(이름 없음)"));
      if (x.match && x.match.status === "confirmed") tdName.appendChild(el("p", "regulatory-result__sub", "매칭: " + candidateLabel(x.match) + " · code " + x.match.code));
      var amt = (x.amount || "").trim() || x.amount_raw;
      tdName.appendChild(el("p", "regulatory-result__sub", "문서 함량(참고): " + (amt || "미기재")));
      tr.appendChild(tdName);
      tr.appendChild(el("td", null, fileMarketLabel()));
      var tdStatus = el("td");
      var lab = BATCH_LABEL[st] || BATCH_LABEL.pending;
      if (st === "access" && x.result && x.result.err) tdStatus.appendChild(errorBadge(x.result.err));
      else tdStatus.appendChild(badge(lab.text, lab.variant));
      if ((st === "api_error" || st === "access") && x.result && x.result.err) tdStatus.appendChild(el("p", "regulatory-result__sub", x.result.err.message || ""));
      if ((st === "no_data" || st === "not_listed") && x.result && x.result.res) {
        tdStatus.appendChild(el("p", "regulatory-result__sub", noDataReason(x.result.res)));
        if (x.result.res.result_note) tdStatus.appendChild(el("p", "regulatory-result__sub", "API 안내(원문): " + x.result.res.result_note));
      }
      if (st === "hold" && x.result && x.result.res) tdStatus.appendChild(el("p", "regulatory-result__sub", "확인되지 않은 응답 상태값 ‘" + (x.result.res.result_status || "—") + "’ — 임의로 해석하지 않았어요."));
      tr.appendChild(tdStatus);
      var types = x.result && x.result.res && x.result.res.entries ? x.result.res.entries.map(function (e) { return e.regulate_type || "구분 미제공"; }) : [];
      tr.appendChild(el("td", null, types.length ? types.join(", ") : "—"));
      var tdAct = el("td", "regulatory-col-action");
      if (x.match && x.match.status === "confirmed" && x.result && x.result.market === market) {
        var btn = el("button", "btn btn-soft btn-sm", "상세"); btn.type = "button"; btn.setAttribute("data-modal-open", "regulatory-detail-modal");
        btn.addEventListener("click", function () { fillModal(x.result.res, batchContext(x, market), x.result.err); });
        tdAct.appendChild(btn);
      } else {
        tdAct.appendChild(el("span", "text-caption text-secondary", "—"));
      }
      tr.appendChild(tdAct);
      body.appendChild(tr);
    });

    setText($("regulatory-result-time"), formatTime(new Date().toISOString().slice(0, 19)));
    setText($("regulatory-cond-market"), fileMarketLabel());
    setText($("regulatory-cond-doc-country"), fileState.doc && fileState.doc.market ? fileState.doc.market.text : "미확인");
    setText($("regulatory-cond-product"), fileState.doc && fileState.doc.use ? fileState.doc.use.text : "미입력");
    setText($("regulatory-cond-scope"), "시장 코드 " + market + " · 확정 성분 " + confirmedRows().length + "건 조회");
    setText($("regulatory-kpi-total"), String(counts.total));
    setText($("regulatory-kpi-found"), String(counts.found));
    setText($("regulatory-kpi-nodata"), String(counts.nodata) + (counts.hold ? " (+보류 " + counts.hold + ")" : ""));
    setText($("regulatory-kpi-access"), String(counts.access));
    setText($("regulatory-kpi-error"), String(counts.error));
    setText($("regulatory-kpi-unconfirmed"), String(counts.unconfirmed));

    show($("regulatory-partial-fail-notice"), counts.fail > 0);
    setText($("regulatory-partial-fail-count"), String(counts.fail));
    show($("regulatory-retry-failed"), counts.fail > 0);

    var allNoData = rows.length > 0 && counts.found === 0 && rows.every(function (x) { var st = rowStatus(x, market); return st === "no_data" || st === "not_listed"; });
    show($("regulatory-result-empty"), allNoData);
    var list = $("regulatory-empty-review-list");
    if (list) { list.innerHTML = ""; if (allNoData) reviewNames.forEach(function (n) { list.appendChild(el("li", null, n)); }); }
    show($("regulatory-result-table-wrap"), rows.length > 0 && !allNoData);
    setResult("batch");
    refreshBatchStale();
  }

  var addRowBtn = $("regulatory-review-add");
  if (addRowBtn) {
    addRowBtn.addEventListener("click", function () {
      var it = { id: "u" + (fileState.nextId++), name_raw: "", amount_raw: null, amount_unit_hint: null, role_raw: null, location: "직접 입력", source: "user",
                 needs_review: true, review_reasons: ["직접 입력한 행이에요. 성분명을 확인해 주세요."], name: "", amount: "", include: true, user_added: true, edited: false, match: null, result: null };
      fileState.items.push(it);
      if (reviewBody) { var tr = rowElement(it); reviewBody.appendChild(tr); var inp = tr.querySelector("input[type=text]"); if (inp) inp.focus(); }
      updateReviewCount();
    });
  }

  var reupload = $("regulatory-review-reupload");
  if (reupload) {
    reupload.addEventListener("click", function () {
      fileState.seq++; fileState.batchSeq++;            // 진행 중 응답(추출·매칭·조회) 무시
      fileState.items = []; fileState.sheets = []; fileState.selectedSheet = null; fileState.lastFile = null; fileState.emptyResult = false;
      fileState.matching = false; fileState.looking = false; fileState.batchResultKey = null; fileState.batchMarket = null; fileState.doc = null;
      var rb = $("regulatory-result-body"); if (rb) rb.innerHTML = "";     // 이전 일괄 결과 표 비우기
      show($("regulatory-batch-stale"), false); show($("regulatory-partial-fail-notice"), false); show($("regulatory-retry-failed"), false);
      setMatchBusy(false);
      setText($("regulatory-match-progress"), "조회 포함 행의 성분명으로 후보를 찾아요. 정확히 일치하는 후보가 하나일 때만 자동 확정하고, 여러 후보는 행에서 직접 골라요.");
      if (!$("regulatory-result-single") || $("regulatory-result-single").hidden) setResult("hidden");
      if (reviewBody) reviewBody.innerHTML = "";
      hideFileError();
      setFileStep("upload");
      if (fileInput) fileInput.value = "";
      show($("regulatory-file-name"), false);
      var docMarket = $("regulatory-file-doc-market"); if (docMarket) docMarket.textContent = "미확인";
      if (fileInput) fileInput.focus();
    });
  }

  // 파일 단계: upload | loading | sheet | review — 한 블록만 표시. 4·5 단계 표시는 다음 단계에서 활성화
  function setFileStep(st) {
    show($("regulatory-file-loading"), st === "loading");
    show($("regulatory-sheet-block"), st === "sheet");
    var reviewVisible = st === "review" || st === "lookup" || st === "result";   // 조회 중·결과 단계에도 확인 표는 남겨 둔다
    show($("regulatory-review-block"), reviewVisible);
    if (!reviewVisible) { show($("regulatory-review-partial"), false); show($("regulatory-file-empty"), false); }
    show($("regulatory-excluded-block"), false);        // 사용 제외 성분 목록은 다음 단계

    var stepKey = { upload: "upload", loading: "upload", sheet: "sheet", review: "review", lookup: "lookup", result: "result" }[st] || "upload";
    var order = ["upload", "sheet", "review", "lookup", "result"];
    var idx = order.indexOf(stepKey);
    document.querySelectorAll(".regulatory-steps__item").forEach(function (li) {
      var i = order.indexOf(li.getAttribute("data-step"));
      li.classList.toggle("is-active", i === idx);
      li.classList.toggle("is-done", i < idx);
    });
  }

  /* ==========================================================================
     결과 영역 상태: hidden | loading | error | single | batch — 한 블록만 표시
     일부 실패 안내·실패 항목 재시도는 파일 일괄 조회에서 실제 실패 건이 있을 때만(후속 단계) 표시합니다.
     ========================================================================== */
  function setResult(st) {
    var section = $("regulatory-results");
    show(section, st !== "hidden");
    show($("regulatory-result-loading"), st === "loading");
    show($("regulatory-result-error"), st === "error");
    show($("regulatory-result-single"), st === "single");
    show($("regulatory-result-batch"), st === "batch");
    if (st !== "batch") {
      show($("regulatory-partial-fail-notice"), false);
      show($("regulatory-retry-failed"), false);
    }
    if (st === "hidden" || st === "loading") { state.resultKey = null; }
    refreshStale();
    if (st !== "hidden" && section) section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
})();

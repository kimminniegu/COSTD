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
   미구현(후속): 중간 포함 검색(API 부분 검색 미사용), 파일 업로드·추출·일괄 조회(함량 추출·수정 포함). */
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

  function renderConditions(res) {
    var section = $("regulatory-single-conditions");
    var body = $("regulatory-single-conditions-body");
    if (!section || !body) return;
    body.innerHTML = "";
    var entries = (res && res.entries) || [];
    if (!entries.length) { show(section, false); return; }
    entries.forEach(function (e, i) { body.appendChild(renderConditionEntry(e, i, entries.length)); });
    var structured = entries.some(function (e) { return !!parseConditionText(e.limit_condition); });
    setText($("regulatory-single-conditions-note"), structured
      ? "API 원문을 언어별·항목별로 나눠 표시했어요. 번역·요약 없이 수치·단위·조건은 원문 그대로예요."
      : "API 원문 그대로예요.");
    show(section, true);
  }

  /* ==========================================================================
     결과 렌더링 (직접 검색 카드 + 상세 Modal)
     ========================================================================== */
  // 조회됨은 허용·안전처럼 보이지 않도록 중립(기본) 배지. 미확인·보류는 warning, 오류는 danger.
  var LOOKUP_LABEL = {
    found: { text: "규제 정보 조회됨", variant: "" },
    no_data: { text: "규제 데이터 미확인", variant: "warning" },
    hold: { text: "판단 보류 (미확인 응답)", variant: "warning" },
    api_error: { text: "API 오류", variant: "danger" },
  };

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
    var sel = ctx.selected || {};
    set("match-name", ingredientFull(res, ctx) + " · code " + sel.code);
    set("match-method", ctx.matchMethod || "—");
    set("match-updated", sel.record_updated_at ? sel.record_updated_at + " (API 레코드 updated_at)" : "미제공");

    var statusNode = el("span");
    statusNode.appendChild(lookupBadge(res ? res.lookup_status : "api_error"));
    if (err && err.message) statusNode.appendChild(document.createTextNode(" " + err.message));
    set("lookup-status", statusNode);
    set("lookup-result-status", res ? res.result_status : (err && err.kind ? "오류 종류: " + err.kind : "—"));
    set("lookup-type", joinEntries(res, "regulate_type") || (res ? "미제공" : "—"));
    set("lookup-notice-name", joinEntries(res, "notice_ingr_name") || (res ? "미제공" : "—"));
    set("lookup-raw", joinEntries(res, "limit_condition") || (res && res.lookup_status === "found" ? "미제공" : (res ? "규제 데이터 없음" : "—")));
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
    else if (res.lookup_status === "no_data") statusNote = "응답 상태값: " + (res.result_status || "—");
    else statusNote = "응답 상태값: " + (res.result_status || "—") + " (확인되지 않은 값)";
    setText($("regulatory-single-status-note"), statusNote);

    var types = res.entries.map(function (e) { return e.regulate_type || "구분 미제공"; });
    setText($("regulatory-single-type"), res.entries.length ? types.join(", ") : "—");
    setText($("regulatory-single-type-note"), res.entries.length
      ? "API 원문 표기"
      : (res.lookup_status === "no_data" ? "규제 데이터 없음" : "판단 보류"));

    show($("regulatory-single-nodata"), res.lookup_status === "no_data");
    var nodataNote = $("regulatory-single-nodata-note");
    if (nodataNote) { setText(nodataNote, res.result_note ? "API 안내: " + res.result_note : ""); show(nodataNote, !!res.result_note); }
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
      "오류 종류: " + ((err && err.kind) || "unknown") + (err && err.http_status ? " · 외부 API HTTP " + err.http_status : "") +
      " · 입력한 조건은 그대로 남아 있어요.");
    fillModal(null, ctx, err);
    setResult("error");
  }

  /* ==========================================================================
     파일 탭 — 화면 골격만 (업로드·추출·함량 확인·일괄 조회는 후속 단계)
     ========================================================================== */
  var fileForm = $("regulatory-file-form");
  var fileInput = $("regulatory-file-input");
  var dropzone = $("regulatory-file-dropzone");

  if (fileInput) {
    fileInput.addEventListener("change", function () {
      var name = fileInput.files && fileInput.files[0] ? fileInput.files[0].name : "";
      var label = $("regulatory-file-name");
      if (label) label.textContent = name ? "선택한 파일: " + name : "";
      show(label, !!name);
      if (dropzone) dropzone.classList.remove("is-error");
      show($("regulatory-file-error"), false);
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

  if (fileForm) {
    fileForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var market = $("regulatory-file-market");
      var fileEmpty = !(fileInput && fileInput.files && fileInput.files.length);
      var marketEmpty = !market.value;

      if (dropzone) dropzone.classList.toggle("is-error", fileEmpty);
      show($("regulatory-file-error"), fileEmpty);
      market.classList.toggle("is-error", marketEmpty);
      show($("regulatory-file-market-error"), marketEmpty);

      if (fileEmpty || marketEmpty) return;
      notReady("파일 추출");
    });
  }

  ["regulatory-sheet-confirm", "regulatory-review-submit", "regulatory-retry-failed"].forEach(function (id) {
    var btn = $(id);
    if (btn) btn.addEventListener("click", function () { notReady("파일 일괄 규제 조회"); });
  });

  var reupload = $("regulatory-review-reupload");
  if (reupload) {
    reupload.addEventListener("click", function () {
      setFileStep("upload");
      if (fileInput) fileInput.value = "";
      show($("regulatory-file-name"), false);
    });
  }

  // 파일 단계: upload | loading | sheet | review | review-partial
  function setFileStep(st) {
    show($("regulatory-file-loading"), st === "loading");
    show($("regulatory-sheet-block"), st === "sheet");
    var review = st === "review" || st === "review-partial";
    show($("regulatory-review-block"), review);
    show($("regulatory-review-partial"), st === "review-partial");
    show($("regulatory-excluded-block"), review);

    var stepKey = { upload: "upload", loading: "upload", sheet: "sheet", review: "review", "review-partial": "review" }[st] || "upload";
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

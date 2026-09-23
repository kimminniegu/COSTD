/* 원가 경쟁력 및 마진 시뮬레이션 전용 JavaScript (담당자 C)
   이 페이지에서만 필요한 로직만 작성합니다.
   다른 페이지의 JS를 수정하거나 의존하지 않습니다. 공통 동작은 src/common/common.js 참고.
   기능 명세: src/03_margin/margin.md — 현재 구현 범위: Tab 1 (§2.3, §4.2), Tab 2 (§2.4, §4.3~4.5, §6.3), Tab 3 PI (§2.5, §6.4.7~6.4.8), §5, §7, §8.3 */
(function () {
  "use strict";

  var API_BASE = "/api/margin-calculator";
  var CALC_DEBOUNCE_MS = 300;
  var SVG_NS = "http://www.w3.org/2000/svg";

  var COST_FIELDS = [
    { key: "bulk", id: "margin-cost-bulk", label: "벌크" },
    { key: "container", id: "margin-cost-container", label: "용기" },
    { key: "packaging", id: "margin-cost-packaging", label: "단상자·라벨·설명서" },
    { key: "processing", id: "margin-cost-processing", label: "충진·포장·검수" },
  ];

  var STATUS_BADGE = {
    ok: { cls: "badge-success", text: "목표 달성" },
    below_target: { cls: "badge-info", text: "목표 미달" },
    below_defense: { cls: "badge-warning", text: "방어선 미달" },
    negative: { cls: "badge-danger", text: "역마진" },
  };

  /* 서버 오류 fields 키 → 화면 id (§7.7) */
  var FIELD_MAP = {
    "cost.bulk": "margin-cost-bulk",
    "cost.container": "margin-cost-container",
    "cost.packaging": "margin-cost-packaging",
    "cost.processing": "margin-cost-processing",
    "cost.fixed_per_order": "margin-fixed-cost",
    "cost.loss_rate": "margin-loss-rate",
    target_margin: "margin-target-margin",
    min_margin: "margin-min-margin",
  };

  var state = {
    master: null,
    tier: {
      tiers: [],              // MOQ 제외 사용자 수량 (오름차순)
      priceOverrides: {},     // { qty: 원/ea }
      result: null,
      status: "idle",         // idle | loading | success | error
    },
    selection: { qty: null },
    requestSeq: 0,
    controller: null,
    fx: { data: null, warnings: [], status: "idle" },          // GET fx-rates 결과
    export: {
      incoterm: "FOB", basis: "base", namedPlaceDirty: false,
      logistics: null, logisticsRequest: null, usdRateUsed: null, quote: null,
      seq: 0, controller: null, quoteSeq: 0, quoteController: null,
    },
    counter: { result: null, applied: null, qtyDirty: false }, // applied = { price, qty, currency } → Tab 3
    pi: {
      bound: null, signature: "", margin: null,  // bound: PI 에 들어가는 Tab 1·2 확정값 (§5.4 stale 비교는 signature)
      dirty: {}, extras: [], previewSeq: 0, previewController: null, strictErrors: false,
    },
  };

  function $(id) { return document.getElementById(id); }

  /* 포맷 --------------------------------------------------------------------- */
  var fmt = {
    int: function (v) { return Math.round(v).toLocaleString("ko-KR"); },
    krw: function (v) { return Math.round(v).toLocaleString("ko-KR") + "원"; },
    won2: function (v) { return Number(v).toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
    qty: function (v) { return Number(v).toLocaleString("ko-KR") + "ea"; },
    pct: function (v) { return Number(v).toFixed(2) + "%"; },
  };

  function debounce(fn, ms) {
    var timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  /* API 래퍼 — 오류를 { code, message, fields } 로 정규화 (§7.7) ------------ */
  function api(method, path, body, signal) {
    var options = { method: method, headers: { Accept: "application/json" }, signal: signal };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(API_BASE + path, options).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        if (json && json.ok) return json;
        var error = (json && json.error) || { code: "HTTP_" + res.status, message: "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요" };
        throw { code: error.code, message: error.message, fields: error.fields || {} };
      });
    });
  }

  function moq() { return state.master ? state.master.defaults.moq : 1500; }
  function maxTiers() { return state.master ? state.master.defaults.max_tiers : 8; }
  function maxQty() { return state.master ? state.master.defaults.max_qty : 1000000; }

  /* 입력 오류 표시 ------------------------------------------------------------ */
  function setFieldError(inputId, message) {
    var input = $(inputId);
    var errorEl = document.querySelector('[data-margin-error-for="' + inputId + '"]');
    var group = input ? input.closest(".input-group") : null;
    var target = group || input;
    if (target) target.classList.toggle("is-error", Boolean(message));
    if (errorEl) {
      errorEl.textContent = message || "";
      errorEl.hidden = !message;
    }
  }

  function clearFieldErrors() {
    Object.keys(FIELD_MAP).forEach(function (key) { setFieldError(FIELD_MAP[key], ""); });
    showCostError("");
  }

  function showCostError(message) {
    var el = $("margin-cost-error");
    el.textContent = message || "";
    el.hidden = !message;
  }

  function showTierError(message) {
    var el = $("margin-tier-error");
    el.textContent = message || "";
    el.hidden = !message;
    $("margin-tier-chips").classList.toggle("is-error", Boolean(message));
  }

  /* 숫자 입력 읽기 — 빈 값 null, 숫자 아님 NaN */
  function readNumber(id) {
    var raw = $(id).value.trim();
    if (raw === "") return null;
    var number = Number(raw.replace(/,/g, ""));
    return Number.isFinite(number) ? number : NaN;
  }

  /* 수량 구간 (§3.1.3) --------------------------------------------------------- */

  /* "2,500" / "2500" / "2,500ea" → 2500, 정수가 아니면 null */
  function parseQty(raw) {
    var text = String(raw).trim().replace(/,/g, "").replace(/\s*ea$/i, "");
    if (!/^\d+$/.test(text)) return null;
    return Number(text);
  }

  function tierCount() { return state.tier.tiers.length + 1; } // MOQ 포함

  function addTier(raw) {
    var input = $("margin-tier-input");
    if (String(raw).trim() === "") {
      showTierError("추가할 수량을 입력해 주세요");
      input.focus();
      return;
    }
    var qty = parseQty(raw);
    if (qty === null) {
      showTierError("수량은 정수로 입력해 주세요 (예: 2,500)");
      input.focus();
      return;
    }
    if (qty < moq()) {
      showTierError(fmt.qty(qty) + "는 MOQ(" + fmt.qty(moq()) + ") 미만이라 추가할 수 없어요");
      input.focus();
      return;
    }
    if (qty > maxQty()) {
      showTierError("수량은 최대 " + fmt.qty(maxQty()) + "까지 입력할 수 있어요");
      input.focus();
      return;
    }
    if (qty === moq() || state.tier.tiers.indexOf(qty) !== -1) {
      // 중복: 추가하지 않고 기존 Chip 강조만
      showTierError("");
      input.value = "";
      flashChip(qty);
      input.focus();
      return;
    }
    if (tierCount() >= maxTiers()) {
      showTierError("수량 구간은 MOQ 포함 최대 " + maxTiers() + "개까지 비교할 수 있어요");
      input.focus();
      return;
    }

    state.tier.tiers.push(qty);
    state.tier.tiers.sort(function (a, b) { return a - b; });
    showTierError("");
    input.value = "";
    renderChips();
    flashChip(qty);
    input.focus();
    scheduleCalc();
  }

  function removeTier(qty) {
    if (qty === moq()) return; // MOQ Chip 은 삭제 불가
    state.tier.tiers = state.tier.tiers.filter(function (q) { return q !== qty; });
    delete state.tier.priceOverrides[qty];
    showTierError("");
    renderChips();
    scheduleCalc();
  }

  function flashChip(qty) {
    var chip = document.querySelector('.margin-tier-chip[data-qty="' + qty + '"]');
    if (!chip) return;
    chip.classList.add("margin-tier-chip-flash");
    setTimeout(function () { chip.classList.remove("margin-tier-chip-flash"); }, 900);
  }

  function renderChips() {
    var box = $("margin-tier-chips");
    var input = $("margin-tier-input");
    box.querySelectorAll(".margin-tier-chip").forEach(function (chip) { chip.remove(); });

    var fixed = document.createElement("span");
    fixed.className = "multi-select__chip margin-tier-chip margin-tier-chip-fixed";
    fixed.dataset.qty = String(moq());
    fixed.title = "MOQ는 삭제할 수 없어요";
    fixed.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>';
    fixed.appendChild(document.createTextNode(fmt.qty(moq()) + " (MOQ)"));
    box.insertBefore(fixed, input);

    state.tier.tiers.forEach(function (qty) {
      var chip = document.createElement("span");
      chip.className = "multi-select__chip margin-tier-chip";
      chip.dataset.qty = String(qty);
      chip.appendChild(document.createTextNode(fmt.qty(qty)));
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "multi-select__remove margin-tier-chip__remove";
      remove.dataset.qty = String(qty);
      remove.setAttribute("aria-label", fmt.qty(qty) + " 삭제");
      remove.textContent = "×";
      chip.appendChild(remove);
      box.insertBefore(chip, input);
    });

    var full = tierCount() >= maxTiers();
    $("margin-tier-count").textContent = tierCount() + "/" + maxTiers();
    input.placeholder = full ? "최대 " + maxTiers() + "개까지 추가했어요" : "수량 입력 후 Enter";
  }

  /* 원가 입력 → 요청 payload (클라이언트 검증 포함) ---------------------------- */
  function collectTierRequest() {
    var d = state.master.defaults;
    var valid = true;
    var complete = true;
    var cost = {};
    clearFieldErrors();

    COST_FIELDS.forEach(function (field) {
      var value = readNumber(field.id);
      if (value === null) { complete = false; return; }
      if (Number.isNaN(value) || value < 0 || value > d.max_unit_cost) {
        setFieldError(field.id, "0~" + fmt.int(d.max_unit_cost) + "원 사이로 입력해 주세요");
        valid = false;
        return;
      }
      cost[field.key] = value;
    });

    var fixed = readNumber("margin-fixed-cost");
    if (fixed !== null && (Number.isNaN(fixed) || fixed < 0)) {
      setFieldError("margin-fixed-cost", "0원 이상으로 입력해 주세요");
      valid = false;
    }
    var loss = readNumber("margin-loss-rate");
    if (loss !== null && (Number.isNaN(loss) || loss < 0 || loss > 30)) {
      setFieldError("margin-loss-rate", "0~30% 사이로 입력해 주세요");
      valid = false;
    }
    var target = readNumber("margin-target-margin");
    if (target === null || Number.isNaN(target) || target < 0 || target > d.max_target_margin) {
      setFieldError("margin-target-margin", "0~" + d.max_target_margin + "% 사이로 입력해 주세요");
      valid = false;
    }
    var minimum = readNumber("margin-min-margin");
    if (minimum === null || Number.isNaN(minimum) || minimum < 0) {
      setFieldError("margin-min-margin", "0% 이상으로 입력해 주세요");
      valid = false;
    } else if (valid && minimum > target) {
      setFieldError("margin-min-margin", "방어선은 목표 마진보다 클 수 없어요");
      valid = false;
    }

    if (complete && valid) {
      var sum = COST_FIELDS.reduce(function (acc, f) { return acc + cost[f.key]; }, 0);
      if (sum === 0) {
        showCostError("원가를 1개 이상 입력해 주세요");
        valid = false;
      }
    }
    if (!complete || !valid) return null;

    cost.fixed_per_order = fixed === null ? d.fixed_cost : fixed;
    cost.loss_rate = loss === null ? d.loss_rate : loss;

    return {
      product: {
        name: $("margin-product-name").value.trim(),
        volume_ml: readNumber("margin-product-volume"),
        category: $("margin-product-category").value,
      },
      cost: cost,
      moq: moq(),
      target_margin: target,
      min_margin: minimum,
      tiers: state.tier.tiers.slice(),
      price_overrides: state.tier.priceOverrides,
    };
  }

  /* MOQ 기준 원가 미리보기 — 단순 합계만 JS에서 계산 (§8.3 예외) */
  function renderCostPreview() {
    if (!state.master) return; // 마스터 로드 전 입력은 무시 (로드 후 runCalc 에서 다시 계산)
    var values = COST_FIELDS.map(function (f) { return readNumber(f.id); });
    var ready = values.every(function (v) { return v !== null && !Number.isNaN(v); });
    var setTile = function (id, text) { $(id).querySelector(".stat-tile__value").textContent = text; };
    if (!ready) {
      ["margin-cost-preview-material", "margin-cost-preview-processing", "margin-cost-preview-total"].forEach(function (id) { setTile(id, "—"); });
      return;
    }
    var d = state.master.defaults;
    var loss = readNumber("margin-loss-rate");
    var fixed = readNumber("margin-fixed-cost");
    loss = loss === null || Number.isNaN(loss) ? d.loss_rate : loss;
    fixed = fixed === null || Number.isNaN(fixed) ? d.fixed_cost : fixed;
    var material = (values[0] + values[1] + values[2]) * (1 + loss / 100);
    var processing = values[3];
    setTile("margin-cost-preview-material", fmt.krw(material));
    setTile("margin-cost-preview-processing", fmt.krw(processing));
    setTile("margin-cost-preview-total", fmt.krw(material + processing + fixed / moq()));
  }

  /* 계산 요청 ----------------------------------------------------------------- */
  var scheduleCalc = debounce(runCalc, CALC_DEBOUNCE_MS);

  function setStatusBadge(status) {
    var badge = $("margin-tier-status");
    var map = {
      loading: { cls: "badge-info", text: "계산 중" },
      success: { cls: "badge-success", text: "계산 완료" },
      error: { cls: "badge-danger", text: "계산 오류" },
      stale: { cls: "badge-warning", text: "이전 결과" },
    };
    var item = map[status];
    badge.hidden = !item;
    if (!item) return;
    badge.className = "badge " + item.cls;
    badge.textContent = item.text;
  }

  function runCalc() {
    if (!state.master) return;
    renderCostPreview();
    var payload = collectTierRequest();
    if (state.controller) state.controller.abort();
    if (!payload) {
      state.tier.status = "idle";
      setStatusBadge(state.tier.result ? "stale" : null);
      return;
    }

    var seq = ++state.requestSeq;
    state.controller = new AbortController();
    state.tier.status = "loading";
    setStatusBadge("loading");

    api("POST", "/calculate-tiers", payload, state.controller.signal)
      .then(function (json) {
        if (seq !== state.requestSeq) return; // 늦게 도착한 이전 응답은 버림 (§5.4)
        state.tier.status = "success";
        state.tier.result = json.data;
        state.tier.lastRequest = payload; // 역제안 역산의 tier_request 로 사용
        setStatusBadge("success");
        renderTierResult(json.data, json.warnings || []);
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") return;
        if (seq !== state.requestSeq) return;
        state.tier.status = "error";
        applyServerError(err);
        setStatusBadge(state.tier.result ? "stale" : "error");
      });
  }

  function applyServerError(err) {
    var fields = (err && err.fields) || {};
    var handled = false;
    Object.keys(fields).forEach(function (key) {
      if (FIELD_MAP[key]) { setFieldError(FIELD_MAP[key], fields[key]); handled = true; }
      else if (key === "tiers" || key.indexOf("tiers[") === 0) { showTierError(fields[key]); handled = true; }
      else if (key === "cost") { showCostError(fields[key]); handled = true; }
    });
    if (!handled) showCostError((err && err.message) || "계산하지 못했어요. 잠시 후 다시 시도해 주세요");
  }

  /* 결과 렌더링 --------------------------------------------------------------- */
  function discountBracket(qty) {
    var bracket = state.master.volume_discounts[0].min_qty;
    state.master.volume_discounts.forEach(function (row) { if (qty >= row.min_qty) bracket = row.min_qty; });
    return bracket;
  }

  function discountText(row) {
    var d = row.discounts;
    if (!d.bulk && !d.container && !d.packaging && !d.processing) return "할인 없음";
    return "벌크 " + d.bulk + "% · 용기 " + d.container + "% · 포장재 " + d.packaging + "% · 임가공 " + d.processing + "%";
  }

  function makeBadge(status) {
    var info = STATUS_BADGE[status];
    var badge = document.createElement("span");
    badge.className = "badge " + info.cls;
    badge.textContent = info.text;
    return badge;
  }

  function cell(text, numeric) {
    var td = document.createElement("td");
    if (numeric) td.className = "is-numeric";
    if (text !== undefined) td.textContent = text;
    return td;
  }

  function renderTierResult(data, warnings) {
    var rows = data.rows;
    var quantities = rows.map(function (r) { return r.qty; });
    if (quantities.indexOf(state.selection.qty) === -1) {
      // 기본 선택: 첫 사용자 구간, 없으면 MOQ (§3.1.3)
      state.selection.qty = rows.length > 1 ? rows[1].qty : rows[0].qty;
    }

    $("margin-tier-result-subtitle").textContent =
      "목표 마진 " + data.target_margin + "% · 방어선 " + data.min_margin + "% · 10원 단위 올림";

    var tbody = $("margin-tier-tbody");
    tbody.textContent = "";
    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      tr.className = "margin-tier-row";
      tr.dataset.qty = String(row.qty);

      var radioCell = cell();
      var label = document.createElement("label");
      label.className = "form-check";
      var radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "margin-tier-select";
      radio.value = String(row.qty);
      radio.setAttribute("aria-label", fmt.qty(row.qty) + " 선택");
      label.appendChild(radio);
      radioCell.appendChild(label);
      tr.appendChild(radioCell);

      var qtyCell = cell(fmt.int(row.qty), true);
      if (row.is_moq) {
        var moqTag = document.createElement("span");
        moqTag.className = "text-caption";
        moqTag.textContent = " MOQ";
        qtyCell.appendChild(moqTag);
      }
      tr.appendChild(qtyCell);

      var discountCell = cell();
      var bracket = document.createElement("span");
      bracket.className = "text-caption";
      bracket.textContent = fmt.int(discountBracket(row.qty)) + "ea 이상 구간 · " + discountText(row);
      discountCell.appendChild(bracket);
      tr.appendChild(discountCell);

      tr.appendChild(cell(fmt.won2(row.unit_cost), true));

      var priceCell = cell(undefined, true);
      var priceInput = document.createElement("input");
      priceInput.type = "number";
      priceInput.min = "1";
      priceInput.step = "10";
      priceInput.className = "form-control form-control-sm margin-tier-price-input" + (row.is_overridden ? " is-overridden" : "");
      priceInput.value = String(row.supply_price);
      priceInput.dataset.qty = String(row.qty);
      priceInput.dataset.suggested = String(row.suggested_price);
      priceInput.title = row.is_overridden
        ? "수동 단가예요. 비우면 제안 단가 " + fmt.krw(row.suggested_price) + "로 돌아가요"
        : "제안 단가예요. 직접 고칠 수 있어요";
      priceInput.setAttribute("aria-label", fmt.qty(row.qty) + " 공급단가");
      priceCell.appendChild(priceInput);
      tr.appendChild(priceCell);

      tr.appendChild(cell(fmt.won2(row.unit_margin), true));
      tr.appendChild(cell(fmt.int(row.total_margin), true));
      tr.appendChild(cell(fmt.pct(row.margin_rate), true));

      var statusCell = cell();
      statusCell.appendChild(makeBadge(row.status));
      tr.appendChild(statusCell);

      var detailCell = cell();
      var detailBtn = document.createElement("button");
      detailBtn.type = "button";
      detailBtn.className = "btn btn-ghost btn-sm margin-tier-detail-btn";
      detailBtn.dataset.qty = String(row.qty);
      detailBtn.textContent = "상세";
      detailCell.appendChild(detailBtn);
      tr.appendChild(detailCell);

      tbody.appendChild(tr);
    });

    $("margin-tier-empty").hidden = true;
    $("margin-tier-table-wrap").hidden = false;
    $("margin-tier-note").hidden = false;
    renderTierAlert(data, warnings);
    selectTier(state.selection.qty);
  }

  function renderTierAlert(data, warnings) {
    var alert = $("margin-tier-alert");
    var list = $("margin-tier-alert-list");
    var messages = [];
    var level = "warning";

    data.rows.forEach(function (row) {
      if (row.status === "negative") {
        level = "danger";
        messages.push(fmt.qty(row.qty) + " 구간이 역마진이에요. 단가를 다시 확인해 주세요");
      } else if (row.status === "below_defense") {
        messages.push(fmt.qty(row.qty) + " 구간이 마진 방어선(" + data.min_margin + "%) 아래예요");
      }
    });
    warnings.forEach(function (w) {
      if (w.code !== "OVERRIDE_NEGATIVE_MARGIN" && w.code !== "OVERRIDE_BELOW_DEFENSE") messages.push(w.message);
    });

    list.textContent = "";
    alert.hidden = messages.length === 0;
    if (!messages.length) return;
    alert.className = "alert mb-6 alert-" + level;
    $("margin-tier-alert-title").textContent = level === "danger" ? "역마진 구간이 있어요" : "확인이 필요해요";
    messages.forEach(function (text) {
      var li = document.createElement("li");
      li.textContent = text;
      list.appendChild(li);
    });
  }

  function findRow(qty) {
    var result = state.tier.result;
    if (!result) return null;
    for (var i = 0; i < result.rows.length; i += 1) {
      if (result.rows[i].qty === qty) return result.rows[i];
    }
    return null;
  }

  function selectTier(qty) {
    var row = findRow(qty);
    if (!row) return;
    state.selection.qty = qty;

    document.querySelectorAll("#margin-tier-tbody .margin-tier-row").forEach(function (tr) {
      var active = Number(tr.dataset.qty) === qty;
      tr.classList.toggle("is-active", active);
      var radio = tr.querySelector('input[type="radio"]');
      if (radio) radio.checked = active;
    });

    renderSummary(row);
    renderChart();
    $("margin-go-export-btn").disabled = false;
    var exportTab = $("margin-tab-btn-export");
    exportTab.disabled = false;
    exportTab.removeAttribute("title");
    onTierSelected(row);
  }

  function renderSummary(row) {
    var setValue = function (id, text) { $(id).querySelector(".stat-tile__value").textContent = text; };
    setValue("margin-summary-qty", fmt.qty(row.qty));
    setValue("margin-summary-krw-price", fmt.krw(row.supply_price));
    var marginValue = $("margin-summary-margin").querySelector(".stat-tile__value");
    marginValue.textContent = fmt.pct(row.margin_rate) + " ";
    marginValue.appendChild(makeBadge(row.status));
  }

  /* 차트 (inline SVG, §2.3 차트 규격) ------------------------------------------ */
  function svg(tag, attrs, parent) {
    var el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach(function (key) { el.setAttribute(key, attrs[key]); });
    if (parent) parent.appendChild(el);
    return el;
  }

  function niceStep(raw) {
    var power = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / power;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * power;
  }

  var lastChartWidth = 0;

  /* 현재 state 로 차트 갱신 (빈 상태 전환 포함) */
  function renderChart() {
    var container = $("margin-tier-chart");
    var chartData = state.tier.result ? state.tier.result.chart : null;
    $("margin-tier-chart-empty").hidden = Boolean(chartData);
    container.hidden = !chartData;
    container.textContent = "";
    if (chartData) renderTierChart(container, chartData, state.selection.qty);
  }

  /* calculate-tiers 응답의 chart 데이터로 SVG 차트를 그립니다. 외부 라이브러리 없이 createElementNS 사용 */
  function renderTierChart(container, chartData, selectedQty) {
    container.textContent = "";
    var rows = chartData.qty.map(function (qty, i) {
      return {
        qty: qty,
        unit_cost: chartData.unit_cost[i],
        supply_price: chartData.supply_price[i],
        unit_margin: chartData.unit_margin[i],
        margin_rate: chartData.margin_rate[i],
        status: chartData.status[i],
      };
    });
    var width = Math.max(container.clientWidth, 320);
    lastChartWidth = width;
    var height = 300;
    var pad = { top: 36, right: 16, bottom: 40, left: 64 };
    var plotW = width - pad.left - pad.right;
    var plotH = height - pad.top - pad.bottom;

    var peak = 0;
    rows.forEach(function (r) { peak = Math.max(peak, r.unit_cost, r.supply_price); });
    var step = niceStep((peak * 1.15) / 4 || 1);
    var yMax = Math.ceil((peak * 1.15) / step) * step || step;
    var y = function (v) { return pad.top + plotH - (Math.max(v, 0) / yMax) * plotH; };
    var band = plotW / rows.length;
    var x = function (i) { return pad.left + band * i + band / 2; };
    var barW = Math.min(48, band * 0.45);

    var root = svg("svg", { viewBox: "0 0 " + width + " " + height, width: width, height: height, "aria-hidden": "true" });

    // Grid + Y축 눈금
    for (var v = 0; v <= yMax + step / 2; v += step) {
      svg("line", { class: v === 0 ? "margin-chart__baseline" : "margin-chart__grid", x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }, root);
      var tick = svg("text", { class: "margin-chart__axis-text", x: pad.left - 10, y: y(v) + 4, "text-anchor": "end" }, root);
      tick.textContent = fmt.int(v);
    }
    var unit = svg("text", { class: "margin-chart__axis-text", x: pad.left - 10, y: pad.top - 18, "text-anchor": "end" }, root);
    unit.textContent = "원/ea";

    var tooltip = document.createElement("div");
    tooltip.className = "margin-chart-tooltip";
    tooltip.hidden = true;

    rows.forEach(function (row, i) {
      var hit = svg("rect", { class: "margin-chart__hit" + (row.qty === selectedQty ? " is-active" : ""), x: pad.left + band * i, y: pad.top, width: band, height: plotH, rx: 8 }, root);
      hit.addEventListener("mouseenter", function () { showTooltip(tooltip, row, x(i), y(Math.max(row.unit_cost, row.supply_price))); });
      hit.addEventListener("mouseleave", function () { tooltip.hidden = true; });
      hit.addEventListener("click", function () { selectTier(row.qty); });

      var top = y(row.unit_cost);
      svg("rect", { class: "margin-chart__bar", x: x(i) - barW / 2, y: top, width: barW, height: pad.top + plotH - top, rx: 4 }, root);

      var label = svg("text", { class: "margin-chart__axis-text", x: x(i), y: height - pad.bottom + 22, "text-anchor": "middle" }, root);
      label.textContent = fmt.int(row.qty);
    });

    var points = rows.map(function (row, i) { return x(i) + "," + y(row.supply_price); }).join(" ");
    svg("polyline", { class: "margin-chart__line", points: points }, root);

    rows.forEach(function (row, i) {
      var selected = row.qty === selectedQty;
      svg("circle", { class: "margin-chart__point" + (selected ? " is-selected" : ""), cx: x(i), cy: y(row.supply_price), r: selected ? 7 : 5 }, root);
      var modifier = row.status === "negative" ? " margin-chart__label--negative"
        : row.status === "below_defense" ? " margin-chart__label--below-defense" : "";
      var rate = svg("text", { class: "margin-chart__label" + modifier, x: x(i), y: y(row.supply_price) - 14 }, root);
      rate.textContent = fmt.pct(row.margin_rate);
    });

    container.appendChild(root);
    container.appendChild(tooltip);
  }

  function showTooltip(tooltip, row, px, py) {
    tooltip.textContent = "";
    var title = document.createElement("strong");
    title.textContent = fmt.qty(row.qty);
    tooltip.appendChild(title);
    [
      "총 제조원가 " + fmt.won2(row.unit_cost) + "원",
      "제안 공급단가 " + fmt.krw(row.supply_price),
      "영업 마진액 " + fmt.won2(row.unit_margin) + "원/ea",
      "영업 마진율 " + fmt.pct(row.margin_rate),
    ].forEach(function (text) {
      var line = document.createElement("span");
      line.textContent = text;
      tooltip.appendChild(line);
    });
    tooltip.style.left = px + "px";
    tooltip.style.top = py + "px";
    tooltip.hidden = false;
  }

  /* 원가 구성 상세 Modal ------------------------------------------------------- */
  function openBreakdown(qty) {
    var row = findRow(qty);
    if (!row) return;
    var d = state.master.defaults;
    var base = {
      bulk: readNumber("margin-cost-bulk"),
      container: readNumber("margin-cost-container"),
      packaging: readNumber("margin-cost-packaging"),
      processing: readNumber("margin-cost-processing"),
    };
    var loss = readNumber("margin-loss-rate");
    var fixed = readNumber("margin-fixed-cost");
    loss = loss === null ? d.loss_rate : loss;
    fixed = fixed === null ? d.fixed_cost : fixed;

    $("margin-cost-breakdown-caption").textContent =
      fmt.qty(row.qty) + " 기준 · " + fmt.int(discountBracket(row.qty)) + "ea 이상 할인 구간";
    var tbody = $("margin-cost-breakdown-tbody");
    tbody.textContent = "";
    var addRow = function (label, baseText, discountText, value, strong) {
      var tr = document.createElement("tr");
      [label, baseText, discountText, value].forEach(function (text, i) {
        var td = cell(text, i > 0);
        if (strong) {
          var b = document.createElement("strong");
          b.textContent = text;
          td.textContent = "";
          td.appendChild(b);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    };
    COST_FIELDS.forEach(function (f) {
      addRow(f.label, fmt.krw(base[f.key]), row.discounts[f.key] + "%", fmt.won2(row.breakdown[f.key]) + "원");
    });
    addRow("로스(①②③ × " + loss + "%)", "—", "—", fmt.won2(row.breakdown.loss) + "원");
    addRow("고정비 분산", fmt.krw(fixed) + " ÷ " + fmt.int(row.qty), "—", fmt.won2(row.breakdown.fixed) + "원");
    addRow("총 제조원가", "", "", fmt.won2(row.unit_cost) + "원", true);
    window.Common.openModal("margin-cost-breakdown-modal");
  }

  /* 이벤트 --------------------------------------------------------------------- */
  function bindEvents() {
    bindExportEvents();
    bindPiEvents();
    var tierInput = $("margin-tier-input");
    tierInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        addTier(tierInput.value);
      }
    });
    tierInput.addEventListener("input", function () { showTierError(""); });
    $("margin-tier-add-btn").addEventListener("click", function () { addTier(tierInput.value); });

    $("margin-tier-chips").addEventListener("click", function (e) {
      var remove = e.target.closest(".margin-tier-chip__remove");
      if (remove) { removeTier(Number(remove.dataset.qty)); tierInput.focus(); return; }
      if (e.target === e.currentTarget) tierInput.focus();
    });

    document.querySelectorAll("[data-margin-tier-preset]").forEach(function (btn) {
      btn.addEventListener("click", function () { addTier(btn.dataset.marginTierPreset); });
    });

    var calcInputs = COST_FIELDS.map(function (f) { return f.id; })
      .concat(["margin-fixed-cost", "margin-loss-rate", "margin-target-margin", "margin-min-margin"]);
    calcInputs.forEach(function (id) {
      $(id).addEventListener("input", function () { renderCostPreview(); scheduleCalc(); });
    });

    var tbody = $("margin-tier-tbody");
    tbody.addEventListener("change", function (e) {
      if (e.target.name === "margin-tier-select") { selectTier(Number(e.target.value)); return; }
      if (e.target.classList.contains("margin-tier-price-input")) {
        var qty = Number(e.target.dataset.qty);
        var value = e.target.value.trim();
        if (value === "" || Number(value) === Number(e.target.dataset.suggested)) {
          delete state.tier.priceOverrides[qty];
        } else if (Number(value) > 0) {
          state.tier.priceOverrides[qty] = Number(value);
        } else {
          e.target.value = e.target.dataset.suggested;
          delete state.tier.priceOverrides[qty];
        }
        scheduleCalc();
      }
    });
    tbody.addEventListener("click", function (e) {
      var detail = e.target.closest(".margin-tier-detail-btn");
      if (detail) { openBreakdown(Number(detail.dataset.qty)); return; }
      if (e.target.closest("input, button, label")) return;
      var tr = e.target.closest(".margin-tier-row");
      if (tr) selectTier(Number(tr.dataset.qty));
    });

    $("margin-go-export-btn").addEventListener("click", function () { $("margin-tab-btn-export").click(); });

    $("margin-reset-btn").addEventListener("click", function () {
      if (state.master) window.Common.openModal("margin-confirm-modal");
    });
    $("margin-confirm-ok-btn").addEventListener("click", function () {
      window.Common.closeModal("margin-confirm-modal");
      resetAll();
    });

    if ("ResizeObserver" in window) {
      var frame = null;
      new ResizeObserver(function () {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(function () {
          var width = $("margin-tier-chart").clientWidth;
          if (state.tier.result && width && Math.abs(width - lastChartWidth) > 4) renderChart();
        });
      }).observe($("margin-tier-chart-card"));
    }
  }

  /* ==========================================================================
     Tab 2 — 수출 조건 · 환율 · 역제안 (§2.4, §4.3~4.5, §5.3, §6.3)
     ========================================================================== */
  var EXPORT_FIELD_MAP = {
    "carton.length_cm": "margin-carton-length",
    "carton.width_cm": "margin-carton-width",
    "carton.height_cm": "margin-carton-height",
    "carton.units_per_carton": "margin-carton-units",
    "carton.gross_weight_kg": "margin-carton-gw",
    "carton.allowance_rate": "margin-carton-allowance",
    named_place: "margin-named-place",
    fx_manual_rate: "margin-fx-manual-rate",
  };
  var CARTON_FIELDS = [
    { key: "length_cm", id: "margin-carton-length", min: 0, max: 200, label: "0초과~200cm" },
    { key: "width_cm", id: "margin-carton-width", min: 0, max: 200, label: "0초과~200cm" },
    { key: "height_cm", id: "margin-carton-height", min: 0, max: 200, label: "0초과~200cm" },
    { key: "gross_weight_kg", id: "margin-carton-gw", min: 0, max: 100, label: "0초과~100kg" },
  ];
  var CARTON_DEFAULTS = { length: 40, width: 30, height: 25, units: 60, gw: 12 };
  var DEFAULT_INCOTERM = "FOB";
  var FX_SOURCE_VIEW = {
    koreaexim: { cls: "badge-success", text: "실시간" },
    open_er_api: { cls: "badge-info", text: "보조 소스" },
    cache: { cls: "badge-warning", text: "캐시" },
    mock: { cls: "badge-danger", text: "모의 환율" },
    manual: { cls: "badge-primary", text: "직접 입력" },
  };
  var VERDICT_VIEW = {
    accept: { cls: "alert-success", title: "수용해도 돼요", text: "목표 마진 이상이에요. 이 단가로 진행해도 돼요." },
    negotiate: { cls: "alert-warning", title: "협상이 필요해요", text: "방어선은 지키지만 목표 마진에 못 미쳐요. 수량 증대나 조건 조정을 제안해 보세요." },
    reject: { cls: "alert-danger", title: "수용하기 어려워요", text: "방어선 아래예요. 원가 절감 또는 가격 재협상이 필요해요." },
    negative: { cls: "alert-danger", title: "역마진이에요", text: "이 단가로는 수주할 수 없어요." },
  };

  fmt.rate = function (v) { return Number(v).toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  fmt.num = function (v, d) { return Number(v).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d }); };

  function currencyInfo(code) {
    var list = state.master ? state.master.currencies : [];
    for (var i = 0; i < list.length; i += 1) if (list[i].code === code) return list[i];
    return { code: code, symbol: code + " ", price_decimals: 3, amount_decimals: 2 };
  }

  /* 외화 표시 — kind: price(단가 자리) | amount(금액 자리) */
  function fmtFx(value, code, kind) {
    var c = currencyInfo(code);
    var d = kind === "amount" ? c.amount_decimals : c.price_decimals;
    return c.symbol + fmt.num(value, d);
  }

  function incotermInfo(code) {
    var list = state.master.incoterms;
    for (var i = 0; i < list.length; i += 1) if (list[i].code === code) return list[i];
    return null;
  }

  function fillSelect(id, items, labelFn) {
    var select = $(id);
    select.textContent = "";
    items.forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.code;
      option.textContent = labelFn(item);
      select.appendChild(option);
    });
  }

  function setTileValue(id, text) { $(id).querySelector(".stat-tile__value").textContent = text; }

  function showListAlert(alertId, listId, messages) {
    var list = $(listId);
    list.textContent = "";
    messages.forEach(function (text) {
      var li = document.createElement("li");
      li.textContent = text;
      list.appendChild(li);
    });
    $(alertId).hidden = messages.length === 0;
  }

  function setBadge(id, view) {
    var badge = $(id);
    badge.hidden = !view;
    if (!view) return;
    badge.className = "badge " + view.cls;
    badge.textContent = view.text;
  }

  function enablePiTab() {
    var tab = $("margin-tab-btn-pi");
    tab.disabled = false;
    tab.removeAttribute("title");
    $("margin-go-pi-btn").disabled = false;
  }

  /* 초기 설정 ---------------------------------------------------------------- */
  function setupExportControls(master) {
    fillSelect("margin-transport-mode", master.transport_modes, function (m) { return m.label; });
    fillSelect("margin-dest-region", master.regions, function (r) { return r.label; });
    fillSelect("margin-currency", master.currencies, function (c) { return c.code + " · " + c.name; });
    fillSelect("margin-insurance-clause", master.insurance_clauses, function (i) { return i.label + " (" + i.rate_pct + "%)"; });

    var tabs = $("margin-incoterm-tabs");
    tabs.textContent = "";
    master.incoterms.forEach(function (term) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tab";
      btn.dataset.marginIncoterm = term.code;
      btn.setAttribute("role", "radio");
      btn.textContent = term.code;
      tabs.appendChild(btn);
    });
    setExportDefaults();
  }

  function setExportDefaults() {
    var d = state.master.defaults;
    $("margin-carton-length").value = CARTON_DEFAULTS.length;
    $("margin-carton-width").value = CARTON_DEFAULTS.width;
    $("margin-carton-height").value = CARTON_DEFAULTS.height;
    $("margin-carton-units").value = CARTON_DEFAULTS.units;
    $("margin-carton-gw").value = CARTON_DEFAULTS.gw;
    $("margin-carton-allowance").value = d.carton_allowance;
    $("margin-transport-mode").value = state.master.transport_modes[0].code;
    $("margin-dest-region").value = state.master.regions[0].code;
    $("margin-named-place").value = state.master.regions[0].default_place;
    $("margin-currency").value = "USD";
    $("margin-fx-manual-rate").value = "";
    $("margin-counter-price").value = "";
    state.export.incoterm = DEFAULT_INCOTERM;
    state.export.basis = "base";
    state.export.namedPlaceDirty = false;
    state.counter.qtyDirty = false;
    Object.keys(EXPORT_FIELD_MAP).forEach(function (k) { setFieldError(EXPORT_FIELD_MAP[k], ""); });
    setFieldError("margin-counter-price", "");
    setFieldError("margin-counter-qty", "");
    updateIncotermUI(true);
    updateBasisUI();
    updateCurrencyUI();
  }

  function updateIncotermUI(resetClause) {
    var code = state.export.incoterm;
    document.querySelectorAll("#margin-incoterm-tabs [data-margin-incoterm]").forEach(function (btn) {
      var active = btn.dataset.marginIncoterm === code;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", String(active));
    });
    var term = incotermInfo(code);
    var needsInsurance = term.seller_pays.insurance;
    $("margin-insurance-group").hidden = !needsInsurance;
    if (needsInsurance && resetClause) $("margin-insurance-clause").value = term.min_insurance_clause;
    $("margin-insurance-help").textContent = code === "CIP"
      ? "CIP는 ICC(A) 부보가 필요해요"
      : "CIF는 ICC(C) 이상이면 돼요. 부보 금액은 CIF 가액의 110%예요";

    var help = code + " · " + term.help;
    if (term.sea_only && $("margin-transport-mode").value === "AIR") {
      help += " (항공이면 " + term.air_equivalent + " 기준으로 계산해요)";
    }
    $("margin-incoterm-help-text").textContent = help;
  }

  function updateBasisUI() {
    document.querySelectorAll("[data-margin-fx-basis]").forEach(function (btn) {
      var active = btn.dataset.marginFxBasis === state.export.basis;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", String(active));
    });
    $("margin-fx-manual-group").hidden = state.export.basis !== "manual";
    renderFxMeta();
  }

  function updateCurrencyUI() {
    var code = $("margin-currency").value || "USD";
    $("margin-counter-currency").textContent = code;
    $("margin-fx-manual-suffix").textContent = "KRW/" + code;
    var rates = state.fx.data ? state.fx.data.rates : {};
    document.querySelectorAll("#margin-currency option").forEach(function (option) {
      option.disabled = Boolean(state.fx.data) && !rates[option.value] && state.export.basis !== "manual";
    });
  }

  /* 환율 --------------------------------------------------------------------- */
  function formatAsOf(iso) {
    if (!iso) return "";
    return String(iso).replace("T", " ").slice(0, 16);
  }

  function renderFxMeta() {
    var data = state.fx.data;
    var meta = $("margin-fx-meta");
    if (state.export.basis === "manual") {
      setBadge("margin-fx-source-badge", FX_SOURCE_VIEW.manual);
      meta.textContent = "직접 입력한 기준 환율(Budget Rate)로 계산해요";
      return;
    }
    if (!data) {
      setBadge("margin-fx-source-badge", null);
      meta.textContent = state.fx.status === "error" ? "환율을 불러오지 못했어요. 새로고침하거나 직접 입력해 주세요" : "환율을 불러오는 중이에요";
      return;
    }
    var key = data.source === "mock" ? "mock" : data.is_fallback ? "cache" : data.source;
    setBadge("margin-fx-source-badge", FX_SOURCE_VIEW[key]);
    var when = formatAsOf(data.as_of);
    if (key === "koreaexim") meta.textContent = "한국수출입은행 · " + when + " 기준";
    else if (key === "open_er_api") meta.textContent = "open.er-api.com · " + when + " 기준 · TTB 추정";
    else if (key === "cache") meta.textContent = when + " 저장값 · 연결이 복구되면 자동 갱신돼요";
    else meta.textContent = "외부 환율을 불러오지 못해 모의 기준 환율을 쓰고 있어요. 직접 입력을 권장해요";
  }

  function loadFxRates(force) {
    var btn = $("margin-fx-refresh-btn");
    btn.disabled = true;
    state.fx.status = "loading";
    renderFxMeta();
    return api("GET", "/fx-rates" + (force ? "?force=1" : ""))
      .then(function (json) {
        state.fx.data = json.data;
        state.fx.warnings = json.warnings || [];
        state.fx.status = "success";
      })
      .catch(function () {
        state.fx.status = "error";
      })
      .then(function () {
        btn.disabled = false;
        $("margin-export-wait").hidden = true;
        renderFxMeta();
        updateCurrencyUI();
        if (state.selection.qty) scheduleExport();
      });
  }

  /* USD 환율 — 물류비 USD 항목 환산용 (§6.4.4): USD 견적이면 선택 기준, 아니면 USD 매매기준율 */
  function currentUsdRate() {
    var currency = $("margin-currency").value;
    var basis = state.export.basis;
    if (currency === "USD" && basis === "manual") {
      var manual = readNumber("margin-fx-manual-rate");
      return manual && manual > 0 ? manual : null;
    }
    var usd = state.fx.data && state.fx.data.rates.USD;
    if (!usd) return null;
    return currency === "USD" && basis === "ttb" ? usd.ttb || usd.base : usd.base;
  }

  /* 물류 계산 ------------------------------------------------------------------ */
  var scheduleExport = debounce(runLogistics, CALC_DEBOUNCE_MS);
  var scheduleQuote = debounce(runQuote, CALC_DEBOUNCE_MS);

  function readExportInputs() {
    var valid = true;
    var carton = {};
    CARTON_FIELDS.forEach(function (f) {
      var value = readNumber(f.id);
      var ok = value !== null && !Number.isNaN(value) && value > f.min && value <= f.max;
      setFieldError(f.id, ok ? "" : f.label + " 사이로 입력해 주세요");
      if (ok) carton[f.key] = value; else valid = false;
    });
    var units = readNumber("margin-carton-units");
    var unitsOk = units !== null && Number.isInteger(units) && units >= 1 && units <= 10000;
    setFieldError("margin-carton-units", unitsOk ? "" : "1~10,000 사이 정수로 입력해 주세요");
    if (unitsOk) carton.units_per_carton = units; else valid = false;
    var allowance = readNumber("margin-carton-allowance");
    var allowanceOk = allowance === null || (!Number.isNaN(allowance) && allowance >= 0 && allowance <= 50);
    setFieldError("margin-carton-allowance", allowanceOk ? "" : "0~50% 사이로 입력해 주세요");
    if (!allowanceOk) valid = false;
    carton.allowance_rate = allowance === null ? state.master.defaults.carton_allowance : allowance;
    if (!valid) return null;

    var clause = $("margin-insurance-group").hidden ? null : $("margin-insurance-clause").value;
    return {
      carton: carton,
      transport_mode: $("margin-transport-mode").value,
      dest_region: $("margin-dest-region").value,
      named_place: $("margin-named-place").value.trim(),
      incoterm: state.export.incoterm,
      insurance_clause: clause,
    };
  }

  function applyExportError(err, alertId, listId) {
    var fields = (err && err.fields) || {};
    var shown = false;
    Object.keys(fields).forEach(function (key) {
      if (EXPORT_FIELD_MAP[key]) { setFieldError(EXPORT_FIELD_MAP[key], fields[key]); shown = true; }
    });
    if (!shown) showListAlert(alertId, listId, [(err && err.message) || "계산하지 못했어요. 잠시 후 다시 시도해 주세요"]);
  }

  function runLogistics() {
    var row = findRow(state.selection.qty);
    if (!row || !state.master) return;
    if (!state.fx.data && state.fx.status !== "error") {
      $("margin-export-wait").hidden = false;
      return;
    }
    var inputs = readExportInputs();
    if (!inputs) return;
    var usdRate = currentUsdRate();
    if (!usdRate) {
      if (state.export.basis === "manual") setFieldError("margin-fx-manual-rate", "환율을 입력해 주세요");
      else showListAlert("margin-fx-alert", "margin-fx-alert-list", ["USD 환율이 없어요. 직접 입력으로 바꿔 주세요"]);
      return;
    }

    var payload = Object.assign({ qty: row.qty, unit_cost: row.unit_cost, supply_price: row.supply_price, usd_rate: usdRate }, inputs);
    if (state.export.controller) state.export.controller.abort();
    var seq = ++state.export.seq;
    state.export.controller = new AbortController();
    setBadge("margin-logistics-status", { cls: "badge-info", text: "계산 중" });

    api("POST", "/calculate-cbm-logistics", payload, state.export.controller.signal)
      .then(function (json) {
        if (seq !== state.export.seq) return;
        state.export.logistics = json.data;
        state.export.logisticsRequest = payload;
        state.export.usdRateUsed = usdRate;
        setBadge("margin-logistics-status", { cls: "badge-success", text: "계산 완료" });
        renderLogistics(json.data, json.warnings || []);
        hideCounterResult();
        runQuote();
      })
      .catch(function (err) {
        if ((err && err.name === "AbortError") || seq !== state.export.seq) return;
        setBadge("margin-logistics-status", { cls: state.export.logistics ? "badge-warning" : "badge-danger", text: state.export.logistics ? "이전 결과" : "계산 오류" });
        applyExportError(err, "margin-logistics-alert", "margin-logistics-alert-list");
      });
  }

  function renderLogistics(data, warnings) {
    var p = data.packing;
    var mode = data.transport_mode;
    $("margin-logistics-empty").hidden = true;
    $("margin-logistics-body").hidden = false;
    $("margin-logistics-subtitle").textContent = data.effective_incoterm + " " + data.named_place + " · 운임·요율은 모의 기준값이에요";

    setTileValue("margin-logistics-cartons", fmt.int(p.cartons) + " CTN");
    setTileValue("margin-logistics-cbm", fmt.num(p.cbm, 3) + " CBM");
    setTileValue("margin-logistics-weight", fmt.num(p.gross_weight_kg, 0) + " kg");
    setTileValue("margin-logistics-chargeable", mode === "AIR"
      ? fmt.num(p.chargeable_kg, 1) + " kg (C.W.)"
      : fmt.num(p.revenue_ton, 3) + " RT");
    setTileValue("margin-logistics-containers", p.containers
      ? p.containers + "대 · 적재율 " + p.utilization + "%"
      : "해당 없음");

    var tbody = $("margin-logistics-tbody");
    tbody.textContent = "";
    data.costs.forEach(function (item) {
      var tr = document.createElement("tr");
      if (item.borne_by === "buyer") tr.className = "margin-row-muted";
      tr.appendChild(cell(item.label));
      var borne = cell();
      var badge = document.createElement("span");
      badge.className = item.borne_by === "seller" ? "badge badge-primary" : "badge";
      badge.textContent = item.borne_by === "seller" ? "매도인" : "매수인";
      borne.appendChild(badge);
      tr.appendChild(borne);
      tr.appendChild(cell(item.currency));
      var amount = item.amount === null ? "—"
        : item.currency === "USD" ? "$" + fmt.num(item.amount, 2) : fmt.won2(item.amount) + "원";
      tr.appendChild(cell(amount, true));
      tr.appendChild(cell(item.krw === null ? "—" : fmt.won2(item.krw) + "원", true));
      tr.appendChild(cell(item.per_unit === null ? "—" : fmt.won2(item.per_unit), true));
      tbody.appendChild(tr);
    });

    setTileValue("margin-logistics-total", fmt.won2(data.totals.seller_total) + "원 (" + fmt.won2(data.totals.per_unit) + "원/ea)");
    setTileValue("margin-logistics-unit-price", fmt.won2(data.incoterm_unit_price_krw) + "원/ea");
    showListAlert("margin-logistics-alert", "margin-logistics-alert-list", warnings.map(function (w) { return w.message; }));
  }

  /* 외화 단가 · 스트레스 --------------------------------------------------------- */
  function runQuote() {
    var logistics = state.export.logistics;
    var tierReq = state.tier.lastRequest;
    if (!logistics || !tierReq) return;
    var basis = state.export.basis;
    var manual = readNumber("margin-fx-manual-rate");
    if (basis === "manual" && !(manual > 0)) {
      setFieldError("margin-fx-manual-rate", "환율을 입력해 주세요");
      return;
    }
    setFieldError("margin-fx-manual-rate", "");

    var payload = {
      qty: logistics.qty,
      unit_cost: state.export.logisticsRequest.unit_cost,
      logistics: { krw_costs: logistics.totals.krw_costs, fx_costs_krw: logistics.totals.fx_costs_krw, insurance: logistics.totals.insurance },
      incoterm_unit_price_krw: logistics.incoterm_unit_price_krw,
      currency: $("margin-currency").value,
      fx_basis: basis,
      fx_manual_rate: basis === "manual" ? manual : null,
      target_margin: tierReq.target_margin,
      min_margin: tierReq.min_margin,
    };
    if (state.export.quoteController) state.export.quoteController.abort();
    var seq = ++state.export.quoteSeq;
    state.export.quoteController = new AbortController();

    api("POST", "/fx-stress", payload, state.export.quoteController.signal)
      .then(function (json) {
        if (seq !== state.export.quoteSeq) return;
        state.export.quote = json.data;
        renderQuote(json.data, json.warnings || []);
        enablePiTab();
        checkPiStale();
      })
      .catch(function (err) {
        if ((err && err.name === "AbortError") || seq !== state.export.quoteSeq) return;
        applyExportError(err, "margin-fx-alert", "margin-fx-alert-list");
      });
  }

  function renderQuote(q, warnings) {
    var logistics = state.export.logistics;
    var place = logistics.effective_incoterm + " " + logistics.named_place;
    var rateText = fmt.rate(q.fx_rate) + " KRW/" + q.currency;

    $("margin-fx-kpi-label").textContent = place + " 외화 단가";
    $("margin-fx-kpi-value").textContent = fmtFx(q.unit_price_fx, q.currency, "price");
    $("margin-fx-kpi-delta").textContent = "원화 " + fmt.won2(q.received_krw_per_unit) + "원/ea · 적용 환율 " + rateText;
    setTileValue("margin-fx-total", fmtFx(q.total_amount_fx, q.currency, "amount"));
    setTileValue("margin-fx-margin-export", fmt.pct(q.margin_rate_export));
    var exw = $("margin-fx-margin-exw").querySelector(".stat-tile__value");
    exw.textContent = (q.margin_rate_exw === null ? "—" : fmt.pct(q.margin_rate_exw)) + " ";
    exw.appendChild(makeBadge(q.status));

    var tbody = $("margin-fx-stress-tbody");
    tbody.textContent = "";
    q.stress.forEach(function (s) {
      var tr = document.createElement("tr");
      if (s.step === 0) tr.className = "is-active";
      var stepCell = cell((s.step > 0 ? "+" : s.step < 0 ? "−" : "") + Math.abs(s.step) + "%" + (s.step === 0 ? " (기준)" : ""), true);
      if (s.step !== 0) stepCell.classList.add(s.step > 0 ? "text-up" : "text-down");
      tr.appendChild(stepCell);
      tr.appendChild(cell(fmt.rate(s.rate), true));
      tr.appendChild(cell(fmt.won2(s.revenue_krw), true));
      tr.appendChild(cell(fmt.won2(s.unit_margin), true));
      var rateCell = cell(s.margin_rate_exw === null ? "—" : "EXW " + fmt.pct(s.margin_rate_exw), true);
      if (s.margin_rate !== null) {
        var sub = document.createElement("span");
        sub.className = "text-caption";
        sub.textContent = " · 수출 " + fmt.pct(s.margin_rate);
        rateCell.appendChild(sub);
      }
      tr.appendChild(rateCell);
      var statusCell = cell();
      statusCell.appendChild(makeBadge(s.status));
      tr.appendChild(statusCell);
      tbody.appendChild(tr);
    });
    $("margin-fx-stress-empty").hidden = true;
    $("margin-fx-stress-wrap").hidden = false;

    setTileValue("margin-fx-breakeven", q.breakeven_rate === null ? "—" : fmt.rate(q.breakeven_rate) + " KRW/" + q.currency);
    setTileValue("margin-fx-defense", q.defense_rate === null ? "—" : fmt.rate(q.defense_rate) + " KRW/" + q.currency);
    $("margin-fx-defense-note").textContent = q.defense_rate === null
      ? "현재 단가로는 어떤 환율에서도 방어선을 지킬 수 없어요"
      : "환율이 " + fmt.rate(q.defense_rate) + " 아래로 내려가면 마진 방어선 아래, " + fmt.rate(q.breakeven_rate) + " 아래면 역마진이에요";

    var fxMessages = warnings.map(function (w) { return w.message; });
    showListAlert("margin-fx-alert", "margin-fx-alert-list", fxMessages);

    setTileValue("margin-summary-incoterm", place);
    setTileValue("margin-summary-fx-price", fmtFx(q.unit_price_fx, q.currency, "price"));
    var rateTile = $("margin-summary-fx-rate").querySelector(".stat-tile__value");
    rateTile.textContent = rateText + " ";
    var source = document.createElement("span");
    source.className = "text-caption";
    var view = q.fx_source === "manual" ? FX_SOURCE_VIEW.manual
      : q.fx_source === "mock" ? FX_SOURCE_VIEW.mock
      : state.fx.data && state.fx.data.is_fallback ? FX_SOURCE_VIEW.cache : FX_SOURCE_VIEW[q.fx_source];
    source.textContent = view ? view.text : "";
    rateTile.appendChild(source);
  }

  /* 환율 입력 변경: USD 환산 환율이 바뀌면 물류부터, 아니면 외화 단가만 다시 계산 */
  function onFxInputChange() {
    updateCurrencyUI();
    renderFxMeta();
    var usdRate = currentUsdRate();
    if (state.export.logistics && usdRate && usdRate !== state.export.usdRateUsed) scheduleExport();
    else scheduleQuote();
  }

  /* 바이어 역제안 ------------------------------------------------------------- */
  function hideCounterResult() {
    state.counter.result = null;
    $("margin-counter-result").hidden = true;
  }

  function setCounterLoading(loading) {
    var btn = $("margin-counter-btn");
    btn.disabled = loading;
    btn.textContent = "";
    if (loading) {
      var spinner = document.createElement("span");
      spinner.className = "spinner spinner-sm";
      btn.appendChild(spinner);
      btn.appendChild(document.createTextNode(" 계산 중"));
    } else {
      btn.textContent = "역산하기";
    }
  }

  function runCounter() {
    var price = readNumber("margin-counter-price");
    var qty = readNumber("margin-counter-qty");
    var ok = true;
    if (price === null || Number.isNaN(price) || price <= 0) {
      setFieldError("margin-counter-price", "0보다 큰 단가를 입력해 주세요");
      ok = false;
    } else if (Math.abs(Math.round(price * 10000) - price * 10000) > 1e-6) {
      setFieldError("margin-counter-price", "소수 4자리까지 입력할 수 있어요");
      ok = false;
    } else {
      setFieldError("margin-counter-price", "");
    }
    if (qty === null || !Number.isInteger(qty) || qty < moq() || qty > maxQty()) {
      setFieldError("margin-counter-qty", fmt.qty(moq()) + " 이상 정수로 입력해 주세요");
      ok = false;
    } else {
      setFieldError("margin-counter-qty", "");
    }
    if (!state.export.quote || !state.export.logisticsRequest || !state.tier.lastRequest) {
      setFieldError("margin-counter-price", "먼저 수출 조건과 외화 단가를 계산해 주세요");
      ok = false;
    }
    if (!ok) return;

    var tierReq = state.tier.lastRequest;
    var payload = {
      counter_price: price,
      currency: state.export.quote.currency,
      fx_rate: state.export.quote.fx_rate,
      qty: qty,
      tier_request: { cost: tierReq.cost, moq: tierReq.moq, target_margin: tierReq.target_margin, min_margin: tierReq.min_margin },
      logistics_request: Object.assign({}, state.export.logisticsRequest, { qty: qty }),
    };
    setCounterLoading(true);
    api("POST", "/reverse-counter-offer", payload)
      .then(function (json) {
        state.counter.result = json.data;
        renderCounter(json.data);
      })
      .catch(function (err) {
        var fields = (err && err.fields) || {};
        var message = fields.counter_price || fields.qty || (err && err.message) || "역산하지 못했어요. 잠시 후 다시 시도해 주세요";
        setFieldError(fields.qty ? "margin-counter-qty" : "margin-counter-price", message);
      })
      .then(function () { setCounterLoading(false); });
  }

  function renderCounter(r) {
    var view = VERDICT_VIEW[r.verdict];
    $("margin-counter-verdict").className = "alert " + view.cls;
    $("margin-counter-verdict-title").textContent = view.title + " · 바이어 " + fmtFx(r.counter_price, r.currency, "price") + " / " + fmt.qty(r.qty);
    $("margin-counter-verdict-text").textContent = r.net_exw_revenue <= 0
      ? "바이어 희망 단가가 물류비보다 낮아요. " + view.text
      : view.text + " (순 EXW 수입 " + fmt.won2(r.net_exw_revenue) + "원/ea)";

    var marginValue = $("margin-counter-margin").querySelector(".stat-tile__value");
    marginValue.textContent = (r.margin_rate_exw === null ? "—" : fmt.pct(r.margin_rate_exw)) + " ";
    marginValue.appendChild(makeBadge(r.status));
    setTileValue("margin-counter-unit-margin", fmt.won2(r.unit_margin) + "원");
    setTileValue("margin-counter-target-price", fmtFx(r.target_price, r.currency, "price") + " (+" + fmt.pct(r.gap_to_target_pct) + ")");
    setTileValue("margin-counter-walkaway", fmtFx(r.walkaway_price, r.currency, "price"));

    var cr = r.cost_reduction;
    $("margin-counter-reduction-summary").textContent = !cr.feasible
      ? "원가 절감만으로는 목표 마진을 확보할 수 없어요"
      : cr.required > 0
        ? "목표 마진 " + r.target_margin + "%를 맞추려면 개당 " + fmt.won2(cr.required) + "원(" + fmt.pct(cr.required_pct) + ")을 줄여야 해요 · 허용 원가 " + fmt.won2(cr.allowed_cost) + "원"
        : "원가를 줄이지 않아도 목표 마진을 확보해요";
    var tbody = $("margin-counter-reduction-tbody");
    tbody.textContent = "";
    cr.by_component.forEach(function (c) {
      var tr = document.createElement("tr");
      tr.appendChild(cell(c.label));
      tr.appendChild(cell(fmt.won2(c.current), true));
      tr.appendChild(cell(fmt.pct(c.share), true));
      tr.appendChild(cell(fmt.won2(c.reduce), true));
      tr.appendChild(cell(fmt.won2(c.after), true));
      tbody.appendChild(tr);
    });

    var guide = r.quantity_guide;
    $("margin-counter-qty-guide").textContent = guide.required_qty
      ? fmt.qty(guide.required_qty) + " 이상 발주하면 목표 마진 " + r.target_margin + "%를 확보해요 (예상 " + fmt.pct(guide.margin_at_required) + ")"
      : "수량만으로는 목표 마진을 확보할 수 없어요 (" + fmt.qty(guide.searched_up_to) + "까지 확인했어요)";

    var apply = $("margin-counter-apply-btn");
    apply.disabled = r.verdict === "negative";
    apply.title = apply.disabled ? "역마진 단가는 견적서에 반영할 수 없어요" : "";
    $("margin-counter-result").hidden = false;
  }

  /* Tab 1 선택 변경 → Tab 2 동기화 */
  function onTierSelected(row) {
    $("margin-export-qty").value = fmt.int(row.qty);
    if (!state.counter.qtyDirty) $("margin-counter-qty").value = row.qty;
    scheduleExport();
  }

  function resetExport() {
    [state.export.controller, state.export.quoteController].forEach(function (c) { if (c) c.abort(); });
    state.export.seq += 1;
    state.export.quoteSeq += 1;
    state.export.logistics = null;
    state.export.logisticsRequest = null;
    state.export.quote = null;
    state.export.usdRateUsed = null;
    state.counter.applied = null;
    hideCounterResult();

    $("margin-export-qty").value = "—";
    $("margin-counter-qty").value = "";
    $("margin-logistics-empty").hidden = false;
    $("margin-logistics-body").hidden = true;
    $("margin-logistics-alert").hidden = true;
    $("margin-fx-alert").hidden = true;
    $("margin-fx-stress-empty").hidden = false;
    $("margin-fx-stress-wrap").hidden = true;
    setBadge("margin-logistics-status", null);
    $("margin-fx-kpi-label").textContent = "외화 단가";
    $("margin-fx-kpi-value").textContent = "—";
    $("margin-fx-kpi-delta").textContent = "";
    ["margin-fx-total", "margin-fx-margin-export", "margin-fx-margin-exw", "margin-fx-breakeven", "margin-fx-defense"]
      .forEach(function (id) { setTileValue(id, "—"); });
    var piTab = $("margin-tab-btn-pi");
    piTab.disabled = true;
    piTab.title = "먼저 수출 조건을 계산해 주세요";
    $("margin-go-pi-btn").disabled = true;
    setExportDefaults();
  }

  function bindExportEvents() {
    document.querySelectorAll("[data-margin-export-input]").forEach(function (el) {
      el.addEventListener(el.tagName === "SELECT" ? "change" : "input", function () {
        if (el.id === "margin-named-place") state.export.namedPlaceDirty = true;
        if (el.id === "margin-dest-region" && !state.export.namedPlaceDirty) {
          var region = state.master.regions.filter(function (r) { return r.code === el.value; })[0];
          if (region) $("margin-named-place").value = region.default_place;
        }
        if (el.id === "margin-transport-mode") updateIncotermUI(false);
        scheduleExport();
      });
    });

    $("margin-incoterm-tabs").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-margin-incoterm]");
      if (!btn || btn.dataset.marginIncoterm === state.export.incoterm) return;
      state.export.incoterm = btn.dataset.marginIncoterm;
      updateIncotermUI(true);
      scheduleExport();
    });

    $("margin-fx-basis-tabs").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-margin-fx-basis]");
      if (!btn) return;
      state.export.basis = btn.dataset.marginFxBasis;
      updateBasisUI();
      if (state.export.basis === "manual" && !$("margin-fx-manual-rate").value) {
        var current = state.export.quote ? state.export.quote.fx_rate : null;
        if (current) $("margin-fx-manual-rate").value = current;
      }
      onFxInputChange();
    });
    $("margin-currency").addEventListener("change", onFxInputChange);
    $("margin-fx-manual-rate").addEventListener("input", onFxInputChange);
    $("margin-fx-refresh-btn").addEventListener("click", function () { loadFxRates(true); });

    $("margin-export-qty-change").addEventListener("click", function (e) {
      e.preventDefault();
      $("margin-tab-btn-tier").click();
    });

    $("margin-counter-qty").addEventListener("input", function () { state.counter.qtyDirty = true; });
    $("margin-counter-price").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); runCounter(); }
    });
    $("margin-counter-btn").addEventListener("click", runCounter);
    $("margin-counter-apply-btn").addEventListener("click", function () {
      var r = state.counter.result;
      if (!r || r.verdict === "negative") return;
      state.counter.applied = { price: r.counter_price, qty: r.qty, currency: r.currency };
      enablePiTab();
      if (state.pi.bound) bindPi(); // 사용자가 명시적으로 적용했으므로 바로 다시 바인딩
      $("margin-tab-btn-pi").click();
    });
    $("margin-go-pi-btn").addEventListener("click", function () {
      enablePiTab();
      $("margin-tab-btn-pi").click();
    });
  }

  /* ==========================================================================
     Tab 3 — 견적서(PI) 미리보기 · 인쇄 · PDF (§2.5, §3.1.7, §5.3~5.4, §6.4.7~6.4.8, §7.5)
     ========================================================================== */
  var PI_PREVIEW_DEBOUNCE_MS = 800;
  var PI_SELLER_STORAGE_KEY = "cosmoa.margin.seller";
  var PI_MAX_EXTRA_ITEMS = 10;
  var PI_FIELD_MAP = {
    "pi.pi_no": "margin-pi-no",
    "pi.issue_date": "margin-pi-date",
    "pi.validity_date": "margin-pi-validity",
    "pi.buyer.company": "margin-buyer-company",
    "pi.buyer.country": "margin-buyer-country",
    "pi.buyer.address": "margin-buyer-address",
    "pi.buyer.contact": "margin-buyer-contact",
    "pi.buyer.email": "margin-buyer-email",
    "pi.seller.company": "margin-seller-company",
    "pi.seller.address": "margin-seller-address",
    "pi.seller.contact": "margin-seller-contact",
    "pi.bank.name": "margin-bank-name",
    "pi.bank.swift": "margin-bank-swift",
    "pi.bank.account": "margin-bank-account",
    "pi.bank.beneficiary": "margin-bank-beneficiary",
    "pi.port_loading": "margin-port-loading",
    "pi.port_discharge": "margin-port-discharge",
    "pi.lead_time_days": "margin-lead-time",
    "pi.shipment_date": "margin-shipment-date",
    "pi.hs_code": "margin-hs-code",
    "pi.remarks": "margin-pi-remarks",
  };
  /* localStorage 에 저장하는 매도인·은행 필드 (§3.4.1) */
  var PI_SELLER_FIELDS = {
    company: "margin-seller-company",
    address: "margin-seller-address",
    contact: "margin-seller-contact",
    bank_name: "margin-bank-name",
    bank_swift: "margin-bank-swift",
    bank_account: "margin-bank-account",
    bank_beneficiary: "margin-bank-beneficiary",
  };
  var PI_EMPTY_PREVIEW = '<!DOCTYPE html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;'
    + 'font-family:sans-serif;color:#6b7684;background:#f9fafb">Tab 2에서 수출 조건을 확정하면 미리보기가 나타나요</body></html>';

  function isoDate(d) {
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function addDays(iso, days) {
    var parts = String(iso).split("-").map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return "";
    return isoDate(new Date(parts[0], parts[1] - 1, parts[2] + days));
  }

  function storageGet(key) {
    try { return JSON.parse(window.localStorage.getItem(key) || "null"); } catch (e) { return null; }
  }

  function storageSet(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* 저장할 수 없는 환경은 무시 */ }
  }

  /* 폼 초기값 -------------------------------------------------------------- */
  function setupPiForm(master) {
    fillSelect("margin-payment-terms", master.payment_terms, function (t) { return t.label; });
    setPiDefaults();
  }

  function setPiDefaults() {
    var d = state.master.defaults;
    var today = isoDate(new Date());
    $("margin-pi-no").value = "COSMOA-PI-" + today.replace(/-/g, "") + "-001";
    $("margin-pi-date").value = today;
    $("margin-pi-validity").value = addDays(today, d.pi_validity_days);
    $("margin-lead-time").value = d.pi_lead_time_days;
    $("margin-shipment-date").value = addDays(today, d.pi_lead_time_days);
    $("margin-hs-code").value = d.hs_code;
    $("margin-payment-terms").value = d.payment_terms;
    ["margin-buyer-company", "margin-buyer-country", "margin-buyer-address", "margin-buyer-contact", "margin-buyer-email",
      "margin-port-loading", "margin-port-discharge", "margin-pi-remarks"].forEach(function (id) { $(id).value = ""; });
    Object.keys(PI_SELLER_FIELDS).forEach(function (k) { $(PI_SELLER_FIELDS[k]).value = ""; });
    state.pi.dirty = {};
    state.pi.extras = [];
    renderExtras();

    var saved = storageGet(PI_SELLER_STORAGE_KEY);
    $("margin-seller-remember").checked = Boolean(saved);
    if (saved) {
      Object.keys(PI_SELLER_FIELDS).forEach(function (k) { if (saved[k]) $(PI_SELLER_FIELDS[k]).value = saved[k]; });
    }
    clearPiErrors();
  }

  function saveSellerIfRemembered() {
    if (!$("margin-seller-remember").checked) return;
    var data = {};
    Object.keys(PI_SELLER_FIELDS).forEach(function (k) { data[k] = $(PI_SELLER_FIELDS[k]).value.trim(); });
    storageSet(PI_SELLER_STORAGE_KEY, data);
  }

  /* 추가 품목 --------------------------------------------------------------- */
  function renderExtras() {
    var tbody = $("margin-pi-extra-tbody");
    tbody.textContent = "";
    state.pi.extras.forEach(function (item, i) {
      var tr = document.createElement("tr");
      [["description", "text", "품목 설명 (영문)"], ["qty", "number", "수량"], ["unit_price", "number", "단가"]].forEach(function (spec) {
        var td = cell(undefined, spec[0] !== "description");
        var input = document.createElement("input");
        input.type = spec[1];
        input.className = "form-control form-control-sm margin-pi-extra-input";
        input.value = item[spec[0]];
        input.placeholder = spec[2];
        input.setAttribute("aria-label", "추가 품목 " + (i + 1) + " " + spec[2]);
        input.dataset.index = String(i);
        input.dataset.key = spec[0];
        if (spec[1] === "number") { input.min = "0"; input.step = spec[0] === "qty" ? "1" : "any"; }
        td.appendChild(input);
        tr.appendChild(td);
      });
      var del = cell();
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-ghost btn-sm";
      btn.dataset.removeIndex = String(i);
      btn.textContent = "삭제";
      del.appendChild(btn);
      tr.appendChild(del);
      tbody.appendChild(tr);
    });
    $("margin-pi-extra-empty").hidden = state.pi.extras.length > 0;
    $("margin-pi-extra-add").disabled = state.pi.extras.length >= PI_MAX_EXTRA_ITEMS;
  }

  /* 시뮬레이션 값 바인딩 (§5.3~5.4) ------------------------------------------- */
  function buildBound() {
    var row = findRow(state.selection.qty);
    var quote = state.export.quote;
    var logistics = state.export.logistics;
    if (!row || !quote || !logistics || !state.export.logisticsRequest) return null;
    var applied = state.counter.applied && state.counter.applied.currency === quote.currency ? state.counter.applied : null;
    var volume = readNumber("margin-product-volume");
    return {
      product_name: $("margin-product-name").value.trim(),
      volume_ml: volume === null || Number.isNaN(volume) ? null : volume,
      qty: applied ? applied.qty : logistics.qty,
      unit_price: applied ? applied.price : quote.unit_price_fx,
      currency: quote.currency,
      incoterm: logistics.effective_incoterm,
      named_place: logistics.named_place,
      transport_mode: logistics.transport_mode,
      carton: state.export.logisticsRequest.carton,
      counter_applied: Boolean(applied),
    };
  }

  function boundSignature(bound) { return bound ? JSON.stringify(bound) : ""; }

  /* 내부 확인용 마진 — PI 요청에는 넣지 않습니다 */
  function boundMargin() {
    var applied = state.pi.bound && state.pi.bound.counter_applied;
    var r = applied ? state.counter.result : state.export.quote;
    if (!r) return null;
    return { rate: r.margin_rate_exw, status: r.status };
  }

  function bindPi() {
    var bound = buildBound();
    if (!bound) return false;
    state.pi.bound = bound;
    state.pi.signature = boundSignature(bound);
    state.pi.margin = boundMargin();
    var mode = state.master.transport_modes.filter(function (m) { return m.code === bound.transport_mode; })[0];
    if (!state.pi.dirty["margin-port-loading"] && mode) $("margin-port-loading").value = mode.port_loading;
    if (!state.pi.dirty["margin-port-discharge"]) $("margin-port-discharge").value = bound.named_place;
    $("margin-pi-stale-alert").hidden = true;
    renderBound();
    renderPreview();
    return true;
  }

  function checkPiStale() {
    if (!state.pi.bound) return;
    var stale = boundSignature(buildBound()) !== state.pi.signature;
    $("margin-pi-stale-alert").hidden = !stale;
    $("margin-pi-stale-text").textContent = state.pi.bound.counter_applied
      ? "견적서에는 이전 조건이 들어가 있어요. 역제안 단가는 이전 원가 기준이에요."
      : "견적서에는 이전 조건이 들어가 있어요.";
  }

  function renderBound() {
    var b = state.pi.bound;
    setTileValue("margin-pi-bound-product", b.product_name || "— (Tab 1에서 영문 제품명을 입력해 주세요)");
    setTileValue("margin-pi-bound-qty", fmt.qty(b.qty));
    setTileValue("margin-pi-bound-price", fmtFx(b.unit_price, b.currency, "price"));
    setTileValue("margin-pi-bound-currency", b.currency);
    setTileValue("margin-pi-bound-incoterm", b.incoterm + " " + b.named_place);
    setTileValue("margin-pi-bound-total", "—");
    var marginValue = $("margin-pi-bound-margin").querySelector(".stat-tile__value");
    var m = state.pi.margin;
    marginValue.textContent = m && m.rate !== null ? fmt.pct(m.rate) + " " : "— ";
    if (m) marginValue.appendChild(makeBadge(m.status));
    $("margin-pi-counter-badge").hidden = !b.counter_applied;
  }

  /* PI 요청 ------------------------------------------------------------------ */
  function collectPi() {
    var val = function (id) { return $(id).value.trim(); };
    return {
      pi_no: val("margin-pi-no"),
      issue_date: val("margin-pi-date"),
      validity_date: val("margin-pi-validity"),
      buyer: {
        company: val("margin-buyer-company"), country: val("margin-buyer-country"), address: val("margin-buyer-address"),
        contact: val("margin-buyer-contact"), email: val("margin-buyer-email"),
      },
      seller: { company: val("margin-seller-company"), address: val("margin-seller-address"), contact: val("margin-seller-contact") },
      bank: {
        name: val("margin-bank-name"), swift: val("margin-bank-swift").toUpperCase(),
        account: val("margin-bank-account"), beneficiary: val("margin-bank-beneficiary"),
      },
      payment_terms: $("margin-payment-terms").value,
      port_loading: val("margin-port-loading"),
      port_discharge: val("margin-port-discharge"),
      lead_time_days: val("margin-lead-time"),
      shipment_date: val("margin-shipment-date"),
      hs_code: val("margin-hs-code"),
      extra_items: state.pi.extras.map(function (x) { return { description: x.description, qty: x.qty, unit_price: x.unit_price }; }),
      remarks: val("margin-pi-remarks"),
    };
  }

  /* render-pi / export-pi-pdf 는 HTML·PDF 를 돌려주므로 api() 대신 fetch 를 직접 씁니다 */
  function piFetch(path, mode, signal) {
    return fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bound: state.pi.bound, pi: collectPi(), version: "1.0", mode: mode }),
      signal: signal,
    }).then(function (res) {
      if (res.ok) return res;
      return res.json().catch(function () { return null; }).then(function (json) {
        var error = (json && json.error) || { code: "HTTP_" + res.status, message: "견적서를 만들지 못했어요. 잠시 후 다시 시도해 주세요" };
        throw { status: res.status, code: error.code, message: error.message, fields: error.fields || {} };
      });
    });
  }

  function clearPiErrors() {
    Object.keys(PI_FIELD_MAP).forEach(function (k) { setFieldError(PI_FIELD_MAP[k], ""); });
    document.querySelectorAll(".margin-pi-extra-input.is-error").forEach(function (el) { el.classList.remove("is-error"); });
    $("margin-pi-form-alert").hidden = true;
  }

  function showPiAlert(kind, title, messages) {
    var alert = $("margin-pi-form-alert");
    alert.className = "alert alert-" + kind;
    $("margin-pi-form-alert-title").textContent = title;
    showListAlert("margin-pi-form-alert", "margin-pi-form-alert-list", messages.length ? messages : [title]);
  }

  function applyPiErrors(err, strict) {
    clearPiErrors();
    state.pi.strictErrors = Boolean(strict);
    var fields = (err && err.fields) || {};
    var messages = [];
    Object.keys(fields).forEach(function (key) {
      var extra = key.match(/^pi\.extra_items\[(\d+)\]\.(\w+)$/);
      if (PI_FIELD_MAP[key]) setFieldError(PI_FIELD_MAP[key], fields[key]);
      else if (extra) {
        var input = document.querySelector('.margin-pi-extra-input[data-index="' + extra[1] + '"][data-key="' + extra[2] + '"]');
        if (input) input.classList.add("is-error");
      }
      messages.push(fields[key]);
    });
    var title = err && err.code === "NON_ENGLISH_TEXT" ? "견적서는 영문으로 작성해 주세요" : (err && err.message) || "입력값을 확인해 주세요";
    showPiAlert("danger", title, messages);
  }

  var schedulePreview = debounce(renderPreview, PI_PREVIEW_DEBOUNCE_MS);

  function setPreviewHtml(html, onLoad) {
    var frame = $("margin-pi-preview-frame");
    if (onLoad) {
      var handler = function () { frame.removeEventListener("load", handler); onLoad(frame); };
      frame.addEventListener("load", handler);
    }
    frame.srcdoc = html;
  }

  function renderPreview() {
    if (!state.pi.bound) { setPreviewHtml(PI_EMPTY_PREVIEW); return; }
    if (state.pi.previewController) state.pi.previewController.abort();
    var seq = ++state.pi.previewSeq;
    state.pi.previewController = new AbortController();
    $("margin-pi-preview-frame").classList.add("margin-pi-frame-loading");
    piFetch("/render-pi", "preview", state.pi.previewController.signal)
      .then(function (res) {
        var total = res.headers.get("X-Margin-PI-Total");
        return res.text().then(function (html) {
          if (seq !== state.pi.previewSeq) return;
          // 미리보기는 필수값을 검사하지 않으므로, PDF·인쇄에서 난 필수값 오류는 사용자가 고칠 때까지 유지
          if (!state.pi.strictErrors) clearPiErrors();
          setPreviewHtml(html);
          if (total) setTileValue("margin-pi-bound-total", total);
          $("margin-pi-preview-meta").textContent = "미리보기 갱신 " + new Date().toLocaleTimeString("ko-KR");
        });
      })
      .catch(function (err) {
        if ((err && err.name === "AbortError") || seq !== state.pi.previewSeq) return;
        applyPiErrors(err);
      })
      .then(function () {
        if (seq === state.pi.previewSeq) $("margin-pi-preview-frame").classList.remove("margin-pi-frame-loading");
      });
  }

  function setButtonLoading(id, loading, label) {
    var btn = $(id);
    btn.disabled = loading;
    btn.textContent = "";
    if (loading) {
      var spinner = document.createElement("span");
      spinner.className = "spinner spinner-sm";
      btn.appendChild(spinner);
      btn.appendChild(document.createTextNode(" " + label));
    } else {
      btn.textContent = label;
    }
  }

  /* 인쇄 — 필수값까지 검증한 PI 를 iframe 에 넣고 iframe 만 인쇄 (페이지 전체 인쇄 아님) */
  function printPi() {
    if (!state.pi.bound) return;
    setButtonLoading("margin-pi-print-btn", true, "준비 중");
    return piFetch("/render-pi", "final")
      .then(function (res) { return res.text(); })
      .then(function (html) {
        state.pi.strictErrors = false;
        clearPiErrors();
        state.pi.previewSeq += 1; // 진행 중인 미리보기 응답이 덮어쓰지 않게
        setPreviewHtml(html, function (frame) {
          frame.contentWindow.focus();
          frame.contentWindow.print();
        });
      })
      .catch(function (err) { applyPiErrors(err, true); })
      .then(function () { setButtonLoading("margin-pi-print-btn", false, "인쇄"); });
  }

  function downloadPdf() {
    if (!state.pi.bound) return;
    setButtonLoading("margin-pi-pdf-btn", true, "PDF 만드는 중");
    piFetch("/export-pi-pdf", "final")
      .then(function (res) {
        var disposition = res.headers.get("Content-Disposition") || "";
        var match = disposition.match(/filename="?([^";]+)"?/);
        var filename = match ? match[1] : "PI.pdf";
        return res.blob().then(function (blob) {
          state.pi.strictErrors = false;
          clearPiErrors();
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        });
      })
      .catch(function (err) {
        if (err && (err.code === "PDF_ENGINE_UNAVAILABLE" || err.code === "PDF_RENDER_FAILED")) {
          showPiAlert("info", err.message, ["인쇄 창의 대상에서 'PDF로 저장'을 선택하면 PDF로 받을 수 있어요"]);
          return printPi();
        }
        applyPiErrors(err, true);
      })
      .then(function () { setButtonLoading("margin-pi-pdf-btn", false, "PDF 다운로드"); });
  }

  /* Tab 3 진입 — 처음이면 바인딩, 이미 있으면 덮어쓰지 않고 stale 여부만 표시 */
  function onEnterPi() {
    if (!state.pi.bound) bindPi();
    else checkPiStale();
  }

  function resetPi() {
    if (state.pi.previewController) state.pi.previewController.abort();
    state.pi.previewSeq += 1;
    state.pi.bound = null;
    state.pi.signature = "";
    state.pi.margin = null;
    ["margin-pi-bound-product", "margin-pi-bound-qty", "margin-pi-bound-price", "margin-pi-bound-currency",
      "margin-pi-bound-incoterm", "margin-pi-bound-total", "margin-pi-bound-margin"].forEach(function (id) { setTileValue(id, "—"); });
    $("margin-pi-stale-alert").hidden = true;
    $("margin-pi-counter-badge").hidden = true;
    $("margin-pi-preview-meta").textContent = "입력하면 잠시 후 자동으로 갱신돼요";
    setPiDefaults();
    setPreviewHtml(PI_EMPTY_PREVIEW);
  }

  function bindPiEvents() {
    document.querySelectorAll("[data-margin-pi-input]").forEach(function (el) {
      el.addEventListener(el.tagName === "SELECT" || el.type === "date" ? "change" : "input", function () {
        state.pi.dirty[el.id] = true;
        setFieldError(el.id, "");
        if (!document.querySelector("#margin-pi-form-card .is-error")) {  // 남은 오류가 없으면 경고도 닫음
          state.pi.strictErrors = false;
          $("margin-pi-form-alert").hidden = true;
        }
        var issue = $("margin-pi-date").value;
        if ((el.id === "margin-pi-date") && !state.pi.dirty["margin-pi-validity"]) {
          $("margin-pi-validity").value = addDays(issue, state.master.defaults.pi_validity_days);
        }
        if ((el.id === "margin-pi-date" || el.id === "margin-lead-time") && !state.pi.dirty["margin-shipment-date"]) {
          var lead = readNumber("margin-lead-time");
          if (lead > 0) $("margin-shipment-date").value = addDays(issue, lead);
        }
        if (el.hasAttribute("data-margin-seller-field")) saveSellerIfRemembered();
        schedulePreview();
      });
    });
    $("margin-seller-remember").addEventListener("change", function (e) {
      if (e.target.checked) saveSellerIfRemembered();
      else storageSet(PI_SELLER_STORAGE_KEY, null);
    });

    $("margin-pi-extra-add").addEventListener("click", function () {
      if (state.pi.extras.length >= PI_MAX_EXTRA_ITEMS) return;
      state.pi.extras.push({ description: "", qty: 1, unit_price: 0 });
      renderExtras();
      var inputs = document.querySelectorAll(".margin-pi-extra-input[data-key='description']");
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    $("margin-pi-extra-tbody").addEventListener("input", function (e) {
      var input = e.target.closest(".margin-pi-extra-input");
      if (!input) return;
      var item = state.pi.extras[Number(input.dataset.index)];
      item[input.dataset.key] = input.value;
      input.classList.remove("is-error");
      schedulePreview();
    });
    $("margin-pi-extra-tbody").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-remove-index]");
      if (!btn) return;
      state.pi.extras.splice(Number(btn.dataset.removeIndex), 1);
      renderExtras();
      schedulePreview();
    });

    $("margin-tab-btn-pi").addEventListener("click", function () { if (!this.disabled) onEnterPi(); });
    $("margin-pi-rebind-btn").addEventListener("click", bindPi);
    $("margin-pi-preview-btn").addEventListener("click", renderPreview);
    $("margin-pi-print-btn").addEventListener("click", printPi);
    $("margin-pi-pdf-btn").addEventListener("click", downloadPdf);
  }

  /* 입력값 초기화 (§5.3) — 확인 Modal 에서 [확인] 시 실행 */
  function resetAll() {
    if (state.controller) state.controller.abort();
    state.requestSeq += 1; // 진행 중이던 응답 무시
    var d = state.master.defaults;

    $("margin-product-name").value = "";
    $("margin-product-volume").value = "50";
    $("margin-product-category").selectedIndex = 0;
    COST_FIELDS.forEach(function (f) { $(f.id).value = ""; });
    $("margin-fixed-cost").value = d.fixed_cost;
    $("margin-loss-rate").value = d.loss_rate;
    $("margin-target-margin").value = d.target_margin;
    $("margin-min-margin").value = d.min_margin;
    $("margin-tier-input").value = "";

    state.tier.tiers = d.tiers.filter(function (q) { return q > d.moq; }).sort(function (a, b) { return a - b; });
    state.tier.priceOverrides = {};
    state.tier.result = null;
    state.tier.status = "idle";
    state.selection.qty = null;

    clearFieldErrors();
    showTierError("");
    setStatusBadge(null);
    $("margin-tier-tbody").textContent = "";
    $("margin-tier-table-wrap").hidden = true;
    $("margin-tier-note").hidden = true;
    $("margin-tier-alert").hidden = true;
    $("margin-tier-empty").hidden = false;
    $("margin-tier-result-subtitle").textContent = "목표 마진 " + d.target_margin + "% · 10원 단위 올림";
    document.querySelectorAll("#margin-summary-bar .stat-tile__value").forEach(function (el) { el.textContent = "—"; });

    $("margin-go-export-btn").disabled = true;
    var exportTab = $("margin-tab-btn-export");
    exportTab.disabled = true;
    exportTab.title = "먼저 수량 구간을 선택해 주세요";
    $("margin-tab-btn-tier").click();

    renderChips();
    renderCostPreview();
    renderChart();
    resetExport();
    resetPi();
  }

  /* 초기화 --------------------------------------------------------------------- */
  function applyMaster(master) {
    state.master = master;
    var d = master.defaults;
    state.tier.tiers = d.tiers.filter(function (q) { return q > d.moq; }).sort(function (a, b) { return a - b; });

    var select = $("margin-product-category");
    master.categories.forEach(function (c) {
      var option = document.createElement("option");
      option.value = c.code;
      option.textContent = c.label;
      select.appendChild(option);
    });
    $("margin-moq").value = fmt.int(d.moq);
    $("margin-fixed-cost").value = d.fixed_cost;
    $("margin-loss-rate").value = d.loss_rate;
    $("margin-target-margin").value = d.target_margin;
    $("margin-min-margin").value = d.min_margin;
    $("margin-tier-input").max = d.max_qty;
    renderChips();
    renderChart();
    setupExportControls(master);
    setupPiForm(master);
    setPreviewHtml(PI_EMPTY_PREVIEW);
  }

  function init() {
    bindEvents();
    api("GET", "/master")
      .then(function (json) {
        applyMaster(json.data);
        loadFxRates(false);
        runCalc();
      })
      .catch(function (err) {
        if (window.console) console.error("[margin] init failed", err);
        showCostError("기준 데이터를 불러오지 못했어요. 새로고침해 주세요");
        $("margin-tier-add-btn").disabled = true;
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

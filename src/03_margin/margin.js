/* 원가 경쟁력 및 마진 시뮬레이션 전용 JavaScript (담당자 C)
   이 페이지에서만 필요한 로직만 작성합니다.
   다른 페이지의 JS를 수정하거나 의존하지 않습니다. 공통 동작은 src/common/common.js 참고.
   기능 명세: src/03_margin/margin.md — 현재 구현 범위: Tab 1 (§2.3, §3.1.3, §4.2, §5, §7.1) */
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
  };

  function $(id) { return document.getElementById(id); }

  /* 포맷 --------------------------------------------------------------------- */
  var fmt = {
    int: function (v) { return Math.round(v).toLocaleString("ko-KR"); },
    krw: function (v) { return Math.round(v).toLocaleString("ko-KR") + "원"; },
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

      tr.appendChild(cell(fmt.int(row.unit_cost), true));

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

      tr.appendChild(cell(fmt.int(row.unit_margin), true));
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

  function renderChart() {
    var container = $("margin-tier-chart");
    var result = state.tier.result;
    container.textContent = "";
    $("margin-tier-chart-empty").hidden = Boolean(result);
    container.hidden = !result;
    if (!result) return;

    var rows = result.rows;
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
      var hit = svg("rect", { class: "margin-chart__hit" + (row.qty === state.selection.qty ? " is-active" : ""), x: pad.left + band * i, y: pad.top, width: band, height: plotH, rx: 8 }, root);
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
      var selected = row.qty === state.selection.qty;
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
      "총 제조원가 " + fmt.krw(row.unit_cost),
      "제안 공급단가 " + fmt.krw(row.supply_price),
      "영업 마진액 " + fmt.krw(row.unit_margin) + "/ea",
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
      addRow(f.label, fmt.krw(base[f.key]), row.discounts[f.key] + "%", fmt.krw(row.breakdown[f.key]));
    });
    addRow("로스(①②③ × " + loss + "%)", "—", "—", fmt.krw(row.breakdown.loss));
    addRow("고정비 분산", fmt.krw(fixed) + " ÷ " + fmt.int(row.qty), "—", fmt.krw(row.breakdown.fixed));
    addRow("총 제조원가", "", "", fmt.krw(row.unit_cost), true);
    window.Common.openModal("margin-cost-breakdown-modal");
  }

  /* 이벤트 --------------------------------------------------------------------- */
  function bindEvents() {
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
  }

  function init() {
    bindEvents();
    api("GET", "/master")
      .then(function (json) {
        applyMaster(json.data);
        runCalc();
      })
      .catch(function () {
        showCostError("기준 데이터를 불러오지 못했어요. 새로고침해 주세요");
        $("margin-tier-add-btn").disabled = true;
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

/* 원가 경쟁력 및 마진 시뮬레이션 전용 JavaScript (담당자 C)
   이 페이지에서만 필요한 로직만 작성합니다.
   다른 페이지의 JS를 수정하거나 의존하지 않습니다. 공통 동작은 src/common/common.js 참고.
   - 화면 Tab(견적 계산 / 역제안 / 수량별 / 환율)과 상세 Tab 전환은 common.js 의 data-tab-target 이 처리합니다.
   - 계산은 모두 브라우저에서 합니다. (서버 호출 없음) */
(() => {
  "use strict";
  const root = document.getElementById("margin-app");
  if (!root) return;

  const $ = (id) => document.getElementById("margin-" + id);
  const num = (id) => parseFloat($(id).value);
  const won = (v) => Math.round(v).toLocaleString("ko-KR") + "원";
  const usd = (v) => "$" + (Math.round(v * 100) / 100).toFixed(2);
  const pct = (v) => (Math.round(v * 1000) / 10).toFixed(1) + "%";
  const money = (v) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const NAMES = { raw: "원재료", proc: "임가공", pack: "부자재" };
  const ICON_X = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';

  /* 판정 단계 → 배경 class / Badge class */
  const ZONE = {
    green: ["is-good", "badge-success"],
    yellow: ["is-caution", "margin-badge-caution"],
    orange: ["is-warn", "badge-warning"],
    red: ["is-bad", "badge-danger"],
  };
  const badge = (z, text) => `<span class="badge ${ZONE[z][1]}">${text}</span>`;
  const setVerdict = (el, z, html) => { el.className = "margin-verdict " + ZONE[z][0]; el.innerHTML = html; };

  const st = {
    mInput: "item", mMode: "margin", absUnit: "krw", qMode: "one",
    tiers: [{ min: 20000, d: 3 }, { min: 50000, d: 5 }],
    fxSettle: null, fxTouched: false,
    adj: {},
    moq: 5000, moqMode: "surcharge", moqSur: 10,
    qtyRows: [{ q: 3000, l: 800000 }, { q: 5000, l: 1000000 }, { q: 10000, l: 1200000 }, { q: 20000, l: 2000000 }, { q: 50000, l: 4000000 }],
    tierData: null,
    quote: null,
  };

  /* 선택 버튼 묶음 (.tabs 모양, Panel 없이 페이지 JS에서 .is-active 토글) */
  function seg(id, key, after) {
    const box = $(id);
    box.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
      st[key] = b.dataset.k;
      box.querySelectorAll(".tab").forEach((x) => {
        x.classList.toggle("is-active", x === b);
        x.setAttribute("aria-selected", String(x === b));
      });
      if (after) after();
      render();
    }));
  }
  seg("seg-minput", "mInput", () => {
    const all = st.mInput === "all";
    root.querySelectorAll(".margin-item-rate").forEach((e) => { e.style.visibility = all ? "hidden" : "visible"; });
    $("all-row").style.display = all ? "grid" : "none";
  });
  seg("seg-mmode", "mMode", () => {
    $("mode-hint").textContent = st.mMode === "margin" ? "판매가 대비" : "원가 대비";
  });
  seg("seg-absunit", "absUnit");
  seg("seg-qmode", "qMode");
  seg("seg-moqmode", "moqMode");

  /* ---------- 계산 ---------- */
  const apply = (base, r, mode) => (mode === "margin" ? base / (1 - r) : base * (1 + r));
  const toSale = (m) => (st.mMode === "margin" ? m : m / (1 + m));

  function readInputs() {
    const p = {
      raw: num("raw"), proc: num("proc"), pack: num("pack"), loss: num("loss") / 100,
      r: { raw: num("r-raw") / 100, proc: num("r-proc") / 100, pack: num("r-pack") / 100 },
      m1: num("m1") / 100, m2: num("m2") / 100, m2min: num("m2min") / 100,
      inco: $("inco").value, qty: num("qty"), logi: num("logi"), fx: num("fx"),
      freight: num("freight"), ins: num("ins") / 100, sagup: $("sagup").checked,
    };
    const bad = [p.raw, p.proc, p.pack, p.loss, p.m2, p.m2min, p.qty, p.logi, p.fx].some(isNaN)
      || p.qty <= 0 || p.fx <= 0 || p.raw < 0 || p.proc < 0 || p.pack < 0;
    if (bad) return { error: "원가·수량·환율을 확인하세요. 수량과 환율은 0보다 커야 해요." };
    const rates = st.mInput === "all" ? { raw: p.m1, proc: p.m1, pack: p.m1 } : { ...p.r };
    if (p.sagup) rates.pack = 0;
    rates.logi = isNaN(num("r-logi")) ? 0 : num("r-logi") / 100;
    if (st.mMode === "margin" && (Object.values(rates).some((v) => v >= 1) || p.m2 >= 1)) {
      return { error: "마진율 방식에서는 마진이 100% 미만이어야 해요." };
    }
    p.rates = rates;
    return p;
  }

  function discountFor(qty) {
    let d = 0;
    [...st.tiers].sort((a, b) => a.min - b.min).forEach((t) => { if (qty >= t.min) d = t.d / 100; });
    return d;
  }

  function forward(p, over = {}) {
    const q = { ...p, ...over };
    const loss = 1 + q.loss;
    const items = { raw: q.raw * loss, proc: q.proc * loss, pack: q.pack * loss };
    const C = items.raw + items.proc + items.pack;
    const supply = {};
    Object.keys(items).forEach((k) => { supply[k] = apply(items[k], q.rates[k], st.mMode); });
    const P1 = supply.raw + supply.proc + supply.pack;
    const L = q.inco === "EXW" ? 0 : q.logi / q.qty;
    const Lsup = apply(L, q.rates.logi || 0, st.mMode); // 물류비 + 물류 마진
    const P2 = P1 + Lsup;
    const P3 = apply(P2, q.m2, st.mMode);
    const d = discountFor(q.qty);
    const belowMoq = q.qty < st.moq;
    const sur = belowMoq && st.moqMode === "surcharge" ? st.moqSur / 100 : 0;
    const P4 = P3 * (1 - d) * (1 + sur);
    let u = P4 / q.fx;
    const fobUsd = u;
    let freightU = 0, insU = 0;
    if (q.inco === "CFR" || q.inco === "CIF") { freightU = (q.freight || 0) / q.qty; u += freightU; }
    if (q.inco === "CIF") { insU = u * 1.1 * (q.ins || 0); u += insU; }
    return {
      items, supply, C, P1, L, Lsup, P2, P3, d, sur, belowMoq, P4, usd: u, fobUsd, freightU, insU,
      m1eff: 1 - (C + L) / P2, m2after: 1 - P2 / P4, marginTotal: P4 - C - L,
    };
  }

  /* ---------- 수량 할인 구간 편집 ---------- */
  function drawTiers() {
    $("tiers").innerHTML = st.tiers.map((t, i) => `
      <div class="margin-tier-row">
        <div class="margin-field"><input class="form-control form-control-sm" type="number" step="1000" value="${t.min}" data-i="${i}" data-f="min" aria-label="할인 시작 수량"><span class="margin-field__unit">개</span></div>
        <div class="margin-field"><input class="form-control form-control-sm" type="number" step="0.5" value="${t.d}" data-i="${i}" data-f="d" aria-label="할인율"><span class="margin-field__unit">%</span></div>
        <button type="button" class="btn btn-secondary btn-icon" data-del="${i}" aria-label="구간 삭제">${ICON_X}</button>
      </div>`).join("") || '<p class="text-caption">할인 구간이 없어요. 모든 수량에 정가가 적용돼요.</p>';
    $("tiers").querySelectorAll("input").forEach((e) => e.addEventListener("input", () => {
      const v = parseFloat(e.value);
      st.tiers[e.dataset.i][e.dataset.f] = isNaN(v) ? 0 : v;
      render();
    }));
    $("tiers").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
      st.tiers.splice(+b.dataset.del, 1);
      drawTiers();
      render();
    }));
  }
  $("add-tier").addEventListener("click", () => {
    const last = st.tiers.length ? Math.max(...st.tiers.map((t) => t.min)) : 10000;
    st.tiers.push({ min: last * 2, d: 0 });
    drawTiers();
    render();
  });

  /* ---------- 렌더 ---------- */
  function render() {
    const p = readInputs();
    const inco = $("inco").value;
    $("sea-row").style.display = ["CFR", "CIF"].includes(inco) ? "grid" : "none";
    $("ins-box").style.visibility = inco === "CIF" ? "visible" : "hidden";
    $("err").textContent = p.error || "";
    if (p.error) return;
    const r = forward(p);
    renderForward(p, r);
    renderReverse(p, r);
    renderTier(p);
    renderFx(p, r);
  }

  function renderForward(p, r) {
    $("hero-cap").textContent = `${p.inco} 단가 · ${p.qty.toLocaleString()}개`;
    $("hero-usd").innerHTML = usd(r.usd) + '<span class="kpi-unit">/ 개</span>';
    const unit = Math.round(r.usd * 100) / 100;
    let sub = `<span>원화 ${won(r.P4)}</span><span>주문 총액 $${Math.round(unit * p.qty).toLocaleString()}</span>`;
    if (r.d > 0) sub += `<span class="badge badge-primary">수량 할인 ${pct(r.d)} 적용</span>`;
    if (r.belowMoq) {
      sub += st.moqMode === "block"
        ? `<span class="badge badge-danger">MOQ ${st.moq.toLocaleString()}개 미달 · 주문 불가</span>`
        : `<span class="badge badge-warning">MOQ 미달 소량 할증 ${pct(r.sur)}</span>`;
    }
    $("hero-sub").innerHTML = sub;

    /* 구성 막대: 합계가 max(할인 전, 할인·할증 후)가 되도록 영업마진은 둘 중 작은 값까지만 */
    const segs = [
      ["원가", r.C, "is-cost"], ["1차 마진", r.P1 - r.C, "is-m1"],
      ["물류비", r.L, "is-logi"], ["물류 마진", r.Lsup - r.L, "is-logi-m"],
      ["영업마진", Math.min(r.P3, r.P4) - r.P2, "is-m2"],
      ["수량 할인", r.P3 - r.P4, "is-disc"], ["소량 할증", r.P4 - r.P3, "is-sur"],
    ];
    const barMax = Math.max(r.P3, r.P4);
    $("bar").innerHTML = segs.filter((s) => s[1] > 0.0001).map((s) => {
      const w = (s[1] / barMax) * 100;
      return `<div class="${s[2]}" style="width:${w}%" title="${s[0]} ${won(s[1])}">${w > 9 ? Math.round(s[1]).toLocaleString() : ""}</div>`;
    }).join("");

    const low = r.m2after < p.m2min;
    const tile = (label, value, cls = "") => `<div class="stat-tile"><span class="stat-tile__label">${label}</span><span class="stat-tile__value ${cls}">${value}</span></div>`;
    $("stats").innerHTML = tile("원가", won(r.C))
      + tile("1차 마진 (물류 포함)", pct(r.m1eff))
      + tile("할인 후 영업마진", pct(r.m2after), low ? "is-low" : "")
      + tile("총 마진 (판매가 대비)", pct(r.marginTotal / r.P4));

    const n = (v) => `<td class="is-numeric">${v}</td>`;
    $("item-table").innerHTML = '<thead><tr><th>항목</th><th class="is-numeric">원가</th><th class="is-numeric">마진율</th><th class="is-numeric">공급가</th><th class="is-numeric">마진</th></tr></thead><tbody>'
      + Object.keys(NAMES).map((k) => `<tr><td>${NAMES[k]}${k === "pack" && p.sagup ? ' <span class="badge badge-primary">사급</span>' : ""}</td>${n(won(r.items[k]))}${n(pct(p.rates[k]))}${n(won(r.supply[k]))}${n(won(r.supply[k] - r.items[k]))}</tr>`).join("")
      + `<tr><td>물류비 <span class="text-caption">개당</span></td>${n(won(r.L))}${n(pct(p.rates.logi))}${n(won(r.Lsup))}${n(won(r.Lsup - r.L))}</tr>`
      + `<tr class="margin-total"><td>합계</td>${n(won(r.C + r.L))}${n(pct(r.m1eff))}${n(won(r.P2))}${n(won(r.P2 - r.C - r.L))}</tr></tbody>`;

    /* 마진 녹이기 (내부·대외 비교) */
    const maxAbs = Math.max(0, Math.floor(r.marginTotal / 10) * 10);
    ["abs-c", "abs-l"].forEach((id) => { $(id).max = maxAbs; });
    const aC = Math.min(num("abs-c"), maxAbs), aL = Math.min(num("abs-l"), maxAbs);
    $("abs-cv").textContent = won(aC);
    $("abs-lv").textContent = won(aL);
    const f = (v) => (st.absUnit === "krw" ? won(v) : usd(v / p.fx));
    const extM = r.marginTotal - aC - aL;
    const rows = (c, l, m, tot) => `<tbody><tr><td>원가</td>${n(f(c))}</tr><tr><td>물류비</td>${n(f(l))}</tr>`
      + `<tr><td>마진</td>${n(`${f(m)} <span class="text-caption">${pct(m / r.P4)}</span>`)}</tr>`
      + `<tr class="margin-total"><td>단가</td>${n(f(tot))}</tr></tbody>`;
    $("int-table").innerHTML = rows(r.C, r.L, r.marginTotal, r.P4);
    $("ext-table").innerHTML = rows(r.C + aC, r.L + aL, extM, r.P4);
    $("abs-warn").innerHTML = extM < 0 ? '<span class="badge badge-danger">마진 초과 흡수</span>'
      : (aC / r.C > 0.2 ? '<span class="badge badge-warning">원가 +20% 초과</span>' : "");

    /* 견적서 — 화면 미리보기와 PDF 가 같은 값(st.quote)을 씁니다 */
    const qty = p.qty, fx = p.fx, U = Math.round(r.usd * 100) / 100;
    const product = $("q-product").value.trim() || "Product";
    const lines = [], breakdown = [];
    if (st.qMode === "split") {
      const logiU = (r.L + aL) / fx;
      const prodU = Math.round((r.usd - logiU - r.freightU - r.insU) * 100) / 100;
      lines.push({ description: `${product} (EXW)`, qty: `${qty.toLocaleString()} pcs`, unit_price: prodU, amount: prodU * qty });
      if (logiU > 0) lines.push({ description: "Local logistics to port of loading", qty: "1 lot", unit_price: "", amount: logiU * qty });
      if (r.freightU) lines.push({ description: "Ocean freight", qty: "1 lot", unit_price: "", amount: r.freightU * qty });
      if (r.insU) lines.push({ description: "Marine insurance", qty: "1 lot", unit_price: "", amount: r.insU * qty });
    } else {
      lines.push({ description: product, qty: `${qty.toLocaleString()} pcs`, unit_price: U, amount: U * qty });
      if (st.qMode === "open") {
        const c = (r.C + aC) / fx, l = (r.L + aL) / fx, m = extM / fx;
        breakdown.push({ label: "Product cost (materials, filling, packaging)", usd: c, share: pct((c * fx) / r.P4) });
        if (l > 0) breakdown.push({ label: "Logistics to port of loading", usd: l, share: pct((l * fx) / r.P4) });
        breakdown.push({ label: "Margin", usd: m, share: pct(extM / r.P4) });
        if (r.freightU) breakdown.push({ label: "Ocean freight", usd: r.freightU, share: "" });
        if (r.insU) breakdown.push({ label: "Marine insurance", usd: r.insU, share: "" });
      }
    }
    lines.forEach((l) => { l.amount = Math.round(l.amount * 100) / 100; });
    st.quote = {
      mode: st.qMode, incoterm: p.inco, lines, breakdown,
      total: lines.reduce((sum, l) => sum + l.amount, 0),
      moq: `${st.moq.toLocaleString()} pcs`,
      discount_note: r.d > 0 ? `Volume discount of ${pct(r.d)} is included in the unit price.` : "",
    };

    const today = new Date().toISOString().slice(0, 10);
    const rowsHtml = lines.map((l) => `<tr><td>${esc(l.description)}</td>${n(esc(l.qty))}${n(l.unit_price === "" ? "" : usd(l.unit_price))}${n(money(l.amount))}</tr>`).join("");
    const bdHtml = breakdown.length
      ? '<table class="table margin-table-compact"><thead><tr><th>Cost breakdown (per pc)</th><th class="is-numeric">USD</th><th class="is-numeric">Share</th></tr></thead><tbody>'
        + breakdown.map((b) => `<tr><td>${b.label}</td>${n(usd(b.usd))}${n(b.share)}</tr>`).join("") + "</tbody></table>"
      : "";
    $("quote").innerHTML = `<div class="margin-quote__head"><strong>QUOTATION</strong><span class="text-caption">${today} · Validity 30 days</span></div>
      <table class="table"><thead><tr><th>Description</th><th class="is-numeric">Q'ty</th><th class="is-numeric">Unit price (${p.inco})</th><th class="is-numeric">Amount</th></tr></thead>
      <tbody>${rowsHtml}<tr class="margin-total"><td>Total</td><td></td><td></td>${n(money(st.quote.total))}</tr></tbody></table>${bdHtml}
      <p class="text-caption margin-quote__terms">Terms: ${p.inco} · Payment T/T · MOQ ${st.moq.toLocaleString()} pcs${r.d > 0 ? ` · Volume discount ${pct(r.d)} included` : ""}</p>`;
    renderQuoteSummary();
  }

  /* ---------- 견적서 PDF 팝업 ---------- */
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
  const qv = (id) => $(id).value.trim();
  const MODE_NAMES = { one: "통합형", split: "분리형", open: "오픈북형" };
  let profileLoaded = false;

  function renderQuoteSummary() {
    const q = st.quote;
    if (!q) return;
    $("q-summary").textContent = `${MODE_NAMES[q.mode]} · ${q.incoterm} · ${q.lines[0].qty} · 합계 ${money(q.total)} — 견적 계산 값이 그대로 들어가요`;
  }

  async function loadProfile() {
    if (profileLoaded) return;
    try {
      const res = await fetch(root.dataset.profileUrl, { headers: { Accept: "application/json" } });
      if (!res.ok || !(res.headers.get("Content-Type") || "").includes("json")) throw new Error();
      const data = await res.json();
      $("q-company").value = data.company.name;
      if (!qv("q-contact-name")) $("q-contact-name").value = data.contact.name || "";
      if (!qv("q-contact-email")) $("q-contact-email").value = data.contact.email || "";
      profileLoaded = true;
    } catch (e) {
      $("q-err").textContent = "회사 정보를 불러오지 못했어요. 다시 로그인한 뒤 열어 주세요.";
    }
  }

  async function downloadQuotePdf() {
    const q = st.quote, btn = $("q-pdf"), err = $("q-err");
    const required = [["q-buyer-company", "고객사 회사명"], ["q-no", "견적 번호"], ["q-product", "품목명"]];
    const missing = required.filter(([id]) => !qv(id));
    required.forEach(([id]) => $(id).classList.toggle("is-error", !qv(id)));
    if (missing.length) { err.textContent = missing.map((m) => m[1]).join(", ") + "을(를) 입력하세요."; $(missing[0][0]).focus(); return; }
    if (!q) return;
    err.textContent = "";
    const payload = {
      ...q,
      quote_no: qv("q-no"), issue_date: new Date().toISOString().slice(0, 10),
      validity_days: parseInt(qv("q-validity"), 10) || 30,
      contact: { name: qv("q-contact-name"), email: qv("q-contact-email") },
      buyer: { company: qv("q-buyer-company"), country: qv("q-buyer-country"), attn: qv("q-buyer-attn"), address: qv("q-buyer-address"), email: qv("q-buyer-email") },
      payment: qv("q-payment"), named_place: qv("q-place"), lead_time: qv("q-lead"), remarks: qv("q-remarks"),
    };
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-sm"></span> 만드는 중';
    try {
      const res = await fetch(root.dataset.pdfUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const type = res.headers.get("Content-Type") || "";
      if (!res.ok || !type.includes("pdf")) {
        let msg = type.includes("html") ? "로그인이 만료됐어요. 다시 로그인해 주세요." : "PDF를 만들지 못했어요.";
        try { msg = (await res.json()).error || msg; } catch (e) { /* JSON 이 아니면 기본 문구 */ }
        throw new Error(msg);
      }
      const name = (res.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name ? name[1] : "Quotation.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      window.Common.closeModal("margin-quote-modal");
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }

  /* .container 는 Container Query 기준이라 fixed 요소가 화면이 아닌 본문 기준으로 배치됩니다.
     팝업이 화면 가운데에 뜨도록 body 바로 아래로 옮깁니다. (열기·닫기는 common.js 가 document 에서 처리) */
  document.body.appendChild($("quote-modal"));
  $("q-no").value = "QT-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-01";
  $("q-open").addEventListener("click", loadProfile);   // 팝업 열기는 common.js(data-modal-open)가 처리
  $("q-pdf").addEventListener("click", downloadQuotePdf);
  $("quote-modal").querySelectorAll("input, textarea").forEach((e) => e.addEventListener("input", () => {
    e.classList.remove("is-error");
    if (e.id === "margin-q-product") render();
  }));

  function renderReverse(p, r) {
    const t = num("target"), floor = num("item-floor") / 100;
    const bad = isNaN(t) || t <= 0 || isNaN(floor);
    $("r-err").textContent = bad ? "목표가와 항목별 최소 마진을 입력하세요." : "";
    if (bad) { $("verdict").innerHTML = ""; $("gauge").innerHTML = ""; return; }

    const sea = p.inco === "CFR" || p.inco === "CIF";
    const toUsd = (krw) => { let u = krw / p.fx; if (sea) u += r.freightU; if (p.inco === "CIF") u += u * 1.1 * p.ins; return u; };
    const toKrw = (u) => { let v = u; if (p.inco === "CIF") v = v / (1 + 1.1 * p.ins); if (sea) v -= r.freightU; return v * p.fx; };
    const withM2 = (sup, m) => apply(sup, m, st.mMode);
    const supMaxFor = (krw, m) => (st.mMode === "margin" ? krw * (1 - m) : krw / (1 + m));

    /* 항목별 원가·공급가 (물류 포함) */
    const keys = ["raw", "proc", "pack", "logi"];
    const cost = { ...r.items, logi: r.L }, sup = { ...r.supply, logi: r.Lsup };
    const floorSup = {};
    keys.forEach((k) => { floorSup[k] = apply(cost[k], Math.min(floor, p.rates[k] || 0), st.mMode); });

    /* 가격 기준선 */
    const T = toKrw(t);
    const P = {
      breakeven: toUsd(r.C + r.L),
      floor: toUsd(withM2(keys.reduce((a, k) => a + floorSup[k], 0), p.m2min)),
      min: toUsd(withM2(r.P2, p.m2min)),
      goal: toUsd(withM2(r.P2, p.m2)),
    };
    const m2now = 1 - r.P2 / T;

    let z;
    if (t >= P.goal - 1e-9) z = ["green", "수락 가능", `${usd(t)}에 받아도 영업마진 ${pct(m2now)}`, `목표 영업마진 ${pct(p.m2)} 이상이 남아요.`];
    else if (t >= P.min - 1e-9) z = ["yellow", "영업마진 양보", `영업마진 ${pct(m2now)}로 받을 수 있어요`, `최소 영업마진(${pct(p.m2min)})은 지켜요. 1차·물류 마진은 그대로예요.`];
    else if (t >= P.floor - 1e-9) z = ["orange", "1차·물류 마진 조정", "1차·물류 마진을 줄이면 가능해요", `영업마진 ${pct(p.m2min)}를 지키려면 1차·물류 마진에서 줄여야 해요.`];
    else z = ["red", "마진만으로 불가", t * p.fx < r.C + r.L ? "원가와 물류비보다 낮은 가격이에요" : "모든 마진을 최소로 줄여도 부족해요", `물류 조건, 수량, 부자재 사양을 바꿔야 해요. 최대 양보가는 ${usd(P.floor)}예요.`];
    setVerdict($("verdict"), z[0], `${badge(z[0], z[1])}<p class="margin-verdict__title">${z[2]}</p><p class="margin-verdict__desc">${z[3]}</p>`);

    /* Gauge */
    const pts = [P.breakeven, P.floor, P.min, P.goal, t];
    const lo = Math.min(...pts) * 0.97, hi = Math.max(...pts) * 1.03;
    const pos = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    const zones = [[lo, P.floor, "is-bad"], [P.floor, P.min, "is-warn"], [P.min, P.goal, "is-caution"], [P.goal, hi, "is-good"]]
      .filter((q) => q[1] > q[0]);
    const ticks = [["손익분기", P.breakeven], ["최대 양보가", P.floor], ["최소 마진가", P.min], ["목표 마진가", P.goal]]
      .map((q) => ({ l: q[0], v: q[1], x: pos(q[1]) })).sort((a, b) => a.x - b.x);
    let lastX = -99, row = 0;
    ticks.forEach((q) => { row = q.x - lastX < 13 && row === 0 ? 1 : 0; q.r = row; lastX = q.x; });
    $("gauge").innerHTML = `<div class="margin-gauge__track">${zones.map((q) => `<div class="${q[2]}" style="width:${((q[1] - q[0]) / (hi - lo)) * 100}%"></div>`).join("")}</div>`
      + ticks.map((q) => `<div class="margin-gauge__tick${q.r ? " is-row2" : ""}" style="left:${q.x}%"><b>${usd(q.v)}</b>${q.l}</div>`).join("")
      + `<div class="margin-gauge__pin" style="left:${pos(t)}%"><b>바이어 ${usd(t)}</b><i></i></div>`;

    /* 마진 직접 조정 (물류 포함) */
    let supNew = 0, totalCut = 0;
    keys.forEach((k) => {
      const curR = p.rates[k] || 0;
      const inp = $("adj-" + k);
      const touched = st.adj[k] !== undefined;
      const nr = touched ? st.adj[k] : curR;
      if (document.activeElement !== inp) inp.value = +(nr * 100).toFixed(2);
      inp.classList.toggle("is-changed", touched && Math.abs(nr - curR) > 1e-9);
      const ns = apply(cost[k], nr, st.mMode);
      const d = sup[k] - ns;
      supNew += ns;
      totalCut += d;
      $("adj-cur-" + k).textContent = pct(curR);
      $("adj-cut-" + k).innerHTML = Math.abs(d) < 0.5 ? '<span class="text-caption">-</span>'
        : `<span class="${d > 0 ? "text-up" : ""}">${d > 0 ? "−" : "+"}${won(Math.abs(d))}</span>`;
    });
    const mAdj = 1 - supNew / T;
    const gSale = toSale(p.m2), mnSale = toSale(p.m2min);
    const need = supNew - supMaxFor(T, p.m2min);
    const zc = mAdj >= gSale - 1e-9 ? ["green", "목표 마진 이상"] : mAdj >= mnSale - 1e-9 ? ["yellow", "최소 마진 이상"] : mAdj >= 0 ? ["orange", "최소 마진 미달"] : ["red", "영업 손실"];
    const priceAdj = toUsd(withM2(supNew, p.m2min));
    setVerdict($("adj-foot"), zc[0], `${badge(zc[0], zc[1])}
      <p class="margin-verdict__title">${usd(t)}에서 영업마진 ${pct(mAdj)}</p>
      <p class="margin-verdict__desc">${Math.abs(totalCut) < 0.5 ? "아직 조정 없음" : `조정 마진 합계 ${totalCut > 0 ? "−" : "+"}${won(Math.abs(totalCut))}`} · ${need > 0.5
        ? `최소 영업마진까지 <b class="text-up">${won(need)}</b> 더 줄여야 해요`
        : `최소 영업마진 대비 여유 <b>${won(-need)}</b>`}
      <br>이 조정안으로 최소 영업마진을 지키는 단가 <b>${usd(priceAdj)}</b></p>`);
    $("adj-foot").classList.add("margin-adj-foot");

    /* 대응 방안 */
    const opts = [];
    opts.push(["재역제안", usd(P.min), "1차·물류 마진은 그대로 두고 영업마진만 최소선까지 양보한 가격."]);
    const Smax = supMaxFor(T, p.m2min), base = r.C + r.L;
    if (Smax > base) {
      const u = st.mMode === "margin" ? 1 - base / Smax : Smax / base - 1;
      opts.push(["1차·물류 마진 일괄", pct(u), `${usd(t)}를 받고 영업마진 ${pct(p.m2min)}를 지키는 공통 마진율.`]);
    }
    if (p.inco !== "EXW") opts.push(["EXW로 전환", usd(forward(p, { inco: "EXW" }).usd), "물류비와 물류 마진을 빼고 바이어가 운송을 맡는 조건."]);
    const next = [...st.tiers].sort((a, b) => a.min - b.min).find((q) => q.min > p.qty);
    if (next) {
      const nq = forward(p, { qty: next.min, logi: p.logi * (next.min / p.qty) * 0.85 });
      opts.push([`${next.min.toLocaleString()}개로 늘리면`, usd(nq.usd), `할인 ${next.d}% 적용, 할인 후 영업마진 ${pct(nq.m2after)}. 물류비는 수량 비례의 85%로 가정.`]);
    }
    const best = t >= P.min ? -1 : 0;
    $("options").innerHTML = opts.map((o, i) => `<div class="margin-option${i === best ? " is-best" : ""}"><span class="margin-option__label">${o[0]}</span><p class="margin-option__value">${o[1]}</p><p class="margin-option__desc">${o[2]}</p></div>`).join("");
  }

  function renderFx(p, r) {
    const sea = p.inco === "CFR" || p.inco === "CIF";
    const useQ = $("fx-use-quote").checked;
    $("fx-contract").disabled = useQ;
    if (useQ) $("fx-contract").value = (Math.round(r.usd * 100) / 100).toFixed(2);
    const contract = num("fx-contract");
    if (isNaN(contract) || contract <= 0) {
      $("fx-verdict").className = "margin-verdict";
      $("fx-verdict").innerHTML = '<p class="margin-verdict__desc">계약 단가를 입력하세요.</p>';
      return;
    }

    /* 달러 단가 중 FOB 부분만 원화로 바뀜 (해상운임·보험료는 그대로 지급) */
    let fobU = contract;
    if (p.inco === "CIF") fobU = fobU / (1 + 1.1 * p.ins);
    if (sea) fobU -= r.freightU;
    const g = toSale(p.m2), mn = toSale(p.m2min);
    const base = r.C + r.L, P2 = r.P2;
    const rev = (fx) => fobU * fx;
    const m2At = (fx) => 1 - P2 / rev(fx);
    const totAt = (fx) => (rev(fx) - base) / rev(fx);
    const fxBE = base / fobU, fxMin = P2 / (1 - mn) / fobU, fxGoal = P2 / (1 - g) / fobU;

    /* Slider 범위: 견적 환율 ±15% */
    const lo = Math.round((p.fx * 0.85) / 10) * 10, hi = Math.round((p.fx * 1.15) / 10) * 10;
    const sl = $("fx-settle");
    sl.min = lo;
    sl.max = hi;
    if (!st.fxTouched || st.fxSettle == null) st.fxSettle = p.fx;
    st.fxSettle = Math.min(hi, Math.max(lo, st.fxSettle));
    sl.value = st.fxSettle;
    const f = st.fxSettle, chg = f / p.fx - 1;
    $("fx-min-l").textContent = lo.toLocaleString() + "원";
    $("fx-max-l").textContent = hi.toLocaleString() + "원";
    $("fx-settle-val").innerHTML = Math.round(f).toLocaleString() + '<span class="kpi-unit">원</span>';
    $("fx-chg").innerHTML = Math.abs(chg) < 0.0005 ? '<span class="text-caption">견적 환율</span>'
      : `<span class="${chg > 0 ? "text-up" : "text-down"}">${chg > 0 ? "▲" : "▼"} ${pct(Math.abs(chg))}</span>`;

    /* 판정 */
    const m = m2At(f), diffUnit = rev(f) - rev(p.fx);
    let z;
    if (m >= g - 1e-9) z = ["green", "목표 마진 유지"];
    else if (m >= mn - 1e-9) z = ["yellow", "최소 마진 이상"];
    else if (m >= 0) z = ["orange", "최소 마진 미달"];
    else z = ["red", "영업 손실"];
    const needU = (() => { let u = P2 / (1 - g) / f; if (sea) u += r.freightU; if (p.inco === "CIF") u += u * 1.1 * p.ins; return u; })();
    setVerdict($("fx-verdict"), z[0], `${badge(z[0], z[1])}
      <p class="margin-verdict__title">영업마진 ${pct(m)}</p>
      <p class="margin-verdict__desc">총 마진 ${pct(totAt(f))} · ${Math.abs(diffUnit) < 0.5 ? "견적 환율 기준" : `견적 환율 대비 주문 이익 ${diffUnit > 0 ? "+" : "−"}${won(Math.abs(diffUnit * p.qty))}`}
      ${m < g - 1e-9 ? `<br>목표 마진 유지 단가 <b>${usd(needU)}</b>` : ""}</p>`);

    /* 차트 */
    const W = 820, H = 215, L = 50, R = 16, T = 16, B = 30;
    const ys = [m2At(lo), m2At(hi), totAt(lo), totAt(hi), g, mn, 0];
    const y0 = Math.floor((Math.min(...ys) - 0.03) * 20) / 20, y1 = Math.ceil((Math.max(...ys) + 0.03) * 20) / 20;
    const X = (v) => L + ((v - lo) / (hi - lo)) * (W - L - R);
    const Y = (v) => T + ((y1 - v) / (y1 - y0)) * (H - T - B);
    const band = (a, b, c) => { a = Math.max(a, y0); b = Math.min(b, y1); return b > a ? `<rect class="${c}" x="${L}" y="${Y(b)}" width="${W - L - R}" height="${Y(a) - Y(b)}"/>` : ""; };
    const path = (fn) => { let d = ""; for (let i = 0; i <= 60; i++) { const v = lo + ((hi - lo) * i) / 60; d += (i ? "L" : "M") + X(v).toFixed(1) + "," + Y(fn(v)).toFixed(1); } return d; };
    let grid = "";
    const step = y1 - y0 > 0.4 ? 0.1 : 0.05;
    for (let v = Math.ceil(y0 / step) * step; v <= y1 + 1e-9; v += step) {
      grid += `<line class="c-grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`;
    }
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      grid += `<text x="${X(v)}" y="${H - 8}" text-anchor="middle">${Math.round(v).toLocaleString()}</text>`;
    }
    const thrLine = (v, c, lab) => (v >= y0 && v <= y1
      ? `<line class="${c}" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke-dasharray="4 4"/><text class="${c}" x="${W - R - 4}" y="${Y(v) - 5}" text-anchor="end">${lab}</text>`
      : "");
    const px = X(f), py = Y(m);
    const bubbleX = Math.min(W - R - 70, Math.max(L + 70, px));
    $("fx-chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="환율별 영업마진 그래프">
      ${band(g, 9, "c-band-good")}${band(mn, g, "c-band-caution")}${band(0, mn, "c-band-warn")}${band(-9, 0, "c-band-bad")}
      ${grid}
      ${thrLine(g, "c-thr-good", "목표 " + pct(g))}${thrLine(mn, "c-thr-warn", "최소 " + pct(mn))}${thrLine(0, "c-thr-bad", "손익 0")}
      <line class="c-ref" x1="${X(p.fx)}" x2="${X(p.fx)}" y1="${T}" y2="${H - B}" stroke-dasharray="3 3"/>
      <path class="c-sub" d="${path(totAt)}" stroke-width="2" stroke-dasharray="6 4"/>
      <path class="c-main" d="${path(m2At)}" stroke-width="2.5"/>
      <line class="c-now" x1="${px}" x2="${px}" y1="${T}" y2="${H - B}"/>
      <circle class="c-dot" cx="${px}" cy="${py}" r="5.5" stroke-width="2.5"/>
      <g transform="translate(${bubbleX},${Math.max(T + 14, py - 18)})"><rect class="c-bubble" x="-72" y="-16" width="144" height="24" rx="7"/>
      <text class="c-inv" x="0" y="0" text-anchor="middle">${Math.round(f).toLocaleString()}원 · ${pct(m)}</text></g>
    </svg>`;

    /* 버틸 수 있는 환율 */
    const thrRow = (k, v, note) => {
      const d = v / p.fx - 1;
      return `<div class="margin-thr"><div class="margin-thr__k">${k}</div><div class="margin-thr__v">${Math.round(v).toLocaleString()}원</div>
        <div class="margin-thr__d">${note} · ${d < 0 ? `견적 환율에서 ${pct(-d)} 하락까지 버팀` : "견적 환율에서 이미 미달"}</div></div>`;
    };
    $("fx-thr").innerHTML = thrRow("목표 영업마진 환율", fxGoal, `영업마진 ${pct(g)} 유지`)
      + thrRow("최소 영업마진 환율", fxMin, `영업마진 ${pct(mn)} 유지`)
      + thrRow("손익분기 환율", fxBE, "원가와 물류비만 회수");

    /* 시나리오 표 */
    $("fx-qty").textContent = p.qty.toLocaleString();
    const steps = [-0.10, -0.05, 0, 0.05, 0.10];
    $("fx-table").innerHTML = '<thead><tr><th>변동</th><th class="is-numeric">환율</th><th class="is-numeric">개당 원화</th><th class="is-numeric">영업마진</th><th class="is-numeric">주문 영업이익</th></tr></thead><tbody>'
      + steps.map((s) => {
        const ff = p.fx * (1 + s), mm = m2At(ff), prof = (rev(ff) - P2) * p.qty;
        const zz = mm >= g - 1e-9 ? "green" : mm >= mn - 1e-9 ? "yellow" : mm >= 0 ? "orange" : "red";
        return `<tr class="${s === 0 ? "is-active" : ""}"><td>${s === 0 ? "견적" : (s > 0 ? "+" : "") + Math.round(s * 100) + "%"}</td>`
          + `<td class="is-numeric">${Math.round(ff).toLocaleString()}</td><td class="is-numeric">${won(rev(ff))}</td>`
          + `<td class="is-numeric">${badge(zz, pct(mm))}</td><td class="is-numeric">${prof < 0 ? "−" : ""}${won(Math.abs(prof))}</td></tr>`;
      }).join("") + "</tbody>";
  }

  function renderTier(p) {
    $("sur-box").style.visibility = st.moqMode === "surcharge" ? "visible" : "hidden";
    const rows = st.qtyRows.map((row, i) => ({ ...row, i })).sort((a, b) => a.q - b.q);
    const data = rows.map((row) => {
      const r = forward(p, { qty: row.q, logi: row.l });
      return { ...row, r, off: r.belowMoq && st.moqMode === "block" };
    });
    const base = data.find((x) => !x.r.belowMoq) || data[0];
    const valid = data.filter((x) => !x.off);
    const best = valid.reduce((a, b) => (b.r.usd < a.r.usd ? b : a), valid[0] || data[0]);

    /* 요약 */
    const moqRow = forward(p, { qty: st.moq, logi: (base ? base.l / base.q : p.logi / p.qty) * st.moq });
    $("tier-summary").innerHTML = `<span class="badge badge-primary">MOQ ${st.moq.toLocaleString()}개부터 ${usd(moqRow.usd)}</span>
      <p class="margin-verdict__title">${best ? `${best.q.toLocaleString()}개면 ${usd(best.r.usd)}` : ""}</p>
      <p class="margin-verdict__desc">${best && best.q !== st.moq ? `MOQ 단가보다 ${pct(1 - best.r.usd / moqRow.usd)} 낮아요 · 할인 후 영업마진 ${pct(best.r.m2after)}` : "가격표에서 가장 낮은 단가예요."}</p>`;

    /* 차트 */
    const W = 820, H = 230, L = 50, R = 12, T = 30, B = 46;
    const n = data.length, slot = (W - L - R) / n, bw = Math.min(64, slot * 0.5);
    const vals = data.map((x) => x.r.usd);
    const y0 = Math.max(0, Math.floor(Math.min(...vals) * 0.85 * 10) / 10), y1 = Math.ceil(Math.max(...vals) * 1.06 * 10) / 10;
    const Y = (v) => T + ((y1 - v) / (y1 - y0)) * (H - T - B);
    let g = "";
    const stp = y1 - y0 > 0.8 ? 0.2 : 0.1;
    for (let v = Math.ceil(y0 / stp) * stp; v <= y1 + 1e-9; v += stp) {
      g += `<line class="c-grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">$${v.toFixed(1)}</text>`;
    }
    let bars = "", moqX = null;
    data.forEach((x, k) => {
      const cx = L + slot * k + slot / 2, top = Y(x.r.usd), h = H - B - top;
      const cur = x.q === p.qty;
      const fill = x.r.belowMoq ? 'fill="url(#margin-hatch)"' : `class="${cur ? "c-bar-cur" : "c-bar-other"}"`;
      if (moqX === null && !x.r.belowMoq && k > 0) moqX = L + slot * k;
      const noteCls = x.r.d > 0 ? "c-disc" : x.r.sur > 0 ? "c-sur" : "c-plain";
      const note = x.r.d > 0 ? "할인 −" + Math.round(x.r.d * 100) + "%" : x.r.sur > 0 ? "할증 +" + Math.round(x.r.sur * 100) + "%" : x.off ? "MOQ 미만" : "정가";
      bars += `<rect x="${cx - bw / 2}" y="${top}" width="${bw}" height="${h}" rx="8" ${fill}/>
        <text class="${x.off ? "c-muted" : "c-value"}" x="${cx}" y="${top - 8}" text-anchor="middle">${x.off ? "불가" : usd(x.r.usd)}</text>
        <text class="c-strong" x="${cx}" y="${H - B + 20}" text-anchor="middle">${x.q.toLocaleString()}개</text>
        <text class="${noteCls}" x="${cx}" y="${H - B + 38}" text-anchor="middle">${note}</text>`;
    });
    const moqLine = moqX !== null
      ? `<line class="c-now" x1="${moqX}" x2="${moqX}" y1="${T - 18}" y2="${H - B}" stroke-dasharray="4 4"/>
        <rect class="c-bubble" x="${moqX - 34}" y="${T - 28}" width="68" height="20" rx="6"/><text class="c-inv" x="${moqX}" y="${T - 14}" text-anchor="middle">MOQ</text>`
      : "";
    $("q-chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="수량별 단가 막대 그래프">
      <defs><pattern id="margin-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="c-hatch-bg" width="6" height="6"/><rect class="c-hatch-fg" width="3" height="6"/></pattern></defs>
      ${g}<line class="c-axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>${bars}${moqLine}</svg>`;

    /* 가격표 */
    $("tier-table").innerHTML = `<thead><tr><th>수량</th><th class="is-numeric">물류비 총액</th><th class="is-numeric">개당 물류</th><th class="is-numeric">${p.inco} 단가</th><th class="is-numeric">영업마진</th><th class="is-numeric">주문 총액</th><th></th></tr></thead><tbody>`
      + data.map((x) => {
        const r = x.r;
        const zz = r.m2after < p.m2min - 1e-9 ? "red" : r.m2after < p.m2 - 1e-9 ? "yellow" : "green";
        const tag = x.q === p.qty ? '<span class="margin-tag is-now">현재</span>'
          : x.q === st.moq ? '<span class="margin-tag">MOQ</span>'
          : r.belowMoq ? '<span class="margin-tag is-under">MOQ 미만</span>' : "";
        const adj = r.d > 0 ? `<span class="margin-tag text-down">할인 −${pct(r.d)}</span>` : r.sur > 0 ? `<span class="margin-tag text-up">할증 +${pct(r.sur)}</span>` : "";
        return `<tr class="${x.q === p.qty ? "is-active" : ""} ${x.off ? "is-off" : ""}">
          <td><div class="margin-field margin-w-qty"><input class="form-control form-control-sm" type="number" step="1000" value="${x.q}" data-qi="${x.i}" data-f="q" aria-label="수량"><span class="margin-field__unit">개</span></div></td>
          <td class="is-numeric"><div class="margin-field margin-w-logi"><input class="form-control form-control-sm" type="number" step="100000" value="${x.l}" data-qi="${x.i}" data-f="l" aria-label="물류비 총액"><span class="margin-field__unit">원</span></div></td>
          <td class="is-numeric">${won(r.L)}</td>
          <td class="is-numeric"><b>${x.off ? "주문 불가" : usd(r.usd)}</b>${tag}${adj}</td>
          <td class="is-numeric">${x.off ? "-" : badge(zz, pct(r.m2after))}</td>
          <td class="is-numeric">${x.off ? "-" : "$" + Math.round((Math.round(r.usd * 100) / 100) * x.q).toLocaleString()}</td>
          <td><button type="button" class="btn btn-ghost btn-icon" data-qdel="${x.i}" aria-label="수량 삭제">${ICON_X}</button></td></tr>`;
      }).join("") + "</tbody>";
    $("tier-table").querySelectorAll("input").forEach((e) => e.addEventListener("change", () => {
      const v = parseFloat(e.value);
      if (!isNaN(v) && v > 0) st.qtyRows[e.dataset.qi][e.dataset.f] = v;
      render();
    }));
    $("tier-table").querySelectorAll("[data-qdel]").forEach((b) => b.addEventListener("click", () => {
      if (st.qtyRows.length > 1) { st.qtyRows.splice(+b.dataset.qdel, 1); render(); }
    }));
    st.tierData = { data, p };
  }

  /* ---------- 이벤트 ---------- */
  [["moq", "moq"], ["moq-sur", "moqSur"]].forEach(([id, key]) => $(id).addEventListener("input", () => {
    const v = parseFloat($(id).value);
    if (isNaN(v) || v < 0) return;
    st[key] = v;
    render();
  }));

  $("copy-tier").addEventListener("click", async () => {
    if (!st.tierData) return;
    const { data, p } = st.tierData;
    const lines = [`Price list (${p.inco} Korea, USD per pc)`, `MOQ: ${st.moq.toLocaleString()} pcs`]
      .concat(data.filter((x) => !x.off).map((x) => `${x.q.toLocaleString()} pcs : ${usd(x.r.usd)}${x.r.d > 0 ? ` (volume discount ${Math.round(x.r.d * 100)}%)` : ""}${x.r.sur > 0 ? " (small-lot surcharge incl.)" : ""}`));
    const txt = lines.join("\n");
    const b = $("copy-tier");
    try { await navigator.clipboard.writeText(txt); b.textContent = "복사됨"; }
    catch (e) { window.prompt("아래 내용을 복사하세요", txt); }
    setTimeout(() => { b.textContent = "바이어용 가격표 복사"; }, 1500);
  });

  $("add-qty").addEventListener("click", () => {
    const last = st.qtyRows[st.qtyRows.length - 1];
    st.qtyRows.push({ q: last.q * 2, l: Math.round((last.l * 1.7) / 100000) * 100000 });
    render();
  });

  $("fx-settle").addEventListener("input", (e) => { st.fxSettle = +e.target.value; st.fxTouched = true; render(); });
  $("fx-reset").addEventListener("click", () => { st.fxTouched = false; render(); });

  ["raw", "proc", "pack", "logi"].forEach((k) => $("adj-" + k).addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    if (isNaN(v)) return;
    if (st.mMode === "margin" && v >= 100) return;
    st.adj[k] = v / 100;
    render();
  }));
  $("adj-reset").addEventListener("click", () => { st.adj = {}; render(); });

  /* 입력 Card 전체 + 탭별 입력 (할인 구간 입력은 drawTiers 에서 따로 연결) */
  $("inputs").querySelectorAll("input, select").forEach((e) => e.addEventListener("input", render));
  ["fx", "target", "item-floor", "abs-c", "abs-l", "fx-contract", "fx-use-quote"].forEach((id) => $(id).addEventListener("input", render));

  drawTiers();
  render();
})();

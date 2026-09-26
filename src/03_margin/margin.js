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
  const pctN = (v) => Math.round(v * 1000) / 10 + "%";   // 기준값 표시용 (20.0% → 20%)
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
    if (p.m2min > p.m2) return { error: "최소 영업마진(방어선)은 목표 영업마진보다 클 수 없어요." };
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

  /* ---------- 수량 할인 구간 편집 (수량별 단가 탭) ----------
     값을 바꾸면 단가표·견적 단가에 바로 반영하고, 구간 시작 수량이 표에 없으면 그 수량 행을 추가해 할인 효과가 보이게 합니다. */
  function drawTiers() {
    $("tiers").innerHTML = st.tiers.map((t, i) => `
      <div class="margin-disc__item">
        <div class="margin-field margin-w-qty"><input class="form-control form-control-sm" type="number" step="1000" value="${t.min}" data-i="${i}" data-f="min" aria-label="할인 시작 수량"><span class="margin-field__unit">개</span></div>
        <span class="text-caption">이상</span>
        <div class="margin-field margin-w-rate"><input class="form-control form-control-sm" type="number" step="0.5" value="${t.d}" data-i="${i}" data-f="d" aria-label="할인율"><span class="margin-field__unit">%</span></div>
        <button type="button" class="btn btn-ghost btn-icon" data-del="${i}" aria-label="구간 삭제">${ICON_X}</button>
      </div>`).join("") || '<p class="text-caption">할인 구간이 없어요. 모든 수량에 정가가 적용돼요.</p>';
    $("tiers").querySelectorAll("input").forEach((e) => {
      e.addEventListener("input", () => {
        const v = parseFloat(e.value);
        st.tiers[e.dataset.i][e.dataset.f] = isNaN(v) || v < 0 ? 0 : v;
        render();
      });
      if (e.dataset.f === "min") e.addEventListener("change", () => { if (ensureQtyRow(st.tiers[e.dataset.i].min)) render(); });
    });
    $("tiers").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
      st.tiers.splice(+b.dataset.del, 1);
      drawTiers();
      render();
    }));
  }
  $("add-tier").addEventListener("click", () => {
    const last = st.tiers.length ? st.tiers.reduce((a, b) => (b.min > a.min ? b : a)) : { min: 10000, d: 0 };
    const t = { min: last.min * 2, d: last.d + 2 };
    st.tiers.push(t);
    ensureQtyRow(t.min);
    drawTiers();
    render();
  });

  /* 가격표에 없는 수량이면 행 추가 — 물류비 총액은 가장 가까운 수량 행에서 (수량비)^0.75 로 약식 추정 (수량이 늘수록 개당 물류비가 줄어드는 관행) */
  function ensureQtyRow(q) {
    if (!(q > 0) || st.qtyRows.some((row) => row.q === q)) return false;
    const near = st.qtyRows.reduce((a, b) => (Math.abs(Math.log(b.q / q)) < Math.abs(Math.log(a.q / q)) ? b : a));
    st.qtyRows.push({ q, l: Math.max(10000, Math.round((near.l * Math.pow(q / near.q, 0.75)) / 10000) * 10000) });
    return true;
  }

  /* ---------- ERP 연동 (제조원가 · 1차 마진) ----------
     서버 /api/margin-calculator/erp-cost 가 품목의 원가·1차 마진율을 돌려줍니다. (시연 단계: 예시 품목 1개)
     받은 값은 세부 항목 칸에 채우고, 이후 직접 고치면 '수정됨'으로 표시합니다. */
  const ERP_FIELDS = { raw: "raw", proc: "proc", pack: "pack", "r-raw": "rate_raw", "r-proc": "rate_proc", "r-pack": "rate_pack", loss: "loss" };
  let erp = null;   // { item_code, item_name, synced_at, vals }

  function erpDirty() {
    if (!erp) return false;
    return Object.keys(ERP_FIELDS).some((id) => Math.abs(num(id) - erp.vals[ERP_FIELDS[id]]) > 1e-9)
      || $("sagup").checked !== erp.vals.sagup;
  }

  function syncErpStatus() {
    const el = $("erp-status");
    if (!erp) { el.textContent = "ERP 미연동 · 예시 값"; return; }
    el.innerHTML = `${esc(erp.item_code)} ${esc(erp.item_name)} · `
      + (erpDirty() ? '<span class="margin-erp-dirty">ERP 값에서 수정됨</span>' : `${esc(erp.synced_at.slice(11, 16))} 동기화`);
  }

  $("erp-sync").addEventListener("click", async () => {
    const btn = $("erp-sync"), label = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-sm"></span> 불러오는 중';
    $("erp-err").textContent = "";
    try {
      const res = await fetch(root.dataset.erpUrl, { headers: { Accept: "application/json" } });
      if (!res.ok || !(res.headers.get("Content-Type") || "").includes("json")) throw new Error();
      const data = await res.json();
      Object.keys(ERP_FIELDS).forEach((id) => { $(id).value = data[ERP_FIELDS[id]]; });
      $("sagup").checked = !!data.sagup;
      if (st.mInput !== "item") $("seg-minput").querySelector('[data-k="item"]').click();   // ERP 는 항목별 마진율
      if (data.product_en) $("q-product").value = data.product_en;
      erp = { item_code: data.item_code, item_name: data.item_name, synced_at: data.synced_at, vals: { ...data, sagup: !!data.sagup } };
      render();
      btn.textContent = "연동됨";
      setTimeout(() => { btn.textContent = label; }, 1500);
    } catch (e) {
      $("erp-err").textContent = "ERP 원가를 불러오지 못했어요. 다시 로그인한 뒤 시도해 주세요.";
      btn.textContent = label;
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- 약식 포장/CBM 추정 (물류비 입력 보조) ----------
     카톤 수 = ⌈수량 ÷ 카톤당 입수⌉, CBM = 카톤 수 × 카톤 부피.
     LCL 은 1 CBM 미만도 1 CBM 으로 청구하는 관행에 맞춰 운임 계산만 최소 1 CBM 을 적용합니다. */
  const CBM_PRESETS = { toner: { ea: 40, box: 0.025 }, cream: { ea: 60, box: 0.025 }, mask: { ea: 200, box: 0.025 } };
  const FCL_HINT_CBM = 15;   // 이 이상이면 20ft 컨테이너(FCL) 견적 비교를 권장
  let cbmEst = null;

  function renderCbm(p) {
    const ea = num("cbm-ea"), box = num("cbm-box"), inland = num("cbm-inland"), lcl = num("cbm-lcl");
    if ([ea, box, inland, lcl].some(isNaN) || ea <= 0 || box <= 0 || inland < 0 || lcl < 0) {
      cbmEst = null;
      $("cbm-peek").textContent = "";
      $("cbm-out").innerHTML = '<p class="form-error">카톤당 입수·부피는 0보다 크고, 단가는 0 이상이어야 해요.</p>';
      $("cbm-apply").disabled = true;
      return;
    }
    const cartons = Math.ceil(p.qty / ea), cbm = cartons * box, billed = Math.max(1, cbm);
    cbmEst = { cartons, cbm, logi: Math.round((billed * inland) / 10000) * 10000, freight: Math.ceil(billed * lcl) };
    $("cbm-peek").textContent = `${cartons.toLocaleString()}카톤 · ${cbm.toFixed(2)} CBM`;
    $("cbm-out").innerHTML = `<div class="margin-cbm-out__row"><span>카톤 ${cartons.toLocaleString()}박스</span><b>${cbm.toFixed(2)} CBM</b></div>
      <div class="margin-cbm-out__row"><span>FOB 내륙물류비</span><b>${won(cbmEst.logi)}</b></div>
      <div class="margin-cbm-out__row"><span>해상운임 (LCL)</span><b>$${cbmEst.freight.toLocaleString()}</b></div>
      ${cbm < 1 ? '<p class="text-caption">1 CBM 미만은 LCL 최소 1 CBM으로 계산했어요.</p>' : ""}
      ${cbm >= FCL_HINT_CBM ? `<p class="text-caption margin-cbm-out__hint">${FCL_HINT_CBM} CBM 이상이에요. 20ft 컨테이너(FCL) 견적과 비교해 보세요.</p>` : ""}`;
    $("cbm-apply").disabled = false;
  }

  $("cbm-preset").addEventListener("input", () => {   // 아래 입력 Card 공통 listener(render)보다 먼저 등록
    const pr = CBM_PRESETS[$("cbm-preset").value];
    $("cbm-ea").value = pr.ea;
    $("cbm-box").value = pr.box;
  });
  $("cbm-apply").addEventListener("click", () => {
    if (!cbmEst) return;
    $("logi").value = cbmEst.logi;
    $("freight").value = cbmEst.freight;
    render();
    const b = $("cbm-apply");
    b.textContent = "반영됨 · 직접 수정 가능";
    setTimeout(() => { b.textContent = "운임 반영"; }, 1500);
  });

  /* ---------- 현재 USD TTB (서버 /api/margin-calculator/fx-rate, 10분 캐시) ----------
     수출 대금을 원화로 받는 기준인 TTB(전신환 받으실 때)를 기준 환율 라벨 아래 'TTB 1,351.1' 알약 버튼으로 보여주고,
     누르면 기준 환율 칸에 넣습니다. 이미 같은 값이면 ✓ 표시 후 잠금. */
  let liveFx = null;
  const FX_REFRESH_MS = 10 * 60 * 1000;

  async function loadLiveFx() {
    try {
      const res = await fetch(root.dataset.fxUrl, { headers: { Accept: "application/json" } });
      if (!res.ok || !(res.headers.get("Content-Type") || "").includes("json")) throw new Error();
      liveFx = await res.json();
      if (!(liveFx.rate > 0)) throw new Error();
    } catch (e) {
      liveFx = null;
    }
    syncLiveFx();
  }

  function syncLiveFx() {
    const btn = $("fxlive-apply");
    if (!liveFx) {
      btn.disabled = true;
      btn.textContent = "TTB 없음";
      btn.title = "현재 TTB 환율을 불러오지 못했어요. 10분 뒤 다시 시도해요.";
      return;
    }
    const r1 = Math.round(liveFx.rate * 10) / 10;
    const same = Math.abs(num("fx") - r1) < 0.05;
    btn.disabled = same;
    btn.textContent = `TTB ${r1.toLocaleString("ko-KR")}${same ? " ✓" : ""}`;
    btn.title = `${same ? "기준 환율에 적용됨" : "누르면 기준 환율에 적용"} · USD TTB ${liveFx.rate.toLocaleString("ko-KR")}원 · ${liveFx.source} · ${liveFx.as_of} 기준`;
  }

  $("fxlive-apply").addEventListener("click", () => {
    if (!liveFx) return;
    $("fx").value = Math.round(liveFx.rate * 10) / 10;   // 소수 1자리
    render();
  });

  /* ---------- 렌더 ---------- */
  function render() {
    syncLiveFx();
    const p = readInputs();
    const inco = $("inco").value;
    $("sea-row").style.display = ["CFR", "CIF"].includes(inco) ? "grid" : "none";
    $("ins-box").style.visibility = inco === "CIF" ? "visible" : "hidden";
    $("err").textContent = p.error || "";
    syncErpStatus();
    if (p.error) { $("cost-sum").textContent = "-"; return; }
    const r = forward(p);
    renderCbm(p);            // 물류비 요약이 CBM 추정값을 쓰므로 먼저 계산
    renderInputSummary(p, r);
    renderForward(p, r);
    renderReverse(p, r);
    renderTier(p);
    renderFx(p, r);
  }

  /* 접힌 입력 섹션 요약 — 원가 합계(로스 포함) / 물류비 (접힌 상태에서도 부피 스펙이 보이도록 CBM·카톤 수 포함) */
  function renderInputSummary(p, r) {
    $("cost-sum").textContent = won(r.C);
    const exw = p.inco === "EXW";
    $("logi-sum").textContent = exw ? "EXW · 미포함" : won(p.logi);
    const peek = exw ? ["바이어 운송"] : [`개당 ${won(r.L)}`, `마진 ${pct(p.rates.logi)}`];
    if (cbmEst) peek.unshift(`${cbmEst.cbm.toFixed(2)} CBM (${cbmEst.cartons.toLocaleString()}박스)`);
    if (p.inco === "CFR" || p.inco === "CIF") peek.push(`해상 $${(p.freight || 0).toLocaleString()}`);
    if (p.inco === "CIF") peek.push(`보험 ${(Math.round(p.ins * 10000) / 100)}%`);
    $("logi-peek").textContent = peek.join(" · ");

    /* 입력 Card 아래 현재 견적 요약 */
    const low = r.m2after < toSale(p.m2min) - 1e-9;
    $("quick").innerHTML = `<div class="margin-quick__row"><span>현재 견적 · ${p.inco} ${p.qty.toLocaleString()}개</span><b class="margin-quick__price">${usd(r.usd)}</b></div>
      <div class="margin-quick__row"><span>주문 총액</span><b>$${Math.round((Math.round(r.usd * 100) / 100) * p.qty).toLocaleString()}</b></div>
      <div class="margin-quick__row"><span>할인 후 영업마진</span><b class="${low ? "is-low" : ""}">${pct(r.m2after)}</b></div>`;
  }

  function renderForward(p, r) {
    syncPlace(p.inco);
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
    const shown = segs.filter((s) => s[1] > 0.0001);
    /* 범례는 막대에 실제로 있는 항목만 (할인·할증이 없으면 숨김) */
    root.querySelectorAll("#margin-bar-legend [data-seg]").forEach((e) => { e.hidden = !shown.some((s) => s[2] === e.dataset.seg); });
    $("bar").innerHTML = shown.map((s) => {
      const w = (s[1] / barMax) * 100;
      return `<div class="${s[2]}" style="width:${w}%" title="${s[0]} ${won(s[1])}">${w > 9 ? Math.round(s[1]).toLocaleString() : ""}</div>`;
    }).join("");

    /* 할인 후 영업마진은 판매가 대비 값이라 목표·최소도 판매가 대비(toSale)로 바꿔 비교 */
    const low = r.m2after < toSale(p.m2min) - 1e-9;
    /* 라벨은 짧게 한 줄, 기준·설명은 값 아래 보조 줄로 (4개 타일 높이 통일) */
    const tile = (label, value, note, cls = "") => `<div class="stat-tile"><span class="stat-tile__label">${label}</span><span class="stat-tile__value ${cls}">${value}</span><span class="margin-stat-note">${note}</span></div>`;
    $("stats").innerHTML = tile("원가", won(r.C), r.C > 0 && p.loss > 0 ? `로스 ${pct(p.loss)} 포함` : "개당 제조원가")
      + tile("1차 마진", pct(r.m1eff), "물류 포함")
      + tile("할인 후 영업마진", pct(r.m2after), `<span>목표 ${pctN(toSale(p.m2))}</span> · <span>최소 ${pctN(toSale(p.m2min))}</span>`, low ? "is-low" : "")
      + tile("총 마진", pct(r.marginTotal / r.P4), "판매가 대비");

    const n = (v) => `<td class="is-numeric">${v}</td>`;
    $("item-table").innerHTML = '<thead><tr><th>항목</th><th class="is-numeric">원가</th><th class="is-numeric">마진율</th><th class="is-numeric">공급가</th><th class="is-numeric">마진</th></tr></thead><tbody>'
      + Object.keys(NAMES).map((k) => `<tr><td>${NAMES[k]}${k === "pack" && p.sagup ? ' <span class="badge badge-primary">사급</span>' : ""}</td>${n(won(r.items[k]))}${n(pct(p.rates[k]))}${n(won(r.supply[k]))}${n(won(r.supply[k] - r.items[k]))}</tr>`).join("")
      + `<tr><td>물류비 <span class="text-caption">개당</span></td>${n(won(r.L))}${n(pct(p.rates.logi))}${n(won(r.Lsup))}${n(won(r.Lsup - r.L))}</tr>`
      + `<tr class="margin-total"><td>합계</td>${n(won(r.C + r.L))}${n(pct(r.m1eff))}${n(won(r.P2))}${n(won(r.P2 - r.C - r.L))}</tr></tbody>`;

    /* 마진 흡수 (견적서 발행 옵션 — 체크하지 않으면 흡수 0) */
    const absOn = $("abs-on").checked;
    $("abs-box").hidden = !absOn;
    const maxAbs = Math.max(0, Math.floor(r.marginTotal / 10) * 10);
    ["abs-c", "abs-l"].forEach((id) => { $(id).max = maxAbs; });
    const aC = absOn ? Math.min(num("abs-c"), maxAbs) : 0, aL = absOn ? Math.min(num("abs-l"), maxAbs) : 0;
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
      mode: st.qMode, incoterm: p.inco, lines, breakdown, unit: U, qty,
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
      <p class="text-caption margin-quote__terms">Terms: ${p.inco} ${esc(placeFor(p.inco))} · Payment T/T · MOQ ${st.moq.toLocaleString()} pcs${r.d > 0 ? ` · Volume discount ${pct(r.d)} included` : ""}</p>`;
    renderQuoteSummary();
  }

  /* ---------- 견적서 PDF 팝업 ---------- */
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
  const qv = (id) => $(id).value.trim();

  /* 가격 조건 — 인코텀즈(좌측 margin-inco 와 양방향 연동) + 지정 장소(Named place).
     지정 장소는 인코텀즈의 의미별로 선택지가 다릅니다: EXW = 판매자 공장 소재지, FOB = 한국 선적항, CFR·CIF = 도착항.
     선택지에 없으면 '직접 입력'. 직접 고른·입력한 값은 같은 의미 안(CFR ↔ CIF)에서는 유지하고, 의미가 바뀌면 기본값으로 되돌립니다.
     실제 값은 #margin-q-place 하나이고 PDF·미리보기·팝업 요약·영문 제안문·가격표 복사가 같은 값을 씁니다. */
  const DEST_PORTS = ["Los Angeles, USA", "Long Beach, USA", "New York, USA", "Vancouver, Canada", "Shanghai, China", "Hong Kong",
    "Tokyo, Japan", "Osaka, Japan", "Singapore", "Ho Chi Minh City, Vietnam", "Bangkok, Thailand", "Port Klang, Malaysia",
    "Jakarta, Indonesia", "Jebel Ali, UAE", "Rotterdam, Netherlands", "Hamburg, Germany", "Sydney, Australia"];
  const PLACE_GROUPS = {
    EXW: { hint: "EXW 지정 장소 = 판매자 공장 소재지", def: "Korea", list: ["Korea", "Seller's factory, Korea", "Hwaseong, Korea", "Pyeongtaek, Korea", "Sejong, Korea", "Eumseong, Korea"] },
    FOB: { hint: "FOB 지정 장소 = 한국 선적항", def: "Busan, Korea", list: ["Busan, Korea", "Incheon, Korea", "Pyeongtaek, Korea", "Gwangyang, Korea", "Ulsan, Korea"] },
    DEST: { hint: "CFR·CIF 지정 장소 = 바이어 쪽 도착항", def: "", list: DEST_PORTS },
  };
  const PLACE_CUSTOM = "__custom";
  const placeGroupOf = (inco) => (inco === "CFR" || inco === "CIF" ? "DEST" : inco);
  const placeFor = (inco) => qv("q-place") || PLACE_GROUPS[placeGroupOf(inco)].def || "Port of destination";
  let placeTouched = false, placeCustom = false, placeGroup = null;

  function syncPlace(inco) {
    $("q-inco").value = inco;   // 팝업 인코텀즈 ← 좌측
    const key = placeGroupOf(inco), g = PLACE_GROUPS[key];
    if (key !== placeGroup) {   // 의미가 바뀌면 선택지 교체 + 기본값으로
      placeGroup = key;
      placeTouched = false;
      placeCustom = false;
      $("q-place-sel").innerHTML = (g.def ? "" : '<option value="">도착항 선택</option>')
        + g.list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("")
        + `<option value="${PLACE_CUSTOM}">직접 입력…</option>`;
      $("q-place").placeholder = g.def || "예: Manila, Philippines";
      $("q-place-hint").textContent = g.hint + " — 좌측 인코텀즈와 연동";
    }
    if (!placeTouched) $("q-place").value = g.def;
    const v = qv("q-place");
    const custom = placeCustom || (v !== "" && !g.list.includes(v));
    $("q-place-sel").value = custom ? PLACE_CUSTOM : v;
    $("q-place").hidden = !custom;
  }

  /* 팝업 인코텀즈 → 좌측 인코텀즈 (다시 계산) */
  $("q-inco").addEventListener("change", () => { $("inco").value = $("q-inco").value; render(); });
  $("q-place-sel").addEventListener("change", () => {
    const v = $("q-place-sel").value;
    if (v === PLACE_CUSTOM) {
      placeCustom = true;
      $("q-place").hidden = false;
      $("q-place").focus();
      return;
    }
    placeCustom = false;
    placeTouched = true;
    $("q-place").value = v;
    render();
  });
  const MODE_NAMES = { one: "통합형", split: "분리형", open: "오픈북형" };
  let profileLoaded = false;

  function renderQuoteSummary() {
    const q = st.quote;
    if (!q) return;
    $("q-summary").textContent = `${MODE_NAMES[q.mode]} · ${q.incoterm} ${placeFor(q.incoterm)} · ${q.lines[0].qty} · 합계 ${money(q.total)} — 견적 계산 값이 그대로 들어가요`;
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
      $("q-done").hidden = false;   // 완료 화면: 팝업을 닫지 않고 영문 제안문 복사를 안내
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
  $("q-open").addEventListener("click", () => { $("q-done").hidden = true; loadProfile(); });   // 팝업 열기는 common.js(data-modal-open)가 처리
  $("q-pdf").addEventListener("click", downloadQuotePdf);

  /* ---------- 클립보드 복사 (가격표 · 영문 제안문) ---------- */
  async function copyText(btn, txt) {
    const label = btn.textContent;
    try { await navigator.clipboard.writeText(txt); btn.textContent = "복사됨"; }
    catch (e) { window.prompt("아래 내용을 복사하세요", txt); }
    setTimeout(() => { btn.textContent = label; }, 1500);
  }

  /* 바이어용 영문 커버레터 — 팝업 입력값이 비어 있으면 [ ] 자리표시로 남깁니다 */
  function proposalMail() {
    const q = st.quote;
    const or = (id, fb) => qv(id) || fb;
    const company = or("q-buyer-company", "[Customer]");
    const qno = or("q-no", "[Quotation No.]"), product = or("q-product", "[Product]");
    const place = placeFor(q.incoterm);
    const validity = parseInt(qv("q-validity"), 10) || 30;
    const tiers = st.tierData ? st.tierData.data.filter((x) => !x.r.belowMoq && x.q !== q.qty) : [];
    const lines = [
      `Subject: Quotation ${qno} - ${product} (${q.incoterm})`,
      "",
      `Dear ${qv("q-buyer-attn") || company},`,
      "",
      `Thank you for your interest in our products. Please find the attached official quotation ${qno} for ${product}.`,
      "",
      `- Unit price: ${usd(q.unit)} per pc (${q.incoterm} ${place})`,
      `- Quantity: ${q.qty.toLocaleString("en-US")} pcs (Total ${money(q.unit * q.qty)})`,
      `- MOQ: ${q.moq}`,
    ];
    if (tiers.length) lines.push(`- Volume pricing: ${tiers.map((x) => `${x.q.toLocaleString("en-US")} pcs ${usd(x.r.usd)}`).join(" / ")}`);
    lines.push(`- Payment: ${qv("q-payment") || "T/T"}`);
    if (qv("q-lead")) lines.push(`- Lead time: ${qv("q-lead")}`);
    lines.push(`- Validity: ${validity} days from ${new Date().toISOString().slice(0, 10)}`);
    if (q.discount_note) lines.push("", q.discount_note);
    lines.push("", "Please feel free to contact us if you have any questions. We look forward to your feedback.", "",
      "Best regards,", qv("q-contact-name") || "[Your name]", qv("q-company") || "[Company]");
    if (qv("q-contact-email")) lines.push(qv("q-contact-email"));
    return lines.join("\n");
  }
  ["copy-mail", "copy-mail-tier"].forEach((id) => $(id).addEventListener("click", async () => {
    if (!st.quote) return;
    await loadProfile();   // 수량별 단가 탭에서 바로 복사할 때도 우리 회사·담당자가 들어가도록
    copyText($(id), proposalMail());
  }));
  $("quote-modal").querySelectorAll("input, textarea").forEach((e) => e.addEventListener("input", () => {
    e.classList.remove("is-error");
    if (e.id === "margin-q-place") placeTouched = placeCustom || qv("q-place") !== "";   // 직접 입력 중이면 유지, 아니면 비울 때 기본값
    if (e.id === "margin-q-product" || e.id === "margin-q-place") render();
  }));

  /* ---------- 역제안 공통 (판정 · Gauge · VE 미리보기가 같이 씀) ---------- */
  function reverseCtx(p, r, t) {
    const sea = p.inco === "CFR" || p.inco === "CIF";
    const toUsd = (krw) => { let u = krw / p.fx; if (sea) u += r.freightU; if (p.inco === "CIF") u += u * 1.1 * p.ins; return u; };
    const toKrw = (u) => { let v = u; if (p.inco === "CIF") v = v / (1 + 1.1 * p.ins); if (sea) v -= r.freightU; return v * p.fx; };
    return {
      toUsd,
      withM2: (sup, m) => apply(sup, m, st.mMode),
      supMaxFor: (krw, m) => (st.mMode === "margin" ? krw * (1 - m) : krw / (1 + m)),
      keys: ["raw", "proc", "pack", "logi"],
      cost: { ...r.items, logi: r.L },   // 항목별 원가 (물류 포함)
      T: t == null ? 0 : toKrw(t),
    };
  }

  /* 가격 기준선 4개 (USD) */
  function priceLines(p, r, floor) {
    const { toUsd, withM2, keys, cost } = reverseCtx(p, r);
    const floorSup = keys.reduce((a, k) => a + apply(cost[k], Math.min(floor, p.rates[k] || 0), st.mMode), 0);
    return {
      breakeven: toUsd(r.C + r.L),
      floor: toUsd(withM2(floorSup, p.m2min)),
      min: toUsd(withM2(r.P2, p.m2min)),
      goal: toUsd(withM2(r.P2, p.m2)),
    };
  }

  function zoneOf(t, P, p, r, m2now) {
    if (t >= P.goal - 1e-9) return ["green", "수락 가능", `${usd(t)}에 받아도 영업마진 ${pct(m2now)}`, `목표 영업마진 ${pct(p.m2)} 이상이 남아요.`];
    if (t >= P.min - 1e-9) return ["yellow", "영업마진 양보", `영업마진 ${pct(m2now)}로 받을 수 있어요`, `최소 영업마진(${pct(p.m2min)})은 지켜요. 1차·물류 마진은 그대로예요.`];
    if (t >= P.floor - 1e-9) return ["orange", "1차·물류 마진 조정", "1차·물류 마진을 줄이면 가능해요", `영업마진 ${pct(p.m2min)}를 지키려면 1차·물류 마진에서 줄여야 해요.`];
    return ["red", "마진만으로 불가", t * p.fx < r.C + r.L ? "원가와 물류비보다 낮은 가격이에요" : "모든 마진을 최소로 줄여도 부족해요", `물류 조건, 수량, 부자재 사양을 바꿔야 해요. 최대 양보가는 ${usd(P.floor)}예요.`];
  }

  /* 영업 승인 가이드라인(R&R): 목표 이상은 담당자 진행, 목표 미만~최소 이상은 팀장 전결, 최소 미만은 본부장/임원 */
  function approval(m, p) {
    if (m >= toSale(p.m2) - 1e-9) return "";
    if (m >= toSale(p.m2min) - 1e-9) return '<span class="badge badge-info">팀장 전결 가능 (승인 권장)</span>';
    return '<span class="badge badge-danger">본부장/임원 특별 승인 필요 (마진 방어 필수)</span>';
  }

  /* 가격 위치 막대 — 색 구간 경계 = 기준가 눈금. 막대는 손익분기에서 시작(목표가가 더 낮으면 그만큼 왼쪽으로 늘림)
     눈금·핀은 막대와 같은 상자(.margin-gauge__bar) 기준 % 로 놓아 경계와 정확히 겹칩니다. */
  function drawGauge(el, P, t) {
    const span = Math.max(P.goal - P.breakeven, 1);
    const lo = Math.min(P.breakeven, t - span * 0.06);
    const hi = Math.max(P.goal + span * 0.12, t + span * 0.06);
    const pos = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    const zones = [[lo, P.breakeven, "is-loss"], [P.breakeven, P.floor, "is-bad"], [P.floor, P.min, "is-warn"], [P.min, P.goal, "is-caution"], [P.goal, hi, "is-good"]]
      .filter((q) => q[1] > q[0]);
    const ticks = [["손익분기", P.breakeven], ["최대 양보가", P.floor], ["최소 마진가", P.min], ["목표 마진가", P.goal]]
      .map((q) => ({ l: q[0], v: q[1], x: pos(q[1]) })).sort((a, b) => a.x - b.x);
    const minGap = el.clientWidth > 0 ? (84 / el.clientWidth) * 100 : 13;   // 라벨(약 76px)이 실제로 겹칠 때만 두 번째 줄로
    let lastX = -99, row = 0;
    ticks.forEach((q) => { row = q.x - lastX < minGap && row === 0 ? 1 : 0; q.r = row; lastX = q.x; });
    const edge = (x) => (x < 4 ? " is-start" : x > 96 ? " is-end" : "");   // 막대 양 끝 라벨은 안쪽으로 정렬
    const tx = pos(t);
    el.classList.toggle("has-row2", ticks.some((q) => q.r));   // 기준가 라벨이 두 줄일 때만 아래 여백 추가
    el.innerHTML = `<div class="margin-gauge__bar"><div class="margin-gauge__track">${zones.map((q) => `<div class="${q[2]}" style="width:${pos(q[1]) - pos(q[0])}%"></div>`).join("")}</div>`
      + ticks.map((q) => `<div class="margin-gauge__tick${q.r ? " is-row2" : ""}${edge(q.x)}" style="left:${q.x}%"><b>${usd(q.v)}</b>${q.l}</div>`).join("")
      + `<div class="margin-gauge__pin${edge(tx)}" style="left:${tx}%"><b>바이어 ${usd(t)}</b><i></i></div>`
      + `<div class="margin-gauge__dot" style="left:${tx}%"></div></div>`;
  }

  /* 사양 변경(VE) 약식 절감 — 대상 항목 원가(개당)에서 차감 */
  const VE_CUT = { coat: { item: "pack", cut: 30 }, box: { item: "pack", cut: 20 }, raw: { item: "raw", cut: 40 } };

  function renderReverse(p, r) {
    const t = num("target"), floor = num("item-floor") / 100;
    const bad = isNaN(t) || t <= 0 || isNaN(floor);
    $("r-err").textContent = bad ? "목표가와 1차 마진 양보 한계치를 입력하세요." : "";
    if (bad) { $("verdict").className = "margin-verdict"; $("verdict").innerHTML = ""; $("gauge").innerHTML = ""; $("gauge-note").textContent = ""; return; }

    const { toUsd, withM2, supMaxFor, keys, cost, T } = reverseCtx(p, r, t);
    const sup = { ...r.supply, logi: r.Lsup };
    const P = priceLines(p, r, floor);
    const m2now = 1 - r.P2 / T;
    const z = zoneOf(t, P, p, r, m2now);

    /* ② 좌: 사양 변경(VE) 체크 */
    Object.keys(VE_CUT).forEach((k) => { $("ve-save-" + k).textContent = "−" + won(VE_CUT[k].cut); });
    $("ve-hint").textContent = z[0] === "orange" || z[0] === "red"
      ? "마진만으로는 부족해요 · 체크해 보세요"
      : "체크하면 위 판정에 반영돼요";
    const veCost = { raw: p.raw, pack: p.pack };
    Object.keys(VE_CUT).forEach((k) => { if ($("ve-" + k).checked) veCost[VE_CUT[k].item] -= VE_CUT[k].cut; });
    Object.keys(veCost).forEach((k) => { veCost[k] = Math.max(0, veCost[k]); });
    const veSaved = r.P2 - forward(p, veCost).P2;
    $("ve-sum").innerHTML = veSaved < 0.5 ? "선택한 사양 변경 없음"
      : `선택 절감 개당 <b>−${won(veSaved)}</b> · 주문 전체 약 −${won(veSaved * p.qty)} (약식 추정, 공급사 확인 필요)`;

    /* ② 우: 마진 직접 조정 (물류 포함) — 변경 칸은 조정만의 효과 */
    const rates = {};
    let adjCut = 0;
    keys.forEach((k) => {
      const curR = p.rates[k] || 0;
      const inp = $("adj-" + k);
      const touched = st.adj[k] !== undefined;
      const nr = touched ? st.adj[k] : curR;
      rates[k] = nr;
      if (document.activeElement !== inp) inp.value = +(nr * 100).toFixed(2);
      const d = sup[k] - apply(cost[k], nr, st.mMode);
      adjCut += d;
      $("adj-row-" + k).classList.toggle("is-changed", touched && Math.abs(nr - curR) > 1e-9);
      $("adj-cur-" + k).textContent = "현재 " + pct(curR);
      $("adj-cut-" + k).innerHTML = Math.abs(d) < 0.5 ? "변경 없음"
        : `<b class="${d > 0 ? "text-up" : ""}">${d > 0 ? "−" : "+"}${won(Math.abs(d))}</b>`;
    });

    /* ① 시뮬레이션(VE + 마진 조정) 적용 결과로 판정·게이지를 다시 계산 */
    const pSim = { ...p, ...veCost, rates };
    const rSim = forward(pSim);
    const simOn = Math.abs(r.P2 - rSim.P2) >= 0.5;
    const Psim = priceLines(pSim, rSim, floor);
    const mSim = 1 - rSim.P2 / T;
    const zSim = zoneOf(t, Psim, pSim, rSim, mSim);
    const short = rSim.P2 - supMaxFor(T, p.m2min);   // + 부족 / − 여유 (개당 공급가 기준)
    const shortHtml = short >= 0.5
      ? `<span class="margin-rsum__gap is-short">${won(short)} 부족</span>`
      : `<span class="margin-rsum__gap is-ok">${won(-short)} 여유</span>`;
    setVerdict($("verdict"), zSim[0], `<div class="margin-badges">${simOn && zSim[0] !== z[0] ? `${badge(z[0], z[1])}<span class="margin-arrow">→</span>` : ""}${badge(zSim[0], zSim[1])}${approval(mSim, p)}</div>
      <div class="margin-rsum__nums"><p class="margin-verdict__title">영업마진 ${simOn ? `${pct(m2now)} → ${pct(mSim)}` : pct(m2now)}</p>${shortHtml}</div>
      <p class="margin-verdict__desc">${simOn
        ? `VE ${veSaved >= 0.5 ? "−" + won(veSaved) : "없음"} · 마진 조정 ${Math.abs(adjCut) >= 0.5 ? (adjCut > 0 ? "−" : "+") + won(Math.abs(adjCut)) : "없음"} 적용 · 최소 영업마진을 지키는 단가 <b>${usd(Psim.min)}</b>`
        : zSim[3]}</p>`);
    $("gauge-note").textContent = simOn ? `VE·마진 조정 적용 후 기준선 · 적용 전 최소 마진가 ${usd(P.min)}` : "";
    drawGauge($("gauge"), simOn ? Psim : P, t);
    $("adj-sum").innerHTML = Math.abs(adjCut) < 0.5 ? "아직 조정 없음"
      : `조정 합계 개당 <b>${adjCut > 0 ? "−" : "+"}${won(Math.abs(adjCut))}</b> · 이 조정안의 최소 마진 단가 <b>${usd(toUsd(withM2(r.P2 - adjCut, p.m2min)))}</b>`;

    /* ③ 대응 방안 (현재 조건 기준) */
    const opts = [];
    opts.push(["재역제안", usd(P.min), "1차·물류 마진은 그대로, 영업마진만 최소선까지 양보."]);
    const Smax = supMaxFor(T, p.m2min), base = r.C + r.L;
    if (Smax > base) {
      const u = st.mMode === "margin" ? 1 - base / Smax : Smax / base - 1;
      opts.push(["1차·물류 마진 일괄", pct(u), `${usd(t)}에서 영업마진 ${pct(p.m2min)}를 지키는 공통 마진율.`]);
    }
    if (p.inco !== "EXW") opts.push(["EXW로 전환", usd(forward(p, { inco: "EXW" }).usd), "물류비·물류 마진을 빼고 바이어가 운송."]);
    const next = [...st.tiers].sort((a, b) => a.min - b.min).find((q) => q.min > p.qty);
    if (next) {
      const nq = forward(p, { qty: next.min, logi: p.logi * (next.min / p.qty) * 0.85 });
      opts.push([`${next.min.toLocaleString()}개 유도`, usd(nq.usd), `할인 ${next.d}% 적용, 영업마진 ${pct(nq.m2after)}. 물류비는 수량 비례의 85% 가정.`]);
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
    const bad = isNaN(contract) || contract <= 0;
    $("fx-err").textContent = bad ? "계약 단가를 입력하세요." : "";
    if (bad) return;

    /* 달러 단가 중 FOB 부분만 원화로 바뀜 (해상운임·보험료는 그대로 지급) */
    let fobU = contract;
    if (p.inco === "CIF") fobU = fobU / (1 + 1.1 * p.ins);
    if (sea) fobU -= r.freightU;
    const g = toSale(p.m2), mn = toSale(p.m2min);
    const base = r.C + r.L, P2 = r.P2;
    const rev = (fx) => fobU * fx;
    const m2At = (fx) => 1 - P2 / rev(fx);
    const fxBE = base / fobU, fxMin = P2 / (1 - mn) / fobU, fxGoal = P2 / (1 - g) / fobU;

    /* Slider 범위 — 실무 기준: 견적~결제(1~3개월) 원/달러 변동을 보수적으로 본 견적 환율 ±10%.
       최소·목표 마진 환율이 그 밖이면 보이도록 넓히되 ±20%까지만. 손익분기 환율은 현실적 변동폭 밖이라 칩으로만 표시 */
    const FX_BAND = 0.10, FX_BAND_MAX = 0.20;
    const r10 = (v) => Math.round(v / 10) * 10;
    const lo = r10(Math.max(p.fx * (1 - FX_BAND_MAX), Math.min(p.fx * (1 - FX_BAND), fxMin * 0.97)));
    const hi = r10(Math.min(p.fx * (1 + FX_BAND_MAX), Math.max(p.fx * (1 + FX_BAND), fxGoal * 1.03)));
    const sl = $("fx-settle");
    sl.min = lo;
    sl.max = hi;
    if (!st.fxTouched || st.fxSettle == null) st.fxSettle = p.fx;
    st.fxSettle = Math.min(hi, Math.max(lo, st.fxSettle));
    sl.value = st.fxSettle;
    const f = st.fxSettle, chg = f / p.fx - 1;
    $("fx-min-l").textContent = lo.toLocaleString() + "원";
    $("fx-max-l").textContent = hi.toLocaleString() + "원";
    const fin = $("fx-settle-input");
    if (document.activeElement !== fin) fin.value = Math.round(f);   // 입력 중에는 덮어쓰지 않음
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
    const pctS = (v) => Math.round(v * 1000) / 10 + "%";   // 15.0% → 15%
    /* 핵심 결과 3분할: 실현 영업마진 / 환차손익 / 방어 단가 */
    $("fx-kpi-m").textContent = pct(m);
    $("fx-kpi-m-note").innerHTML = badge(z[0], z[1]);
    const pnl = diffUnit * p.qty;   // 견적 환율 대비 환차손익 (주문 전체)
    const sign = (v, up, down) => (v > 0 ? up : down);
    $("fx-kpi-pnl").innerHTML = Math.abs(pnl) < 0.5 ? "±0원"
      : `<span class="${sign(pnl, "text-up", "text-down")}">${sign(pnl, "▲ +", "▼ −")}${won(Math.abs(pnl))}</span>`;
    $("fx-kpi-pnl-note").textContent = Math.abs(diffUnit) < 0.005 ? "견적 환율과 같아요" : `견적 환율 대비 · 개당 ${sign(diffUnit, "+", "−")}${won(Math.abs(diffUnit))}`;
    $("fx-kpi-need").textContent = usd(needU);   // 이 환율에서 목표 영업마진을 지키려면 바이어에게 요구할 단가
    const gap = needU - contract;
    $("fx-kpi-need-note").textContent = `목표 마진 ${pctS(g)} 유지 · ` + (gap > 0.005 ? `현재보다 +${usd(gap)}` : "현재 단가로 달성");

    /* Slider 트랙 = 위험/안전 게이지: 손익분기·최소·목표 환율 구간을 판정 색으로 칠함 (손잡이가 현재 환율 핀) */
    const at = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100)).toFixed(2) + "%";
    /* 3구간 단색: 최소 마진 미만 연한 빨강 / 최소~목표 주황 / 목표 이상 초록 */
    const stops = [["bad", lo, fxMin], ["warn", fxMin, fxGoal], ["good", fxGoal, hi]]
      .map(([k, a, b]) => `var(--margin-fxrange-${k}) ${at(a)} ${at(b)}`);
    sl.style.setProperty("--margin-fxrange-bg", `linear-gradient(to right, ${stops.join(", ")})`);

    /* 마지노선 환율 칩 (구 '버틸 수 있는 환율') — 견적 환율에서 이미 미달이면 is-miss */
    const chip = (k, v, sw) => `<span class="margin-chip${v >= p.fx ? " is-miss" : ""}"><i class="margin-swatch ${sw}"></i>${k} <b>${Math.round(v).toLocaleString()}원</b></span>`;
    $("fx-thr").innerHTML = '<span class="margin-chips__label">마지노선 환율</span>'
      + chip("손익분기", fxBE, "is-bad")
      + chip(`최소 마진(${pctS(mn)})`, fxMin, "is-warn")
      + chip(`목표 마진(${pctS(g)})`, fxGoal, "is-good");

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
    const surOn = st.moqMode === "surcharge";
    $("moq-sur").disabled = !surOn;
    $("sur-box").classList.toggle("is-disabled", !surOn);
    /* 현재 주문 수량 행은 좌측 입력(주문수량·FOB 물류비)과 같은 값으로 계산 — 견적 계산 탭 단가와 항상 일치.
       가격표에 현재 수량이 없으면 삭제할 수 없는 '현재 주문' 행(i = -1)을 임시로 넣습니다. */
    const rows = st.qtyRows.map((row, i) => (row.q === p.qty ? { ...row, l: p.logi, i } : { ...row, i }));
    if (!rows.some((row) => row.q === p.qty)) rows.push({ q: p.qty, l: p.logi, i: -1 });
    rows.sort((a, b) => a.q - b.q);
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

    /* 수량별 단가표 — 가격표 행마다 단가 막대를 함께 그립니다 (막대 길이: 가장 싼 단가 ~ 가장 비싼 단가 구간 기준) */
    const vals = valid.map((x) => x.r.usd);
    const vMin = vals.length ? Math.min(...vals) : 0, vMax = vals.length ? Math.max(...vals) : 1;
    const barW = (v) => (vMax - vMin < 1e-9 ? 100 : 35 + ((v - vMin) / (vMax - vMin)) * 65);
    const gS = toSale(p.m2), mnS = toSale(p.m2min);   // 영업마진 Badge 기준 (판매가 대비)
    $("tier-crit").textContent = `영업마진 배지 기준 · 목표 ${pctN(gS)} · 최소 ${pctN(mnS)}`;
    $("tier-table").innerHTML = `<thead><tr><th>수량</th><th class="is-numeric">물류비 총액</th><th>${p.inco} 단가</th><th class="is-numeric">영업마진</th><th></th></tr></thead><tbody>`
      + data.map((x) => {
        const r = x.r, now = x.q === p.qty;
        const zz = r.m2after < mnS - 1e-9 ? "red" : r.m2after < gS - 1e-9 ? "yellow" : "green";
        const fill = r.belowMoq ? "is-hatch" : now ? "is-cur" : "is-other";
        const pctS = (v) => Math.round(v * 1000) / 10 + "%";   // 표 안에서는 10.0% → 10%
        const notes = [now ? '<b class="is-now">현재 주문</b>' : ""];
        if (r.d > 0) notes.push(`<span class="text-down">할인 −${pctS(r.d)}</span>`);
        if (r.sur > 0) notes.push(`<span class="text-up">할증 +${pctS(r.sur)}</span>`);
        if (!x.off) notes.push(`<span>총 $${Math.round((Math.round(r.usd * 100) / 100) * x.q).toLocaleString()}</span>`);
        const price = x.off
          ? '<span class="margin-qbar__off">MOQ 미만 · 주문 불가</span>'
          : `<div class="margin-qbar"><span class="margin-qbar__track"><span class="margin-qbar__fill ${fill}" style="width:${barW(r.usd)}%"></span></span><b>${usd(r.usd)}</b></div>`;
        const moqTag = x.q === st.moq ? '<span class="margin-qtable__moq">MOQ</span>' : "";
        return `<tr class="${now ? "is-active" : ""} ${x.off ? "is-off" : ""}">
          <td><div class="margin-qtable__line"><div class="margin-field margin-w-qty"><input class="form-control form-control-sm" type="number" step="1000" value="${x.q}" data-qi="${x.i}" data-f="q" aria-label="수량"><span class="margin-field__unit">개</span></div>${moqTag}</div></td>
          <td class="is-numeric"><div class="margin-qtable__line is-end"><div class="margin-field margin-w-logi"><input class="form-control form-control-sm" type="number" step="100000" value="${x.l}" data-qi="${x.i}" data-f="l" aria-label="물류비 총액"><span class="margin-field__unit">원</span></div></div><span class="margin-qtable__sub">개당 ${won(r.L)}</span></td>
          <td class="margin-qtable__price"><div class="margin-qtable__line">${price}</div><span class="margin-qtable__sub margin-qtable__notes">${notes.filter(Boolean).join("")}</span></td>
          <td class="is-numeric"><div class="margin-qtable__line is-end">${x.off ? "-" : badge(zz, pct(r.m2after))}</div></td>
          <td><div class="margin-qtable__line"><button type="button" class="btn btn-ghost btn-icon" data-qdel="${x.i}" aria-label="수량 삭제"${st.qtyRows.length > 1 && x.i >= 0 ? "" : " disabled"}>${ICON_X}</button></div></td></tr>`;
      }).join("") + "</tbody>";
    /* 현재 주문 행의 물류비를 고치면 좌측 FOB 물류비에, 임시 행(i = -1)의 수량을 고치면 좌측 주문수량에 반영 */
    $("tier-table").querySelectorAll("input").forEach((e) => e.addEventListener("change", () => {
      const v = parseFloat(e.value), i = +e.dataset.qi;
      if (!isNaN(v) && v > 0) {
        const row = i >= 0 ? st.qtyRows[i] : null;
        const cur = row ? row.q === p.qty : true;
        if (e.dataset.f === "l" && cur) $("logi").value = v;
        if (e.dataset.f === "q" && !row) $("qty").value = v;
        if (row) row[e.dataset.f] = v;
      }
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

  $("copy-tier").addEventListener("click", () => {
    if (!st.tierData) return;
    const { data, p } = st.tierData;
    const lines = [`Price list (${p.inco} ${placeFor(p.inco)}, USD per pc)`, `MOQ: ${st.moq.toLocaleString()} pcs`]
      .concat(data.filter((x) => !x.off).map((x) => `${x.q.toLocaleString()} pcs : ${usd(x.r.usd)}${x.r.d > 0 ? ` (volume discount ${Math.round(x.r.d * 100)}%)` : ""}${x.r.sur > 0 ? " (small-lot surcharge incl.)" : ""}`));
    copyText($("copy-tier"), lines.join("\n"));
  });

  /* 견적 수량 추가 — 물류비 총액은 ensureQtyRow 의 약식 추정 */
  function addQty() {
    const q = Math.round(num("qty-add"));
    const err = $("qty-add-err");
    if (isNaN(q) || q <= 0) { err.textContent = "0보다 큰 수량을 입력하세요."; $("qty-add").focus(); return; }
    if (!ensureQtyRow(q)) { err.textContent = `${q.toLocaleString()}개는 이미 표에 있어요.`; return; }
    err.textContent = "";
    $("qty-add").value = "";
    render();
  }
  $("qty-add-btn").addEventListener("click", addQty);
  $("qty-add").addEventListener("keydown", (e) => { if (e.key === "Enter") addQty(); });
  $("qty-add").addEventListener("input", () => { $("qty-add-err").textContent = ""; });

  $("fx-settle").addEventListener("input", (e) => { st.fxSettle = +e.target.value; st.fxTouched = true; render(); });
  /* 결제 환율 직접 입력 ↔ Slider 양방향 연동 (범위 밖 값은 renderFx 에서 ±15% 끝으로 맞춤) */
  $("fx-settle-input").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    if (isNaN(v) || v <= 0) return;
    st.fxSettle = v;
    st.fxTouched = true;
    render();
  });
  $("fx-settle-input").addEventListener("change", (e) => { render(); e.target.value = Math.round(st.fxSettle); });
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
  ["fx", "target", "item-floor", "abs-on", "abs-c", "abs-l", "fx-contract", "fx-use-quote", "ve-coat", "ve-box", "ve-raw"].forEach((id) => $(id).addEventListener("input", render));

  /* 입력 Card 높이 — 처음 화면(헤더 아래)에서 바닥이 화면 끝에 닿는 높이로 고정하고, 스크롤해도 늘리지 않습니다.
     (늘리면 남는 높이가 요약 박스 위로 몰려 간격이 벌어짐)
     단, 내용이 그 높이보다 길면(작은 화면·토글 펼침) 스크롤 중 화면에 남는 만큼 내용 높이까지만 늘려 Card 안 스크롤을 줄입니다.
     1열 배치(position: static)에서는 적용하지 않습니다. */
  const aside = $("inputs");
  const asideBody = aside.querySelector(".card-body");
  function asideNatural() {   // 요약 박스를 입력 바로 아래에 붙였을 때의 내용 높이
    const top = aside.getBoundingClientRect().top - aside.scrollTop;
    let bottom = 0;
    [...asideBody.children].forEach((e) => {
      if (e === $("quick") || !e.offsetHeight) return;
      bottom = Math.max(bottom, e.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(e).marginBottom) || 0));
    });
    return bottom - top + $("quick").offsetHeight + (parseFloat(getComputedStyle(asideBody).paddingBottom) || 0);
  }
  function fitAside() {
    if (getComputedStyle(aside).position !== "sticky") { aside.style.height = ""; return; }
    const gap = parseFloat(getComputedStyle(aside).top) || 0;   // sticky top 과 같은 여백을 아래에도
    const layoutTop = aside.parentElement.getBoundingClientRect().top + window.scrollY;   // 스크롤과 무관한 Card 시작 위치
    const first = window.innerHeight - layoutTop - gap;                                    // 처음 화면 기준 높이
    const avail = window.innerHeight - Math.max(aside.getBoundingClientRect().top, gap) - gap;
    aside.style.height = Math.max(320, first, Math.min(asideNatural(), avail)) + "px";
  }
  window.addEventListener("resize", fitAside);
  window.addEventListener("scroll", fitAside, { passive: true });
  ["cost", "logi-box"].forEach((id) => $(id).addEventListener("toggle", fitAside));

  drawTiers();
  render();
  fitAside();
  loadLiveFx();
  setInterval(loadLiveFx, FX_REFRESH_MS);
})();

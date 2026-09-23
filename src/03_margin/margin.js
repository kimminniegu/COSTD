document.addEventListener("DOMContentLoaded", () => {
  let projectData = {};
  let currentSimResult = null;

  // 1. 하부 탭 전환 로직
  const tabButtons = document.querySelectorAll(".sub-tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-target");

      tabButtons.forEach(b => {
        b.classList.remove("bg-indigo-600", "text-white", "active");
        b.classList.add("bg-indigo-800", "text-indigo-200");
      });
      btn.classList.add("bg-indigo-600", "text-white", "active");
      btn.classList.remove("bg-indigo-800", "text-indigo-200");

      tabContents.forEach(content => {
        content.classList.toggle("hidden", content.id !== targetId);
      });

      if (targetId === "tab2") triggerSimulation();
    });
  });

  // 2. 초기 데이터 수신
  async function init() {
    try {
      const res = await fetch("/api/init");
      const data = await res.json();
      projectData = data;

      document.getElementById("header-project-name").innerText = 
        `품목: ${data.project.item_name} (${data.project.item_code})`;

      renderTierTable(data.cost_tiers);
      renderHistoryTable(data.quotations);
      triggerSimulation();
    } catch (err) {
      console.error("Failed to load initial data:", err);
    }
  }

  // 3. Tab 1 테이블 렌더링
  function renderTierTable(tiers) {
    const tbody = document.getElementById("tier-table-body");
    tbody.innerHTML = tiers.map(tier => {
      const suggestedPrice = Math.round(tier.exw_cost_krw / (1 - (tier.target_margin_pct / 100)));
      return `
        <tr class="border-b border-slate-100 hover:bg-slate-50">
          <td class="p-3 font-semibold">${tier.moq.toLocaleString()} pcs</td>
          <td class="p-3">${tier.exw_cost_krw.toLocaleString()} 원</td>
          <td class="p-3">${tier.target_margin_pct}%</td>
          <td class="p-3 font-bold text-indigo-600">${suggestedPrice.toLocaleString()} 원</td>
          <td class="p-3 text-center">
            <button class="select-tier-btn px-3 py-1 bg-slate-800 hover:bg-indigo-600 text-white rounded text-xs"
              data-moq="${tier.moq}" data-cost="${tier.exw_cost_krw}">
              Tab 2로 넘기기
            </button>
          </td>
        </tr>
      `;
    }).join("");

    // 'Tab 2로 넘기기' 클릭 이벤트 바인딩
    document.querySelectorAll(".select-tier-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const moq = e.target.dataset.moq;
        const cost = e.target.dataset.cost;

        document.getElementById("input-qty").value = moq;
        document.getElementById("input-exw-cost").value = cost;

        // Tab 2로 탭 전환
        document.querySelector('[data-target="tab2"]').click();
      });
    });
  }

  // 4. Tab 2 시뮬레이션 API 호출
  async function triggerSimulation() {
    const incoterms = document.querySelector('input[name="incoterms"]:checked').value;
    
    // CIF 전용 입력창 토글
    document.getElementById("cif-freight-group").classList.toggle("hidden", incoterms !== "CIF");
    document.getElementById("cif-insurance-group").classList.toggle("hidden", incoterms !== "CIF");

    const payload = {
      qty: document.getElementById("input-qty").value,
      exw_cost_krw: document.getElementById("input-exw-cost").value,
      incoterms: incoterms,
      local_charge_krw: document.getElementById("input-local-charge").value,
      freight_usd: document.getElementById("input-freight-usd").value,
      insurance_krw: document.getElementById("input-insurance-krw").value,
      base_fx_rate: document.getElementById("input-base-fx").value,
      fx_stress_pct: document.getElementById("input-fx-stress").value,
      target_price_usd: document.getElementById("input-target-price").value
    };

    document.getElementById("fx-stress-display").innerText = `${payload.fx_stress_pct}%`;

    try {
      const res = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      currentSimResult = data;
      updateSimulationUI(data, payload);
    } catch (err) {
      console.error("Simulation error:", err);
    }
  }

  // 5. 시뮬레이션 결과 UI 업데이트
  function updateSimulationUI(data, payload) {
    document.getElementById("res-total-cbm").innerText = `${data.logistics.total_cbm} CBM`;
    document.getElementById("res-boxes-weight").innerText = 
      `총 ${data.logistics.total_boxes} 박스 / ${data.logistics.total_weight_kg} kg`;
    document.getElementById("res-unit-logistics").innerText = `${data.logistics.unit_logistics_krw} 원`;

    document.getElementById("res-margin-pct").innerText = `${data.result.margin_pct}%`;
    document.getElementById("res-margin-detail").innerText = 
      `개당 마진: ${data.result.unit_margin_krw.toLocaleString()}원 (총 ${(data.result.total_margin_krw/10000).toLocaleString()}만 원)`;

    document.getElementById("res-applied-fx").innerText = `${data.fx.applied_fx_rate} 원/$`;
    document.getElementById("res-total-cost").innerText = `${data.logistics.total_cost_per_unit_krw.toLocaleString()} 원`;

    const statusBadge = document.getElementById("badge-status");
    const statusCard = document.getElementById("status-card");
    statusBadge.innerText = data.result.status;

    // 배지 색상 동적 매핑
    statusCard.className = "p-5 rounded-xl border shadow-sm " + 
      (data.result.status === "SAFE" ? "bg-emerald-50 border-emerald-300" :
       data.result.status === "REVIEW" ? "bg-amber-50 border-amber-300" : "bg-rose-50 border-rose-300");
    
    statusBadge.className = "px-2 py-0.5 rounded text-xs font-extrabold text-white " +
      (data.result.status === "SAFE" ? "bg-emerald-600" :
       data.result.status === "REVIEW" ? "bg-amber-500" : "bg-rose-600");

    // Tab 3 PI 미리보기 데이터 동기화
    document.getElementById("pi-incoterms").innerText = payload.incoterms;
    document.getElementById("pi-qty").innerText = `${parseInt(payload.qty).toLocaleString()} pcs`;
    document.getElementById("pi-unit-price").innerText = `$${parseFloat(payload.target_price_usd).toFixed(2)}`;
    document.getElementById("pi-total-amount").innerText = 
      `$${(payload.qty * payload.target_price_usd).toLocaleString(undefined, {minimumFractionDigits: 2})}`;
    document.getElementById("pi-logistics-summary").innerText = 
      `총 ${data.logistics.total_boxes} 카톤 / ${data.logistics.total_cbm} CBM / 약 ${data.logistics.total_weight_kg} kg`;
  }

  // 6. 입력 필드 이벤트 리스너 등록
  document.querySelectorAll(".sim-trigger").forEach(el => {
    el.addEventListener("input", triggerSimulation);
  });

  // 7. Tab 3 견적서(PI) 버전 저장
  document.getElementById("btn-save-pi").addEventListener("click", async () => {
    const memo = prompt("저장할 견적 협상 메모를 입력하세요:", "바이어 단가 협의 스냅샷");
    if (memo === null) return;

    const payload = {
      qty: document.getElementById("input-qty").value,
      incoterms: document.querySelector('input[name="incoterms"]:checked').value,
      unit_price_usd: document.getElementById("input-target-price").value,
      margin_pct: currentSimResult.result.margin_pct,
      total_cbm: currentSimResult.logistics.total_cbm,
      total_boxes: currentSimResult.logistics.total_boxes,
      memo: memo
    };

    const res = await fetch("/api/quotations/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (result.success) {
      renderHistoryTable(result.history);
      document.querySelector('[data-target="tab3"]').click();
      alert("새 견적서 버전이 저장되었습니다.");
    }
  });

  // 8. 히스토리 테이블 렌더링
  function renderHistoryTable(history) {
    const tbody = document.getElementById("history-table-body");
    tbody.innerHTML = history.map(item => `
      <tr class="border-b hover:bg-slate-50">
        <td class="p-2 font-bold text-indigo-600">${item.version}</td>
        <td class="p-2">${item.pi_number}</td>
        <td class="p-2">${item.issue_date}</td>
        <td class="p-2">${item.qty.toLocaleString()} pcs</td>
        <td class="p-2 font-semibold">${item.incoterms}</td>
        <td class="p-2 font-bold">$${item.unit_price_usd.toFixed(2)}</td>
        <td class="p-2 font-bold">${item.margin_pct}%</td>
        <td class="p-2 text-slate-500">${item.memo}</td>
      </tr>
    `).join("");
  }

  // 앱 실행
  init();
});
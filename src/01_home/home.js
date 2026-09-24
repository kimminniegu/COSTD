/* Home 전용 JavaScript (담당자 A) — 명세: src/01_home/home.md
   - 서버가 #home-data 에 넣어 준 JSON으로 화면을 그리고, 갱신 중인 구역은 /api/home/data 를 다시 불러 그립니다.
   - 왼쪽 수출입 카드 3개는 서버(home_trade.py, pandas)가 정리한 결과를 그립니다. (5장)
   - 뉴스 4건·규제 3건을 표시하고, 그래도 넘치면 영역 높이에 맞춰 숨깁니다. (2-7)
   - 바이어 현지 시각은 브라우저에서 계산합니다. (7장)
   - 규제 새 소식은 10분마다 /api/home/regulations 로 확인합니다. (8-3) */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var dataEl = $("home-data");
  if (!dataEl) return;

  /* localStorage — 저장 불가 환경에서도 동작하도록 감쌉니다 (state 보다 먼저 정의) */
  var storage = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    getJSON: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    setJSON: function (k, v) { storage.set(k, JSON.stringify(v)); },
  };

  var state = {
    data: JSON.parse(dataEl.textContent || "{}"),
    clockMode: storage.get("cosmoa.clock.mode") || "top_export",
    customCities: storage.getJSON("cosmoa.clock.cities") || null,
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function arrow(direction) { return direction === "up" ? "▲" : direction === "down" ? "▼" : "–"; }
  var NEWS_LIMIT = 4, REG_LIMIT = 3;   // 홈의 뉴스 · 규제 표시 건수
  function isNarrow() { return window.matchMedia("(max-width: 1024px)").matches; }

  /* 1. 환율 띠 -------------------------------------------------------------- */
  function renderRates(r) {
    var box = $("home-rates-items"), meta = $("home-rates-meta");
    if (!r || !r.items || !r.items.length) {
      box.innerHTML = '<span class="home-error">' + esc((r && r.error) || "환율 정보를 불러오지 못했어요") + "</span>";
      meta.textContent = "";
      return;
    }
    box.innerHTML = r.items.map(function (it) {
      var unit = it.unit === 100 ? " <small>(100)</small>" : "";
      var title = it.name + (it.unit === 100 ? " · 100" + it.code + " 기준" : " · 1" + it.code + " 기준");
      var warn = "";
      if (it.warning) { /* 전일 대비 급변 — 서버 RATE_WARN_PCT 기준 (명세 13-1) */
        title += " · 전일 대비 " + it.change_text + " 변동, 값 확인 필요";
        warn = '<span class="home-rate__warn" role="img" aria-label="이상값 경고">!</span>';
      }
      return '<div class="home-rate' + (it.warning ? " is-warn" : "") + '" role="button" tabindex="0" data-code="' + esc(it.code) + '" title="' + esc(title + " · 누르면 상세 보기") + '">' +
        '<span class="home-rate__code">' + esc(it.code) + unit + warn + "</span>" +
        '<span class="home-rate__value"><span class="home-rate__rate">' + esc(it.rate_text) + "</span>" +
        '<span class="home-rate__change is-' + esc(it.direction) + '">' + arrow(it.direction) + " " + esc(it.change_text) + "</span></span></div>";
    }).join("");
    meta.textContent = "수출입은행 · " + r.date_text + " 기준";
  }

  /* 1-1. 환율 상세 모달 (4-4): 통화 클릭 → /api/home/rates/<code> ------------ */
  var rateCache = {};   // code → { at, data } (10분)
  function fmt(n, digits) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("ko-KR", { minimumFractionDigits: digits == null ? 2 : digits, maximumFractionDigits: digits == null ? 2 : digits });
  }
  function rateChart(hist) {
    var W = 320, H = 110, padT = 10, padB = 6, n = hist.length;
    if (n < 2) return '<p class="home-rated__nochart">이력이 아직 하루치뿐이에요</p>';
    var stepX = W / (n - 1);
    var pts = hist.map(function (h, i) { return [i * stepX, padT + (H - padT - padB) * (1 - Number(h.pct || 0) / 100)]; });
    var line = pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
    var area = "0," + H + " " + line + " " + W + "," + H;
    var last = pts[n - 1];
    return '<svg class="home-rated__chart" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<polygon class="home-tsum__area" points="' + area + '"></polygon>' +
      '<polyline class="home-tsum__line" points="' + line + '"></polyline>' +
      '<circle class="home-tsum__dot" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="3.5"></circle></svg>';
  }
  function renderRateDetail(d) {
    var body = $("home-rate-body");
    $("home-rate-title").textContent = d.name ? d.name + " (" + d.code + ")" : "환율 상세";
    if (!d.ok) { body.innerHTML = '<span class="home-error">' + esc(d.error || "환율 정보를 불러오지 못했어요") + "</span>"; return; }
    var s = d.stats, chg = d.change == null ? "" :
      '<span class="home-rated__change is-' + esc(d.direction) + '">' + arrow(d.direction) + " " + esc(d.diff_text) + "원 (" + esc(d.change_text) + ")</span>";
    var warn = d.warning ? '<span class="badge badge-warning home-rated__warn">전일 대비 급변 · 값 확인 필요</span>' : "";
    var hist = d.history || [];
    var ticks = hist.map(function (h, i) {
      var show = i === 0 || i === hist.length - 1 || (hist.length > 6 && i === Math.floor(hist.length / 2));
      return '<small class="' + (show ? "" : "is-hidden") + '">' + esc(h.label) + "</small>";
    }).join("");
    var calc =
      '<div class="home-rated__section home-rated__calc">' +
        '<div class="home-rated__section-head"><span>환산 계산기</span><small>매매기준율 기준</small></div>' +
        '<div class="home-rated__calc-row">' +
          '<label class="home-rated__field"><span>' + esc(d.code) + '</span><input class="form-control form-control-sm home-rated__input" id="home-rate-fx" type="text" inputmode="decimal" autocomplete="off" value="1,000"></label>' +
          '<span class="home-rated__eq" aria-hidden="true">=</span>' +
          '<label class="home-rated__field"><span>KRW</span><input class="form-control form-control-sm home-rated__input" id="home-rate-krw" type="text" inputmode="decimal" autocomplete="off"></label>' +
        "</div>" +
        '<p class="form-help">실제 송금·환전 금액은 은행 우대율과 수수료에 따라 달라져요. 참고용으로만 사용해 주세요.</p>' +
      "</div>";
    body.innerHTML =
      '<div class="home-rated__col">' +
      '<div class="home-rated__head">' +
        '<div class="home-rated__main"><span class="home-rated__rate">' + esc(d.rate_text) + '<small>원</small></span>' + chg + "</div>" +
        '<p class="home-rated__sub">' + esc(d.unit_text) + " 기준 매매기준율 · 수출입은행 " + esc(d.date_text) + " 고시" +
          (d.prev_date_text ? " · 전일(" + esc(d.prev_date_text) + ") 대비" : "") + "</p>" + warn +
      "</div>" +
      '<div class="home-rated__tiles">' +
        '<div class="home-rated__tile"><span class="home-rated__label">송금 받으실 때</span><span class="home-rated__num">' + esc(d.ttb_text || "—") + '</span><small>TTB · 외화→원화</small></div>' +
        '<div class="home-rated__tile"><span class="home-rated__label">송금 보내실 때</span><span class="home-rated__num">' + esc(d.tts_text || "—") + '</span><small>TTS · 원화→외화</small></div>' +
        '<div class="home-rated__tile"><span class="home-rated__label">장부가격</span><span class="home-rated__num">' + esc(d.bkpr_text || "—") + '</span><small>' + (d.spread_text ? "스프레드 " + esc(d.spread_text) + "원" : "회계 기준") + "</small></div>" +
      "</div>" + calc + "</div>" +
      '<div class="home-rated__col">' +
      '<div class="home-rated__section">' +
        '<div class="home-rated__section-head"><span>최근 ' + s.points + "영업일 추이</span><small>" + esc(s.from_text) + " ~ " + esc(s.to_text) + "</small></div>" +
        rateChart(hist) + '<div class="home-rated__axis">' + ticks + "</div>" +
        '<dl class="home-rated__stats">' +
          "<div><dt>최고</dt><dd>" + esc(s.high_text) + "<small>" + esc(s.high_date_text) + "</small></dd></div>" +
          "<div><dt>최저</dt><dd>" + esc(s.low_text) + "<small>" + esc(s.low_date_text) + "</small></dd></div>" +
          "<div><dt>평균</dt><dd>" + esc(s.mean_text) + "</dd></div>" +
          "<div><dt>기간 변동</dt><dd class=\"is-" + (s.period_change > 0 ? "up" : s.period_change < 0 ? "down" : "flat") + "\">" + (s.period_change == null ? "—" : (s.period_change > 0 ? "▲ " : s.period_change < 0 ? "▼ " : "") + Math.abs(s.period_change).toFixed(2) + "%") + "</dd></div>" +
          "<div><dt>변동성</dt><dd>" + (s.volatility == null ? "—" : s.volatility.toFixed(2) + "%") + "<small>일별 등락률 표준편차</small></dd></div>" +
        "</dl>" +
      "</div>" + "</div>";
    var per = d.rate / d.unit, fx = $("home-rate-fx"), krw = $("home-rate-krw");
    /* 회계 숫자 형식: 입력 중에도 천 단위 콤마를 붙이고, 계산에는 콤마를 뺀 값을 씁니다. 외화는 소수 2자리, 원화는 정수 */
    var formatField = function (el, maxDec) {
      var raw = el.value.replace(/[^\d.]/g, "");
      if (raw === "") { el.value = ""; return null; }
      var parts = raw.split("."), intPart = parts[0].replace(/^0+(?=\d)/, "") || "0";
      var dec = parts.length > 1 && maxDec > 0 ? parts.slice(1).join("").slice(0, maxDec) : null;
      el.value = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (dec !== null ? "." + dec : "");
      return Number(intPart + (dec ? "." + dec : ""));
    };
    var sync = function (from) {
      if (from === "fx") { var a = formatField(fx, 2); krw.value = a == null ? "" : fmt(Math.round(a * per), 0); }
      else { var b = formatField(krw, 0); fx.value = b == null ? "" : fmt(b / per, 2); }
    };
    fx.addEventListener("input", function () { sync("fx"); });
    krw.addEventListener("input", function () { sync("krw"); });
    sync("fx");
  }
  function openRateDetail(code) {
    if (!window.Common || !window.Common.openModal) return;
    var body = $("home-rate-body"), src = $("home-rate-source");
    $("home-rate-title").textContent = code + " 환율 상세";
    body.innerHTML = '<span class="home-loading">불러오는 중이에요</span>';
    window.Common.openModal("home-rate-modal");
    var c = rateCache[code];
    if (c && Date.now() - c.at < 10 * 60 * 1000) { renderRateDetail(c.data); return; }
    fetch("/api/home/rates/" + encodeURIComponent(code), { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) { rateCache[code] = { at: Date.now(), data: d }; if (d.source_url) src.href = d.source_url; }
        renderRateDetail(d);
      })
      .catch(function () { body.innerHTML = '<span class="home-error">환율 정보를 불러오지 못했어요</span>'; });
  }
  $("home-rates-items").addEventListener("click", function (e) {
    var el = e.target.closest(".home-rate[data-code]");
    if (el) openRateDetail(el.getAttribute("data-code"));
  });
  $("home-rates-items").addEventListener("keydown", function (e) {
    var el = e.target.closest(".home-rate[data-code]");
    if (el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openRateDetail(el.getAttribute("data-code")); }
  });

  /* 2. 화장품 수출입 카드 3개 (왼쪽 열, 서버의 pandas 분석 결과) ------------ */
  function delta(d, suffix) {
    if (!d || d.change == null) return '<span class="home-rank__delta">—</span>';
    return '<span class="home-rank__delta is-' + esc(d.direction) + '">' + arrow(d.direction) + " " + esc(d.change_text) + (suffix || "") + "</span>";
  }
  function rankItem(it, unitLabel) {
    return '<li class="home-rank__item" title="' + esc(it.name + " · $" + it.musd + "M · 비중 " + it.share + "%") + '">' +
      '<span class="home-rank__name">' + esc(it.name) + '<small>' + esc(it.code) + "</small></span>" +
      '<span class="home-rank__bar" aria-hidden="true"><span style="width:' + Number(it.bar || 0) + '%"></span></span>' +
      '<span class="home-rank__value">$' + esc(it.musd) + "M</span>" +
      '<span class="home-rank__share">' + esc(it.share) + "%</span>" +
      delta(it) + "</li>";
  }
  /* 최근 12개월 수출액 꺾은선 — 라이브러리 없이 inline SVG (선: primary-bright / 영역: primary-soft) */
  function trendChart(trend, currentYymm) {
    var W = 300, H = 100, padT = 8, padB = 4, n = trend.length;
    var stepX = n > 1 ? W / (n - 1) : 0;
    var pts = trend.map(function (m, i) {
      return [i * stepX, padT + (H - padT - padB) * (1 - Number(m.pct || 0) / 100)];
    });
    var line = pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
    var area = "0," + H + " " + line + " " + W + "," + H;
    var cur = trend.findIndex(function (m) { return m.yymm === currentYymm; });
    var dot = cur >= 0 ? '<circle class="home-tsum__dot" cx="' + pts[cur][0].toFixed(1) + '" cy="' + pts[cur][1].toFixed(1) + '" r="3.5"></circle>' : "";
    var title = trend.map(function (m) { return m.label + " $" + m.musd + "M"; }).join(" · ");
    return '<div class="home-tsum__trend" role="img" aria-label="최근 12개월 월별 수출액" title="' + esc(title) + '">' +
      '<svg class="home-tsum__chart" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<polygon class="home-tsum__area" points="' + area + '"></polygon>' +
        '<polyline class="home-tsum__line" points="' + line + '"></polyline>' + dot +
      "</svg>" +
      '<div class="home-tsum__axis">' + trend.map(function (m) {
        return '<small class="' + (m.yymm === currentYymm ? "is-current" : "") + '">' + esc(m.label) + "</small>";
      }).join("") + "</div></div>";
  }
  function renderTradeCards(t) {
    var sumBody = $("home-tsum-body"), sumMonth = $("home-tsum-month"), sumMeta = $("home-tsum-meta");
    var cList = $("home-tcountry-list"), pList = $("home-tproduct-list");
    var cMeta = $("home-tcountry-meta"), pMeta = $("home-tproduct-meta");
    if (!t || !t.ok) {
      var msg = esc((t && t.message) || "수출입 실적을 불러오는 중이에요");
      sumMonth.textContent = "";
      sumMeta.innerHTML = '<a href="https://stat.kita.net/" target="_blank" rel="noopener">K-stat ↗</a>';
      sumBody.innerHTML = '<span class="home-error">' + msg + "</span>";
      cList.innerHTML = pList.innerHTML = '<li class="home-list__empty">' + msg + "</li>";
      cMeta.textContent = pMeta.textContent = "";
      return;
    }
    var s = t.summary;
    sumMonth.textContent = s.month_text + " · HS " + t.hs_codes.join("·");
    sumMeta.innerHTML = '<span title="' + esc(t.cleaning.text) + '">관세청 · pandas 정리</span> · <a href="' + esc(t.kstat_url) + '" target="_blank" rel="noopener" title="한국무역협회 K-stat에서 상세 조회">K-stat ↗</a>';
    sumBody.innerHTML =
      '<div class="home-tsum">' +
        '<div class="home-tsum__kpis">' +
          '<div class="home-tsum__kpi"><span class="home-tsum__label">수출</span><span class="home-tsum__value">$' + esc(s.exp_musd) + '<small>M</small></span>' + delta(s.exp_yoy, " 전년비") + "</div>" +
          '<div class="home-tsum__kpi"><span class="home-tsum__label">수입</span><span class="home-tsum__value">$' + esc(s.imp_musd) + '<small>M</small></span>' + delta(s.imp_yoy, " 전년비") + "</div>" +
          '<div class="home-tsum__kpi"><span class="home-tsum__label">무역수지</span><span class="home-tsum__value">$' + esc(s.bal_musd) + '<small>M</small></span><span class="home-rank__delta">12개월 수출 $' + esc(s.total_12m_musd) + "M</span></div>" +
        "</div>" +
        trendChart(s.trend, s.yymm) +
      "</div>";
    cList.innerHTML = t.countries.map(rankItem).join("") || '<li class="home-list__empty">데이터가 없어요</li>';
    pList.innerHTML = t.products.map(rankItem).join("") || '<li class="home-list__empty">데이터가 없어요</li>';
    cMeta.textContent = t.period_text + " · 비중 · 전년 동기 대비";
    pMeta.textContent = t.period_text + " · 비중 · 전년 동기 대비";
  }

  /* 3. 뉴스 목록 ------------------------------------------------------------ */
  function newsItem(it) {
    var badge = it.official ? "badge-info" : "";
    return '<li class="home-list__item"><a class="home-list__link" href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">' +
      '<span class="home-list__title"><span class="badge ' + badge + '">' + esc(it.source) + "</span>" + esc(it.title) + "</span>" +
      '<span class="home-list__meta">' + esc(it.time_text) + "</span></a></li>";
  }
  function renderNews(n) {
    var list = $("home-news-list"), meta = $("home-news-meta");
    if (!n || !n.items || !n.items.length) {
      list.innerHTML = '<li class="home-list__empty">' + esc((n && n.error) || "뉴스를 불러오는 중이에요") + "</li>";
      meta.textContent = "";
      return;
    }
    list.innerHTML = n.items.slice(0, NEWS_LIMIT).map(newsItem).join("");   // 홈에는 4건만
    meta.textContent = n.updated_text || "";
  }

  /* 4. 규제 업데이트 ------------------------------------------------------- */
  function regItem(it) {
    return '<li class="home-list__item" data-published="' + esc(it.published_at) + '"><a class="home-list__link" href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">' +
      '<span class="home-list__title"><span class="badge badge-primary">' + esc(it.country) + "</span>" + esc(it.title) + "</span>" +
      '<span class="home-list__meta">' + (it.is_new ? '<span class="badge badge-danger">NEW</span>' : "") + esc(it.source) + " · " + esc(it.time_text) + "</span></a></li>";
  }
  function renderRegs(r) {
    var list = $("home-reg-list"), meta = $("home-reg-meta");
    if (!r || !r.items || !r.items.length) {
      list.innerHTML = '<li class="home-list__empty">최근 규제 소식이 없어요</li>';
      meta.textContent = r && r.checked_text ? r.checked_text : "";
      return;
    }
    list.innerHTML = r.items.slice(0, REG_LIMIT).map(regItem).join("");     // 홈에는 3건만
    meta.textContent = r.checked_text || "";
  }

  /* 5. 목록 개수를 영역 높이에 맞춤 (2-7) --------------------------------- */
  function fitList(list) {
    var items = list.querySelectorAll(".home-list__item");
    items.forEach(function (li) { li.hidden = false; });
    if (isNarrow() || !items.length) return;
    var limit = list.clientHeight;
    items.forEach(function (li) {
      if (li.offsetTop + li.offsetHeight - list.offsetTop > limit + 1) li.hidden = true;
    });
  }
  function fitLists() { document.querySelectorAll(".home-list[data-fit]").forEach(fitList); }

  /* 6. 바이어 현지 시각 (7장) --------------------------------------------- */
  function partsIn(tz, date) {
    var f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false });
    var p = {};
    f.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
    return { hour: Number(p.hour) % 24, minute: p.minute, weekday: p.weekday };
  }
  function offsetHours(tz, date) {
    var local = new Date(date.toLocaleString("en-US", { timeZone: tz }));
    var seoul = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
    return Math.round((local - seoul) / 3600000);
  }
  function statusOf(p) {
    if (p.weekday === "Sat" || p.weekday === "Sun") return { text: "주말", cls: "" };
    return p.hour >= 9 && p.hour < 18 ? { text: "업무 중", cls: "badge-success" } : { text: "업무 외", cls: "" };
  }
  function currentCities() {
    if (state.clockMode === "custom" && state.customCities && state.customCities.length) return state.customCities;
    return state.data.buyer_cities || [];
  }
  function renderClock() {
    var list = $("home-clock-list");
    var cities = currentCities();
    if (!cities.length) { list.innerHTML = '<li class="home-clock__empty">표시할 도시가 없어요. "편집"에서 골라 주세요.</li>'; return; }
    var now = new Date();
    list.innerHTML = cities.map(function (c, i) {
      var p = partsIn(c.tz, now), s = statusOf(p), off = offsetHours(c.tz, now);
      var rank = state.clockMode === "top_export" && c.rank ? '<span class="home-clock__rank">' + c.rank + "</span>" : "";
      return '<li class="home-clock__row" title="' + esc(c.country + " · " + c.tz) + '">' +
        '<span class="home-clock__city">' + rank + esc(c.name) + '<span class="home-clock__code">' + esc(c.code) + "</span></span>" +
        '<span class="home-clock__time">' + String(p.hour).padStart(2, "0") + ":" + p.minute + "</span>" +
        '<span class="home-clock__offset">' + (off === 0 ? "±0h" : (off > 0 ? "+" : "−") + Math.abs(off) + "h") + "</span>" +
        '<span class="badge home-clock__status ' + s.cls + '">' + s.text + "</span></li>";
    }).join("");
  }
  function setClockMode(mode) {
    state.clockMode = mode;
    storage.set("cosmoa.clock.mode", mode);
    document.querySelectorAll("[data-clock-mode]").forEach(function (b) {
      var on = b.getAttribute("data-clock-mode") === mode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    $("home-clock-edit").hidden = mode !== "custom";
    if (mode === "custom" && !(state.customCities && state.customCities.length)) {
      // 처음 "내가 선택"으로 바꾸면 현재 수출 상위국 4곳이 미리 선택된 상태 (7-3)
      state.customCities = (state.data.buyer_cities || []).map(function (c) { return { code: c.code, country: c.country, name: c.name, tz: c.tz }; });
      storage.setJSON("cosmoa.clock.cities", state.customCities);
    }
    renderClock();
  }
  document.querySelectorAll("[data-clock-mode]").forEach(function (b) {
    b.addEventListener("click", function () { setClockMode(b.getAttribute("data-clock-mode")); });
  });

  /* 도시 편집 모달 (7-3) */
  var picked = [];
  function renderCityOptions(filter) {
    var q = (filter || "").trim().toLowerCase();
    var opts = (state.data.city_options || []).filter(function (o) {
      return !q || (o.country + o.name + o.code).toLowerCase().indexOf(q) !== -1;
    });
    $("home-city-count").textContent = picked.length + " / 4";
    $("home-city-options").innerHTML = opts.map(function (o) {
      var idx = picked.findIndex(function (p) { return p.tz === o.tz && p.name === o.name; });
      var on = idx !== -1, full = picked.length >= 4 && !on;
      return '<li><label class="home-city-option' + (full ? " is-disabled" : "") + '">' +
        '<input type="checkbox" data-tz="' + esc(o.tz) + '" data-name="' + esc(o.name) + '"' + (on ? " checked" : "") + (full ? " disabled" : "") + ">" +
        "<span>" + esc(o.country) + " · " + esc(o.name) + "</span>" +
        "<small>" + (on ? (idx + 1) + "번째" : esc(o.code)) + "</small></label></li>";
    }).join("") || '<li class="home-list__empty">검색 결과가 없어요</li>';
  }
  $("home-clock-edit").addEventListener("click", function () {
    picked = (state.customCities || []).slice();
    $("home-city-search").value = "";
    renderCityOptions("");
    setTimeout(function () { $("home-city-search").focus(); }, 50);
  });
  $("home-city-search").addEventListener("input", function (e) { renderCityOptions(e.target.value); });
  $("home-city-options").addEventListener("change", function (e) {
    var cb = e.target.closest("input[type=checkbox]");
    if (!cb) return;
    var tz = cb.getAttribute("data-tz"), name = cb.getAttribute("data-name");
    var opt = (state.data.city_options || []).find(function (o) { return o.tz === tz && o.name === name; });
    if (cb.checked && opt && picked.length < 4) picked.push({ code: opt.code, country: opt.country, name: opt.name, tz: opt.tz });
    else picked = picked.filter(function (p) { return !(p.tz === tz && p.name === name); });
    renderCityOptions($("home-city-search").value);
  });
  $("home-city-save").addEventListener("click", function () {
    state.customCities = picked.slice();
    storage.setJSON("cosmoa.clock.cities", state.customCities);
    renderClock();
    window.Common.closeModal("home-city-modal");
  });

  /* 7. 그리기 + 갱신 -------------------------------------------------------- */
  function renderAll() {
    var d = state.data;
    renderRates(d.rates);
    renderTradeCards(d.trade_cards);
    renderNews(d.news);
    renderRegs(d.regulations);
    renderClock();
    requestAnimationFrame(fitLists);
  }

  function needsMore(d) {
    return (d.refreshing && d.refreshing.length) ||
      !(d.trade_cards && d.trade_cards.ok) ||
      !(d.news && d.news.items && d.news.items.length) ||
      !(d.regulations && d.regulations.items && d.regulations.items.length);
  }

  var pollCount = 0;
  function pollData() {
    if (pollCount++ > 20) return;  // 최대 약 3분간만 재시도
    fetch("/api/home/data", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        state.data = d;
        renderAll();
        if (needsMore(d)) setTimeout(pollData, 8000);
      })
      .catch(function () { setTimeout(pollData, 15000); });
  }

  /* 규제 새 소식 확인 (8-3): 10분마다 */
  function pollRegulations() {
    var since = state.data.regulations && state.data.regulations.latest_at;
    var url = "/api/home/regulations" + (since ? "?since=" + encodeURIComponent(since) : "");
    fetch(url, { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (r) {
        if (!r || !r.items || !r.items.length) return;
        var cur = state.data.regulations || { items: [] };
        var urls = {};
        cur.items.forEach(function (it) { urls[it.url] = true; });
        var fresh = r.items.filter(function (it) { return !urls[it.url]; });
        if (!fresh.length) return;
        cur.items = fresh.concat(cur.items).slice(0, 8);
        cur.latest_at = r.latest_at || cur.latest_at;
        cur.checked_text = r.checked_text || cur.checked_text;
        state.data.regulations = cur;
        renderRegs(cur);
        requestAnimationFrame(fitLists);
      })
      .catch(function () { /* 다음 주기에 다시 */ });
  }

  /* 시작 */
  setClockMode(state.clockMode);
  renderAll();
  if (needsMore(state.data)) setTimeout(pollData, 4000);
  setInterval(pollRegulations, 10 * 60 * 1000);

  // 매 분 0초에 맞춰 현지 시각 갱신 (7-1)
  setTimeout(function () { renderClock(); setInterval(renderClock, 60000); }, (60 - new Date().getSeconds()) * 1000);

  var resizeTimer;
  window.addEventListener("resize", function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitLists, 120); });
  window.addEventListener("load", fitLists);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitLists);
  // 목록 영역 크기가 바뀔 때(글꼴 적용, Sidebar 접기, 창 크기 변경 등)마다 표시 개수를 다시 맞춥니다
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitLists, 50); });
    document.querySelectorAll(".home-list[data-fit]").forEach(function (l) { ro.observe(l); });
  }
})();

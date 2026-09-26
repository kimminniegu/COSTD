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

  /* 공통 .container 가 container-type(레이아웃 격리)을 써서 그 안의 position:fixed 모달이 본문 스크롤을 따라 움직입니다.
     홈의 모달 3개를 <body> 바로 아래로 옮겨 항상 화면 가운데에 뜨게 합니다. (common.js 는 document 위임이라 그대로 동작) */
  ["home-city-modal", "home-rate-modal", "home-trade-modal"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.parentNode !== document.body) document.body.appendChild(el);
  });

  var state = {
    data: JSON.parse(dataEl.textContent || "{}"),
    clockMode: storage.get("cosmoa.clock.mode") || "top_export",
    customCities: storage.getJSON("cosmoa.clock.cities") || null,
    tradeFilter: storage.getJSON("cosmoa.trade.filter") || { hs: "3304", months: 12, country: "", metric: "exp" },
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
  /* 공통 꺾은선 차트: 세로축 눈금값(단위 포함)·격자선·마지막 값 표시·점별 툴팁. 홈 카드(12개월), 환율 상세(30일), 수출입 상세(월별)에서 같이 씁니다.
     o = { values:[숫자], labels:[문자], fmt:함수(값→"$1,250M"), aria:설명, zeroBase:0을 축에 포함할지, current:강조할 index, every:x 라벨 간격 } */
  /* 보기 좋은 눈금 (1·2·5 × 10^n 간격) — 축 값이 0, 500, 1,000 처럼 딱 떨어지게 */
  function niceNum(r, round) {
    if (r <= 0) return 1;
    var exp = Math.floor(Math.log(r) / Math.LN10), f = r / Math.pow(10, exp), nf;
    if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10; else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * Math.pow(10, exp);
  }
  function niceTicks(lo, hi, count) {
    var step = niceNum(niceNum(hi - lo, false) / (count - 1), true) || 1;
    var nlo = Math.floor(lo / step) * step, nhi = Math.ceil(hi / step) * step;
    if (nhi === nlo) nhi = nlo + step;
    var t = []; for (var v = nhi; v >= nlo - step / 2; v -= step) t.push(Math.round(v * 1e6) / 1e6);
    return { lo: nlo, hi: nhi, ticks: t };
  }
  /* 공통 꺾은선 차트 — 차트 제목·단위 표기·범례·보기 좋은 눈금·격자·마지막 값·점 툴팁.
     o = { series:[{name, values, dashed}] (또는 values), labels, fmt, title, unit, xTitle, aria, zeroBase, current, every } */
  function lineChart(o) {
    var series = o.series || [{ name: o.name || "", values: o.values }];
    var main = series[0], v = main.values, n = v.length;
    if (n < 2) return '<p class="home-chart__none">표시할 자료가 부족해요</p>';
    var all = [];
    series.forEach(function (sr) { sr.values.forEach(function (x) { if (x != null && !isNaN(x)) all.push(x); }); });
    var vmin = Math.min.apply(null, all), vmax = Math.max.apply(null, all);
    var lo = o.zeroBase ? Math.min(0, vmin) : vmin, hi = o.zeroBase ? Math.max(0, vmax) : vmax;
    if (!o.zeroBase) { var pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.01 || 1; lo -= pad; hi += pad; }
    var nt = niceTicks(lo, hi, 4); lo = nt.lo; hi = nt.hi;
    var y = function (val) { return (1 - (val - lo) / (hi - lo)) * 100; };
    var step = 100 / (n - 1), base = y(o.zeroBase ? Math.max(0, lo) : lo);
    var toPts = function (vals) { return vals.map(function (val, i) { return val == null ? null : [i * step, y(val)]; }); };
    var toLine = function (pts) { return pts.filter(Boolean).map(function (p) { return p[0].toFixed(2) + "," + p[1].toFixed(2); }).join(" "); };
    var pts = toPts(v), line = toLine(pts);
    var area = "0," + base.toFixed(2) + " " + line + " 100," + base.toFixed(2);
    var grid = nt.ticks.map(function (t) { var yy = y(t).toFixed(2); return '<line class="home-chart__grid" x1="0" x2="100" y1="' + yy + '" y2="' + yy + '"></line>'; }).join("");
    var zero = lo < 0 && hi > 0 ? '<line class="home-chart__zero" x1="0" x2="100" y1="' + y(0).toFixed(2) + '" y2="' + y(0).toFixed(2) + '"></line>' : "";
    var others = series.slice(1).map(function (sr) {
      return '<polyline class="home-chart__line2' + (sr.dashed === false ? "" : " is-dashed") + '" points="' + toLine(toPts(sr.values)) + '"></polyline>';
    }).join("");
    var cur = o.current != null && o.current >= 0 ? o.current : n - 1;
    var hover = v.map(function (val, i) {
      var x0 = Math.max(0, (i - 0.5) * step), w = Math.min(100, (i + 0.5) * step) - x0;
      var tip = series.map(function (sr) { var x = sr.values[i]; return (sr.name ? sr.name + " " : "") + (x == null ? "—" : o.fmt(x)); }).join(" · ");
      return '<rect class="home-chart__hit" x="' + x0.toFixed(2) + '" y="0" width="' + w.toFixed(2) + '" height="100"><title>' + esc(o.labels[i] + " · " + tip) + "</title></rect>";
    }).join("");
    var every = o.every || Math.max(1, Math.ceil(n / 6));
    var xs = o.labels.map(function (l, i) {
      var show = (i % every === 0 || i === n - 1 || i === cur) &&
        (i === cur || Math.abs(i - cur) > 1) &&            /* 강조 라벨 바로 옆은 숨김 (겹침 방지) */
        (i === n - 1 || i === cur || n - 1 - i > 1);       /* 마지막 라벨 바로 옆도 숨김 */
      return '<small class="' + (i === cur ? "is-current" : "") + (show ? "" : " is-hidden") + '" style="left:' + (i * step).toFixed(2) + '%">' + esc(l) + "</small>";
    }).join("");
    var last = pts[cur];
    var lastPos = (last[1] < 32 ? " is-below" : "") + (last[0] < 18 ? " is-left" : "");
    var lastLabel = '<span class="home-chart__last' + lastPos + '" style="left:' + last[0].toFixed(2) + "%;top:" + last[1].toFixed(2) + '%">' + esc(o.fmt(v[cur])) + "</span>";
    var ys = nt.ticks.map(function (t) { return '<span style="top:' + y(t).toFixed(2) + '%">' + esc(o.fmt(t)) + "</span>"; }).join("");
    var head = o.title || o.unit ? '<div class="home-chart__head"><span class="home-chart__title">' + esc(o.title || "") + "</span>" +
      (o.unit ? '<span class="home-chart__unit">단위: ' + esc(o.unit) + "</span>" : "") + "</div>" : "";
    var legend = series.length > 1 || (series[0].name && o.legend !== false) ? '<div class="home-chart__legend">' + series.map(function (sr, i) {
      return '<span class="home-chart__key' + (i > 0 && sr.dashed !== false ? " is-dashed" : "") + '"><i></i>' + esc(sr.name) + "</span>";
    }).join("") + "</div>" : "";
    return '<div class="home-chart" role="img" aria-label="' + esc(o.aria || o.title || "") + '">' + head + legend +
      '<div class="home-chart__y">' + ys + "</div>" +
      '<div class="home-chart__plot"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' + grid + zero +
        '<polygon class="home-tsum__area" points="' + area + '"></polygon>' + others +
        '<polyline class="home-tsum__line" points="' + line + '"></polyline>' +
        '<circle class="home-tsum__dot" cx="' + last[0].toFixed(2) + '" cy="' + last[1].toFixed(2) + '" r="3.5"></circle>' + hover +
      "</svg>" + lastLabel + "</div>" +
      '<div class="home-chart__x">' + xs + (o.xTitle ? '<em class="home-chart__xtitle">' + esc(o.xTitle) + "</em>" : "") + "</div></div>";
  }
  function musdNum(t) { return Number(String(t).replace(/,/g, "")) || 0; }
  function fmtMusd(v) { var a = Math.abs(v); return (v < 0 ? "−" : "") + "$" + a.toLocaleString("ko-KR", { maximumFractionDigits: a >= 100 ? 0 : 1 }) + "M"; }
  function rateChart(hist) {
    return lineChart({
      values: hist.map(function (h) { return Number(h.rate); }), labels: hist.map(function (h) { return h.label; }),
      fmt: function (v) { return v.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "원"; },
      name: "매매기준율", legend: false, title: "매매기준율 추이", unit: "원",
      aria: "최근 30영업일 매매기준율 추이", zeroBase: false, every: Math.ceil(hist.length / 4),
    });
  }
  function renderRateDetail(d) {
    var body = $("home-rate-body");
    $("home-rate-title").textContent = d.name ? d.name + " (" + d.code + ")" : "환율 상세";
    if (!d.ok) { body.innerHTML = '<span class="home-error">' + esc(d.error || "환율 정보를 불러오지 못했어요") + "</span>"; return; }
    var s = d.stats, chg = d.change == null ? "" :
      '<span class="home-rated__change is-' + esc(d.direction) + '">' + arrow(d.direction) + " " + esc(d.diff_text) + "원 (" + esc(d.change_text) + ")</span>";
    var warn = d.warning ? '<span class="badge badge-warning home-rated__warn">전일 대비 급변 · 값 확인 필요</span>' : "";
    var hist = d.history || [];
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
        rateChart(hist) +
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
    var cur = trend.findIndex(function (m) { return m.yymm === currentYymm; });
    return lineChart({
      series: [{ name: "수출액", values: trend.map(function (m) { return musdNum(m.musd); }) }], labels: trend.map(function (m) { return m.label; }),
      fmt: fmtMusd, title: "월별 수출액 · 12개월", unit: "백만 달러", aria: "최근 12개월 월별 수출액 (백만 달러)", zeroBase: true, current: cur, every: 3,
    });
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
    /* 왼쪽: 지표 3줄(라벨 · 값 · 전년비)을 한 줄씩 정렬 + 누계 한 줄 / 오른쪽: 회색 패널 안 월별 그래프 (공통 kpi-delta 사용) */
    var row = function (label, musd, yoy) {
      var d = !yoy || yoy.change == null ? '<span class="kpi-delta home-tsum__delta">—</span>'
        : '<span class="kpi-delta home-tsum__delta is-' + esc(yoy.direction) + '" title="전년 동월 대비">' + arrow(yoy.direction) + " " + esc(yoy.change_text) + "</span>";
      return '<div class="home-tsum__row"><span class="home-tsum__label">' + label + '</span><span class="home-tsum__value">$' + esc(musd) + "<small>M</small></span>" + d + "</div>";
    };
    sumBody.innerHTML =
      '<div class="home-tsum">' +
        '<div class="home-tsum__kpis">' +
          row("수출", s.exp_musd, s.exp_yoy) + row("수입", s.imp_musd, s.imp_yoy) + row("무역수지", s.bal_musd, null) +
          '<div class="home-tsum__foot"><span>최근 12개월 수출 누계</span><strong>$' + esc(s.total_12m_musd) + "M</strong></div>" +
        "</div>" +
        '<div class="home-tsum__trend">' + trendChart(s.trend, s.yymm) +
        "</div>" +
      "</div>";
    cList.innerHTML = t.countries.map(rankItem).join("") || '<li class="home-list__empty">데이터가 없어요</li>';
    pList.innerHTML = t.products.map(rankItem).join("") || '<li class="home-list__empty">데이터가 없어요</li>';
    cMeta.textContent = t.period_text + " · 비중 · 전년 동기 대비";
    pMeta.textContent = t.period_text + " · 비중 · 전년 동기 대비";
  }

  /* 2-1. 수출입 상세 모달 (5-9): 카드 클릭 → /api/home/trade?hs&months&country&metric ---- */
  var tradeTab = "countries", tradeLast = null, tradeFoot = "";
  function tradeChart(points, metricName, hasPrior) {
    var series = [{ name: metricName, values: points.map(function (p) { return musdNum(p.musd); }) }];
    if (hasPrior && points.every(function (p) { return p.prior_musd != null; })) {
      series.push({ name: "전년 동기", dashed: true, values: points.map(function (p) { return musdNum(p.prior_musd); }) });
    }
    return lineChart({
      series: series, labels: points.map(function (p) { return p.label; }),
      fmt: fmtMusd, title: "월별 " + metricName + " (" + points.length + "개월)", unit: "백만 달러(USD)", xTitle: "연.월",
      aria: "월별 " + metricName, zeroBase: true, every: Math.max(1, Math.ceil(points.length / 6)),
    });
  }
  function seg(attr, value, label, active, extra) {   /* 공통 Tabs(Segmented Control) 항목 — ui_components.md 13장 */
    return '<button class="tab' + (active ? " is-active" : "") + '" type="button" role="tab" aria-selected="' + (active ? "true" : "false") + '" ' + attr + '="' + esc(value) + '"' + (extra || "") + ">" + esc(label) + "</button>";
  }
  function tradeQuery() {
    var f = state.tradeFilter;
    return "hs=" + encodeURIComponent(f.hs || "3304") + "&months=" + encodeURIComponent(f.months || 12) +
      "&country=" + encodeURIComponent(f.country || "") + "&metric=" + encodeURIComponent(f.metric || "exp");
  }
  function setTradeFilter(patch) {
    var f = state.tradeFilter;
    Object.keys(patch).forEach(function (k) { f[k] = patch[k]; });
    storage.setJSON("cosmoa.trade.filter", f);
    loadTradeDetail();
  }
  function tradeTable(items, metricName, nameHead) {   /* 공통 Table(ui_components.md 12장) — 순위 · 이름 · 막대 · 금액 · 비중 · 전년비 */
    if (!items || !items.length) return '<div class="state state-empty home-traded__state"><p class="state-title">해당 조건의 실적이 없어요</p><p>다른 품목이나 기간을 골라 보세요</p></div>';
    var rows = items.map(function (it, i) {
      var active = state.tradeFilter.country && it.code === state.tradeFilter.country ? ' class="is-active"' : "";
      return "<tr" + active + ' title="' + esc(it.name + " · " + metricName + " $" + it.musd + "M") + '">' +
        '<td class="is-numeric home-traded__no">' + (i + 1) + "</td>" +
        '<td class="home-traded__name">' + esc(it.name) + "<small>" + esc(it.code) + "</small></td>" +
        '<td class="home-traded__barcell"><span class="home-rank__bar" aria-hidden="true"><span style="width:' + Number(it.bar || 0) + '%"></span></span></td>' +
        '<td class="is-numeric home-traded__val">' + (it.value < 0 ? "−" : "") + "$" + esc(String(it.musd).replace("-", "")) + "M</td>" +
        '<td class="is-numeric home-traded__share">' + (it.share != null ? esc(it.share) + "%" : "–") + "</td>" +
        '<td class="is-numeric">' + delta(it) + "</td></tr>";
    }).join("");
    return '<div class="table-wrap"><table class="table home-traded__table"><thead><tr>' +
      '<th class="is-numeric">#</th><th>' + esc(nameHead) + '</th><th></th><th class="is-numeric">' + esc(metricName) + '</th><th class="is-numeric">비중</th><th class="is-numeric">전년비</th>' +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>";
  }
  function renderTradeRight(d) {
    var box = $("home-trade-right");
    if (!box) return;
    var tab = tradeTab;
    box.innerHTML =
      '<div class="home-traded__head"><div class="tabs" role="tablist" aria-label="순위 기준">' +
        seg("data-trade-tab", "countries", "국가별", tab === "countries") +
        seg("data-trade-tab", "products", "품목별", tab === "products") +
      '</div><span class="text-caption home-traded__meta">상위 10 · 전년 동기 대비</span></div>';
    var isC = tab === "countries";
    box.innerHTML += tradeTable(isC ? d.countries : d.products, d.metric_name, isC ? "국가" : "품목 (HS 6단위)") +
      (isC && d.country ? '<p class="form-help">국가를 고른 상태예요. 품목별 탭은 ' + esc(d.country_name) + " 기준으로 보여요.</p>" : "");
  }
  function renderTradeDetail(d) {
    var body = $("home-trade-body"), f = state.tradeFilter;
    tradeLast = d;
    $("home-trade-title").textContent = d.ok ? d.hs_label + (d.country_name ? " · " + d.country_name : "") : "화장품 수출입 상세";
    var hs4 = f.hs && f.hs !== "all" ? f.hs.slice(0, 4) : "all";
    var controls =
      '<div class="home-traded__controls">' +
        '<div class="home-traded__ctl">' +
          '<span class="form-label home-traded__ctl-label">품목</span>' +
          '<div class="tabs" role="tablist" aria-label="품목">' +
            seg("data-trade-hs", "all", "전체", hs4 === "all") +
            (d.hs4_options || []).map(function (o) { return seg("data-trade-hs", o.code, o.code + " " + o.name, hs4 === o.code, o.has_data ? "" : ' title="처음 선택 시 관세청에서 받아와요"'); }).join("") +
          "</div>" +
          (hs4 !== "all" ? '<select class="form-control form-control-sm home-traded__select" id="home-trade-hs6" aria-label="세부 품목">' +
            '<option value="' + esc(hs4) + '">세부 품목 전체</option>' +
            (d.hs6_options || []).map(function (o) { return '<option value="' + esc(o.code) + '"' + (f.hs === o.code ? " selected" : "") + ">" + esc(o.code + " " + o.name) + "</option>"; }).join("") +
          "</select>" : "") +
        "</div>" +
        '<div class="home-traded__ctl">' +
          '<span class="form-label home-traded__ctl-label">기간</span>' +
          '<div class="tabs" role="tablist" aria-label="기간">' + (d.periods || [3, 6, 12, 24]).map(function (m) { return seg("data-trade-months", m, m + "개월", Number(f.months) === m); }).join("") + "</div>" +
          '<span class="form-label home-traded__ctl-label">지표</span>' +
          '<div class="tabs" role="tablist" aria-label="지표">' + (d.metrics || []).map(function (m) { return seg("data-trade-metric", m.key, m.name, f.metric === m.key); }).join("") + "</div>" +
          '<select class="form-control form-control-sm home-traded__select home-traded__select--right" id="home-trade-country" aria-label="국가">' +
            '<option value="">국가 전체</option>' +
            (d.country_options || []).map(function (o) { return '<option value="' + esc(o.code) + '"' + (f.country === o.code ? " selected" : "") + ">" + esc(o.name + " (" + o.code + ")") + "</option>"; }).join("") +
          "</select>" +
        "</div>" +
      "</div>";
    if (!d.ok) {
      body.innerHTML = controls + '<div class="state state-empty home-traded__state"><p class="state-title">' + esc(d.message || d.error || "수출입 실적을 불러오지 못했어요") + "</p><p>다른 품목이나 기간을 골라 보세요</p></div>";
      return;
    }
    var s = d.summary;
    var tile = function (label, musd, yoy) {   /* 공통 Stat Tile(ui_components.md 5장) + kpi-delta */
      var neg = String(musd).indexOf("-") === 0;
      var dl = !yoy || yoy.change == null ? '<span class="kpi-delta">' + (d.has_prior ? "—" : "전년 자료 없음") + "</span>"
        : '<span class="kpi-delta is-' + esc(yoy.direction) + '">' + arrow(yoy.direction) + " " + esc(yoy.change_text) + " 전년비</span>";
      return '<div class="stat-tile home-traded__tile"><span class="stat-tile__label">' + label + '</span><span class="stat-tile__value">' + (neg ? "−" : "") + "$" + esc(String(musd).replace("-", "")) + "<small>M</small></span>" + dl + "</div>";
    };
    body.innerHTML = controls +
      '<div class="home-traded__cols">' +
        '<div class="home-traded__col">' +
          '<div class="home-traded__head"><span class="home-traded__title">' + esc(d.period_text) + ' 합계</span><span class="text-caption">백만 달러</span></div>' +
          '<div class="home-traded__tiles">' + tile("수출", s.exp_musd, s.exp_yoy) + tile("수입", s.imp_musd, s.imp_yoy) + tile("무역수지", s.bal_musd, s.bal_yoy) + "</div>" +
          '<div class="home-traded__chart">' + tradeChart(d.trend, d.metric_name, d.has_prior) + "</div>" +
        "</div>" +
        '<div class="home-traded__col" id="home-trade-right"></div>' +
      "</div>";
    tradeFoot = "관세청 수출입실적 · " + d.latest_text + " 최신 · " + (d.cleaning_text || "");
    $("home-trade-foot").textContent = tradeFoot;
    renderTradeRight(d);
  }
  function loadTradeDetail() {
    var body = $("home-trade-body");
    body.classList.add("is-loading");
    fetch("/api/home/trade?" + tradeQuery(), { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        body.classList.remove("is-loading");
        if (d.ok && d.country && d.country !== state.tradeFilter.country) { state.tradeFilter.country = d.country; }
        if (d.ok && !d.country && state.tradeFilter.country) { state.tradeFilter.country = ""; storage.setJSON("cosmoa.trade.filter", state.tradeFilter); }
        renderTradeDetail(d);
      })
      .catch(function () { body.classList.remove("is-loading"); body.innerHTML = '<span class="home-error">수출입 상세를 불러오지 못했어요</span>'; });
  }
  function openTradeDetail() {
    if (!window.Common || !window.Common.openModal) return;
    var body = $("home-trade-body");
    body.innerHTML = '<span class="home-loading">불러오는 중이에요 · 처음 고른 품목은 관세청에서 받아오느라 몇 초 걸려요</span>';
    window.Common.openModal("home-trade-modal");
    loadTradeDetail();
  }
  $("home-trade-col").addEventListener("click", function (e) {
    if (e.target.closest("a")) return;
    if (e.target.closest("[data-trade-open]")) openTradeDetail();
  });
  $("home-trade-col").addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.hasAttribute("data-trade-open")) { e.preventDefault(); openTradeDetail(); }
  });
  $("home-trade-body").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-trade-hs")) { setTradeFilter({ hs: b.getAttribute("data-trade-hs"), country: "" }); }
    else if (b.hasAttribute("data-trade-months")) { setTradeFilter({ months: Number(b.getAttribute("data-trade-months")) }); }
    else if (b.hasAttribute("data-trade-metric")) { setTradeFilter({ metric: b.getAttribute("data-trade-metric") }); }
    else if (b.hasAttribute("data-trade-tab")) { tradeTab = b.getAttribute("data-trade-tab"); if (tradeLast) renderTradeRight(tradeLast); }
  });
  $("home-trade-body").addEventListener("change", function (e) {
    if (e.target.id === "home-trade-hs6") setTradeFilter({ hs: e.target.value });
    else if (e.target.id === "home-trade-country") { if (e.target.value) tradeTab = "products"; setTradeFilter({ country: e.target.value }); }
  });

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

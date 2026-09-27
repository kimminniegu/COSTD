/* ==========================================================================
   AI 챗봇 위젯 (담당자 F) — 우하단 플로팅 채팅. 명세: src/06_chatbot/chatbot.md 7·12장
   - 대화 기록·열림 상태는 sessionStorage 에 두어 페이지 이동 후에도 이어집니다. (탭을 닫으면 사라짐)
   - 서버 호출은 /api/chatbot/message 하나. 답변 생성·도구 호출은 서버가 처리합니다.
   - 전역 변수를 만들지 않도록 IIFE 안에 작성합니다.
   ========================================================================== */
(function () {
  "use strict";

  var root = document.getElementById("chatbot");
  if (!root) return;

  var endpoint = root.getAttribute("data-endpoint");
  var loginUrl = root.getAttribute("data-login") || "/login";
  var launcher = document.getElementById("chatbot-launcher");
  var panel = document.getElementById("chatbot-panel");
  var closeBtn = document.getElementById("chatbot-close");
  var clearBtn = document.getElementById("chatbot-clear");
  var body = document.getElementById("chatbot-messages");
  var empty = document.getElementById("chatbot-empty");
  var form = document.getElementById("chatbot-form");
  var input = document.getElementById("chatbot-input");
  var sendBtn = document.getElementById("chatbot-send");

  var KEY_MESSAGES = "cosmoa.chatbot.messages";
  var KEY_OPEN = "cosmoa.chatbot.open";
  var MAX_HISTORY = 30;
  var messages = [];
  var pending = false;

  /* 저장 / 복원 ---------------------------------------------------------- */
  function load() {
    try {
      var raw = sessionStorage.getItem(KEY_MESSAGES);
      var parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) messages = parsed.filter(function (m) { return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"; });
    } catch (e) { messages = []; }
  }
  function save() {
    try { sessionStorage.setItem(KEY_MESSAGES, JSON.stringify(messages.slice(-MAX_HISTORY))); } catch (e) { /* 저장 불가 환경 무시 */ }
  }

  /* 본문 → 안전한 HTML (escape 후 **굵게**, "- " 목록, 링크만 변환) ---------- */
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function inline(s) {
    s = escapeHtml(s);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(https?:\/\/[^\s<]+[^\s<.,)\]])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }
  function format(text) {
    var lines = text.split("\n"), html = "", list = [];
    function flush() {
      if (list.length) { html += "<ul>" + list.map(function (l) { return "<li>" + inline(l) + "</li>"; }).join("") + "</ul>"; list = []; }
    }
    lines.forEach(function (line) {
      var m = /^\s*[-•]\s+(.*)$/.exec(line);
      if (m) { list.push(m[1]); return; }
      flush();
      html += (html && !/<\/ul>$/.test(html) ? "\n" : "") + inline(line);
    });
    flush();
    return html;
  }

  /* 그리기 --------------------------------------------------------------- */
  function bubble(role, text, extraClass) {
    var wrap = document.createElement("div");
    wrap.className = "chatbot__msg chatbot__msg--" + role + (extraClass ? " " + extraClass : "");
    var b = document.createElement("div");
    b.className = "chatbot__bubble";
    b.innerHTML = format(text);
    wrap.appendChild(b);
    return wrap;
  }
  function render() {
    body.querySelectorAll(".chatbot__msg, .chatbot__pending").forEach(function (el) { el.remove(); });
    empty.hidden = messages.length > 0;
    messages.forEach(function (m) { body.appendChild(bubble(m.role, m.content)); });
    scrollBottom();
  }
  function scrollBottom() { body.scrollTop = body.scrollHeight; }

  function showPending() {
    var el = document.createElement("div");
    el.className = "chatbot__pending";
    el.id = "chatbot-pending";
    el.innerHTML = '<span class="spinner spinner-sm"></span> 답변을 준비하고 있어요';
    body.appendChild(el);
    scrollBottom();
  }
  function hidePending() {
    var el = document.getElementById("chatbot-pending");
    if (el) el.remove();
  }
  function showError(text) {
    body.appendChild(bubble("assistant", text, "chatbot__msg--error"));
    scrollBottom();
  }

  /* 열기 / 닫기 ---------------------------------------------------------- */
  function setOpen(open) {
    root.classList.toggle("is-open", open);
    panel.hidden = !open;
    launcher.setAttribute("aria-expanded", String(open));
    launcher.setAttribute("aria-label", open ? "AI 비서 닫기" : "AI 비서 열기");
    try { sessionStorage.setItem(KEY_OPEN, open ? "1" : "0"); } catch (e) { /* 무시 */ }
    if (open) { render(); setTimeout(function () { input.focus(); }, 50); }
  }

  /* 전송 ----------------------------------------------------------------- */
  function autosize() {
    input.style.height = "44px";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }
  function setPending(on) {
    pending = on;
    sendBtn.disabled = on;
    input.disabled = on;
    if (on) showPending(); else hidePending();
  }

  function send(text) {
    text = (text || "").trim();
    if (!text || pending) return;
    messages.push({ role: "user", content: text });
    messages = messages.slice(-MAX_HISTORY);
    save();
    render();
    input.value = "";
    autosize();
    setPending(true);

    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ messages: messages }),
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: "서버 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요." }; })
        .then(function (data) { return { status: res.status, data: data }; });
    }).then(function (r) {
      setPending(false);
      if (r.status === 401) {
        showError("로그인이 만료됐어요. 다시 로그인해 주세요: " + location.origin + loginUrl);
        return;
      }
      if (!r.data || !r.data.ok || typeof r.data.reply !== "string") {
        showError((r.data && r.data.error) || "답변을 받지 못했어요. 잠시 후 다시 시도해 주세요.");
        return;
      }
      messages.push({ role: "assistant", content: r.data.reply });
      messages = messages.slice(-MAX_HISTORY);
      save();
      render();
    }).catch(function () {
      setPending(false);
      showError("서버에 연결하지 못했어요. 네트워크를 확인한 뒤 다시 시도해 주세요.");
    }).then(function () { input.focus(); });
  }

  /* 이벤트 --------------------------------------------------------------- */
  launcher.addEventListener("click", function () { setOpen(panel.hidden); });
  closeBtn.addEventListener("click", function () { setOpen(false); });
  clearBtn.addEventListener("click", function () {
    if (pending) return;
    messages = [];
    save();
    render();
    input.focus();
  });
  form.addEventListener("submit", function (e) { e.preventDefault(); send(input.value); });
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  body.addEventListener("click", function (e) {
    var chip = e.target.closest("[data-chatbot-prompt]");
    if (chip) send(chip.getAttribute("data-chatbot-prompt"));
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !panel.hidden && !document.querySelector(".modal-backdrop.is-open")) setOpen(false);
  });

  /* 시작 ----------------------------------------------------------------- */
  load();
  var wasOpen = false;
  try { wasOpen = sessionStorage.getItem(KEY_OPEN) === "1"; } catch (e) { /* 무시 */ }
  if (wasOpen) setOpen(true);
})();

/* Home 전용 JavaScript (담당자 A)
   이 페이지에서만 필요한 로직만 작성합니다.
   다른 페이지의 JS를 수정하거나 의존하지 않습니다. 공통 동작은 src/common/common.js 참고. */
(function () {
  "use strict";

  // 페이지 상단 오늘 날짜 표시
  var today = document.getElementById("home-today");
  if (today) {
    today.textContent = new Date().toLocaleDateString("ko-KR", {
      year: "numeric", month: "long", day: "numeric", weekday: "long",
    });
  }
})();

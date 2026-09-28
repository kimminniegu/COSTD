# 배포용 식약처 규제 DB

`mfds_use_restriction.sqlite` — 메인·챗봇 Render 서비스가 읽기 전용으로 조회하는 배포용 복사본입니다.
원본(수집 결과)은 `instance/regulatory/mfds_use_restriction.sqlite` (Git 제외)이며, 이 파일은 그 사본입니다.

| 항목 | 값 |
|---|---|
| 출처 | 식품의약품안전처, 「화장품 사용제한 원료정보」 (공공데이터포털 https://www.data.go.kr/data/15111772/openapi.do) |
| 이용허락범위 | 제한 없음 (공공데이터포털 표시 기준, 2026-09-27 확인) |
| 수집 | run 1 · completed · 2026-09-23T10:53:54Z · 31,191건 · `src/02_regulatory/mfds_use_restriction.py` |
| 크기 | 47,161,344 bytes |
| SHA-256 | `e88d2e7027c8eb6f0e6bca05f87251f0a0c36edeaa3ad171b68c844be720d3aa` |
| 내용 | `runs`(수집 기록, 인증키 없는 주소), `pages`(페이지별 응답 코드·해시), `records`(규제 원료 공공데이터) — 계정·개인정보·인증키 없음 |

갱신 (PM)
1. 로컬에서 수집을 다시 실행해 `instance/regulatory/` 원본을 만든다. (서버는 자동으로 재수집하지 않음)
2. 원본을 이 경로로 복사하고 위 표(수집·크기·SHA-256)를 새 값으로 고친다.
3. 커밋·푸시 후 두 서비스를 같은 커밋으로 재배포한다.

# 개발요청서 실행 및 검증

프로젝트 루트에서 `python app.py` 실행 후 로그인하여 `/dev-request`에 접속합니다.
HTML은 Flask 템플릿이므로 파일을 브라우저에서 직접 열지 않습니다.

## 구현 범위

- 업로드 → 자동변환 → 읽기 전용 결과 → 수정/취소/완료
- 빈 양식 직접 작성 → 필수값 검증 → 동일한 결과 화면
- `schema.py`의 공통 항목 정의를 자동변환·직접작성·수정·PDF에서 함께 사용합니다.
- 기본정보, 제품 개발 요구사항, 원료 요구사항, 사용 정보, 품질 확인사항, 참고자료의 6개 섹션
- 안정도/미생물 시험의 필요 여부는 `true/false/null`로 구분하며 미지정 책임 주체를 추정하지 않습니다.
- 수량·상세 원가·거래조건·클레임/효능 시험·포장·일정은 `raw_extracted_data`에 분리 보존합니다.
- 국가·바이어 지정 원료 복수 입력, 기타 제품 유형, 단일 벤치마크, 전달 대상
- 수정 시 버전 증가, 원본 추출값/번역값/사용자 수정값 구분
- 항목별 원문 페이지와 `confirmed/needs_review/missing/not_applicable/user_edited` 상태 보존
- 참고자료 추가/삭제/다운로드, 이미지의 PDF 포함 (파일당 5MB, 전체 20MB, 최대 20개)
- 최종 결과를 A4 인쇄용 문서로 생성. `PDF로 저장`을 누르고 브라우저 인쇄 창에서 PDF 저장을 선택합니다.
- 권장 파일명을 인쇄 문서 제목으로 설정합니다. 브라우저에 따라 저장 창에서 이름을 확인해야 할 수 있습니다.

## 자동변환 설정

기존 `.env`의 `OPENAI_API_KEY`를 사용합니다. 추가 패키지 설치는 필요 없습니다.
선택 환경변수 `REQUISITION_OPENAI_MODEL`의 기본값은 `gpt-4.1`입니다.
Responses API의 파일/이미지 입력 및 Structured Outputs를 지원하는 모델을 사용해야 합니다.

- [OpenAI 파일 입력 문서](https://developers.openai.com/api/docs/guides/file-inputs)
- [OpenAI Structured Outputs 문서](https://developers.openai.com/api/docs/guides/structured-outputs)

`POST /api/dev-request/convert`는 multipart `file`, `customer`, `source_language`, `target_language`, `recipients`를 받습니다.
파일은 1개, 최대 20MB이며 확장자와 파일 시그니처를 확인합니다.
`recipients`는 JSON 배열입니다. 언어 코드는 `ko/en/zh/ja/fr/de/es`, 원문 언어는 `auto`도 가능합니다.
파일은 변환 시 OpenAI로 전송합니다. 응답 저장은 `store: false`로 요청합니다.
DOCX의 삽입 이미지/차트는 추출되지 않으며 XLSX는 API의 시트별 1,000행 처리 제한이 있습니다.
한 파일에 제품이 여러 개면 제품별로 파일을 나누어야 합니다.
API 키 없음, 인증 실패, 시간 초과, 잘못된 응답은 오류로 안내하며 예시 데이터로 대체하지 않습니다.

## 현재 연결 범위

- 고객사 마스터가 제공되지 않아 고객사는 직접 입력합니다.
- 원본 파일과 요청서/수정 이력은 현재 페이지 메모리에만 보존합니다. 서버 DB나 영구 파일 보관은 하지 않습니다.
- 원본 RFP는 별도로 다운로드할 수 있습니다. 원본 문서의 이미지 자동 분리는 지원하지 않으며, 연구소에 필요한 참고 이미지는 수정 화면에서 추가합니다. 문서 첨부파일은 PDF에 파일명으로 표시합니다.
- 연구소·공장 선택은 문서의 전달 대상 정보이며 실제 이메일/메신저 발송 기능은 아닙니다.
- 법규 조회 서비스가 없으므로 모든 수출 대상국은 `규제 확인 필요`로 표시합니다.
- 출력 언어는 추출되는 자유 텍스트에 적용합니다. 화면/PDF 항목명과 분류 라벨은 사내 양식에 맞춰 한국어를 유지합니다.
- 직접 작성은 번역을 수행하지 않으므로 선택한 출력 언어로 값을 직접 입력합니다.
- 파일 변환 취소는 브라우저의 응답 대기를 취소합니다. 이미 시작된 외부 API 처리는 서버에서 끝날 수 있습니다.

## 검증

프로젝트 루트에서:

```powershell
python -m unittest discover -s src/05_requisition/tests -p "test_*.py"
node --check src/05_requisition/requisition.js
python src/05_requisition/tests/check_browser.py
```

테스트는 외부 API를 모의 처리하며 실제 비용을 발생시키지 않습니다.
마지막 명령은 Windows의 Edge를 headless로 실행해 실제 DOM에서 직접작성, 필수값, 수정 취소, 버전, 자동변환 전환, PDF 최신값 및 비공개 데이터 제외를 확인합니다. 테스트 자료와 전용 브라우저 프로필은 Git 제외 경로인 `instance/requisition-browser-*`에 생성합니다.

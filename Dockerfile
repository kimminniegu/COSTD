# COSMOA 메인 대시보드 (app.py) — Render Free Docker 서비스용 이미지
# 챗봇 서버(src/06_chatbot/server.py)는 이 이미지를 쓰지 않고 Render Python 런타임으로 따로 배포합니다.
# 배포 안내: docs/deploy_render.md
FROM python:3.10.21-slim-bookworm

# MFDS_DB_PATH: 이미지에 포함한 배포용 식약처 규제 DB (읽기 전용 조회). Render 환경변수로 같은 값을 넣어도 됩니다.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    COSMOA_ENV=production \
    MFDS_DB_PATH=/app/data/regulatory/mfds_use_restriction.sqlite

# 규제 OCR: Tesseract 본체 + 한국어·영어 언어 데이터 (TESSERACT_CMD / TESSDATA_PREFIX 없이 PATH·기본 tessdata 사용)
# 마진 견적서 PDF: 한글 폰트 (src/03_margin/service.py 가 /usr/share/fonts/truetype/nanum/NanumGothic.ttf 를 찾음)
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-kor tesseract-ocr-eng fonts-nanum \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .

# instance/ (계정·홈 캐시 DB)는 이미지에 넣지 않습니다 (.dockerignore). 시작할 때 새로 만들어지고,
# 무료 서비스에서는 재시작·재배포·절전 때마다 초기화됩니다. 계정은 COSMOA_DEMO_* 로 다시 만들어집니다.
# worker 1개: 홈 데이터 백그라운드 수집의 중복 방지가 프로세스 안에서만 동작하기 때문. 동시 요청은 thread 로 처리합니다.
# --timeout 은 gthread 에서 worker 생존 확인 시간일 뿐 요청 시간 상한이 아닙니다. 요청 시간은 각 기능의 외부 호출 제한시간이 정합니다.
CMD ["sh", "-c", "exec gunicorn app:app --bind 0.0.0.0:${PORT:-10000} --workers 1 --threads 8 --timeout 150 --graceful-timeout 30 --access-logfile -"]

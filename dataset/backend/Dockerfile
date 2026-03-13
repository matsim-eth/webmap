FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .

RUN pip install --no-cache-dir -r ./requirements.txt

ENV UVICORN_WORKERS=4

CMD ["sh","-lc","python -m uvicorn main:app --host 0.0.0.0 --port 5033 --workers ${UVICORN_WORKERS} --proxy-headers --forwarded-allow-ips '*'"]

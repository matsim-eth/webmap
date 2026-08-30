FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM base AS dev
EXPOSE 5035
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5035", "--reload"]

FROM base AS prod
COPY . .
EXPOSE 5035
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5035", "--proxy-headers", "--forwarded-allow-ips", "*"]

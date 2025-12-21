FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR ./auth
#COPY backend/requirements.txt requirements.txt
COPY . ./auth

RUN pip install --no-cache-dir -r ./auth/backend/requirements.txt


#CMD ["sleep", "infinity"]
CMD ["python","-m","uvicorn","auth.backend.main:app","--host","0.0.0.0","--port","8090"]

cd backend
docker run --rm -v "$PWD":/app -w /app python:3.12-slim sh -lc \
  "python -m pip install -U pip pip-tools && pip-compile --generate-hashes --allow-unsafe -o requirements.txt requirements.in"
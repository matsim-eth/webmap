# Build context: this directory.   docker build -t sim-worker sim-worker/
# Java for MATSim/eqasim (run + trip/activity analyses) and Python for the
# diff engine and the dataset publish. The result duckdb is built by the
# platform's dataset ingest, so no eqasim python checkout is needed here.
FROM eclipse-temurin:17-jdk-jammy

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY *.py .
CMD ["python3", "worker.py"]

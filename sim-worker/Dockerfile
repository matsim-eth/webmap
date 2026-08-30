# Build from the REPO ROOT:  docker build -f sim-worker/Dockerfile .
# Java (MATSim/eqasim) + Python (diff engine, export, retrofit, upload).
FROM eclipse-temurin:17-jdk-jammy

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git \
  && rm -rf /var/lib/apt/lists/*

# eqasim-switzerland checkout (webmap_export branch) for the standalone
# duckdb export; its python deps are installed into the system python.
ARG EQASIM_REF=webmap_export
RUN git clone --depth 1 --branch ${EQASIM_REF} \
      https://github.com/eqasim-org/eqasim-switzerland.git /opt/eqasim-switzerland
RUN pip3 install --no-cache-dir -r /opt/eqasim-switzerland/euler_requirements.txt || true

WORKDIR /app
COPY sim-worker/requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Our PT-volumes retrofit (fed into the result duckdb after each run)
COPY webmap-backend/scripts/build_transit_volumes /opt/build_transit_volumes

COPY sim-worker/*.py .
ENV EQASIM_REPO=/opt/eqasim-switzerland \
    TRANSIT_VOLUMES_DIR=/opt/build_transit_volumes \
    EXPORT_PYTHON=python3
CMD ["python3", "worker.py"]

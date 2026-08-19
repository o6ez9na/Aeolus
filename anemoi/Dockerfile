FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY anemoi/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY proto ./proto
COPY scripts/gen_proto.sh ./scripts/gen_proto.sh
COPY anemoi/anemoi ./anemoi

# Generated from the same .proto the panel uses, so the two cannot drift.
RUN chmod +x scripts/gen_proto.sh && PROTO_ROOT=/app ./scripts/gen_proto.sh /app/anemoi/grpc_gen

# Same uid as the backend: both write the shared OpenVPN config volume.
RUN useradd --create-home --uid 10001 aeolus && \
    mkdir -p /var/lib/anemoi && chown -R aeolus:aeolus /var/lib/anemoi /app

USER aeolus

CMD ["python", "-m", "anemoi.agent"]

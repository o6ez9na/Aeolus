# Built from the repository root: the panel and the agent share proto/ and
# scripts/, so neither can be built from its own directory alone.
FROM python:3.13-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# argon2-cffi and asyncpg ship wheels, so no compiler is needed at this pin.
COPY panel/backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY panel/backend/alembic.ini ./
COPY panel/backend/alembic ./alembic
COPY panel/backend/app ./app

# Stubs are generated from the shared .proto at build time, so the panel and the
# agent can never drift apart.
COPY proto ./proto
COPY scripts/gen_proto.sh ./scripts/gen_proto.sh
RUN chmod +x scripts/gen_proto.sh && PROTO_ROOT=/app ./scripts/gen_proto.sh /app/app/grpc_gen

COPY panel/backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN useradd --create-home --uid 10001 aeolus

# Docker seeds an empty named volume from the image, ownership included, so the
# unprivileged app can write the OpenVPN bundle into the shared volume.
RUN mkdir -p /etc/openvpn/aeolus && chown -R aeolus:aeolus /etc/openvpn

USER aeolus

EXPOSE 8000 50051
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

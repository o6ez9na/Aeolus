FROM python:3.13-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# argon2-cffi and asyncpg ship wheels, so no compiler is needed at this pin.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN useradd --create-home --uid 10001 aeolus

# Docker seeds an empty named volume from the image, ownership included, so the
# unprivileged app can write the OpenVPN bundle into the shared volume.
RUN mkdir -p /etc/openvpn/aeolus && chown -R aeolus:aeolus /etc/openvpn

USER aeolus

EXPOSE 8000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

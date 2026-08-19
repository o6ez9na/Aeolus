#!/bin/sh
set -e

# Wait for Postgres, then bring the schema up to date before serving traffic.
python - <<'PY'
import asyncio
import os
import sys

import asyncpg

url = os.environ["AEOLUS_DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")


async def wait():
    for attempt in range(30):
        try:
            conn = await asyncpg.connect(url)
        except Exception as exc:  # noqa: BLE001 - any failure means "not ready yet"
            print(f"waiting for postgres ({attempt + 1}/30): {exc}", file=sys.stderr)
            await asyncio.sleep(2)
        else:
            await conn.close()
            return
    sys.exit("postgres did not become reachable in time")


asyncio.run(wait())
PY

alembic upgrade head

exec "$@"

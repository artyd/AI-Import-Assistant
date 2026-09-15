# logist-mcp — internal customs/logistics tool service (plain-REST over HTTP).
# Built and run by docker-compose as an INTERNAL service only: no host port, no
# Caddy route, reachable by the backend on the Compose network at
# http://logist-mcp:8015. Python 3.12 (stable wheels for mcp/pydantic/httpx).
FROM python:3.12-slim

# Keep Python output unbuffered so container logs stream; no .pyc clutter.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Uvicorn binds to this host; 0.0.0.0 so other Compose services can reach it.
    FASTMCP_HOST=0.0.0.0 \
    # Default DRLZ cache location — mounted volume in docker-compose.
    DRLZ_CACHE_PATH=/data/cache/drlz_cache.json

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY logist_mcp.py drlz_build_cache.py ./
RUN mkdir -p /data/cache

# Non-root runtime.
RUN useradd --system --uid 1001 mcp && chown -R mcp:mcp /app /data
USER mcp

EXPOSE 8015
# Plain-REST surface on :8015 (uvicorn; see logist_mcp.py __main__).
CMD ["python", "logist_mcp.py", "--http", "--port", "8015"]

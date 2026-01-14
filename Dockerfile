FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Install dependencies
COPY pyproject.toml /app/pyproject.toml
RUN pip install --no-cache-dir -U pip && \
    pip install --no-cache-dir .

# Copy source
COPY src /app/src

# Non-root user
RUN useradd -u 1000 -m appuser
USER appuser

EXPOSE 3000
CMD ["python", "-m", "unifi_mcp.server"]

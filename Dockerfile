# Game, config service and API on one port. Hugging Face Spaces uses 7860; set PORT=8000 elsewhere.
FROM python:3.11-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=7860 META_PROVIDER=stub

COPY pyproject.toml .
COPY backend backend
RUN pip install --no-cache-dir .

COPY frontend frontend
COPY configs configs
COPY runs_demo runs_demo

EXPOSE 7860 8000
CMD ["sh", "-c", "uvicorn backend.app:app --host 0.0.0.0 --port ${PORT}"]

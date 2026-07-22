# EVL ASR proxy — browser mic -> NIM realtime ASR.
# All NIM/ASR settings are plain environment variables (see docker-compose.yml
# or GO for the full list); nothing is baked into the image.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py analyzers.json ./
COPY static/ static/
COPY packages/ packages/
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Run as a non-root user.
RUN useradd -r -u 1001 asr
USER asr

EXPOSE 8080

# PORT, SSL_CERT and SSL_KEY are handled by the entrypoint; everything else
# (NIM_HOST, ASR_MODEL, …) is read directly by server.py at startup.
ENTRYPOINT ["/docker-entrypoint.sh"]

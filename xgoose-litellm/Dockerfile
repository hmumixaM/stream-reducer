FROM ghcr.io/berriai/litellm@sha256:7845f9673e7e23eb7a8234d84f6c3dbe0413e31125b5b813deb1ec58f0fb94d6

COPY config.yaml /app/config.yaml
USER 65532:65532
ENV HOME=/tmp LITELLM_LOCAL_MODEL_COST_MAP=True LITELLM_TELEMETRY=False PYTHONDONTWRITEBYTECODE=1 EXPERIMENTAL_UI_LOGIN=false
ENTRYPOINT ["litellm"]
CMD ["--config", "/app/config.yaml", "--host", "0.0.0.0", "--port", "4000", "--num_workers", "1"]

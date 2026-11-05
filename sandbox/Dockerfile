FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash libreoffice-writer poppler-utils fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir python-docx==1.2.0 pypdf==6.1.1

RUN useradd --create-home --uid 10001 sandbox \
  && mkdir -p /workspace \
  && chown -R sandbox:sandbox /workspace
WORKDIR /workspace
USER sandbox
CMD ["tail", "-f", "/dev/null"]

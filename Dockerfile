# ── Stage 1: install PROS toolchain ──────────────────────────────────────────
FROM ubuntu:22.04 AS base

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    gcc-arm-none-eabi \
    binutils-arm-none-eabi \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install PROS CLI
RUN pip3 install --no-cache-dir pros-cli

# Pre-warm the PROS kernel/template cache so the first `pros new` is fast.
# This bakes the kernel download into the image layer.
RUN mkdir /tmp/pros_warmup \
    && cd /tmp/pros_warmup \
    && pros new . \
    && cd / \
    && rm -rf /tmp/pros_warmup

# ── Stage 2: app ──────────────────────────────────────────────────────────────
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]

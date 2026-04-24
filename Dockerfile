FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    gcc-arm-none-eabi \
    binutils-arm-none-eabi \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# PROS CLI — break-system-packages is required on Ubuntu 22.04+
RUN pip3 install --no-cache-dir --break-system-packages pros-cli \
    || pip3 install --no-cache-dir pros-cli

# Verify both tools are reachable
RUN pros --version && arm-none-eabi-gcc --version | head -1

# App
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]

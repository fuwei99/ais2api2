# Dockerfile (进一步优化版)
FROM node:18-slim
WORKDIR /app

# 1. [保持不变] 安装最稳定、最不常变化的系统依赖。
RUN apt-get update && apt-get install -y \
    curl \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-6 \
    libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libxss1 libxtst6 xvfb \
    && rm -rf /var/lib/apt/lists/*

# 2. [保持不变] 拷贝 package.json 并安装依赖。
# 只要你的npm包不变化，这一层就会被缓存。
COPY package*.json ./
RUN npm install --production

# 3. 【核心优化】将浏览器下载和解压作为独立的一层。
# 增加默认下载链接 (v135.0.1-beta.24 Linux x86_64)，防止构建时未传 ARG 导致失败。
ARG CAMOUFOX_URL=https://github.com/daijro/camoufox/releases/download/v135.0.1-beta.24/camoufox-135.0.1-beta.24-lin.x86_64.zip

# 拆分步骤进行调试，不使用 && 合并，方便观察哪一步报错
RUN apt-get update
RUN apt-get install -y unzip
RUN curl -sSL ${CAMOUFOX_URL} -o camoufox.zip

# 特别处理 unzip：如果返回 1 (警告) 则认为成功，避免构建中断
RUN unzip camoufox.zip -d /app/camoufox-linux || [ $? -eq 1 ]

RUN rm camoufox.zip
RUN chmod +x /app/camoufox-linux/camoufox

# 清理工作分阶段进行
RUN apt-get purge -y unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# 4. 【核心优化】现在，才拷贝你经常变动的代码文件。
# 这一步放在后面，确保你修改代码时，前面所有重量级的层都能利用缓存。
COPY app/ ./app/
COPY black-browser.js models.json ./

# 5. [保持不变] 创建目录并设置权限。
# 注意：chown应在拷贝文件后进行，确保所有文件权限正确。
RUN mkdir -p ./auth && chown -R node:node /app

# 切换到非 root 用户
USER node

# 暴露服务端口
EXPOSE 7860
EXPOSE 9998

# 设置环境变量
ENV CAMOUFOX_EXECUTABLE_PATH=/app/camoufox-linux/camoufox

# 定义容器启动命令
CMD ["node", "app/main.js"]

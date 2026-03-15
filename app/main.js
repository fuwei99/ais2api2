const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const http = require("http");
const crypto = require("crypto");
const { LoggingService, loadConfiguration } = require("./config");
const AuthSource = require("./auth");
const WsManager = require("./ws-manager");
const { BrowserPool } = require("./browser-pool");
const { translateOpenAIToGoogle, translateGoogleToOpenAIStream } = require("./translator");

const logger = new LoggingService("Main");
const config = loadConfiguration(logger);
let forceThinkingGlobal = config.forceThinking;
let streamingModeGlobal = config.streamingMode;

const authSource = new AuthSource(logger);
const wsManager = new WsManager(logger);
const browserPool = new BrowserPool(config, authSource, wsManager, logger);

const app = express();
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-requested-with, x-api-key, x-goog-api-key, origin, accept");
    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});

app.use((req, res, next) => {
    if (req.path !== "/api/status" && req.path !== "/" && req.path !== "/favicon.ico" && req.path !== "/login") {
        logger.info(`[Entrypoint] 收到一个请求: ${req.method} ${req.path}`);
    }
    next();
});

const sessionSecret = (config.apiKeys && config.apiKeys[0]) || crypto.randomBytes(20).toString("hex");
app.use(cookieParser());
app.use(
    session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: true,
        cookie: { secure: false, maxAge: 86400000 },
    })
);

const isAuthenticated = (req, res, next) => {
    if (req.session.isAuthenticated) {
        return next();
    }
    res.redirect("/login");
};

app.get("/login", (req, res) => {
    if (req.session.isAuthenticated) return res.redirect("/");
    const loginHtml = `
  <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>登录</title>
  <style>body{display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#f0f2f5}form{background:white;padding:40px;border-radius:10px;box-shadow:0 4px 8px rgba(0,0,0,0.1);text-align:center}input{width:250px;padding:10px;margin-top:10px;border:1px solid #ccc;border-radius:5px}button{width:100%;padding:10px;background-color:#007bff;color:white;border:none;border-radius:5px;margin-top:20px;cursor:pointer}.error{color:red;margin-top:10px}</style>
  </head><body><form action="/login" method="post"><h2>请输入 API Key</h2>
  <input type="password" name="apiKey" placeholder="API Key" required autofocus><button type="submit">登录</button>
  ${req.query.error ? '<p class="error">API Key 错误!</p>' : ""}</form></body></html>`;
    res.send(loginHtml);
});

app.post("/login", (req, res) => {
    const { apiKey } = req.body;
    if (apiKey && config.apiKeys.includes(apiKey)) {
        req.session.isAuthenticated = true;
        res.redirect("/");
    } else {
        res.redirect("/login?error=1");
    }
});

// ==== 完整的原版 Dashboard 还原，适配多实例 ====
app.get("/", isAuthenticated, (req, res) => {
    const accountOptionsHtml = authSource.availableIndices.map((index) => `<option value="${index}">账号 #${index}</option>`).join("");
    const logs = logger.logBuffer || [];

    const statusHtml = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>多实例代理服务状态</title>
        <style>
        body { font-family: 'SF Mono', 'Consolas', 'Menlo', monospace; background-color: #f0f2f5; color: #333; padding: 2em; }
        .container { max-width: 1000px; margin: 0 auto; background: #fff; padding: 1em 2em 2em 2em; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        h1, h2 { color: #333; border-bottom: 2px solid #eee; padding-bottom: 0.5em;}
        pre { background: #2d2d2d; color: #f0f0f0; font-size: 1.1em; padding: 1.5em; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.6; }
        #log-container { font-size: 0.9em; max-height: 400px; overflow-y: auto; }
        .status-ok { color: #2ecc71; font-weight: bold; }
        .status-error { color: #e74c3c; font-weight: bold; }
        .label { display: inline-block; width: 220px; box-sizing: border-box; }
        .dot { height: 10px; width: 10px; background-color: #bbb; border-radius: 50%; display: inline-block; margin-left: 10px; animation: blink 1s infinite alternate; }
        @keyframes blink { from { opacity: 0.3; } to { opacity: 1; } }
        .action-group { display: flex; flex-wrap: wrap; gap: 15px; align-items: center; }
        .action-group button, .action-group select, .action-group input { font-size: 1em; border: 1px solid #ccc; padding: 10px 15px; border-radius: 8px; cursor: pointer; transition: background-color 0.3s ease; }
        .action-group button:hover { opacity: 0.85; }
        .action-group button { background-color: #007bff; color: white; border-color: #007bff; }
        .action-group select, .action-group input { background-color: #ffffff; color: #000000; }
        table { width: 100%; border-collapse: collapse; margin-top: 1em; }
        th, td { padding: 12px; border: 1px solid #555; text-align: left; }
        th { background-color: #444; color: white; }
        </style>
    </head>
    <body>
        <div class="container">
        <h1>多实例代理服务状态 <span class="dot" title="数据动态刷新中..."></span></h1>
        <div id="status-section">
            <pre>
<span class="label">服务状态</span>: <span class="status-ok">Running</span>
--- 全局配置 ---
<span class="label">并发实例数</span>: ${config.instanceNum}
<span class="label">流模式</span>: <span id="mode-span">${streamingModeGlobal}</span> (仅启用流式传输时生效)
<span class="label">强制推理</span>: <span id="think-span">${forceThinkingGlobal ? "✅ 已启用" : "❌ 已关闭"}</span>
<span class="label">立即切换 (状态码)</span>: ${config.immediateSwitchStatusCodes.length > 0 ? `[${config.immediateSwitchStatusCodes.join(", ")}]` : "已禁用"}
<span class="label">API 密钥来源</span>: ${config.apiKeySource}
<span class="label">扫描到的总账号</span>: [${authSource.initialIndices.join(", ")}] (总数: ${authSource.initialIndices.length})
<span class="label">当前可用账号池</span>: <span id="avail-pool"></span>

--- 实例池实时大盘 ---
<div id="instance-table"></div>
            </pre>
        </div>
        <div id="actions-section" style="margin-top: 2em;">
            <h2>操作面板</h2>
            <div class="action-group">
                <input type="number" id="targetPort" placeholder="输入要操作的实例端口(例如:9998)" style="width: 250px;">
                <select id="accountIndexSelect">${accountOptionsHtml}</select>
                <button onclick="switchSpecificAccount()">为该实例强制切号</button>
                <button onclick="toggleStreamingMode()">切换流模式</button>
                <button onclick="toggleForceThinking()">切换强制推理</button>
            </div>
        </div>
        <div id="log-section" style="margin-top: 2em;">
            <h2>实时日志 (最近 <span id="log-count">${logs.length}</span> 条)</h2>
            <pre id="log-container">${logs.join("\n")}</pre>
        </div>
        </div>
        <script>
        function updateContent() {
            fetch('/api/status').then(response => response.json()).then(data => {
                document.getElementById('mode-span').innerText = data.streamingMode;
                document.getElementById('think-span').innerText = data.forceThinking;
                document.getElementById('avail-pool').innerText = "[" + data.available + "]";

                let tb = "<table><tr><th>实例端口</th><th>实例状态</th><th>浏览器连接</th><th>占用账号</th><th>使用次数</th><th>连续失败</th><th>操作</th></tr>";
                data.instances.forEach(i => {
                  tb += '<tr>' +
                    '<td>' + i.port + '</td>' +
                    '<td class="' + (i.status === 'READY' ? 'status-ok' : 'status-error') + '">' + i.status + '</td>' +
                    '<td class="' + (i.wsConnected ? 'status-ok' : 'status-error') + '">' + (i.wsConnected ? '✅ 已连接' : '❌ 断开') + '</td>' +
                    '<td>' + i.account + '</td>' +
                    '<td>' + i.uses + '</td>' +
                    '<td>' + i.fails + '</td>' +
                    '<td><button onclick="restartInstance(' + i.port + ')" style="padding:4px 8px;font-size:0.8em;background:#e74c3c;border-color:#e74c3c;">销毁并重启</button></td>' +
                  '</tr>';
                });
                tb += "</table>";
                document.getElementById('instance-table').innerHTML = tb;

                const logContainer = document.getElementById('log-container');
                const isScrolledToBottom = logContainer.scrollHeight - logContainer.clientHeight <= logContainer.scrollTop + 1;
                document.getElementById('log-count').innerText = data.logCount;
                logContainer.innerText = data.logs;
                if (isScrolledToBottom) { logContainer.scrollTop = logContainer.scrollHeight; }
            }).catch(error => console.error('Error fetching new content:', error));
        }

        function restartInstance(port) {
            if (!confirm("确定要强制销毁并重启实例 [端口 " + port + "] 吗？")) return;
            fetch('/api/restart-instance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }) })
            .then(res => res.text()).then(data => { alert(data); updateContent(); });
        }

        function switchSpecificAccount() {
            const portInput = document.getElementById('targetPort').value;
            const selectElement = document.getElementById('accountIndexSelect');
            const targetIndex = selectElement.value;
            if (!portInput) { alert("请先填写要操作的实例端口号！"); return; }
            if (!confirm(\`确定要让实例 [\${portInput}] 强制切换到账号 #\${targetIndex} 吗？\`)) return;
            
            fetch('/api/switch-account', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ port: parseInt(portInput, 10), targetIndex: parseInt(targetIndex, 10) })
            })
            .then(res => res.text()).then(data => { alert(data); updateContent(); })
            .catch(err => alert('❌ 操作失败: ' + err));
        }
            
        function toggleStreamingMode() { 
            const newMode = prompt('请输入新的流模式 (real 或 fake):', '${config.streamingMode}');
            if (newMode === 'fake' || newMode === 'real') {
                fetch('/api/set-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: newMode }) })
                .then(res => res.text()).then(data => { alert(data); updateContent(); })
                .catch(err => alert('设置失败: ' + err));
            } else if (newMode !== null) { 
                alert('无效的模式！请只输入 "real" 或 "fake"。'); 
            } 
        }

        function toggleForceThinking() {
            fetch('/api/toggle-force-thinking', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
            .then(res => res.text()).then(data => { alert(data); updateContent(); })
            .catch(err => alert('设置失败: ' + err));
        }

        document.addEventListener('DOMContentLoaded', () => {
            updateContent(); 
            setInterval(updateContent, 3000);
        });
        </script>
    </body>
    </html>
  `;
    res.status(200).send(statusHtml);
});

app.get("/api/status", isAuthenticated, (req, res) => {
    const instances = [];
    for (const [port, instance] of browserPool.instances.entries()) {
        instances.push({
            port,
            status: instance.status,
            wsConnected: wsManager.connections.has(port),
            account: instance.currentAuthIndex !== null ? `#${instance.currentAuthIndex}` : "未分配",
            uses: `${instance.usageCount} / ${config.switchOnUses > 0 ? config.switchOnUses : "N/A"}`,
            fails: `${instance.failureCount} / ${config.failureThreshold > 0 ? config.failureThreshold : "N/A"}`
        });
    }
    const logs = logger.logBuffer || [];
    res.json({
        streamingMode: streamingModeGlobal,
        forceThinking: forceThinkingGlobal ? "✅ 已启用" : "❌ 已关闭",
        available: authSource.availableIndices.join(", "),
        instances: instances,
        logs: logs.join("\n"),
        logCount: logs.length
    });
});

app.post("/api/restart-instance", isAuthenticated, (req, res) => {
    const port = req.body.port;
    if (!browserPool.instances.has(port)) return res.status(400).send("无效的实例端口");
    browserPool.respawn(port);
    res.send(`正在强制回收并重启实例 [端口 ${port}] ...`);
});

app.post("/api/switch-account", isAuthenticated, (req, res) => {
    const { port, targetIndex } = req.body;
    if (!browserPool.instances.has(port)) return res.status(400).send("无效的实例端口");
    const checkResult = authSource.checkoutSpecificAccount(targetIndex);
    if (!checkResult.success) {
        return res.status(400).send(checkResult.reason);
    }
    browserPool.respawn(port, targetIndex);
    res.send(`已锁定账号 #${targetIndex}，实例 [端口 ${port}] 正在执行重启...`);
});

app.post("/api/set-mode", isAuthenticated, (req, res) => {
    const newMode = req.body.mode;
    if (newMode === "fake" || newMode === "real") {
        streamingModeGlobal = newMode;
        logger.info(`[WebUI] 流式模式已由认证用户切换为: ${streamingModeGlobal}`);
        res.status(200).send(`流式模式已切换为: ${streamingModeGlobal}`);
    } else {
        res.status(400).send('无效模式. 请用 "fake" 或 "real".');
    }
});

app.post("/api/toggle-force-thinking", isAuthenticated, (req, res) => {
    forceThinkingGlobal = !forceThinkingGlobal;
    const statusText = forceThinkingGlobal ? "已启用" : "已关闭";
    logger.info(`[WebUI] 强制推理开关已切换为: ${statusText}`);
    res.status(200).send(`强制推理模式: ${statusText}`);
});

// ==== 鉴权与 OpenAI 接口转换与路由逻辑 ====

const authMiddleware = (req, res, next) => {
    const serverApiKeys = config.apiKeys;
    if (!serverApiKeys || serverApiKeys.length === 0) return next();

    let clientKey = null;
    if (req.headers["x-goog-api-key"]) clientKey = req.headers["x-goog-api-key"];
    else if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) clientKey = req.headers.authorization.substring(7);
    else if (req.headers["x-api-key"]) clientKey = req.headers["x-api-key"];
    else if (req.query.key) clientKey = req.query.key;

    if (clientKey && serverApiKeys.includes(clientKey)) {
        logger.info(`[Auth] API Key验证通过 (来自: ${req.headers["x-forwarded-for"] || req.ip})`);
        if (req.query.key) delete req.query.key;
        return next();
    }

    if (req.path !== "/favicon.ico") {
        const clientIp = req.headers["x-forwarded-for"] || req.ip;
        logger.warn(`[Auth] 访问密码错误或缺失，已拒绝请求。IP: ${clientIp}, Path: ${req.path}`);
    }
    return res.status(401).json({ error: { message: "Access denied. A valid API key was not found or is incorrect." } });
};

app.use(authMiddleware);

app.get("/v1/models", (req, res) => {
    const models = config.modelList.map((id) => ({ id: id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "google" }));
    res.status(200).json({ object: "list", data: models });
});

// 发送错误响应的辅助函数
function sendErrorResponse(res, status, message) {
    if (!res.headersSent) {
        res.status(status || 500).type("application/json").send(JSON.stringify({
            error: { code: status || 500, message: message, status: "SERVICE_UNAVAILABLE" }
        }));
    }
}

app.post("/v1/chat/completions", async (req, res) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const isOpenAIStream = req.body.stream === true;
    const originalModel = req.body.model || "gemini-1.5-pro-latest";

    let translated;
    try {
        translated = translateOpenAIToGoogle(req.body, originalModel, forceThinkingGlobal, logger);
    } catch (error) {
        logger.error(`[Adapter] OpenAI请求翻译失败: ${error.message}`);
        return sendErrorResponse(res, 400, "Invalid OpenAI request format.");
    }

    const { baseModelName, googleRequest } = translated;
    const useRealStream = isOpenAIStream && streamingModeGlobal === "real";

    const proxyRequest = {
        path: `/v1beta/models/${baseModelName}:${useRealStream ? "streamGenerateContent" : "generateContent"}`,
        method: "POST", headers: { "Content-Type": "application/json" },
        query_params: useRealStream ? { alt: "sse" } : {},
        body: JSON.stringify(googleRequest), request_id: requestId, streaming_mode: useRealStream ? "real" : "fake"
    };

    // 负载均衡与重试机制的核心循环
    const maxAttempts = config.maxRetries + config.instanceNum;
    let currentAttempt = 0;

    while (currentAttempt < maxAttempts) {
        currentAttempt++;

        // 获取当前最闲的健康实例
        const instance = browserPool.getBestInstance();
        if (!instance) {
            if (currentAttempt === 1) {
                logger.warn("[System] 当前无空闲或健康的浏览器实例。");
                return sendErrorResponse(res, 503, "服务器正在进行内部维护（所有实例账号切换或恢复中），请稍后重试。");
            }
            break;
        }

        if (instance.browser) instance.notifyUserActivity();
        logger.info(`[Router] 开始路由请求 ${requestId} -> 分配至实例 [端口 ${instance.port}] (尝试 #${currentAttempt}/${maxAttempts})`);

        const messageQueue = wsManager.createMessageQueue(requestId);
        wsManager.sendToPort(instance.port, proxyRequest);

        try {
            // 第一阶段：等待头部/报错信号响应
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("等待首个数据块超时")), 60000));
            const initialMessage = await Promise.race([messageQueue.dequeue(), timeoutPromise]);

            if (initialMessage.event_type === "error") {
                logger.warn(`[Router] 实例 [端口 ${instance.port}] 返回错误，状态码: ${initialMessage.status}, 消息: ${initialMessage.message}`);

                // 【核心】故障转移与重生逻辑
                if (config.immediateSwitchStatusCodes.includes(initialMessage.status)) {
                    logger.error(`[Router] 触发立即切号阈值，标记实例 [端口 ${instance.port}] 回收！`);
                    browserPool.respawn(instance.port);
                } else {
                    instance.failureCount++;
                    if (instance.failureCount >= config.failureThreshold) {
                        logger.warn(`[Router] 实例 [端口 ${instance.port}] 达到失败阈值，标记回收！`);
                        browserPool.respawn(instance.port);
                    }
                }

                // 清理当前队列，进入下一轮 while 循环，瞬间换号重试
                wsManager.removeMessageQueue(requestId);
                continue;
            }

            // 请求已成功连接，重置该实例的错误计数并增加使用计数
            instance.usageCount++;
            instance.failureCount = 0;
            logger.info(`✅ [Auth] 请求已连接 - 实例 [端口 ${instance.port}] 失败计数已清零。当前使用次数: ${instance.usageCount}`);

            if (config.switchOnUses > 0 && instance.usageCount >= config.switchOnUses) {
                logger.info(`[Auth] 实例 [端口 ${instance.port}] 达到使用次数阈值 (${instance.usageCount}/${config.switchOnUses})，将在后台自动切号...`);
                browserPool.respawn(instance.port);
            }

            // 第二阶段：流式/非流式数据处理
            if (isOpenAIStream) {
                res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });

                if (useRealStream) {
                    logger.info(`[Adapter] OpenAI 流式响应 (Real Mode) 已启动...`);
                    while (true) {
                        const message = await messageQueue.dequeue(300000);
                        if (message.type === "STREAM_END") { res.write("data: [DONE]\n\n"); break; }
                        if (message.data) {
                            const translatedChunk = translateGoogleToOpenAIStream(message.data, originalModel, requestId);
                            if (translatedChunk) res.write(translatedChunk);
                        }
                    }
                } else {
                    logger.info(`[Adapter] OpenAI 流式响应 (Fake Mode) 已启动...`);
                    let fullBody = "";
                    while (true) {
                        const message = await messageQueue.dequeue(300000);
                        if (message.type === "STREAM_END") break;
                        if (message.data) fullBody += message.data;
                    }
                    const translatedChunk = translateGoogleToOpenAIStream(fullBody, originalModel, requestId);
                    if (translatedChunk) res.write(translatedChunk);
                    res.write("data: [DONE]\n\n");
                    logger.info(`[Adapter] Fake模式：已一次性发送完整内容并结束流。`);
                }
            } else {
                // 非流式
                let fullBody = "";
                while (true) {
                    const message = await messageQueue.dequeue(300000);
                    if (message.type === "STREAM_END") break;
                    if (message.event_type === "chunk" && message.data) fullBody += message.data;
                }

                const googleResponse = JSON.parse(fullBody);
                const candidate = googleResponse.candidates?.[0];

                let responseContent = "";
                let messageObj = { role: "assistant", content: "" };

                if (candidate && candidate.content && Array.isArray(candidate.content.parts)) {
                    const imagePart = candidate.content.parts.find((p) => p.inlineData);
                    if (imagePart) {
                        const image = imagePart.inlineData;
                        responseContent = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
                        logger.info("[Adapter] 从 parts.inlineData 中成功解析到图片。");
                    } else {
                        let mainContent = "";
                        let reasoningContent = "";
                        candidate.content.parts.forEach((p) => {
                            if (p.thought) reasoningContent += p.text;
                            else mainContent += p.text;
                        });
                        responseContent = mainContent;
                        if (reasoningContent) messageObj.reasoning_content = reasoningContent;
                    }
                    messageObj.content = responseContent;
                }

                const openaiResponse = {
                    id: `chatcmpl-${requestId}`,
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model: originalModel,
                    choices: [
                        { index: 0, message: messageObj, finish_reason: candidate?.finishReason || "UNKNOWN" }
                    ],
                };

                logger.info(`✅ [Request] OpenAI非流式响应结束，请求ID: ${requestId}`);
                res.status(200).json(openaiResponse);
            }

            wsManager.removeMessageQueue(requestId);
            if (!res.writableEnded) res.end();
            return;

        } catch (e) {
            logger.error(`[Router] 队列超时或断开连接: ${e.message}`);
            wsManager.removeMessageQueue(requestId);
            instance.failureCount++;
            // 进入下一轮重试
        }
    }

    // 如果穷尽了所有重试次数都没成功
    if (!res.headersSent) {
        logger.error(`[Router] 跨实例重试 ${maxAttempts} 次后仍然彻底失败，放弃请求。`);
        sendErrorResponse(res, 500, "代理错误: 所有实例重试均失败，可能是服务器被大规模风控。");
    }
});

async function startServer() {
    await authSource.init();
    await browserPool.start();

    const httpServer = http.createServer(app);
    httpServer.keepAliveTimeout = 120000;
    httpServer.headersTimeout = 125000;
    httpServer.requestTimeout = 120000;

    httpServer.listen(config.httpPort, config.host, () => {
        logger.info(`✅ HTTP 网关已启动监听: http://${config.host}:${config.httpPort}`);
        logger.info(`[System] Keep-Alive 超时已设置为 ${httpServer.keepAliveTimeout / 1000} 秒。`);
    });
}

startServer();

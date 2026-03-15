const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
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
app.use(express.static(path.join(__dirname, "web")));

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
    res.sendFile(path.join(__dirname, "web", "login.html"));
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

app.get("/", isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, "web", "index.html"));
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
        availableIndices: authSource.availableIndices,
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

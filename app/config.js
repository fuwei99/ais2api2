require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

class LoggingService {
    constructor(serviceName = "ProxyServer") {
        this.serviceName = serviceName;
        this.logBuffer = [];
        this.maxBufferSize = 100;
        this.lockLog = process.env.LOCK_LOG === "true";
        this.lockKey = process.env.LOCK_KEY || "default_unlock_key";
    }
    _encrypt(text) {
        try {
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv("aes-256-cbc", crypto.createHash("sha256").update(this.lockKey).digest(), iv);
            let encrypted = cipher.update(text, "utf8", "hex");
            encrypted += cipher.final("hex");
            return `[LOCKED] ${iv.toString("hex")}:${encrypted}`;
        } catch (e) {
            return `[LOCK_ERROR] ${text}`;
        }
    }
    _formatMessage(level, message) {
        const timestamp = new Date().toISOString();
        const formatted = `[${level}] ${timestamp} [${this.serviceName}] - ${message}`;
        this.logBuffer.push(formatted);
        if (this.logBuffer.length > this.maxBufferSize) {
            this.logBuffer.shift();
        }
        return formatted;
    }
    info(message) {
        const formatted = this._formatMessage("INFO", message);
        console.log(this.lockLog ? this._encrypt(formatted) : formatted);
    }
    error(message) {
        const formatted = this._formatMessage("ERROR", message);
        console.error(this.lockLog ? this._encrypt(formatted) : formatted);
    }
    warn(message) {
        const formatted = this._formatMessage("WARN", message);
        console.warn(this.lockLog ? this._encrypt(formatted) : formatted);
    }
    debug(message) {
        const formatted = this._formatMessage("DEBUG", message);
        console.debug(this.lockLog ? this._encrypt(formatted) : formatted);
    }
}

function loadConfiguration(logger) {
    let config = {
        httpPort: 7860,
        host: "0.0.0.0",
        wsPort: 9998,
        instanceNum: 1,
        streamingMode: "real",
        failureThreshold: 3,
        switchOnUses: 40,
        maxRetries: 1,
        retryDelay: 2000,
        browserExecutablePath: null,
        apiKeys: [],
        immediateSwitchStatusCodes: [429, 503],
        apiKeySource: "未设置",
        targetUrl: "https://ai.studio/apps/4c16dd7f-beef-4c90-bd4e-86e68a36b9a4",
        portUrls: {},
        httpProxy: null,
        // === 新增：解析 HEADLESS 环境变量，默认为 true (无头) ===
        headless: process.env.HEADLESS === "false" ? false : true,
    };

    const configPath = path.join(__dirname, "..", "config.json");
    try {
        if (fs.existsSync(configPath)) {
            const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            config = { ...config, ...fileConfig };
            logger.info("[System] 已从 config.json 加载配置。");
        }
    } catch (error) {
        logger.warn(`[System] 无法读取或解析 config.json: ${error.message}`);
    }

    if (process.env.PORT) config.httpPort = parseInt(process.env.PORT, 10) || config.httpPort;
    if (process.env.HOST) config.host = process.env.HOST;
    if (process.env.TARGET_URL) config.targetUrl = process.env.TARGET_URL;
    if (process.env.STREAMING_MODE) config.streamingMode = process.env.STREAMING_MODE;
    if (process.env.INSTANCE_NUM) config.instanceNum = parseInt(process.env.INSTANCE_NUM, 10) || config.instanceNum;

    for (const key in process.env) {
        const match = key.match(/^(\d+)_TARGET_URL$/);
        if (match) {
            const port = parseInt(match[1], 10);
            config.portUrls[port] = process.env[key].trim();
        }
    }

    const rawFailSwitch = process.env.FAIL_SWICH || process.env.FAILURE_THRESHOLD;
    if (rawFailSwitch) config.failureThreshold = parseInt(rawFailSwitch, 10) || config.failureThreshold;

    const rawSwitch = process.env.SWICH || process.env.SWITCH_ON_USES;
    if (rawSwitch) config.switchOnUses = parseInt(rawSwitch, 10) || config.switchOnUses;

    if (process.env.MAX_RETRIES) config.maxRetries = parseInt(process.env.MAX_RETRIES, 10) || config.maxRetries;
    if (process.env.RETRY_DELAY) config.retryDelay = parseInt(process.env.RETRY_DELAY, 10) || config.retryDelay;
    if (process.env.CAMOUFOX_EXECUTABLE_PATH) config.browserExecutablePath = process.env.CAMOUFOX_EXECUTABLE_PATH;

    const rawPassword = process.env.PASSWORD || process.env.API_KEYS;
    if (rawPassword) {
        config.apiKeys = rawPassword.split(",");
    }
    if (process.env.HTTP_PROXY) {
        config.httpProxy = process.env.HTTP_PROXY;
    }

    let rawCodes = process.env.IMMEDIATE_SWITCH_STATUS_CODES;
    let codesSource = "环境变量";

    if (!rawCodes && config.immediateSwitchStatusCodes && Array.isArray(config.immediateSwitchStatusCodes)) {
        rawCodes = config.immediateSwitchStatusCodes.join(",");
        codesSource = "config.json 文件或默认值";
    }

    if (rawCodes && typeof rawCodes === "string") {
        config.immediateSwitchStatusCodes = rawCodes
            .split(",")
            .map((code) => parseInt(String(code).trim(), 10))
            .filter((code) => !isNaN(code) && code >= 400 && code <= 599);
        if (config.immediateSwitchStatusCodes.length > 0) {
            logger.info(`[System] 已从 ${codesSource} 加载“立即切换报错码”。`);
        }
    } else {
        config.immediateSwitchStatusCodes = [];
    }

    if (Array.isArray(config.apiKeys)) {
        config.apiKeys = config.apiKeys.map((k) => String(k).trim()).filter((k) => k);
    } else {
        config.apiKeys = [];
    }

    if (config.apiKeys.length > 0) {
        config.apiKeySource = "自定义";
    } else {
        config.apiKeys = ["123456"];
        config.apiKeySource = "默认";
        logger.info("[System] 未设置任何API Key，已启用默认密码: 123456");
    }

    const modelsPath = path.join(__dirname, "..", "models.json");
    try {
        if (fs.existsSync(modelsPath)) {
            const modelsFileContent = fs.readFileSync(modelsPath, "utf-8");
            config.modelList = JSON.parse(modelsFileContent);
            logger.info(`[System] 已从 models.json 成功加载 ${config.modelList.length} 个模型。`);
        } else {
            logger.warn(`[System] 未找到 models.json 文件，将使用默认模型列表。`);
            config.modelList = ["gemini-1.5-pro-latest"];
        }
    } catch (error) {
        logger.error(`[System] 读取或解析 models.json 失败: ${error.message}，将使用默认模型列表。`);
        config.modelList = ["gemini-1.5-pro-latest"];
    }

    logger.info("================ [ 生效配置 ] ================");
    logger.info(`  多实例并发数: ${config.instanceNum}`);
    logger.info(`  无头模式 (Headless): ${config.headless ? "✅ 是 (隐藏窗口)" : "❌ 否 (显示窗口)"}`); // 打印展示
    logger.info(`  HTTP 服务端口: ${config.httpPort}`);
    logger.info(`  监听地址: ${config.host}`);
    logger.info(`  WS 起始端口: ${config.wsPort}`);
    logger.info(`  全局缺省 URL: ${config.targetUrl}`);
    if (Object.keys(config.portUrls).length > 0) {
        logger.info(`  特定端口 URL 映射:`);
        for (const [port, url] of Object.entries(config.portUrls)) {
            logger.info(`    - 端口 ${port}: ${url}`);
        }
    }
    logger.info(`  流式模式: ${config.streamingMode}`);
    logger.info(`  轮换计数切换阈值: ${config.switchOnUses > 0 ? `每 ${config.switchOnUses} 次请求后切换` : "已禁用"}`);
    logger.info(`  失败计数切换: ${config.failureThreshold > 0 ? `失败${config.failureThreshold} 次后切换` : "已禁用"}`);
    logger.info(`  立即切换报错码: ${config.immediateSwitchStatusCodes.length > 0 ? config.immediateSwitchStatusCodes.join(", ") : "已禁用"}`);
    logger.info(`  单次请求最大重试: ${config.maxRetries}次`);
    logger.info(`  重试间隔: ${config.retryDelay}ms`);
    logger.info(`  API 密钥来源: ${config.apiKeySource}`);
    if (config.httpProxy) {
        const maskedProxy = config.httpProxy.replace(/:[^:@/]+@/, ":****@");
        logger.info(`  浏览器代理: ${maskedProxy}`);
    } else {
        logger.info(`  浏览器代理: 已禁用`);
    }
    logger.info("=============================================================");

    return config;
}

module.exports = { LoggingService, loadConfiguration };

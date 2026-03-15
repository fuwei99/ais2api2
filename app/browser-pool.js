const { firefox } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");

class BrowserInstance {
    constructor(port, config, authSource, logger) {
        this.port = port;
        this.config = config;
        this.authSource = authSource;
        this.logger = logger;
        this.browser = null;
        this.context = null;
        this.page = null;
        this.currentAuthIndex = null;
        this.status = "INIT"; // INIT, BOOTING, READY, DEAD
        this.usageCount = 0;
        this.failureCount = 0;
        this.noButtonCount = 0;

        let plat = os.platform();
        this.execPath = config.browserExecutablePath || (plat === "linux" ? path.join(__dirname, "..", "camoufox-linux", "camoufox") : path.join(__dirname, "..", "camoufox", "camoufox.exe"));
        this.launchArgs = [
            "--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox", "--disable-setuid-sandbox",
            "--disable-infobars", "--disable-background-networking", "--disable-default-apps",
            "--disable-extensions", "--disable-sync", "--disable-translate", "--metrics-recording-only",
            "--mute-audio", "--safebrowsing-disable-auto-update", "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"
        ];
    }

    notifyUserActivity() {
        if (this.noButtonCount > 0) {
            this.logger.info(`[Browser] ⚡ [端口 ${this.port}] 收到用户请求信号，强制唤醒后台检测 (重置计数器)`);
            this.noButtonCount = 0;
        }
    }

    async launch(authIndex) {
        this.status = "BOOTING";
        this.currentAuthIndex = authIndex;

        const targetUrl = this.config.portUrls[this.port] || this.config.targetUrl;

        this.logger.info("==================================================");
        this.logger.info(`🔄 [Browser] 正在为账号 #${authIndex} 创建新的浏览器上下文 (分配端口: ${this.port})`);
        this.logger.info(`   • 目标 URL: ${targetUrl}`);
        this.logger.info("==================================================");

        try {
            if (!fs.existsSync(this.execPath)) {
                throw new Error(`Browser executable not found at path: ${this.execPath}`);
            }

            let proxyConfig = undefined;
            if (this.config.httpProxy) {
                try {
                    const proxyUrl = new URL(this.config.httpProxy);
                    proxyConfig = {
                        server: `${proxyUrl.protocol}//${proxyUrl.host}`,
                        bypass: "localhost,127.0.0.1",
                    };
                    if (proxyUrl.username) proxyConfig.username = decodeURIComponent(proxyUrl.username);
                    if (proxyUrl.password) proxyConfig.password = decodeURIComponent(proxyUrl.password);
                } catch (e) {
                    proxyConfig = { server: this.config.httpProxy, bypass: "localhost,127.0.0.1" };
                }
            }

            // === 核心修改：将配置中的 headless 传入 Playwright ===
            this.browser = await firefox.launch({
                headless: this.config.headless,
                executablePath: this.execPath,
                args: this.launchArgs,
                proxy: proxyConfig,
            });

            this.browser.on("disconnected", () => {
                this.logger.error(`❌ [Browser] [端口 ${this.port}] 浏览器意外断开连接！`);
                this.status = "DEAD";
            });

            const storageStateObject = this.authSource.getAuth(authIndex);
            this.context = await this.browser.newContext({
                storageState: storageStateObject,
                viewport: { width: 1920, height: 1080 },
            });
            this.page = await this.context.newPage();

            this.page.on("console", (msg) => {
                const msgText = msg.text();
                if (msgText.includes("Content-Security-Policy: (Report-Only policy)")) return;
                if (msgText.includes("[ProxyClient]")) {
                    this.logger.info(`[Browser-${this.port}] ${msgText.replace("[ProxyClient] ", "")}`);
                } else if (msg.type() === "error") {
                    this.logger.error(`[Browser Page Error - ${this.port}] ${msgText}`);
                }
            });

            this.page.on("crash", () => {
                this.logger.error(`🚨 [Browser] [端口 ${this.port}] 致命：页面进程崩溃 (Crash)！当前账号索引: ${authIndex}`);
                this.status = "DEAD";
            });

            this.page.on("framenavigated", (frame) => {
                if (frame === this.page.mainFrame()) {
                    const newUrl = frame.url();
                    if (newUrl !== "about:blank" && !newUrl.includes(targetUrl.split('?')[0])) {
                        this.logger.warn(`⚠️ [Browser] [端口 ${this.port}] 页面发生了意外导航/刷新！新 URL: ${newUrl}`);
                    }
                }
            });

            this.page.on("websocket", (ws) => {
                ws.on("close", () => this.logger.info(`[Browser Network - ${this.port}] 页面内的 WebSocket 连接已关闭: ${ws.url()}`));
                ws.on("error", (err) => this.logger.error(`[Browser Network - ${this.port}] 页面内的 WebSocket 发生错误: ${err}`));
            });

            this.logger.info(`[Browser] [端口 ${this.port}] 正在导航至目标网页...`);
            await this.page.goto(targetUrl, { timeout: 180000, waitUntil: "domcontentloaded" });
            this.logger.info(`[Browser] [端口 ${this.port}] 页面加载完成。`);

            await this.page.waitForTimeout(3000);

            const currentUrl = this.page.url();
            let pageTitle = "";
            try { pageTitle = await this.page.title(); } catch (e) { this.logger.warn(`[Browser] [端口 ${this.port}] 无法获取页面标题: ${e.message}`); }

            this.logger.info(`[Browser] [诊断 - ${this.port}] URL: ${currentUrl}`);
            this.logger.info(`[Browser] [诊断 - ${this.port}] Title: "${pageTitle}"`);

            if (currentUrl.includes("accounts.google.com") || currentUrl.includes("ServiceLogin") || pageTitle.includes("Sign in") || pageTitle.includes("登录")) throw new Error("🚨 Cookie 已失效/过期！浏览器被重定向到了 Google 登录页面。请重新提取 storageState。");
            if (pageTitle.includes("Available regions") || pageTitle.includes("not available")) throw new Error("🚨 当前 IP 不支持访问 Google AI Studio。请更换节点后重启！");
            if (pageTitle.includes("403") || pageTitle.includes("Forbidden")) throw new Error("🚨 403 Forbidden：当前 IP 信誉过低，被 Google 风控拒绝访问。");
            if (currentUrl === "about:blank") throw new Error("🚨 页面加载失败 (about:blank)，可能是网络连接超时或浏览器崩溃。");

            this.logger.info(`[Browser] [端口 ${this.port}] 进入 20秒 检查流程 (目标: Cookie + Got it + 新手引导)...`);
            const startTime = Date.now();
            const timeLimit = 20000;
            const popupStatus = { cookie: false, gotIt: false, guide: false, continueBtn: false };

            while (Date.now() - startTime < timeLimit) {
                if (popupStatus.cookie && popupStatus.gotIt && popupStatus.guide) {
                    this.logger.info(`[Browser] ⚡ [端口 ${this.port}] 完美！3个弹窗全部处理完毕，提前进入下一步。`);
                    break;
                }

                let clickedInThisLoop = false;

                if (!popupStatus.cookie) {
                    try {
                        const agreeBtn = this.page.locator('button:text("Agree")').first();
                        if (await agreeBtn.isVisible({ timeout: 100 })) {
                            await agreeBtn.click({ force: true });
                            this.logger.info(`[Browser] ✅ (1/3) 点击了 "Cookie Agree"`);
                            popupStatus.cookie = true;
                            clickedInThisLoop = true;
                        }
                    } catch (e) { }
                }

                if (!popupStatus.gotIt) {
                    try {
                        const gotItBtn = this.page.locator('div.dialog button:text("Got it")').first();
                        if (await gotItBtn.isVisible({ timeout: 100 })) {
                            await gotItBtn.click({ force: true });
                            this.logger.info(`[Browser] ✅ (2/3) 点击了 "Got it" 弹窗`);
                            popupStatus.gotIt = true;
                            clickedInThisLoop = true;
                        }
                    } catch (e) { }
                }

                if (!popupStatus.guide) {
                    try {
                        const closeBtn = this.page.locator('button[aria-label="Close"]').first();
                        if (await closeBtn.isVisible({ timeout: 100 })) {
                            await closeBtn.click({ force: true });
                            this.logger.info(`[Browser] ✅ (3/3) 点击了 "新手引导关闭" 按钮`);
                            popupStatus.guide = true;
                            clickedInThisLoop = true;
                        }
                    } catch (e) { }
                }

                if (!popupStatus.continueBtn) {
                    try {
                        const clicked = await this.page.evaluate(() => {
                            const btns = Array.from(document.querySelectorAll("button"));
                            const target = btns.find((b) => b.innerText && b.innerText.includes("Continue to the app"));
                            if (target) { target.click(); return true; }
                            return false;
                        });

                        if (clicked) {
                            this.logger.info(`[Browser] ✅ (4/4) 原生JS成功点击 "Continue to the app"`);
                            popupStatus.continueBtn = true;
                            clickedInThisLoop = true;
                            this.logger.info(`[Browser] ⚡ [端口 ${this.port}] 已确认进入应用，提前终止弹窗等待循环。`);
                            break;
                        }
                    } catch (e) { }
                }

                try {
                    const isAppRunning = await this.page.evaluate(() => { return document.body.innerText.includes("[ProxyClient]"); });
                    if (isAppRunning) {
                        this.logger.info(`[Browser] ⚡ [端口 ${this.port}] 检测到内部环境已就绪，跳出弹窗等待。`);
                        break;
                    }
                } catch (e) { }

                await this.page.waitForTimeout(clickedInThisLoop ? 500 : 1000);
            }

            this.logger.info(`[Browser] [端口 ${this.port}] 弹窗检查结束 (耗时: ${Math.round((Date.now() - startTime) / 1000)}s)，结果: Cookie[${popupStatus.cookie ? "Ok" : "No"}], GotIt[${popupStatus.gotIt ? "Ok" : "No"}], Guide[${popupStatus.guide ? "Ok" : "No"}]`);

            this._startBackgroundWakeup();
            this.logger.info(`[Browser] (后台任务) 🛡️ [端口 ${this.port}] 监控进程已启动...`);
            await this.page.waitForTimeout(1000);
            this.logger.info(`[Browser] ⚡ [端口 ${this.port}] 正在发送主动唤醒请求以触发 Launch 流程...`);

            try {
                await this.page.evaluate(async () => {
                    try {
                        await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=ActiveTrigger", { method: "GET", headers: { "Content-Type": "application/json" } });
                    } catch (e) {
                        console.log("[ProxyClient] 主动唤醒请求已发送 (预期内可能会失败，这很正常)");
                    }
                });
                this.logger.info(`[Browser] ⚡ [端口 ${this.port}] 主动唤醒请求已发送。`);
            } catch (e) {
                this.logger.warn(`[Browser] [端口 ${this.port}] 主动唤醒请求发送异常 (不影响主流程): ${e.message}`);
            }

            this.logger.info("==================================================");
            this.logger.info(`✅ [Browser] 账号 ${authIndex} 的上下文初始化成功！(关联端口: ${this.port})`);
            this.logger.info("✅ [Browser] 浏览器客户端已准备就绪。");
            this.logger.info("==================================================");

            this.status = "READY";
            this.usageCount = 0;
            this.failureCount = 0;

        } catch (error) {
            this.logger.error(`❌ [Browser] [端口 ${this.port}] 账户 ${authIndex} 启动失败: ${error.message}`);
            await this.close();
            throw error;
        }
    }

    async close() {
        this.status = "DEAD";
        if (this.browser) {
            this.logger.info(`[Browser] [端口 ${this.port}] 正在关闭整个浏览器实例...`);
            await this.browser.close().catch(() => { });
            this.browser = null;
            this.context = null;
            this.page = null;
            this.logger.info(`[Browser] [端口 ${this.port}] 浏览器实例已关闭。`);
        }
    }

    async _startBackgroundWakeup() {
        const currentPage = this.page;
        await new Promise((r) => setTimeout(r, 1500));
        if (!currentPage || currentPage.isClosed() || this.page !== currentPage) return;
        this.logger.info(`[Browser] (后台任务) 🛡️ [端口 ${this.port}] 网页保活监控已启动`);

        while (currentPage && !currentPage.isClosed() && this.page === currentPage && this.status !== "DEAD") {
            try {
                await currentPage.bringToFront().catch(() => { });
                await currentPage.mouse.move(10, 10);
                await currentPage.mouse.move(20, 20);

                const targetInfo = await currentPage.evaluate(() => {
                    try {
                        const preciseCandidates = Array.from(document.querySelectorAll(".interaction-modal p, .interaction-modal button"));
                        for (const el of preciseCandidates) {
                            const text = (el.innerText || "").trim();
                            if (/Launch|rocket_launch/i.test(text)) {
                                const rect = el.getBoundingClientRect();
                                if (rect.width > 0 && rect.height > 0) return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tagName: el.tagName, text: text.substring(0, 15), strategy: "precise_css" };
                            }
                        }
                    } catch (e) { }

                    const MIN_Y = 400; const MAX_Y = 800;
                    const isValid = (rect) => rect.width > 0 && rect.height > 0 && rect.top > MIN_Y && rect.top < MAX_Y;
                    const candidates = Array.from(document.querySelectorAll("button, span, div, a, i"));

                    for (const el of candidates) {
                        const text = (el.innerText || "").trim();
                        if (!/Launch|rocket_launch/i.test(text)) continue;
                        let targetEl = el;
                        let rect = targetEl.getBoundingClientRect();
                        let parentDepth = 0;
                        while (parentDepth < 3 && targetEl.parentElement) {
                            if (targetEl.tagName === "BUTTON" || targetEl.getAttribute("role") === "button") break;
                            const parent = targetEl.parentElement;
                            const pRect = parent.getBoundingClientRect();
                            if (isValid(pRect)) { targetEl = parent; rect = pRect; }
                            parentDepth++;
                        }
                        if (isValid(rect)) return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tagName: targetEl.tagName, text: text.substring(0, 15), strategy: "fuzzy_scan" };
                    }
                    return { found: false };
                });

                if (targetInfo.found) {
                    this.noButtonCount = 0;
                    this.logger.info(`[Browser] 🎯 [端口 ${this.port}] 锁定目标 [${targetInfo.tagName}] (策略: ${targetInfo.strategy === "precise_css" ? "精准定位" : "模糊扫描"})...`);

                    await currentPage.mouse.move(targetInfo.x, targetInfo.y, { steps: 5 });
                    await new Promise((r) => setTimeout(r, 300));
                    await currentPage.mouse.down();
                    await new Promise((r) => setTimeout(r, 400));
                    await currentPage.mouse.up();

                    this.logger.info(`[Browser] 🖱️ [端口 ${this.port}] 物理点击已执行，验证结果...`);
                    await new Promise((r) => setTimeout(r, 1500));

                    const isStillThere = await currentPage.evaluate(() => {
                        const els = Array.from(document.querySelectorAll('button, span, div[role="button"]'));
                        return els.some((el) => {
                            const r = el.getBoundingClientRect();
                            return /Launch|rocket_launch/i.test(el.innerText) && r.top > 400 && r.top < 800 && r.height > 0;
                        });
                    });

                    if (isStillThere) {
                        this.logger.warn(`[Browser] ⚠️ [端口 ${this.port}] 物理点击似乎无效（按钮仍在），尝试 JS 强力点击...`);
                        await currentPage.evaluate(() => {
                            const MIN_Y = 400; const MAX_Y = 800;
                            const candidates = Array.from(document.querySelectorAll('button, span, div[role="button"]'));
                            for (const el of candidates) {
                                const r = el.getBoundingClientRect();
                                if (/Launch|rocket_launch/i.test(el.innerText) && r.top > MIN_Y && r.top < MAX_Y) {
                                    let target = el;
                                    if (target.closest("button")) target = target.closest("button");
                                    target.click();
                                    console.log("[ProxyClient] JS Click triggered on " + target.tagName);
                                    return true;
                                }
                            }
                        });
                        await new Promise((r) => setTimeout(r, 2000));
                    } else {
                        this.logger.info(`[Browser] ✅ [端口 ${this.port}] 物理点击成功，按钮已消失。`);
                        await new Promise((r) => setTimeout(r, 60000));
                        this.noButtonCount = 21;
                    }
                } else {
                    this.noButtonCount++;
                    if (this.noButtonCount > 20) {
                        for (let i = 0; i < 30; i++) {
                            if (this.noButtonCount === 0 || this.status === "DEAD") break;
                            await new Promise((r) => setTimeout(r, 1000));
                        }
                    } else {
                        await new Promise((r) => setTimeout(r, 1500));
                    }
                }
            } catch (e) {
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
    }
}

class BrowserPool {
    constructor(config, authSource, wsManager, logger) {
        this.config = config;
        this.authSource = authSource;
        this.wsManager = wsManager;
        this.logger = logger;
        this.instances = new Map();
    }

    async start() {
        const totalAvailable = this.authSource.availableIndices.length;
        const actualInstances = Math.min(this.config.instanceNum, totalAvailable);
        this.logger.info(`[Pool] 计划启动 ${actualInstances} 个并发实例 (基于总可用账号数 ${totalAvailable})...`);

        for (let i = 0; i < actualInstances; i++) {
            const port = this.config.wsPort + i;
            this.wsManager.startServerForPort(port);
            const instance = new BrowserInstance(port, this.config, this.authSource, this.logger);
            this.instances.set(port, instance);
            this.spawnInstance(port);
        }
    }

    async spawnInstance(port) {
        const instance = this.instances.get(port);
        const authIndex = this.authSource.checkoutNextAccount();
        if (!authIndex) {
            instance.status = "DEAD";
            this.logger.error(`[Pool] 端口 ${port} 启动失败: 无可用账号分配。`);
            return;
        }
        try {
            await instance.launch(authIndex);
        } catch (e) {
            this.authSource.releaseAccount(authIndex);
            this.respawn(port);
        }
    }

    async respawn(port, manualTargetIndex = null) {
        const instance = this.instances.get(port);
        if (!instance || instance.status === "BOOTING") {
            this.logger.info(`🔄 [Pool] 端口 ${port} 正在重启中，跳过重复操作`);
            return;
        }

        this.logger.warn(`[Pool] 🔄 实例 [端口 ${port}] 触发回收与重生流程...`);
        const oldIndex = instance.currentAuthIndex;
        await instance.close();
        this.authSource.releaseAccount(oldIndex);

        const newIndex = manualTargetIndex !== null ? manualTargetIndex : this.authSource.checkoutNextAccount();
        if (!newIndex) {
            this.logger.error(`[Pool] 端口 ${port} 无法重生: 没有可用的未锁定账号。`);
            return;
        }

        try {
            await instance.launch(newIndex);
        } catch (e) {
            this.authSource.releaseAccount(newIndex);
            if (manualTargetIndex === null) {
                setTimeout(() => this.respawn(port), 5000);
            }
        }
    }

    getBestInstance() {
        let best = null;
        for (const [port, instance] of this.instances.entries()) {
            if (instance.status === "READY" && this.wsManager.connections.has(port)) {
                if (!best || instance.usageCount < best.usageCount) {
                    best = instance;
                }
            }
        }
        return best;
    }
}

module.exports = { BrowserPool };

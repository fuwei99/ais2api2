const fs = require("fs");
const path = require("path");
const https = require("https");
const unzipper = require("unzipper");

class AuthSource {
    constructor(logger) {
        this.logger = logger;
        this.authMode = "file";
        this.availableIndices = [];
        this.initialIndices = [];
        this.accountNameMap = new Map();
        this.lockedIndices = new Set(); // 多实例锁
    }

    async init() {
        if (process.env.ZIP_URL) {
            await this.initAuthFromZip();
        }

        if (process.env.ACC_1 || process.env.AUTH_JSON_1) {
            this.authMode = "env";
            this.logger.info(`[Auth] 检测到 ${process.env.ACC_1 ? "ACC_1" : "AUTH_JSON_1"} 环境变量，切换到环境变量认证模式。`);
        } else {
            this.logger.info('[Auth] 未检测到环境变量认证，将使用 "auth/" 目录下的文件。');
        }

        this._discoverAvailableIndices();
        this._preValidateAndFilter();

        if (this.availableIndices.length === 0) {
            this.logger.error(`[Auth] 致命错误：在 '${this.authMode}' 模式下未找到任何有效的认证源。`);
            throw new Error("No valid authentication sources found.");
        }
    }

    async initAuthFromZip() {
        const zipUrl = process.env.ZIP_URL;
        const zipPass = process.env.ZIP_PASSWORD;
        if (!zipUrl) return;

        this.logger.info(`[Auth] 探测到 ZIP_URL: ${zipUrl.split("?")[0]}，准备拉取远程认证源...`);
        const tempZip = path.join(__dirname, "..", "remote_auth.zip");
        const innerZip = path.join(__dirname, "..", "bundle.zip");

        try {
            const downloadWithRedirects = (url, dest, redirectCount = 0) => {
                return new Promise((resolve, reject) => {
                    if (redirectCount > 5) return reject(new Error("重定向次数过多"));
                    https.get(url, (response) => {
                        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                            return resolve(downloadWithRedirects(response.headers.location, dest, redirectCount + 1));
                        }
                        if (response.statusCode !== 200) {
                            return reject(new Error(`下载失败，状态码: ${response.statusCode}`));
                        }
                        const file = fs.createWriteStream(dest);
                        response.pipe(file);
                        file.on("finish", () => {
                            file.close();
                            resolve();
                        });
                    }).on("error", (err) => {
                        if (fs.existsSync(dest)) fs.unlinkSync(dest);
                        reject(err);
                    });
                });
            };

            await downloadWithRedirects(zipUrl, tempZip);
            this.logger.info("   • 下载完成，正在进行第一层解压 (AES/ZipCrypto)...");

            const directory1 = await unzipper.Open.file(tempZip);
            for (const entry of directory1.files) {
                const extractPath = path.join(__dirname, "..", entry.path);
                const parentDir = path.dirname(extractPath);
                if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });

                const content = await entry.buffer(zipPass);
                fs.writeFileSync(extractPath, content);
            }
            this.logger.info("   • 第一层解压成功！");

            if (fs.existsSync(innerZip)) {
                this.logger.info("   • 正在进行第二层解压 (Bundle)...");
                const directory2 = await unzipper.Open.file(innerZip);
                for (const entry of directory2.files) {
                    const extractPath = path.join(__dirname, "..", entry.path);
                    const parentDir = path.dirname(extractPath);
                    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });

                    const content = await entry.buffer();
                    fs.writeFileSync(extractPath, content);
                }
                this.logger.info("   • 第二层解压成功！");
            } else {
                this.logger.warn("   • 警告：未发现 bundle.zip，尝试直接使用一级解压结果。");
            }

            this.logger.info("✅ [Auth] 远程认证源加载成功！已更新 auth/ 目录。");
        } catch (error) {
            this.logger.error(`❌ [Auth] 自动加载远程认证源失败: ${error.message}`);
        } finally {
            if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
            if (fs.existsSync(innerZip)) fs.unlinkSync(innerZip);
        }
    }

    _discoverAvailableIndices() {
        let indices = [];
        if (this.authMode === "env") {
            const regex = /^(ACC|AUTH_JSON)_(\d+)$/;
            for (const key in process.env) {
                const match = key.match(regex);
                if (match && match[2]) {
                    indices.push(parseInt(match[2], 10));
                }
            }
        } else {
            const authDir = path.join(__dirname, "..", "auth");
            if (!fs.existsSync(authDir)) {
                this.logger.warn('[Auth] "auth/" 目录不存在。');
                this.availableIndices = [];
                return;
            }
            try {
                const files = fs.readdirSync(authDir);
                const authFiles = files.filter((file) => /^auth-\d+\.json$/.test(file));
                indices = authFiles.map((file) =>
                    parseInt(file.match(/^auth-(\d+)\.json$/)[1], 10),
                );
            } catch (error) {
                this.logger.error(`[Auth] 扫描 "auth/" 目录失败: ${error.message}`);
                this.availableIndices = [];
                return;
            }
        }

        this.initialIndices = [...new Set(indices)].sort((a, b) => a - b);
        this.availableIndices = [...this.initialIndices];

        this.logger.info(`[Auth] 在 '${this.authMode}' 模式下，初步发现 ${this.initialIndices.length} 个认证源: [${this.initialIndices.join(", ")}]`);
    }

    _getAuthContent(index) {
        if (this.authMode === "env") {
            return process.env[`ACC_${index}`] || process.env[`AUTH_JSON_${index}`];
        } else {
            const authFilePath = path.join(__dirname, "..", "auth", `auth-${index}.json`);
            if (!fs.existsSync(authFilePath)) return null;
            try {
                return fs.readFileSync(authFilePath, "utf-8");
            } catch (e) {
                return null;
            }
        }
    }

    _preValidateAndFilter() {
        if (this.availableIndices.length === 0) return;

        this.logger.info("[Auth] 开始预检验所有认证源的JSON格式...");
        const validIndices = [];
        const invalidSourceDescriptions = [];

        for (const index of this.availableIndices) {
            const authContent = this._getAuthContent(index);
            if (authContent) {
                try {
                    const authData = JSON.parse(authContent);
                    validIndices.push(index);
                    this.accountNameMap.set(index, authData.accountName || "N/A (未命名)");
                } catch (e) {
                    invalidSourceDescriptions.push(`auth-${index}`);
                }
            } else {
                invalidSourceDescriptions.push(`auth-${index} (无法读取)`);
            }
        }

        if (invalidSourceDescriptions.length > 0) {
            this.logger.warn(`⚠️ [Auth] 预检验发现 ${invalidSourceDescriptions.length} 个格式错误或无法读取的认证源: [${invalidSourceDescriptions.join(", ")}]，将从可用列表中移除。`);
        }

        this.availableIndices = validIndices;
    }

    getAuth(index) {
        if (!this.availableIndices.includes(index)) {
            this.logger.error(`[Auth] 请求了无效或不存在的认证索引: ${index}`);
            return null;
        }

        let jsonString = this._getAuthContent(index);
        if (!jsonString) {
            this.logger.error(`[Auth] 在读取时无法获取认证源 #${index} 的内容。`);
            return null;
        }

        try {
            return JSON.parse(jsonString);
        } catch (e) {
            this.logger.error(`[Auth] 解析来自认证源 #${index} 的JSON内容失败: ${e.message}`);
            return null;
        }
    }

    // ==== 多实例分配与解锁机制 ====
    checkoutNextAccount() {
        const available = this.availableIndices.filter(i => !this.lockedIndices.has(i));
        if (available.length === 0) return null;
        const picked = available[0];
        this.lockedIndices.add(picked);
        return picked;
    }

    checkoutSpecificAccount(targetIndex) {
        if (!this.availableIndices.includes(targetIndex)) return { success: false, reason: `切换失败：账号 #${targetIndex} 无效或不存在。` };
        if (this.lockedIndices.has(targetIndex)) return { success: false, reason: `切换失败：账号 #${targetIndex} 正在被其他实例使用。` };
        this.lockedIndices.add(targetIndex);
        return { success: true };
    }

    releaseAccount(index) {
        if (index !== null) {
            this.lockedIndices.delete(index);
        }
    }
}

module.exports = AuthSource;

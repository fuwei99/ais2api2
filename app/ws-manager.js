const WebSocket = require("ws");
const { EventEmitter } = require("events");

class MessageQueue extends EventEmitter {
    constructor(timeoutMs = 600000) {
        super();
        this.messages = [];
        this.waitingResolvers = [];
        this.defaultTimeout = timeoutMs;
        this.closed = false;
    }
    enqueue(message) {
        if (this.closed) return;
        if (this.waitingResolvers.length > 0) {
            const resolver = this.waitingResolvers.shift();
            resolver.resolve(message);
        } else {
            this.messages.push(message);
        }
    }
    async dequeue(timeoutMs = this.defaultTimeout) {
        if (this.closed) {
            throw new Error("Queue is closed");
        }
        return new Promise((resolve, reject) => {
            if (this.messages.length > 0) {
                resolve(this.messages.shift());
                return;
            }
            const resolver = { resolve, reject };
            this.waitingResolvers.push(resolver);
            const timeoutId = setTimeout(() => {
                const index = this.waitingResolvers.indexOf(resolver);
                if (index !== -1) {
                    this.waitingResolvers.splice(index, 1);
                    reject(new Error("Queue timeout"));
                }
            }, timeoutMs);
            resolver.timeoutId = timeoutId;
        });
    }
    close() {
        this.closed = true;
        this.waitingResolvers.forEach((resolver) => {
            clearTimeout(resolver.timeoutId);
            resolver.reject(new Error("Queue closed"));
        });
        this.waitingResolvers = [];
        this.messages = [];
    }
}

class WsManager extends EventEmitter {
    constructor(logger) {
        super();
        this.logger = logger;
        this.servers = new Map();
        this.connections = new Map();
        this.reconnectGraceTimers = new Map();
        this.messageQueues = new Map();
    }

    startServerForPort(port) {
        if (this.servers.has(port)) return;
        const wss = new WebSocket.Server({ port, host: "0.0.0.0" });
        this.servers.set(port, wss);

        wss.on("connection", (ws, req) => {
            // 还原原版：当新连接建立时，清除可能存在的“断开”警报
            if (this.reconnectGraceTimers.has(port)) {
                clearTimeout(this.reconnectGraceTimers.get(port));
                this.reconnectGraceTimers.delete(port);
                this.logger.info(`[Server] 端口 ${port} 在缓冲期内检测到新连接，已取消断开处理。`);
            }

            this.connections.set(port, ws);
            this.logger.info(`[Server] 端口 ${port} 内部WebSocket客户端已接入。`);
            this.emit("connected", port);

            ws.on("message", (data) => this._handleIncomingMessage(data.toString()));
            ws.on("error", (error) => this.logger.error(`[Server] 端口 ${port} 内部WebSocket连接错误: ${error.message}`));
            ws.on("close", () => this._handleClose(port));
        });
    }

    _handleClose(port) {
        this.connections.delete(port);
        this.logger.warn(`[Server] 端口 ${port} 内部WebSocket客户端连接断开。`);

        // 还原原版：不立即清理队列，而是启动一个缓冲期
        this.logger.info(`[Server] 端口 ${port} 启动5秒重连缓冲期...`);
        const timer = setTimeout(() => {
            this.logger.error(`[Server] 端口 ${port} 缓冲期结束，未检测到重连。确认连接丢失，正在清理所有待处理请求...`);
            this.reconnectGraceTimers.delete(port);
            this.emit("connectionLost", port);
        }, 5000); // 5秒的缓冲时间
        this.reconnectGraceTimers.set(port, timer);
    }

    _handleIncomingMessage(messageData) {
        try {
            const parsedMessage = JSON.parse(messageData);
            const requestId = parsedMessage.request_id;
            if (!requestId) {
                this.logger.warn("[Server] 收到无效消息：缺少request_id");
                return;
            }
            const queue = this.messageQueues.get(requestId);
            if (queue) {
                const { event_type } = parsedMessage;
                switch (event_type) {
                    case "response_headers":
                    case "chunk":
                    case "error":
                        queue.enqueue(parsedMessage);
                        break;
                    case "stream_close":
                        queue.enqueue({ type: "STREAM_END" });
                        break;
                    default:
                        this.logger.warn(`[Server] 未知的内部事件类型: ${event_type}`);
                }
            } else {
                this.logger.warn(`[Server] 收到未知或已过时请求ID的消息: ${requestId}`);
            }
        } catch (error) {
            this.logger.error("[Server] 解析内部WebSocket消息失败");
        }
    }

    createMessageQueue(requestId) {
        const queue = new MessageQueue();
        this.messageQueues.set(requestId, queue);
        return queue;
    }

    removeMessageQueue(requestId) {
        const queue = this.messageQueues.get(requestId);
        if (queue) {
            queue.close();
            this.messageQueues.delete(requestId);
        }
    }

    sendToPort(port, payload) {
        const ws = this.connections.get(port);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
            return true;
        }
        return false;
    }
}

module.exports = WsManager;

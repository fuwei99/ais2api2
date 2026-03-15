function translateOpenAIToGoogle(openaiBody, modelName = "", forceThinking = false, logger) {
    logger.info("[Adapter] 开始将OpenAI请求格式翻译为Google格式...");

    // 解析复合后缀
    const isNoThinkingSuffix = modelName.includes("-nothinking");
    const isSearchSuffix = modelName.includes("-search");
    const baseModelName = modelName.replace("-nothinking", "").replace("-search", "");

    let systemInstruction = null;
    const googleContents = [];

    // 1. 分离出 system 指令
    const systemMessages = openaiBody.messages.filter((msg) => msg.role === "system");
    if (systemMessages.length > 0) {
        const systemContent = systemMessages.map((msg) => msg.content).join("\n");
        systemInstruction = {
            role: "system",
            parts: [{ text: systemContent }],
        };
    }

    // 2. 转换 user 和 assistant 消息
    const conversationMessages = openaiBody.messages.filter((msg) => msg.role !== "system");
    for (const message of conversationMessages) {
        const googleParts = [];

        if (typeof message.content === "string") {
            googleParts.push({ text: message.content });
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part.type === "text") {
                    googleParts.push({ text: part.text });
                } else if (part.type === "image_url" && part.image_url) {
                    const dataUrl = part.image_url.url;
                    const match = dataUrl.match(/^data:(image\/.*?);base64,(.*)$/);
                    if (match) {
                        googleParts.push({
                            inlineData: {
                                mimeType: match[1],
                                data: match[2],
                            },
                        });
                    }
                }
            }
        }

        googleContents.push({
            role: message.role === "assistant" ? "model" : "user",
            parts: googleParts,
        });
    }

    // 3. 构建最终的Google请求体
    const googleRequest = {
        contents: googleContents,
        ...(systemInstruction && {
            systemInstruction: { parts: systemInstruction.parts },
        }),
    };

    // 4. 转换生成参数
    const generationConfig = {
        temperature: openaiBody.temperature,
        topP: openaiBody.top_p,
        topK: openaiBody.top_k,
        maxOutputTokens: openaiBody.max_tokens,
        stopSequences: openaiBody.stop,
    };

    const extraBody = openaiBody.extra_body || {};
    let rawThinkingConfig = extraBody.google?.thinking_config || extraBody.google?.thinkingConfig || extraBody.thinkingConfig || extraBody.thinking_config || openaiBody.thinkingConfig || openaiBody.thinking_config;

    let thinkingConfig = null;

    if (rawThinkingConfig) {
        thinkingConfig = {};
        if (rawThinkingConfig.include_thoughts !== undefined) {
            thinkingConfig.includeThoughts = rawThinkingConfig.include_thoughts;
        } else if (rawThinkingConfig.includeThoughts !== undefined) {
            thinkingConfig.includeThoughts = rawThinkingConfig.includeThoughts;
        }
        logger.info(`[Adapter] 成功提取并转换推理配置: ${JSON.stringify(thinkingConfig)}`);
    }

    if (isNoThinkingSuffix) {
        logger.info(`[Adapter] 检测到 -nothinking 后缀，为模型 ${baseModelName} 注入特定推理压制配置。`);
        if (baseModelName.includes("2.5-pro")) {
            thinkingConfig = { thinkingBudget: 128 };
        } else if (baseModelName.includes("3.0") || baseModelName.includes("3.1") || baseModelName.includes("3.")) {
            thinkingConfig = { thinkingLevel: "LOW" };
        } else if (baseModelName.includes("2.5-flash") || baseModelName.includes("flash-lite")) {
            thinkingConfig = { thinkingBudget: 0 };
        }
    } else {
        if (!thinkingConfig) {
            const effort = openaiBody.reasoning_effort || extraBody.reasoning_effort;
            if (effort) {
                logger.info(`[Adapter] 检测到 OpenAI 标准推理参数 (reasoning_effort: ${effort})，自动转换为 Google 格式。`);
                thinkingConfig = { includeThoughts: true };
            }
        }
        if (forceThinking && !thinkingConfig) {
            logger.info("[Adapter] ⚠️ 强制推理已启用，且客户端未提供配置，正在注入 thinkingConfig...");
            thinkingConfig = { includeThoughts: true };
        }
    }

    if (thinkingConfig) {
        generationConfig.thinkingConfig = thinkingConfig;
    }
    googleRequest.generationConfig = generationConfig;

    // 5. 注入搜索工具
    if (isSearchSuffix) {
        logger.info(`[Adapter] 检测到 -search 后缀，为模型 ${baseModelName} 开启 Google Search 工具。`);
        googleRequest.tools = [{ googleSearch: {} }];
    }

    // 6. 安全设置
    googleRequest.safetySettings = [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
    ];

    logger.info("[Adapter] 翻译完成。");
    return { baseModelName, googleRequest };
}

function translateGoogleToOpenAIStream(googleChunk, modelName, requestId) {
    if (!googleChunk || googleChunk.trim() === "") {
        return null;
    }

    let jsonString = googleChunk;
    if (jsonString.startsWith("data: ")) {
        jsonString = jsonString.substring(6).trim();
    }

    if (!jsonString || jsonString === "[DONE]") return null;

    let googleResponse;
    try {
        googleResponse = JSON.parse(jsonString);
    } catch (e) {
        return null; // 无法解析则忽略
    }

    const candidate = googleResponse.candidates?.[0];
    if (!candidate) {
        if (googleResponse.promptFeedback) {
            const errorText = `[ProxySystem Error] Request blocked due to safety settings. Finish Reason: ${googleResponse.promptFeedback.blockReason}`;
            return `data: ${JSON.stringify({
                id: `chatcmpl-${requestId}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [{ index: 0, delta: { content: errorText }, finish_reason: "stop" }],
            })}\n\n`;
        }
        return null;
    }

    const delta = {};

    if (candidate.content && Array.isArray(candidate.content.parts)) {
        const imagePart = candidate.content.parts.find((p) => p.inlineData);

        if (imagePart) {
            const image = imagePart.inlineData;
            delta.content = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
        } else {
            let contentAccumulator = "";
            let reasoningAccumulator = "";

            for (const part of candidate.content.parts) {
                if (part.thought === true) {
                    reasoningAccumulator += part.text || "";
                } else {
                    contentAccumulator += part.text || "";
                }
            }

            if (reasoningAccumulator) {
                delta.reasoning_content = reasoningAccumulator;
            }
            if (contentAccumulator) {
                delta.content = contentAccumulator;
            }
        }
    }

    if (!delta.content && !delta.reasoning_content && !candidate.finishReason) {
        return null;
    }

    const openaiResponse = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [
            {
                index: 0,
                delta: delta,
                finish_reason: candidate.finishReason || null,
            },
        ],
    };

    return `data: ${JSON.stringify(openaiResponse)}\n\n`;
}

module.exports = { translateOpenAIToGoogle, translateGoogleToOpenAIStream };

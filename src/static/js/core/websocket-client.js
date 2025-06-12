import { EventEmitter } from 'https://cdn.skypack.dev/eventemitter3';
import { blobToJSON, base64ToArrayBuffer } from '../utils/utils.js';
import { ApplicationError, ErrorCodes } from '../utils/error-boundary.js';
import { Logger } from '../utils/logger.js';
import { ToolManager } from '../tools/tool-manager.js';

/**
 * Client for interacting with the Gemini 2.0 Flash Multimodal Live API via WebSockets.
 * This class handles the connection, sending and receiving messages, and processing responses.
 * It extends EventEmitter to emit events for various stages of the interaction.
 *
 * @extends EventEmitter
 */
export class MultimodalLiveClient extends EventEmitter {
    /**
     * Creates a new MultimodalLiveClient.
     *
     * @param {Object} options - Configuration options.
     * @param {string} [options.url] - The WebSocket URL for the Gemini API. Defaults to a URL constructed with the provided API key.
     */
    constructor() {
        super();
        this.ws = null;
        this.isConnected = false;
        this.messageQueue = [];
        this.currentModel = null;
        this.send = this.send.bind(this);
        this.toolManager = new ToolManager();
        this.debug = true; // 启用调试模式
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.reconnectDelay = 1000; // 1秒
    }

    /**
     * Logs a message with a timestamp and type. Emits a 'log' event.
     *
     * @param {string} type - The type of the log message (e.g., 'server.send', 'client.close').
     * @param {string|Object} message - The message to log.
     */
    log(message, type = 'info') {
        if (this.debug) {
            console.log(`[GeminiWebSocket] ${type.toUpperCase()}: ${message}`);
            if (this.onLog) {
                this.onLog(message, type);
            }
        }
    }

    /**
     * Connects to the WebSocket server with the given configuration.
     * The configuration can include model settings, generation config, system instructions, and tools.
     *
     * @param {Object} config - The configuration for the connection.
     * @param {string} config.model - The model to use (e.g., 'gemini-2.0-flash-exp').
     * @param {Object} config.generationConfig - Configuration for content generation.
     * @param {string[]} config.generationConfig.responseModalities - The modalities for the response (e.g., "audio", "text").
     * @param {Object} config.generationConfig.speechConfig - Configuration for speech generation.
     * @param {Object} config.generationConfig.speechConfig.voiceConfig - Configuration for the voice.
     * @param {string} config.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName - The name of the prebuilt voice to use.
     * @param {Object} config.systemInstruction - Instructions for the system.
     * @param {Object[]} config.systemInstruction.parts - Parts of the system instruction.
     * @param {string} config.systemInstruction.parts[].text - Text content of the instruction part.
     * @param {Object[]} [config.tools] - Additional tools to be used by the model.
     * @returns {Promise<boolean>} - Resolves with true when the connection is established.
     * @throws {ApplicationError} - Throws an error if the connection fails.
     */
    async connect(config, apiKey) {
        this.log('开始连接...', 'info');
        
        if (this.isConnected) {
            const error = '已经连接到服务器，请先断开连接';
            this.log(error, 'error');
            throw new Error(error);
        }

        if (!config || !config.model) {
            const error = '配置无效：未指定模型';
            this.log(error, 'error');
            throw new Error(error);
        }

        if (!apiKey) {
            const error = '配置无效：未提供 API Key';
            this.log(error, 'error');
            throw new Error(error);
        }

        this.currentModel = config.model;
        this.log(`使用模型: ${this.currentModel}`, 'info');
        
        const wsUrl = new URL('/v1/models/' + this.currentModel + ':streamGenerateContent', window.location.origin);
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl.searchParams.append('key', apiKey);
        
        this.log(`连接 URL: ${wsUrl.toString().replace(apiKey, '***')}`, 'info');
        this.log(`WebSocket 状态: ${this.ws ? this.getWebSocketState(this.ws.readyState) : '未初始化'}`, 'info');

        return new Promise((resolve, reject) => {
            try {
                if (this.ws) {
                    this.log('清理现有连接...', 'info');
                    this.ws.close();
                    this.ws = null;
                }

                this.ws = new WebSocket(wsUrl.toString());
                this.log('WebSocket 实例已创建', 'info');

                // 设置超时
                const connectionTimeout = setTimeout(() => {
                    if (this.ws.readyState !== WebSocket.OPEN) {
                        this.log('连接超时', 'error');
                        this.ws.close();
                        reject(new Error('连接超时'));
                    }
                }, 10000); // 10秒超时

                this.ws.onopen = () => {
                    clearTimeout(connectionTimeout);
                    this.log('WebSocket 连接已建立', 'success');
                    this.log(`WebSocket 状态: ${this.getWebSocketState(this.ws.readyState)}`, 'info');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.processMessageQueue();
                    resolve();
                };

                this.ws.onclose = (event) => {
                    clearTimeout(connectionTimeout);
                    const state = this.getWebSocketState(event.code);
                    const message = `WebSocket 连接已关闭 (代码: ${event.code}, 状态: ${state}, 原因: ${event.reason || '无'})`;
                    this.log(message, 'warning');
                    
                    // 记录更详细的关闭原因
                    switch (event.code) {
                        case 1000:
                            this.log('正常关闭', 'info');
                            break;
                        case 1001:
                            this.log('离开页面或导航到其他页面', 'info');
                            break;
                        case 1002:
                            this.log('协议错误', 'error');
                            break;
                        case 1003:
                            this.log('接收到无法处理的数据', 'error');
                            break;
                        case 1005:
                            this.log('无状态码关闭', 'warning');
                            break;
                        case 1006:
                            this.log('连接异常关闭，可能是网络问题或服务器拒绝连接', 'error');
                            break;
                        case 1007:
                            this.log('接收到不一致的数据', 'error');
                            break;
                        case 1008:
                            this.log('违反政策', 'error');
                            break;
                        case 1009:
                            this.log('消息太大', 'error');
                            break;
                        case 1010:
                            this.log('客户端需要扩展', 'error');
                            break;
                        case 1011:
                            this.log('服务器遇到意外情况', 'error');
                            break;
                        case 1012:
                            this.log('服务重启', 'info');
                            break;
                        case 1013:
                            this.log('服务临时过载', 'warning');
                            break;
                        case 1014:
                            this.log('网关超时', 'error');
                            break;
                        case 1015:
                            this.log('TLS 握手失败', 'error');
                            break;
                        default:
                            this.log(`未知关闭代码: ${event.code}`, 'warning');
                    }

                    this.isConnected = false;
                    this.currentModel = null;
                    if (this.onClose) {
                        this.onClose(event);
                    }
                };

                this.ws.onerror = (error) => {
                    clearTimeout(connectionTimeout);
                    let errorMessage = 'WebSocket 错误: ';
                    
                    // 尝试获取更详细的错误信息
                    if (error instanceof Error) {
                        errorMessage += error.message;
                    } else if (error.message) {
                        errorMessage += error.message;
                    } else {
                        errorMessage += '未知错误';
                        // 记录更多错误信息
                        this.log('错误详情:', 'error');
                        this.log(JSON.stringify(error, null, 2), 'error');
                    }
                    
                    this.log(errorMessage, 'error');
                    this.isConnected = false;
                    this.currentModel = null;
                    reject(new Error(errorMessage));
                };

                this.ws.onmessage = (event) => {
                    this.log('收到消息', 'info');
                    if (this.onMessage) {
                        try {
                            this.onMessage(event.data);
                        } catch (error) {
                            this.log(`处理消息时出错: ${error.message}`, 'error');
                            this.log('消息内容:', 'error');
                            this.log(event.data, 'error');
                        }
                    }
                };
            } catch (error) {
                const errorMessage = `创建 WebSocket 连接时出错: ${error.message}`;
                this.log(errorMessage, 'error');
                reject(new Error(errorMessage));
            }
        });
    }

    getWebSocketState(code) {
        const states = {
            0: 'CONNECTING',
            1: 'OPEN',
            2: 'CLOSING',
            3: 'CLOSED'
        };
        return states[code] || `未知状态(${code})`;
    }

    /**
     * Disconnects from the WebSocket server.
     *
     * @param {WebSocket} [ws] - The WebSocket instance to disconnect. If not provided, defaults to the current instance.
     * @returns {boolean} - True if disconnected, false otherwise.
     */
    disconnect(ws) {
        this.log('正在断开连接...', 'info');
        if ((!ws || this.ws === ws) && this.ws) {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close(1000, '用户主动断开连接');
            }
            this.ws = null;
        }
        this.isConnected = false;
        this.currentModel = null;
        this.log('连接已断开', 'info');
        return true;
    }

    /**
     * Receives and processes a message from the WebSocket server.
     * Handles different types of responses like tool calls, setup completion, and server content.
     *
     * @param {Blob} blob - The received blob data.
     */
    async receive(blob) {
        const response = await blobToJSON(blob);
        if (response.toolCall) {
            this.log('server.toolCall', response);
            await this.handleToolCall(response.toolCall);
            return;
        }
        if (response.toolCallCancellation) {
            this.log('receive.toolCallCancellation', response);
            this.emit('toolcallcancellation', response.toolCallCancellation);
            return;
        }
        if (response.setupComplete) {
            this.log('server.send', 'setupComplete');
            this.emit('setupcomplete');
            return;
        }
        if (response.serverContent) {
            const { serverContent } = response;
            if (serverContent.interrupted) {
                this.log('receive.serverContent', 'interrupted');
                this.emit('interrupted');
                return;
            }
            if (serverContent.turnComplete) {
                this.log('server.send', 'turnComplete');
                this.emit('turncomplete');
            }
            if (serverContent.modelTurn) {
                let parts = serverContent.modelTurn.parts;
                const audioParts = parts.filter((p) => p.inlineData && p.inlineData.mimeType.startsWith('audio/pcm'));
                const base64s = audioParts.map((p) => p.inlineData?.data);
                const otherParts = parts.filter((p) => !audioParts.includes(p));

                base64s.forEach((b64) => {
                    if (b64) {
                        const data = base64ToArrayBuffer(b64);
                        this.emit('audio', data);
                        //this.log(`server.audio`, `buffer (${data.byteLength})`);
                    }
                });

                if (!otherParts.length) {
                    return;
                }

                parts = otherParts;
                const content = { modelTurn: { parts } };
                this.emit('content', content);
                this.log(`server.content`, response);
            }
        } else {
            console.log('Received unmatched message', response);
        }
    }

    /**
     * Sends real-time input data to the server.
     *
     * @param {Array} chunks - An array of media chunks to send. Each chunk should have a mimeType and data.
     */
    sendRealtimeInput(chunks) {
        let hasAudio = false;
        let hasVideo = false;
        let totalSize = 0;

        for (let i = 0; i < chunks.length; i++) {
            const ch = chunks[i];
            totalSize += ch.data.length;
            if (ch.mimeType.includes('audio')) {
                hasAudio = true;
            }
            if (ch.mimeType.includes('image')) {
                hasVideo = true;
            }
        }

        const message = hasAudio && hasVideo ? 'audio + video' : hasAudio ? 'audio' : hasVideo ? 'video' : 'unknown';
        Logger.debug(`Sending realtime input: ${message} (${Math.round(totalSize/1024)}KB)`);

        const data = { realtimeInput: { mediaChunks: chunks } };
        this._sendDirect(data);
        //this.log(`client.realtimeInput`, message);
    }

    /**
     * Sends a tool response to the server.
     *
     * @param {Object} toolResponse - The tool response to send.
     */
    sendToolResponse(toolResponse) {
        const message = { toolResponse };
        this._sendDirect(message);
        this.log(`client.toolResponse`, message);
    }

    /**
     * Sends a message to the server.
     *
     * @param {string|Object|Array} parts - The message parts to send. Can be a string, an object, or an array of strings/objects.
     * @param {boolean} [turnComplete=true] - Indicates if this message completes the current turn.
     */
    send(parts, turnComplete = true) {
        parts = Array.isArray(parts) ? parts : [parts];
        const formattedParts = parts.map(part => {
            if (typeof part === 'string') {
                return { text: part };
            } else if (typeof part === 'object' && !part.text && !part.inlineData) {
                return { text: JSON.stringify(part) };
            }
            return part;
        });
        const content = { role: 'user', parts: formattedParts };
        const clientContentRequest = { clientContent: { turns: [content], turnComplete } };
        this._sendDirect(clientContentRequest);
        this.log(`client.send`, clientContentRequest);
    }

    /**
     * Sends a message directly to the WebSocket server.
     *
     * @param {Object} request - The request to send.
     * @throws {Error} - Throws an error if the WebSocket is not connected.
     * @private
     */
    _sendDirect(request) {
        if (!this.ws) {
            throw new Error('WebSocket is not connected');
        }
        const str = JSON.stringify(request);
        this.ws.send(str);
    }

    /**
     * Handles a tool call from the server.
     *
     * @param {Object} toolCall - The tool call data.
     */
    async handleToolCall(toolCall) {
        try {
            const response = await this.toolManager.handleToolCall(toolCall.functionCalls[0]);
            this.sendToolResponse(response);
        } catch (error) {
            Logger.error('Tool call failed', error);
            this.sendToolResponse({
                functionResponses: [{
                    response: { error: error.message },
                    id: toolCall.functionCalls[0].id
                }]
            });
        }
    }
} 
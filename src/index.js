const assetManifest = {};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 处理 WebSocket 连接
    if (request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocket(request, env);
    }
    
    // 添加 API 请求处理
    if (url.pathname.endsWith("/chat/completions") ||
        url.pathname.endsWith("/embeddings") ||
        url.pathname.endsWith("/models")) {
      return handleAPIRequest(request, env);
    }

    // 处理静态资源
    if (url.pathname === '/' || url.pathname === '/index.html') {
      console.log('Serving index.html',env);
      return new Response(await env.__STATIC_CONTENT.get('index.html'), {
        headers: {
          'content-type': 'text/html;charset=UTF-8',
        },
      });
    }

    // 处理其他静态资源
    const asset = await env.__STATIC_CONTENT.get(url.pathname.slice(1));
    if (asset) {
      const contentType = getContentType(url.pathname);
      return new Response(asset, {
        headers: {
          'content-type': contentType,
        },
      });
    }



    return new Response('Not found', { status: 404 });
  },
};

function getContentType(path) {
  const ext = path.split('.').pop().toLowerCase();
  const types = {
    'js': 'application/javascript',
    'css': 'text/css',
    'html': 'text/html',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif'
  };
  return types[ext] || 'text/plain';
}

async function handleWebSocket(request, env) {


  if (request.headers.get("Upgrade") !== "websocket") {
		return new Response("Expected WebSocket connection", { status: 400 });
	}
  
	const url = new URL(request.url);
    // 从客户端请求 URL 中提取 API 密钥
    const apiKey = url.searchParams.get("key");
    if (!apiKey) {
        return new Response("API key is missing in WebSocket URL.", { status: 401 });
    }

    // 从查询参数中删除 'key'，因为我们将通过 header 发送
    url.searchParams.delete("key");
    const targetPathAndQuery = url.pathname + url.search;

    // 构建目标 URL，但使用 HTTPS 协议，因为 fetch 是通过 HTTP/HTTPS 发起请求的
    const targetUrl = `https://generativelanguage.googleapis.com${targetPathAndQuery}`;

    const [client, server] = new WebSocketPair(); // client 用于我们的客户端，server 用于连接到 Gemini

    // 使用 fetch 并升级到 WebSocket 来连接到 Gemini
    const geminiResponse = await fetch(targetUrl, {
        headers: {
            "Upgrade": "websocket",
            "Connection": "Upgrade",
            "x-goog-api-key": apiKey, // 在这里传递 API 密钥
            "User-Agent": "Cloudflare-Worker-Gemini-Proxy", // 添加 User-Agent 便于识别
        },
    });

    const geminiWebSocket = geminiResponse.webSocket;

    if (!geminiWebSocket) {
        return new Response("Failed to upgrade to WebSocket with Gemini.", { status: 500 });
    }

    // 设置客户端和 Gemini WebSocket 的事件监听器
    // 将消息从客户端转发到 Gemini
    client.addEventListener("message", (event) => {
        geminiWebSocket.send(event.data);
    });

    // 将消息从 Gemini 转发到客户端
    geminiWebSocket.addEventListener("message", (event) => {
        client.send(event.data);
    });

    // 处理关闭事件
    client.addEventListener("close", (event) => {
        console.log("Client connection closed:", { code: event.code, reason: event.reason });
        geminiWebSocket.close(event.code, event.reason);
    });

    geminiWebSocket.addEventListener("close", (event) => {
        console.log("Gemini connection closed:", { code: event.code, reason: event.reason });
        client.close(event.code, event.reason);
    });

    // 处理错误事件
    client.addEventListener("error", (error) => {
        console.error("Client WebSocket error:", error);
        geminiWebSocket.close(1011, "Client error"); // 内部错误
    });

    geminiWebSocket.addEventListener("error", (error) => {
        console.error("Gemini WebSocket error:", error);
        client.close(1011, "Gemini error"); // 内部错误
    });

    return new Response(null, {
        status: 101, // Switching Protocols
        webSocket: client, // 与我们的客户端握手
    });
}

async function handleAPIRequest(request, env) {
  try {
    const worker = await import('./api_proxy/worker.mjs');
    return await worker.default.fetch(request);
  } catch (error) {
    console.error('API request error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorStatus = error.status || 500;
    return new Response(errorMessage, {
      status: errorStatus,
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
      }
    });
  }
}
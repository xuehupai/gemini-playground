const getContentType = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const types: Record<string, string> = {
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
};

async function handleWebSocket(req: Request): Promise<Response> {
  const { socket: clientWs, response } = Deno.upgradeWebSocket(req);
  
  const url = new URL(req.url);
  const targetUrl = `wss://generativelanguage.googleapis.com${url.pathname}${url.search}`;
  
  console.log('WebSocket 连接请求:', {
    url: req.url,
    targetUrl: targetUrl.replace(/\?key=.*$/, '?key=***'),
    headers: Object.fromEntries(req.headers.entries())
  });
  
  const pendingMessages: string[] = [];
  let targetWs: WebSocket | null = null;
  let isClientConnected = true;
  let isTargetConnected = false;

  try {
    targetWs = new WebSocket(targetUrl);
    
    targetWs.onopen = () => {
      console.log('已连接到 Gemini 服务器');
      isTargetConnected = true;
      
      // 发送所有待处理的消息
      console.log(`发送 ${pendingMessages.length} 条待处理消息`);
      for (const msg of pendingMessages) {
        try {
          targetWs?.send(msg);
          console.log('已发送待处理消息:', msg.slice(0, 100) + '...');
        } catch (error) {
          console.error('发送待处理消息失败:', error);
        }
      }
      pendingMessages.length = 0;
    };

    clientWs.onmessage = (event) => {
      console.log('收到客户端消息:', {
        type: typeof event.data,
        preview: typeof event.data === 'string' ? event.data.slice(0, 100) + '...' : '二进制数据',
        timestamp: new Date().toISOString()
      });

      if (targetWs?.readyState === WebSocket.OPEN) {
        try {
          targetWs.send(event.data);
          console.log('消息已转发到 Gemini');
        } catch (error) {
          console.error('转发消息到 Gemini 失败:', error);
          if (isClientConnected) {
            clientWs.send(JSON.stringify({
              error: '转发消息失败: ' + (error instanceof Error ? error.message : '未知错误')
            }));
          }
        }
      } else {
        console.log('Gemini 连接未就绪，消息已加入队列');
        pendingMessages.push(event.data);
      }
    };

    targetWs.onmessage = (event) => {
      console.log('收到 Gemini 消息:', {
        type: typeof event.data,
        preview: typeof event.data === 'string' ? event.data.slice(0, 100) + '...' : '二进制数据',
        timestamp: new Date().toISOString()
      });

      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.send(event.data);
          console.log('消息已转发到客户端');
        } catch (error) {
          console.error('转发消息到客户端失败:', error);
        }
      } else {
        console.log('客户端连接已关闭，无法转发消息');
      }
    };

    clientWs.onclose = (event) => {
      console.log('客户端连接已关闭:', {
        code: event.code,
        reason: event.reason || '无原因',
        wasClean: event.wasClean,
        timestamp: new Date().toISOString()
      });
      isClientConnected = false;

      if (targetWs?.readyState === WebSocket.OPEN) {
        try {
          targetWs.close(1000, '客户端断开连接');
        } catch (error) {
          console.error('关闭 Gemini 连接失败:', error);
        }
      }
    };

    targetWs.onclose = (event) => {
      console.log('Gemini 连接已关闭:', {
        code: event.code,
        reason: event.reason || '无原因',
        wasClean: event.wasClean,
        timestamp: new Date().toISOString()
      });
      isTargetConnected = false;

      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.close(event.code, event.reason || 'Gemini 服务器断开连接');
        } catch (error) {
          console.error('关闭客户端连接失败:', error);
        }
      }
    };

    targetWs.onerror = (error) => {
      console.error('Gemini WebSocket 错误:', {
        error: error instanceof Error ? error.message : '未知错误',
        timestamp: new Date().toISOString()
      });

      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.send(JSON.stringify({
            error: 'Gemini 服务器错误: ' + (error instanceof Error ? error.message : '未知错误')
          }));
        } catch (sendError) {
          console.error('发送错误消息到客户端失败:', sendError);
        }
      }
    };

  } catch (error) {
    console.error('WebSocket 处理错误:', error);
    if (clientWs.readyState === WebSocket.OPEN) {
      try {
        clientWs.close(1011, '服务器内部错误');
      } catch (closeError) {
        console.error('关闭客户端连接失败:', closeError);
      }
    }
    throw error;
  }

  return response;
}

async function handleAPIRequest(req: Request): Promise<Response> {
  try {
    const worker = await import('./api_proxy/worker.mjs');
    return await worker.default.fetch(req);
  } catch (error) {
    console.error('API request error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorStatus = (error as { status?: number }).status || 500;
    return new Response(errorMessage, {
      status: errorStatus,
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
      }
    });
  }
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  console.log('Request URL:', req.url);

  // WebSocket 处理
  if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return handleWebSocket(req);
  }

  if (url.pathname.endsWith("/chat/completions") ||
      url.pathname.endsWith("/embeddings") ||
      url.pathname.endsWith("/models")) {
    return handleAPIRequest(req);
  }

  // 静态文件处理
  try {
    let filePath = url.pathname;
    if (filePath === '/' || filePath === '/index.html') {
      filePath = '/index.html';
    }

    const fullPath = `${Deno.cwd()}/src/static${filePath}`;

    const file = await Deno.readFile(fullPath);
    const contentType = getContentType(filePath);

    return new Response(file, {
      headers: {
        'content-type': `${contentType};charset=UTF-8`,
      },
    });
  } catch (e) {
    console.error('Error details:', e);
    return new Response('Not Found', { 
      status: 404,
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
      }
    });
  }
}

Deno.serve(handleRequest); 
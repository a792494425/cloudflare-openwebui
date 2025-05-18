// --- 配置区域 ---
const TARGET_HOST = "libabaasdasd21312asda-web.hf.space"; // 您要代理的目标主机
const TARGET_SCHEME = "https"; // 目标主机的协议 (http 或 https)

// --- 日志记录函数 (与Deno脚本类似) ---
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// --- User-Agent 生成函数 (源自Deno脚本) ---
function getDefaultUserAgent(isMobile = false) {
  if (isMobile) {
    return "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
  } else {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  }
}

// --- 请求头转换函数 (适配Deno脚本逻辑，用于发往源服务器的请求) ---
function transformHeadersForOrigin(requestHeaders, targetHost /* 通常是 TARGET_HOST */) {
  const newHeaders = new Headers(requestHeaders); // 复制原始请求头

  // 根据 sec-ch-ua-mobile 判断是否为移动设备并设置 User-Agent
  const isMobile = newHeaders.get("sec-ch-ua-mobile") === "?1";
  newHeaders.set("User-Agent", getDefaultUserAgent(isMobile));

  // 设置 Host 和 Origin 头部
  newHeaders.set("Host", targetHost);
  newHeaders.set("Origin", `${TARGET_SCHEME}://${targetHost}`);

  // 清理一些 Cloudflare 特有的、不应发送到源的头部 (可选)
  newHeaders.delete('cf-connecting-ip');
  newHeaders.delete('cf-ipcountry');
  newHeaders.delete('cf-ray');
  newHeaders.delete('cf-visitor');
  newHeaders.delete('cdn-loop');
  // 根据需要添加或删除更多

  return newHeaders;
}

// --- Cloudflare Worker 入口 ---
export default {
  async fetch(request, env, ctx) {
    const originalUrl = new URL(request.url);

    // 判断是否为 WebSocket 升级请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      return handleWebSocket(request, originalUrl);
    } else {
      // 处理普通的 HTTP/HTTPS 请求 (包括 SSE)
      return handleHttpRequest(request, originalUrl);
    }
  },
};

// --- HTTP/HTTPS 请求处理函数 ---
async function handleHttpRequest(request, originalUrl) {
  const targetUrl = new URL(`${TARGET_SCHEME}://${TARGET_HOST}`);
  targetUrl.pathname = originalUrl.pathname;
  targetUrl.search = originalUrl.search;

  log(`HTTP Request: ${request.method} ${originalUrl.pathname}${originalUrl.search} -> ${targetUrl.toString()}`);

  // 准备发往源服务器的请求头部
  const originRequestHeaders = transformHeadersForOrigin(request.headers, TARGET_HOST);

  try {
    const originResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: originRequestHeaders,
      body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
      redirect: "follow", // 与Deno脚本行为一致，Worker主动跟随重定向
    });

    // 复制响应头，以便修改
    const responseHeaders = new Headers(originResponse.headers);

    // 添加 Access-Control-Allow-Origin (与Deno脚本行为一致)
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    // 如果需要更细致的 CORS 控制，可以在这里根据 request.headers.get('Origin') 来设置

    // 可选：添加其他安全相关的响应头
    // responseHeaders.set('X-Content-Type-Options', 'nosniff');
    // responseHeaders.set('X-Frame-Options', 'DENY');

    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    log(`HTTP Proxy Error: ${error.message} for ${targetUrl.toString()}`);
    return new Response(`Proxy Error: ${error.message}`, { status: 500 });
  }
}

// --- WebSocket 请求处理函数 ---
async function handleWebSocket(request, originalUrl) {
  const targetWsUrl = new URL(`${TARGET_SCHEME === 'https' ? 'wss' : 'ws'}://${TARGET_HOST}`);
  targetWsUrl.pathname = originalUrl.pathname;
  targetWsUrl.search = originalUrl.search;

  log(`WebSocket Upgrade: ${originalUrl.pathname}${originalUrl.search} -> ${targetWsUrl.toString()}`);

  const webSocketPair = new WebSocketPair();
  const client = webSocketPair[0]; // 连接到客户端的 WebSocket
  const server = webSocketPair[1]; // Worker 内部的 WebSocket，用于连接到源

  server.accept(); // 接受 Worker runtime 的连接

  // 准备发往源 WebSocket 服务器的头部
  // Cloudflare Worker 的 fetch API 在请求 WebSocket 时，会自动处理一些头部，
  // 但明确设置 Host 和其他必要的 Sec-WebSocket-* 头部是好习惯。
  const originWsHeaders = new Headers();
  originWsHeaders.set('Host', TARGET_HOST);
  originWsHeaders.set('Upgrade', 'websocket'); // 必须
  // originWsHeaders.set('Connection', 'Upgrade'); // fetch 通常会自动处理

  // 复制客户端的 Sec-WebSocket-* 头部
  const clientSecKey = request.headers.get('Sec-WebSocket-Key');
  if (clientSecKey) originWsHeaders.set('Sec-WebSocket-Key', clientSecKey);

  const clientSecVersion = request.headers.get('Sec-WebSocket-Version');
  if (clientSecVersion) originWsHeaders.set('Sec-WebSocket-Version', clientSecVersion);

  const clientSecProtocol = request.headers.get('Sec-WebSocket-Protocol');
  if (clientSecProtocol) originWsHeaders.set('Sec-WebSocket-Protocol', clientSecProtocol);

  // 应用 User-Agent 和 Origin (与Deno脚本行为一致)
  const isMobile = request.headers.get("sec-ch-ua-mobile") === "?1";
  originWsHeaders.set("User-Agent", getDefaultUserAgent(isMobile));
  originWsHeaders.set("Origin", `${TARGET_SCHEME}://${TARGET_HOST}`);


  try {
    // 使用 fetch 连接到源 WebSocket 服务器
    const originWsResponse = await fetch(targetWsUrl.toString(), {
      headers: originWsHeaders,
    });

    const originSocket = originWsResponse.webSocket;
    if (!originSocket) {
      log(`WebSocket origin did not upgrade. Status: ${originWsResponse.status}`);
      let errorBody = `WebSocket origin did not upgrade. Status: ${originWsResponse.status}`;
      try { errorBody += " Body: " + await originWsResponse.text(); } catch (e) {}
      // 如果源服务器没有升级，我们不能用 server.close() 因为它期望一个已建立的连接。
      // 直接返回错误响应给客户端。
      return new Response(errorBody, { status: originWsResponse.status, headers: originWsResponse.headers });
    }

    originSocket.accept(); // 接受来自源服务器的 WebSocket 连接

    // 在 client (连接到浏览器) 和 originSocket (连接到目标服务器) 之间双向传递消息
    originSocket.addEventListener('message', event => {
      try {
        if (server.readyState === WebSocket.OPEN) { // 确保 server 端还开着
          server.send(event.data);
        }
      } catch (e) {
        log(`Error sending origin WS message to client: ${e.message || e}`);
      }
    });

    server.addEventListener('message', event => {
      try {
        if (originSocket.readyState === WebSocket.OPEN) { // 确保 originSocket 还开着
          originSocket.send(event.data);
        }
      } catch (e) {
        log(`Error sending client WS message to origin: ${e.message || e}`);
      }
    });

    // 处理关闭和错误事件，确保连接被正确清理
    const closeOrErrorHandler = (wsSide, otherWs, event, type) => {
      const code = event.code || 1000;
      const reason = event.reason || (type === 'error' ? 'Error encountered' : 'Connection closed');
      log(`${wsSide} WebSocket ${type}: Code ${code}, Reason: ${reason}`);
      // 如果另一端还开着，就用相同的代码和原因关闭它
      if (otherWs.readyState === WebSocket.OPEN || otherWs.readyState === WebSocket.CONNECTING) {
        otherWs.close(code, reason);
      }
    };

    originSocket.addEventListener('close', event => closeOrErrorHandler('Origin', server, event, 'close'));
    server.addEventListener('close', event => closeOrErrorHandler('Client', originSocket, event, 'close'));
    originSocket.addEventListener('error', event => closeOrErrorHandler('Origin', server, event, 'error'));
    server.addEventListener('error', event => closeOrErrorHandler('Client', originSocket, event, 'error'));

    // 准备给客户端的 101 Switching Protocols 响应
    const responseHeaders = new Headers();
    // 如果源服务器选择了子协议，将其传回给客户端
    const chosenProtocol = originWsResponse.headers.get('sec-websocket-protocol');
    if (chosenProtocol) {
      responseHeaders.set('sec-websocket-protocol', chosenProtocol);
    }

    return new Response(null, {
      status: 101,
      webSocket: client, // 将 client 端 WebSocket 交给 Cloudflare runtime
      headers: responseHeaders,
    });

  } catch (error) {
    log(`WebSocket connection to origin error: ${error.message || error}`);
    // 如果在 fetch 阶段就出错了，server 可能还没完全建立，但尝试关闭
    if (server && server.readyState !== WebSocket.CLOSED && server.readyState !== WebSocket.CLOSING) {
        server.close(1011, `Proxy to origin failed: ${error.message || error}`);
    }
    return new Response(`WebSocket Proxy Error: ${error.message || error}`, { status: 502 }); // Bad Gateway
  }
}

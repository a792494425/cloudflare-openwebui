// --- 配置区域 ---
const TARGET_HOST = "libabaasdasd21312asda-web.hf.space"; // 您要代理的目标主机
const TARGET_SCHEME = "https"; // 目标主机的协议 (https)

// --- 日志记录函数 ---
function log(message) {
  // 在 Cloudflare Workers 中，可以直接使用 console.log
  // 如果需要更复杂的日志，可以考虑集成第三方日志服务
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// --- User-Agent 生成函数 (源自您的 Deno 脚本) ---
function getDefaultUserAgent(isMobile = false) {
  if (isMobile) {
    return "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
  } else {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  }
}

// --- HTTP 请求头转换函数 (用于发往源服务器的 HTTP 请求) ---
function transformHttpHeadersForOrigin(clientRequestHeaders, targetHostForHeader) {
  const newHeaders = new Headers(clientRequestHeaders); // 复制原始请求头

  // 根据 sec-ch-ua-mobile 判断是否为移动设备并设置 User-Agent
  const isMobile = newHeaders.get("sec-ch-ua-mobile") === "?1";
  newHeaders.set("User-Agent", getDefaultUserAgent(isMobile));

  // 设置 Host 和 Origin 头部 (针对 HTTP 请求)
  newHeaders.set("Host", targetHostForHeader);
  newHeaders.set("Origin", `${TARGET_SCHEME}://${targetHostForHeader}`);

  // 清理一些 Cloudflare 特有的、不应发送到源的头部 (可选，但推荐)
  newHeaders.delete('cf-connecting-ip');
  newHeaders.delete('cf-ipcountry');
  newHeaders.delete('cf-ray');
  newHeaders.delete('cf-visitor');
  newHeaders.delete('x-real-ip'); // 通常由CF的 CF-Connecting-IP 代替
  newHeaders.delete('cdn-loop');

  return newHeaders;
}

// --- Cloudflare Worker 入口 ---
export default {
  async fetch(request /*: Request */, env /*: Env */, ctx /*: ExecutionContext */) /*: Promise<Response> */ {
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

  // 准备发往源服务器的 HTTP 请求头部 (应用Deno脚本中的转换逻辑)
  const originRequestHeaders = transformHttpHeadersForOrigin(request.headers, TARGET_HOST);

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
    // 生产环境建议更严格的CORS策略
    // responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    // responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");


    // 确保 SSE 流相关的头部被正确处理 (通常是透传源服务器的)
    // 如果源服务器的 SSE 响应没有 Cache-Control: no-cache 等，可以在这里补充
    // if (responseHeaders.get('content-type')?.includes('text/event-stream')) {
    //   responseHeaders.set('cache-control', 'no-cache');
    //   responseHeaders.set('connection', 'keep-alive'); // 虽然通常由HTTP/1.1管理
    // }

    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    log(`HTTP Proxy Error: ${error.name} - ${error.message} for ${targetUrl.toString()}`);
    return new Response(`Proxy Error: ${error.message}`, { status: 502 }); // Bad Gateway 更合适
  }
}

// --- WebSocket 请求处理函数 ---
async function handleWebSocket(request, originalUrl) {
  const targetWsUrl = new URL(`${TARGET_SCHEME === 'https' ? 'wss' : 'ws'}://${TARGET_HOST}`);
  targetWsUrl.pathname = originalUrl.pathname;
  targetWsUrl.search = originalUrl.search;

  log(`WebSocket Upgrade: ${originalUrl.pathname}${originalUrl.search} -> ${targetWsUrl.toString()}`);

  const webSocketPair = new WebSocketPair();
  const clientWs = webSocketPair[0]; // 连接到客户端浏览器的 WebSocket
  const serverWs = webSocketPair[1]; // Worker 内部的 WebSocket，用于连接到源服务器

  serverWs.accept(); // 接受来自 Worker runtime 的连接，这会触发 serverWs 的 open 事件

  // 准备发往源 WebSocket 服务器的头部
  // **关键调整**：这里的头部尽量模拟原生 WebSocket 客户端的行为，
  // 而不是完全照搬 HTTP 请求的 transformHttpHeadersForOrigin 逻辑。
  const originWsHeaders = new Headers();
  originWsHeaders.set('Host', TARGET_HOST); // 必须
  originWsHeaders.set('Upgrade', 'websocket'); // 必须
  // originWsHeaders.set('Connection', 'Upgrade'); // fetch 通常会自动处理

  // 1. 透传客户端的 User-Agent
  if (request.headers.has('User-Agent')) {
    originWsHeaders.set('User-Agent', request.headers.get('User-Agent'));
  } else {
    // 如果客户端没有 User-Agent (不太可能来自浏览器)，可以设置一个通用的，
    // 或者 Deno 可能的默认 User-Agent (例如 "Deno/x.y.z")，
    // 但通常透传客户端的更合理。这里我们不设，依赖fetch的默认行为或上面透传的。
  }

  // 2. 透传 Sec-WebSocket-* 头部
  const secWebSocketKey = request.headers.get('Sec-WebSocket-Key');
  if (secWebSocketKey) originWsHeaders.set('Sec-WebSocket-Key', secWebSocketKey);

  const secWebSocketVersion = request.headers.get('Sec-WebSocket-Version');
  if (secWebSocketVersion) originWsHeaders.set('Sec-WebSocket-Version', secWebSocketVersion);

  const clientSecProtocol = request.headers.get('Sec-WebSocket-Protocol');
  if (clientSecProtocol) originWsHeaders.set('Sec-WebSocket-Protocol', clientSecProtocol);

  // 3. Origin 头部处理 (更接近原生WebSocket客户端行为)
  //    原生 WebSocket 客户端通常会发送发起请求页面的 Origin。
  //    如果客户端请求 Worker 时带了 Origin，我们就透传它。
  //    如果没带 (例如非浏览器客户端)，Deno 的 `new WebSocket()` 可能不发送 Origin，或发送 null/本地路径。
  //    这里我们选择：如果客户端有 Origin 就透传，没有就不主动为 WebSocket 设置伪造的 Origin，
  //    除非测试发现目标服务器强制要求一个与 TARGET_HOST 匹配的 Origin。
  if (request.headers.has('Origin')) {
    originWsHeaders.set('Origin', request.headers.get('Origin'));
  } else {
    // 备选方案：如果目标服务器强依赖一个 Origin，即使客户端没传，
    // Deno 的 HTTP 代理是成功的，它为 HTTP 设置了 Origin。
    // 可以尝试为 WS 也设置，但这可能与 Deno 原生 WS 行为不同。
    // 为求与 HTTP 行为一致性，且基于 Deno HTTP 代理成功的经验，先加上：
    // log('Original request had no Origin for WebSocket, setting to target origin');
    // originWsHeaders.set("Origin", `${TARGET_SCHEME}://${TARGET_HOST}`);
    // **或者，为了更模拟 Deno 原生 WebSocket，这里不设置 Origin (如果原始请求没有的话)**
    // **我们先尝试不设置，如果失败，再尝试上面被注释掉的强制设置**
  }


  try {
    const originWsResponse = await fetch(targetWsUrl.toString(), {
      headers: originWsHeaders,
      // 对于 WebSocket 的 fetch，不需要指定 method 或 body
    });

    const originSocket = originWsResponse.webSocket;
    if (!originSocket) {
      log(`WebSocket origin did not upgrade. Status: ${originWsResponse.status}`);
      let errorBody = `WebSocket origin did not upgrade. Status: ${originWsResponse.status}`;
      try { errorBody += " Body: " + await originWsResponse.text(); } catch (e) {}
      return new Response(errorBody, { status: originWsResponse.status, headers: originWsResponse.headers });
    }

    originSocket.accept();

    // 双向绑定消息、关闭、错误事件
    originSocket.addEventListener('message', event => {
      try {
        if (serverWs.readyState === WebSocket.OPEN) serverWs.send(event.data);
      } catch (e) { log(`Error serverWs.send: ${e}`); }
    });
    serverWs.addEventListener('message', event => {
      try {
        if (originSocket.readyState === WebSocket.OPEN) originSocket.send(event.data);
      } catch (e) { log(`Error originSocket.send: ${e}`); }
    });

    const commonCloseOrErrorHandler = (wsSide, otherWs, event, type) => {
      const code = event.code || (type === 'error' ? 1011 : 1000); // 1011 server error, 1000 normal
      const reason = event.reason || (type === 'error' ? 'Error encountered' : 'Connection closed');
      log(`${wsSide} WebSocket ${type}: Code ${code}, Reason: '${reason}'`);
      if (otherWs.readyState === WebSocket.OPEN || otherWs.readyState === WebSocket.CONNECTING) {
        otherWs.close(code, reason);
      }
    };

    originSocket.addEventListener('close', event => commonCloseOrErrorHandler('Origin', serverWs, event, 'close'));
    serverWs.addEventListener('close', event => commonCloseOrErrorHandler('Client', originSocket, event, 'close'));
    originSocket.addEventListener('error', event => commonCloseOrErrorHandler('Origin', serverWs, event, 'error'));
    serverWs.addEventListener('error', event => commonCloseOrErrorHandler('Client', originSocket, event, 'error'));

    // 准备并返回给客户端的 101 响应
    const responseHeaders = new Headers();
    const chosenProtocol = originWsResponse.headers.get('sec-websocket-protocol');
    if (chosenProtocol) {
      responseHeaders.set('sec-websocket-protocol', chosenProtocol);
    }

    return new Response(null, {
      status: 101,
      webSocket: clientWs, // 将 clientWs 交给 runtime
      headers: responseHeaders,
    });

  } catch (error) {
    log(`WebSocket connection to origin error: ${error.name} - ${error.message}`);
    if (serverWs && serverWs.readyState !== WebSocket.CLOSED && serverWs.readyState !== WebSocket.CLOSING) {
        serverWs.close(1011, `Proxy to origin failed: ${error.message}`);
    }
    return new Response(`WebSocket Proxy Error: ${error.message}`, { status: 502 });
  }
}


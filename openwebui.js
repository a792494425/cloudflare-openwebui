/**
 * @typedef {Object} Env
 * @property {string} TARGET_HOST - 目标服务器的主机名 (例如: "your-app.hf.space")
 * @property {string} TARGET_SCHEME - 目标服务器的协议 (例如: "https")
 * @property {string} ALLOWED_ORIGIN - [推荐] 允许跨域请求的前端域名 (例如: "https://your-frontend.com")
 */

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    try {
      // 优先从环境变量中读取配置，如果未设置则使用默认值
      // 强烈建议在 Cloudflare 的设置中配置这些环境变量
      const TARGET_HOST = env.TARGET_HOST || "libabaasdasd21312asda-web.hf.space";
      const TARGET_SCHEME = env.TARGET_SCHEME || "https";
      
      // 处理 WebSocket 升级请求
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return this.handleWebSocketRequest(request, TARGET_HOST, TARGET_SCHEME);
      }
      
      // 处理普通 HTTP 请求
      return this.handleHttpRequest(request, TARGET_HOST, TARGET_SCHEME, env.ALLOWED_ORIGIN);

    } catch (e) {
      console.error(`[Worker] 全局错误: ${e.message}`);
      return new Response(`代理时发生内部错误: ${e.message}`, { status: 502 });
    }
  },

  /**
   * 处理 HTTP 请求
   * @param {Request} request 原始请求
   * @param {string} targetHost 目标主机
   * @param {string} targetScheme 目标协议
   * @param {string | undefined} allowedOrigin 允许的跨域来源
   * @returns {Promise<Response>}
   */
  async handleHttpRequest(request, targetHost, targetScheme, allowedOrigin) {
    const url = new URL(request.url);
    const targetUrl = `${targetScheme}://${targetHost}${url.pathname}${url.search}`;

    // 复制请求头，并进行必要修改
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('Host', targetHost);
    requestHeaders.set('X-Forwarded-Host', url.hostname);

    // 将客户端的真实 IP 地址通过 X-Forwarded-For 传递给源服务器
    const clientIp = request.headers.get('cf-connecting-ip');
    if (clientIp) {
      requestHeaders.set('X-Forwarded-For', clientIp);
    }

    // 删除 Cloudflare 特有的、不应转发到源站的头部
    requestHeaders.delete('cf-connecting-ip');
    requestHeaders.delete('cf-ipcountry');
    requestHeaders.delete('cf-ray');
    requestHeaders.delete('cf-visitor');

    try {
      const originResponse = await fetch(targetUrl, {
        method: request.method,
        headers: requestHeaders,
        body: request.body,
        redirect: 'manual', // 手动处理重定向，防止敏感信息泄露
      });

      // 对响应头进行修改
      const responseHeaders = new Headers(originResponse.headers);

      // --- CORS 头部设置 ---
      // 为了安全，建议将 ALLOWED_ORIGIN 设置为你的前端域名，而不是 '*'
      responseHeaders.set('Access-Control-Allow-Origin', allowedOrigin || new URL(request.url).origin);
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
      responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');

      // 不主动删除源服务器设置的 CSP 等安全头部

      return new Response(originResponse.body, {
        status: originResponse.status,
        statusText: originResponse.statusText,
        headers: responseHeaders,
      });

    } catch (e) {
      console.error(`[HTTP] 请求目标失败: ${e.message}, URL: ${targetUrl}`);
      return new Response(`HTTP 代理错误: ${e.message}`, { status: 502 });
    }
  },

  /**
   * 处理 WebSocket 握手和代理
   * @param {Request} request 原始请求
   * @param {string} targetHost 目标主机
   * @param {string} targetScheme 目标协议
   * @returns {Promise<Response>}
   */
  async handleWebSocketRequest(request, targetHost, targetScheme) {
    const url = new URL(request.url);
    const targetUrl = `${targetScheme === 'https' ? 'wss' : 'ws'}://${targetHost}${url.pathname}${url.search}`;

    // 建立 WebSocket 连接对
    const { 0: clientWs, 1: serverWs } = new WebSocketPair();

    // 准备发往源服务器的 WebSocket 握手请求头
    const handshakeHeaders = new Headers();
    handshakeHeaders.set('Host', targetHost);
    handshakeHeaders.set('Upgrade', 'websocket');
    handshakeHeaders.set('Connection', 'Upgrade');

    // 透传关键的 WebSocket 头部
    const wsKeys = ['Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Protocol', 'User-Agent'];
    wsKeys.forEach(key => {
      if (request.headers.has(key)) {
        handshakeHeaders.set(key, request.headers.get(key));
      }
    });

    // hf.space 等平台可能强制要求 Origin 头部
    if (request.headers.has('Origin')) {
      handshakeHeaders.set('Origin', request.headers.get('Origin'));
    } else {
      // 如果客户端未提供 Origin，则根据目标信息构造一个
      handshakeHeaders.set('Origin', `${targetScheme}://${targetHost}`);
    }

    try {
      // 向源服务器发起 WebSocket 连接请求
      const originResponse = await fetch(targetUrl, { headers: handshakeHeaders });

      const originSocket = originResponse.webSocket;
      if (!originSocket) {
        console.error(`[WebSocket] 源服务器未升级连接. 状态: ${originResponse.status}, URL: ${targetUrl}`);
        return new Response("WebSocket 源服务器连接失败", { status: originResponse.status, headers: originResponse.headers });
      }

      // 接受双向连接，并设置事件监听以转发数据
      serverWs.accept();
      originSocket.accept();

      const forwardMessage = (source, destination, direction) => {
        source.addEventListener('message', event => {
          if (destination.readyState === WebSocket.OPEN) {
            destination.send(event.data);
          }
        });
      };
      
      forwardMessage(serverWs, originSocket, 'client -> origin');
      forwardMessage(originSocket, serverWs, 'origin -> client');

      // 处理关闭和错误事件
      const closeHandler = (event, side) => {
        console.log(`[WebSocket] ${side} 已关闭: ${event.code} ${event.reason}`);
        if (serverWs.readyState === WebSocket.OPEN) serverWs.close(event.code, event.reason);
        if (originSocket.readyState === WebSocket.OPEN) originSocket.close(event.code, event.reason);
      };

      const errorHandler = (error, side) => {
        console.error(`[WebSocket] ${side} 发生错误:`, error);
        if (serverWs.readyState === WebSocket.OPEN) serverWs.close(1011, `${side} 错误`);
        if (originSocket.readyState === WebSocket.OPEN) originSocket.close(1011, `${side} 错误`);
      };

      serverWs.addEventListener('close', event => closeHandler(event, '客户端'));
      originSocket.addEventListener('close', event => closeHandler(event, '源服务器'));
      serverWs.addEventListener('error', event => errorHandler(event, '客户端'));
      originSocket.addEventListener('error', event => errorHandler(event, '源服务器'));
      
      // 返回 101 Switching Protocols 响应，并将客户端的 WebSocket 连接交由 Worker 处理
      return new Response(null, { status: 101, webSocket: clientWs });

    } catch (e) {
      console.error(`[WebSocket] 代理连接错误: ${e.message}, URL: ${targetUrl}`);
      return new Response(`WebSocket 代理错误: ${e.message}`, { status: 502 });
    }
  }
};

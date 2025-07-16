// --- 配置 ---
// 建议在Cloudflare的环境变量中设置这些值。
// const TARGET_HOST = "libabaasdasd21312asda-web.hf.space"; // 例如：在Cloudflare仪表板中设置为 TARGET_HOST
// const TARGET_SCHEME = "https"; // 例如：在Cloudflare仪表板中设置为 TARGET_SCHEME

export default {
  async fetch(request, env, ctx) {
    // 从环境变量读取配置值 (提供备用值)
    const TARGET_HOST = env.TARGET_HOST || "libabaasdasd21312asda-web.hf.space";
    const TARGET_SCHEME = env.TARGET_SCHEME || "https";

    const url = new URL(request.url);

    // 构建目标URL
    const targetUrlObj = new URL(`${TARGET_SCHEME}://${TARGET_HOST}`);
    targetUrlObj.pathname = url.pathname;
    targetUrlObj.search = url.search;
    const targetRequestUrl = targetUrlObj.toString();

    // 准备发往源服务器的请求头：主要修改Host头部，其他透传
    const originRequestHeaders = new Headers(request.headers);
    originRequestHeaders.set('Host', TARGET_HOST);

    // 删除Cloudflare添加的、不应发往源服务器的头部
    originRequestHeaders.delete('cf-connecting-ip');
    originRequestHeaders.delete('cf-ipcountry');
    originRequestHeaders.delete('cf-ray');
    originRequestHeaders.delete('cf-visitor');
    originRequestHeaders.delete('x-real-ip'); // 通常由 cf-connecting-ip 替代

    // 处理 WebSocket 升级请求
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const webSocketPair = new WebSocketPair();
      const clientWs = webSocketPair[0];
      const serverWs = webSocketPair[1];

      serverWs.accept();

      // WebSocket 握手头部：设置 Host，透传关键的 Sec-* 头部和客户端原始的 UA/Origin
      const wsHandshakeHeaders = new Headers();
      wsHandshakeHeaders.set('Host', TARGET_HOST);
      wsHandshakeHeaders.set('Upgrade', 'websocket');
      wsHandshakeHeaders.set('Connection', 'Upgrade'); // 某些源服务器可能需要此头部

      if (request.headers.has('Sec-WebSocket-Key')) wsHandshakeHeaders.set('Sec-WebSocket-Key', request.headers.get('Sec-WebSocket-Key'));
      if (request.headers.has('Sec-WebSocket-Version')) wsHandshakeHeaders.set('Sec-WebSocket-Version', request.headers.get('Sec-WebSocket-Version'));
      if (request.headers.has('Sec-WebSocket-Protocol')) wsHandshakeHeaders.set('Sec-WebSocket-Protocol', request.headers.get('Sec-WebSocket-Protocol'));

      // 透传原始客户端的 User-Agent 和 Origin (如果存在)
      if (request.headers.has('User-Agent')) wsHandshakeHeaders.set('User-Agent', request.headers.get('User-Agent'));
      if (request.headers.has('Origin')) {
        wsHandshakeHeaders.set('Origin', request.headers.get('Origin'));
      } else {
        // 如果客户端没有发送 Origin (例如非浏览器客户端),
        // 且 hf.space 强制要求 Origin，可以考虑取消下面一行的注释，
        // 并使用 TARGET_SCHEME 和 TARGET_HOST 生成 Origin。
        // wsHandshakeHeaders.set('Origin', `${TARGET_SCHEME}://${TARGET_HOST}`);
        // console.log(`WebSocket：来自 ${request.headers.get('cf-connecting-ip')} 的原始请求没有 Origin 头部。目标：${targetRequestUrl}`);
      }

      try {
        // 向源服务器发起 WebSocket 连接
        const originResponse = await fetch(targetRequestUrl, { headers: wsHandshakeHeaders });
        const originSocket = originResponse.webSocket;

        if (!originSocket) {
          // console.error(`WebSocket：源服务器未升级连接。状态码：${originResponse.status}，URL：${targetRequestUrl}`);
          serverWs.close(1011, "源服务器未升级到 WebSocket"); // "Origin did not upgrade to WebSocket"
          return new Response("WebSocket 源服务器未升级", { status: originResponse.status, headers: originResponse.headers }); // "WebSocket origin did not upgrade"
        }
        originSocket.accept();

        // 消息、关闭、错误处理的双向绑定
        originSocket.addEventListener('message', event => {
          if (serverWs.readyState === WebSocket.OPEN) {
            serverWs.send(event.data);
          }
        });
        serverWs.addEventListener('message', event => {
          if (originSocket.readyState === WebSocket.OPEN) {
            originSocket.send(event.data);
          }
        });

        const commonCloseHandler = (event, side) => {
          // 生产环境中，考虑更详细的日志记录或与外部监控系统集成
          // console.log(`${side} WebSocket 已关闭：${event.code} ${event.reason}。IP：${request.headers.get('cf-connecting-ip')}`);
          if (side === 'origin' && serverWs.readyState === WebSocket.OPEN) serverWs.close(event.code, event.reason);
          if (side === 'client' && originSocket.readyState === WebSocket.OPEN) originSocket.close(event.code, event.reason);
        };
        const commonErrorHandler = (event, side) => {
          // 生产环境中，考虑更详细的日志记录或与外部监控系统集成
          // console.error(`${side} WebSocket 错误：${event.message || '未知错误'}。IP：${request.headers.get('cf-connecting-ip')}`);
          if (side === 'origin' && serverWs.readyState === WebSocket.OPEN) serverWs.close(1011, "源 WebSocket 错误"); // "Origin WebSocket error"
          if (side === 'client' && originSocket.readyState === WebSocket.OPEN) originSocket.close(1011, "客户端 WebSocket 错误"); // "Client WebSocket error"
        };

        originSocket.addEventListener('close', event => commonCloseHandler(event, 'origin'));
        serverWs.addEventListener('close', event => commonCloseHandler(event, 'client'));
        originSocket.addEventListener('error', event => commonErrorHandler(event, 'origin'));
        serverWs.addEventListener('error', event => commonErrorHandler(event, 'client'));

        const responseHeaders = new Headers();
        // 如果源服务器返回了 Sec-WebSocket-Protocol，则将其返回给客户端
        if (originResponse.headers.has('sec-websocket-protocol')) {
            responseHeaders.set('sec-websocket-protocol', originResponse.headers.get('sec-websocket-protocol'));
        }

        return new Response(null, { status: 101, webSocket: clientWs, headers: responseHeaders });

      } catch (e) {
        // console.error(`WebSocket 代理连接错误：${e.message}。IP：${request.headers.get('cf-connecting-ip')}，目标：${targetRequestUrl}`);
        serverWs.close(1011, "WebSocket 代理连接错误"); // "WebSocket proxy connection error"
        return new Response(`WebSocket 代理错误：${e.message}`, { status: 502 }); // "WebSocket Proxy Error: "
      }
    } else {
      // 处理普通 HTTP 请求
      try {
        const response = await fetch(targetRequestUrl, {
          method: request.method,
          headers: originRequestHeaders,
          body: request.body,
          redirect: 'follow', // 与 Deno 脚本保持一致
        });

        // 对响应头做最小修改，主要是透传，根据需要添加基础CORS
        const responseHeaders = new Headers(response.headers);
        // Access-Control-Allow-Origin 设置为 '*'，但根据安全需求，
        // 可以考虑限制为特定的源。
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH'); // 根据需要调整方法
        responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // 根据需要调整头部

        // 不添加强制缓存，不删除CSP等安全头部

        return new Response(response.body, {
          status: response.status,
          headers: responseHeaders,
        });
      } catch (e) {
        // console.error(`HTTP Fetch 错误：${e.message}。IP：${request.headers.get('cf-connecting-ip')}，目标：${targetRequestUrl}，方法：${request.method}`);
        return new Response(`HTTP 代理错误：${e.message}`, {status: 502}); // "HTTP Proxy Error: "
      }
    }
  }
};

// --- 配置 ---
const TARGET_HOST = "libabaasdasd21312asda-web.hf.space";
const TARGET_SCHEME = "https"; // 假设目标是 HTTPS

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 构建目标 URL
    const targetUrlObj = new URL(`${TARGET_SCHEME}://${TARGET_HOST}`);
    targetUrlObj.pathname = url.pathname;
    targetUrlObj.search = url.search;
    const targetRequestUrl = targetUrlObj.toString();

    // 准备发往源的请求头：主要目标是透传，仅修改 Host
    const originRequestHeaders = new Headers(request.headers);
    originRequestHeaders.set('Host', TARGET_HOST);

    // 删除一些 Cloudflare 添加的、不应发往源的头部
    originRequestHeaders.delete('cf-connecting-ip');
    originRequestHeaders.delete('cf-ipcountry');
    originRequestHeaders.delete('cf-ray');
    originRequestHeaders.delete('cf-visitor');
    originRequestHeaders.delete('x-real-ip'); // 通常由 cf-connecting-ip 代替

    // 处理 WebSocket 升级请求
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const webSocketPair = new WebSocketPair();
      const clientWs = webSocketPair[0];
      const serverWs = webSocketPair[1];

      serverWs.accept();

      // WebSocket 握手头部：设置 Host，透传关键 Sec-* 头部和客户端原始 UA/Origin
      const wsHandshakeHeaders = new Headers();
      wsHandshakeHeaders.set('Host', TARGET_HOST);
      wsHandshakeHeaders.set('Upgrade', 'websocket');

      if (request.headers.has('Sec-WebSocket-Key')) wsHandshakeHeaders.set('Sec-WebSocket-Key', request.headers.get('Sec-WebSocket-Key'));
      if (request.headers.has('Sec-WebSocket-Version')) wsHandshakeHeaders.set('Sec-WebSocket-Version', request.headers.get('Sec-WebSocket-Version'));
      if (request.headers.has('Sec-WebSocket-Protocol')) wsHandshakeHeaders.set('Sec-WebSocket-Protocol', request.headers.get('Sec-WebSocket-Protocol'));

      // 透传原始客户端的 User-Agent 和 Origin (如果存在)
      if (request.headers.has('User-Agent')) wsHandshakeHeaders.set('User-Agent', request.headers.get('User-Agent'));
      if (request.headers.has('Origin')) {
        wsHandshakeHeaders.set('Origin', request.headers.get('Origin'));
      } else {
        // 如果客户端没有发送 Origin (例如非浏览器客户端),
        // Deno 的 new WebSocket() 行为可能是不发送，或发送 null/本地源。
        // 此处我们先尝试不主动添加 Origin。
        // 如果 hf.space 强制要求 Origin，我们可能需要像之前一样设置为 TARGET_SCHEME + TARGET_HOST
        // console.log("WebSocket: Original request has no Origin header.");
      }


      try {
        const originResponse = await fetch(targetRequestUrl, { headers: wsHandshakeHeaders });
        const originSocket = originResponse.webSocket;

        if (!originSocket) {
          serverWs.close(1011, "Origin did not upgrade to WebSocket");
          return new Response("WebSocket origin did not upgrade", { status: originResponse.status, headers: originResponse.headers });
        }
        originSocket.accept();

        // 基本的消息、关闭、错误处理和双向绑定
        originSocket.addEventListener('message', event => {
          if (serverWs.readyState === WebSocket.OPEN) serverWs.send(event.data);
        });
        serverWs.addEventListener('message', event => {
          if (originSocket.readyState === WebSocket.OPEN) originSocket.send(event.data);
        });

        const commonCloseHandler = (event, side) => {
          // console.log(`${side} WebSocket closed: ${event.code} ${event.reason}`);
          if (side === 'origin' && serverWs.readyState === WebSocket.OPEN) serverWs.close(event.code, event.reason);
          if (side === 'client' && originSocket.readyState === WebSocket.OPEN) originSocket.close(event.code, event.reason);
        };
        const commonErrorHandler = (event, side) => {
          // console.error(`${side} WebSocket error:`, event);
          if (side === 'origin' && serverWs.readyState === WebSocket.OPEN) serverWs.close(1011, "Origin WebSocket error");
          if (side === 'client' && originSocket.readyState === WebSocket.OPEN) originSocket.close(1011, "Client WebSocket error");
        };

        originSocket.addEventListener('close', event => commonCloseHandler(event, 'origin'));
        serverWs.addEventListener('close', event => commonCloseHandler(event, 'client'));
        originSocket.addEventListener('error', event => commonErrorHandler(event, 'origin'));
        serverWs.addEventListener('error', event => commonErrorHandler(event, 'client'));

        const responseHeaders = new Headers();
        if (originResponse.headers.has('sec-websocket-protocol')) {
            responseHeaders.set('sec-websocket-protocol', originResponse.headers.get('sec-websocket-protocol'));
        }

        return new Response(null, { status: 101, webSocket: clientWs, headers: responseHeaders });
      } catch (e) {
        serverWs.close(1011, "WebSocket proxy connection error");
        return new Response(`WebSocket Proxy Error: ${e.message}`, { status: 502 });
      }
    } else {
      // 处理普通 HTTP 请求
      try {
        const response = await fetch(targetRequestUrl, {
          method: request.method,
          headers: originRequestHeaders, // 使用修改过的最简请求头
          body: request.body,
          redirect: 'follow', // 与 Deno 脚本一致
        });

        // 对响应头做最小修改，主要是透传，根据需要添加基础CORS
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set('Access-Control-Allow-Origin', '*'); // 基础CORS
        // **不添加**强制缓存，**不删除**CSP等安全头部

        return new Response(response.body, {
          status: response.status,
          headers: responseHeaders,
        });
      } catch (e) {
        console.error(`HTTP Fetch Error: ${e.message}`);
        return new Response(`HTTP Proxy Error: ${e.message}`, {status: 502});
      }
    }
  }
};

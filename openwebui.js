export default {
  async fetch(request, env, ctx) {
    const targetBaseUrl = "https://libabaasdasd21312asda-web.hf.space"; // 您的目标后端服务地址
    const originalUrl = new URL(request.url);

    // 构建指向目标服务器的完整 URL
    const targetUrl = new URL(targetBaseUrl);
    targetUrl.pathname = originalUrl.pathname;
    targetUrl.search = originalUrl.search;

    // 检查是否是 WebSocket 升级请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      // 处理 WebSocket 代理
      return proxyWebSocket(request, targetUrl.toString());
    } else {
      // 处理 HTTP/SSE 请求
      return proxyHttpRequest(request, targetUrl);
    }
  },
};

async function proxyHttpRequest(request, targetUrl) {
  const newHeaders = new Headers(request.headers);
  newHeaders.set('Host', targetUrl.hostname); // 非常重要：设置正确的目标 Host

  // 如果需要，可以在这里添加或修改其他头部
  // newHeaders.set('X-Custom-Header', 'value');

  let response;
  try {
    response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: newHeaders,
      body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
      redirect: 'manual', // 通常代理需要手动处理或传递重定向
    });

    // 重新创建响应以允许修改头部（例如，添加 CORS 或自定义头部）
    const responseHeaders = new Headers(response.headers);

    // 示例：为特定 SSE 端点确保正确的头部 (请按需调整路径)
    // 您需要知道确切的 SSE 端点路径来应用这些规则
    // const sseEndpointPath = '/api/chat'; // 假设这是您的 SSE 端点
    // if (targetUrl.pathname.startsWith(sseEndpointPath) && response.headers.get('content-type')?.includes('text/event-stream')) {
    //   responseHeaders.set('Cache-Control', 'no-cache');
    //   responseHeaders.set('Connection', 'keep-alive');
    // }

    // 示例：添加通用的 CORS 头部（生产环境中请谨慎配置，不要总是用 "*"）
    // responseHeaders.set('Access-Control-Allow-Origin', '*');
    // responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    // responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');


    // 如果原始响应是重定向，并且你想让客户端处理它
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        // 直接返回原始重定向，或者修改 location (如果代理本身在不同路径下)
        return new Response(null, {
            status: response.status,
            headers: responseHeaders // 包含 location 的头部
        });
    }

    // 构建最终响应
    // 对于 SSE，response.body 应该是一个 ReadableStream，这样可以流式传输
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (e) {
    console.error('CF Worker HTTP Proxy fetch error:', e);
    // 可以根据错误类型返回更具体的错误信息
    if (e.message.includes('Failed to connect')) {
        return new Response('Proxy error: Could not connect to target service at ' + targetUrl.hostname, { status: 502 });
    }
    return new Response('Proxy error: An unexpected error occurred.', { status: 500 });
  }
}

async function proxyWebSocket(request, targetUrlString) {
  // Cloudflare Worker 中的 WebSocket 代理需要直接建立 TCP 连接的能力，
  // 或者利用特定的 fetch API 来升级连接。
  // 标准的 fetch(request) 不会直接代理 WebSocket。

  // 创建一个到目标服务器的 WebSocket 连接请求。
  // 注意：目标URL需要是 ws:// 或 wss://
  const targetWsUrl = new URL(targetUrlString);
  targetWsUrl.protocol = targetWsUrl.protocol.replace('http', 'ws'); // http -> ws, https -> wss

  // Cloudflare Workers 中代理 WebSocket 的标准方法是：
  // 当 worker 收到一个 WebSocket 升级请求时，它自己也发起一个到源的 WebSocket 请求，
  // 然后将这两个 WebSocket 连接起来。

  // 但是，直接从 Worker `Workspace` 一个 `ws(s)://` URL 来建立 WebSocket 连接并将其响应
  // 直接返回给客户端的 `Upgrade: websocket` 请求是不行的。
  // 正确的方式是，如果客户端发起了 WebSocket 升级请求，
  // Worker 需要接受这个升级，并同时建立到后端的 WebSocket 连接，然后双向传递数据。
  // 这通常通过 `Response.webSocket` 和 `Workspace` 的 `upgrade` 选项（如果后端支持）
  // 或者直接创建 WebSocket 对象来实现。

  // 更简单且推荐的做法是，如果源服务器支持 WebSocket，
  // 并且 Cloudflare 域名设置中启用了 WebSockets（通常默认启用），
  // Cloudflare 通常会自动处理 WebSocket 的代理，只要请求能正确到达源服务器。
  // Worker 在这里可能不需要做特别复杂的 WebSocket 管道操作，
  // 除非你需要拦截或修改 WebSocket 消息。

  // 对于简单的 WebSocket 直通代理，Cloudflare 通常自己就能处理好。
  // 如果需要 Worker 介入（例如，修改头部、认证），则会更复杂。

  // 以下是一个尝试性的直通（如果 Cloudflare 允许 worker fetch ws）：
  // **注意：这种直接 fetch ws 的方式在很多环境中可能不被支持或行为不符合预期。
  // Cloudflare 更推荐的是 Worker 返回一个特殊的 Response 来指示 Runtime 建立 WebSocket 连接。

  // 正确的处理方式是检查头部，如果 'Upgrade' 是 'websocket'，
  // Cloudflare Runtime 会期望一个包含 server-side WebSocket 的 Response 对象。
  // ref: https://developers.cloudflare.com/workers/examples/websockets/
  // 我们需要创建一个 WebSocketPair，并将其中一个 socket 返回给客户端，另一个连接到源。

  const { readable, writable } = new TransformStream();

  // 尝试连接到源 WebSocket
  let originResponse;
  try {
    originResponse = await fetch(targetWsUrl.toString(), {
      headers: {
        'Upgrade': 'websocket',
        'Host': targetWsUrl.hostname,
        // 复制一些可能相关的原始请求头部
        'Sec-WebSocket-Key': request.headers.get('Sec-WebSocket-Key'),
        'Sec-WebSocket-Version': request.headers.get('Sec-WebSocket-Version'),
        'Sec-WebSocket-Protocol': request.headers.get('Sec-WebSocket-Protocol'),
        'User-Agent': request.headers.get('User-Agent'),
        // 根据需要添加其他头部，如认证
      },
    });
  } catch (e) {
    console.error("CF Worker WebSocket origin connection error:", e);
    return new Response("WebSocket origin connection error: " + e.message, { status: 502 });
  }


  if (!originResponse.webSocket) {
    // 如果源服务器没有成功升级到 WebSocket
    console.error("CF Worker WebSocket origin did not upgrade. Status: " + originResponse.status);
    let bodyText = "WebSocket origin did not upgrade. Status: " + originResponse.status;
    try {
        bodyText += " Body: " + await originResponse.text();
    } catch (err) { /* ignore if body already used or empty */ }
    return new Response(bodyText, { status: originResponse.status, statusText: originResponse.statusText, headers: originResponse.headers });
  }

  // 我们有了从源服务器来的 WebSocket (originResponse.webSocket)
  // 和一个到客户端的管道 (readable, writable)
  // 现在需要将它们连接起来
  const originSocket = originResponse.webSocket;

  // 当客户端 WebSocket 打开时，开始监听源 WebSocket
  originSocket.accept(); // 必须调用 accept

  // 双向数据流
  // 客户端 -> 源
  request.body
    .pipeTo(originSocket.writable)
    .catch(err => {
      console.error('Error piping client to origin WebSocket:', err);
      // 根据需要关闭 originSocket 或进行其他清理
      // originSocket.close(1011, "Client pipe error");
    });

  // 源 -> 客户端
  originSocket.readable
    .pipeTo(writable)
    .catch(err => {
      console.error('Error piping origin to client WebSocket:', err);
      // 根据需要关闭 writable 或进行其他清理
    });

  // 返回给客户端的响应，这将完成客户端的 WebSocket 升级
  return new Response(readable, {
    status: 101, // Switching Protocols
    webSocket: originSocket, // 将源 socket 交给 runtime 来处理与客户端的连接
                            // 这实际上是不正确的，应该将 `client` socket (WebSocketPair 的一部分) 返回
  });

  // --- 正确的 WebSocket 代理方法 (使用 WebSocketPair) ---
  // 上面的方法尝试直接使用 fetch 返回的 webSocket，这可能不完全符合 Worker 的模式。
  // Cloudflare 推荐的模式是创建一个 WebSocketPair。

  // 创建一个 WebSocket 对
  // let [client, server] = Object.values(new WebSocketPair()); // 旧的语法
  const webSocketPair = new WebSocketPair();
  const client = webSocketPair[0];
  const server = webSocketPair[1];


  // 将 server-side 的 WebSocket (server) 连接到源服务器
  // 我们需要将 server 的事件转发到真正的源 WebSocket，反之亦然
  server.accept(); // 接受来自 Worker runtime 的连接

  fetch(targetWsUrl.toString(), {
    headers: {
      'Upgrade': 'websocket',
      'Host': targetWsUrl.hostname,
      'Sec-WebSocket-Key': request.headers.get('Sec-WebSocket-Key'),
      'Sec-WebSocket-Version': request.headers.get('Sec-WebSocket-Version'),
      'Sec-WebSocket-Protocol': request.headers.get('Sec-WebSocket-Protocol'),
      'User-Agent': request.headers.get('User-Agent'),
      // 根据需要添加其他头部，如认证
      // 注意：一些头部（如CF自带的CF-Connecting-IP）会被自动添加
    }
  }).then(async originWsResponse => {
    if (!originWsResponse.webSocket) {
      console.error("CF Worker WebSocket origin did not upgrade (WebSocketPair method). Status: " + originWsResponse.status);
      let errorBody = "WebSocket origin did not upgrade (WebSocketPair method). Status: " + originWsResponse.status;
      try {
        errorBody += " Body: " + await originWsResponse.text();
      } catch(e){}
      server.send(JSON.stringify({ error: errorBody }));
      server.close(1011, "Origin did not upgrade");
      return;
    }

    const originTrueSocket = originWsResponse.webSocket;
    originTrueSocket.accept(); // 接受来自源的连接

    // 双向数据流绑定
    // server (连接到客户端) <-> originTrueSocket (连接到源)

    originTrueSocket.addEventListener('message', event => {
      try {
        server.send(event.data);
      } catch (e) {
        console.error("Error sending origin message to client via server socket:", e);
      }
    });

    server.addEventListener('message', event => {
      try {
        originTrueSocket.send(event.data);
      } catch (e) {
        console.error("Error sending client message to origin via originTrueSocket:", e);
      }
    });

    const closeHandler = (event) => {
        const code = event.code || 1000;
        const reason = event.reason || "Connection closed";
        if (!originTrueSocket.readyState || originTrueSocket.readyState === WebSocket.OPEN || originTrueSocket.readyState === WebSocket.CONNECTING) {
            originTrueSocket.close(code, reason);
        }
        if (!server.readyState || server.readyState === WebSocket.OPEN || server.readyState === WebSocket.CONNECTING) {
            server.close(code, reason);
        }
    };

    originTrueSocket.addEventListener('close', closeHandler);
    server.addEventListener('close', closeHandler);
    originTrueSocket.addEventListener('error', event => {
        console.error('Origin WebSocket error:', event);
        server.close(1011, "Origin WebSocket error");
    });
    server.addEventListener('error', event => {
        console.error('Client-side Worker WebSocket error:', event);
        if (originTrueSocket.readyState === WebSocket.OPEN) {
          originTrueSocket.close(1011, "Client-side Worker WebSocket error");
        }
    });

  }).catch(e => {
    console.error("CF Worker WebSocketPair: Error connecting to origin WebSocket:", e);
    server.send(JSON.stringify({ error: "Failed to connect to origin WebSocket: " + e.message }));
    server.close(1002, "Proxy connection error");
  });

  // 返回 client-side 的 WebSocket 给 runtime，它会连接到用户的浏览器
  return new Response(null, {
    status: 101, // Switching Protocols
    webSocket: client, // 将 client 端给 runtime
  });
}

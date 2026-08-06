// 极简 LSP 服务器,供 lsp.test.ts 端到端测试客户端与管理器。
//
// 行为:initialize 正常握手(顺带发一个 workspace/configuration 反向请求,
// 验证客户端会应答而不是卡死);didOpen/didChange 后按内容发布诊断——
// 每行的 "BUG" 标记发一条 error,"WARN" 标记发一条 warning,干净内容
// 发布空数组。shutdown/exit 按协议退出。
//
// 内容里的几个标记用来触发特定路径:
//   LATE   先发一个空批次,80ms 后才发真正的诊断(rust-analyzer/gopls 的做法)
//   DIE    收到同步通知后直接退出进程(模拟半路死掉的服务器)
//   LANGID 把收到的 languageId 原样放进一条 error 的 message 里
let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const length = Number(/content-length:\s*(\d+)/i.exec(header)[1]);
    const total = headerEnd + 4 + length;
    if (buffer.length < total) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, total).toString('utf8'));
    buffer = buffer.subarray(total);
    handle(message);
  }
});

function send(message) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

const languageIds = new Map();

function publish(uri, version, text) {
  if (text.includes('DIE')) {
    process.exit(1);
  }
  const diagnostics = [];
  if (text.includes('LANGID')) {
    diagnostics.push({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 1,
      message: `languageId=${languageIds.get(uri)}`,
    });
  }
  text.split('\n').forEach((line, i) => {
    const bug = line.indexOf('BUG');
    if (bug !== -1) {
      diagnostics.push({
        range: { start: { line: i, character: bug }, end: { line: i, character: bug + 3 } },
        severity: 1,
        source: 'fake',
        code: 'E001',
        message: 'found BUG marker',
      });
    }
    const warn = line.indexOf('WARN');
    if (warn !== -1) {
      diagnostics.push({
        range: { start: { line: i, character: warn }, end: { line: i, character: warn + 4 } },
        severity: 2,
        source: 'fake',
        message: 'found WARN marker',
      });
    }
    // 客户端应当过滤掉 info/hint——每行都塞一条 hint 验证这一点。
    diagnostics.push({
      range: { start: { line: i, character: 0 }, end: { line: i, character: 0 } },
      severity: 4,
      message: 'noise hint',
    });
  });
  if (text.includes('LATE')) {
    // 先空后实:客户端若在第一批空诊断上就收工,就会把有错报成干净。
    send({ method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics: [] } });
    setTimeout(() => {
      send({ method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics } });
    }, 80);
    return;
  }
  send({ method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics } });
}

function handle(message) {
  if (message.method === 'initialize') {
    send({ id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
    // 反向请求:客户端不应答的话,真实服务器会停在这里等。
    send({ id: 9999, method: 'workspace/configuration', params: { items: [{}] } });
  } else if (message.method === 'textDocument/didOpen') {
    const doc = message.params.textDocument;
    languageIds.set(doc.uri, doc.languageId);
    publish(doc.uri, doc.version, doc.text);
  } else if (message.method === 'textDocument/didChange') {
    publish(
      message.params.textDocument.uri,
      message.params.textDocument.version,
      message.params.contentChanges[0].text,
    );
  } else if (message.method === 'shutdown') {
    send({ id: message.id, result: null });
  } else if (message.method === 'exit') {
    process.exit(0);
  }
}

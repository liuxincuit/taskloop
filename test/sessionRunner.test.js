const test = require('node:test');
const assert = require('node:assert');
const { runTask, resolveModel, summarizeToolArgs } = require('../src/sessionRunner.js');

// 构造一个可控的假 session：prompt 期间按脚本触发事件
function makeMockSession(options = {}) {
  const {
    deltas = [],
    text = '',
    promptError = null,
    messageError = '',
    toolCalls = [],
    onAbort = null,
  } = options;

  const calls = { prompt: 0, abort: 0, dispose: 0 };
  let listener = null;

  const session = {
    prompt: async () => {
      calls.prompt += 1;
      await options.beforePrompt?.();
      for (const call of toolCalls) {
        listener?.({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.args });
        listener?.({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, isError: call.isError === true });
      }
      for (const delta of deltas) {
        listener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
      }
      if (messageError) {
        listener?.({ type: 'message_end', message: { errorMessage: messageError } });
      }
      if (promptError) throw promptError;
    },
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    abort: async () => {
      calls.abort += 1;
      listener?.({ type: 'agent_settled', aborted: true });
      await onAbort?.();
    },
    dispose: () => { calls.dispose += 1; },
    getLastAssistantText: () => text,
  };

  return { session, calls };
}

test('runTask：成功路径返回 success、文本与会话文件，并销毁会话', async () => {
  const { session, calls } = makeMockSession({ text: '已完成' });
  const result = await runTask('do it', {
    createSession: () => ({ session, sessionFile: '/tmp/s.jsonl' }),
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.text, '已完成');
  assert.strictEqual(result.sessionFile, '/tmp/s.jsonl');
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(calls.prompt, 1);
  assert.strictEqual(calls.dispose, 1);
});

test('runTask：prompt 抛错时返回 failed 且带回原因，仍然销毁会话', async () => {
  const { session, calls } = makeMockSession({ promptError: new Error('模型不可用') });
  const result = await runTask('do it', { createSession: () => session });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /模型不可用/);
  assert.strictEqual(calls.dispose, 1);
});

test('runTask：模型错误通过 message_end 上报时同样判为失败', async () => {
  const { session } = makeMockSession({ messageError: '401 凭据无效' });
  const result = await runTask('do it', { createSession: () => session });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /401/);
});

test('runTask：会话创建失败时返回 failed 而不是抛出', async () => {
  const result = await runTask('do it', {
    createSession: () => { throw new Error('资源加载失败'); },
  });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /资源加载失败/);
});

test('runTask：未返回 session 时判为失败', async () => {
  const result = await runTask('do it', { createSession: () => ({}) });
  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /未返回可用的 session/);
});

test('runTask：中止时调用 session.abort() 并标记为 aborted 而非 failed', async () => {
  const { session, calls } = makeMockSession({
    beforePrompt: () => new Promise((resolve) => setTimeout(resolve, 20)),
  });
  const controller = new AbortController();

  const pending = runTask('do it', {
    createSession: () => session,
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 5);
  const result = await pending;

  assert.strictEqual(result.status, 'aborted');
  assert.strictEqual(calls.abort, 1);
  assert.strictEqual(calls.dispose, 1);
});

test('runTask：传入已中止的 signal 时立刻请求中止', async () => {
  const { session, calls } = makeMockSession();
  const controller = new AbortController();
  controller.abort();

  const result = await runTask('do it', { createSession: () => session, signal: controller.signal });

  assert.strictEqual(result.status, 'aborted');
  assert.ok(calls.abort >= 1);
});

test('runTask：200 个文本增量合并后的事件数远小于 200，且拼接内容与原文一致', async () => {
  const deltas = Array.from({ length: 200 }, (_, i) => `第${i}段`);
  const { session } = makeMockSession({ deltas });
  const events = [];

  const result = await runTask('do it', {
    createSession: () => session,
    onEvent: (e) => events.push(e),
    flushIntervalMs: 1000, // 长于执行时间，验证结束时强制 flush
  });

  const textEvents = events.filter((e) => e.type === 'text');
  assert.strictEqual(result.status, 'success');
  assert.ok(textEvents.length < 20, `应合并为少量事件，实际 ${textEvents.length}`);
  assert.strictEqual(textEvents.map((e) => e.text).join(''), deltas.join(''));
});

test('runTask：间隔超过时间窗时按批推送多段文本', async () => {
  // 用一个可控门控让 prompt 停在中间，避免与内部 subscribe 的时序竞争
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const { session } = makeMockSession({ beforePrompt: () => gate });
  const events = [];

  let listenerRef = null;
  const originalSubscribe = session.subscribe;
  session.subscribe = (fn) => { listenerRef = fn; return originalSubscribe(fn); };

  const pending = runTask('do it', {
    createSession: () => session,
    onEvent: (e) => events.push(e),
    flushIntervalMs: 5,
  });

  // 等 subscribe 真的完成，再插入间隔超过时间窗的两段增量
  const startWait = Date.now();
  while (listenerRef === null) {
    if (Date.now() - startWait > 2000) throw new Error('等待 subscribe 超时');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  listenerRef({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'A' } });
  await new Promise((resolve) => setTimeout(resolve, 25));
  listenerRef({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'B' } });

  release();
  await pending;

  const textEvents = events.filter((e) => e.type === 'text');
  assert.ok(textEvents.length >= 2, `应有至少两次刷新，实际 ${textEvents.length}`);
  assert.strictEqual(textEvents.map((e) => e.text).join(''), 'AB');
});

test('runTask：工具调用产生成对的 start/end 事件并携带参数摘要', async () => {
  const { session } = makeMockSession({
    toolCalls: [
      { id: 'c1', name: 'bash', args: { command: 'npm test' } },
      { id: 'c2', name: 'read', args: { path: 'src/app.js' }, isError: true },
    ],
  });
  const events = [];

  await runTask('do it', {
    createSession: () => session,
    onEvent: (e) => events.push(e),
  });

  const tools = events.filter((e) => e.type === 'tool');
  assert.deepStrictEqual(
    tools.map((t) => [t.phase, t.name, t.arg ?? t.ok]),
    [
      ['start', 'bash', 'npm test'],
      ['end', 'bash', true],
      ['start', 'read', 'src/app.js'],
      ['end', 'read', false],
    ]
  );
});

test('runTask：事件监听器抛错不影响任务完成', async () => {
  const { session } = makeMockSession({ text: 'ok' });
  const result = await runTask('do it', {
    createSession: () => session,
    onEvent: () => { throw new Error('监听器炸了'); },
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.text, 'ok');
});

test('resolveModel：支持 provider/modelId 写法', async () => {
  const fake = { provider: 'p', id: 'm' };
  const runtime = { getModel: (p, i) => (p === 'p' && i === 'm' ? fake : undefined), getModels: () => [fake] };
  assert.strictEqual(await resolveModel('p/m', runtime), fake);
});

test('resolveModel：只写 modelId 时在全量模型中唯一匹配', async () => {
  const fake = { provider: 'p', id: 'm' };
  const runtime = { getModel: () => undefined, getModels: () => [{ provider: 'x', id: 'other' }, fake] };
  assert.strictEqual(await resolveModel('m', runtime), fake);
});

test('resolveModel：多个提供方同名时报错要求补全 provider', async () => {
  const runtime = {
    getModel: () => undefined,
    getModels: () => [{ provider: 'a', id: 'm' }, { provider: 'b', id: 'm' }],
  };
  await assert.rejects(() => resolveModel('m', runtime), /多个提供方.*provider\/m/s);
});

test('resolveModel：空值返回 undefined（交给 SDK 使用默认模型）', async () => {
  assert.strictEqual(await resolveModel(''), undefined);
  assert.strictEqual(await resolveModel(undefined), undefined);
});

test('summarizeToolArgs：shell 类工具取 command，文件类取 path，取不到时退化为 JSON', () => {
  assert.strictEqual(summarizeToolArgs('bash', { command: 'npm test' }), 'npm test');
  assert.strictEqual(summarizeToolArgs('read', { path: 'a/b.js' }), 'a/b.js');
  assert.strictEqual(summarizeToolArgs('weird', { foo: 'bar' }), '{"foo":"bar"}');
  assert.strictEqual(summarizeToolArgs('bash', null), '');
  assert.ok(summarizeToolArgs('bash', { command: 'x'.repeat(500) }).endsWith('…'));
});

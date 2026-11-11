const DEFAULT_FLUSH_INTERVAL_MS = 100;
const MAX_TOOL_ARG_LENGTH = 200;
const MAX_ERROR_LENGTH = 800;

// SDK 是 ESM-only，本项目是 CommonJS：用动态 import 桥接并缓存结果，
// 避免每个任务都重新走一次模块解析
let sdkPromise = null;
function loadSdk() {
  sdkPromise ??= import('@earendil-works/pi-coding-agent');
  return sdkPromise;
}

// config 里的 model 支持 "provider/modelId" 与 "modelId" 两种写法。
// 只写 modelId 且多个提供方都有同名模型时要求补全，避免静默选错。
async function resolveModel(spec, modelRuntime) {
  if (!spec) return undefined;
  const rt = modelRuntime ?? (await (await loadSdk()).ModelRuntime.create());
  const slash = spec.indexOf('/');
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    const id = spec.slice(slash + 1);
    const found = rt.getModel(provider, id);
    if (!found) throw new Error(`找不到模型 ${spec}`);
    return found;
  }
  const matched = rt.getModels().filter((m) => m.id === spec);
  if (matched.length === 0) throw new Error(`找不到模型 ${spec}`);
  if (matched.length > 1) {
    const providers = matched.map((m) => m.provider).join(', ');
    throw new Error(`模型 ${spec} 存在于多个提供方（${providers}），请写成 provider/${spec}`);
  }
  return matched[0];
}

// 工具调用的参数摘要：优先取人类可读的单个字段，取不到再退化为 JSON 截断
function summarizeToolArgs(toolName, args) {
  if (!args || typeof args !== 'object') return '';
  const pick = (keys) => {
    for (const key of keys) {
      if (typeof args[key] === 'string' && args[key].length > 0) return args[key];
    }
    return '';
  };
  const isShell = /^(bash|powershell|powerShell|shell|sh)$/i.test(String(toolName || ''));
  let text = isShell
    ? pick(['command', 'cmd', 'script'])
    : pick(['path', 'filePath', 'file_path', 'url', 'query', 'pattern', 'command']);
  if (!text) {
    try {
      text = JSON.stringify(args);
    } catch {
      text = '';
    }
  }
  return text.length > MAX_TOOL_ARG_LENGTH ? `${text.slice(0, MAX_TOOL_ARG_LENGTH)}…` : text;
}

// 文本增量按时间窗合并：SDK 逐 token 推送，一个任务可能产生数万条，
// 直接转发会让浏览器与服务端都饱和
function createTextMerger(emit, intervalMs) {
  let buffer = '';
  let timer = null;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const text = buffer;
    buffer = '';
    emit({ type: 'text', text });
  }

  function push(delta) {
    buffer += delta;
    if (timer) return;
    timer = setTimeout(flush, intervalMs);
    // 进程可能因为等待该定时器而不退出
    timer.unref?.();
  }

  return { push, flush };
}

// 单个扩展加载失败不应让整个任务失败：把工厂包一层，异常降级为一条警告
function guardExtension(name, factory, emit) {
  return (pi) => {
    try {
      factory(pi);
    } catch (err) {
      emit({ type: 'log', level: 'warn', message: `扩展 ${name} 初始化失败: ${err.message}` });
    }
  };
}

// SDK 默认不加载 CLI 的内置扩展（codemode / tool_search / MCP），
// 而用户的 settings.json 可能已把 codemode 写进 defaultTools，必须在此补齐
function createResourceLoader(sdk, { cwd, agentDir, emit }) {
  const factories = [];
  if (typeof sdk.createCodemodeExtension === 'function') {
    factories.push(guardExtension('codemode', sdk.createCodemodeExtension(), emit));
  }
  if (typeof sdk.createToolSearchExtension === 'function') {
    factories.push(guardExtension('tool_search', sdk.createToolSearchExtension(), emit));
  }
  if (typeof sdk.createMcpExtension === 'function') {
    factories.push(guardExtension('mcp', sdk.createMcpExtension(), emit));
  }
  return new sdk.DefaultResourceLoader({ cwd, agentDir, extensionFactories: factories });
}

// 默认实现：走真实的 pi SDK。测试通过 options.createSession 注入替身
async function defaultCreateSession(options, emit) {
  const sdk = await loadSdk();
  // 必须显式给 agentDir：SDK 在 Windows 上会对 undefined 调用路径规范化并崩溃
  const agentDir = options.agentDir ?? sdk.getAgentDir();
  const modelRuntime = await sdk.ModelRuntime.create();
  const model = await resolveModel(options.model, modelRuntime);
  const resourceLoader = createResourceLoader(sdk, {
    cwd: options.cwd,
    agentDir,
    emit,
  });

  try {
    await resourceLoader.reload();
  } catch (err) {
    emit({ type: 'log', level: 'warn', message: `资源加载失败，按默认资源继续: ${err.message}` });
  }

  const sessionManager = options.sessionDir
    ? sdk.SessionManager.create(options.cwd, options.sessionDir)
    : undefined;

  const created = await sdk.createAgentSession({
    cwd: options.cwd,
    agentDir,
    model,
    thinkingLevel: options.thinking,
    modelRuntime,
    resourceLoader,
    sessionManager,
  });

  if (created.modelFallbackMessage) {
    emit({ type: 'log', level: 'warn', message: created.modelFallbackMessage });
  }

  return {
    session: created.session,
    sessionFile: sessionManager?.getSessionFile?.(),
  };
}

/**
 * 执行一个任务。
 *
 * 返回值 status 三态：success / failed / aborted。
 * outcome 不使用子进程退出码——agent 现在跑在同一进程里。
 */
async function runTask(prompt, options = {}) {
  const {
    cwd,
    agentDir,
    model,
    thinking,
    sessionDir,
    onEvent = () => {},
    createSession,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    signal,
  } = options;

  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // 监听器异常不能影响任务执行
    }
  };
  const merger = createTextMerger(emit, flushIntervalMs);

  let session;
  let sessionFile;
  let aborted = false;
  let failure = null;
  let lastError = '';

  const requestAbort = () => {
    aborted = true;
    // abort 是异步的，且可能在 session 尚未建立时被调用
    Promise.resolve(session?.abort?.()).catch(() => {});
  };

  try {
    const factory = createSession ?? ((opts) => defaultCreateSession(opts, emit));
    const created = await factory({ cwd, agentDir, model, thinking, sessionDir });
    session = created?.session ?? created;
    sessionFile = created?.sessionFile;

    if (!session || typeof session.prompt !== 'function') {
      throw new Error('会话创建失败：未返回可用的 session');
    }

    if (signal) {
      if (signal.aborted) requestAbort();
      else signal.addEventListener('abort', requestAbort, { once: true });
    }

    const unsubscribe = session.subscribe((event) => {
      if (!event || typeof event.type !== 'string') return;

      if (event.type === 'message_update') {
        const delta = event.assistantMessageEvent;
        if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
          merger.push(delta.delta);
        }
        return;
      }

      if (event.type === 'message_end') {
        // 模型层错误通过消息携带，prompt() 本身不一定 reject
        if (event.message?.errorMessage) lastError = event.message.errorMessage;
        return;
      }

      if (event.type === 'tool_execution_start') {
        // 先刷出已累积的文本，保证"说的话"与"做的事"的先后顺序
        merger.flush();
        emit({
          type: 'tool',
          phase: 'start',
          id: event.toolCallId,
          name: event.toolName,
          arg: summarizeToolArgs(event.toolName, event.args),
        });
        return;
      }

      if (event.type === 'tool_execution_end') {
        emit({
          type: 'tool',
          phase: 'end',
          id: event.toolCallId,
          name: event.toolName,
          ok: event.isError !== true,
          durationMs: event.durationMs,
        });
        return;
      }

      if (event.type === 'turn_start') {
        merger.flush();
        emit({ type: 'turn', phase: 'start' });
        return;
      }

      if (event.type === 'turn_end') {
        merger.flush();
        emit({ type: 'turn', phase: 'end' });
        return;
      }

      if (event.type === 'agent_settled' && event.aborted) {
        aborted = true;
      }
    });

    try {
      await session.prompt(prompt);
    } catch (err) {
      failure = err;
    } finally {
      merger.flush();
      if (typeof unsubscribe === 'function') unsubscribe();
    }

    const text = typeof session.getLastAssistantText === 'function'
      ? session.getLastAssistantText() ?? ''
      : '';

    if (lastError && !failure) failure = new Error(lastError);

    let status = 'success';
    if (aborted) status = 'aborted';
    else if (failure) status = 'failed';

    return {
      status,
      text,
      sessionFile,
      error: failure ? String(failure.message ?? failure).slice(0, MAX_ERROR_LENGTH) : undefined,
    };
  } catch (err) {
    merger.flush();
    const message = String(err?.message ?? err).slice(0, MAX_ERROR_LENGTH);
    return {
      status: 'failed',
      text: '',
      sessionFile,
      error: message,
    };
  } finally {
    try {
      session?.dispose?.();
    } catch {
      // 销毁失败不应覆盖执行结果
    }
  }
}

module.exports = {
  runTask,
  loadSdk,
  resolveModel,
  summarizeToolArgs,
  createTextMerger,
  DEFAULT_FLUSH_INTERVAL_MS,
};

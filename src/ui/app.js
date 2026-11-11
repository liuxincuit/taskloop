/* taskloop 页面：SSE 实时进度 + 控制 + 配置表单 */
(function () {
  'use strict';

  var STATUS_TEXT = {
    success: '完成',
    failed: '失败',
    aborted: '已中止',
    interrupted: '已中断',
    running: '执行中',
  };

  var STATUS_CLASS = {
    success: 'task-block__state--done',
    failed: 'task-block__state--fail',
    aborted: 'task-block__state--fail',
    interrupted: 'task-block__state--fail',
    running: 'task-block__state--run',
  };

  var state = {
    snapshot: null,
    rounds: [],
    tasks: new Map(),
    connection: 'connecting',
  };

  var el = {
    dot: document.getElementById('dot'),
    statusText: document.getElementById('statusText'),
    countdown: document.getElementById('countdown'),
    controls: document.getElementById('controls'),
    banner: document.getElementById('banner'),
    rulesPane: document.getElementById('rulesPane'),
    rulesHead: document.getElementById('rulesHead'),
    stream: document.getElementById('stream'),
    idle: document.getElementById('idle'),
    cfgBody: document.getElementById('cfgBody'),
    viewProgress: document.getElementById('view-progress'),
    viewConfig: document.getElementById('view-config'),
  };

  var confirmStopTimer = null;

  // ---------- 工具函数 ----------

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function clock(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    if (m >= 60) return Math.floor(m / 60) + ':' + pad(m % 60) + ':' + pad(s);
    return m + ':' + pad(s);
  }

  function hhmmss(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function banner(message) {
    if (!message) {
      el.banner.hidden = true;
      el.banner.textContent = '';
      return;
    }
    el.banner.hidden = false;
    el.banner.textContent = message;
  }

  async function api(method, path, body) {
    var init = { method: method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    var res = await fetch(path, init);
    var text = await res.text();
    var data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  // ---------- 视图切换 ----------

  var navButtons = document.querySelectorAll('.nav-btn');

  function showView(name) {
    if (name !== 'config') name = 'progress';
    el.viewProgress.hidden = name !== 'progress';
    el.viewConfig.hidden = name !== 'config';
    navButtons.forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.view === name);
    });
    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
    if (name === 'config') loadConfig();
  }

  navButtons.forEach(function (btn) {
    btn.addEventListener('click', function () { showView(btn.dataset.view); });
  });

  window.addEventListener('hashchange', function () { showView(location.hash.slice(1)); });

  // ---------- 头部与控制 ----------

  function renderHeader() {
    var snap = state.snapshot;
    var running = snap && snap.state === 'running';
    var stopping = snap && snap.state === 'stopping';

    el.dot.className = 'dot';
    if (state.connection === 'lost') {
      el.dot.classList.add('dot--halt');
      el.statusText.textContent = '连接中断';
      el.countdown.textContent = '';
    } else if (stopping) {
      el.dot.classList.add('dot--halt');
      el.statusText.textContent = '停止中';
      el.countdown.textContent = '正在中止当前任务';
    } else if (running) {
      el.dot.classList.add('dot--run');
      el.statusText.textContent = '运行中';
      el.countdown.textContent = snap.nextWakeAt
        ? '下一轮 ' + clock(Math.max(0, snap.nextWakeAt - Date.now()))
        : '';
    } else {
      el.statusText.textContent = snap ? '已停止' : '连接中';
      el.countdown.textContent = '';
    }

    renderControls();
  }

  function renderControls() {
    var snap = state.snapshot;
    var running = snap && snap.state === 'running';
    var stopping = snap && snap.state === 'stopping';

    el.controls.textContent = '';

    if (stopping) {
      var busy = document.createElement('span');
      busy.className = 'confirm';
      busy.textContent = '正在中止…';
      el.controls.appendChild(busy);
      return;
    }

    if (running) {
      var wake = document.createElement('button');
      wake.className = 'btn btn--ghost';
      wake.type = 'button';
      wake.textContent = '立即一轮';
      wake.addEventListener('click', doWake);

      var stop = document.createElement('button');
      stop.className = 'btn btn--danger';
      stop.type = 'button';
      stop.textContent = '停止';
      stop.addEventListener('click', askStop);

      el.controls.appendChild(wake);
      el.controls.appendChild(stop);
      return;
    }

    var start = document.createElement('button');
    start.className = 'btn btn--primary';
    start.type = 'button';
    start.textContent = '启动';
    start.addEventListener('click', doStart);
    el.controls.appendChild(start);
  }

  // 停止必须二次确认：就地展开，不用模态
  function askStop() {
    el.controls.textContent = '';

    var label = document.createElement('span');
    label.className = 'confirm';
    label.textContent = '确认停止？';

    var confirm = document.createElement('button');
    confirm.className = 'btn btn--danger';
    confirm.type = 'button';
    confirm.textContent = '停止';
    confirm.addEventListener('click', doStop);

    var cancel = document.createElement('button');
    cancel.className = 'btn btn--ghost';
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', function () {
      clearTimeout(confirmStopTimer);
      renderControls();
    });

    el.controls.appendChild(label);
    el.controls.appendChild(confirm);
    el.controls.appendChild(cancel);
    confirm.focus();

    clearTimeout(confirmStopTimer);
    confirmStopTimer = setTimeout(renderControls, 8000);
  }

  async function doStart() {
    banner('');
    try {
      var res = await api('POST', '/api/start');
      applySnapshot(res.state);
    } catch (err) {
      banner('启动失败：' + err.message);
    }
  }

  async function doStop() {
    clearTimeout(confirmStopTimer);
    banner('');
    try {
      state.snapshot = { ...(state.snapshot || {}), state: 'stopping' };
      renderHeader();
      renderStreamTop();
      var res = await api('POST', '/api/stop');
      applySnapshot(res.state);
    } catch (err) {
      banner('停止失败：' + err.message);
    }
  }

  async function doWake() {
    banner('');
    try {
      var res = await api('POST', '/api/wake');
      applySnapshot(res.state);
    } catch (err) {
      banner('立即执行失败：' + err.message);
    }
  }

  // 控制接口的返回值直接刷新界面：不单靠 SSE 事件，避免事件遗失时界面卡在旧状态
  function applySnapshot(snapshot) {
    if (!snapshot) return;
    state.snapshot = snapshot;
    renderHeader();
    renderRules();
    renderStreamTop();
  }

  // ---------- 左栏规则 ----------

  function renderRules() {
    var snap = state.snapshot;
    var rules = (snap && snap.rules) || [];
    var activeIndex = snap && snap.currentTask ? snap.currentTask.ruleIndex : -1;

    el.rulesHead.textContent = rules.length ? '规则 ' + rules.length : '规则';
    el.rulesPane.querySelectorAll('.rule').forEach(function (n) { n.remove(); });

    rules.forEach(function (rule, index) {
      var box = document.createElement('div');
      box.className = 'rule' + (index === activeIndex ? ' rule--active' : '');

      var name = document.createElement('div');
      name.className = 'rule__name';
      name.textContent = rule.source;
      box.appendChild(name);

      var labels = document.createElement('div');
      labels.className = 'rule__labels';
      labels.textContent = rule.labels.concat((rule.notLabels || []).map(function (l) { return '-' + l; })).join(', ');
      box.appendChild(labels);

      var count = document.createElement('div');
      if (rule.error) {
        count.className = 'rule__count rule__count--fail';
        count.textContent = '抓取失败';
      } else if (rule.candidates > 0) {
        count.className = 'rule__count';
        count.textContent = rule.candidates + ' 个候选';
      } else {
        count.className = 'rule__count rule__count--zero';
        count.textContent = '无候选';
      }
      box.appendChild(count);

      el.rulesPane.appendChild(box);
    });
  }

  // ---------- 执行流 ----------

  function getRound(number) {
    var found = state.rounds.find(function (r) { return r.round === number; });
    if (found) return found;
    var created = { round: number, startedAt: Date.now(), el: null, rules: new Map(), tasks: new Map() };
    state.rounds.push(created);
    return created;
  }

  function renderStreamTop() {
    var snap = state.snapshot;
    var showingIdle = snap && snap.state !== 'running' && snap.state !== 'stopping';

    el.stream.querySelectorAll('.round').forEach(function (n) { n.hidden = showingIdle; });
    el.idle.hidden = !showingIdle;

    if (showingIdle) renderIdle();
  }

  function renderIdle() {
    var snap = state.snapshot || {};
    var last = snap.lastRun;
    var tasks = (last && last.tasks) || (snap.history || []).slice(-8);

    el.idle.textContent = '';

    var title = document.createElement('div');
    title.className = 'idle__state';
    title.textContent = state.connection === 'lost' ? '连接中断' : '已停止';
    el.idle.appendChild(title);

    var next = document.createElement('div');
    next.className = 'idle__next';
    next.textContent = state.connection === 'lost'
      ? '正在尝试重新连接…'
      : '轮询已暂停。点右上角「启动」立即执行一轮。';
    el.idle.appendChild(next);

    if (tasks.length === 0) return;

    var box = document.createElement('div');
    box.className = 'idle__last';

    var boxTitle = document.createElement('div');
    boxTitle.className = 'idle__lasttitle';
    boxTitle.textContent = last
      ? '上一次运行 轮次 ' + last.round + ' · ' + hhmmss(last.startedAt)
      : '历史记录';
    box.appendChild(boxTitle);

    tasks.forEach(function (task) {
      var row = document.createElement('div');
      row.className = 'idle__row';

      var id = document.createElement('span');
      id.className = 'idle__rowid';
      id.textContent = task.id;

      var st = document.createElement('span');
      st.className = 'idle__rowstate';
      var status = task.status || 'running';
      st.classList.add('idle__rowstate--' + (status === 'success' ? 'done' : status === 'running' ? 'run' : 'fail'));
      st.textContent = STATUS_TEXT[status] || status;

      var clockEl = document.createElement('span');
      clockEl.className = 'idle__rowclock';
      clockEl.textContent = task.durationMs ? clock(task.durationMs) : '';

      row.appendChild(id);
      row.appendChild(st);
      row.appendChild(clockEl);

      if (task.error) {
        var why = document.createElement('span');
        why.className = 'idle__rowwhy';
        why.textContent = task.error;
        row.appendChild(why);
      }

      box.appendChild(row);
    });

    el.idle.appendChild(box);
  }

  function ensureRoundElement(round) {
    if (round.el) return round.el;

    var wrap = document.createElement('div');
    wrap.className = 'round';

    var head = document.createElement('div');
    head.className = 'round__head';

    var title = document.createElement('span');
    title.className = 'round__title round__title--now';
    title.textContent = '轮次 ' + round.round;

    var time = document.createElement('span');
    time.className = 'round__time';
    time.textContent = hhmmss(round.startedAt);

    head.appendChild(title);
    head.appendChild(time);
    wrap.appendChild(head);

    var firstRound = el.stream.querySelector('.round');
    if (firstRound) el.stream.insertBefore(wrap, firstRound);
    else el.stream.insertBefore(wrap, el.idle);

    round.el = wrap;
    return wrap;
  }

  function ensureRuleElement(round, index, label) {
    var key = index;
    if (round.rules.has(key)) return round.rules.get(key);

    var block = document.createElement('div');
    block.className = 'rule-block';

    var head = document.createElement('div');
    head.className = 'rule-block__head';

    var text = document.createElement('span');
    text.innerHTML = '规则 <b>' + esc(label) + '</b>';
    head.appendChild(text);
    block.appendChild(head);

    ensureRoundElement(round).appendChild(block);
    round.rules.set(key, { el: block, head: head, text: text });
    return round.rules.get(key);
  }

  function ensureTaskElement(round, taskId) {
    if (round.tasks.has(taskId)) return round.tasks.get(taskId);

    var block = document.createElement('div');
    block.className = 'task-block';

    var head = document.createElement('div');
    head.className = 'task-block__head';

    var id = document.createElement('span');
    id.className = 'task-block__id';
    id.textContent = taskId;

    var status = document.createElement('span');
    status.className = 'task-block__state';

    var clockEl = document.createElement('span');
    clockEl.className = 'task-block__clock';

    head.appendChild(id);
    head.appendChild(status);
    head.appendChild(clockEl);

    var body = document.createElement('div');
    body.className = 'task-block__body';

    block.appendChild(head);
    block.appendChild(body);

    ensureRoundElement(round).appendChild(block);

    var entry = { el: block, head: head, status: status, clock: clockEl, body: body, startedAt: null };
    round.tasks.set(taskId, entry);
    state.tasks.set(taskId, entry);
    return entry;
  }

  function setTaskStatus(entry, status) {
    entry.status.className = 'task-block__state';
    var cls = STATUS_CLASS[status];
    if (cls) entry.status.classList.add(cls);
    entry.status.textContent = STATUS_TEXT[status] || status;
  }

  // 连续文本合并到同一个 .say 段落，遇到工具调用就另起一段
  function appendText(entry, text) {
    var last = entry.body.lastElementChild;
    if (last && last.classList.contains('say')) {
      last.textContent += text;
      return last;
    }
    var p = document.createElement('div');
    p.className = 'say';
    p.textContent = text;
    entry.body.appendChild(p);
    return p;
  }

  function appendTool(entry, event) {
    var row = document.createElement('div');
    row.className = 'tool';

    var name = document.createElement('span');
    name.className = 'tool__name';
    name.textContent = event.name;

    var arg = document.createElement('span');
    arg.className = 'tool__arg';
    arg.textContent = event.arg || '';

    row.appendChild(name);
    row.appendChild(arg);
    row.dataset.id = event.id || '';
    entry.body.appendChild(row);
    return row;
  }

  function markToolEnd(entry, event) {
    var rows = entry.body.querySelectorAll('.tool');
    var target = null;
    for (var i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].dataset.id === String(event.id)) { target = rows[i]; break; }
    }
    if (target && event.ok === false) target.classList.add('tool--fail');
  }

  function currentRoundFor(event) {
    var number = event.round || (state.snapshot && state.snapshot.round) || 1;
    return getRound(number);
  }

  // ---------- 事件处理 ----------

  function handleEvent(name, payload) {
    switch (name) {
      case 'state': {
        state.snapshot = payload;
        renderHeader();
        renderRules();
        renderStreamTop();
        break;
      }

      case 'round': {
        var round = getRound(payload.round);
        if (payload.phase === 'start') {
          round.startedAt = payload.startedAt || Date.now();
          ensureRoundElement(round);
        }
        break;
      }

      case 'rule': {
        var r = currentRoundFor(payload);
        var block = ensureRuleElement(r, payload.index, payload.source);
        if (payload.phase === 'fail') {
          block.head.classList.add('is-fail');
          block.text.innerHTML = '规则 <b>' + esc(payload.source) + '</b> 抓取失败：' + esc(payload.error);
        } else if (payload.phase === 'empty') {
          block.text.innerHTML = '规则 <b>' + esc(payload.source) + '</b> 无候选';
        } else {
          block.text.innerHTML = '规则 <b>' + esc(payload.source) + '</b> 抓到 ' + payload.candidates + ' 个候选';
        }
        break;
      }

      case 'task': {
        var tr = currentRoundFor(payload);
        var entry = ensureTaskElement(tr, payload.taskId);
        if (payload.phase === 'start') {
          entry.startedAt = payload.startedAt || Date.now();
          entry.clock.dataset.started = String(entry.startedAt);
          // 立即算一次，不等下次定时器刷新——否则页面刚打开时执行中的任务耗时为空白
          entry.clock.textContent = clock(Date.now() - entry.startedAt);
          setTaskStatus(entry, 'running');
        } else {
          setTaskStatus(entry, payload.status);
          delete entry.clock.dataset.started;
          entry.clock.textContent = payload.durationMs ? clock(payload.durationMs) : '';
          if (payload.error) {
            var err = document.createElement('div');
            err.className = 'tool tool--fail';
            err.innerHTML = '<span class="tool__name">error</span><span class="tool__arg">' + esc(payload.error) + '</span>';
            entry.body.appendChild(err);
          }
        }
        break;
      }

      case 'agent': {
        var ar = currentRoundFor(payload);
        var target = ensureTaskElement(ar, payload.taskId);
        if (payload.type === 'text') appendText(target, payload.text);
        else if (payload.type === 'tool') {
          if (payload.phase === 'start') appendTool(target, payload);
          else markToolEnd(target, payload);
        }
        break;
      }

      case 'log':
        break;

      default:
        break;
    }
  }

  // 执行中的任务每秒刷新一次耗时
  setInterval(function () {
    var now = Date.now();
    document.querySelectorAll('[data-started]').forEach(function (node) {
      node.textContent = clock(now - Number(node.dataset.started));
    });

    if (state.snapshot && state.snapshot.state === 'running' && state.snapshot.nextWakeAt) {
      el.countdown.textContent = '下一轮 ' + clock(Math.max(0, state.snapshot.nextWakeAt - now));
    }
  }, 1000);

  // ---------- SSE ----------

  function connect() {
    var source = new EventSource('/api/events');

    source.addEventListener('open', function () {
      state.connection = 'online';
      renderHeader();
    });

    ['state', 'round', 'rule', 'task', 'agent', 'log'].forEach(function (name) {
      source.addEventListener(name, function (message) {
        var payload;
        try { payload = JSON.parse(message.data); } catch { return; }
        handleEvent(name, payload);
      });
    });

    source.addEventListener('error', function () {
      state.connection = 'lost';
      renderHeader();
      renderStreamTop();
      // EventSource 自带重连，这里只更新界面状态
    });
  }

  // ---------- 配置表单 ----------

  var cfgState = { raw: null, options: null, loaded: false, dirty: false };

  async function loadConfig() {
    if (cfgState.loaded) return;
    try {
      var data = await api('GET', '/api/config');
      cfgState.raw = data.config;
      cfgState.options = data.options;
      cfgState.loaded = true;
      renderConfig();
    } catch (err) {
      el.cfgBody.innerHTML = '<p class="banner" style="margin:0">读取配置失败：' + esc(err.message) + '</p>';
    }
  }

  function field(labelText, control, hint) {
    var wrap = document.createElement('div');
    wrap.className = 'field';

    var label = document.createElement('label');
    label.textContent = labelText;
    label.htmlFor = control.id;

    wrap.appendChild(label);
    wrap.appendChild(control);

    if (hint) {
      var aside = document.createElement('div');
      aside.className = 'field__aside';
      var p = document.createElement('p');
      p.className = 'hint';
      p.textContent = hint;
      aside.appendChild(p);
      wrap.appendChild(aside);
    }

    return wrap;
  }

  function textInput(id, value, type, placeholder) {
    var input = document.createElement('input');
    input.type = type || 'text';
    input.id = id;
    input.value = value == null ? '' : String(value);
    if (placeholder) input.placeholder = placeholder;
    if (type === 'number') { input.min = '1'; input.step = '1'; }
    return input;
  }

  function selectInput(id, values, current) {
    var select = document.createElement('select');
    select.id = id;
    values.forEach(function (value) {
      var opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      if (String(value) === String(current)) opt.selected = true;
      select.appendChild(opt);
    });
    return select;
  }

  function chipsEditor(values, placeholder, ariaLabel) {
    var wrap = document.createElement('div');
    wrap.className = 'chips';

    (values || []).forEach(function (value, index) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = value;

      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = '\u00d7';
      del.setAttribute('aria-label', '移除 ' + value);
      del.addEventListener('click', function () {
        values.splice(index, 1);
        wrap.replaceWith(chipsEditor(values, placeholder, ariaLabel));
        cfgState.dirty = true;
      });

      chip.appendChild(del);
      wrap.appendChild(chip);
    });

    var input = document.createElement('input');
    input.className = 'chip-input';
    input.placeholder = (values && values.length) ? '' : (placeholder || '输入后回车');
    // 同一条规则里有两组标签输入，没有可访问名称时人和自动化都会搞混
    if (ariaLabel) input.setAttribute('aria-label', ariaLabel);
    input.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      var value = input.value.trim();
      if (!value) return;
      if (values.indexOf(value) === -1) values.push(value);
      wrap.replaceWith(chipsEditor(values, placeholder, ariaLabel));
      cfgState.dirty = true;
    });

    wrap.appendChild(input);
    return wrap;
  }

  function renderConfig() {
    var raw = cfgState.raw || {};
    var options = cfgState.options || { sources: [], thinkingLevels: [], templates: [] };

    el.cfgBody.textContent = '';

    // 运行参数
    var runSection = document.createElement('div');
    runSection.className = 'cfg__section';

    var runTitle = document.createElement('h2');
    runTitle.className = 'cfg__title';
    runTitle.textContent = '运行';
    runSection.appendChild(runTitle);

    var runNote = document.createElement('p');
    runNote.className = 'cfg__note';
    runNote.textContent = '保存后需要重启循环才会生效。';
    runSection.appendChild(runNote);

    var intervalInput = textInput('cfg-interval', raw.intervalSeconds == null ? 60 : raw.intervalSeconds, 'number');
    runSection.appendChild(field('轮询间隔（秒）', intervalInput));

    var modelInput = textInput('cfg-model', raw.model, 'text', '留空则使用 pi 设置中的默认模型');
    runSection.appendChild(field('模型', modelInput, '写法 provider/modelId，例如 opencode-go/deepseek-v4.1-flash'));

    var thinkingValues = [''].concat(options.thinkingLevels || []);
    var thinkingSelect = selectInput('cfg-thinking', thinkingValues, raw.thinking || '');
    thinkingSelect.options[0].textContent = '（使用默认）';
    runSection.appendChild(field('推理强度', thinkingSelect));

    var workdirInput = textInput('cfg-workdir', raw.workdir, 'text', '~/.taskloop/workdir');
    runSection.appendChild(field('工作目录', workdirInput, 'agent 在这个目录里执行命令、读写文件；留空则为 ~/.taskloop/workdir'));

    var sessionInput = textInput('cfg-sessionDir', raw.sessionDir, 'text', '~/.taskloop/sessions');
    runSection.appendChild(field('会话目录', sessionInput, '每个任务的完整对话保存在这里，进度页可以回看'));

    var envInput = textInput('cfg-envFile', raw.envFile, 'text', '~/.pi/agent/.env');
    runSection.appendChild(field('环境变量文件', envInput, '模型 API key 与任务来源 token 都从这个文件读，格式 KEY=VALUE'));

    el.cfgBody.appendChild(runSection);

    // 规则
    var ruleSection = document.createElement('div');
    ruleSection.className = 'cfg__section';

    var ruleTitle = document.createElement('h2');
    ruleTitle.className = 'cfg__title';
    ruleTitle.textContent = '规则';
    ruleSection.appendChild(ruleTitle);

    var ruleNote = document.createElement('p');
    ruleNote.className = 'cfg__note';
    ruleNote.textContent = '每条规则独立抓取并过滤，命中后按顺序交给 agent 执行。';
    ruleSection.appendChild(ruleNote);

    var list = document.createElement('div');
    list.className = 'rlist';

    var rules = Array.isArray(raw.rules) ? raw.rules : [];

    rules.forEach(function (rule, index) {
      var card = document.createElement('article');
      card.className = 'rcard';

      var head = document.createElement('div');
      head.className = 'rcard__head';

      var idx = document.createElement('span');
      idx.className = 'rcard__idx';
      idx.textContent = '规则 ' + (index + 1);

      var sourceSelect = selectInput('cfg-source-' + index, options.sources || [], rule.source || 'youtrack');
      sourceSelect.addEventListener('change', function () {
        rule.source = sourceSelect.value;
        cfgState.dirty = true;
      });

      var spacer = document.createElement('span');
      spacer.className = 'rcard__spacer';

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn';
      remove.textContent = '删除';
      remove.addEventListener('click', function () {
        rules.splice(index, 1);
        renderConfig();
        cfgState.dirty = true;
      });

      head.appendChild(idx);
      head.appendChild(sourceSelect);
      head.appendChild(spacer);
      head.appendChild(remove);
      card.appendChild(head);

      var body = document.createElement('div');
      body.className = 'rcard__body';

      if (!Array.isArray(rule.labels)) rule.labels = [];
      if (!Array.isArray(rule.notLabels)) rule.notLabels = [];

      var labelsWrap = document.createElement('div');
      var labelsField = document.createElement('div');
      labelsField.className = 'field';
      var labelsLabel = document.createElement('label');
      labelsLabel.textContent = '必须包含标签';
      labelsField.appendChild(labelsLabel);
      labelsField.appendChild(chipsEditor(rule.labels, '输入后回车', '必须包含标签'));
      body.appendChild(labelsField);

      var notWrap = document.createElement('div');
      var notField = document.createElement('div');
      notField.className = 'field';
      var notLabel = document.createElement('label');
      notLabel.textContent = '排除标签';
      notField.appendChild(notLabel);
      notField.appendChild(chipsEditor(rule.notLabels, '输入后回车', '排除标签'));
      body.appendChild(notField);

      var assigneeInput = textInput('cfg-assignee-' + index, rule.assignee, 'text', 'me');
      assigneeInput.addEventListener('input', function () {
        rule.assignee = assigneeInput.value;
        cfgState.dirty = true;
      });
      var assigneeField = document.createElement('div');
      assigneeField.className = 'field';
      var assigneeLabel = document.createElement('label');
      assigneeLabel.textContent = '指派';
      assigneeField.appendChild(assigneeLabel);
      assigneeField.appendChild(assigneeInput);
      body.appendChild(assigneeField);

      var templates = options.templates || [];
      var tplValues = templates.indexOf(rule.promptTemplate) === -1 && rule.promptTemplate
        ? [rule.promptTemplate].concat(templates)
        : templates;
      var tplSelect = selectInput('cfg-tpl-' + index, tplValues.length ? tplValues : [''], rule.promptTemplate || '');
      tplSelect.addEventListener('change', function () {
        rule.promptTemplate = tplSelect.value;
        cfgState.dirty = true;
      });
      var tplField = document.createElement('div');
      tplField.className = 'field';
      var tplLabel = document.createElement('label');
      tplLabel.textContent = '提示词模板';
      tplField.appendChild(tplLabel);
      tplField.appendChild(tplSelect);
      body.appendChild(tplField);

      card.appendChild(body);
      list.appendChild(card);
    });

    ruleSection.appendChild(list);

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn--ghost';
    addBtn.textContent = '添加规则';
    addBtn.style.marginTop = '14px';
    addBtn.addEventListener('click', function () {
      rules.push({
        source: (options.sources || ['youtrack'])[0],
        labels: [],
        notLabels: [],
        assignee: 'me',
        promptTemplate: (options.templates || [''])[0],
      });
      renderConfig();
      cfgState.dirty = true;
    });
    ruleSection.appendChild(addBtn);

    el.cfgBody.appendChild(ruleSection);

    // 操作
    var actions = document.createElement('div');
    actions.className = 'cfg__actions';

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn--primary';
    saveBtn.textContent = '保存';

    var toast = document.createElement('span');
    toast.className = 'toast';
    toast.hidden = true;

    saveBtn.addEventListener('click', async function () {
      toast.hidden = true;
      try {
        var payload = JSON.parse(JSON.stringify(cfgState.raw));
        payload.intervalSeconds = Number(intervalInput.value);
        setOrDelete(payload, 'model', modelInput.value.trim());
        setOrDelete(payload, 'thinking', thinkingSelect.value);
        setOrDelete(payload, 'workdir', workdirInput.value.trim());
        setOrDelete(payload, 'sessionDir', sessionInput.value.trim());
        setOrDelete(payload, 'envFile', envInput.value.trim());
        payload.rules = rules.map(function (rule) {
          var out = { ...rule };
          if (!out.assignee) delete out.assignee;
          if (!Array.isArray(out.notLabels) || out.notLabels.length === 0) delete out.notLabels;
          return out;
        });

        var res = await api('PUT', '/api/config', payload);
        cfgState.raw = payload;
        cfgState.loaded = true;
        toast.className = 'toast';
        toast.textContent = res.restartRequired ? '已保存，重启循环后生效' : '已保存';
        toast.hidden = false;
        setTimeout(function () { toast.hidden = true; }, 3000);
        banner('');
      } catch (err) {
        toast.className = 'toast toast--error';
        toast.textContent = err.message;
        toast.hidden = false;
      }
    });

    actions.appendChild(saveBtn);
    actions.appendChild(toast);
    el.cfgBody.appendChild(actions);
  }

  function setOrDelete(obj, key, value) {
    if (value === '' || value == null) delete obj[key];
    else obj[key] = value;
  }

  // ---------- 启动 ----------

  state.connection = 'connecting';
  renderHeader();
  renderRules();
  showView(location.hash.slice(1) || 'progress');
  connect();
})();

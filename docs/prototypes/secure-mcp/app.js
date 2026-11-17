(() => {
  const M = globalThis.CommandSetPreview;
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const family = text => ({kind: 'family', text});
  const modes = {ask: '请求审批', auto_edit: '自动编辑', full: '完全访问'};
  const content = $('#content');
  let state, editor = null, toastTimer, dialogResolve;
  const icon = name => {
    const paths = {plus: '<path d="M8 2v12M2 8h12"/>', copy: '<rect x="5" y="5" width="9" height="9" rx="1"/><path d="M10 2H2v8"/>', arrow: '<path d="m9 3-5 5 5 5M4 8h10"/>', edit: '<path d="m10 2 4 4-7 7-5 1 1-5Z M8 4l4 4"/>', check: '<path d="m2 8 4 4 8-9"/>'};
    return `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${paths[name] || paths.plus}</svg>`;
  };
  const button = (label, action, cls = '', attrs = '') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
  function initial(scenario = 'normal') {
    const profiles = [{id: 'router', name: 'OpenWrt', host: 'root@192.168.1.1', enabled: true, mode: 'ask'}, {id: 'server', name: '开发服务器', host: 'dev@192.0.2.20', enabled: true, mode: 'auto_edit'}, {id: 'production', name: '生产服务器', host: 'ops@192.0.2.80', enabled: false, mode: 'ask'}];
    let clients = [{id: 'cursor', name: 'Cursor', initials: 'CU', permission: 'permanent', active: true}, {id: 'claude', name: 'Claude Desktop', initials: 'CL', permission: 'session', active: false}, {id: 'codex', name: 'Codex', initials: 'CX', permission: '24h', active: false}];
    if (scenario === 'empty') clients = [];
    if (scenario === 'long') {
      clients[0].name = 'Cursor · 上海研发团队的日常 SSH 运维客户端';
      profiles[0].name = 'OpenWrt / 上海办公室 / 核心网关与 OpenClash';
      for (let i = 0; i < 7; i++) clients.push({id: `extra-${i}`, name: `团队客户端 ${i + 1}`, initials: `T${i + 1}`, permission: 'session', active: false});
    }
    const pairs = {};
    for (const client of clients) for (const profile of profiles) pairs[`${client.id}/${profile.id}`] = {rules: [], inherit: true, connection: 'ask'};
    if (clients.length) { pairs[`${clients[0].id}/router`].rules = [family('docker ps'), family('uci get')]; pairs[`${clients[0].id}/router`].connection = 'allowed'; }
    return {page: 'clients', clients, profiles, pairs, selectedClient: clients[0]?.id, global: scenario === 'limit' ? Array.from({length: 128}, (_, i) => ({kind: 'exact', text: `echo preview-${i + 1}`})) : [], running: true, port: 3001, closePolicy: 'immediate', scenario};
  }
  function announce(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200); }
  function dialog(title, body, actions) {
    $('#dialog-title').textContent = title;
    $('#dialog-body').innerHTML = body;
    $('#dialog-actions').innerHTML = actions.map(action => `<button value="${action.value}" class="${action.cls || ''}" ${action.value === 'cancel' ? 'formnovalidate' : ''}>${escape(action.label)}</button>`).join('');
    $('#action-dialog').returnValue = 'cancel';
    $('#action-dialog').showModal();
    return new Promise(resolve => { dialogResolve = resolve; });
  }
  $('#action-dialog').addEventListener('close', () => { const resolve = dialogResolve; dialogResolve = null; resolve?.($('#action-dialog').returnValue); });
  $('#action-dialog').addEventListener('cancel', () => { $('#action-dialog').returnValue = 'cancel'; });
  function pendingRule() { return !!editor && (editor.editing === null ? !!editor.text.trim() : editor.text !== editor.rules[editor.editing].text || editor.kind !== editor.rules[editor.editing].kind); }
  function dirty() { return !!editor && (JSON.stringify(editor.rules) !== JSON.stringify(editor.original.rules) || editor.inherit !== editor.original.inherit || pendingRule() || !!editor.paste.trim()); }
  async function leaveEditor() {
    if (!dirty()) return true;
    const choice = await dialog('还有未保存的修改', '<p>离开前可保存当前命令集，或放弃本次草稿。已保存的规则不会受影响。</p>', [{value: 'cancel', label: '继续编辑'}, {value: 'discard', label: '放弃修改', cls: 'btn-danger'}, {value: 'save', label: '保存并离开', cls: 'btn-primary'}]);
    if (choice === 'save') return saveEditor(false);
    return choice === 'discard';
  }
  async function navigate(page) { if (!await leaveEditor()) return; editor = null; state.page = page; render(); }
  function inheritedCount() { return Object.entries(state.pairs).filter(([key, pair]) => pair.inherit && state.profiles.some(p => key.endsWith(`/${p.id}`) && p.enabled)).length; }
  function currentClient() { return state.clients.find(client => client.id === state.selectedClient); }
  function effective(pair) { return new Set([...(pair.inherit ? state.global : []), ...pair.rules].map(M.key)).size; }
  async function openEditor(scope, clientId, profileId, fill = false) {
    if (!await leaveEditor()) return;
    const source = scope === 'global' ? {rules: state.global, inherit: false} : state.pairs[`${clientId}/${profileId}`];
    editor = {scope, clientId, profileId, rules: structuredClone(source.rules), inherit: source.inherit, original: structuredClone(source), text: '', kind: 'family', editing: null, paste: '', importOpen: false, importPreview: null, error: ''};
    render();
    if (fill) fillPresets();
    focusInput();
  }
  function focusInput() { requestAnimationFrame(() => { $('#rule-text')?.focus({preventScroll: true}); const input = $('#rule-text'); if (input && input.getBoundingClientRect().bottom > $('#editor-footer').getBoundingClientRect().top) input.scrollIntoView({block: 'nearest'}); }); }
  function render() {
    $('.workspace').classList.toggle('editing', !!editor);
    $('#client-count').textContent = state.clients.length;
    $('#global-count').textContent = state.global.length;
    $('#header-status').innerHTML = `<span class="dot ${state.running ? 'good' : ''}"></span>${state.running ? '服务运行中' : '服务已停止'}`;
    document.querySelectorAll('[data-page]').forEach(tab => { const active = tab.dataset.page === (editor?.scope === 'global' ? 'global' : state.page); tab.classList.toggle('active', active); if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current'); });
    content.innerHTML = editor ? editorView() : ({clients: clientsView, service: serviceView, ssh: sshView, global: globalView}[state.page])();
    content.scrollTop = 0;
    renderFooter();
  }
  function renderFooter() {
    const footer = $('#editor-footer'); footer.hidden = !editor;
    if (!editor) return;
    const changed = dirty();
    footer.innerHTML = `<div class="footer-info">${changed ? '<span class="dirty-dot"></span>有未保存的修改' : '所有更改已保存'}<p>${editor.scope === 'global' ? `保存后同步应用到 ${inheritedCount()} 份继承此默认集的 SSH 命令集。` : '仅应用到当前客户端的这一个 SSH。'}</p></div><div class="actions">${button('取消', 'close-editor')}${button('保存命令集', 'save-editor', 'btn-primary', changed ? '' : 'disabled')}</div>`;
  }
  function clientsView() {
    const client = currentClient();
    if (!client) return `<div class="page-heading"><div><h2>客户端</h2><p>每个客户端的 SSH 授权与审批命令集独立管理。</p></div></div><div class="empty-state"><div class="empty-symbol">＋</div><h3>添加第一个 AI 客户端</h3><p>为 Cursor、Claude Desktop 或其他客户端分别创建凭据，并选择它可以使用的 SSH。</p>${button('添加客户端', 'add-client', 'btn-primary')}</div>`;
    const profileRows = state.profiles.filter(p => p.enabled).map(p => {
      const pair = state.pairs[`${client.id}/${p.id}`];
      return `<div class="connection-row"><div class="connection-info"><strong>${escape(p.name)}</strong><code>${escape(p.host)}</code><div class="connection-meta">${pair.rules.length} 条本地${pair.inherit ? ` · 继承全局 ${state.global.length} 条` : ' · 不继承全局'} · <span>生效 ${effective(pair)} 条</span></div></div><label class="sr-only" for="connection-${p.id}">${escape(p.name)} 连接权限</label><select id="connection-${p.id}" data-connection="${p.id}"><option value="ask" ${pair.connection === 'ask' ? 'selected' : ''}>连接时询问</option><option value="allowed" ${pair.connection === 'allowed' ? 'selected' : ''}>永久允许连接</option></select>${button(`${icon('edit')}编辑命令集`, 'edit-local', 'btn-small', `data-profile="${p.id}"`)}</div>`;
    }).join('');
    return `<div class="page-heading"><div><h2>客户端</h2><p>按客户端管理连接权限和各个 SSH 的审批命令。</p></div>${button(`${icon('plus')}添加客户端`, 'add-client', 'btn-small')}</div><div class="client-layout"><div class="client-sidebar"><div class="list-label">已配对客户端 <span>${state.clients.length}</span></div>${state.clients.map(c => `<button class="client-choice ${c.id === client.id ? 'active' : ''}" data-action="select-client" data-client="${c.id}" aria-pressed="${c.id === client.id}"><span class="avatar">${escape(c.initials)}</span><span><span class="client-name">${escape(c.name)}</span><small>${c.active ? '当前在线' : '尚未连接'}</small></span></button>`).join('')}</div><div class="client-details"><div class="client-title"><span class="avatar">${escape(client.initials)}</span><div class="title-info"><h2>${escape(client.name)}</h2><p>独立凭据 · 独立 SSH 命令集</p></div>${button('重命名', 'rename-client', 'btn-link btn-small')}</div><section class="panel"><div class="panel-body setting-row"><div><h3>配对授权</h3><p>允许此客户端建立 MCP 会话。</p></div><div class="inline-select"><label class="sr-only" for="client-permission">配对有效期</label><select id="client-permission">${[['permanent', '长期有效'], ['24h', '24 小时'], ['session', '本次会话'], ['none', '需要重新审批']].map(([key, label]) => `<option value="${key}" ${client.permission === key ? 'selected' : ''}>${label}</option>`).join('')}</select>${button('应用', 'apply-permission', 'btn-small')}</div></div></section><section class="panel"><div class="panel-head"><div><h3>SSH 连接与命令集</h3><p>连接许可与命令审批分别管理。</p></div><span class="badge">${state.profiles.filter(p => p.enabled).length} 个 SSH</span></div>${profileRows || '<div class="panel-body"><p>尚未启用 SSH，请先到“SSH 权限”勾选连接。</p></div>'}</section><div class="quiet-note"><span class="note-mark">i</span><div>${state.global.length ? `全局默认已配置 ${state.global.length} 条规则，继承后随全局同步更新。` : '<strong>全局默认命令集还是空的。</strong> 可一键填充只读查询，减少重复审批。'} ${button('配置全局命令集 →', 'go-global', 'btn-link btn-small')}</div></div><div class="credential-actions">${button(`${icon('copy')}复制连接配置`, 'copy-client', 'btn-link')}${button('重置凭据', 'reset-client', 'btn-link')}${button('撤销客户端', 'revoke-client', 'btn-link btn-danger')}</div></div></div>`;
  }
  function globalView() {
    return `<div class="page-heading"><div><h2>全局命令集</h2><p>统一维护常用审批规则，各客户端的 SSH 默认继承。</p></div>${button(`${icon('edit')}编辑命令集`, 'edit-global', 'btn-small')}</div><div class="global-summary"><div><div class="summary-value">${state.global.length}<span style="font-size:12px;letter-spacing:0;color:var(--muted);margin-left:8px">条默认审批规则</span></div><div class="summary-label">默认空集 · 主动添加后才生效</div></div><div class="inherit-summary"><strong>${inheritedCount()}</strong> 份 SSH 命令集正在继承</div></div>${state.global.length ? `<div class="panel"><div class="panel-head"><h3>已保存的全局规则</h3><span class="badge good">同步继承</span></div>${ruleList(state.global, 'global', false)}</div><div class="actions">${button('填充低风险命令', 'fill-global', 'btn-primary')}${button('编辑全部规则', 'edit-global')}</div>` : `<div class="empty-state"><div class="empty-symbol">$_</div><h3>从常用只读查询开始</h3><p>一键加入 15 个低风险查询命令族，包含基础信息、容器状态、路由与防火墙查询。先加入草稿，由你确认保存。</p><div class="actions">${button('填充低风险命令', 'fill-global', 'btn-primary')}${button('手动添加规则', 'edit-global')}</div></div>`}<div class="global-description"><h3>全局默认如何生效</h3><div class="explain-row"><span class="explain-index">01</span><div><strong>各客户端的 SSH 独立继承</strong><p>每份命令集都可以关闭继承，并保留自己的本地规则。</p></div></div><div class="explain-row"><span class="explain-index">02</span><div><strong>全局修改，保存后同步</strong><p>填充会合并并去重，不覆盖已有规则。保存前不会改变生效命令集。</p></div></div><div class="explain-row"><span class="explain-index">03</span><div><strong>只读不等于输出不敏感</strong><p>例如 <code>cat</code> 和 <code>uci get</code> 可能读取敏感配置。程序和参数仍需通过现有风险校验。</p></div></div></div>`;
  }
  function ruleList(rules, source, editable) {
    if (!rules.length) return `<div class="rule-empty"><h3>还没有${source === 'local' ? '本地' : ''}规则</h3><p>${editor?.scope === 'global' ? '点击“填充低风险命令”，或在上方输入第一条规则。' : '在上方输入程序和子命令，例如 docker ps。'}</p></div>`;
    return `<div role="table" aria-label="${source === 'global' ? '全局' : '本地'}审批规则"><div class="rule-row header" role="row"><span role="columnheader">命令</span><span role="columnheader">匹配方式</span><span role="columnheader" class="rule-source">来源</span><span role="columnheader">${editable ? '操作' : '状态'}</span></div>${rules.map((rule, i) => `<div class="rule-row" role="row"><div role="cell"><code>${escape(rule.text)}</code>${rule.kind === 'family' ? '<span class="rule-desc">参数仍须通过风险校验</span>' : ''}</div><span role="cell" class="rule-kind">${rule.kind === 'family' ? '程序 / 子命令' : '精确命令'}</span><span role="cell" class="rule-source ${source === 'global' ? 'global-source' : ''}">${source === 'global' ? '全局' : '本地'}</span><div role="cell" class="rule-actions">${editable ? button('编辑', 'edit-rule', 'btn-link', `data-index="${i}" aria-label="编辑 ${escape(rule.text)}"`) + button('删除', 'delete-rule', 'btn-link btn-danger', `data-index="${i}" aria-label="删除 ${escape(rule.text)}"`) : '<span class="badge">只读</span>'}</div></div>`).join('')}</div>`;
  }
  function editorView() {
    const global = editor.scope === 'global';
    const client = state.clients.find(c => c.id === editor.clientId);
    const profile = state.profiles.find(p => p.id === editor.profileId);
    return `${button(`${icon('arrow')}返回${global ? '全局命令集' : '客户端'}`, 'close-editor', 'back-link')}<div class="breadcrumb">${global ? '全局默认 / 审批命令' : `客户端 / ${escape(client.name)} / ${escape(profile.name)}`}</div><div class="page-heading editor-heading compact"><div><h2>${global ? '编辑全局命令集' : `命令集 · ${escape(profile.name)}`}</h2><div class="editor-scope">${global ? '保存后同步到开启继承的 SSH 命令集。' : `仅作用于 ${escape(client.name)} 的此 SSH 连接。`}</div></div><div class="actions"><span class="badge ${global ? 'accent' : ''}">${global ? '全局默认' : '客户端独立'}</span>${global ? button('填充低风险命令', 'fill-presets', 'btn-small') : ''}</div></div>${!global ? `<div class="inherit-row"><input type="checkbox" id="inherit-defaults" ${editor.inherit ? 'checked' : ''}><div><label for="inherit-defaults">继承全局默认命令集 <span class="badge">${state.global.length} 条</span></label><p>全局修改后同步生效，本地规则独立保留。</p></div></div>` : ''}<section class="panel editor-input-panel"><div class="panel-body"><h3 id="input-heading">${editor.editing === null ? '添加审批规则' : '编辑审批规则'}</h3><form id="rule-form" class="input-grid"><div><label for="rule-kind">匹配方式</label><select id="rule-kind"><option value="family" ${editor.kind === 'family' ? 'selected' : ''}>程序 / 子命令</option><option value="exact" ${editor.kind === 'exact' ? 'selected' : ''}>精确命令</option></select></div><div><label for="rule-text">${editor.kind === 'family' ? '程序和子命令' : '完整命令'}</label><input id="rule-text" type="text" value="${escape(editor.text)}" placeholder="${editor.kind === 'family' ? '例如 docker ps' : '例如 docker inspect demo'}" spellcheck="false" autocomplete="off" aria-describedby="rule-hint rule-error"></div><button type="submit" id="add-rule-button" class="btn-primary">${editor.editing === null ? '添加规则' : '更新规则'}</button></form><div id="rule-hint" class="input-hint">${editor.kind === 'family' ? '按程序和子命令记住，实际参数仍需校验。例如填写 <code>uci get</code>，而非 <code>uci *</code>。' : '只批准这一条完整命令，不扩展到同程序的其他命令。'}${editor.editing !== null ? ' ' + button('取消编辑此条', 'cancel-rule', 'btn-link btn-small') : ''}</div><div id="rule-error" class="form-error" role="alert" ${editor.error ? '' : 'hidden'}>${escape(editor.error)}</div></div></section><div class="rule-toolbar"><h3>${global ? '全局规则' : '本地规则'}<small>${editor.rules.length} / 128 条</small></h3><div class="actions">${button(`${icon('copy')}复制${global ? '规则' : '本地规则'}`, 'copy-rules', 'btn-small')}${button('粘贴导入', 'toggle-import', 'btn-small', `aria-expanded="${editor.importOpen}" aria-controls="import-panel"`)}${button('清空', 'clear-rules', 'btn-small btn-danger', editor.rules.length ? '' : 'disabled')}</div></div>${editor.importOpen ? importView() : ''}<div class="rule-list">${ruleList(editor.rules, global ? 'global' : 'local', true)}</div>${!global && editor.inherit ? `<section><div class="inherited-head"><div><h3>继承自全局 <span class="count">${state.global.length}</span></h3><p>这里仅供查看，不会随“复制本地规则”复制。</p></div>${button('编辑全局 →', 'edit-global', 'btn-link btn-small')}</div><div class="rule-list">${state.global.length ? ruleList(state.global, 'global', false) : '<div class="rule-empty"><p>全局默认还是空的。可前往全局填充 15 个低风险查询命令族。</p></div>'}</div></section>` : ''}<p class="input-hint" style="margin-top:16px">审批模式仍决定未匹配命令的处理方式；填充和编辑不会更改 SSH 的权限等级。</p>`;
  }
  function importView() { return `<section id="import-panel" class="import-panel"><label for="paste-text">粘贴另一个命令集</label><textarea id="paste-text" spellcheck="false" placeholder="粘贴在本预览中复制的命令集…">${escape(editor.paste)}</textarea><p class="input-hint">仅演示命令集之间的复制与导入，不可用于真实插件配置。</p><div class="actions">${button('校验并预览', 'preview-import', 'btn-small')}${button('取消导入', 'cancel-import', 'btn-link btn-small')}</div>${editor.importPreview ? `<div class="import-preview"><p>已校验 ${editor.importPreview.length} 条规则。选择合并保留现有内容，或替换当前草稿。</p><div class="import-samples">${editor.importPreview.map(rule => `<code>${escape(rule.text)}</code>`).join('')}</div><div class="actions">${button('合并到草稿', 'merge-import', 'btn-small btn-primary')}${button('替换草稿', 'replace-import', 'btn-small btn-danger')}</div></div>` : ''}</section>`; }
  function sshView() {
    return `<div class="page-heading"><div><h2>SSH 权限</h2><p>勾选可供 MCP 使用的 SSH，并为每个连接选择命令审批模式。</p></div></div><div class="mode-guide">${[['01', '请求审批', '每种未获批准的命令都先询问；审批时可选择记住。'], ['02', '自动编辑', '低风险操作直接执行；高危与无法判断的操作仍需审批。'], ['03', '完全访问', '允许执行全部命令。仅对你信任的环境开启。']].map(([i, title, desc]) => `<div class="mode-card"><div class="mode-index">${i}</div><h3>${title}</h3><p>${desc}</p></div>`).join('')}</div><section class="panel"><div class="panel-head"><h3>允许使用的 SSH</h3><span class="badge">${state.profiles.filter(p => p.enabled).length} / ${state.profiles.length} 已启用</span></div>${state.profiles.map(p => `<div class="ssh-setting-row"><input type="checkbox" id="ssh-${p.id}" data-enable-profile="${p.id}" ${p.enabled ? 'checked' : ''}><div><label for="ssh-${p.id}">${escape(p.name)}</label><p class="mono">${escape(p.host)}</p></div><label class="sr-only" for="mode-${p.id}">${escape(p.name)} 审批模式</label><select id="mode-${p.id}" data-mode-profile="${p.id}" ${p.enabled ? '' : 'disabled'}>${Object.entries(modes).map(([key, label]) => `<option value="${key}" ${p.mode === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>`).join('')}</section><div class="quiet-note"><span class="note-mark">i</span><div>命令审批规则仍按“客户端 + SSH”单独保存。${button('前往客户端管理 →', 'go-clients', 'btn-link btn-small')}</div></div>`;
  }
  function serviceView() {
    return `<div class="page-heading"><div><h2>本地服务</h2><p>管理 Tabby 内置的 MCP HTTP 服务与命令会话。</p></div><span class="badge">仅本机</span></div><section class="panel"><div class="service-status"><div><h3><span class="dot ${state.running ? 'good' : ''}"></span> ${state.running ? '服务运行中' : '服务已停止'}</h3><p class="mono">http://127.0.0.1:${state.port}/mcp</p></div>${button(state.running ? '停止服务' : '启动服务', 'toggle-service', state.running ? 'btn-small' : 'btn-small btn-primary')}</div></section><section class="panel"><div class="panel-head"><h3>连接设置</h3></div><div class="panel-body"><form id="port-form" class="service-form"><div class="form-width"><label for="http-port">HTTP 端口</label><input id="http-port" type="number" value="${state.port}" min="1024" max="65535" required></div><button type="submit">保存端口</button></form><p id="port-help" class="field-help">端口范围 1024–65535；修改后客户端连接地址也需更新。</p><div class="setting-divider"></div><div class="setting-row"><div><h3>命令完成后关闭 SSH 会话</h3><p>独立命令会话的清理方式。</p></div><label class="sr-only" for="close-policy">会话关闭策略</label><select id="close-policy"><option value="immediate" ${state.closePolicy === 'immediate' ? 'selected' : ''}>立即关闭</option><option value="on_success" ${state.closePolicy === 'on_success' ? 'selected' : ''}>成功后关闭</option><option value="manual" ${state.closePolicy === 'manual' ? 'selected' : ''}>手动关闭</option></select></div></div></section><div class="service-footer"><span class="dot"></span>当前为交互预览，不会启动真实服务或建立 SSH 连接。</div>`;
  }
  function setError(error) { editor.error = error.message || error; const el = $('#rule-error'); el.textContent = editor.error; el.hidden = false; el.scrollIntoView({block: 'nearest'}); }
  function commitRule() {
    if (!editor.text.trim()) { setError('请先输入程序和子命令，或一条完整命令。'); return false; }
    try {
      const incoming = M.validate([{kind: editor.kind, text: editor.text}])[0];
      const next = [...editor.rules];
      if (editor.editing === null) next.push(incoming); else next[editor.editing] = incoming;
      editor.rules = M.validate(next); editor.text = ''; editor.editing = null; editor.error = ''; return true;
    } catch (error) { setError(error); return false; }
  }
  function fillPresets() {
    try { const before = editor.rules.length; const next = M.fill(editor.rules); editor.rules = next; editor.error = ''; render(); announce(next.length === before ? '已包含全部 15 条低风险预设' : `已向草稿新增 ${next.length - before} 条只读查询规则，保存后生效。`); }
    catch (error) { setError(error); }
  }
  function saveEditor(close = true) {
    if (editor.paste.trim()) { setError('请先合并或替换导入内容，或取消导入，再保存。'); return false; }
    if (editor.text.trim() && !commitRule()) return false;
    try {
      const rules = M.validate(editor.rules);
      if (editor.scope === 'global') state.global = structuredClone(rules);
      else { const pair = state.pairs[`${editor.clientId}/${editor.profileId}`]; pair.rules = structuredClone(rules); pair.inherit = editor.inherit; }
      const page = editor.scope === 'global' ? 'global' : 'clients';
      editor.original = {rules: structuredClone(rules), inherit: editor.inherit};
      if (close) { editor = null; state.page = page; render(); }
      announce('命令集已保存到当前预览，刷新后重置。'); return true;
    } catch (error) { setError(error); return false; }
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); announce('已复制，可粘贴到另一份命令集。'); }
    catch { await dialog('复制内容', `<p>当前浏览器不允许直接写入剪贴板。选中以下内容后复制。</p><textarea class="manual-copy" readonly>${escape(text)}</textarea>`, [{value: 'done', label: '完成', cls: 'btn-primary'}]); }
  }
  async function handle(action, el) {
    if (action === 'go-global') return navigate('global');
    if (action === 'go-clients') return navigate('clients');
    if (action === 'edit-global') return openEditor('global');
    if (action === 'fill-global') return openEditor('global', null, null, true);
    if (action === 'edit-local') return openEditor('local', state.selectedClient, el.dataset.profile);
    if (action === 'select-client') { state.selectedClient = el.dataset.client; render(); return; }
    if (action === 'close-editor') return navigate(editor.scope === 'global' ? 'global' : 'clients');
    if (action === 'save-editor') return saveEditor();
    if (action === 'fill-presets') return fillPresets();
    if (action === 'edit-rule') {
      let index = Number(el.dataset.index);
      if (editor.editing === index) { focusInput(); return; }
      const targetKey = M.key(editor.rules[index]);
      if (pendingRule()) {
        const choice = await dialog('先处理输入中的规则', '<p>当前输入还没有添加或更新到草稿。切换前可以保留到草稿，或放弃这段输入。</p>', [{value: 'cancel', label: '继续输入'}, {value: 'discard', label: '放弃输入'}, {value: 'apply', label: '加入草稿并切换', cls: 'btn-primary'}]);
        if (!['apply', 'discard'].includes(choice)) return;
        if (choice === 'apply' && !commitRule()) return;
        index = editor.rules.findIndex(rule => M.key(rule) === targetKey);
      }
      editor.editing = index; editor.kind = editor.rules[index].kind; editor.text = editor.rules[index].text; editor.error = ''; render(); focusInput(); return;
    }
    if (action === 'cancel-rule') { editor.text = ''; editor.editing = null; editor.error = ''; render(); focusInput(); return; }
    if (action === 'delete-rule') {
      const index = Number(el.dataset.index);
      editor.rules.splice(index, 1);
      if (editor.editing === index) { editor.editing = null; editor.text = ''; } else if (editor.editing > index) editor.editing--;
      render(); return;
    }
    if (action === 'clear-rules') {
      const choice = await dialog('清空当前命令集？', `<p>将从草稿中移除 ${editor.rules.length} 条${editor.scope === 'global' ? '全局' : '本地'}规则。${editor.scope === 'local' ? '继承的全局规则不受影响。' : '保存后会同步影响正在继承的 SSH 命令集。'}你仍可在保存前取消本次修改。</p>`, [{value: 'cancel', label: '保留规则'}, {value: 'clear', label: '清空草稿', cls: 'btn-danger'}]);
      if (choice === 'clear') { editor.rules = []; editor.text = ''; editor.editing = null; editor.error = ''; render(); announce('草稿已清空，保存后生效。'); } return;
    }
    if (action === 'copy-rules') return copy(M.exportSet(editor.rules));
    if (action === 'toggle-import') { editor.importOpen = !editor.importOpen; render(); if (editor.importOpen) $('#paste-text').focus(); return; }
    if (action === 'cancel-import') { editor.paste = ''; editor.importPreview = null; editor.importOpen = false; editor.error = ''; render(); return; }
    if (action === 'preview-import') { try { editor.importPreview = M.importSet(editor.paste); editor.error = ''; render(); $('#import-panel').scrollIntoView({block: 'nearest'}); } catch (error) { setError(error); } return; }
    if (action === 'merge-import' || action === 'replace-import') {
      if (action === 'replace-import' && await dialog('替换当前草稿？', '<p>当前草稿规则将被导入内容替换，尚未添加或更新的输入也会被放弃。保存前不会影响已生效的规则。</p>', [{value: 'cancel', label: '取消'}, {value: 'replace', label: '替换草稿', cls: 'btn-danger'}]) !== 'replace') return;
      try { const next = action === 'merge-import' ? M.merge(editor.rules, editor.importPreview) : M.validate(editor.importPreview); editor.rules = next; if (action === 'replace-import') { editor.text = ''; editor.editing = null; } editor.paste = ''; editor.importPreview = null; editor.importOpen = false; editor.error = ''; render(); announce('导入已应用到草稿，保存后生效。'); } catch (error) { setError(error); } return;
    }
    if (action === 'toggle-service') { state.running = !state.running; render(); announce(`已模拟${state.running ? '启动' : '停止'}服务。`); return; }
    if (action === 'apply-permission') { currentClient().permission = $('#client-permission').value; announce('配对授权已在预览中更新。'); return; }
    if (action === 'copy-client') return copy(JSON.stringify({preview: true, client: currentClient().name, url: `http://127.0.0.1:${state.port}/mcp`, token: 'DEMO-CREDENTIAL-NOT-VALID'}, null, 2));
    if (action === 'add-client' || action === 'rename-client') {
      const client = currentClient();
      const value = action === 'rename-client' ? client.name : '';
      const choice = await dialog(action === 'add-client' ? '添加客户端' : '重命名客户端', `<label for="client-name-input">客户端名称</label><input id="client-name-input" value="${escape(value)}" maxlength="160" required placeholder="例如 Cursor · 工作电脑"><p class="field-help">此预览只创建演示条目，不生成真实凭据。</p>`, [{value: 'cancel', label: '取消'}, {value: 'save', label: '保存', cls: 'btn-primary'}]);
      if (choice !== 'save') return;
      const name = $('#client-name-input').value.trim(); if (!name) return;
      if (action === 'rename-client') client.name = name;
      else { const id = `client-${Date.now()}`; state.clients.push({id, name, initials: name.slice(0, 2).toUpperCase(), active: false, permission: 'session'}); for (const p of state.profiles) state.pairs[`${id}/${p.id}`] = {rules: [], inherit: true, connection: 'ask'}; state.selectedClient = id; }
      render(); return;
    }
    if (action === 'reset-client' || action === 'revoke-client') {
      const revoke = action === 'revoke-client';
      const choice = await dialog(revoke ? '撤销此客户端？' : '重置客户端凭据？', `<p>${escape(currentClient().name)}：${revoke ? '将从预览中移除此客户端及其本地命令集。' : '真实插件中，旧凭据将失效，需要重新复制连接配置。此处仅演示确认流程。'}</p>`, [{value: 'cancel', label: '取消'}, {value: 'confirm', label: revoke ? '撤销客户端' : '重置凭据', cls: 'btn-danger'}]);
      if (choice !== 'confirm') return;
      if (revoke) { const id = state.selectedClient; state.clients = state.clients.filter(c => c.id !== id); for (const key of Object.keys(state.pairs)) if (key.startsWith(`${id}/`)) delete state.pairs[key]; state.selectedClient = state.clients[0]?.id; render(); }
      announce(revoke ? '演示客户端已撤销。' : '已模拟重置凭据。');
    }
  }
  document.addEventListener('click', event => {
    const action = event.target.closest('[data-action]'); if (action) handle(action.dataset.action, action).catch(error => announce(error.message));
    const tab = event.target.closest('[data-page]'); if (tab) navigate(tab.dataset.page);
    const theme = event.target.closest('[data-theme-choice]');
    if (theme) { document.body.dataset.theme = theme.dataset.themeChoice; document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', button === theme)); }
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'rule-text') { editor.text = event.target.value; editor.error = ''; $('#rule-error').hidden = true; renderFooter(); }
    if (event.target.id === 'paste-text') { editor.paste = event.target.value; editor.importPreview = null; $('.import-preview')?.remove(); renderFooter(); }
  });
  document.addEventListener('change', async event => {
    const el = event.target;
    if (el.id === 'scenario') { const next = el.value; if (!await leaveEditor()) { el.value = state.scenario; return; } editor = null; state = initial(next); if (next === 'limit') state.page = 'global'; render(); announce('预览场景已切换，模拟数据已重置。'); }
    if (el.id === 'rule-kind') { editor.kind = el.value; render(); focusInput(); }
    if (el.id === 'inherit-defaults') { editor.inherit = el.checked; render(); $('#inherit-defaults').focus(); }
    if (el.dataset.connection) { state.pairs[`${state.selectedClient}/${el.dataset.connection}`].connection = el.value; announce('连接权限已在预览中更新。'); }
    if (el.dataset.enableProfile) { state.profiles.find(p => p.id === el.dataset.enableProfile).enabled = el.checked; render(); }
    if (el.dataset.modeProfile) { state.profiles.find(p => p.id === el.dataset.modeProfile).mode = el.value; announce(`审批模式已在预览中切换为“${modes[el.value]}”。`); }
    if (el.id === 'close-policy') { state.closePolicy = el.value; announce('会话关闭策略已在预览中更新。'); }
  });
  document.addEventListener('submit', event => {
    if (event.target.id === 'rule-form') { event.preventDefault(); if (commitRule()) { render(); focusInput(); announce('规则已加入草稿，保存后生效。'); } }
    if (event.target.id === 'port-form') { event.preventDefault(); const value = Number($('#http-port').value); if (Number.isInteger(value) && value >= 1024 && value <= 65535) { state.port = value; render(); announce('端口已在预览中更新。'); } }
  });
  window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  state = initial(); render();
})();

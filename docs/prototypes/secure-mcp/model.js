/* UI-only state. This format is deliberately separate from real authorization data. */
(function (root) {
  const presets = ['pwd', 'whoami', 'id', 'uptime', 'uname', 'ls', 'cat', 'wc', 'docker ps', 'ip rule show', 'ip -4 rule show', 'ip -6 rule show', 'uci get', 'uci -q get', 'nft list table'];
  const size = value => new TextEncoder().encode(value).length;
  const key = rule => `${rule.kind}:${rule.text}`;
  function validate(rules) {
    if (!Array.isArray(rules)) throw new Error('命令集必须包含规则列表。');
    const unique = new Map();
    for (const rule of rules) {
      if (!rule || !['family', 'exact'].includes(rule.kind) || typeof rule.text !== 'string' || !rule.text.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(rule.text) || size(rule.text) > 512) throw new Error('每条规则需为单行命令，最多 512 字节。');
      const normalized = {kind: rule.kind, text: rule.text.trim()};
      if (rule.kind === 'family' && ![...presets, 'mkdir', 'touch'].includes(normalized.text)) throw new Error('请输入已支持的程序和子命令，例如 docker ps；其他命令请使用精确匹配。');
      unique.set(key(normalized), normalized);
    }
    if (unique.size > 128) throw new Error('一个命令集最多保存 128 条规则；草稿未更改。');
    if (size(JSON.stringify([...unique.values()])) > 64 * 1024) throw new Error('命令集不能超过 64 KiB；草稿未更改。');
    return [...unique.values()];
  }
  function merge(current, incoming) { return validate([...current, ...incoming]); }
  function fill(current) { return merge(current, presets.map(text => ({kind: 'family', text}))); }
  function exportSet(rules) {
    const text = JSON.stringify({format: 'secure-mcp-ui-preview', version: 1, rules: validate(rules)}, null, 2);
    if (size(text) > 64 * 1024) throw new Error('导出内容不能超过 64 KiB；草稿未更改。');
    return text;
  }
  function importSet(text) {
    if (size(text) > 64 * 1024) throw new Error('粘贴内容不能超过 64 KiB。');
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error('内容不是有效 JSON，请先使用“复制规则”获取命令集。'); }
    if (payload?.format !== 'secure-mcp-ui-preview' || payload.version !== 1) throw new Error('请粘贴本预览中复制的命令集。');
    return validate(payload.rules);
  }
  root.CommandSetPreview = {presets, validate, merge, fill, exportSet, importSet, key};
})(globalThis);

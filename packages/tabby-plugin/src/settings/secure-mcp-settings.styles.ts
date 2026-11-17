export const secureMcpSettingsStyles = `
.secure-mcp-settings {
  --mcp-bg: var(--theme-bg, var(--bs-body-bg, Canvas));
  --mcp-panel: var(--theme-bg-more, var(--bs-secondary-bg, var(--mcp-bg)));
  --mcp-line: var(--bs-border-color, var(--theme-bg-less, GrayText));
  --mcp-muted: var(--bs-secondary-color, inherit);
  --mcp-accent: var(--theme-primary, var(--bs-primary, Highlight));
  --mcp-danger: var(--theme-danger, var(--bs-danger, #b3323a));
  --mcp-warning: var(--theme-warning, var(--bs-warning, #a86900));
  color: inherit; font-family: inherit; font-size: inherit; line-height: 1.5; min-width: 0;
}
.secure-mcp-settings *, .secure-mcp-settings *::before, .secure-mcp-settings *::after { box-sizing: border-box; }
.secure-mcp-settings h2, .secure-mcp-settings h3, .secure-mcp-settings p { margin: 0; }
.secure-mcp-settings h2 { font-size: 1.3em; font-weight: 600; }
.secure-mcp-settings h3 { font-size: 1em; font-weight: 600; }
.secure-mcp-settings p { margin-top: .4rem; }
.secure-mcp-settings .muted, .secure-mcp-settings small { color: var(--mcp-muted); opacity: .8; }
.secure-mcp-settings .workspace-header, .secure-mcp-settings .page-heading,
.secure-mcp-settings .panel-head, .secure-mcp-settings .setting-row,
.secure-mcp-settings .rule-toolbar, .secure-mcp-settings .editor-footer {
  display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap;
}
.secure-mcp-settings .workspace-header { padding: .75rem 0 1rem; }
.secure-mcp-settings .workspace-header h2 { font-size: 1.25em; }
.secure-mcp-settings .section-tabs { display: flex; gap: 1.5rem; border-bottom: 1px solid var(--mcp-line); overflow-x: auto; }
.secure-mcp-settings .section-tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: .65rem 0; white-space: nowrap; }
.secure-mcp-settings .section-tabs button.active { border-bottom-color: var(--mcp-accent); color: var(--mcp-accent); }
.secure-mcp-settings .content { padding: 1.5rem 0; }
.secure-mcp-settings .page-heading { margin-bottom: 1.25rem; }
.secure-mcp-settings .actions { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.secure-mcp-settings .btn { font: inherit; white-space: normal; }
.secure-mcp-settings .btn-link { color: var(--mcp-accent); }
.secure-mcp-settings .danger { color: var(--mcp-danger); }
.secure-mcp-settings .warning { color: var(--mcp-warning); }
.secure-mcp-settings button:disabled { cursor: default; opacity: .5; }
.secure-mcp-settings button:focus-visible, .secure-mcp-settings input:focus-visible,
.secure-mcp-settings select:focus-visible, .secure-mcp-settings textarea:focus-visible {
  outline: 2px solid var(--mcp-accent); outline-offset: 2px;
}
.secure-mcp-settings input, .secure-mcp-settings select, .secure-mcp-settings textarea {
  font: inherit; color: inherit; background: var(--mcp-bg); border: 1px solid var(--mcp-line);
  border-radius: 5px; padding: .45rem .6rem; min-width: 0; max-width: 100%;
}
.secure-mcp-settings input:not([type=checkbox]), .secure-mcp-settings textarea { width: 100%; }
.secure-mcp-settings input[type=checkbox] { accent-color: var(--mcp-accent); flex: none; }
.secure-mcp-settings textarea { resize: vertical; min-height: 8rem; }
.secure-mcp-settings label { display: block; margin-bottom: .35rem; }
.secure-mcp-settings code, .secure-mcp-settings .command-input, .secure-mcp-settings textarea {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere;
}
.secure-mcp-settings code { color: inherit; }
.secure-mcp-settings .panel { border: 1px solid var(--mcp-line); border-radius: 7px; margin-bottom: 1rem; }
.secure-mcp-settings .panel-head { padding: .8rem 1rem; border-bottom: 1px solid var(--mcp-line); }
.secure-mcp-settings .panel-body { padding: 1rem; }
.secure-mcp-settings .badge, .secure-mcp-settings .count, .secure-mcp-settings .status-pill {
  display: inline-flex; align-items: center; gap: .4rem; border: 1px solid var(--mcp-line);
  border-radius: 5px; padding: .15rem .45rem; color: inherit; font-weight: 400; font-size: .85em;
}
.secure-mcp-settings .status-pill { border-radius: 1rem; }
.secure-mcp-settings .count { margin-left: .3rem; }
.secure-mcp-settings .client-layout { display: grid; grid-template-columns: 12rem minmax(0, 1fr); gap: 1.5rem; align-items: start; }
.secure-mcp-settings .client-sidebar { border: 1px solid var(--mcp-line); border-radius: 7px; overflow: hidden; }
.secure-mcp-settings .list-label { padding: .6rem .8rem; background: var(--mcp-panel); border-bottom: 1px solid var(--mcp-line); }
.secure-mcp-settings .client-choice { display: block; width: 100%; text-align: left; border: 0; border-left: 2px solid transparent; border-radius: 0; padding: .8rem; overflow-wrap: anywhere; }
.secure-mcp-settings .client-choice + .client-choice { border-top: 1px solid var(--mcp-line); }
.secure-mcp-settings .client-choice.active { border-left-color: var(--mcp-accent); background: var(--mcp-panel); color: var(--mcp-accent); }
.secure-mcp-settings .client-details { min-width: 0; }
.secure-mcp-settings .client-title { margin-bottom: 1rem; }
.secure-mcp-settings .create-client { display: flex; align-items: end; gap: .6rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
.secure-mcp-settings .create-client label { flex: 1 1 12rem; margin: 0; }
.secure-mcp-settings .connection-row { display: flex; flex-wrap: wrap; align-items: center; gap: .7rem; padding: 1rem; }
.secure-mcp-settings .connection-row + .connection-row { border-top: 1px solid var(--mcp-line); }
.secure-mcp-settings .connection-info { flex: 1 1 12rem; min-width: 0; overflow-wrap: anywhere; }
.secure-mcp-settings .connection-meta { font-size: .9em; margin-top: .3rem; }
.secure-mcp-settings .quiet-note { padding: 1rem; background: var(--mcp-panel); border-radius: 5px; margin: 1rem 0; }
.secure-mcp-settings .empty-state { padding: 2rem 1.2rem; border: 1px dashed var(--mcp-line); border-radius: 7px; text-align: center; }
.secure-mcp-settings .empty-state .actions { justify-content: center; margin-top: 1rem; }
.secure-mcp-settings .global-summary { margin: 1rem 0; }
.secure-mcp-settings .summary-value { font-size: 2em; font-weight: 600; margin-right: .5rem; }
.secure-mcp-settings .mode-guide { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; margin-bottom: 1.25rem; }
.secure-mcp-settings .mode-card { padding: 1rem; border: 1px solid var(--mcp-line); border-radius: 6px; }
.secure-mcp-settings .ssh-setting-row { display: grid; grid-template-columns: 1.2rem minmax(0, 1fr) minmax(9rem, 13rem); gap: .8rem; padding: 1rem; align-items: start; }
.secure-mcp-settings .ssh-setting-row + .ssh-setting-row { border-top: 1px solid var(--mcp-line); }
.secure-mcp-settings .ssh-setting-row label { overflow-wrap: anywhere; }
.secure-mcp-settings .grant-warning { grid-column: 2 / -1; }
.secure-mcp-settings .editor { min-width: 0; scroll-margin-top: 1rem; display: flex; flex-direction: column; max-height: calc(100vh - 200px); min-height: 320px; }
.secure-mcp-settings .editor-body { overflow-y: auto; min-height: 0; padding-top: 1rem; padding-right: .5rem; scroll-padding: 1rem; }
.secure-mcp-settings .editor-footer { flex: none; }
.secure-mcp-settings .editor-footer .footer-error { flex-basis: 100%; width: 100%; margin: 0; max-height: 6rem; overflow-y: auto; }
.secure-mcp-settings .port-input { max-width: 10rem; }
.secure-mcp-settings .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
.secure-mcp-settings .back-link { padding-left: 0; margin-bottom: .75rem; }
.secure-mcp-settings .editor-input-panel { border-color: var(--mcp-accent); }
.secure-mcp-settings .input-grid { display: grid; grid-template-columns: minmax(9rem, 1fr) minmax(0, 2fr) auto; gap: .75rem; align-items: end; margin-top: .75rem; }
.secure-mcp-settings .input-grid label { margin: 0; }
.secure-mcp-settings .input-grid select { width: 100%; }
.secure-mcp-settings .inherit-row { display: flex; align-items: baseline; gap: .6rem; margin: 1rem 0; }
.secure-mcp-settings .rule-toolbar { margin: 1.25rem 0 .75rem; }
.secure-mcp-settings .rule-list { list-style: none; padding: 0; border: 1px solid var(--mcp-line); border-radius: 6px; margin: 0 0 1rem; }
.secure-mcp-settings .rule-row { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; padding: .75rem 1rem; }
.secure-mcp-settings .rule-row + .rule-row { border-top: 1px solid var(--mcp-line); }
.secure-mcp-settings .rule-command { flex: 1 1 12rem; min-width: 0; }
.secure-mcp-settings .rule-command small { display: block; }
.secure-mcp-settings .rule-actions { display: flex; gap: .5rem; margin-left: auto; }
.secure-mcp-settings .import-panel { padding: 1rem; border: 1px solid var(--mcp-line); border-radius: 6px; background: var(--mcp-panel); margin-bottom: 1rem; }
.secure-mcp-settings .import-preview { margin-top: 1rem; border-top: 1px solid var(--mcp-line); padding-top: 1rem; }
.secure-mcp-settings .editor-footer { position: sticky; bottom: 0; z-index: 2; background: var(--mcp-bg); border-top: 1px solid var(--mcp-line); padding: 1rem 0; margin-top: 1.25rem; }
.secure-mcp-settings .footer-info { flex: 1 1 14rem; }
.secure-mcp-settings .alert { margin: .75rem 0; overflow-wrap: anywhere; }
.secure-mcp-settings dialog { width: min(32rem, calc(100% - 2rem)); max-height: 85vh; overflow-y: auto; color: var(--theme-fg, var(--bs-body-color, CanvasText)); background: var(--mcp-bg); border: 1px solid var(--mcp-line); border-radius: 8px; padding: 1.5rem; }
.secure-mcp-settings dialog::backdrop { background: rgb(0 0 0 / 50%); }
.secure-mcp-settings .dialog-actions { display: flex; justify-content: end; flex-wrap: wrap; gap: .5rem; margin-top: 1.5rem; }
@media (max-width: 900px) {
  .secure-mcp-settings .client-layout { grid-template-columns: 1fr; gap: 1rem; }
  .secure-mcp-settings .client-sidebar { display: flex; flex-wrap: wrap; }
  .secure-mcp-settings .list-label { width: 100%; }
  .secure-mcp-settings .client-choice { width: auto; flex: 1 1 9rem; }
  .secure-mcp-settings .input-grid { grid-template-columns: minmax(8rem, 1fr) minmax(0, 2fr); }
  .secure-mcp-settings .input-grid > button { grid-column: 1 / -1; }
}
@media (max-width: 600px) {
  .secure-mcp-settings .mode-guide, .secure-mcp-settings .input-grid { grid-template-columns: 1fr; }
  .secure-mcp-settings .section-tabs { gap: 1rem; }
  .secure-mcp-settings .ssh-setting-row { grid-template-columns: 1.2rem minmax(0, 1fr); }
  .secure-mcp-settings .ssh-setting-row select { grid-column: 2; }
  .secure-mcp-settings .editor-footer .actions { width: 100%; justify-content: end; }
}
`

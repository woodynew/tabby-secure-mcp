// Execute in the isolated Angular settings render fixture, reloading between cases.
async function checkStaleConnectionSelection() {
  const { component, zone, credentials } = window.settingsFixture;
  credentials.connectionGrants = () => [{ profileId: 'ssh-1', profileDigest: 'old-digest', updatedAt: 0 }];
  zone.run(() => component.onSelectClient('b'));
  await new Promise(resolve => setTimeout(resolve, 40));
  const select = document.querySelector('.connection-row select');
  const apply = document.querySelector('.connection-row button');
  if (component.clientConnectionState(component.selectedClient, component.rows[0]) !== 'stale') throw new Error('Fixture did not produce a stale connection');
  if (select.value !== 'stale' || !select.selectedOptions[0]?.disabled || !apply.disabled) throw new Error('Stale authorization is not selected, or its Apply button is enabled');
  return { selected: select.value, applyDisabled: apply.disabled };
}

async function checkVisibleCommandSetError(kind = 'draft') {
  const { component, zone, credentials } = window.settingsFixture;
  zone.run(() => component.onOpenLowRiskDefaults());
  await new Promise(resolve => setTimeout(resolve, 40));
  if (kind === 'draft') {
    const input = document.querySelector('#command-rule-input');
    input.value = 'pwd';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (kind === 'storage') {
    credentials.setDefaultCommandSet = async () => { throw new Error('simulated storage failure'); };
  } else if (kind === 'conflict') {
    credentials.commandRevision = () => 999;
  } else throw new Error('Unknown test case');
  const body = document.querySelector('.editor-body');
  body.scrollTop = body.scrollHeight;
  await new Promise(resolve => setTimeout(resolve, 40));
  [...document.querySelectorAll('.editor-footer button')].find(button => button.textContent.includes('保存审批命令集')).click();
  await new Promise(resolve => setTimeout(resolve, 40));
  const expected = { draft: 'secureMcp.errorCommandDraft', storage: 'secureMcp.errorCommandSetSave', conflict: 'secureMcp.errorCommandSetConflict' }[kind];
  if (component.commandEditor?.error !== expected) throw new Error('Expected save failure was not retained in the draft');
  const alert = document.querySelector('.editor [role="alert"]');
  if (!alert) throw new Error('Save error is not rendered');
  const rect = alert.getBoundingClientRect();
  const scrollBody = alert.closest('.editor-body');
  const visible = scrollBody ? scrollBody.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  if (rect.top < visible.top || rect.bottom > visible.bottom || rect.top < 0 || rect.bottom > innerHeight) throw new Error('Save error is outside the visible area');
  return { kind, error: expected, visible: true, draftRuleCount: component.commandEditor.rules.length };
}

// Design-only counterexample checks; this is not WeKnora authorization code.
const assert = require('node:assert/strict');
const { validateDocuments } = require('./validate-docs.cjs');
const documentChecks = validateDocuments();

const HOUR = 3600000;
const now = Date.parse('2026-10-08T16:00:00+08:00');
const freshSource = {
  health: 'healthy', status: 'active', mappingActive: true,
  verifiedAt: now - HOUR, degradedAt: null,
};
const user = {
  id: 'U1', tenant: 'T0', source: 'P1', localActive: true, internalToT0: true,
  memberActive: true, sessionRevoked: false, pending: false,
  issuedAt: now - 3 * HOUR, expiresAt: now + 20 * HOUR,
  role: 'viewer', manualAdmin: false, departments: { P1: ['D1'], P2: [] },
  sources: { P1: freshSource, P2: freshSource }, userScopes: [],
};
const sourcePass = (source, issuedAt) => {
  if (!source || !source.mappingActive || source.status !== 'active'
      || !Number.isFinite(source.verifiedAt)) return false;
  const factAge = now - source.verifiedAt;
  if (factAge < 0 || factAge > 24 * HOUR) return false;
  if (source.health === 'healthy') return true;
  return source.health === 'degraded'
    && Number.isFinite(source.degradedAt)
    && issuedAt < source.degradedAt && source.degradedAt <= now
    && now - source.degradedAt <= 24 * HOUR;
};
const sessionPass = (u) => u.localActive && !u.pending && !u.sessionRevoked
  && u.issuedAt <= now && u.expiresAt > now && sourcePass(u.sources[u.source], u.issuedAt);
const READ = ['view', 'query'];
const ALL = [...READ, 'edit_content', 'manage_members', 'manage_settings', 'delete', 'share'];
const roleActions = {
  viewer: READ,
  contributor: [...READ, 'edit_content'],
  admin: ALL,
};
const resources = {
  K1: { id: 'K1', tenant: 'T0', creator: 'U3', bindings: { P1: ['D1'] } },
  K2: { id: 'K2', tenant: 'T0', creator: 'U1', bindings: { P1: ['D1'] } },
  K3: { id: 'K3', tenant: 'T0', creator: 'U2', bindings: { P1: ['D2'], P2: ['D2'] } },
  K4: { id: 'K4', tenant: 'T0', creator: 'U1', bindings: { P1: ['D1'] } },
  K5: { id: 'K5', tenant: 'T0', creator: 'U1', bindings: {} },
  K6: { id: 'K6', tenant: 'T0', creator: 'U1', bindings: {}, publicActions: READ },
  T0: { id: 'T0', tenant: 'T0', workspace: true, bindings: {} },
};
const deptGrant = (u, r, action) =>
  [...READ, 'edit_content'].includes(action)
  && (r.bindings[u.source] || []).some((d) => (u.departments[u.source] || []).includes(d));
const scopePass = (u, r, action, route) => {
  if (r.workspace) return route === 'member';
  const exported = u.tenant === 'T1' && READ.includes(action)
    && ((route === 'share' && r.id === 'K4') || (route === 'agent' && r.id === 'K1'));
  if (u.internalToT0) {
    const internalPass = (u.tenant === r.tenant && u.manualAdmin && u.role === 'admin')
      || (r.publicActions || []).includes(action)
      || deptGrant(u, r, action)
      || u.userScopes.some((s) => s.kb === r.id && s.action === action
        && s.route === route && s.expiresAt > now);
    return internalPass && (u.tenant === r.tenant || exported);
  }
  return exported;
};
const allow = (u, resourceId, action, route = 'member', agentMode = 'selected') => {
  const r = resources[resourceId];
  if (!r || !sessionPass(u) || !u.memberActive || !scopePass(u, r, action, route)) return false;
  if (!roleActions[u.role].includes(action)) return false;
  if (route === 'member') {
    if (u.tenant !== r.tenant) return false;
    return action !== 'edit_content' || u.manualAdmin || r.creator === u.id;
  }
  if (route === 'share') return u.tenant === 'T1' && r.id === 'K4' && READ.includes(action);
  if (route === 'agent') {
    const selected = agentMode === 'all'
      || (agentMode === 'selected' && ['K1', 'K3'].includes(r.id));
    return selected && READ.includes(action);
  }
  return false;
};
const key = {
  revoked: false, expiresAt: now + 20 * HOUR, issuedAt: now - 3 * HOUR,
  resources: ['K1'], actions: READ, principalActive: true, boundUser: null,
};
const keyAllow = (k, id, action) => !k.revoked && k.expiresAt > now
  && k.principalActive && k.resources.includes(id) && k.actions.includes(action)
  && (!k.boundUser || (k.boundUser.localActive && !k.boundUser.pending
    && sourcePass(k.boundUser.sources[k.dependency], k.issuedAt)));

let scenarioCount = 0;
const scenarios = [];
const test = (name, check) => {
  check();
  scenarioCount++;
  scenarios.push(name);
};
const withSource = (delta) => ({ ...user, sources: { ...user.sources, P1: { ...freshSource, ...delta } } });
test('U1 bound K1 read', () => assert.equal(allow(user, 'K1', 'view'), true));
test('U1 unbound department K3 denied despite viewer', () => assert.equal(allow(user, 'K3', 'view'), false));
test('unbound K5 denied even creator', () => assert.equal(allow(user, 'K5', 'view'), false));
test('public read allowed', () => assert.equal(allow(user, 'K6', 'query'), true));
test('public write not implicit', () => assert.equal(allow(user, 'K6', 'edit_content'), false));
const multi = { ...user, id: 'U2', role: 'contributor', departments: { P1: ['D1', 'D2'] } };
test('multi-department union read', () => {
  assert.equal(allow(multi, 'K1', 'view'), true);
  assert.equal(allow(multi, 'K3', 'view'), true);
});
test('multi-department does not bypass ownership', () => assert.equal(allow(multi, 'K1', 'edit_content'), false));
const head = { ...user, id: 'U3', role: 'contributor' };
test('department head own edit', () => assert.equal(allow(head, 'K1', 'edit_content'), true));
test('department head delegated edit gap', () => assert.equal(allow(head, 'K2', 'edit_content'), false));
test('department head cannot manage', () => assert.equal(allow(head, 'T0', 'manage_members'), false));
const admin = { ...user, id: 'U6', role: 'admin', manualAdmin: true };
test('manual admin retains management in ordinary department', () => {
  assert.equal(allow(admin, 'T0', 'manage_members'), true);
  assert.equal(allow(admin, 'T0', 'manage_settings'), true);
});
test('manual admin scope exemption', () => assert.equal(allow(admin, 'K5', 'view'), true));
test('manual admin cannot bypass local block', () => assert.equal(allow({ ...admin, localActive: false }, 'K3', 'view'), false));
const receiver = { ...user, id: 'U7', tenant: 'T1', source: 'P2', internalToT0: false };
test('receiver share K4 read', () => assert.equal(allow(receiver, 'K4', 'view', 'share'), true));
test('share stays read only', () => assert.equal(allow(receiver, 'K4', 'edit_content', 'share'), false));
test('tenant_public not cross-tenant', () => assert.equal(allow(receiver, 'K6', 'view', 'share'), false));
test('switching tenant does not remove internal department gate', () => assert.equal(allow({
  ...user, tenant: 'T1', departments: { P1: ['D2'] },
}, 'K4', 'view', 'share'), false));
test('shared Agent exported selected K1 read', () => assert.equal(allow(receiver, 'K1', 'query', 'agent'), true));
test('shared Agent selected but unexported K3 denied', () => assert.equal(allow(receiver, 'K3', 'view', 'agent'), false));
test('explicit Agent selection not replaced by org share', () => assert.equal(allow(receiver, 'K4', 'view', 'agent'), false));
test('Agent none denied', () => assert.equal(allow(receiver, 'K1', 'view', 'agent', 'none'), false));
test('Agent all does not bypass department', () => assert.equal(allow(user, 'K3', 'query', 'agent', 'all'), false));
test('disabled source denied', () => assert.equal(sessionPass(withSource({ status: 'disabled' })), false));
test('deleted source denied', () => assert.equal(sessionPass(withSource({ status: 'deleted' })), false));
test('revoked Token denied', () => assert.equal(sessionPass({ ...user, sessionRevoked: true }), false));
test('revocation pending blocks', () => assert.equal(sessionPass({ ...user, pending: true }), false));
test('expired Token denied', () => assert.equal(sessionPass({ ...user, expiresAt: now }), false));
test('future Token issuance denied', () => assert.equal(sessionPass({ ...user, issuedAt: now + 1 }), false));
test('degraded old Token both ages fresh', () => assert.equal(sessionPass(withSource({ health: 'degraded', degradedAt: now - 2 * HOUR })), true));
test('25h fact 2h degraded counterexample denied', () => assert.equal(sessionPass(withSource({ health: 'degraded', degradedAt: now - 2 * HOUR, verifiedAt: now - 25 * HOUR })), false));
test('healthy does not bypass 25h fact', () => assert.equal(sessionPass(withSource({ verifiedAt: now - 25 * HOUR })), false));
test('degraded 25h even fresh fact denied', () => assert.equal(sessionPass({ ...withSource({ health: 'degraded', degradedAt: now - 25 * HOUR }), issuedAt: now - 26 * HOUR }), false));
test('exact 24h fact allowed', () => assert.equal(sessionPass(withSource({ verifiedAt: now - 24 * HOUR })), true));
test('over 24h fact denied', () => assert.equal(sessionPass(withSource({ verifiedAt: now - 24 * HOUR - 1 })), false));
test('exact 24h degraded boundary allowed', () => assert.equal(sessionPass({ ...withSource({ health: 'degraded', degradedAt: now - 24 * HOUR }), issuedAt: now - 25 * HOUR }), true));
test('missing confirmation denied', () => assert.equal(sessionPass(withSource({ verifiedAt: null })), false));
test('future confirmation denied', () => assert.equal(sessionPass(withSource({ verifiedAt: now + 1 })), false));
test('Token equal to degraded start denied', () => assert.equal(sessionPass({ ...withSource({ health: 'degraded', degradedAt: now - 2 * HOUR }), issuedAt: now - 2 * HOUR }), false));
test('future degraded start denied', () => assert.equal(sessionPass(withSource({ health: 'degraded', degradedAt: now + 1 })), false));
test('missing degraded start denied', () => assert.equal(sessionPass(withSource({ health: 'degraded', degradedAt: null })), false));
test('missing authentication source denied', () => assert.equal(sessionPass({ ...user, source: 'missing' }), false));
test('provider disabled denied', () => assert.equal(sessionPass(withSource({ health: 'disabled' })), false));
const rebound = {
  ...user, id: 'U8', source: 'P2',
  issuedAt: now - 0.5 * HOUR,
  departments: { P1: ['D1'], P2: ['D2'] },
  sources: { P1: { ...freshSource, status: 'disabled' }, P2: freshSource },
};
test('P2 new login allowed after P1 disable', () => assert.equal(allow(rebound, 'K3', 'view'), true));
test('P2 new login cannot reuse P1 department', () => assert.equal(allow(rebound, 'K1', 'view'), false));
test('all old P2 sessions revoked on P1 event', () => assert.equal(sessionPass({ ...rebound, sessionRevoked: true }), false));
test('independent scoped Key read', () => assert.equal(keyAllow(key, 'K1', 'query'), true));
test('Key cannot borrow human resource scope', () => assert.equal(keyAllow(key, 'K3', 'view'), false));
test('Key cannot borrow human action', () => assert.equal(keyAllow(key, 'K1', 'edit_content'), false));
test('independent Key does not depend on provider outage', () => assert.equal(keyAllow(key, 'K1', 'view'), true));
test('old bound Key revoked despite P2 new login', () => assert.equal(keyAllow({ ...key, revoked: true, boundUser: rebound, dependency: 'P2' }, 'K1', 'view'), false));
test('bound Key cannot use disabled dependency', () => assert.equal(keyAllow({ ...key, boundUser: rebound, dependency: 'P1' }, 'K1', 'view'), false));
test('bound Key stale identity rejected', () => assert.equal(keyAllow({
  ...key, boundUser: withSource({ verifiedAt: now - 25 * HOUR, health: 'degraded', degradedAt: now - 2 * HOUR }), dependency: 'P1',
}, 'K1', 'view'), false));
test('bound Key local block rejected', () => assert.equal(keyAllow({ ...key, boundUser: { ...user, localActive: false }, dependency: 'P1' }, 'K1', 'view'), false));
test('expired user scope does not open K3', () => assert.equal(allow({
  ...user, userScopes: [{ kb: 'K3', action: 'view', route: 'member', expiresAt: now }],
}, 'K3', 'view'), false));
test('precise live user scope opens one action', () => {
  const u = { ...user, userScopes: [{ kb: 'K3', action: 'view', route: 'member', expiresAt: now + HOUR }] };
  assert.equal(allow(u, 'K3', 'view'), true);
  assert.equal(allow(u, 'K3', 'query'), false);
});
test('department move removes old range', () => assert.equal(allow({
  ...user, departments: { P1: ['D2'] },
}, 'K1', 'view'), false));

const baseState = {
  snapshot: 10, scope: 1, config: 1, policy: 1, complete: true,
  sourceRecord: 7, securityEvent: 1,
  target: { value: 'viewer', version: 7, fieldVersion: 7, owner: 'P1', change: 'previous' },
  writes: 0, securityBlocked: false,
};
const plan = {
  snapshot: 10, scope: 1, config: 1, policy: 1,
  sourceRecord: 7, securityEvent: 1,
  hash: 'fixed', approvedHash: 'fixed', expiresAt: now + HOUR,
  targetVersion: 7, fieldVersion: 7, owner: 'P1', lastChange: 'previous',
  before: 'viewer', after: 'contributor', change: 'A',
};
const apply = (state, p) => {
  if (!state.complete || p.expiresAt <= now || p.hash !== p.approvedHash
      || ['snapshot', 'scope', 'config', 'policy', 'sourceRecord', 'securityEvent']
        .some((field) => p[field] !== state[field])) return 'stale_plan';
  const t = state.target;
  if (t.version !== p.targetVersion || t.fieldVersion !== p.fieldVersion
      || t.owner !== p.owner || t.change !== p.lastChange) return 'conflict';
  t.value = p.after;
  t.version++;
  t.fieldVersion++;
  t.change = p.change;
  state.writes++;
  return 'applied';
};
const rollback = (state, change) => {
  const t = state.target;
  if (state.securityBlocked || t.value !== change.after
      || t.version !== change.postVersion || t.fieldVersion !== change.postFieldVersion
      || t.owner !== change.owner || t.change !== change.change) return 'rollback_conflict';
  t.value = change.before;
  t.version++;
  t.fieldVersion++;
  t.change = 'rollback:' + change.change;
  state.writes++;
  return 'rolled_back';
};
test('old active approval cannot restore later disabled', () => {
  const s = { ...structuredClone(baseState), snapshot: 11,
    target: { value: 'disabled', version: 8, fieldVersion: 8, owner: 'P1', change: 'B' } };
  assert.equal(apply(s, plan), 'stale_plan');
  assert.equal(s.writes, 0);
  assert.equal(s.target.value, 'disabled');
});
for (const field of ['scope', 'config', 'policy', 'sourceRecord', 'securityEvent']) {
  test(`changed ${field} invalidates approval`, () => {
    const s = structuredClone(baseState);
    s[field]++;
    assert.equal(apply(s, plan), 'stale_plan');
    assert.equal(s.writes, 0);
  });
}
test('approval expires', () => assert.equal(apply(structuredClone(baseState), { ...plan, expiresAt: now }), 'stale_plan'));
test('approval hash mismatch', () => assert.equal(apply(structuredClone(baseState), { ...plan, hash: 'changed' }), 'stale_plan'));
test('incomplete source not applied', () => assert.equal(apply({ ...structuredClone(baseState), complete: false }, plan), 'stale_plan'));
test('target version changed conflict', () => {
  const s = structuredClone(baseState);
  s.target.version++;
  assert.equal(apply(s, plan), 'conflict');
  assert.equal(s.writes, 0);
});
test('field owner changed conflict', () => {
  const s = structuredClone(baseState);
  s.target.owner = 'manual';
  assert.equal(apply(s, plan), 'conflict');
});
const change = { ...plan, postVersion: 8, postFieldVersion: 8 };
test('fresh apply and rollback advances versions', () => {
  const s = structuredClone(baseState);
  assert.equal(apply(s, plan), 'applied');
  assert.equal(rollback(s, change), 'rolled_back');
  assert.equal(s.target.value, 'viewer');
  assert.equal(s.target.version, 9);
  assert.equal(rollback(s, change), 'rollback_conflict');
});
test('ABA same final value rollback rejected', () => {
  const s = structuredClone(baseState);
  assert.equal(apply(s, plan), 'applied');
  s.target.value = 'admin'; s.target.version++; s.target.fieldVersion++; s.target.change = 'manual1';
  s.target.value = 'contributor'; s.target.version++; s.target.fieldVersion++; s.target.change = 'manual2';
  assert.equal(rollback(s, change), 'rollback_conflict');
  assert.equal(s.target.value, 'contributor');
});
test('security block not undone by rollback', () => {
  const s = structuredClone(baseState);
  apply(s, plan);
  s.securityBlocked = true;
  assert.equal(rollback(s, change), 'rollback_conflict');
});
test('later change attribution rejects rollback even equal value', () => {
  const s = structuredClone(baseState);
  apply(s, plan);
  s.target.change = 'later';
  assert.equal(rollback(s, change), 'rollback_conflict');
});
const acceptSnapshot = (state, incoming, complete) => {
  if (!complete || incoming <= state.snapshot) return false;
  state.snapshot = incoming;
  return true;
};
test('late lower snapshot rejected', () => {
  const s = structuredClone(baseState);
  assert.equal(acceptSnapshot(s, 11, true), true);
  assert.equal(acceptSnapshot(s, 10, true), false);
  assert.equal(s.snapshot, 11);
});

console.log(JSON.stringify({
  documentChecks,
  designCounterexamples: { passed: scenarioCount, failed: 0, scenarios },
  scope: 'Static document checks and simplified design counterexamples only; no application or integration tests.',
}, null, 2));

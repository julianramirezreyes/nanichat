import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { classifyForModeration } from '../src/services/moderation-rules.js';
import * as moderation from '../src/services/moderation.js';
import { migrateDatabase } from '../src/db/migrations.js';
import { randomUUID } from 'node:crypto';
import type { SocialProvider, ModerationResult } from '../src/core/domain.js';
import { ownerRepliedParentIds, claimingAutomations, classifyComment } from '../src/services/automations.js';

test('classifyForModeration', () => {
  const defaults = { enabled: true, blockedTerms: [], detectLinks: false, detectPhones: false, detectMentions: false, detectEmoji: false, autoHideEnabled: false, autoHideCategories: [] };
  
  assert.equal(classifyForModeration({ commentId: '1', text: 'hola' }, 'owner', defaults).flagged, false);
  
  // owner not flagged
  assert.equal(classifyForModeration({ commentId: '1', text: 'compra en bit.ly', username: 'Owner' }, 'owner', { ...defaults, detectLinks: true }).flagged, false);

  // priority: blocked_term > spam_link > spam_phone > spam_mentions > spam_emoji
  const all = { ...defaults, blockedTerms: ['oferta'], detectLinks: true, detectPhones: true, detectMentions: true, detectEmoji: true };
  const resAll = classifyForModeration({ commentId: '1', text: 'mira esta oferta en http://a.com llama al +34 600 123 456 @a @b @c 😂😂😂😂😂😂' }, 'other', all);
  assert.equal(resAll.flagged, true);
  assert.equal(resAll.category, 'blocked_term');
  assert.equal(resAll.reasons.length, 5);

  // spam_emoji
  const resEmoji = classifyForModeration({ commentId: '1', text: 'hola 😂😂😂😂😂😂' }, 'other', all);
  assert.equal(resEmoji.category, 'spam_emoji');

  const resEmoji2 = classifyForModeration({ commentId: '1', text: '😂😂😂😂😂😂😂😂😂😂' }, 'other', all);
  assert.equal(resEmoji2.category, 'spam_emoji');

  // spam_mentions
  const resMentions = classifyForModeration({ commentId: '1', text: 'ey @a @b @c' }, 'other', all);
  assert.equal(resMentions.category, 'spam_mentions');
});

async function withDb(fn: (db: DatabaseSync) => any) {
  const db = new DatabaseSync(':memory:');
  try {
    migrateDatabase(db);
    db.prepare('PRAGMA foreign_keys = ON').run();
    await fn(db);
  } finally {
    db.close();
  }
}

test('moderation DB migration and actions', () => {
  return withDb((db) => {
    db.exec(`
      INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at)
        VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc1', 'conn1', 'ig1', 'u1', 'u1', 'valid', '2026', '2026');
      INSERT INTO media(media_id, account_id, permalink, published_at, last_seen_at) VALUES ('m1', 'acc1', 'p', '2026', '2026');
      INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at) VALUES ('c1', 'acc1', 'm1', 'text', 'user', '2026', '2026', '2026');
      INSERT OR REPLACE INTO app_state(state_key, state_value, updated_at) VALUES ('dry_run', 'false', '2026');
    `);

    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 17);
    db.exec(`INSERT INTO moderation_actions(action_id, flag_id, account_id, comment_id, action, actor, mode, outcome, created_at)
      VALUES ('a0', 'f0', 'acc1', 'c1', 'hide', 'operator', 'dry_run', 'simulated', '2026')`);
    assert.throws(() => db.exec(`UPDATE moderation_actions SET outcome='accepted' WHERE action_id='a0'`), /append-only/);
    assert.throws(() => db.exec(`DELETE FROM moderation_actions WHERE action_id='a0'`), /append-only/);

    // default settings
    const settings = moderation.getSettings(db, 'acc1');
    assert.equal(settings.enabled, false);

    moderation.updateSettings(db, 'acc1', { ...settings, enabled: true, autoHideEnabled: true, autoHideCategories: ['spam_link'] }, true);
    db.exec(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id='acc1'`);

    const updated = moderation.getSettings(db, 'acc1');
    assert.equal(updated.enabled, true);

    db.exec(`
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
      VALUES ('f1', 'acc1', 'm1', 'c1', 'spam_link', 'rules', '[]', 'PENDING', '${new Date(Date.now() + 1000).toISOString()}', '2026', 1);
    `);

    // Auto-hide compares the comment date: c1 is published after auto-hide was switched on.
    db.prepare(`UPDATE comments SET created_at=? WHERE comment_id='c1'`).run(new Date(Date.now() + 1000).toISOString());
    let hideCalled = 0;
    const provider: SocialProvider = {
      async setCommentHidden() { hideCalled++; return { status: 'accepted' }; },
      async deleteComment() { return { status: 'accepted' }; }
    } as any;

    return moderation.processAutoHide(db, provider).then(() => {
      assert.equal(hideCalled, 1);
      const flag = db.prepare(`SELECT state, last_action FROM moderation_flags WHERE flag_id='f1'`).get() as any;
      assert.equal(flag.state, 'HIDDEN');
      assert.equal(flag.last_action, 'hide');
    });
  });
});

test('moderation action dry_run', async () => {
  return withDb((db) => {
    db.exec(`
      INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at)
        VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc1', 'conn1', 'ig1', 'u1', 'u1', 'valid', '2026', '2026');
      INSERT INTO media(media_id, account_id, permalink, published_at, last_seen_at) VALUES ('m1', 'acc1', 'p', '2026', '2026');
      INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at) VALUES ('c1', 'acc1', 'm1', 'text', 'user', '2026', '2026', '2026');
      INSERT OR REPLACE INTO app_state(state_key, state_value, updated_at) VALUES ('dry_run', 'true', '2026');
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
      VALUES ('f1', 'acc1', 'm1', 'c1', 'spam_link', 'rules', '[]', 'PENDING', '2026', '2026', 1);
    `);

    let hideCalled = 0;
    const provider: SocialProvider = {
      async setCommentHidden() { hideCalled++; return { status: 'accepted' }; },
    } as any;

    return moderation.act(db, provider, 'acc1', 'f1', 'hide', 'operator').then(() => {
      assert.equal(hideCalled, 0);
      const flag = db.prepare(`SELECT state, last_action FROM moderation_flags WHERE flag_id='f1'`).get() as any;
      assert.equal(flag.state, 'SIMULATED');
      assert.equal(flag.last_action, 'hide');
    });
  });
});

test('moderation action real mode: accepted, unhide, delete', async () => {
  return withDb((db) => {
    db.exec(`
      INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at)
        VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc1', 'conn1', 'ig1', 'u1', 'u1', 'valid', '2026', '2026');
      INSERT INTO media(media_id, account_id, permalink, published_at, last_seen_at) VALUES ('m1', 'acc1', 'p', '2026', '2026');
      INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at) VALUES ('c1', 'acc1', 'm1', 'text', 'user', '2026', '2026', '2026');
      INSERT OR REPLACE INTO app_state(state_key, state_value, updated_at) VALUES ('dry_run', 'false', '2026');
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
      VALUES ('f1', 'acc1', 'm1', 'c1', 'spam_link', 'rules', '[]', 'PENDING', '2026', '2026', 1);
    `);

    let providerCalled = 0;
    const provider: SocialProvider = {
      async setCommentHidden() { providerCalled++; return { status: 'accepted' }; },
      async deleteComment() { providerCalled++; return { status: 'accepted' }; }
    } as any;

    return moderation.act(db, provider, 'acc1', 'f1', 'hide', 'operator').then(() => {
      assert.equal(providerCalled, 1);
      let flag = db.prepare(`SELECT state, last_action FROM moderation_flags WHERE flag_id='f1'`).get() as any;
      assert.equal(flag.state, 'HIDDEN');
      
      return moderation.act(db, provider, 'acc1', 'f1', 'unhide', 'operator');
    }).then(() => {
      assert.equal(providerCalled, 2);
      let flag = db.prepare(`SELECT state, last_action FROM moderation_flags WHERE flag_id='f1'`).get() as any;
      assert.equal(flag.state, 'VISIBLE');

      return moderation.act(db, provider, 'acc1', 'f1', 'delete', 'operator', true);
    }).then(() => {
      assert.equal(providerCalled, 3);
      let flag = db.prepare(`SELECT state, last_action FROM moderation_flags WHERE flag_id='f1'`).get() as any;
      assert.equal(flag.state, 'DELETED');
    });
  });
});

test('moderation action real mode: provider throws ends in UNKNOWN_OUTCOME', async () => {
  return withDb((db) => {
    db.exec(`
      INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at)
        VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc1', 'conn1', 'ig1', 'u1', 'u1', 'valid', '2026', '2026');
      INSERT INTO media(media_id, account_id, permalink, published_at, last_seen_at) VALUES ('m1', 'acc1', 'p', '2026', '2026');
      INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at) VALUES ('c1', 'acc1', 'm1', 'text', 'user', '2026', '2026', '2026');
      INSERT OR REPLACE INTO app_state(state_key, state_value, updated_at) VALUES ('dry_run', 'false', '2026');
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
      VALUES ('f1', 'acc1', 'm1', 'c1', 'spam_link', 'rules', '[]', 'PENDING', '2026', '2026', 1);
    `);

    const provider: SocialProvider = {
      async setCommentHidden() { throw new Error('Network timeout'); }
    } as any;

    return moderation.act(db, provider, 'acc1', 'f1', 'hide', 'operator').then(() => {
      const flag = db.prepare(`SELECT state, safe_error_code FROM moderation_flags WHERE flag_id='f1'`).get() as any;
      assert.equal(flag.state, 'UNKNOWN_OUTCOME');
      assert.equal(flag.safe_error_code, 'moderation_ambiguous');
      const action = db.prepare(`SELECT outcome, safe_error_code FROM moderation_actions WHERE flag_id='f1' AND mode='real' ORDER BY rowid DESC LIMIT 1`).get() as any;
      assert.equal(action.outcome, 'ambiguous');
      assert.equal(action.safe_error_code, 'moderation_ambiguous');
    });
  });
});

import { createServer } from 'node:http';
import { createApiHandler } from '../src/http/router.js';

function withApi(fn: (baseUrl: string, db: DatabaseSync, provider: SocialProvider) => Promise<void>) {
  return withDb(async (db) => {
    db.exec(`
      INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at)
        VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc1', 'conn1', 'ig1', 'u1', 'u1', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc2', 'conn1', 'ig2', 'u2', 'u2', 'valid', '2026', '2026');
      INSERT INTO media(media_id, account_id, permalink, published_at, last_seen_at) VALUES ('m1', 'acc1', 'p', '2026', '2026');
      INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at) VALUES ('c1', 'acc1', 'm1', 'text', 'user', '2026', '2026', '2026');
      INSERT OR REPLACE INTO app_state(state_key, state_value, updated_at) VALUES ('dry_run', 'false', '2026');
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
      VALUES ('f1', 'acc1', 'm1', 'c1', 'spam_link', 'rules', '[]', 'PENDING', '2026', '2026', 1);
    `);

    const provider: SocialProvider = {
      async setCommentHidden() { return { status: 'accepted' }; },
      async deleteComment() { return { status: 'accepted' }; }
    } as any;

    const deps = { database: db, provider, automations: {} as any, scanner: {} as any, backlog: {} as any, queue: {} as any, legacy: undefined, csrfToken: 'any' };
    const server = createServer(createApiHandler(deps));
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const port = (server.address() as any).port;
    try {
      await fn(`http://127.0.0.1:${port}`, db, provider);
    } finally {
      server.close();
    }
  });
}

test('moderation API error codes and CSRF', async () => {
  return withApi(async (baseUrl, db) => {
    // CSRF required
    const noCsrf = await fetch(baseUrl + '/api/moderation/flags/f1/hide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc1' })
    });
    assert.equal(noCsrf.status, 403);

    // DTO secret check: response of getSettings/listFlags should not contain secrets
    const getList = await fetch(baseUrl + '/api/moderation/flags?accountId=acc1');
    assert.equal(getList.status, 200);
    const listBody = await getList.json();
    assert.equal(listBody.items[0].flagId, 'f1');
    assert.equal(Object.keys(listBody.items[0]).includes('token'), false);

    // delete without confirmed -> 400
    const noConfirm = await fetch(baseUrl + '/api/moderation/flags/f1/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'any', 'origin': baseUrl },
      body: JSON.stringify({ accountId: 'acc1' })
    });
    assert.equal(noConfirm.status, 400);
    assert.equal((await noConfirm.json()).error, 'confirmation_required');

    // PUT settings with autoHideEnabled and no confirmed -> 400
    const settingsNoConfirm = await fetch(baseUrl + '/api/moderation/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'any', 'origin': baseUrl },
      body: JSON.stringify({ accountId: 'acc1', autoHideEnabled: true })
    });
    assert.equal(settingsNoConfirm.status, 400);
    assert.equal((await settingsNoConfirm.json()).error, 'confirmation_required');

    // flag of account B requested with accountId A -> 404
    const wrongAcc = await fetch(baseUrl + '/api/moderation/flags/f1/hide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'any', 'origin': baseUrl },
      body: JSON.stringify({ accountId: 'acc2' })
    });
    assert.equal(wrongAcc.status, 404);
    assert.equal((await wrongAcc.json()).error, 'not_found');

    // invalid_state
    db.prepare("UPDATE moderation_flags SET state='UNKNOWN_OUTCOME' WHERE flag_id='f1'").run();
    const invalidState = await fetch(baseUrl + '/api/moderation/flags/f1/hide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'any', 'origin': baseUrl },
      body: JSON.stringify({ accountId: 'acc1' })
    });
    assert.equal(invalidState.status, 409);
    assert.equal((await invalidState.json()).error, 'invalid_state');
  });
});

test('processAutoHide head-of-line blocking and spacing', async () => {
  return withDb(async (db) => {
    db.exec(`
      INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at)
        VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc1', 'conn1', 'ig1', 'u1', 'u1', 'valid', '2026', '2026');
      INSERT INTO media(media_id, account_id, permalink, published_at, last_seen_at) VALUES ('m1', 'acc1', 'p', '2026', '2026');
      INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at) VALUES ('c1', 'acc1', 'm1', 't', 'u', '2026-01-01T00:00:00+0000', '2026', '2026');
      INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at) VALUES ('c2', 'acc1', 'm1', 't', 'u', '2026-01-01T00:00:00+0000', '2026', '2026');
      INSERT OR REPLACE INTO app_state(state_key, state_value, updated_at) VALUES ('dry_run', 'false', '2026');
      UPDATE social_accounts SET monitoring_paused=0;
      INSERT INTO moderation_settings(account_id, enabled, auto_hide_enabled, auto_hide_categories_json, auto_hide_since, updated_at)
        VALUES ('acc1', 1, 1, '["spam_link"]', '2025-01-01T00:00:00.000Z', '2026');
      -- older flag has unallowed category 'spam_phone'
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
        VALUES ('f1', 'acc1', 'm1', 'c1', 'spam_phone', 'rules', '[]', 'PENDING', '2026-01-01T00:00:00.000Z', '2026', 1);
      -- newer flag has allowed category 'spam_link'
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
        VALUES ('f2', 'acc1', 'm1', 'c2', 'spam_link', 'rules', '[]', 'PENDING', '2026-01-02T00:00:00.000Z', '2026', 1);
    `);

    let hideCalled = 0;
    const provider: SocialProvider = {
      async setCommentHidden() { hideCalled++; return { status: 'accepted' }; }
    } as any;

    // Call 1: should skip f1 and process f2
    await moderation.processAutoHide(db, provider);
    assert.equal(hideCalled, 1);
    const flag2 = db.prepare(`SELECT state FROM moderation_flags WHERE flag_id='f2'`).get() as any;
    assert.equal(flag2.state, 'HIDDEN');

    const flag1 = db.prepare(`SELECT state FROM moderation_flags WHERE flag_id='f1'`).get() as any;
    assert.equal(flag1.state, 'PENDING');

    // Call 2: should do nothing because of 10s spacing
    db.exec(`
      INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at) VALUES ('c3', 'acc1', 'm1', 't', 'u', '2026-01-01T00:00:00+0000', '2026', '2026');
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
        VALUES ('f3', 'acc1', 'm1', 'c3', 'spam_link', 'rules', '[]', 'PENDING', '2026-01-03T00:00:00.000Z', '2026', 1);
    `);

    // Less than 10 s since the last auto action: nothing happens.
    await moderation.processAutoHide(db, provider);
    assert.equal(hideCalled, 1);

    // More than 10 s later: the next allowed flag is hidden.
    db.prepare(`UPDATE app_state SET state_value=? WHERE state_key='moderation_last_auto_at'`).run(new Date(Date.now() - 10_001).toISOString());
    await moderation.processAutoHide(db, provider);
    assert.equal(hideCalled, 2);
    assert.equal((db.prepare(`SELECT state FROM moderation_flags WHERE flag_id='f3'`).get() as any).state, 'HIDDEN');
  });
});

test('recoverInterrupted sets *_INTENT to UNKNOWN_OUTCOME', async () => {
  return withDb(async (db) => {
    db.exec(`
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
        VALUES ('f1', 'acc1', 'm1', 'c1', 'spam_link', 'rules', '[]', 'HIDE_INTENT', '2026', '2026', 1);
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
        VALUES ('f2', 'acc1', 'm1', 'c2', 'spam_link', 'rules', '[]', 'UNHIDE_INTENT', '2026', '2026', 1);
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
        VALUES ('f3', 'acc1', 'm1', 'c3', 'spam_link', 'rules', '[]', 'DELETE_INTENT', '2026', '2026', 1);
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
        VALUES ('f4', 'acc1', 'm1', 'c4', 'spam_link', 'rules', '[]', 'PENDING', '2026', '2026', 1);
    `);

    moderation.recoverInterrupted(db);

    const states = db.prepare(`SELECT state FROM moderation_flags ORDER BY flag_id`).all() as any[];
    assert.equal(states[0].state, 'UNKNOWN_OUTCOME');
    assert.equal(states[1].state, 'UNKNOWN_OUTCOME');
    assert.equal(states[2].state, 'UNKNOWN_OUTCOME');
    assert.equal(states[3].state, 'PENDING');
  });
});

test('scanner: flags created only when moderation enabled, idempotent, owner comments skipped, no provider calls', async () => {
  return withDb(async (db) => {
    db.exec(`
      INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at)
        VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc1', 'conn1', 'ig1', 'brand', 'brand', 'valid', '2026', '2026');
      INSERT INTO media(media_id, account_id, permalink, published_at, last_seen_at) VALUES ('m1', 'acc1', 'p', '2026', '2026');
    `);

    let hideCalled = 0;
    let deleteCalled = 0;
    const provider: SocialProvider = {
      async setCommentHidden() { hideCalled++; return { status: 'accepted' }; },
      async deleteComment() { deleteCalled++; return { status: 'accepted' }; },
      async listComments() { return { items: [{ commentId: 'c1', text: 'http://spam.com', username: 'spammer' }, { commentId: 'c2', text: 'http://spam.com', username: 'brand' }], complete: true }; }
    } as any;

    const { Scanner } = await import('../src/services/scanner.ts');
    const scanner = new Scanner(db, provider);

    // 1. Not enabled initially
    await scanner.scanMedia({ accountId: 'acc1', username: 'brand', providerAccountId: 'ig1', connectionId: 'conn1' } as any, 'm1', { kind: 'backlog' });
    const flagsBefore = db.prepare(`SELECT count(*) as c FROM moderation_flags`).get() as any;
    assert.equal(flagsBefore.c, 0);

    // 2. Enable it
    db.exec(`INSERT INTO moderation_settings(account_id, enabled, updated_at) VALUES ('acc1', 1, '2026')`);
    
    // Scan again
    await scanner.scanMedia({ accountId: 'acc1', username: 'brand', providerAccountId: 'ig1', connectionId: 'conn1' } as any, 'm1', { kind: 'backlog' });
    
    const flags = db.prepare(`SELECT comment_id FROM moderation_flags`).all() as any[];
    // spamer flagged, brand (owner) skipped
    assert.equal(flags.length, 1);
    assert.equal(flags[0].comment_id, 'c1');

    // 3. Idempotent
    await scanner.scanMedia({ accountId: 'acc1', username: 'brand', providerAccountId: 'ig1', connectionId: 'conn1' } as any, 'm1', { kind: 'backlog' });
    const flagsAfter = db.prepare(`SELECT count(*) as c FROM moderation_flags`).get() as any;
    assert.equal(flagsAfter.c, 1);

    // 4. No provider calls
    assert.equal(hideCalled, 0);
    assert.equal(deleteCalled, 0);
  });
});

test('provider: fake fetch HTTP mapping for moderation', async () => {
  return withDb(async (db) => {
    db.exec(`
      INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at, access_token_nonce, access_token_ciphertext, access_token_tag)
        VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026', 'iv', 'cipher', 'tag');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc1', 'conn1', 'ig1', 'u1', 'u1', 'valid', '2026', '2026');
      INSERT INTO media(media_id, account_id, permalink, published_at, last_seen_at) VALUES ('m1', 'acc1', 'p', '2026', '2026');
      INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at) VALUES ('c1', 'acc1', 'm1', 't', 'u', '2026-01-01T00:00:00+0000', '2026', '2026');
    `);

    let responseStatus = 200;
    let responseBody: any = { success: true };
    let requestMethod = '';
    let requestBody = '';
    let requestUrl = '';

    const fetcher: typeof fetch = async (input, init = {}) => {
      requestMethod = init.method || 'GET';
      requestBody = init.body as string || '';
      requestUrl = input.toString();
      const r = Response.json(responseBody, { status: responseStatus });
      Object.defineProperty(r, 'url', { value: requestUrl });
      return r as any;
    };

    const { MetaProvider } = await import('../src/providers/meta/provider.ts');
    const vault = { decrypt() { return JSON.stringify({ token: 't' }); } } as any;
    const provider = new MetaProvider(db, vault, fetcher);
    const acc = { accountId: 'acc1', connectionId: 'conn1', providerAccountId: 'ig1' } as any;

    // 1. accepted hide
    let res = await provider.setCommentHidden(acc, 'c1', true);
    assert.equal(res.status, 'accepted');
    assert.equal(requestMethod, 'POST');
    assert.equal(requestBody, '{"hide":true}');
    assert.ok(requestUrl.includes('graph.instagram.com/v17.0/c1'));

    // 2. accepted delete
    res = await provider.deleteComment(acc, 'c1');
    assert.equal(res.status, 'accepted');
    assert.equal(requestMethod, 'DELETE');
    assert.ok(requestUrl.includes('graph.instagram.com/v17.0/c1'));

    // 3. 429 rate limit
    responseStatus = 429; responseBody = { error: { code: 429 } };
    res = await provider.setCommentHidden(acc, 'c1', true);
    assert.equal(res.status, 'rejected');
    assert.equal(res.safeErrorCode, 'moderation_rate_limited');

    // 4. Permission (code 10)
    responseStatus = 403; responseBody = { error: { code: 10 } };
    res = await provider.setCommentHidden(acc, 'c1', true);
    assert.equal(res.status, 'rejected');
    assert.equal(res.safeErrorCode, 'moderation_permission_denied');

    // 5. Code 100 not found (meta API error but HTTP 400 or 404)
    responseStatus = 400; responseBody = { error: { code: 100 } };
    res = await provider.setCommentHidden(acc, 'c1', true);
    assert.equal(res.status, 'rejected');
    assert.equal(res.safeErrorCode, 'moderation_not_found');

    // 6. 5xx ambiguous
    responseStatus = 503; responseBody = { error: { code: 1 } };
    res = await provider.setCommentHidden(acc, 'c1', true);
    assert.equal(res.status, 'ambiguous');

    // 7. 200 without success:true
    responseStatus = 200; responseBody = { success: false };
    res = await provider.setCommentHidden(acc, 'c1', true);
    assert.equal(res.status, 'ambiguous');

    // 8. Reject without HTTP call if comment does not exist in DB
    requestMethod = 'NONE';
    res = await provider.setCommentHidden(acc, 'c_missing', true);
    assert.equal(res.status, 'rejected');
    assert.equal(res.safeErrorCode, 'comment_not_owned');
    assert.equal(requestMethod, 'NONE');
  });
});

test('updateSettings validation: categories, terms length, deduping', async () => {
  return withDb(async (db) => {
    db.exec(`
      INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at)
        VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc1', 'conn1', 'ig1', 'u1', 'u1', 'valid', '2026', '2026');
    `);

    // 1. Invalid category
    assert.throws(() => {
      moderation.updateSettings(db, 'acc1', {
        enabled: true, blockedTerms: [], detectLinks: false, detectPhones: false, detectMentions: false, detectEmoji: false,
        autoHideEnabled: true, autoHideCategories: ['invalid_cat'] as any
      }, true);
    }, /invalid_category/);

    // 2. Term too long
    assert.throws(() => {
      moderation.updateSettings(db, 'acc1', {
        enabled: true, blockedTerms: ['a'.repeat(61)], detectLinks: false, detectPhones: false, detectMentions: false, detectEmoji: false,
        autoHideEnabled: true, autoHideCategories: ['spam_link']
      }, true);
    }, /blocked_term_invalid/);

    // 3. Deduplication
    moderation.updateSettings(db, 'acc1', {
      enabled: true, blockedTerms: ['Café', 'cafe', 'CAFE', '  Cafe  ', 'other'], detectLinks: false, detectPhones: false, detectMentions: false, detectEmoji: false,
      autoHideEnabled: false, autoHideCategories: []
    }, true);
    
    const settings = moderation.getSettings(db, 'acc1');
    assert.deepEqual(settings.blockedTerms, ['Café', 'other']);
  });
});

test('B. Bulk Actions & Idempotency', async (t) => {
  return withDb(async (db) => {
    db.exec(`
      INSERT OR REPLACE INTO app_state(state_key, state_value, updated_at) VALUES ('dry_run', 'false', '2026');
      INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at) VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at) VALUES ('acc1', 'conn1', 'ig1', 'u1', 'u1', 'valid', '2026', '2026');
      INSERT INTO media(media_id, account_id, permalink, published_at, last_seen_at) VALUES ('m1', 'acc1', 'p', '2026', '2026');
      INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at) VALUES ('c1', 'acc1', 'm1', 'text', 'user', '2026', '2026', '2026');
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version) VALUES ('f1', 'acc1', 'm1', 'c1', 'spam_link', 'rules', '[]', 'PENDING', '2026', '2026', 1);
      
      INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at) VALUES ('c2', 'acc1', 'm1', 'text', 'user', '2026', '2026', '2026');
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version) VALUES ('f2', 'acc1', 'm1', 'c2', 'spam_link', 'rules', '[]', 'PENDING', '2026', '2026', 1);

      INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at) VALUES ('c3', 'acc1', 'm1', 'text', 'user', '2026', '2026', '2026');
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version) VALUES ('f3', 'acc1', 'm1', 'c3', 'spam_link', 'rules', '[]', 'PENDING', '2026', '2026', 1);
    `);


    let calls = 0;
    const provider: SocialProvider = {
      async setCommentHidden(account: any, commentId: string, hidden: boolean) {
        calls++;
        if (commentId === 'c2') return { status: 'rejected', safeErrorCode: 'moderation_rate_limited' };
        return { status: 'accepted' };
      }
    } as any;

    const sleeps: number[] = [];
    const result = await moderation.executeBulkAction(db, provider, 'acc1', ['f1', 'f2', 'f3'], 'hide', { sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [1000]);
    assert.deepEqual(result.results.map((r) => r.error ?? r.state), ['HIDDEN', 'FAILED', 'not_attempted']);

    const flags = db.prepare(`SELECT flag_id, state FROM moderation_flags ORDER BY flag_id`).all() as any[];
    assert.equal(flags.find((f: any) => f.flag_id === 'f1').state, 'HIDDEN');
    assert.equal(flags.find((f: any) => f.flag_id === 'f2').state, 'FAILED');
    assert.equal(flags.find((f: any) => f.flag_id === 'f3').state, 'PENDING');
  });
});

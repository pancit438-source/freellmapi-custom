import { groupRows } from '../../services/model-groups.js';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { requestedModelHonoredSql, registerRequestedModelMatcher } from '../../lib/requested-model.js';

describe('analytics pin honor for model aliases', () => {
  it.each([
    ['glm-5.3', 'z-ai/glm-5.3', 'nvidia', 1],
    ['glm-5.3-flash', 'z-ai/glm-5.3-flash', 'nvidia', 1],
    ['nvidia:z-ai/glm-5.3', 'z-ai/glm-5.3', 'nvidia', 1],
    ['nvidia:glm-5.3', 'z-ai/glm-5.3', 'nvidia', 1],
    ['z-ai/glm-5.3', 'z-ai/glm-5.3', 'nvidia', 1],
    ['deepseek-flash', 'deepseek-flash', 'custom', 1],
    ['glm-5.3', 'z-ai/glm-5.3-flash', 'nvidia', 0],
    ['glm-5.3', 'moonshotai/kimi-k3', 'nvidia', 0],
    ['other:glm-5.3', 'z-ai/glm-5.3', 'nvidia', 0],
    ['other/glm-5.3', 'z-ai/glm-5.3', 'nvidia', 0],
    ['glm-5.3', 'some/nested/glm-5.3', 'nvidia', 1],
    [null, 'z-ai/glm-5.3', 'nvidia', 0],
    ['', 'z-ai/glm-5.3', 'nvidia', 0],
  ])('%s with %s on %s', (requested, served, platform, expected) => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE requests(requested_model TEXT, model_id TEXT, platform TEXT)');
    db.prepare('INSERT INTO requests VALUES(?, ?, ?)').run(requested, served, platform);
    const row = db.prepare(`SELECT CASE WHEN ${requestedModelHonoredSql('r.')} THEN 1 ELSE 0 END AS honored FROM requests r`).get() as { honored: number };
    expect(row.honored).toBe(expected);
    const plain = db.prepare(`SELECT CASE WHEN ${requestedModelHonoredSql()} THEN 1 ELSE 0 END AS honored FROM requests`).get() as { honored: number };
    expect(plain.honored).toBe(expected);
    db.close();
  });
})

describe('routing-aware canonical aliases', () => {
  it('recognizes the canonical Nemotron slug and rejects a different member', () => {
    const db = new Database(':memory:');
    const groups = groupRows([
      {model_db_id: 1, platform: 'nvidia', model_id: 'nvidia/nemotron-3-ultra-550b-a55b', display_name: 'Nemotron 3 Ultra 550B (NVIDIA)'},
      {model_db_id: 2, platform: 'nvidia', model_id: 'z-ai/glm-5.3', display_name: 'GLM 5.3 (NVIDIA)'},
    ], {merges: [], splits: []});
    registerRequestedModelMatcher(db, groups);
    expect(db.prepare("SELECT analytics_alias_honored('nemotron-3-ultra-550b', 1) AS honored").get()).toEqual({honored: 1});
    expect(db.prepare("SELECT analytics_alias_honored('nemotron-3-ultra-550b', 2) AS honored").get()).toEqual({honored: 0});
    db.close();
  });
  it('keeps an accidental slug collision classified as a model fallback', () => {
    const db = new Database(':memory:');
    const groups = groupRows([
      {model_db_id: 1, platform: 'google', model_id: 'gemma-4-26b-a4b-it', display_name: 'Gemma 4 26B A4B'},
      {model_db_id: 2, platform: 'cloudflare', model_id: '@cf/google/gemma-4-26b-a4b-it', display_name: 'Gemma 4 26B A4B it'},
    ], {merges: [], splits: []});
    registerRequestedModelMatcher(db, groups);
    db.exec('CREATE TABLE requests(requested_model TEXT, model_id TEXT, platform TEXT, model_db_id INTEGER)');
    db.prepare('INSERT INTO requests VALUES(?, ?, ?, ?)').run('gemma-4-26b-a4b-it', '@cf/google/gemma-4-26b-a4b-it', 'cloudflare', 2);
    expect(db.prepare(`SELECT ${requestedModelHonoredSql('', true)} AS honored FROM requests`).get()).toEqual({honored: 0});
    db.close();
  });
  it('returns unknown for a deleted historical member or unresolved name', () => {
    const db = new Database(':memory:');
    const groups = groupRows([{model_db_id: 1, platform: 'nvidia', model_id: 'z-ai/glm-5.3', display_name: 'GLM 5.3'}], {merges: [], splits: []});
    registerRequestedModelMatcher(db, groups);
    expect(db.prepare("SELECT analytics_alias_honored('glm-5.3', 99) AS honored").get()).toEqual({honored: null});
    expect(db.prepare("SELECT analytics_alias_honored('unknown', 1) AS honored").get()).toEqual({honored: null});
    db.close();
  });
});

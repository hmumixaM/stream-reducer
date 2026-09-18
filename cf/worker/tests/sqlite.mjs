import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

// Run the production migrations and SQL, adapting only D1's async result shape.
export function database() {
  const db = new DatabaseSync(':memory:');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, directory), 'utf8'));
  const DB = {
    prepare(sql) {
      const statement = db.prepare(sql); let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return statement.get(...args) ?? null; },
        async all() { return { results: statement.all(...args) }; },
        async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; },
      };
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
  function item(id, published, status = 'queued') {
    db.prepare("INSERT INTO item(id,title,source_url,status,published_at,created_at) VALUES(?,?,?,'done',?,?)").run(id, `Source ${id}`, `https://example.com/${id}`, published, '2026-09-01T00:00:00Z');
    db.prepare('INSERT INTO summary(item_id,structured,markdown) VALUES(?,?,?)').run(id, JSON.stringify({tldr:'Overview',bulletin:[{text:'A source claim',timestamp:12}],walkthrough:'LONG PRIVATE NOTES'}), 'ORIGINAL NOTES');
    db.prepare("INSERT INTO bulletin_translation(item_id,lang,status) VALUES(?,'zh',?)").run(id,status);
  }
  return { db, DB, item };
}

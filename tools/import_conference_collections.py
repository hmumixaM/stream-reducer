"""Bounded, resumable import of a reviewed conference manifest. Dry run by default.

No library memberships, existing content statuses, or service settings are changed.
Use a new ledger for each manifest. An ambiguous queue submission requires manual
reconciliation: it is deliberately never replayed automatically.
"""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--ledger', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    raw = args.manifest.read_bytes()
    manifest = json.loads(raw)
    conferences = manifest['collections']
    videos = [v for c in conferences for v in c['videos']]
    assert conferences and 1 <= len(videos) <= 200
    assert len({v['id'] for v in videos}) == len(videos), 'manifest must be globally deduplicated'
    assert len({c['slug'] for c in conferences}) == len(conferences)
    for c in conferences:
        assert re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', c['slug'])
        assert c['source_url'] == 'https://www.youtube.com/playlist?list=' + c['playlist_id']
        for v in c['videos']:
            assert re.fullmatch(r'[A-Za-z0-9_-]{11}', v['id'])
            assert v['url'] == 'https://www.youtube.com/watch?v=' + v['id']
            assert v['title'] and v['author'] and 300 <= v['duration_s'] <= 10800
            assert isinstance(v['view_count'], int) and v['view_count'] >= 0
    digest = hashlib.sha256(raw).hexdigest()
    state = json.loads(args.ledger.read_text()) if args.ledger.exists() else {
        'manifest_sha256': digest, 'collections': {}, 'dispatch': {}, 'translation_intents': [],
    }
    assert state['manifest_sha256'] == digest, 'ledger belongs to a different manifest'
    assert all(v['status'] != 'dispatching' for v in state['dispatch'].values()), 'reconcile ambiguous queue submissions before resuming'
    account = os.environ['CLOUDFLARE_ACCOUNT_ID']
    base = 'https://api.cloudflare.com/client/v4/accounts/' + account

    def api(path, payload=None):
        request = urllib.request.Request(base + path, headers={
            'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'],
            'Content-Type': 'application/json',
        }, data=json.dumps(payload).encode() if payload is not None else None)
        with urllib.request.urlopen(request, timeout=60) as response:
            result = json.load(response)
        if not result.get('success'):
            raise RuntimeError(str(result.get('errors')))
        return result['result']

    def query(sql, params=None):
        results = api('/d1/database/60e0f618-ad5c-41ab-88d5-7099f526809a/query', {'sql': sql, 'params': params or []})
        assert all(r.get('success') for r in results)
        return results[0]['results']

    def save():
        args.ledger.parent.mkdir(parents=True, exist_ok=True)
        temp = args.ledger.with_suffix('.tmp')
        temp.write_text(json.dumps(state, indent=2, ensure_ascii=False))
        temp.replace(args.ledger)

    existing = query("SELECT id,external_id,source_url,status FROM item WHERE external_id IN (SELECT value FROM json_each(?)) OR source_url IN (SELECT value FROM json_each(?))", [json.dumps([v['id'] for v in videos]), json.dumps([v['url'] for v in videos])])
    by_video = {}
    for v in videos:
        matches = [r for r in existing if r['source_url'] == v['url'] or r['external_id'] == v['id']]
        if matches:
            by_video[v['id']] = min(matches, key=lambda r: (r['status'] == 'excluded', r['status'] != 'done', r['source_url'] != v['url'], r['id']))
            assert by_video[v['id']]['status'] != 'excluded', f"excluded source must not be revived: {v['id']}"
    print(json.dumps({'collections': len(conferences), 'videos': len(videos), 'new': len(videos) - len(by_video), 'reused': len(by_video), 'apply': args.apply}), flush=True)
    if not args.apply:
        return
    save()
    queue_ids = {q['queue_name']: q['queue_id'] for q in api('/queues')}

    def dispatch(queue, messages):
        pending = []
        for message in messages:
            key = queue + ':' + json.dumps(message, sort_keys=True)
            if state['dispatch'].get(key, {}).get('status') != 'submitted':
                pending.append((key, message))
        for offset in range(0, len(pending), 100):
            batch = pending[offset:offset+100]
            for key, message in batch:
                state['dispatch'][key] = {'status': 'dispatching', 'queue': queue, 'message': message}
            save()
            api('/queues/' + queue_ids[queue] + '/messages/batch', {'messages': [{'content_type': 'json', 'body': message} for _, message in batch]})
            for key, _ in batch:
                state['dispatch'][key]['status'] = 'submitted'
                state['dispatch'][key]['at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            save()

    for c in conferences:
        known = query('SELECT id,source_url FROM collection WHERE slug=?', [c['slug']])
        if known:
            assert state['collections'].get(c['slug'], {}).get('id') == known[0]['id'], 'existing unowned collection; stop instead of overwriting'
            cid = known[0]['id']
        else:
            cid = query("INSERT INTO collection(slug,title,description,source_url,cover_url,is_public,auto_translate_langs) VALUES(?,?,?,?,?,1,'[\"zh\"]') RETURNING id", [c['slug'], c['title'] + ' — Selected Talks', c['description'], c['source_url'], 'https://i.ytimg.com/vi/' + c['videos'][0]['id'] + '/hqdefault.jpg'])[0]['id']
            state['collections'][c['slug']] = {'id': cid}
            save()
        query("INSERT INTO collection_section(collection_id,slug,title,position) VALUES(?,'highlights','Highlights',0) ON CONFLICT(collection_id,slug) DO NOTHING", [cid])
        sid = query("SELECT id FROM collection_section WHERE collection_id=? AND slug='highlights'", [cid])[0]['id']
        query("INSERT INTO collection_track(section_id,title,position) VALUES(?,'Selected talks',0) ON CONFLICT(section_id,title) DO NOTHING", [sid])
        tid = query("SELECT id FROM collection_track WHERE section_id=? AND title='Selected talks'", [sid])[0]['id']
        linked = []
        for position, v in enumerate(c['videos']):
            row = by_video.get(v['id'])
            if row is None:
                created = query("INSERT INTO item(platform,source_url,external_id,title,author,description,thumbnail,duration_s,published_at,view_count,priority_score,status) VALUES('youtube',?,?,?,?,?,?,?,?,?,?,'queued') ON CONFLICT(source_url) DO NOTHING RETURNING id,status", [v['url'], v['id'], v['title'], v['author'], v.get('description', ''), 'https://i.ytimg.com/vi/' + v['id'] + '/hqdefault.jpg', v['duration_s'], v.get('published_at'), v['view_count'], math.log10(v['view_count'] + 1)])
                row = created[0] if created else query('SELECT id,status FROM item WHERE source_url=?', [v['url']])[0]
                assert row['status'] != 'excluded'
            iid = row['id']
            query('INSERT INTO collection_item(collection_id,item_id,position) VALUES(?,?,?) ON CONFLICT(collection_id,item_id) DO NOTHING', [cid, iid, position])
            query('INSERT INTO collection_track_item(track_id,item_id,position) VALUES(?,?,?) ON CONFLICT(track_id,item_id) DO NOTHING', [tid, iid, position])
            linked.append(iid)
        data = json.dumps(linked)
        pending = query("SELECT i.id FROM collection_item ci JOIN item i ON i.id=ci.item_id WHERE ci.collection_id=? AND ci.item_id IN (SELECT value FROM json_each(?)) AND ci.import_enqueued_at IS NULL AND i.status='queued'", [cid, data])
        for offset in range(0, len(pending), 100):
            batch = pending[offset:offset+100]
            dispatch('stream-reduce-items', [{'kind': 'process', 'item_id': r['id']} for r in batch])
            query("UPDATE collection_item SET import_enqueued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE collection_id=? AND item_id IN (SELECT value FROM json_each(?))", [cid, json.dumps([r['id'] for r in batch])])
        # Existing finished sources also get the selected collection's Chinese edition,
        # without regenerating the original media. New sources use normal completion hooks.
        done = query("SELECT i.id,substr(s.markdown,1,3000) sample FROM item i JOIN summary s ON s.item_id=i.id WHERE i.id IN (SELECT value FROM json_each(?)) AND i.status='done'", [data])
        translate = []
        for r in done:
            if len(re.findall(r'[\u3400-\u9fff]', r['sample'] or '')) > 300:
                continue
            previous = query("SELECT status FROM item_translation WHERE item_id=? AND lang='zh'", [r['id']])
            if not previous and r['id'] not in state['translation_intents']:
                state['translation_intents'].append(r['id'])
                save()
            if r['id'] in state['translation_intents']:
                query("INSERT INTO item_translation(item_id,lang,status) VALUES(?,'zh','queued') ON CONFLICT(item_id,lang) DO NOTHING", [r['id']])
                if not previous or previous[0]['status'] == 'queued':
                    translate.append({'kind': 'translate', 'item_id': r['id'], 'lang': 'zh'})
        if translate:
            dispatch('stream-reduce-pipeline', translate)
        state['collections'][c['slug']].update(item_ids=linked, track_id=tid)
        save()
        print(json.dumps({'slug': c['slug'], 'linked': len(linked), 'submitted_media': len(pending), 'submitted_translations': len(translate)}), flush=True)


if __name__ == '__main__':
    main()

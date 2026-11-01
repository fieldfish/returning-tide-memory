import {retrievalText} from './retrieval-text.mjs'
import {activitySourceText} from './source-position.mjs'

// Each query term has at least two BMP characters. Its first pair is a
// necessary substring, including for a match inside a longer English word.
const pairKey = (text, start = 0) =>
  text.charCodeAt(start) * 65536 + text.charCodeAt(start + 1)

// Identifiers often share a prefix. Their last four ASCII characters select a
// smaller candidate set while still matching identifiers embedded in prose.
function asciiFour(text, start) {
  let value=0
  for(let i=start;i<start+4;i++) value=value*128+text.charCodeAt(i)
  return 2**32+value
}
const termKey=term=>term.length>=4 && /^[a-z0-9_]+$/.test(term)
  ? asciiFour(term,term.length-4) : pairKey(term)
const MAX_SOURCE_CHARS=8192,BATCH=16

export class LexicalIndex {
  constructor(store) {
    this.store = store
    const db = store.db
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_lex_sources'").get()) {
      this.ensureActivityTriggers()
      return
    }
    store.tx(() => db.exec(`
      CREATE TABLE cm_lex_sources(
        slot INTEGER PRIMARY KEY, rid TEXT NOT NULL UNIQUE, library TEXT NOT NULL,
        state INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX cm_lex_queue ON cm_lex_sources(library,state);
      CREATE TABLE cm_lex_pairs(
        pair INTEGER NOT NULL, slot INTEGER NOT NULL REFERENCES cm_lex_sources(slot) ON DELETE CASCADE,
        PRIMARY KEY(pair,slot)
      ) WITHOUT ROWID;
      CREATE INDEX cm_lex_by_slot ON cm_lex_pairs(slot);
      INSERT INTO cm_lex_sources(rid,library) SELECT id,library FROM records;
      CREATE TRIGGER cm_lex_insert AFTER INSERT ON records BEGIN
        INSERT INTO cm_lex_sources(rid,library) VALUES(new.id,new.library);
      END;
      CREATE TRIGGER cm_lex_delete AFTER DELETE ON records BEGIN
        DELETE FROM cm_lex_sources WHERE rid=old.id;
      END;
      CREATE TRIGGER cm_lex_update AFTER UPDATE OF text,origin,role ON records BEGIN
        UPDATE cm_lex_sources SET state=0 WHERE rid=new.id;
      END;
    `))
    this.ensureActivityTriggers()
  }

  // Activity payloads arrive or change after the raw record is archived. Their text is part of the
  // searchable source, so an existing index entry must be rebuilt. Triggers are created only when the
  // payload table already exists; the manager calls this again after that plugin owns the table.
  ensureActivityTriggers(){
    const db=this.store.db
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_activity_payloads'").get())return false
    const existed=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_lex_payload_insert'").get()&&
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_lex_payload_update'").get()&&
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_lex_payload_delete'").get()
    this.store.tx(()=>db.exec(`
      CREATE TRIGGER IF NOT EXISTS cm_lex_payload_insert AFTER INSERT ON cm_activity_payloads BEGIN UPDATE cm_lex_sources SET state=0 WHERE rid=new.rid; END;
      CREATE TRIGGER IF NOT EXISTS cm_lex_payload_update AFTER UPDATE OF payload,digest ON cm_activity_payloads BEGIN UPDATE cm_lex_sources SET state=0 WHERE rid=new.rid; END;
      CREATE TRIGGER IF NOT EXISTS cm_lex_payload_delete AFTER DELETE ON cm_activity_payloads BEGIN UPDATE cm_lex_sources SET state=0 WHERE rid=old.rid; END;
    `))
    if(!existed)this.store.tx(()=>db.prepare('UPDATE cm_lex_sources SET state=0 WHERE rid IN (SELECT rid FROM cm_activity_payloads)').run())
    return true
  }

  pending(library) {
    return this.store.db.prepare('SELECT count(*) AS n FROM cm_lex_sources WHERE library=? AND state=0').get(library).n
  }

  // Pending and oversized sources remain searchable through exact verification.
  // Batch size also caps synchronous work during idle index maintenance.
  nextRows(library,limit){
    const payload=!!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_activity_payloads'").get()
      ? `,CASE WHEN length(ap.payload)<=${MAX_SOURCE_CHARS} THEN ap.payload END AS payload,
        length(ap.payload)>${MAX_SOURCE_CHARS} AS payload_oversized` : ''
    const join=payload ? ' LEFT JOIN cm_activity_payloads ap ON ap.rid=r.id' : ''
    return this.store.db.prepare(`SELECT s.slot,r.role,r.origin,
      CASE WHEN length(r.text)<=${MAX_SOURCE_CHARS} THEN r.text END AS text${payload}
      FROM cm_lex_sources s JOIN records r ON r.id=s.rid${join}
      WHERE s.library=? AND s.state=0 ORDER BY s.slot LIMIT ?`).all(library,limit)
  }

  buildRows(rows){
    const db=this.store.db
    const clear=db.prepare('DELETE FROM cm_lex_pairs WHERE slot=?')
    const insert=db.prepare('INSERT INTO cm_lex_pairs VALUES(?,?)')
    const finish=db.prepare('UPDATE cm_lex_sources SET state=? WHERE slot=?')
    for(const row of rows){
      clear.run(row.slot)
      if(row.text===null||row.payload_oversized){finish.run(-1,row.slot);continue}
      const source=row.payload?activitySourceText(retrievalText(row),row.payload):retrievalText(row)
      if(typeof source!=='string'||source.length>MAX_SOURCE_CHARS){finish.run(-1,row.slot);continue}
      const pairs=new Set()
      const runs=source.toLowerCase().match(/[\u3400-\u9fff]+|[a-z0-9_]+/g)||[]
      for(const run of runs){
        for(let i=1;i<run.length;i++)pairs.add(pairKey(run,i-1))
        if(/^[a-z0-9_]/.test(run))for(let i=3;i<run.length;i++)pairs.add(asciiFour(run,i-3))
      }
      for(const pair of pairs)insert.run(pair,row.slot)
      finish.run(1,row.slot)
    }
  }

  buildBatch(library){
    return this.store.tx(()=>{
      const rows=this.nextRows(library,BATCH)
      this.buildRows(rows)
      return rows.length
    })
  }

  // Idle maintenance: one small transaction per row and a yielded turn between rows so a large
  // backlog cannot block the foreground event loop, and cancellation is observed between rows.
  async buildBatchAsync(library,{signal=null,batch=BATCH}={}){
    let done=0
    for(let i=0;i<batch;i++){
      if(signal?.aborted)throw Object.assign(new Error('索引维护已取消'),{code:'CANCELLED'})
      await new Promise(resolve=>setImmediate(resolve))
      // Cancellation can arrive while the turn is yielded; re-check before touching the database.
      if(signal?.aborted)throw Object.assign(new Error('索引维护已取消'),{code:'CANCELLED'})
      const rows=this.store.tx(()=>{const next=this.nextRows(library,1);this.buildRows(next);return next})
      if(!rows.length)break
      done++
    }
    return done
  }

  candidates(library,terms,activities) {
    const keys = [...new Set(terms.map(termKey))]
    const placeholders = keys.map(() => '?').join(',')
    // Activity payloads can arrive or change after the raw record is indexed.
    // Include them explicitly; verification uses the current structured text.
    const payloads = activities ? ' UNION ALL SELECT ap.rid FROM cm_activity_payloads ap JOIN records ar ON ar.id=ap.rid WHERE ar.library=?' : ''
    return {
      sql: `SELECT s.rid FROM cm_lex_pairs p CROSS JOIN cm_lex_sources s ON s.slot=p.slot
        WHERE p.pair IN (${placeholders}) AND s.library=?
        UNION ALL SELECT rid FROM cm_lex_sources WHERE library=? AND state IN (-1,0)${payloads}`,
      args: [...keys,library,library,...(activities ? [library] : [])]
    }
  }
}

import {createHash} from 'node:crypto';

const SESSION = createHash('sha256').update('alexbot:admin:rag-check:v1').digest('hex');
const DAY = 86400000;
const ERRORS = new Set(['RAG_DISABLED','RAG_VECTOR_NOT_CONFIGURED','RAG_VECTOR_UNAVAILABLE',
  'RAG_STORE_UNAVAILABLE','RAG_INDEX_MANIFEST_MISMATCH','RAG_EMBEDDING_MISMATCH','EMBEDDING_DIMENSION_MISMATCH']);
const validMs = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 600000;
const response = (statusCode, body) => ({statusCode, body});

/** Administrator diagnostics only: fixed shared reads on the existing agent worker. */
export class RagHealthCheck {
  #busy = false;
  constructor({worker, enabled = Boolean(process.env.QQ_RAG_CONFIG), now = Date.now}) {
    Object.assign(this, {worker, enabled, now});
  }
  async run(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 1 || !Object.hasOwn(input,'check') ||
        !['knowledge','outdoor'].includes(input.check)) {
      return response(400, {ok:false, code:'INVALID_INPUT'});
    }
    if (!this.enabled) return response(503, {ok:false, code:'RAG_DISABLED'});
    if (this.#busy) return response(409, {ok:false, code:'RAG_CHECK_BUSY'});
    this.#busy = true;
    const started = performance.now(), check = input.check;
    try {
      const day = Math.floor((this.now()+8*3600000)/DAY)*DAY;
      const date = offset => new Date(day+offset*DAY).toISOString().slice(0,10);
      const payload = {type:'rag', sessionKey:SESSION, context:{scope:'c2c'},
        ...(check === 'knowledge'
          ? {name:'search_domain_knowledge', text:'运维只读检查：乌孙古道路线资料',
             args:{query:'乌孙古道 路线 管理公告', domain:'outdoor', limit:2}}
          : {name:'prepare_outdoor_trip', text:'运维只读检查：党岭明后两天的天气、季节参考与装备资料',
             args:{destination_id:'dangling', start_date:date(1), end_date:date(2)}})};
      const result = await this.worker.run(payload, async () => {throw Error('RAG_CHECK_RPC_DENIED');}, value => value);
      const elapsedMs = Math.round(performance.now()-started);
      if (result?.kind !== 'rag' || result.requiredFeature !== 'weather' ||
          typeof result.text !== 'string' || !result.text.trim() || result.text.length > 1600 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result.text)) {
        const code = result?.errorCode === 'RAG_DISABLED' ? 'RAG_DISABLED' : 'RAG_CHECK_INVALID_RESULT';
        return response(503, {ok:false, check, code, elapsedMs});
      }
      const errorCode = ERRORS.has(result.errorCode) ? result.errorCode : undefined;
      const timings = Object.fromEntries(Object.entries(result.ragTimings ?? {}).filter(([key,value]) =>
        ['lexical_ms','embedding_ms','vector_ms','source_verify_ms','total_ms'].includes(key) && validMs(value)));
      const vectorVerified = check === 'knowledge' && result.status === 'ok' && !result.errorCode &&
        validMs(timings.embedding_ms) && validMs(timings.vector_ms);
      const completed = check === 'knowledge' ? vectorVerified :
        ['ok','partial'].includes(result.status) && !result.errorCode;
      return response(completed ? 200 : 503, {
        ok:completed, check, status:['ok','partial','empty','degraded','unavailable','denied','invalid','rejected'].includes(result.status)
          ? result.status : 'unavailable',
        ...(!completed ? {code:errorCode ?? (check === 'knowledge' ? 'RAG_VECTOR_NOT_VERIFIED' : 'RAG_CHECK_UNAVAILABLE')} : {}),
        ...(errorCode ? {errorCode} : {}), elapsedMs, timings,
        ...(check === 'knowledge' ? {vectorVerified} : {complete:result.status === 'ok'}),
        summary:check === 'knowledge'
          ? (vectorVerified ? '共享资料向量检索已核验。' : '未确认向量检索成功，请检查状态与错误码。')
          : '复合工具已返回；天气、气候与路线资料的缺项以正文为准。',
        text:result.text,
      });
    } catch (error) {
      return response(503, {ok:false, check, code:error?.timedOut === true ? 'RAG_CHECK_TIMEOUT' : 'RAG_CHECK_UNAVAILABLE',
        elapsedMs:Math.round(performance.now()-started)});
    } finally {this.#busy = false;}
  }
}

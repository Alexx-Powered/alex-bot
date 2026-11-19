// Only normalize the current addressed QQ message. Never serialize an event,
// a model prompt, SDK response or Error object into a remote run.
export function traceMessage(text){
  if(typeof text!=='string'||text.length>1500||!text.trim())return undefined;
  if(/-----BEGIN [^-]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk-|lsv2_|gh[pousr]_)[A-Za-z0-9_-]{8,}|(?:api[_ -]?key|app[_ -]?secret|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|authorization|password|passwd|cookie|token|密钥|密码|验证码|口令)["']?\s*(?:[=:：]|是|为|\s)\s*\S|[?&](?:signature|sig|credential|x-amz-signature|x-oss-signature)=/iu.test(text))return '[凭据已隐藏]';
  return text.replace(/(\/(?:group-bind|pair|probe))\s+\S+/giu,'$1 [口令已隐藏]').replace(/<(@!?|#)[^>\r\n]+>/gu,'[QQ 提及]');
}

const reasons={
  MORNING_DATA_INCOMPLETE:'早间天气数据未通过完整性检查',
  MORNING_SOURCE_FIELDS_MISSING:'天气源返回的有效时次或字段不足',
  MORNING_EC_CACHE_UNAVAILABLE:'Visual Crossing 凌晨预报快照缺失或已过期',
  MORNING_EC_TIMELINE_UNAVAILABLE:'Visual Crossing ECMWF 预报取数或校验失败',
  MORNING_EC_ENSEMBLE_UNAVAILABLE:'ECMWF 集合降水概率取数或校验失败',
  MORNING_PM25_UNAVAILABLE:'早报 PM2.5 取数或选源校验失败',
  MORNING_GEFS_DECODER_UNAVAILABLE:'NOAA GEFS-Aerosols 解码器未就绪',
  MORNING_OUTDOOR_INDEX_UNAVAILABLE:'户外指数暂无法评定',
  MORNING_OUTDOOR_INDEX_TIMEOUT:'户外指数计算超时',
  MORNING_PM25_SELECT_TIMEOUT:'PM2.5 比较选源超时',
  WEATHER_SUMMARY_TIMEOUT:'天气与风速摘要计算超时',
  MORNING_DATE_CITY_CHANGED:'早报日期或城市校验失败',
  MORNING_REPORT_INVALID:'天气早报未生成有效的当日图片',
  MORNING_REPORT_FAILED:'早间天气生成失败',
  CAMPUS_REPORT_FAILED:'自习简报生成失败',
  CAMPUS_IMAGE_MISSING:'自习简报未生成有效的当日图片',
  CAMPUS_LOGIN_TIMEOUT:'等待校园统一认证结果超时',
  CAMPUS_NAVIGATION_TIMEOUT:'校园网页加载超时',
  CAMPUS_LOGIN_ACTION_TIMEOUT:'校园登录页面操作超时',
  CAMPUS_LOGIN_ACCOUNT_TIMEOUT:'填写校园账号超时',
  CAMPUS_LOGIN_PASSWORD_TIMEOUT:'填写校园密码超时',
  CAMPUS_LOGIN_SUBMIT_TIMEOUT:'点击校园登录按钮超时',
  CAMPUS_SEARCH_TIMEOUT:'空教室接口查询超时',
  CAMPUS_INTERACTION_REQUIRED:'校园认证需要人工验证',
  CAMPUS_RENDER_FAILED:'自习简报绘图失败',
  MORNING_WINDOW_ENDED:'已过早报投递时段',
  MORNING_CANCELLED:'当日早报任务已取消',
  MORNING_RETRIES_EXHAUSTED:'今日早报生成次数已用完',
  HEAVY_WORK_BUSY:'重任务队列已满',
  GROUP_MORNING_UNAVAILABLE:'当前传输模式未启用群早报',
  PAUSED:'发送已暂停',NOT_PAIRED:'尚未配对主人',NOT_CONNECTED:'QQ 未连接',
  RATE_LIMIT_DAY:'当日发送额度已用完',RATE_LIMIT_MINUTE:'每分钟发送额度已用完',
  RATE_LIMIT_TARGET:'该会话发送频率达到上限',STORAGE_ERROR:'运行状态保存失败',
  HIKING_FORECAST_TIMEOUT:'徒步沿线预报获取超时',HIKING_FORECAST_UNAVAILABLE:'徒步沿线预报获取或校验失败',
  RAG_DISABLED:'知识检索未启用或当前会话没有权限',RAG_VECTOR_NOT_CONFIGURED:'未配置语义索引，使用关键词检索',
  RAG_VECTOR_UNAVAILABLE:'向量检索或嵌入服务不可用',RAG_STORE_UNAVAILABLE:'原文资料库不可用',
  RAG_INDEX_MANIFEST_MISMATCH:'语义索引版本与配置不匹配',RAG_EMBEDDING_MISMATCH:'嵌入模型版本不匹配',
  EMBEDDING_DIMENSION_MISMATCH:'嵌入向量维度不匹配',RAG_EXPLICIT_SAVE_REQUIRED:'没有匹配本轮原文的明确保存请求',
  RAG_EXPLICIT_DELETE_REQUIRED:'没有匹配本轮原文的明确删除请求',
  LOCATION_NOT_FOUND:'未找到请求的地点', LOCATION_AMBIGUOUS:'多个地点重名，需要补充省市', LOCATION_INPUT_INVALID:'地点格式无效',
  LOCATION_SOURCE_TIMEOUT:'地名服务响应超时', LOCATION_SOURCE_UNAVAILABLE:'地名服务不可用',
  FORECAST_SOURCE_TIMEOUT:'预报数据源响应超时', FORECAST_SOURCE_RATE_LIMITED:'预报数据源限流', FORECAST_SOURCE_HTTP_ERROR:'预报数据源返回 HTTP 错误',
  FORECAST_SOURCE_UNAVAILABLE:'预报数据源不可用', WEATHER_DATA_UNAVAILABLE:'天气和空气质量数据均不可用',
  VIDEO_NATIVE_UNAVAILABLE:'原始预报格点读取失败', VIDEO_SOURCE_UNAVAILABLE:'动态天气数据源不可用', VIDEO_SOURCE_STALE:'动态天气数据已过期',
  VIDEO_NO_COVERAGE:'数据源未覆盖请求区域', VIDEO_DATA_MISSING:'缺少成片所需的有效时次', VIDEO_SOURCE_INVALID:'数据结构校验失败',
  VIDEO_ENCODING_FAILED:'视频编码或成片校验失败', VIDEO_TIMEOUT:'视频生成超时', VIDEO_RESULT_INVALID:'视频成品校验失败',
  MODEL_AUTH_ERROR:'模型服务鉴权失败', MODEL_BALANCE_INSUFFICIENT:'模型账户余额不足', MODEL_PROVIDER_RATE_LIMITED:'模型服务限流',
  MODEL_PROVIDER_UNAVAILABLE:'模型服务端异常', MODEL_TIMEOUT:'模型响应超时', MODEL_CONNECTION_ERROR:'连接模型服务失败',
  MODEL_TOOL_PROTOCOL_ERROR:'模型接口拒绝工具历史中的思考字段', MODEL_REQUEST_REJECTED:'模型接口拒绝请求格式',
  MODEL_TOOL_ROUTING_FAILED:'工具选择或参数校验失败', MODEL_CONFIG_UNAVAILABLE:'读取模型配置失败', CHAT_POLICY_INVALID:'读取聊天规则失败',
  PYTHON_AGENT_UNAVAILABLE:'Python 工作进程不可用', WORKER_FAILED:'Python 工作进程返回失败', WORKER_TIMEOUT:'工作进程超过时限',
  QQ_UPLOAD_TIMEOUT:'QQ 媒体上传超时', QQ_SEND_TIMEOUT:'QQ 消息提交超时', QQ_RATE_LIMITED:'QQ 接口限流', QQ_PERMISSION_DENIED:'QQ 接口拒绝权限',
  QQ_TARGET_PERMISSION_DENIED:'QQ 拒绝向当前会话发送，请检查该会话的发送权限', QQ_SERVICE_UNAVAILABLE:'QQ 接口暂时不可用',
  QQ_UPLOAD_FAILED:'QQ 媒体上传失败', QQ_SEND_FAILED:'QQ 消息提交失败', QQ_UPLOAD_RESPONSE_INVALID:'QQ 媒体上传回执无效',
  QQ_REPLY_TARGET_EXPIRED:'QQ 被动回复窗口已过期', QQ_SEND_CANCELLED:'QQ 发送已取消', QQ_NOT_CONNECTED:'QQ 未连接',
  QQ_CONNECTION_CHANGED:'QQ 连接在发送途中发生变化', HTTP_ERROR:'上游接口返回 HTTP 错误', NETWORK_TIMEOUT:'网络请求超时',
  CONNECTION_ERROR:'与上游服务连接失败', DECODE_ERROR:'数据解码失败', VALIDATION_ERROR:'输入或响应格式校验失败',
  NOT_FOUND:'未找到请求的资源', AMBIGUOUS_TARGET:'目标存在多个匹配', RADAR_STALE:'雷达图已过期',
  DELIVERY_UNCERTAIN:'QQ 投递结果待确认', PLATFORM_REJECTED:'QQ 平台拒绝投递', PERMISSION_DENIED:'发送权限不足',
  CONTENT_REJECTED:'QQ 平台拒绝消息内容', RATE_LIMITED:'请求达到发送限额', REQUEST_EXPIRED:'排队期间超过被动回复时限',
  BUSY:'请求队列已满', STORAGE_FAILED:'运行状态保存失败', STATUS_RESULT_INVALID:'服务状态回执校验失败',
  STATUS_SOURCE_UNAVAILABLE:'状态查询数据源不可用', STATUS_RESULT_STALE:'状态查询结果已过期', STATUS_IMAGE_INVALID:'状态图片校验失败',
};
const knownGroups=[
  ['预报数据校验失败','FORECAST_CLOCK_INVALID FORECAST_COVERAGE_INCOMPLETE FORECAST_DATA_MISSING FORECAST_METADATA_INVALID FORECAST_MODEL_STALE FORECAST_RESPONSE_INVALID FORECAST_RESPONSE_STALE FORECAST_RESPONSE_TOO_LARGE FORECAST_SCHEMA_INVALID FORECAST_TIME_INVALID FORECAST_TIMEZONE_INVALID FORECAST_UNITS_INVALID'],
  ['校园查询失败','CAMPUS_BUSY CAMPUS_CONFIG_UNAVAILABLE CAMPUS_QUERY_FAILED CAMPUS_WORKER_TIMEOUT CAMPUS_NAVIGATION_TIMEOUT CAMPUS_LOGIN_TIMEOUT CAMPUS_SEARCH_TIMEOUT CAMPUS_AUTH_FAILED CAMPUS_NOT_CONFIGURED CAMPUS_DISABLED CAMPUS_INVALID_DATE CAMPUS_INTERACTION_REQUIRED CAMPUS_NETWORK_ERROR CAMPUS_SCHEMA_CHANGED CAMPUS_BROWSER_UNAVAILABLE CAMPUS_RENDER_FAILED CAMPUS_INTERACTIVE_LOGIN_TIMEOUT CAMPUS_LOGIN_ACTION_TIMEOUT'],
  ['雷达数据获取失败','GLOBAL_RADAR_UNAVAILABLE GLOBAL_RADAR_NO_COVERAGE RADAR_TIMEOUT RADAR_TARGET_NOT_FOUND TARGET_NOT_FOUND'],
  ['目标或媒体格式无效','QQ_REPLY_TARGET_INVALID QQ_TEXT_INVALID QQ_IMAGE_INVALID QQ_VIDEO_INVALID QQ_IMAGE_TOO_LARGE VIDEO_INPUT_INVALID INVALID_VIDEO_WINDOW INVALID_VIDEO_LAYER'],
  ['上游连接失败','ECONNRESET ECONNREFUSED ENOTFOUND EAI_AGAIN ENETUNREACH EHOSTUNREACH'],
  ['网络请求超时','ETIMEDOUT UND_ERR_HEADERS_TIMEOUT UND_ERR_BODY_TIMEOUT'],
];
for(const [message,codes] of knownGroups)for(const code of codes.split(' '))if(!Object.hasOwn(reasons,code))reasons[code]=message;
reasons.UND_ERR_CONNECT_TIMEOUT='建立上游连接超时';
reasons.UND_ERR_SOCKET='上游连接意外中断';
reasons.ERR_TLS_CERT_ALTNAME_INVALID='上游证书域名校验失败';
reasons.UNABLE_TO_VERIFY_LEAF_SIGNATURE='上游证书校验失败';
const known=value=>typeof value==='string'&&Object.hasOwn(reasons,value);
const morningFields=new Set(['weather','weather.coverage','weather.temperatureC','weather.humidityPct',
  'weather.precipitationMm','weather.precipitationProbabilityPct','weather.cloudCoverPct','weather.windSpeedMs',
  'weather.windDirectionDeg','weather.windGustMs','weather.rainMm','weather.weatherCode','weather.summary',
  'weather.windBrief','air','air.coverage','air.pm25','outdoorIndex']);

function morningMissing(code,error){
  if(!['MORNING_DATA_INCOMPLETE','MORNING_SOURCE_FIELDS_MISSING'].includes(code)||!Array.isArray(error?.morningQuality?.missing))return '';
  const missing=[...new Set(error.morningQuality.missing.slice(0,24).filter(field=>morningFields.has(field)))];
  return missing.length?'缺项 '+missing.join(', '):'';
}

export function failureDetail(stage,error,fallback=false){
  const prefix=fallback?'该步骤已转入备用路径 · ':'';
  try{
    const status=[error?.httpStatus,error?.status_code,error?.status,error?.statusCode,error?.response?.status].find(n=>Number.isInteger(n)&&n>=400&&n<=599);
    const timed=error?.timedOut===true;
    const code=[error?.reason,error?.errorCode,timed&&error?.code==='PYTHON_AGENT_UNAVAILABLE'?'WORKER_TIMEOUT':undefined,error?.code,timed?'WORKER_TIMEOUT':undefined,error?.message,error?.cause?.code,
      ['TimeoutError','AbortError'].includes(error?.name)?'NETWORK_TIMEOUT':undefined,error?.name==='ZodError'?'VALIDATION_ERROR':undefined,status?'HTTP_ERROR':undefined].find(known);
    const timeout=timed&&Number.isSafeInteger(error.timeoutMs)&&error.timeoutMs>0&&error.timeoutMs<=600000?`时限 ${error.timeoutMs/1000} 秒`:'';
    const cause=known(error?.causeCode)&&error.causeCode!==code?error.causeCode+' · '+reasons[error.causeCode]:'';
    const biz=stage.startsWith('qq_')&&Number.isSafeInteger(error?.bizCode)&&error.bizCode>0&&error.bizCode<=999999999?`QQ 业务码 ${error.bizCode}`:'';
    const group=stage==='qq_group_permission'&&/^sha256:[a-f0-9]{12}$/.test(error?.groupHint??'')?`群标识 ${error.groupHint}`:'';
    const type=['TypeError','RangeError','SyntaxError'].includes(error?.name)?error.name:'';
    const detail=[code,code?reasons[code]:(type||'此步骤未提供具体错误码'),morningMissing(code,error),cause,status?`HTTP ${status}`:'',biz,group,timeout].filter(Boolean).join(' · ');
    return {stage,code,message:prefix+stage+' · '+detail};
  }catch{return {stage,message:prefix+stage+' · 此步骤未提供具体错误码'};}
}

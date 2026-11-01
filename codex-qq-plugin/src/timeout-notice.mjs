// Only fixed stage labels and validated durations enter user-visible errors.
const stages={global_radar_image:'全球雷达查询与出图',weather_image:'天气数据查询与出图',air_quality_image:'空气质量查询与出图',radar_image:'雷达查询',radar_catalog:'雷达目录查询',buaa_classroom_query:'校园教室查询与出图',buaa_classroom_recommend:'教室推荐',liang_status:'滑动变祖器状态查询',deepseek_service_status:'DeepSeek状态查询',local_weather_briefing:'天气简报生成'};
const codes={MODEL_TIMEOUT:['模型响应',20],FORECAST_SOURCE_TIMEOUT:['预报数据源响应',15],LOCATION_SOURCE_TIMEOUT:['城市定位服务响应',15],RADAR_TIMEOUT:['雷达数据下载',10],CAMPUS_NAVIGATION_TIMEOUT:['校园网页加载',25],CAMPUS_LOGIN_TIMEOUT:['校园登录响应',40],CAMPUS_SEARCH_TIMEOUT:['校园教室接口响应',20],CAMPUS_WORKER_TIMEOUT:['校园查询与出图',210],CAMPUS_INTERACTIVE_LOGIN_TIMEOUT:['校园交互登录等待',150],CAMPUS_LOGIN_ACTION_TIMEOUT:['校园登录页面操作',3]};
export function timeoutNotice(error,{stage,seconds}={}){
  const fixed=codes[error?.reason]||codes[error?.code];
  if(!fixed&&error?.timedOut!==true)return null;
  const label=fixed?.[0]||stages[error?.stage]||stage||'智能处理';
  const duration=fixed?.[1]||(Number.isFinite(error?.timeoutMs)&&error.timeoutMs>0&&error.timeoutMs<=300000?error.timeoutMs/1000:seconds);
  return `${label}超时${duration?`（${duration}秒时限）`:''}，这一环节未在时限内完成，请稍后重试`;
}

// Register user-facing weather tools here with their access switch and help text.
// The group permission lookup and the /help layout both use this catalogue.
export const WEATHER_TOOLS = Object.freeze([
  ...[
    {tool:'cloud_video',title:'云量预报',feature:'weather',command:'发 云图 南京'},
    {tool:'temperature_video',title:'温度预报',feature:'weather',command:'发 48h动态温度 新疆'},
    {tool:'precipitation_video',title:'降水预报',feature:'weather',command:'发 动态降水 华东'},
    {tool:'pm25_video',title:'PM2.5 预报',feature:'air',command:'发 动态PM2.5 北京'},
  ].map(row=>({...row,detail:'默认未来 24 小时，可选 48 小时。支持地点、省区和气象大区。',usage:row.command})),
  {tool: 'radar_image', feature: 'radar', title: '全球气象雷达',
    detail: '城市或全球的最新降水回波。', question: '看看纽约的降水雷达', command: '全球雷达 纽约',
    usage: '发 雷达 xx（支持全球）'},
  {tool: 'weather_image', feature: 'weather', title: '2 日天气简报',
    detail: '逐小时查看气温、降水概率、云量和 PM2.5。', question: '北京这两天会下雨吗？', command: '发 天气 北京',
    usage: '发 天气 xx（2 日简报）'},
  {tool: 'air_quality_image', feature: 'air', title: '空气质量',
    detail: '未来 48 小时 PM2.5 浓度预报。', question: '北京明天空气怎么样？', command: '发 空气 北京',
    usage: '发 空气 xx'},
  {tool: 'radar_catalog', feature: 'radar', title: '国内雷达站',
    detail: '按省份找站点，再用站名查图。', question: '广东有哪些雷达站？', command: '雷达目录 广东',
    usage: '雷达目录 [省份]'},
]);

import unittest
from datetime import datetime
from unittest.mock import patch,MagicMock
from regional_air_alerts import TIANJIN,TZ,parse_article,links,fetch_tianjin,coverage,get_page
from weather_alerts import decorate,weather_alerts
NOW=datetime(2026,11,10,9,tzinfo=TZ)
URL=TIANJIN['home']+'YWGZ7406/HJZL9827/DQHJZL7498/202611/t20261107_7652064.html'
def page(title='发布重污染天气橙色预警',text='从11月9日20时起启动重污染天气Ⅱ级响应。'):
 return f'<meta name="ArticleTitle" content="{title}"><meta name="PubDate" content="2026-11-07 19:40:00"><div class="TRS_Editor"><div>{text}</div></div><p>不应包含页脚</p>'
class Regional(unittest.TestCase):
 def test_scope_and_effective_time(self):
  a=parse_article(page(),URL,TIANJIN,NOW);self.assertEqual(a['effective'],'2026-11-09T20:00:00+08:00');self.assertNotIn('页脚',a['description'])
  self.assertEqual([x['area']['code'] for x in decorate([a],['120000','110108'])[0]['matches']],['120000'])
 def test_plan_is_not_warning(self):
  with self.assertRaises(ValueError):parse_article(page('重污染天气应急预案'),URL,TIANJIN,NOW)
  with self.assertRaises(ValueError):links('<html>系统升级中</html>',TIANJIN,NOW)
 def test_latest_cancellation_and_external_link_rejected(self):
  newer=URL.replace('t20261107_7652064','t20261109_7653000')
  index=f'<a href="{URL}">发布重污染天气橙色预警</a><a href="{newer}">解除重污染天气预警</a><a href="https://evil.example/a">重污染预警</a>'
  self.assertEqual(links(index,TIANJIN,NOW),newer)
  a=parse_article(page('解除重污染天气预警','从11月9日20时起解除重污染天气预警。'),newer,TIANJIN,NOW);self.assertTrue(a['cancelled'])
 def test_coverage_is_explicit(self):
  self.assertEqual(coverage(['130100'])[0]['heavyPollution'],'source_not_verified')
 def test_all_sources_and_isolated_failure(self):
  a=parse_article(page(),URL,TIANJIN,NOW)
  with patch('weather_alerts.fetch_feed',return_value={'code':0,'data':[]}),patch('beijing_air_alerts.fetch_beijing',side_effect=TimeoutError()),patch('regional_air_alerts.fetch_tianjin',return_value=[a]):
   result=weather_alerts.invoke({'action':'poll','codes':['110108','120000']})
   self.assertTrue(result['ok']);self.assertEqual(result['sourceFailures'],['beijing_air']);self.assertEqual(result['alerts'][0]['code'],'120000')
 def test_timeout_retries_once_but_http_errors_do_not(self):
  from urllib.error import URLError,HTTPError
  response=MagicMock();response.__enter__.return_value=response;response.url=TIANJIN['home'];response.read.return_value=b'<html></html>'
  with patch('regional_air_alerts.urlopen',side_effect=[URLError(TimeoutError()),response]) as call:
   self.assertEqual(get_page(TIANJIN['home'],TIANJIN),'<html></html>');self.assertEqual(call.call_count,2)
   ctx=call.call_args.kwargs['context'];self.assertTrue(ctx.check_hostname);self.assertEqual(ctx.verify_mode,2)
  with patch('regional_air_alerts.urlopen',side_effect=URLError(TimeoutError())) as call:
   with self.assertRaises(URLError):get_page(TIANJIN['home'],TIANJIN)
   self.assertEqual(call.call_count,2)
  with patch('regional_air_alerts.urlopen',side_effect=HTTPError(TIANJIN['home'],403,'denied',{},None)) as call:
   with self.assertRaises(HTTPError):get_page(TIANJIN['home'],TIANJIN)
   self.assertEqual(call.call_count,1)
if __name__=='__main__':unittest.main()

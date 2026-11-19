import unittest
from datetime import datetime
from beijing_air_alerts import TZ,HOME,discover,parse_article,fetch_beijing
from weather_alerts import decorate
NOW=datetime(2026,11,10,9,tzinfo=TZ)
URL=HOME+'art/2026/11/9/art_2472_693516.html'
def page(title='发布空气重污染橙色预警',body='11月11日0时本市启动空气重污染橙色预警，请注意防护。',date='2026-11-09 20:00'):
    return f'<meta name="ArticleTitle" content="{title}"><meta name="PubDate" content="{date}"><!--ZJEG_RSS.content.begin--><p>{body}</p><!--ZJEG_RSS.content.end-->'
class Beijing(unittest.TestCase):
    def test_future_activation_matches_district_not_tianjin(self):
        a=parse_article(page(),URL,NOW)
        self.assertEqual(a['effective'],'2026-11-11T00:00:00+08:00')
        self.assertEqual(a['publishedAt'],'2026-11-09T20:00:00+08:00')
        a=decorate([a],['110108','120000'])[0]
        self.assertEqual([x['area']['code'] for x in a['matches']],['110108'])
        self.assertEqual(a['matches'][0]['relation'],'省级')
    def test_upgrade_cancel_and_stable_fingerprint(self):
        a=parse_article(page(),URL,NOW)
        same=decorate([parse_article(page(),URL,NOW)],['110108'],[a])[0]
        self.assertEqual(same['change'],'未变')
        red=parse_article(page('升级空气重污染红色预警','11月11日0时本市启动空气重污染红色预警。'),URL,NOW)
        self.assertEqual(decorate([red],['110108'],[a])[0]['change'],'升级')
        end=parse_article(page('解除空气重污染预警','11月10日0时本市解除空气重污染预警。'),URL,NOW)
        self.assertEqual(decorate([end],['110108'],[red])[0]['change'],'解除')
    def test_latest_cancellation_wins_and_two_requests_max(self):
        end=HOME+'art/2026/11/10/art_2472_693600.html'
        index=f'<a href="{URL}">发布空气重污染橙色预警</a><a href="{end}">解除空气重污染预警</a>'
        self.assertEqual(discover(index,NOW),end)
        calls=[]
        def get(url):
            calls.append(url)
            return index if url==HOME else page('解除空气重污染预警','11月10日0时本市解除空气重污染预警。')
        self.assertTrue(fetch_beijing(NOW,get)[0]['cancelled']);self.assertEqual(calls,[HOME,end])
    def test_invalid_page_and_external_links(self):
        with self.assertRaises(ValueError):discover('<html>维护中</html>',NOW)
        with self.assertRaises(ValueError):parse_article(page(),'https://example.com/',NOW)
        with self.assertRaises(ValueError):parse_article('<html>维护中</html>',URL,NOW)
        old=HOME+'art/2025/11/9/art_2472_1.html'
        self.assertIsNone(discover(f'<a href="{old}">发布空气重污染橙色预警</a>',NOW))
    def test_new_year_midnight(self):
        a=parse_article(page(body='1月1日24时本市启动空气重污染橙色预警。',date='2026-12-31 20:00'),URL,datetime(2026,12,31,21,tzinfo=TZ))
        self.assertEqual(a['effective'],'2027-01-02T00:00:00+08:00')
if __name__=='__main__':unittest.main()

import unittest
import internet_trends as trends

class TrendTests(unittest.TestCase):
    def setUp(self):trends._cache.clear();self.now=1800000000
    def test_hot_feed_is_bounded_and_cached_without_a_key(self):
        calls=[]
        def fetch(url):calls.append(url);return {'code':0,'data':{'trending':{'list':[{'keyword':'梗'+str(i)} for i in range(20)]}}}
        r=trends.current_trends('',fetch,lambda:self.now)
        self.assertEqual(len(r['items']),10);self.assertFalse(r['meaning_verified'])
        trends.current_trends('',fetch,lambda:self.now);self.assertEqual(len(calls),1)
    def test_search_rejects_old_posts_and_strips_html(self):
        rows=[{'pubdate':self.now-60,'bvid':'BV1234567890','title':'<em>新梗</em>','description':'解释线索'},
              {'pubdate':self.now-40*86400,'bvid':'BV1234567890','title':'旧梗'}]
        r=trends.current_trends('新梗',lambda _: {'code':0,'data':{'result':rows}},lambda:self.now)
        self.assertEqual(len(r['items']),1);self.assertEqual(r['items'][0]['title'],'新梗');self.assertTrue(r['untrusted'])
    def test_source_errors_are_fixed_no_raw_error_or_fake_meaning(self):
        def fail(_):raise ValueError('private raw error')
        r=trends.current_trends('梗',fail,lambda:self.now)
        self.assertEqual(r,{'ok':False,'code':'TREND_SOURCE_UNAVAILABLE','items':[]})

if __name__=='__main__':unittest.main()

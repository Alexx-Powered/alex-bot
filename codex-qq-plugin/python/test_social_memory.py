import hashlib
import tempfile
import unittest
from pathlib import Path
from social_memory import SocialMemory, MOOD_HALF_LIFE, MOOD_TTL
from social_worker import process

def key(v):return hashlib.sha256(str(v).encode()).hexdigest()

class SocialMemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.now=1800000000
        self.store=SocialMemory(Path(self.tmp.name),clock=lambda:self.now)
        self.user=key('groupA:userA');self.scope=key('groupA')
    def tearDown(self):self.tmp.cleanup()
    def observe(self,text,event=1,user=None,scope=None):
        return self.store.observe(user or self.user,scope or self.scope,key(event),text)
    def recall(self):return self.store.recall(self.user,self.scope)
    def test_unaddressed_self_preferences_survive_restart(self):
        self.observe('我喜欢安静的小教室')
        new=SocialMemory(Path(self.tmp.name),clock=lambda:self.now)
        self.assertEqual(new.recall(self.user,self.scope)['preferences'][0]['text'],'我喜欢安静的小教室')
    def test_mood_decay_and_expiry_and_latest_change(self):
        self.observe('我好烦，写了一天都没做完')
        self.assertEqual(self.recall()['mood'][0]['label'],'烦躁')
        before=self.recall()['mood'][0]['weight'];self.now+=MOOD_HALF_LIFE
        self.assertAlmostEqual(self.recall()['mood'][0]['weight'],before/2)
        self.observe('我现在很开心',2)
        self.assertEqual(self.recall()['mood'][0]['label'],'开心')
        self.now+=MOOD_TTL
        self.assertEqual(self.recall()['mood'],[])
    def test_no_mood_from_others_quotes_sensitive_topics_or_meme(self):
        for i,text in enumerate(['她说我好难过','“我很开心”','我有抑郁症','照片中的人很难过','[哭哭表情包]']):self.observe(text,i)
        self.assertEqual(self.recall()['mood'],[])
    def test_profiles_isolated_by_member_and_group(self):
        self.observe('我很开心');self.observe('我喜欢数学',2,user=key('other'))
        self.assertEqual(self.store.recall(key('other'),self.scope)['mood'],[])
        self.assertEqual(self.store.recall(self.user,key('other-group'))['mood'],[]) # namespace alone is not scope authority
        self.assertFalse(self.store.control(self.user,key('other-group'),'clear')['ok'])
        self.assertEqual(self.recall()['mood'][0]['label'],'开心')
    def test_duplicate_event_does_not_reinforce(self):
        self.observe('我很开心');self.observe('我很开心')
        self.assertEqual(len(self.recall()['mood']),1)
    def test_off_persists_and_prevents_resurrection(self):
        self.observe('我喜欢数学');self.store.control(self.user,self.scope,'off')
        self.now+=200*86400
        self.assertTrue(self.observe('我很开心',2)['disabled'])
        self.assertTrue(self.recall()['disabled']);self.assertEqual(self.recall()['media'],[])
    def test_clear_erases_all_types_and_on_reenables(self):
        self.observe('我很开心');self.store.remember_media(self.user,self.scope,key(7),'image','一只鱼')
        self.store.control(self.user,self.scope,'clear');self.assertEqual(self.recall()['mood'],[]);self.assertEqual(self.recall()['media'],[])
        self.store.control(self.user,self.scope,'off');self.store.control(self.user,self.scope,'on')
        self.observe('我好累',8);self.assertEqual(self.recall()['mood'][0]['label'],'疲惫')
    def test_style_needs_repetition_and_decays(self):
        for i in range(5):self.observe('哈哈这鱼好可爱~',i)
        self.assertGreater(self.recall()['style']['playful_expression_ratio'],.5)
        self.now+=180*86400;self.assertEqual(self.recall()['style'],{})
    def test_media_bounded_and_sensitive_summaries_rejected(self):
        self.observe('你好')
        for i in range(20):self.store.remember_media(self.user,self.scope,key(i),'meme','猫猫伸爪')
        self.assertEqual(len(self.recall()['media']),4)
        self.assertFalse(self.store.remember_media(self.user,self.scope,key(30),'image','银行卡余额100')['ok'])
    def test_real_langchain_social_tool_rejects_paths_and_other_actions(self):
        args={'action':'observe','namespace':self.user,'scope':self.scope,'event':key(1),'text':'我喜欢画画'}
        self.assertTrue(process({'type':'social','args':args},self.store)['ok'])
        with self.assertRaises(Exception):process({'type':'social','args':{**args,'path':'/etc/passwd'}},self.store)
        with self.assertRaises(Exception):process({'type':'social','args':{**args,'action':'execute'}},self.store)
    def test_media_quota_and_duplicate_survive_restart(self):
        for i in range(30):self.assertTrue(self.store.reserve_media(key(i),'audio')['ok'])
        self.assertFalse(self.store.reserve_media(key(99),'audio')['ok'])
        self.assertEqual(self.store.reserve_media(key(1),'audio')['code'],'MEDIA_ALREADY_PROCESSED')
        self.now+=86400;self.assertTrue(self.store.reserve_media(key(99),'audio')['ok'])

if __name__=='__main__':unittest.main()

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
SCRIPTS=Path(__file__).parent/'skills/building3-study-planner-v2-1/scripts'
sys.path.insert(0,str(SCRIPTS))

class BriefingTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec('PIL'),'renderer runtime only')
    def test_unknown_exclusion_and_render(self):
        import briefing
        from PIL import Image
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);input_file=p/'input.json'
            data={'building':'三号楼','date':'2026-10-29','rows':[{'room':'105','slots':'FFFFBFFFFFFFFF'},{'room':'106','slots':'?'*14},{'room':'204','slots':'F'*14}]}
            input_file.write_text(json.dumps(data),encoding='utf-8')
            m=briefing.render(input_file,p,reviewed=True,demo=True)
            self.assertEqual(m['roomCount'],2)
            with Image.open(p/'study-briefing.png') as image:
                self.assertEqual(image.size[0],1800)
                self.assertLess(image.size[1],16000)
            other=briefing.render(input_file,p,reviewed=True,demo=True)
            self.assertEqual(other['idempotencyKey'],m['idempotencyKey'])
            result=briefing.plan.analyze(data)
            self.assertNotIn('204',result['rooms'])
            self.assertTrue(all(x.get('room')!='106' for s in result['sessions'].values() for x in s['recommendations']))


@unittest.skipUnless(importlib.util.find_spec('langchain_core'),'run with QQ Bot Python')
class SenderTests(unittest.TestCase):
    def setUp(self):
        import hashlib
        from datetime import datetime,timezone
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        (self.root/'.private').mkdir()
        (self.root/'.private/admin-token').write_text('a'*64)
        self.image=b'\x89PNG\r\n\x1a\n'+b'test'
        (self.root/'study-briefing.png').write_bytes(self.image)
        self.manifest={'version':'study-briefing-v1','reviewed':True,'date':'2026-10-29',
            'generatedAt':datetime.now(timezone.utc).isoformat(),'image':'study-briefing.png',
            'sha256':hashlib.sha256(self.image).hexdigest(),'idempotencyKey':'study:'+'b'*64}
        self.file=self.root/'briefing-manifest.json'
        self.write_manifest()
        self.status={'ok':True,'configured':True,'transport':{'state':'connected'},
            'core':{'paired':True,'paused':False,'remainingDailyAttempts':300,
                'minuteAttempts':0,'limits':{'minuteAttempts':15}}}
        self.posts=[]
        self.timeout=False

    def write_manifest(self):
        self.file.write_text(json.dumps(self.manifest),encoding='utf-8')

    def transport(self,route,token,body=None):
        self.assertEqual(token,'a'*64)
        self.assertEqual(route,'/api/status' if body is None else '/api/study-briefing')
        if body is None:return self.status
        self.posts.append(body)
        if self.timeout:raise TimeoutError('offline simulated timeout')
        return {'ok':True,'code':'SENT'}

    def send(self):
        import send_qq
        return send_qq.send(self.file,transport=self.transport,bot_home=self.root)

    def test_same_manifest_two_explicit_invocations_send_with_distinct_keys(self):
        self.assertEqual(self.send()['code'],'SENT')
        self.assertEqual(self.send()['code'],'SENT')
        self.assertEqual(len(self.posts),2)
        first,second=self.posts
        self.assertNotEqual(first['idempotencyKey'],second['idempotencyKey'])
        self.assertEqual(first['pngBase64'],second['pngBase64'])
        self.assertNotEqual(first['idempotencyKey'],self.manifest['idempotencyKey'])
        for post in self.posts:
            self.assertEqual(set(post),{'idempotencyKey','pngBase64'})
            self.assertRegex(post['idempotencyKey'],r'^study:[0-9a-f]{64}$')
            receipt=self.root/'.qq-delivery'/(post['idempotencyKey'][6:]+'.json')
            self.assertEqual(json.loads(receipt.read_text())['code'],'SENT')

    def test_timeout_posts_once_and_records_uncertainty_without_retry(self):
        self.timeout=True
        self.assertEqual(self.send()['code'],'DELIVERY_UNKNOWN')
        self.assertEqual(len(self.posts),1)
        receipts=list((self.root/'.qq-delivery').glob('*.json'))
        self.assertEqual(len(receipts),1)
        self.assertEqual(json.loads(receipts[0].read_text())['code'],'DELIVERY_UNKNOWN')
        # Only a separate, explicit invocation may create another request.
        self.timeout=False
        self.assertEqual(self.send()['code'],'SENT')
        self.assertEqual(len(self.posts),2)
        self.assertNotEqual(self.posts[0]['idempotencyKey'],self.posts[1]['idempotencyKey'])

    def test_pause_offline_and_quota_reject_without_posting(self):
        import copy
        initial=copy.deepcopy(self.status)
        for change,expected in [('pause','PAUSED'),('offline','NOT_CONNECTED'),('quota','LOCAL_QUOTA_EXHAUSTED')]:
            with self.subTest(change=change):
                self.status=copy.deepcopy(initial)
                if change=='pause':self.status['core']['paused']=True
                elif change=='offline':self.status['transport']['state']='disconnected'
                else:self.status['core']['remainingDailyAttempts']=0
                self.assertEqual(self.send()['code'],expected)
        self.assertFalse(self.posts)
        self.assertFalse((self.root/'.qq-delivery').exists())

    def test_unreviewed_and_changed_image_cannot_be_sent(self):
        (self.root/'study-briefing.png').write_bytes(self.image+b'changed')
        self.assertEqual(self.send()['code'],'IMAGE_CHANGED')
        self.manifest['reviewed']=False
        self.write_manifest()
        self.assertEqual(self.send()['code'],'REVIEW_REQUIRED')
        self.assertFalse(self.posts)

if __name__=='__main__':unittest.main()

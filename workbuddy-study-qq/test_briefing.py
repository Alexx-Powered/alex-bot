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

    @unittest.skipUnless(importlib.util.find_spec('langchain_core'),'sender runtime only')
    def test_send_pause_hash_and_uncertain_dedupe(self):
        import send_qq
        import hashlib
        from datetime import datetime,timezone
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);(p/'.private').mkdir();(p/'.private/admin-token').write_text('a'*64)
            image=b'\x89PNG\r\n\x1a\n'+b'test'
            (p/'study-briefing.png').write_bytes(image)
            m={'version':'study-briefing-v1','reviewed':True,'date':'2026-10-29','generatedAt':datetime.now(timezone.utc).isoformat(),'image':'study-briefing.png','sha256':hashlib.sha256(image).hexdigest(),'idempotencyKey':'study:'+'b'*64}
            f=p/'briefing-manifest.json';f.write_text(json.dumps(m))
            status={'ok':True,'configured':True,'transport':{'state':'connected'},'core':{'paired':True,'paused':True}}
            posts=[]
            def fake(route,token,body=None):
                if body is None:return status
                posts.append(body);raise TimeoutError()
            self.assertEqual(send_qq.send(f,transport=fake,bot_home=p)['code'],'PAUSED')
            self.assertFalse(posts)
            status['core']['paused']=False
            self.assertEqual(send_qq.send(f,transport=fake,bot_home=p)['code'],'DELIVERY_UNKNOWN')
            self.assertEqual(send_qq.send(f,transport=fake,bot_home=p)['code'],'ALREADY_ATTEMPTED_CHECK_RECEIPT')
            self.assertEqual(len(posts),1)
            (p/'study-briefing.png').write_bytes(image+b'x')
            self.assertEqual(send_qq.send(f,transport=fake,bot_home=p)['code'],'IMAGE_CHANGED')
            m['reviewed']=False;f.write_text(json.dumps(m))
            self.assertEqual(send_qq.send(f,transport=fake,bot_home=p)['code'],'REVIEW_REQUIRED')

if __name__=='__main__':unittest.main()

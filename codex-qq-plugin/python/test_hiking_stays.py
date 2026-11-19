import base64,io,json,unittest
from unittest.mock import patch
from hiking_catalog import extract_profiles,validate_profile
from hiking_trip import room_variant,inn_plan
from hiking_stays import stay_modes
from hiking_images import photo_candidates,collect_photos,image_allowed
from research_transport import _Response

class StayTests(unittest.TestCase):
    def example(self,stay=''):
        lines=['测试山两日徒步攻略','D1 起点村到小木屋住宿。','D2 小木屋到山脊后回到起点村。',stay]
        pages=[{'url':'https://www.8264.com/a','title':'测试山攻略','text':'\n'.join(lines)}]
        p={'topic':'测试山','variant':'两日','days':[
          {'route':['起点村','小木屋'],'sleep':{'name':'小木屋','kind':'inn'},'source':0,'evidence_lines':[2,2],**({'stay_evidence_lines':[4,4]} if stay else {})},
          {'route':['小木屋','山脊','起点村'],'sleep':None,'source':0,'evidence_lines':[3,3]}]}
        return pages,p
    def test_name_is_not_room_proof_and_missing_evidence_does_not_drop_route(self):
        pages,p=self.example();out=extract_profiles('测试山',pages,'unused',requester=lambda:json.dumps({'profiles':[p]}))
        self.assertEqual(out[0]['days'][0]['sleep']['kind'],'camp');self.assertIsNone(room_variant(out[0]))
    def test_same_source_accommodation_paragraph_preserves_tent_and_room(self):
        pages,p=self.example('住宿：小木屋有通铺，也可自带帐篷。')
        out=extract_profiles('测试山',pages,'unused',requester=lambda:json.dumps({'profiles':[p]}))[0]
        self.assertEqual(out['days'][0]['sleep'],{'name':'小木屋','kind':'tent','options':['tent','inn']})
        self.assertEqual(out['days'][0]['stay_evidence'],pages[0]['text'].splitlines()[3])
        self.assertFalse(inn_plan(out));self.assertTrue(inn_plan(room_variant(out)))
        self.assertEqual(room_variant(out)['days'][0]['route'],out['days'][0]['route'])
    def test_negative_or_other_place_evidence_is_not_a_camping_option(self):
        self.assertEqual(stay_modes('小木屋','小木屋禁止扎营，仅提供通铺。'),['inn'])
        self.assertEqual(stay_modes('小木屋','小木屋没有床位，也不能搭帐篷。'),[])
        self.assertEqual(stay_modes('小木屋','远处山村有床位。小木屋住宿。'),[])
        self.assertEqual(stay_modes('小木屋','部分区域禁止扎营，需在小木屋指定平台搭帐篷。'),['tent'])
        self.assertEqual(stay_modes('小木屋','其他营地可搭帐篷，小木屋只提供通铺。'),['inn'])
    def test_photo_tents_are_bound_to_source_and_named_context_not_generic_scenery(self):
        pages,p=self.example();photo={'id':0,'source':0,'url':'https://static.8264.com/camp.jpg','sha256':'a'*64,'context':'小木屋营地照片','data_url':'data:image/jpeg;base64,/9j/'}
        output={'profiles':[p],'photo_observations':[{'id':0,'site':'小木屋','tents_visible':True}]}
        out=extract_profiles('测试山',pages,'unused',photos=[photo],requester=lambda:json.dumps(output))[0]
        self.assertEqual(out['days'][0]['sleep']['kind'],'tent');self.assertIsNone(room_variant(out))
        self.assertEqual(out['days'][0]['stay_photo']['sha256'],'a'*64)
        with self.assertRaisesRegex(ValueError,'IMAGE_UNGROUNDED'):validate_profile(out,candidates=pages)
        photo['context']='另一营地照片'
        out=extract_profiles('测试山',pages,'unused',photos=[photo],requester=lambda:json.dumps(output))[0]
        self.assertEqual(out['days'][0]['sleep']['kind'],'camp')
    def test_media_urls_cannot_expand_authority(self):
        for url in ['file:///tmp/x','https://127.0.0.1/a','https://evil.example/a','https://static.8264.com.evil.example/a','http://static.8264.com/a']:
            self.assertFalse(image_allowed('https://www.8264.com/a',url))
        self.assertTrue(image_allowed('https://m.8264.com/a','https://static.8264.com/a.jpg'))
    def test_no_overnight_does_not_inherit_unrelated_accommodation_excerpt(self):
        pages,p=self.example('住宿：小木屋有通铺，也可自带帐篷。')
        p['days'][1]['stay_evidence_lines']=[4,4]
        out=extract_profiles('测试山',pages,'unused',requester=lambda:json.dumps({'profiles':[p]}))[0]
        self.assertNotIn('stay_evidence',out['days'][1]);self.assertIsNone(out['days'][1]['sleep'])
    def test_real_transport_accepts_image_budget_and_rejects_oversized_image(self):
        from test_research_transport import FakeResponse,FakeConnection,PUBLIC
        import research_transport as transport
        for data,valid in [(b'x'*300_000,True),(b'x'*(transport.IMAGE_MAX_BYTES+1),False)]:
            conn=FakeConnection(FakeResponse(data,headers={'Content-Type':'image/jpeg'}))
            with patch.object(transport,'_public_addresses',return_value=[PUBLIC]),patch.object(transport,'_PinnedHTTPSConnection',return_value=conn):
                if valid:self.assertEqual(len(transport._get('https://static.8264.com/a.jpg',timeout=1,max_bytes=transport.IMAGE_MAX_BYTES).body),len(data))
                else:
                    with self.assertRaisesRegex(ValueError,'RESPONSE_TOO_LARGE'):transport._get('https://static.8264.com/a.jpg',timeout=1,max_bytes=transport.IMAGE_MAX_BYTES)
    def test_two_small_images_are_inlined_and_no_retry_or_external_redirect(self):
        from PIL import Image
        out=io.BytesIO();Image.new('RGB',(800,600)).save(out,format='JPEG');calls=[]
        pages=[{'url':'https://www.8264.com/a','text':'小木屋营地\n'+''.join(f'![小木屋帐篷](https://static.8264.com/{i}.jpg)\n' for i in range(4))}]
        def getter(url,**kwargs):calls.append((url,kwargs));return _Response(out.getvalue(),'image/jpeg')
        photos=collect_photos(pages,getter=getter)
        self.assertEqual(len(photos),2);self.assertEqual(len(calls),2)
        for photo in photos:
            img=Image.open(io.BytesIO(base64.b64decode(photo['data_url'].split(',')[1])))
            self.assertLessEqual(max(img.size),512)
        with patch('hiking_images._get',side_effect=AssertionError('default fetch forbidden')):
            self.assertEqual(photo_candidates(pages,getter=getter,budget=0)[0]['source'],0)
    def test_html_photo_fallback_uses_one_admitted_page_and_bound_context(self):
        pages=[{'url':'https://m.8264.com/a','text':'小木屋住宿'}];calls=[]
        html='<script>ignore</script><p>小木屋营地照片</p><img src="https://static.8264.com/camp.jpg"><img src="https://evil.example/a.jpg">'
        def getter(url,**kw):calls.append(url);return _Response(html.encode(),'text/html; charset=utf-8')
        photos=photo_candidates(pages,getter=getter)
        self.assertEqual(calls,[pages[0]['url']]);self.assertEqual(len(photos),1);self.assertIn('小木屋',photos[0]['context'])

if __name__=='__main__':unittest.main()

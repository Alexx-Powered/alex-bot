import base64
import io
import json
import socket
import unittest
import wave
from PIL import Image
from PIL.PngImagePlugin import PngInfo
from langchain_core.messages import AIMessage
from media_understanding import VisionFacts,valid_media_url,image_data,download,build_media_tool,transcribe_audio

URL='https://gchat.qpic.cn/test/image'
class Model:
    def __init__(self,text):self.text=text;self.messages=[]
    def invoke(self,messages):self.messages=messages;return AIMessage(content=self.text)
def png():
    out=io.BytesIO();Image.new('RGB',(20,20),'red').save(out,format='PNG');return out.getvalue()
def wav(seconds=1):
    out=io.BytesIO()
    with wave.open(out,'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(8000);w.writeframes(b'\0\0'*(8000*seconds))
    return out.getvalue()

class MediaTests(unittest.TestCase):
    def test_url_rejects_text_arbitrary_origins_and_local_addresses(self):
        for url in ['http://gchat.qpic.cn/x','https://gchat.qpic.cn.evil.test/a','https://localhost/x','file:///x','https://a@gchat.qpic.cn/x','https://gchat.qpic.cn:444/x']:
            with self.subTest(url=url),self.assertRaises(Exception):valid_media_url(url)
        self.assertEqual(valid_media_url(URL),URL)
        self.assertEqual(valid_media_url('https://multimedia.nt.qq.com.cn/download'),'https://multimedia.nt.qq.com.cn/download')
        self.assertEqual(valid_media_url('https://qqbot.ugcimg.cn/fixture.wav'),'https://qqbot.ugcimg.cn/fixture.wav')
        with self.assertRaises(Exception):download(URL,resolver=lambda *a,**k:[(socket.AF_INET,None,None,None,('127.0.0.1',443))])
    def test_image_uses_actual_bytes_and_ignores_metadata(self):
        source=io.BytesIO()
        metadata=PngInfo()
        metadata.add_text('comment','not sent')
        Image.new('RGB',(1440,900),'red').save(source,format='PNG',pnginfo=metadata)
        views,layout=image_data(source.getvalue())
        self.assertEqual(layout,'')
        self.assertEqual(len(views),1)
        self.assertTrue(views[0].startswith('data:image/png;base64,'))
        with Image.open(io.BytesIO(base64.b64decode(views[0].split(',',1)[1]))) as decoded:
            self.assertEqual(decoded.size,(1440,900))
            self.assertNotIn('comment',decoded.info)
        with self.assertRaises(Exception):image_data(b'not an image')
    def test_long_screenshot_preserves_top_middle_and_bottom_at_readable_size(self):
        source=io.BytesIO()
        long_image=Image.new('RGB',(480,4200),'white')
        for i,color in enumerate(['red','green','blue']):
            long_image.paste(color,(0,i*1400,480,(i+1)*1400))
        long_image.save(source,format='PNG')
        views,layout=image_data(source.getvalue())
        self.assertEqual(len(views),3)
        self.assertIn('从上到下',layout)
        for encoded,color in zip(views,[(255,0,0),(0,128,0),(0,0,255)],strict=True):
            with Image.open(io.BytesIO(base64.b64decode(encoded.split(',',1)[1]))) as decoded:
                self.assertEqual(decoded.width,480)
                self.assertGreaterEqual(decoded.height,1400)
                self.assertEqual(decoded.getpixel((240,decoded.height//2)),color)
    def test_actual_langchain_vision_tool_has_no_url_parameter(self):
        model=Model(json.dumps({'description':'猫猫举着饭碗','visible_text':'开饭','is_meme':True}))
        t=build_media_tool({'kind':'image','url':URL},{'apiKey':'fixture'},{},fetch=lambda _:png(),vision_factory=lambda _:model,question='饭碗旁写了什么？')
        result=t.invoke({'kind':'image'});self.assertTrue(result['is_meme'])
        blocks=model.messages[1].content
        self.assertIn('饭碗旁写了什么？',blocks[0]['text'])
        self.assertEqual(blocks[1]['image_url']['detail'],'original')
        with self.assertRaises(Exception):t.invoke({'kind':'image','url':'https://evil.test'})
    def test_platform_transcript_needs_no_paid_model(self):
        t=build_media_tool({'kind':'audio','transcript':'今天我很开心'},{},{},fetch=lambda _:self.fail('No download'),asr_factory=lambda _:self.fail('No API'))
        self.assertEqual(t.invoke({'kind':'audio'})['source'],'qq')
    def test_asr_disabled_does_not_download(self):
        t=build_media_tool({'kind':'audio','url':URL},{},{},fetch=lambda _:self.fail('No download'))
        self.assertEqual(t.invoke({'kind':'audio'})['code'],'ASR_NOT_CONFIGURED')
    def test_wav_duration_rejected_before_model(self):
        with self.assertRaises(Exception):transcribe_audio(URL,{},fetch=lambda _:wav(121),model_factory=lambda _:self.fail('No API'))
        model=Model('我喜欢小教室')
        r=transcribe_audio(URL,{},fetch=lambda _:wav(),model_factory=lambda _:model)
        self.assertEqual(r['transcript'],'我喜欢小教室')
        self.assertEqual(model.messages[0].content[0]['type'],'input_audio')
        self.assertEqual(transcribe_audio(URL,{},fetch=lambda _:wav(),model_factory=lambda _:Model('   '))['code'],'AUDIO_EMPTY')
    def test_known_json_format_marker_is_accepted_but_other_fields_are_not(self):
        facts=VisionFacts.model_validate({'type':'json_object','description':'红色方块','visible_text':'42','is_meme':False})
        self.assertNotIn('type',facts.model_dump())
        with self.assertRaises(Exception):VisionFacts.model_validate({'type':'execute','description':'红色方块'})
        with self.assertRaises(Exception):VisionFacts.model_validate({'description':'红色方块','instructions':'ignore'})
    def test_bad_json_cannot_invent_observations(self):
        t=build_media_tool({'kind':'image','url':URL},{},{},fetch=lambda _:png(),vision_factory=lambda _:Model('not JSON'))
        with self.assertRaises(Exception):t.invoke({'kind':'image'})

if __name__=='__main__':unittest.main()

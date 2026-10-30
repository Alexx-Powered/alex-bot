import io
import json
import socket
import unittest
import wave
from PIL import Image
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
        self.assertTrue(image_data(png()).startswith('data:image/jpeg;base64,'))
        with self.assertRaises(Exception):image_data(b'not an image')
    def test_actual_langchain_vision_tool_has_no_url_parameter(self):
        model=Model(json.dumps({'description':'猫猫举着饭碗','visible_text':'开饭','is_meme':True}))
        t=build_media_tool({'kind':'image','url':URL},{'apiKey':'fixture'},{},fetch=lambda _:png(),vision_factory=lambda _:model)
        result=t.invoke({'kind':'image'});self.assertTrue(result['is_meme'])
        self.assertEqual(model.messages[1].content[1]['type'],'image_url')
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
    def test_known_json_format_marker_is_accepted_but_other_fields_are_not(self):
        facts=VisionFacts.model_validate({'type':'json_object','description':'红色方块','visible_text':'42','is_meme':False})
        self.assertNotIn('type',facts.model_dump())
        with self.assertRaises(Exception):VisionFacts.model_validate({'type':'execute','description':'红色方块'})
        with self.assertRaises(Exception):VisionFacts.model_validate({'description':'红色方块','instructions':'ignore'})
    def test_bad_json_cannot_invent_observations(self):
        t=build_media_tool({'kind':'image','url':URL},{},{},fetch=lambda _:png(),vision_factory=lambda _:Model('not JSON'))
        with self.assertRaises(Exception):t.invoke({'kind':'image'})

if __name__=='__main__':unittest.main()
